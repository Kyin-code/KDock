import assert from "node:assert/strict";
import {
  FLASH_ROM_TOOLS,
  flashToolUi,
  isFlashRomTool,
  isSerialRomTool,
} from "../src/flash-rom.js";

assert.equal(isFlashRomTool("stm32dfu"), true);
assert.equal(isFlashRomTool("stm32uart"), true);
assert.equal(isFlashRomTool("esprom"), true);
assert.equal(isFlashRomTool("openocd"), false);
assert.equal(isSerialRomTool("stm32uart"), true);
assert.equal(isSerialRomTool("esprom"), true);
assert.equal(isSerialRomTool("stm32dfu"), false);
assert.deepEqual(flashToolUi("stm32dfu"), {
  rom: true,
  serialRom: false,
  dfu: true,
  kdockOta: false,
  probe: false,
});
assert.deepEqual(flashToolUi("openocd"), {
  rom: false,
  serialRom: false,
  dfu: false,
  kdockOta: false,
  probe: true,
});

assert.deepEqual(
  FLASH_ROM_TOOLS.stm32dfu.mk({
    tool: "stm32dfu",
    action: "flash",
    file: "D:\\fw\\app.hex",
  }),
  ["-c", "port=USB1", "-w", "D:\\fw\\app.hex", "-v", "-rst"],
);

assert.deepEqual(
  FLASH_ROM_TOOLS.stm32uart.mk({
    tool: "stm32uart",
    action: "flash",
    file: "D:\\fw\\app.bin",
    port: "COM5",
    addr: "0x08000000",
  }),
  ["-c", "port=COM5", "-w", "D:\\fw\\app.bin", "0x08000000", "-v", "-rst"],
);

assert.deepEqual(
  FLASH_ROM_TOOLS.esprom.mk({
    tool: "esprom",
    action: "flash",
    file: "D:\\fw\\merged.bin",
    port: "COM7",
    baud: 460800,
    addr: "0x0",
  }),
  ["--port", "COM7", "--baud", "460800", "write_flash", "0x0", "D:\\fw\\merged.bin"],
);

assert.deepEqual(
  FLASH_ROM_TOOLS.esprom.mk({
    tool: "esprom",
    action: "erase",
    port: "COM7",
    baud: 115200,
  }),
  ["--port", "COM7", "--baud", "115200", "erase_flash"],
);

assert.throws(
  () => FLASH_ROM_TOOLS.stm32uart.mk({
    tool: "stm32uart",
    action: "flash",
    file: "D:\\fw\\app.bin",
    port: "",
  }),
  /需要选择串口/,
);

assert.throws(
  () => FLASH_ROM_TOOLS.esprom.mk({
    tool: "esprom",
    action: "flash",
    file: "D:\\fw\\app.hex",
    port: "COM7",
  }),
  /只接受 \.bin/,
);

console.log(JSON.stringify({
  ok: true,
  tools: [...Object.keys(FLASH_ROM_TOOLS)],
  checked: ["stm32dfu", "stm32uart", "esprom", "validation"],
}, null, 2));
