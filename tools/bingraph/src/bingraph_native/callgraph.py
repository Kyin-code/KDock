"""Call-graph rendering and HTTP integration for the native launcher."""

from __future__ import annotations

from functools import lru_cache
from html import escape
import json
import os
from pathlib import Path
from urllib.parse import quote

import networkx as nx
from angr import Project
from fastapi import Query
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydot import Dot, Edge as PydotEdge, Node as PydotNode

from bingraph.core.outputs import validate_text_cfg_format


def parse_address(value: str | int) -> int:
    if isinstance(value, int):
        return value
    return int(value, 16) if value.lower().startswith("0x") else int(value)


@lru_cache(maxsize=16)
def _callgraph_data(project: Project) -> tuple[object, object]:
    cfg = project.analyses.CFGFast(
        force_smart_scan=False,
        resolve_indirect_jumps=False,
        data_references=False,
        normalize=True,
    )
    return cfg, cfg.functions.callgraph


@lru_cache(maxsize=16)
def _symbol_direct_calls(project: Project, cfg: object) -> dict[int, list[tuple[int, int, str]]]:
    """Recover direct calls from the full ELF symbol range.

    CFGFast sometimes stops at an indirect call or an unusual loop boundary and
    assigns a much smaller size to an otherwise valid function. This is common
    in MDK-generated Cortex-M images (for example MainLoop): relying only on
    ``function.get_call_sites()`` then loses every call in the loop body.

    ELF symbol sizes describe the complete function range, so disassemble that
    range and merge its direct BL/BLX calls back into the graph.
    """
    sections = getattr(project.loader.main_object, "sections", [])
    canonical_functions: dict[int, int] = {}
    for addr, function in cfg.functions.items():
        normalized = int(addr) & ~1
        candidate = int(addr)
        current = canonical_functions.get(normalized)
        if current is None:
            canonical_functions[normalized] = candidate
            continue
        current_function = cfg.functions.get(current)
        current_named = bool(current_function and not current_function.name.startswith("sub_"))
        candidate_named = bool(function and not function.name.startswith("sub_"))
        if candidate_named and not current_named:
            canonical_functions[normalized] = candidate
    symbols: dict[int, object] = {}
    for symbol in getattr(project.loader.main_object, "symbols", []):
        if not symbol.is_function or not symbol.size:
            continue
        start = int(symbol.rebased_addr) & ~1
        try:
            section = sections[int(symbol.section)]
            executable = bool(getattr(section, "is_executable", False))
        except (AttributeError, IndexError, TypeError, ValueError):
            executable = True
        if executable:
            # Keep the largest alias for duplicate symbol names at one address.
            old = symbols.get(start)
            if old is None or int(symbol.size) > int(old.size):
                symbols[start] = symbol

    disassembler = (
        project.arch.capstone_thumb
        if getattr(project.arch, "is_thumb", False)
        else project.arch.capstone
    )
    result: dict[int, list[tuple[int, int, str]]] = {}
    for normalized_addr, symbol in symbols.items():
        function_addr = canonical_functions.get(normalized_addr, normalized_addr)
        try:
            raw = project.loader.memory.load(normalized_addr, int(symbol.size))
        except Exception:
            continue
        recovered: list[tuple[int, int, str]] = []
        for instruction in disassembler.disasm(bytes(raw), normalized_addr):
            if instruction.mnemonic not in {"bl", "blx"} or not instruction.operands:
                continue
            target = getattr(instruction.operands[0], "imm", None)
            if target is None:
                continue
            target_normalized = int(target) & ~1
            target_symbol = symbols.get(target_normalized)
            if target_symbol is not None:
                target = int(target_symbol.rebased_addr)
            elif target_normalized in canonical_functions:
                target = canonical_functions[target_normalized]
            else:
                continue
            recovered.append(
                (
                    int(instruction.address),
                    target,
                    f"{instruction.mnemonic} {instruction.op_str}".strip(),
                )
            )
        if recovered:
            result[function_addr] = recovered
    return result


