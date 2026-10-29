/** 厂商 ROM Bootloader 烧录命令。
 *
 * 这些协议直接跑芯片出厂系统区里的下载器，不依赖 KDock 自有 bootloader、
 * YMODEM 或 SVC1。上层只负责判断 BOOT 模式、选串口/文件，再把命令交给
 * 已有的 flash_run 进程通道。
 */

export const FLASH_ROM_TOOL_IDS = new Set(["stm32dfu", "stm32uart", "esprom"]);

export function isFlashRomTool(tool) {
  return FLASH_ROM_TOOL_IDS.has(tool);
}

export function isSerialRomTool(tool) {
  return tool === "stm32uart" || tool === "esprom";
}

export function flashToolUi(tool) {
  const rom = isFlashRomTool(tool);
  return {
    rom,
    serialRom: isSerialRomTool(tool),
    dfu: tool === "stm32dfu",
    kdockOta: tool === "netudp",
    probe: !rom && tool !== "netudp",
  };
}

function stm32Common(o) {
  const port = String(o.port || "").trim();
  if (o.tool === "stm32uart" && !port) throw new Error("STM32 UART ROM 需要选择串口");
  const args = ["-c", o.tool === "stm32dfu" ? "port=USB1" : `port=${port}`];
  const file = String(o.file || "").trim();
  const isBin = /\.bin$/i.test(file);
  if (o.action === "flash") {
    if (!file) throw new Error("先选择要烧录的固件");
    args.push("-w", file);
    if (isBin) args.push(String(o.addr || "0x08000000").trim());
    args.push("-v", "-rst");
  } else if (o.action === "erase") {
    args.push("-e", "all", "-rst");
  } else if (o.action === "verify") {
    if (!file) throw new Error("先选择要校验的固件");
    args.push("-v", file);
    if (isBin) args.push(String(o.addr || "0x08000000").trim());
  } else if (o.action === "reset") {
    args.push("-rst");
  }
  return args;
}

export const FLASH_ROM_TOOLS = {
  stm32dfu: {
    exe: "STM32_Programmer_CLI",
    mk: stm32Common,
  },
  stm32uart: {
    exe: "STM32_Programmer_CLI",
    mk: stm32Common,
  },
  esprom: {
    exe: "esptool",
    mk: (o) => {
      const port = String(o.port || "").trim();
      const baud = String(o.baud || "460800").trim();
      const file = String(o.file || "").trim();
      if (!port) throw new Error("ESP ROM 烧录需要选择串口");
      const args = ["--port", port, "--baud", baud];
      if (o.action === "erase") {
        args.push("erase_flash");
        return args;
      }
      if (o.action === "reset") {
        args.push("run");
        return args;
      }
      if (!file) throw new Error("先选择要烧录的 .bin 固件");
      if (!/\.bin$/i.test(file)) throw new Error("ESP ROM 烧录只接受 .bin；多镜像请先合并为一个 bin");
      const addr = String(o.addr || "0x0").trim();
      args.push(o.action === "verify" ? "verify_flash" : "write_flash", addr, file);
      return args;
    },
  },
};
