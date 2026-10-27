"""Launch pybingraph on Windows with PE and bare-metal compatibility fixes.

pybingraph 0.2.5 has two Windows-relevant gaps:

* PE imports are treated as in-image function symbols, so stripped PE files
  never reach its CFGFast fallback.
* The bounded custom CFG builder can initialize Windows simulation libraries
  and raise a missing-ntoskrnl error. CFGFast is sufficient for rendering.

This wrapper applies narrow, in-memory compatibility patches and delegates the
CLI to upstream pybingraph.
"""

from __future__ import annotations

import os
from functools import lru_cache
from itertools import groupby
from pathlib import Path
import shutil
import sys
from typing import Sequence


GRAPHVIZ_ENV = "BINGRAPH_NATIVE_GRAPHVIZ"
BLOB_ENV = "BINGRAPH_NATIVE_BLOB_SPECS"


def _graphviz_candidates() -> list[Path]:
    """Return Graphviz bin candidates without tying the repo to one machine."""
    candidates: list[Path] = []
    configured = os.environ.get(GRAPHVIZ_ENV)
    if configured:
        candidates.append(Path(configured))

    repo_root = Path(__file__).resolve().parents[2]
    candidates.extend([
        repo_root / "tools" / "graphviz" / "bin",
        repo_root / "tools" / "graphviz-16.1.0" / "Graphviz-16.1.0-win64" / "bin",
    ])

    dot = shutil.which("dot")
    if dot:
        candidates.append(Path(dot).resolve().parent)
    return candidates


def _ensure_graphviz() -> None:
    """Prefer an explicit env path, then repo-local tooling, then system PATH."""
    for candidate in _graphviz_candidates():
        dot = candidate / ("dot.exe" if os.name == "nt" else "dot")
        if dot.is_file():
            path = os.environ.get("PATH", "")
            if str(candidate) not in path.split(os.pathsep):
                os.environ["PATH"] = str(candidate) + os.pathsep + path
            return


def _blob_specs() -> dict[str, tuple[int, str, int | None]]:
    """Parse NAME:BASE_ADDR:ARCH[:ENTRY_ADDR] specifications from the environment."""
    raw = os.environ.get(BLOB_ENV, "")
    entries = [part.strip() for part in raw.split(";") if part.strip()]
    specs: dict[str, tuple[int, str, int | None]] = {}
    for item in entries:
        try:
            # rsplit() would merge an empty trailing entry and shift fields.
            parts = item.split(":")
            if len(parts) not in (3, 4):
                continue
            name, base, arch, *entry_parts = parts
            if not name or not arch:
                continue
            entry = entry_parts[0] if entry_parts else None
            specs[name.casefold()] = (int(base, 0), arch, int(entry, 0) if entry else None)
        except ValueError:
            continue
    return specs


def _load_project(path: Path) -> object:
    """Load ELF/PE normally and recognized raw firmware images as ARM blobs."""
    from angr import Project

    spec = _blob_specs().get(path.name.casefold())
    if spec is None:
        return Project(str(path), auto_load_libs=False)
    base_addr, arch, entry = spec
    return Project(
        str(path),
        main_opts={"backend": "blob", "base_addr": base_addr, "arch": arch, "entry_point": entry},
        auto_load_libs=False,
    )


def _install_loader() -> None:
    import bingraph.core.project as project_module

    original_load_project = project_module.load_project

    @lru_cache(maxsize=None)
    def load_project(path: Path) -> object:
        return _load_project(path)

    project_module.load_project = load_project

    import bingraph.core as core_module
    import bingraph.api.app as app_module

    core_module.load_project = load_project
    app_module.load_project = load_project