@lru_cache(maxsize=16)
def _symbol_sizes(project: Project) -> dict[int, int]:
    sizes: dict[int, int] = {}
    for symbol in getattr(project.loader.main_object, "symbols", []):
        if not symbol.is_function or not symbol.size:
            continue
        normalized = int(symbol.rebased_addr) & ~1
        sizes[normalized] = max(sizes.get(normalized, 0), int(symbol.size))
    return sizes


# RTOS entry points are usually registered as function pointers. A normal
# static call graph only records the call to xTaskCreate/osThreadNew itself and
# therefore loses every task body. These APIs put the entry function in a
# register before the registration call; ARM targets used by embedded firmware
# can be resolved reliably from the immediately preceding literal load.
_RTOS_ENTRYPOINTS: dict[str, tuple[int, str]] = {
    "xTaskCreate": (0, "task"),
    "xTaskCreateStatic": (0, "task"),
    "xTaskCreatePinnedToCore": (0, "task"),
    "xTaskCreateAffinitySet": (0, "task"),
    "xTaskCreateStaticPinnedToCore": (0, "task"),
    "xTaskCreateStaticAffinitySet": (0, "task"),
    "osThreadNew": (0, "task"),
    "pthread_create": (2, "thread"),
    "tx_thread_create": (2, "thread"),
    "_txe_thread_create": (2, "thread"),
    "rt_thread_create": (1, "thread"),
    "rt_thread_init": (1, "thread"),
    "k_thread_create": (3, "thread"),
    "task_create": (1, "task"),
}


def _canonical_function_addr(cfg: object, value: int) -> int | None:
    """Map a Thumb pointer (possibly address|1) back to a CFG function."""
    normalized = int(value) & ~1
    matches = [
        int(addr)
        for addr in cfg.functions
        if (int(addr) & ~1) == normalized
    ]
    if not matches:
        return None
    named = [
        addr
        for addr in matches
        if not _function_name(cfg, addr).startswith("sub_")
    ]
    return (named or matches)[0]


def _argument_register(project: Project, index: int) -> str | None:
    """Return the ABI register used by the first integer arguments."""
    arch = str(getattr(project.arch, "name", "")).lower()
    if "arm" in arch or "thumb" in arch:
        return f"r{index}" if index < 4 else None
    if "aarch64" in arch:
        return f"x{index}" if index < 8 else None
    if "amd64" in arch or "x86_64" in arch:
        return ("rdi", "rsi", "rdx", "rcx", "r8", "r9")[index] if index < 6 else None
    if arch in {"mips32", "mips64"}:
        return f"a{index}" if index < 4 else None
    return None


def _resolve_register_value(
    project: Project,
    instructions: list[object],
    instruction_index: int,
    register: str,
    depth: int = 0,
) -> int | None:
    """Resolve a simple PC-relative literal/move chain before a call."""
    if depth > 4:
        return None
    start = max(0, instruction_index - 24)
    for index in range(instruction_index - 1, start - 1, -1):
        instruction = instructions[index]
        try:
            written = {
                instruction.reg_name(reg)
                for reg in instruction.regs_access()[1]
            }
        except (AttributeError, TypeError, ValueError):
            written = set()
        if register not in written:
            continue

        mnemonic = instruction.mnemonic.lower()
        operands = instruction.operands
        if mnemonic.startswith(("mov", "ldr", "adr", "add")):
            if not operands:
                return None

            if mnemonic.startswith("mov") and len(operands) >= 2:
                source = operands[1]
                if getattr(source, "type", None) == 2:  # IMM
                    return int(source.imm)
                if getattr(source, "type", None) == 1:  # REG
                    source_name = instruction.reg_name(source.reg)
                    if source_name != register:
                        return _resolve_register_value(
                            project, instructions, index, source_name, depth + 1
                        )
                    return None

            if mnemonic.startswith("ldr") and len(operands) >= 2:
                source = operands[1]
                if getattr(source, "type", None) != 3:  # MEM
                    return None
                memory = source.mem
                base_name = instruction.reg_name(memory.base)
                if base_name != "pc":
                    return None
                pc = instruction.address + (4 if project.arch.is_thumb else 8)
                if project.arch.is_thumb:
                    pc &= ~3
                literal_addr = pc + int(memory.disp)
                try:
                    raw = project.loader.memory.load(literal_addr, 4)
                except Exception:
                    return None
                return int.from_bytes(raw, "little")

            if mnemonic.startswith("adr") and len(operands) >= 2:
                offset = getattr(operands[1], "imm", None)
                if offset is None:
                    return None
                pc = instruction.address + (4 if project.arch.is_thumb else 8)
                if project.arch.is_thumb:
                    pc &= ~3
                return pc + int(offset)

            if mnemonic.startswith("add") and len(operands) >= 3:
                base = operands[1]
                offset = operands[2]
                if (
                    getattr(base, "type", None) == 1
                    and instruction.reg_name(base.reg) == "pc"
                    and getattr(offset, "type", None) == 2
                ):
                    pc = instruction.address + (4 if project.arch.is_thumb else 8)
                    if project.arch.is_thumb:
                        pc &= ~3
                    return pc + int(offset.imm)

        return None
    return None


