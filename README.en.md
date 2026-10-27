<div align="center">

<img src="assets/kdock-logo.png" width="96" alt="KDock" />

# KDock

**An embedded debugging workbench with an Agent that can use every built-in tool**

Serial, network, flashing, devices, firmware analysis, instruments and workflows—in one window.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB)
![Rust](https://img.shields.io/badge/Rust-1.80%2B-orange)

[中文](README.md) ｜ **English**

</div>

---

## Contents

- [Download and run](#download-and-run)
- [What it does](#what-it-does)
- [Working together](#working-together)
- [Build from source](#build-from-source)
- [Screenshots](#screenshots)
- [Project layout](#project-layout)
- [Open source and licensing](#open-source-and-licensing)
- [Documentation](#documentation)

## Download and run

Only automatically built **Pre-release** test builds are available:

**[Download the latest test build](https://github.com/Kyin-code/KDock/releases/tag/test-latest)**

- `KDock-*-win-x64.zip`: portable, unzip and run `KDock.exe`
- `KDock_*_x64-setup.exe`: NSIS installer
- `kdock.exe`: bare executable

Requires Windows x64 and the WebView2 Runtime. Builds are unsigned and may trigger SmartScreen.
Test builds can change local settings or crash; back up first.

## What it does

- **Links**: serial, TCP/UDP, SSH, USBPcap and tshark.
- **Devices**: `.fw` upgrade, OpenOCD/J-Link, device files, FTP/FTPS/TFTP and ADB.
- **Analysis**: ELF/BIN runtime graph, call chains, CFG and logic analyzer.
- **Tools**: scope, commands, live charts, batch text, calculator and workflow.
- **Agent**: chat, skills, MCP, workspaces, approvals and device analysis.

## Working together

- **Agent**: describe a goal; it uses tools with permission checks.
- **Automation**: capture operations and project rules in workflows, `AGENTS.md`, skills and MCP.
- **Development**: open issues or PRs; pass `cargo test --workspace --locked` and `npm run build`.

## Build from source

Requires Windows x64, Node.js 18+, Rust 1.80+ (MSVC toolchain) and Tauri 2 dependencies.

```powershell
git clone https://github.com/Kyin-code/KDock.git
cd KDock
npm ci

# First runtime-analyzer build, about 500 MB
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/bingraph/build-portable.ps1 -NoGraphviz

# Development
npm run tauri dev

# Tests and release package
cargo test --workspace --locked
npm run tauri build
```

Outputs:

- `target/release/kdock.exe`
- `target/release/bundle/nsis/KDock_0.3.0_x64-setup.exe`

Use `npm run tauri build`; `cargo build --release` alone does not package the frontend correctly.

## Screenshots

> UI preview only. Press F1 for contextual help.

| Workbench | Runtime graph |
| --- | --- |
| ![Workbench](docs/images/readme-overview.png) | ![Runtime graph](docs/images/readme-runtime.png) |

| Logic analyzer | Agent |
| --- | --- |
| ![Logic analyzer](docs/images/readme-logic.png) | ![Agent](docs/images/readme-agent.png) |

## Project layout

```text
src/                    Vite frontend
src-tauri/              Tauri 2 / Rust backend and Agent
crates/kdock-core/      Serial, HEX, line endings and session core
tools/bingraph/         Portable firmware analyzer source and build script
resources/bingraph/     Generated bundle, not tracked by Git
docs/                   Protocol, algorithm and feature docs
```

## Open source and licensing

KDock itself is [Apache-2.0](LICENSE).

Core open-source projects:

| Project | Purpose | License |
| --- | --- | --- |
| [Tauri](https://github.com/tauri-apps/tauri) | Desktop framework | MIT OR Apache-2.0 |
| [uPlot](https://github.com/leeoniya/uPlot) | Live charts | MIT |
| [pybingraph](https://github.com/manelfx/pybingraph) | Firmware function/CFG analysis | BSD-2-Clause |
| [angr](https://angr.io/) | Binary analysis and symbolic execution | BSD-2-Clause |
| [Python](https://www.python.org/) | Portable analyzer runtime | PSF-2.0 |
| [Cytoscape.js](https://js.cytoscape.org/) | Analyzer offline graph UI | MIT |

The firmware analyzer runs as an **independent Python child process**. Release artifacts retain
licenses and notices for **78 Python distributions**. `pyvex` contains LibVEX
(`GPL-2.0-or-later`); KDock does not modify it and uses it only in that separate process.
See [NOTICE](NOTICE) and the
[third-party inventory](tools/bingraph/THIRD_PARTY_NOTICES.md).

USBPcap, tshark, sigrok, ADB/scrcpy, DSView, J-Link and OpenOCD are optional external tools.
KDock invokes user-installed programs and does not bundle or relicense them.

## Documentation

- [Firmware packages and upgrade protocol](docs/01-固件包格式与打包算法.md)
- [Flashing and external programmers](docs/05-烧录-外部烧录器.md)
- [Device file transfer](docs/06-设备文件传输.md)
- [Logic analyzer validation](docs/09-逻辑分析仪-准确性与解码自测.md)
- [Firmware runtime analyzer](docs/10-固件运行结构分析器.md)
- [Changelog](CHANGELOG.md)