def _install_symbol_fallback() -> None:
    from angr import KnowledgeBase, Project
    from bingraph.helpers.symbols import FunctionSymbol, UNKNOWN_FUNC
    import bingraph.helpers.symbols as symbols_module

    @lru_cache
    def list_function_symbols(project: Project) -> list[FunctionSymbol]:
        """Prefer in-image symbols; fall back to CFG discovery for stripped images."""
        symbols = [
            FunctionSymbol(
                name=symbol.name or UNKNOWN_FUNC,
                addr=symbol.rebased_addr,
                size=symbol.size,
                is_import=False,
                origin="symtab",
            )
            for symbol in project.loader.main_object.symbols
            if symbol.is_function and not symbol.is_import
        ]

        if not symbols:
            kb = KnowledgeBase(project)
            cfg = project.analyses.CFGFast(
                kb=kb,
                force_smart_scan=False,
                resolve_indirect_jumps=False,
                data_references=False,
            )
            symbols = [
                FunctionSymbol(
                    name=func.name or UNKNOWN_FUNC,
                    addr=func.addr,
                    size=func.size,
                    is_import=func.is_plt,
                    origin="cfg",
                )
                for func in cfg.kb.functions.values()
                if not (
                    func.is_simprocedure or func.is_alignment or func.is_syscall
                )
            ]

        symbols.sort(key=lambda symbol: (symbol.addr, symbol.name))
        symbols = [
            next(group)
            for _, group in groupby(symbols, key=lambda s: (s.addr, s.name))
        ]
        return [symbol for symbol in symbols if symbol.size > 0]

    symbols_module.list_function_symbols = list_function_symbols

    # These modules imported the function by value while loading before the patch.
    import bingraph.cfg.anomalies as anomalies_module
    import bingraph.core.project as project_module

    anomalies_module.list_function_symbols = list_function_symbols
    project_module.list_function_symbols = list_function_symbols

    import bingraph.core as core_module
    import bingraph.api.app as app_module

    core_module.list_function_symbols = list_function_symbols
    app_module.list_function_symbols = list_function_symbols


def _install_cfg_fallback() -> None:
    """Use CFGFast for PE and raw ARM blobs instead of the custom builder."""
    import bingraph.core.project as project_module

    original_get_cfg = project_module.get_cfg

    @lru_cache(maxsize=None)
    def has_incompatible_custom_builder(project: object) -> bool:
        try:
            obj = project.loader.main_object
            is_pe = str(obj.os).lower() == "windows" and obj.__class__.__module__.startswith(
                "cle.backends.pe"
            )
            is_blob = obj.__class__.__name__ == "Blob"
            return is_pe or is_blob
        except Exception:
            return False

    def get_cfg(project: object, func_addr: int, cfg_mode: str | None = None) -> object:
        resolved_mode = cfg_mode
        if resolved_mode is None:
            from bingraph.helpers import get_settings

            resolved_mode = get_settings().cfg_mode
        if resolved_mode == "custom" and has_incompatible_custom_builder(project):
            resolved_mode = "none"
        return original_get_cfg(project, func_addr, resolved_mode)

    get_cfg.cache_clear = original_get_cfg.cache_clear
    get_cfg.cache_info = original_get_cfg.cache_info
    project_module.get_cfg = get_cfg

    # render_cfg imported get_cfg by value at import time.
    import bingraph.core.render as render_module

    render_module.get_cfg = get_cfg


def _install_callgraph_route() -> None:
    """Wrap app creation so the call-graph routes are present at startup."""
    import bingraph.api.app as app_module

    original_create_app = app_module.create_app

    def create_app():
        app = original_create_app()
        from .callgraph import install_routes

        install_routes(app)
        return app

    app_module.create_app = create_app

    import bingraph.api.cli as cli_module

    cli_module.create_app = create_app


def main(argv: Sequence[str] | None = None) -> None:
    _ensure_graphviz()
    _install_loader()
    _install_symbol_fallback()
    _install_cfg_fallback()
    _install_callgraph_route()
    from bingraph.api.cli import main as upstream_main

    if argv is not None:
        sys.argv[1:] = list(argv)
    upstream_main()


if __name__ == "__main__":
    main()