@lru_cache(maxsize=16)
def _rtos_registration_calls(
    project: Project, cfg: object
) -> dict[int, list[tuple[int, int, str, str, str]]]:
    """Recover call edges introduced by RTOS task/thread registration APIs."""
    result: dict[int, list[tuple[int, int, str, str, str]]] = {}
    sizes = _symbol_sizes(project)
    disassembler = (
        project.arch.capstone_thumb
        if getattr(project.arch, "is_thumb", False)
        else project.arch.capstone
    )
    for source, direct_calls in _symbol_direct_calls(project, cfg).items():
        registrations = []
        for site, target, _ in direct_calls:
            api_name = _function_name(cfg, target)
            spec = _RTOS_ENTRYPOINTS.get(api_name)
            if spec is None:
                continue
            arg_index, entry_kind = spec
            register = _argument_register(project, arg_index)
            if register is None:
                continue
            registrations.append((site, api_name, register, entry_kind))
        if not registrations:
            continue

        normalized_source = int(source) & ~1
        function = cfg.functions.get(source)
        size = max(
            sizes.get(normalized_source, 0),
            int(function.size) if function is not None else 0,
        )
        if size <= 0:
            continue
        try:
            raw = project.loader.memory.load(normalized_source, size)
        except Exception:
            continue
        instructions = list(disassembler.disasm(bytes(raw), normalized_source))
        instruction_indexes = {
            int(instruction.address): index
            for index, instruction in enumerate(instructions)
        }

        recovered = []
        for site, api_name, register, entry_kind in registrations:
            instruction_index = instruction_indexes.get(int(site))
            if instruction_index is None:
                continue
            pointer = _resolve_register_value(
                project, instructions, instruction_index, register
            )
            if pointer is None:
                continue
            entry_addr = _canonical_function_addr(cfg, pointer)
            if entry_addr is None or entry_addr == source:
                continue
            entry_name = _function_name(cfg, entry_addr)
            recovered.append(
                (
                    int(site),
                    entry_addr,
                    f"{api_name}({entry_name})",
                    f"rtos-{entry_kind}",
                    api_name,
                )
            )
        if recovered:
            result[int(source)] = recovered
    return result


def _augmented_callgraph(project: Project, cfg: object, callgraph: object) -> object:
    """Return CFGFast's graph plus direct and RTOS registration edges."""
    graph = callgraph.copy()
    for function_addr, calls in _symbol_direct_calls(project, cfg).items():
        for _, target, _ in calls:
            if target in cfg.functions or (target & ~1) in cfg.functions:
                graph.add_edge(function_addr, target)
    for function_addr, calls in _rtos_registration_calls(project, cfg).items():
        for _, target, _, kind, via in calls:
            graph.add_edge(function_addr, target, kind=kind, via=via)
    return graph


def _visible_callgraph(
    cfg: object,
    callgraph: object,
    func_addr: int,
    depth: int,
) -> tuple[dict[int, int], set[int], list[tuple[int, int]]]:
    if func_addr not in callgraph:
        raise KeyError(f"Call graph node {func_addr:#x} not found")
    cutoff = None if depth < 0 else depth
    depths = nx.single_source_shortest_path_length(callgraph, func_addr, cutoff=cutoff)
    nodes = set(depths)
    edges = sorted((a, b) for a, b in callgraph.edges() if a in nodes and b in nodes)
    return depths, nodes, edges


