<div align="center">

<img src="assets/kdock-logo.png" width="96" alt="KDock" />

# KDock

**面向嵌入式开发的桌面工作台：串口 / 网络调试 · 固件升级(OTA) · 烧录 · 设备文件 · 会自己动手的 AI 助手**

串口与网络收发、命令速查、固件打包/升级/烧录、设备文件读写、实时图表、时序编排，
外加一个能直接调这些能力的 Agent —— 全部在一个窗口里。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB)
![Rust](https://img.shields.io/badge/Rust-1.80%2B-orange)

</div>

---

## 目录

- [它能做什么](#它能做什么)
- [截图](#截图)
- [快速开始](#快速开始)
- [界面速览](#界面速览)
- [示波器](#示波器)
- [Agent 使用说明](#agent-使用说明)
- [协议与算法文档](#协议与算法文档)
- [从源码构建](#从源码构建)
- [目录结构](#目录结构)
- [常见问题](#常见问题)
- [开源协议与致谢](#开源协议与致谢)
- [版本管理](#版本管理)

## 它能做什么

| 分类 | 能力 |
| --- | --- |
| **传输** | 串口（全参数组合）、TCP/UDP 客户端与服务器、HEX/文本双模式、行尾处理、编码切换、会话日志与回放、ANSI 终端渲染、快捷发送 |
| **调试辅助** | 命令表速查（标准 Linux 命令）、批量文本处理、计算器（含 32 位控制板 / IEEE754 / 文件校验） |
| **固件** | `.fw` 升级包解析与校验、**串口在线升级（YMODEM）**、**网口在线升级（服务通道）**、从 HTTP 服务器拉取版本清单 |
| **烧录** | 调用外部烧录器（OpenOCD / J-Link / STM32CubeProgrammer）完成烧录、擦除、校验、复位 |
| **设备文件** | 列目录、取回/下发文件、CRC 核对（串口走 base64，网口走服务通道按偏移读写） |
| **可视化** | 实时图表（多通道曲线）、屏幕捕获、**示波器**（RIGOL DS1000Z 系 SCPI：状态 / 13 项自动测量 / 多通道波形 / 截屏 / 时基触发控制）、逻辑分析仪位 |
| **中控编排** | 把「本机命令 / TCP / UDP / 串口」串成带条件分支的时序流程，一键跑 |
| **AI Agent** | 内置对话式助手：能调上面这些能力；支持 OpenAI 兼容 / Anthropic 两种协议、技能（SKILL.md）、MCP 服务、上下文压缩、出字速度与花费统计 |

## 截图

**传输页：串口 / 网络收发 + HEX 视图 + 会话日志**

![传输页](docs/images/01-transfer.png)

**命令表：标准 Linux 命令速查，点一下填进发送框**

![命令表](docs/images/02-commands.png)

**Agent：对话式调试助手，能直接读写设备、升级、烧录**

![Agent](docs/images/03-agent.png)

**批量文本：多行去重/排序/转格式，按间隔逐行发到串口**

![批量文本](docs/images/04-batch-text.png)

**计算器：C 风格表达式 + 传统键盘 + 32 位控制板 + 文件校验**

![计算器](docs/images/05-calculator.png)

**示波器：RIGOL DS1000Z 系（SCPI over TCP）—— 状态 / 自动测量 / 多通道波形 / 截屏**

![示波器](docs/images/06-scope.png)

**Agent 信息页：技能与 MCP 开关、上下文成分、缓存命中与花费；技能由 agent 自己按需读取**

![技能与 MCP](docs/images/07-skills.png)

## 快速开始

1. 打开 **传输** 页，选串口（或 TCP/UDP），点「连接」；
2. 发送框里写内容，`Enter` 发送、`Shift+Enter` 换行；HEX 形如 `41 54 0D 0A`；
3. 想升级固件：**固件升级** 页 → 选本地 `.fw` 或填服务器地址 → 选串口/网口通道 → 开始；
4. 想烧片：**烧录** 页 → 选工具与型号 → 选文件 → 烧录；
5. 想要个帮手：**Agent** 页 → 在设置里配一个模型（供应商 + API Key）→ 直接说需求。

## 界面速览

### 传输

- 串口参数（波特率/数据位/停止位/校验/流控）与网络参数都在右栏；连接状态在标题栏与状态点；
- 输出区支持 HEX/文本切换、时间戳、发送/接收着色、暂停与回看、导出会话日志；
- 「终端模式」把设备发出的 ANSI 序列渲染出来（退格、重绘、光标移动），像终端一样用；
- 快捷发送可以自己加常用命令。

### 命令表

标准 Linux 命令速查，按「文件 / 文本 / 系统 / 网络 / 权限」分组，带参数模板；
点命令名填进发送框，点 `▶` 直接发。搜索框支持命令名与说明。

### 固件升级

- **包**：`.fw` = 64 字节包头（magic / 版本 / payload CRC / 包头 CRC / 板卡名）+ 镜像；
- **通道**：串口（设备端 YMODEM 在线升级）或网口（服务端口按偏移写 + 校验 + 打升级标记 + 复位）；
- **来源**：本地文件，或 HTTP 服务器的版本清单（自动按版本排序、下载后自检 CRC）；
- 每一步都有明确进度与"卡在哪一步"的人话报错。

### 烧录

界面只负责拼命令行并把输出实时回显；支持 OpenOCD / J-Link / STM32CubeProgrammer，
工具路径、适配器、型号、速度这些填一次就记住。适合首件、救砖、产线。

### 文件管理

列设备目录、取回文件、下发文件、核对 CRC；串口走 `base64`，网口走服务通道。

### 实时图表 / 屏幕捕获 / 示波器 / 中控编排

- 设备按 `1.23,4.56,7.89` 每行发一串数字，图表自动分通道画曲线；
- 屏幕捕获用系统桌面复制抓帧，参数可调；
- **示波器**支持普源（RIGOL）DS1000Z 系，详见下面单独一节；
- 中控编排把多路连接串成流程，支持条件分支、超时、等待与日志。

### 批量文本 / 计算器

- **批量文本**：多行去重/排序/加前后缀/加行号、转 HEX 数组 / HEX 串 / JSON / CSV / C 数组、
  搜索替换（Ctrl+F，支持全词、模糊、正则）、JSON 格式化、正则批量处理、大小写与缩进整理（选区优先）、
  按间隔逐行发到串口；
- **计算器**：C 风格表达式（`0x/0b/0o`、`<< >> & | ~ % **`，手写解析不用 eval）、传统键盘、
  **32 位控制板**（点任意一位即改并反馈到计算区）、IEEE 754 浮点↔位（含符号/阶码/尾数拆解）、
  进制换算、**文件校验**（CRC32 / CRC16-CCITT / CRC16-MODBUS / MD5 / SHA1 / SHA256，可只算某一段）。

## 示波器

连的是 RIGOL DS1000Z / DS1000Z-E 系（DS1054Z、DS1202Z-E 这些）标配的网口口子：**TCP 5555，SCPI 文本**。

- **状态**：型号（`*IDN?`）、各通道开关 / 档位 / 偏移 / 耦合 / 探头、时基、采样率、存储深度、触发源与电平；
- **通道卡片**：直接改 V/div 与偏移（点「应用」下发到示波器）；
- **自动测量**：频率 / 周期 / 峰峰 / 最大最小 / 平均 / 有效值 / 顶底电平 / 上升下降时间 / 正负占空，
  共 13 项，可以勾「连续」每 2 秒刷一次；没接信号的那一路显示 `—`（示波器回的是 9.9E37，按"测不到"处理）；
- **波形**：多通道一起画（一通道一色，鼠标悬停读数），点数是屏幕的 1200 点，
  也可以选深存储（存储深度是 AUTO 时会提示"示波器只给了 1200 点"）；
- **截屏**：直接取示波器屏幕（`DISP:DATA?` 回的二进制 PNG）就地显示，可另存为；
- **控制**：时基 / 触发源 / 触发电平 / RUN·STOP / 自动设置，外加一个 SCPI 控制台（带回复日志）。

同一套能力也挂在 **Agent** 上：`scope_connect` / `scope_info` / `scope_measure` /
`scope_waveform`（回摘要 + 字符画）/ `scope_screenshot`（默认存进会话工作区）/ `scope_control`，
再加上一条裸 `scope <cmd>`。所以"连着示波器看看 CH2 是什么波形"这种话可以直接跟 agent 说。

> 注意：DS1000Z 的 SCPI 口同时只接受**一个**客户端；被别的程序占着时本程序会自动重连，
> 但别同时开两个上位机。

## Agent 使用说明

右栏三页：**Agent 信息 / 文本 / 浏览器**。

**模型**：设置 → 模型与供应商里配「供应商 profile」（OpenAI 兼容的 `base_url`，或 Anthropic 格式），
每个 profile 一个 Key（Windows 上用 DPAPI 按当前用户加密存储）。对话页下方的下拉可以随时切换，
会显示实时负载（AMD Radeon Cloud 那批免费模型）与测得的出字速度。

**权限**（对话页底部）：

| 档位 | 行为 |
| --- | --- |
| 只读 | 写设备 / 写文件 / 跑命令 / 烧录一律拒绝 |
| 需要批准 | 危险动作先弹卡片让你点允许/拒绝；切到「自动」时正等着的会立刻放行 |
| 自动 | 直接执行（做完汇报） |

**技能**：一份 `SKILL.md`（frontmatter 的 name/description 进系统提示，正文按需读）。
Agent 信息页只管开关，路径 / 导入 / 编辑都在 设置 → 技能。

**MCP**：设置 → MCP 里加 stdio 服务（`command` + `args` + `env`，也兼容其它工具那种
`command` 数组 + `environment` 的写法）；Agent 信息页只管启用开关。远程 HTTP 类型暂不支持。

**斜杠命令**：`/goal <目标>`（长期目标，每轮注入）、`/compact`、`/new`、`/perm ask|auto|read`、
`/stop`、`/help`。

**上下文与花费**：Agent 信息页显示上下文占用、成分分析（系统提示 / 工具定义 / 摘要 / 用户消息 /
助手回复 / 工具调用）、缓存命中率、估算花费与出字速度（只统计模型正在出字的那段）。

## 协议与算法文档

升级、OTA 包、烧录这几块"实现细节多、容易踩坑"的功能都单独成文：

| 文档 | 内容 |
| --- | --- |
| [01 固件包格式与打包算法](docs/01-固件包格式与打包算法.md) | `.fw` 包头逐字节布局、版本号编码、CRC 算法、校验顺序 |
| [02 串口在线升级](docs/02-固件升级-串口在线升级.md) | YMODEM 流程、超时与重试、失败定位 |
| [03 网口升级与服务通道协议](docs/03-固件升级-网口服务通道.md) | SVC1/SVR1 帧格式、命令码、seq 去重、错误码表 |
| [04 固件服务器与版本管理](docs/04-固件服务器与版本管理.md) | 清单格式、版本比较、下载后自检 |
| [05 烧录（外部烧录器）](docs/05-烧录-外部烧录器.md) | OpenOCD / J-Link / CubeProgrammer 命令拼装与排错 |
| [06 设备文件传输](docs/06-设备文件传输.md) | 串口 base64 与网口按偏移读写的取舍与流程 |

## 从源码构建

需要 Node.js 18+、Rust 1.80+（MSVC 工具链）与 Tauri 2 的系统依赖。

```bash
npm install
npm run dev            # 只跑前端（配合下面的 tauri dev）
npm run tauri dev      # 开发模式：前端热更 + Rust 后端
cargo test --workspace # 单元测试（在 src-tauri 目录下，或加 --manifest-path）
npm run tauri build    # 出包：Windows 下产物是 target/release/kdock.exe
```

> ⚠️ 出包**只能**用 `npm run tauri build`。直接 `cargo build --release` 编出来的是 dev 模式二进制，
> 它会去加载 `devUrl`（`http://localhost:1420`）；没有前端开发服务器时窗口就是浏览器那个
> "无法访问此页"。

> 🔧 调试口子：debug 构建里设 `KDOCK_DEBUG_PORT=<端口>` 再启动，会给 WebView2 打开远程调试端口，
> 可以用 CDP 脚本驱动界面做回归测试（release 包里这段代码不存在）。

## 目录结构

```
.
├─ crates/kdock-core/     协议层：HEX 编解码、行尾、波特率、串口参数映射、会话日志（与 UI 解耦，可单独测）
├─ src-tauri/             Tauri 2 应用：串口/网络 I/O、升级与烧录、Agent、文件与窗口命令
│  └─ src/agent/          Agent：LLM 客户端、工具、技能、MCP、会话存储
├─ src/                   前端（Vite + 原生 JS，无框架）
│  ├─ main.js             界面与业务逻辑
│  └─ tools-batch-calc.js 批量文本 / 计算器
├─ docs/                  功能与协议说明、截图
├─ tools/                 辅助脚本（图标生成等）
└─ dist/                  前端构建产物（被 Tauri 内嵌，不入库）
```

## 常见问题

**Q：双击 exe 没反应 / 闪退？**
A：先看是不是已经开着一个 KDock（单实例：第二次启动只会把已有窗口叫到前面）。
若上次是被强杀的，WebView2 的进程可能还占着数据目录，等几秒或结束残留的 `msedgewebview2.exe` 再试。

**Q：窗口边框 / 任务栏图标不对？**
A：自绘无边框窗口在 Windows 上要额外处理非客户区，代码里已经处理（含最大化贴工作区与 DWM 描边）。
遇到异常请带上系统版本反馈。

**Q：升级中途断电/断线会怎样？**
A：设备端会拒收不完整的包；重跑一次升级即可（网口按偏移写，会覆盖）。详见 `docs/03`。

**Q：`/goal` 设了目标但没生效？**
A：目标存在会话里，每轮都会拼进系统提示；用 `/goal` 可以查当前值，`/goal clear` 清除。

**Q：为什么有些界面文字是英文？**
A：设置 → 通用里可以切换中英文，切换是即时生效的。

## 版本管理

- **应用版本**走 [语义化版本](https://semver.org/lang/zh-CN/) `MAJOR.MINOR.PATCH`，当前
  `v0.3.0`（关于页也会显示实时值）。版本号在这三处保持一致：
  `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json`；
- 每次发版在 [CHANGELOG.md](CHANGELOG.md) 追加一段，并打 `vX.Y.Z` 的 git tag
  （例如 `git tag v0.3.0 && git push origin v0.3.0`）；
- **固件包版本**是另一套：`.fw` 包头里的三段式 `PD_HW.PD_SW.PD_FIX`，用于设备端判断能否升级/降级，
  与应用版本无关（见 [docs/01](docs/01-固件包格式与打包算法.md)）；
- 应用内「设置 → 关于与数据」里也写了同样的约定，并给出当前版本、作者与仓库地址。

## 开源协议与致谢

本项目以 **Apache License 2.0** 开源，见 [LICENSE](LICENSE)；第三方组件与借鉴项目的声明见 [NOTICE](NOTICE)。

特别感谢（设计/交互参考过的开源项目）：

- [MICU-OmniProbe](https://github.com/zuoliangyu/MICU-OmniProbe)（README 声明 MIT）：
  实时图表的实现思路与配色方案参考了它；
- [opencode](https://github.com/anomalyco/opencode)：Agent 的交互形态参考了它 ——
  上下文成分/花费面板、技能与 MCP 的组织方式、"边跑边补充方向"这些都受益于它；
- [CC Switch](https://github.com/farion1231/cc-switch)：供应商 profile 列表与技能管理的组织方式参考了它；
- [Tauri](https://github.com/tauri-apps/tauri)、[uPlot](https://github.com/leeoniya/uPlot)、
  [RustCrypto](https://github.com/RustCrypto) 等开源项目提供的坚实基础。

欢迎 issue / PR。

<sub>English README: [README.en.md](README.en.md)</sub>