def _function_name(cfg: object, addr: int) -> str:
    function = cfg.functions.get(addr)
    return function.name if function is not None and function.name else f"sub_{addr:x}"


def interrupt_vector_base(project: Project, cfg: object | None = None) -> int:
    """Locate the Cortex-M vector table, with an explicit environment override.

    Preference order:
      1. BINGRAPH_NATIVE_VECTOR_BASE
      2. .isr_vector section
      3. known vector symbols
      4. image min address for bare-metal images
    """
    configured = os.environ.get("BINGRAPH_NATIVE_VECTOR_BASE", "").strip()
    if configured:
        return int(configured, 0)

    main_object = project.loader.main_object
    for section in getattr(main_object, "sections", []):
        if section.name == ".isr_vector" and section.memsize:
            return int(section.vaddr)

    names = {"g_pfnVectors", "__Vectors", "_vectors", "vector_table", "isr_vector"}
    for symbol in getattr(main_object, "symbols", []):
        if symbol.name in names and symbol.size:
            return int(symbol.rebased_addr)

    return int(getattr(main_object, "min_addr", 0))


def runtime_graph_json(
    project: Project,
    filepath: str,
    entry: int | None = None,
) -> dict[str, object]:
    """Build an ordered runtime tree plus separately mounted interrupt roots."""
    cfg, callgraph = _callgraph_data(project)
    callgraph = _augmented_callgraph(project, cfg, callgraph)
    if entry is None:
        candidates = [addr for addr, f in cfg.functions.items() if f.name == "main"]
        if not candidates:
            raise KeyError("main function not found")
        entry = candidates[0]

    def ordered_calls(func_addr: int) -> list[dict]:
        function = cfg.functions.get(func_addr)
        if function is None:
            return []
        all_calls: list[tuple[int, int, str, str, str]] = []
        for site in sorted(function.get_call_sites()):
            target = function.get_call_target(site)
            if target is None or target not in cfg.functions or target == func_addr:
                continue
            # CFGFast attributes some Thumb calls to the start of the containing
            # basic block. Locate the concrete BL/BLX in that block so the UI
            # shows the real call address and instruction.
            block = next(
                (item for item in function.blocks if item.addr <= site < item.addr + item.size),
                None,
            )
            if block is None:
                continue
            call_candidates = [
                insn
                for insn in block.capstone.insns
                if insn.mnemonic.startswith("bl") or insn.mnemonic.startswith("call")
            ]
            matched = [
                insn
                for insn in call_candidates
                if getattr(insn.operands[0], "imm", None) == target
            ]
            chosen = matched if matched else call_candidates[-1:]
            for call_insn in chosen:
                all_calls.append(
                    (
                        int(call_insn.address),
                        int(target),
                        f"{call_insn.mnemonic} {call_insn.op_str}".strip(),
                        "call",
                        "",
                    )
                )
        scanned_calls = _symbol_direct_calls(project, cfg)
        for site, target, mnemonic in (
            scanned_calls.get(int(func_addr))
            or scanned_calls.get(int(func_addr) & ~1)
            or []
        ):
            all_calls.append((site, target, mnemonic, "call", ""))
        registrations = _rtos_registration_calls(project, cfg)
        all_calls.extend(
            registrations.get(int(func_addr))
            or registrations.get(int(func_addr) & ~1)
            or []
        )
        # CFGFast can report the same edge from both the block entry and the
        # actual instruction. Keep one record per concrete call instruction.
        calls: list[tuple[int, int, str, str, str]] = []
        for call_site, target, mnemonic, kind, via in sorted(
            all_calls, key=lambda item: item[0]
        ):
            if any(
                previous_target == target and abs(previous_site - call_site) <= 1
                for previous_site, previous_target, _, _, _ in calls
            ):
                continue
            calls.append((call_site, target, mnemonic, kind, via))
        return [
            {
                "site": f"{site:x}",
                "addr": f"{target:x}",
                "name": _function_name(cfg, target),
                "order": order,
                "mnemonic": mnemonic or "call",
                "kind": kind,
                "via": via,
            }
            for order, (site, target, mnemonic, kind, via) in enumerate(calls, start=1)
        ]

    main_reachable = nx.descendants(callgraph, entry) | {entry}

    vector_base = interrupt_vector_base(project, cfg)
    interrupts: list[dict] = []
    seen_vectors: set[int] = set()
    for index in range(1, 256):
        try:
            value = int.from_bytes(project.loader.memory.load(vector_base + index * 4, 4), "little")
        except Exception:
            break
        if value not in cfg.functions or value in seen_vectors:
            continue
        function = cfg.functions[value]
        if function.name == "Reset_Handler":
            continue
        if not (function.name.endswith("_Handler") or function.name.endswith("_IRQHandler")):
            continue
        seen_vectors.add(value)
        interrupts.append(
            {
                "vector": index,
                "addr": f"{value:x}",
                "name": function.name,
                "calls": ordered_calls(value),
            }
        )

    # Interrupt handlers and everything reachable *from them* must be present in
    # the runtime payload. Otherwise an interrupt callee that is not reachable
    # from main would appear as an empty external stub and its subtree would be
    # impossible to inspect. Main and interrupt scopes stay separate at the
    # graph-root level even when the two scopes share helper functions.
    interrupt_reachable: set[int] = set()
    for interrupt in interrupts:
        root = int(interrupt["addr"], 16)
        interrupt_reachable.add(root)
        interrupt_reachable |= nx.descendants(callgraph, root)

    nodes = []
    symbol_sizes = _symbol_sizes(project)
    for addr in sorted(main_reachable | interrupt_reachable):
        function = cfg.functions.get(addr)
        blocks = []
        if function is not None:
            for block in sorted(function.blocks, key=lambda item: item.addr):
                first_insn = block.capstone.insns[0] if block.capstone.insns else None
                blocks.append(
                    {
                        "addr": f"{block.addr:x}",
                        "size": block.size,
                        "instructions": block.instructions,
                        "first_insn": (
                            f"{first_insn.mnemonic} {first_insn.op_str}".strip()
                            if first_insn is not None
                            else ""
                        ),
                        "successors": [f"{succ:x}" for succ in sorted(block.vex.constant_jump_targets)],
                    }
                )
        nodes.append(
            {
                "addr": f"{addr:x}",
                "name": _function_name(cfg, addr),
                "size": max(
                    function.size if function is not None else 0,
                    symbol_sizes.get(addr & ~1, 0),
                ),
                "blocks": len(list(function.blocks)) if function is not None else 0,
                "block_nodes": blocks,
                "calls": ordered_calls(addr),
                "mainReachable": addr in main_reachable,
            }
        )

    return {
        "filepath": filepath,
        "entry": f"{entry:x}",
        "entryName": _function_name(cfg, entry),
        "nodes": nodes,
        "roots": [f"{entry:x}"],
        "mainReachable": [f"{addr:x}" for addr in sorted(main_reachable)],
        "interruptReachable": [f"{addr:x}" for addr in sorted(interrupt_reachable)],
        "interrupts": interrupts,
    }


def all_functions_json(project: Project, filepath: str) -> dict[str, object]:
    """Return every discovered function and call edge, without reachability pruning."""
    cfg, callgraph = _callgraph_data(project)
    callgraph = _augmented_callgraph(project, cfg, callgraph)
    scanned = _symbol_direct_calls(project, cfg)
    all_addrs = set(callgraph.nodes)
    for source, calls in scanned.items():
        if source in cfg.functions:
            all_addrs.add(source)
        for _, target, _ in calls:
            if target in cfg.functions:
                all_addrs.add(target)
    registrations = _rtos_registration_calls(project, cfg)
    for source, calls in registrations.items():
        if source in cfg.functions:
            all_addrs.add(source)
        for _, target, _, _, _ in calls:
            if target in cfg.functions:
                all_addrs.add(target)
    nodes = []
    symbol_sizes = _symbol_sizes(project)
    # The list endpoint is a browsing view. Sending no instruction text keeps
    # large images responsive; per-function block metadata is still included
    # for the CFG panel and sidebar.
    for addr in sorted(all_addrs):
        function = cfg.functions.get(addr)
        blocks = []
        if function is not None:
            for block in sorted(function.blocks, key=lambda item: item.addr):
                first_insn = block.capstone.insns[0] if block.capstone.insns else None
                blocks.append(
                    {
                        "addr": f"{block.addr:x}",
                        "size": block.size,
                        "instructions": block.instructions,
                        "first_insn": (
                            f"{first_insn.mnemonic} {first_insn.op_str}".strip()
                            if first_insn is not None
                            else ""
                        ),
                    }
                )
        nodes.append(
            {
                "addr": f"{addr:x}",
                "name": _function_name(cfg, addr),
                "size": max(
                    function.size if function is not None else 0,
                    symbol_sizes.get(addr & ~1, 0),
                ),
                "blocks": len(blocks),
                "block_nodes": blocks,
                "calls": [],
                "mainReachable": False,
            }
        )
    by_addr = {node["addr"]: node for node in nodes}
    for source, calls in scanned.items():
        source_s = f"{source:x}"
        if source_s not in by_addr:
            continue
        seen = {
            (call["site"], call["addr"])
            for call in by_addr[source_s]["calls"]
        }
        for site, target, mnemonic in calls:
            target_s = f"{target:x}"
            key = (f"{site:x}", target_s)
            if target_s not in by_addr or key in seen:
                continue
            seen.add(key)
            by_addr[source_s]["calls"].append(
                {
                    "site": f"{site:x}",
                    "addr": target_s,
                    "name": by_addr[target_s]["name"],
                    "order": 0,
                    "mnemonic": mnemonic,
                    "kind": "call",
                    "via": "",
                }
            )
    for source, calls in registrations.items():
        source_s = f"{source:x}"
        if source_s not in by_addr:
            continue
        seen = {
            (call["site"], call["addr"])
            for call in by_addr[source_s]["calls"]
        }
        for site, target, mnemonic, kind, via in calls:
            target_s = f"{target:x}"
            key = (f"{site:x}", target_s)
            if target_s not in by_addr or key in seen:
                continue
            seen.add(key)
            by_addr[source_s]["calls"].append(
                {
                    "site": f"{site:x}",
                    "addr": target_s,
                    "name": by_addr[target_s]["name"],
                    "order": 0,
                    "mnemonic": mnemonic,
                    "kind": kind,
                    "via": via,
                }
            )
    scanned_sources = set(scanned)
    for source, target in sorted(callgraph.edges()):
        # The full-symbol scan already captures every concrete direct call site
        # for these functions. CFGFast's aggregate edge would add site-less
        # duplicates to the same targets.
        if source in scanned_sources:
            continue
        source_s, target_s = f"{source:x}", f"{target:x}"
        if source_s in by_addr and target_s in by_addr:
            by_addr[source_s]["calls"].append(
                {
                    "site": "",
                    "addr": target_s,
                    "name": by_addr[target_s]["name"],
                    "order": 0,
                    "mnemonic": "",
                    "kind": "call",
                    "via": "",
                }
            )
    # Build the target set once. The previous O(n^2 * edges) scan was visibly
    # slow on larger firmware images (1300+ functions).
    targets = {edge["addr"] for node in nodes for edge in node["calls"]}
    return {
        "filepath": filepath,
        "entry": "",
        "entryName": "FULL FIRMWARE",
        "nodes": nodes,
        "roots": [node["addr"] for node in nodes if node["addr"] not in targets],
        "mainReachable": [],
        "interruptReachable": [],
        "interrupts": [],
        "totalFunctions": len(nodes),
        "totalCalls": sum(len(node["calls"]) for node in nodes),
        "rootsTotal": len([node for node in nodes if node["addr"] not in targets]),
    }


def callgraph_json(
    project: Project,
    func_addr: int | None,
    depth: int,
    filepath: str,
) -> dict[str, object]:
    """Return a reachable subgraph, or the entire image when func_addr is None."""
    cfg, callgraph = _callgraph_data(project)
    if func_addr is None:
        nodes = set(callgraph.nodes)
        edges = sorted(callgraph.edges())
        depths = None
        roots = sorted(node for node in nodes if callgraph.in_degree(node) == 0)
        root = None
        root_name = "ALL FUNCTIONS"
    else:
        depths, nodes, edges = _visible_callgraph(cfg, callgraph, func_addr, depth)
        roots = [func_addr]
        root = f"{func_addr:x}"
        root_name = _function_name(cfg, func_addr)
    return {
        "filepath": filepath,
        "root": root,
        "rootName": root_name,
        "roots": [f"{addr:x}" for addr in roots],
        "depth": depth,
        "nodes": [
            {
                "addr": f"{addr:x}",
                "name": _function_name(cfg, addr),
                "depth": depths[addr] if depths is not None else -1,
                "label": _function_name(cfg, addr) + f"\n0x{addr:x}",
            }
            for addr in sorted(nodes)
        ],
        "edges": [
            {"source": f"{source:x}", "target": f"{target:x}"}
            for source, target in edges
        ],
    }


def render_callgraph_page(
    project: Project,
    func_addr: int | None,
    depth: int,
    filepath: str,
) -> str:
    """Render the interactive call-graph viewer."""
    graph = callgraph_json(project, func_addr, depth, filepath)
    template = (Path(__file__).parent / "static" / "callgraph.html").read_text(
        encoding="utf-8"
    )
    graph_json = json.dumps(graph, ensure_ascii=False).replace("</", "<\\/")
    return template.replace("{{ filepath }}", escape(filepath)).replace(
        "{{ graph_json | safe }}", graph_json
    )


def render_all_callgraph_page(project: Project, filepath: str, depth: int = -1) -> str:
    return render_callgraph_page(project, None, depth, filepath)


def render_runtime_page(project: Project, filepath: str, entry: int | None = None) -> str:
    graph = runtime_graph_json(project, filepath, entry)
    template = (Path(__file__).parent / "static" / "runtime.html").read_text(encoding="utf-8")
    graph_json = json.dumps(graph, ensure_ascii=False).replace("</", "<\\/")
    # The runtime view deliberately has no file-level abstraction. Never leak
    # the binary filename into the graph UI.
    return template.replace("{{ filepath }}", "当前固件").replace(
        "{{ runtime_json | safe }}", graph_json
    )


def render_callgraph(
    project: Project,
    func_addr: int,
    depth: int = 10,
    format: str = "svg",
    filepath: str | None = None,
) -> str:
    """Render reachable callees from one function as Graphviz output."""
    validate_text_cfg_format(format)
    cfg, callgraph = _callgraph_data(project)
    depths, nodes, edges = _visible_callgraph(cfg, callgraph, func_addr, depth)

    graph = Dot(graph_type="digraph", rankdir="LR")
    graph.set_node_defaults(shape="box", fontname="monospace", fontsize="9")
    graph.set_edge_defaults(fontname="monospace", fontsize="8")
    for addr in sorted(nodes):
        name = _function_name(cfg, addr)
        label = f"{name}\\n0x{addr:x}\\nd={depths[addr]}"
        attributes = {"label": label}
        if filepath is not None:
            # Graphviz supports clickable nodes through the SVG URL attribute.
            attributes["URL"] = (
                f"/cfg?filepath={quote(filepath, safe='')}&function=0x{addr:x}"
            )
        graph.add_node(PydotNode(f"n{addr:x}", **attributes))
    for source, target in edges:
        graph.add_edge(PydotEdge(f"n{source:x}", f"n{target:x}"))

    value = graph.create(format=format)
    return value.decode("utf-8") if isinstance(value, bytes) else value


def install_routes(app: object) -> None:
    """Attach /callgraph and /api/callgraph to an existing FastAPI app."""
    from bingraph.api import app as app_module

    static_dir = Path(__file__).parent / "static"
    if not any(getattr(route, "path", None) == "/_static" for route in app.routes):
        app.mount("/_static", StaticFiles(directory=static_dir), name="callgraph-static")

    def get_project(filepath: str) -> Project:
        path = app_module.resolve_under_root(app_module.get_settings().root, filepath)
        return app_module.load_project(path)

    @app.get("/", response_class=HTMLResponse)
    def home() -> HTMLResponse:
        return HTMLResponse(
            """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>bingraph native</title>
  <style>
    body { font: 16px/1.55 system-ui, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 20px; color: #202124; }
    code { background: #f3f4f6; padding: 2px 5px; border-radius: 4px; }
    li { margin: 8px 0; }
  </style>
</head>
<body>
  <h1>bingraph native</h1>
  <p>本机 pybingraph 已运行。输入相对于 <code>--root</code> 的固件路径：</p>
  <form action="/runtime" method="get">
    <label for="filepath">固件相对路径</label>
    <input id="filepath" name="filepath" placeholder="firmware.elf" required>
    <button type="submit">打开运行结构</button>
  </form>
  <p>也可以直接访问 <code>/runtime?filepath=&lt;相对路径&gt;</code>。</p>
  <ul>
    <li><a href="/docs">API 文档 (Swagger UI)</a></li>
    <li><a href="/openapi.json">OpenAPI 描述</a></li>
    <li><code>/symtab?filepath=&lt;相对路径&gt;</code>：应用符号表</li>
    <li><code>/runtime?filepath=&lt;相对路径&gt;</code>：运行结构（唯一 main 入口、完整运行层级、中断外挂、用户分组）</li>
    <li><code>/callgraph/all?filepath=&lt;相对路径&gt;</code>：全固件调用图</li>
    <li><code>/cfg?filepath=&lt;相对路径&gt;&amp;function=0x地址</code>：单函数 CFG</li>
  </ul>
  <p>推荐使用“运行结构”：从 main 按实际调用顺序展开，中断独立挂在外部，库函数默认折叠，并支持用户自定义折叠分组。</p>
</body>
</html>"""
        )

    @app.get("/callgraph/all")
    def callgraph_all(filepath: str = Query(...)) -> HTMLResponse:
        page = render_all_callgraph_page(get_project(filepath), filepath)
        return HTMLResponse(page)

    @app.get("/runtime")
    def runtime(filepath: str = Query(...)) -> HTMLResponse:
        page = render_runtime_page(get_project(filepath), filepath)
        return HTMLResponse(page)

    @app.get("/api/runtime/json")
    def api_runtime_json(
        filepath: str = Query(...),
        entry: str | None = Query(None),
    ) -> JSONResponse:
        entry_addr = parse_address(entry) if entry else None
        return JSONResponse(runtime_graph_json(get_project(filepath), filepath, entry_addr))

    @app.get("/api/functions/json")
    def api_functions_json(filepath: str = Query(...)) -> JSONResponse:
        return JSONResponse(all_functions_json(get_project(filepath), filepath))

    @app.get("/api/callgraph/all/json")
    def api_callgraph_all_json(filepath: str = Query(...)) -> JSONResponse:
        return JSONResponse(callgraph_json(get_project(filepath), None, -1, filepath))

    @app.get("/callgraph")
    def callgraph(
        filepath: str = Query(...),
        function: str = Query(...),
        depth: int = Query(-1, ge=-1, le=100),
        view: str = Query("interactive", pattern="^(interactive|svg)$"),
    ) -> Response:
        if view == "svg":
            svg = render_callgraph(
                get_project(filepath), parse_address(function), depth, "svg", filepath
            )
            return Response(content=svg, media_type="image/svg+xml")
        page = render_callgraph_page(
            get_project(filepath), parse_address(function), depth, filepath
        )
        return HTMLResponse(page)

    @app.get("/api/callgraph/json")
    def api_callgraph_json(
        filepath: str = Query(...),
        function: str = Query(...),
        depth: int = Query(-1, ge=-1, le=100),
    ) -> JSONResponse:
        value = callgraph_json(
            get_project(filepath), parse_address(function), depth, filepath
        )
        return JSONResponse(value)

    @app.get("/api/callgraph")
    def api_callgraph(
        filepath: str = Query(...),
        function: str = Query(...),
        depth: int = Query(-1, ge=-1, le=100),
        format: str = Query("dot"),
    ) -> JSONResponse:
        value = render_callgraph(
            get_project(filepath), parse_address(function), depth, format, filepath
        )
        return JSONResponse({"graph": value, "depth": depth})
