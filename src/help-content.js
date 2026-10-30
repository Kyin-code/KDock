// 上下文帮助内容。与 UI 代码分离，方便逐页维护。
// 约定：复杂单元写“用途 / 操作 / 联动”，基础单元只保留必要说明。
export const HELP_GROUPS = [
  {
    title: "概览",
    items: [
      {
        id: "help-work",
        title: "Work with KDock",
        zh: "KDock 把连接、设备操作、分析工具和 Agent 放在同一个窗口里。\n### 导航\n- 常用入口保留在左栏：传输、监听、Agent、固件升级、烧录、文件管理、运行结构和环境配置。\n- 低频的命令、知识库、ADB、测量和效率工具收在「高级工具」，状态会记住。\n### 建议流程\n- 先用「环境配置」确认驱动、调试器和工具链齐全。\n- 调试设备时先在「传输」或「监听」确认目标连接。\n- 固件升级、烧录、文件管理都依赖明确的目标和固件格式。\n### 联动\n- 「命令表」「快捷发送」「批量文本」「实时图表」共用传输连接和数据流。\n- 「运行结构」「逻辑分析仪」「示波器」的结果可以被 Agent 查询和总结。\n- F1 打开当前页面帮助。",
        en: "KDock combines links, device operations, analysis tools and the Agent in one window.\n### Navigation\n- Primary entries stay visible: Transfer, Monitor, Agent, Firmware, Flash, Files, Runtime graph and Environment.\n- Low-frequency development, knowledge, ADB, measurement and productivity tools live under Advanced tools, whose state is remembered.\n### Suggested flow\n- Check drivers, debug probes and toolchains in Environment setup first.\n- Confirm the target link in Transfer or Monitor before device operations.\n- Firmware upgrade, flashing and file management depend on the right target and file format.\n### Relationships\n- Commands, Quick send, Batch text and Charts share transfer connections and data.\n- Runtime graph, Logic analyzer and Scope results can be queried and summarized by the Agent.\n- F1 opens help for the current page."
      },
      {
        id: "help-shortcuts",
        title: "快捷键与通用操作",
        zh: "### 快捷键\n- F1：当前页面帮助。\n- Ctrl+,：打开设置。\n- Ctrl+L：清空传输日志。\n- Enter：发送；Shift+Enter：换行。\n- 画布：滚轮缩放、拖动平移；中控里 Delete 删除选中项。\n### 通用规则\n- 带「?」的卡片可以单独打开说明。\n- 长任务会同时写分析/安装日志；失败时优先看日志尾部和提示的临时文件路径。",
        en: "### Shortcuts\n- F1: help for the current page.\n- Ctrl+,: open Settings.\n- Ctrl+L: clear the transfer log.\n- Enter: send; Shift+Enter: newline.\n- Canvas: wheel to zoom, drag to pan; Delete removes the selected workflow item.\n### General rules\n- Cards with ? open their own help section.\n- Long tasks write progress to a log; check its tail and any temporary-file path on failure."
      },
      {
        id: "help-pages",
        title: "页面之间怎么联动",
        zh: "### 连接类\n- 「传输」是主连接；Agent、实时图表、批量文本和中控编排都可以复用它。\n- 「监听」使用独立的抓包会话，不会占用传输页的串口。\n### 设备类\n- 「固件升级」处理 .fw，走设备的串口/网口升级通道。\n- 「烧录」调用 OpenOCD、J-Link、pyOCD 等外部烧录器。\n- 「文件管理」走设备文件服务、FTP/FTPS/TFTP 或内置 TFTP。\n- 「安卓 ADB」与普通串口/网络连接相互独立。\n### 分析类\n- 「运行结构」分析 ELF/BIN 调用图，并可作为 Agent 的结构化上下文。\n- 「示波器」「逻辑分析仪」「屏幕共享」分别管理各自设备/来源。\n### 配置类\n- 「环境配置」安装的驱动和工具会被烧录、监听、逻辑分析仪、ADB 和运行结构复用。",
        en: "### Links\n- Transfer is the main link; Agent, Charts, Batch text and Workflow can reuse it.\n- Monitor uses independent capture sessions and does not take the Transfer serial port.\n### Devices\n- Firmware upgrade handles .fw packages over the device's serial/network upgrade channel.\n- Flash runs external tools such as OpenOCD, J-Link or pyOCD.\n- Files uses device services, FTP/FTPS/TFTP, or the built-in TFTP server.\n- Android ADB is independent from ordinary serial/network links.\n### Analysis\n- Runtime graph analyzes ELF/BIN call graphs and can feed structured context to the Agent.\n- Scope, Logic analyzer and Screen share manage their own devices or sources.\n### Configuration\n- Drivers and tools installed from Environment setup are reused by flashing, Monitor, Logic analyzer, ADB and Runtime graph."
      },
    ],
  },
  {
    title: "传输",
    items: [
      {
        id: "help-transfer-start",
        title: "连接与参数",
        zh: "### 用途\n在右栏选择串口、TCP 客户端/服务端、UDP 或 SSH，并设置对应参数。\n### 操作\n- 串口：选择端口、波特率、数据位、停止位、校验和流控。\n- 网络：填写远端地址、端口或本机监听端口。\n- 点「连接」建立主连接；连接后按钮状态和标题栏会同步变化。\n### 联动\n- Agent 的 port_* 工具操作的就是这条主连接。\n- 中控编排可以引用「主连接」。\n- 实时图表会从收到的文本中提取数字行。\n- 批量文本可以把处理结果逐行发送到当前连接。\n### 注意\n- 主连接是多会话共享的；需要独占设备时让 Agent 使用 link_* 独立连接。",
        en: "### Purpose\nChoose serial, TCP client/server, UDP or SSH in the right panel and configure the matching fields.\n### Usage\n- Serial: port, baud, data bits, stop bits, parity and flow control.\n- Network: remote address/port or a local listening port.\n- Connect to create the main link; the title bar and controls update with its state.\n### Relationships\n- Agent port_* tools operate on this main link.\n- Workflow can reference Main link.\n- Charts extract numeric lines from received text.\n- Batch text can send processed rows through the current link.\n### Note\n- The main link is shared across sessions; Agent link_* tools create independent links."
      },
      {
        id: "help-transfer-receive",
        title: "收发区与显示",
        zh: "### 用途\n中间输出区显示 RX/TX；下方输入区负责发送。\n### 操作\n- Text / HEX 切换显示和发送解释方式；HEX 例：41 54 0D 0A。\n- 行尾决定发送时追加 CR、LF、CRLF 或不追加。\n- 时间戳、序号、方向标记只影响显示；循环发送会按间隔重复。\n- 上翻输出区会暂停跟随，点「↓ 最新」恢复。\n### 联动\n- 快捷发送、命令表、批量文本和 Agent 的发送都会出现在同一日志中。\n- 中控编排如果使用主连接，收发也会同步到此处。\n### 注意\n- ANSI 终端渲染只改变显示，不改变原始收发数据。",
        en: "### Purpose\nThe center output shows RX/TX and the bottom editor sends data.\n### Usage\n- Text / HEX controls display and send interpretation; HEX example: 41 54 0D 0A.\n- Line ending selects CR, LF, CRLF or none.\n- Timestamp, sequence and direction only affect display; loop mode repeats at the configured interval.\n- Scrolling up pauses follow mode; use Jump to latest to resume.\n### Relationships\n- Quick send, Commands, Batch text and Agent sends all appear in the same log.\n- Workflow traffic on the main link is mirrored here.\n### Note\n- ANSI terminal rendering is presentation-only and never changes raw data."
      },
      {
        id: "help-transfer-stats",
        title: "统计",
        zh: "统计当前主连接累计收发的字符数、字节数和日志行数，用于判断设备是否真的有响应。切换连接或清屏后以当前会话状态为准。",
        en: "Shows accumulated characters, bytes and log lines for the current main link, useful for confirming whether the device actually responded."
      },
      {
        id: "help-transfer-quick",
        title: "快捷发送",
        zh: "### 用途\n保存常用命令，点一行即可发送。\n### 操作\n- 「编辑」里可新增、修改、删除和批量整理。\n- 类型可选文本或 HEX；▶ 直接发送。\n### 联动\n- 使用当前主连接和当前行尾设置。\n- 命令表的「▶」也走同一条发送路径。\n- Agent 可以读取/修改中控编排，但不会自动改这里的快捷命令。",
        en: "### Purpose\nSave frequently used commands and click a row to send it.\n### Usage\n- Edit adds, changes, removes and bulk-organizes rows.\n- Type can be text or HEX; ▶ sends immediately.\n### Relationships\n- Uses the current main link and line-ending setting.\n- Command table ▶ uses the same send path.\n- Agent can edit workflows, but does not silently change these saved commands."
      },
      {
        id: "help-transfer-session",
        title: "会话日志与回放",
        zh: "### 用途\n保存、加载和导出当前传输记录，或按时间轴回放。\n### 操作\n- 保存为 JSONL，加载后可恢复记录；导出 CSV 便于表格分析。\n- 回放可选择速度，暂停不会影响真实连接。\n### 联动\n- 会话日志是当前主连接的历史；Agent 的 port_read 只读取最近记录。\n- 大日志建议先导出，再用外部工具筛选。",
        en: "### Purpose\nSave, load, export and replay transfer history.\n### Usage\n- Save to JSONL and load it later; export CSV for spreadsheet analysis.\n- Replay speed is adjustable and does not affect the real link.\n### Relationships\n- Session history belongs to the main link; Agent port_read reads only the recent tail.\n- Export large logs and filter them externally."
      },
      {
        id: "help-cmds",
        title: "命令表",
        zh: "搜索 Linux 常用命令，点名称填入发送框或点 ▶ 直接执行。命令表是通用速查，不保证目标设备一定安装了对应程序；执行结果会出现在传输日志中。",
        en: "Search common Linux commands, insert one or send it with ▶. The table is a generic reference, not a guarantee that the target has the command installed."
      },
    ],
  },
  {
    title: "Agent",
    items: [
      {
        id: "help-agent-chat",
        title: "对话",
        zh: "### 用途\n用自然语言描述目标，Agent 会读取工作区、调用工具、执行验证并汇报。\n### 操作\n- 输入后 Enter 发送，Shift+Enter 换行。\n- 可在输入框下方切换权限：只读 / 需批准 / 自动。\n- 供应商声明多个思考档位后，底栏会出现「思考」下拉；选择按当前会话保存。\n- 模型下拉切换 profile；对话内补发消息会在当前回合的下一个边界并入。\n### 联动\n- 「上下文成分」「运行概览」展示成本、上下文来源和建议思考档位。\n- 修改设备、运行命令、写文件等动作受权限控制。",
        en: "### Purpose\nDescribe a goal; the Agent reads the workspace, calls tools, verifies work and reports.\n### Usage\n- Enter sends, Shift+Enter inserts a newline.\n- Switch permission below the composer: read-only / ask / auto.\n- When a provider declares several reasoning efforts, a Thinking selector appears and is stored per session.\n- The model selector switches profiles; extra messages are merged at the next turn boundary.\n### Relationships\n- Context breakdown and Runtime overview show cost, context sources and the selected effort.\n- Device changes, commands and file writes are permission-gated."
      },
      {
        id: "help-agent-workspace",
        title: "工作区与会话",
        zh: "### 用途\n工作区是 Agent 读写文件和保存技能/指导的根目录；会话保存对话与工具历史。\n### 操作\n- 点 Agent 行右侧的文件夹+新建工作区。\n- 工作区树可以切换当前目录；历史会话可以重命名或删除。\n### 联动\n- workspace_* 工具只能在工作区内按相对路径操作。\n- 工作区里的 AGENTS.md 会作为项目级指导注入。\n- 运行结构分析可以读取工作区里的 ELF/BIN。",
        en: "### Purpose\nA workspace is the Agent's file root for files, skills and guidance; sessions store conversation and tool history.\n### Usage\n- Use the folder+ button beside Agent to create a workspace.\n- Switch workspaces from the tree; rename or delete old sessions.\n### Relationships\n- workspace_* tools use relative paths inside the active workspace.\n- AGENTS.md in the workspace is injected as project guidance.\n- Runtime graph can analyze ELF/BIN files from the workspace."
      },
      {
        id: "help-agent-info",
        title: "Agent 信息",
        zh: "显示当前供应商/模型、上下文占用、累计费用、输出速度、缓存命中和工具调用概况。费用是估算值，取决于供应商配置的价格；缓存命中用于观察前缀复用效果。",
        en: "Shows provider/model, context usage, estimated cost, output speed, cache hits and tool activity. Cost depends on configured prices; cache hits indicate prefix reuse."
      },
      {
        id: "help-agent-context",
        title: "上下文成分",
        zh: "### 用途\n拆解系统提示、工具定义、技能、历史对话、工具结果和摘要各占多少 token。\n### 怎么判断\n- 工具定义很大时，在设置 → 工具关闭不用的分类。\n- 历史过长时，压缩会提炼摘要；原始记录仍可用 history_search 回查。\n### 联动\n- 工具开关按会话冻结，新会话才应用。\n- 技能正文按需读取；只有常驻技能会每轮进入提示。",
        en: "### Purpose\nBreak down context usage across system prompt, tool schemas, skills, history, tool results and summaries.\n### How to use it\n- If tool schemas dominate, disable unused tool categories in Settings → Tools.\n- Long history is compacted into a summary; history_search can still find original details.\n### Relationships\n- Tool switches are frozen per session and apply to new sessions.\n- Skill bodies are loaded on demand; only always-on skills enter every turn."
      },
      {
        id: "help-agent-skills",
        title: "技能",
        zh: "### 用途\n技能是可复用的工作流程说明（SKILL.md）。\n### 操作\n- 启用/停用决定技能是否出现在清单中。\n- 「常驻」会把正文注入每轮系统提示，适合人格、固定规范；流程型技能建议按需读取。\n- 工作区可以拥有独立技能副本和归档。\n### 联动\n- Agent 只有在用户点名时才能读取停用技能正文。\n- skill_list / skill_read 影响下一步工具调用和上下文。",
        en: "### Purpose\nSkills are reusable procedures stored as SKILL.md.\n### Usage\n- Enable/disable controls whether a skill appears in the list.\n- Always-on injects the body every turn; use it for stable identity or rules, not long procedures.\n- Workspaces can keep their own skill copies and archives.\n### Relationships\n- The Agent can read a disabled skill only when the user names it.\n- skill_list and skill_read shape later tool calls and context."
      },
      {
        id: "help-agent-mcp",
        title: "MCP 服务",
        zh: "### 用途\n把本地命令或远程 HTTP MCP 服务作为额外工具提供给 Agent。\n### 操作\n- 配置 id、命令/URL、参数和启用状态；先测试再使用。\n- 远程服务可配置请求头。\n### 联动\n- 启用后会出现在工具清单，名称通常为 mcp__<服务>__<工具>。\n- MCP 工具调用同样受权限和结果长度预算控制。",
        en: "### Purpose\nExpose local-command or remote HTTP MCP servers as extra Agent tools.\n### Usage\n- Set id, command/URL, arguments and enabled state; test before use.\n- Remote servers can define request headers.\n### Relationships\n- Enabled tools appear in the tool list, usually as mcp__<server>__<tool>.\n- MCP calls use the same permission and output-budget rules."
      },
      {
        id: "help-agent-links",
        title: "页面里的链接",
        zh: "列出内嵌浏览器当前页面的可读链接，方便继续打开或交给 Agent 读取。链接内容属于外部网页，只有在任务确实需要时才应继续访问。",
        en: "Lists readable links on the current embedded browser page so they can be opened or handed to the Agent. External page content is untrusted and should only be followed when the task requires it."
      },
      {
        id: "help-agent-tools",
        title: "工具、权限与审批",
        zh: "### 分类\n- 只读：扫描、查询、读取文件。\n- 需批准：写文件、运行命令、改设备、安装组件。\n- 自动：完全信任当前会话。\n### 联动\n- 设置 → 工具可分类全开/全关；基本工具不可关闭。\n- 审批弹窗会显示工具名和参数，拒绝后 Agent 会收到失败结果。\n- 工具结果过长时会落盘，避免占满上下文。\n### 注意\n- 「自动」只适合你信任当前任务和 Agent 行为时使用。",
        en: "### Categories\n- Read-only: scans, queries and file reads.\n- Needs approval: file writes, commands, device changes and installs.\n- Auto: fully trust the current session.\n### Relationships\n- Settings → Tools supports per-category enable/disable; core tools cannot be disabled.\n- Approval dialogs show tool name and arguments; rejection is returned to the Agent.\n- Oversized results spill to disk to protect context.\n### Note\n- Use Auto only when you trust the task and the Agent's actions."
      },
    ],
  },
  {
    title: "知识库",
    items: [
      {
        id: "help-kb-chat",
        title: "对话页面",
        zh: "内嵌知识库对话页面。地址和焦点设置来自「设置 → 知识库」；顶部「管理/全屏」用于切换管理页和对话页。加载的是外部 WebView，账号和数据由对应知识库服务管理。",
        en: "Embedded knowledge-base chat. Its URL and focus setting come from Settings → Knowledge base; Manage/Fullscreen switches between admin and chat pages. The external WebView and account are managed by that service."
      },
      {
        id: "help-kb-admin",
        title: "管理页面",
        zh: "知识库后台上传文档、切分、索引和测试检索。KDock 只负责嵌入页面，不读取或修改知识库内容；页面里的链接可以用 Agent 的 browser_* 工具继续读取。",
        en: "The knowledge-base admin page uploads documents, chunks, indexes and tests retrieval. KDock only embeds it and does not modify its data; Agent browser_* tools can continue reading page links."
      },
    ],
  },
  {
    title: "固件升级",
    items: [
      {
        id: "help-upgrade-start",
        title: "连接与目标",
        zh: "这里只处理 KDock 自有 OTA：串口走 cshell + YMODEM，网口走 SVC1 服务通道，文件必须是 .fw。它不是 STM32/ESP 出厂 ROM Bootloader；没有 KDock 服务固件时请去「烧录 → 厂商 ROM Bootloader」。",
        en: "This page only handles KDock OTA: serial uses cshell + YMODEM, network uses the SVC1 service channel, and the file must be .fw. It is not the STM32/ESP factory ROM bootloader; use Flash → Vendor ROM Bootloader when no KDock service firmware exists."
      },
      {
        id: "help-upgrade-firmware",
        title: "固件包与来源",
        zh: "### 本地包\n选择 .fw 文件，先解析包头、版本、目标板卡和 CRC。\n### 服务器\n填写版本清单地址，KDock 会排序并下载所选版本，再校验 CRC。\n### 联动\n- 串口升级使用设备端 YMODEM 协议。\n- 网口升级使用配置的固件服务端口和偏移写通道。\n- .bin/.hex/.elf 不在这里烧录，请用「烧录」页。",
        en: "### Local package\nChoose a .fw file and verify header, version, board name and CRC.\n### Server\nEnter the version manifest URL; KDock sorts versions, downloads the selection and verifies CRC.\n### Relationships\n- Serial upgrade uses the device's YMODEM protocol.\n- Network upgrade uses the configured service port and offset-write channel.\n- .bin/.hex/.elf belong to the Flash page."
      },
      {
        id: "help-upgrade-process",
        title: "升级过程与失败处理",
        zh: "升级会依次执行连接、握手、传输、校验、标记和复位。日志里的最后一步决定失败原因。中途停止可能让设备停留在引导模式；不要断电，重新连接后先查版本或重新刷完整包。",
        en: "Upgrade runs connect, handshake, transfer, verify, mark and reset. The last log step identifies failure. Stopping halfway may leave the device in bootloader mode; reconnect and verify or reflash the full package."
      },
    ],
  },
  {
    title: "烧录",
    items: [
      {
        id: "help-flash-tools",
        title: "烧录工具路径",
        zh: "自动检测不到时，手动指定 OpenOCD、J-Link Commander/Server、STM32CubeProgrammer、pyOCD 或厂商 CLI。路径会保存到本地偏好；环境配置里安装的工具也可能被自动发现。",
        en: "When auto-detection fails, choose OpenOCD, J-Link, STM32CubeProgrammer, pyOCD or a vendor CLI. Paths are saved locally; tools installed from Environment setup may be detected automatically."
      },
      {
        id: "help-flash-programmer",
        title: "烧录器与目标",
        zh: "调试探针：选择 OpenOCD / J-Link / pyOCD 等工具、适配器、接口、速度和目标芯片。厂商 ROM Bootloader：STM32 选 USB DFU 或 UART，ESP 选串口 ROM，并按芯片手册进入 BOOT 模式。参数必须与接线和目标芯片一致。",
        en: "Debug probe: choose OpenOCD / J-Link / pyOCD, adapter, interface, speed and target. Vendor ROM bootloader: use STM32 USB DFU or UART, or ESP serial ROM, and enter BOOT mode as documented by the vendor. Parameters must match the wiring and MCU."
      },
      {
        id: "help-flash-firmware",
        title: "固件与地址",
        zh: "### 格式\n- .hex / .elf：地址由文件本身携带。\n- .bin：必须填写正确的 Flash 地址。\n- ESP ROM 只接受 .bin，多镜像先用 esptool merge_bin 合并。\n- .fw：只用于「固件升级」页的 KDock OTA。\n### 联动\n- 命令预览会随调试探针/厂商 ROM 路径、固件格式和地址实时变化。",
        en: "### Formats\n- .hex / .elf carry their own addresses.\n- .bin needs the correct Flash address.\n- ESP ROM accepts .bin only; merge multiple images with esptool merge_bin first.\n- .fw belongs only to KDock OTA on the Firmware page.\n### Relationships\n- The command preview updates with probe/vendor-ROM mode, file format and address."
      },
      {
        id: "help-flash-preview",
        title: "命令预览与执行",
        zh: "预览显示最终会执行的烧录命令。擦除、烧录、校验、复位分别执行对应动作；生产或救砖前先用预览确认工具、目标、地址和文件一致。",
        en: "Preview shows the exact programmer command. Erase, program, verify and reset run separately; confirm tool, target, address and file before production or recovery."
      },
    ],
  },
  {
    title: "运行结构",
    items: [
      {
        id: "help-runtime-start",
        title: "分析器与输入",
        zh: "### 用途\n分析 ELF/PE/AXF/OUT/BIN 的函数、调用边、中断和 CFG。\n### RTOS\n可恢复 `xTaskCreate`、`xTaskCreateStatic`、`osThreadNew`、ThreadX / RT-Thread 等任务注册入口；注册边显示为虚线，入口节点标记 `TASK`。\n### 首次使用\n分析器随正式包分发；缺失时到「环境配置 → 固件运行结构分析器」准备。\n### 联动\n- 分析结果会缓存在后端，Agent 可用 runtime_graph_query 查询 calls/callers。\n- 全固件、运行链和单条链路使用同一份分析结果，不重复运行 angr。",
        en: "### Purpose\nAnalyze functions, call edges, interrupts and CFG in ELF/PE/AXF/OUT/BIN files.\n### RTOS\nTask registration through `xTaskCreate`, `xTaskCreateStatic`, `osThreadNew`, ThreadX and RT-Thread is recovered as a dashed edge; entry nodes are marked `TASK`.\n### First use\nThe analyzer ships with release builds; prepare it from Environment setup if missing.\n### Relationships\n- The result is cached in Rust and Agent runtime_graph_query can inspect calls/callers.\n- Full firmware, runtime chain and single-chain views reuse the same analysis."
      },
      {
        id: "help-runtime-elf",
        title: "生成可分析的 ELF",
        zh: "### Keil MDK\n- Options for Target → Output 勾选 Create Executable，并保留 Debug Information。\n- `Objects\\<target>.axf` 本身就是 ELF，可以直接选择；需要 `.elf` 文件名时执行 `fromelf --elf --output=Objects\\app.elf Objects\\app.axf`。\n### CMake\n- 构建链接器和 `.elf` 目标，不要只构建 `.bin`。\n- 保留 `-g` 调试符号；可用 `set_target_properties(app PROPERTIES SUFFIX \".elf\")` 固定输出名。\n### 注意\nELF 必须与当前烧录固件来自同一次构建。只有 `.bin` 时没有符号名，函数搜索、中断识别和调用链都会明显变差。",
        en: "### Keil MDK\n- In Options for Target → Output, enable Create Executable and keep Debug Information.\n- `Objects\\<target>.axf` is already an ELF and can be selected directly. To produce a `.elf` filename, run `fromelf --elf --output=Objects\\app.elf Objects\\app.axf`.\n### CMake\n- Build the linker/ELF target, not only `.bin`.\n- Keep `-g` debug symbols; use `set_target_properties(app PROPERTIES SUFFIX \".elf\")` to fix the output name.\n### Note\nThe ELF must come from the same build as the firmware being flashed. A `.bin` has no symbol names, so function search, interrupt detection and call chains are substantially worse."
      },
      {
        id: "help-runtime-mode",
        title: "全固件 / main / 链路",
        zh: "### 全固件函数\n列出 CFGFast 识别的全部函数。默认开启「入口骨架」：先显示 main、它的一级调用和其他组件入口，点节点上的 `+` 或双击逐层展开；全部展开会关闭骨架。\n### main 运行链\n从 main 展开，单独挂载中断 Handler；BIN 无符号时入口可能显示 _start。\n### 函数调用链路\n以选中函数为根，按向上/向下/双向和深度裁剪。\n### 联动\n- 切回全固件优先使用本地缓存，不重新分析。\n- 选中节点右侧可查看大小、块数、调用点和 CFG。",
        en: "### Full firmware\nLists every CFGFast-discovered function. Entry skeleton is enabled by default: main, its direct calls and other component entries are shown first; use + or double-click to expand level by level. Expand all turns the skeleton off.\n### main runtime\nExpands from main and mounts interrupt handlers separately; unsigned BIN may show _start.\n### Call chain\nCrops the graph around a selected function by direction and depth.\n### Relationships\n- Returning to Full firmware reuses local cache instead of re-analyzing.\n- Select a node to inspect size, blocks, call sites and CFG."
      },
      {
        id: "help-runtime-layout",
        title: "拓扑整理、搜索与高亮",
        zh: "### 拓扑整理\n先按调用深度分列；正常规模时同层固定同一列，超长层会在同一泳道内自动拆分子列，再按父节点重心排序减少交叉。\n### 完整展开\n`main 运行链`和“全固件函数”点“展开全部”后，也会切换到与函数调用链路相同的层级列、泳道标题、应用/库区分和自动适应布局。\n### 搜索\n顶部搜索框支持名称前缀、包含、地址和模糊子序列；方向键选择，Enter 定位。隐藏在被折叠祖先下的结果会自动展开路径。\n### 高亮\n选中函数后，橙色线表示上游调用者，绿色线表示下游调用；其余节点和连线淡化。点画布空白或按 Esc 清除选中和高亮。\n### 视图\n滚轮缩放、拖动画布/节点；「适应」缩放到全图，「整理」重新计算拓扑。",
        en: "### Topology\nFunctions are arranged by call depth. Normal-size levels use one column; oversized levels split into subcolumns inside the same lane. Parent barycenters reduce crossings.\n### Full expansion\nAfter Expand all, both the main runtime chain and Full firmware use the same depth columns, lane headers, application/library distinction and auto-fit layout as a focused call chain.\n### Search\nName prefix, substring, address and fuzzy subsequence matching; use arrow keys and Enter to jump. A path hidden by collapsed ancestors opens automatically.\n### Highlight\nOrange edges show upstream callers and green edges show downstream calls; unrelated elements dim. Click empty canvas space or press Esc to clear the selection and highlight.\n### View\nWheel to zoom, drag the canvas or nodes, Fit to see everything and Tidy to recompute topology."
      },
      {
        id: "help-runtime-chain",
        title: "拉一条链路与返回",
        zh: "### 操作\n普通点击选择一个函数；`Ctrl / Shift + 点击` 可多选。点「拉选中链路」后，选择向下调用、向上调用者或双向，以及 1/2/3/5/8 层或全部深度；默认 2 层，先看模块关系，需要内部细节再增加深度。\n### 分层整理\n所有根固定在 `L0`，下游依次为 `L+1 / L+2`，上游为 `L-1 / L-2`；正常规模时每层固定一列，超长层会在同一泳道内自动拆分子列。\n### 应用优先\n「应用逻辑」默认开启，链路中隐藏 HAL / CMSIS / C 库等系统函数；取消后可查看完整库调用。\n### 多根示例\n同时选择 `fsm_init` 和状态机本体，再选“向下 / 全部深度”，即可只保留两棵逻辑树并合并整理，其他函数不进入画布。",
        en: "### Usage\nClick to select one function; use `Ctrl / Shift + click` for multi-select. Draw selected chain, then choose downstream, upstream or both, and 1/2/3/5/8 levels or unlimited. The default is 2 levels; increase it when you need implementation detail.\n### Layered layout\nRoots stay at `L0`, downstream levels use `L+1 / L+2`, and upstream levels use `L-1 / L-2`. Each level normally occupies one column; very long levels split into subcolumns inside one lane.\n### Application first\nApplication logic is enabled by default and hides HAL / CMSIS / C-library functions in chains. Clear it to inspect the full library call surface.\n### Multi-root example\nSelect both `fsm_init` and the state-machine body, then choose Downstream / All depths to keep and arrange only their two logic trees."
      },
      {
        id: "help-runtime-bin",
        title: "BIN 参数与 ELF 差异",
        zh: "### BIN 必填\n- 加载基址：文件首字节对应的地址。\n- 架构：通常为 ARMCortexM。\n- 入口、向量表：可选但影响运行链和中断。\n### ELF 与 BIN\nBIN 没有符号表，函数数可能更少，入口常显示 _start，中断通常无法识别。优先分析同源 ELF。\n### 联动\n- 修改 BIN 基址/入口/向量表会清空前端缓存。\n- Agent runtime_graph_analyze 支持同一组 BIN 参数。",
        en: "### BIN requirements\n- Base address: address of the first byte.\n- Architecture: usually ARMCortexM.\n- Entry and vector base: optional but affect runtime/interrupt discovery.\n### ELF vs BIN\nBIN has no symbol table, may expose fewer functions, often starts at _start and usually has no interrupt names. Prefer the matching ELF.\n### Relationships\n- Changing BIN parameters clears the frontend cache.\n- Agent runtime_graph_analyze accepts the same BIN parameters."
      },
      {
        id: "help-runtime-libcfg",
        title: "分组折叠、筛选与 CFG",
        zh: "### 分组折叠\n- 「折叠库函数」勾选时立即收起 HAL/CMSIS/newlib 分支，取消后立即展开。\n- 自定义分组支持名称前缀/包含、正则、精确名称列表和地址范围；启用后默认折叠匹配分支。\n- 节点右上角 `+/-`、双击节点或右侧「收起/展开下游」都可单独控制。\n### 函数筛选\n可只看业务、库、中断或孤立函数；筛选不会改变分析结果。\n### CFG 与中断\n选中函数后可展开基本块；运行链模式可显示向量表识别的 Handler。",
        en: "### Group collapse\n- Ticking Library collapse immediately folds HAL/CMSIS/newlib branches; clearing it expands them.\n- Custom groups support prefix/contains, regex, exact-name lists and address ranges. Enabled groups collapse matching branches by default.\n- Use the node +/- control, double-click, or Collapse/Expand downstream in the detail card.\n### Function filter\nShow only business, library, interrupt or isolated functions without re-running analysis.\n### CFG and interrupts\nOpen basic blocks for the selected function; Runtime mode can show vector-table handlers."
      },
      {
        id: "help-runtime-agent",
        title: "让 Agent 看这张图",
        zh: "### 工具\n- runtime_graph_analyze：按路径和 scope 分析固件，结果缓存。\n- runtime_graph_query：按函数名/地址查 calls、callers、调用点和基本块。\n- ui_goto runtime：把界面切到本页。\n### 示例问题\n- 谁调用了 HAL_UART_Transmit？\n- 这个中断往下会用到哪些函数？\n- 从 main 到目标函数经过哪些层？",
        en: "### Tools\n- runtime_graph_analyze: analyze a firmware path and scope, then cache it.\n- runtime_graph_query: find calls, callers, call sites and block counts by name/address.\n- ui_goto runtime: show this page.\n### Example questions\n- Who calls HAL_UART_Transmit?\n- Which functions are reachable from this interrupt?\n- What path leads from main to the target function?"
      },
    ],
  },
  {
    title: "文件管理",
    items: [
      {
        id: "help-files-start",
        title: "连接方式",
        zh: "按设备支持的能力选择串口、TCP、FTP/FTPS 或 TFTP。串口/网口设备文件走设备服务；FTP/FTPS 和 TFTP 是标准文件协议。连接成功后目录区才会可用。",
        en: "Choose serial, TCP, FTP/FTPS or TFTP according to the target. Serial/network modes use the device file service; FTP/FTPS and TFTP are standard protocols. The directory area becomes usable after connecting."
      },
      {
        id: "help-files-dir",
        title: "目录",
        zh: "列出远端目录、进入上级、新建目录或删除选中项。路径使用设备侧路径格式；删除是不可逆操作，执行前确认选中项。",
        en: "List remote directories, go up, create folders or delete selected items. Paths use the target format; deletion is irreversible, so confirm the selection first."
      },
      {
        id: "help-files-pull",
        title: "取回本机",
        zh: "把选中的远端文件或目录下载到本机目录。完成后可核对大小和 CRC；目录传输可能按设备实现逐文件进行。",
        en: "Download the selected remote file or folder to the local directory. Verify size and CRC afterward; folder transfer may proceed file by file depending on the target."
      },
      {
        id: "help-files-push",
        title: "发到设备",
        zh: "选择本机文件并填写远端目标路径。上传完成后建议重新列目录并核对 CRC；同名文件可能被覆盖。",
        en: "Choose a local file and remote destination. After upload, list the directory and verify CRC; existing files may be overwritten."
      },
      {
        id: "help-files-tftp",
        title: "内置 TFTP 服务端",
        zh: "### 用途\n让局域网设备从本机取文件，或允许设备写入本机目录。\n### 联动\n- 服务端使用本机网卡和端口；防火墙可能要求放行。\n- 与你选择的 TFTP 客户端模式互不替代：一个是被设备访问，一个是访问设备。\n### 注意\nTFTP 无认证和加密，只适合可信局域网。",
        en: "### Purpose\nServe files to LAN devices or allow devices to write into a local folder.\n### Relationships\n- Uses a local NIC and port; Windows Firewall may need a rule.\n- Client TFTP mode accesses a device; this server is accessed by devices.\n### Note\nTFTP has no authentication or encryption; use it only on trusted LANs."
      },
    ],
  },
  {
    title: "安卓 ADB",
    items: [
      {
        id: "help-adb-device",
        title: "设备与连接状态",
        zh: "列出 USB 直连和已连接的无线调试设备。插线、授权或打开无线调试后点刷新；设备未授权时先在手机上确认 RSA 提示。",
        en: "Lists USB and connected wireless-debugging devices. Refresh after plugging in, authorizing or enabling wireless debugging; approve the RSA prompt on the phone if unauthorized."
      },
      {
        id: "help-adb-wireless",
        title: "无线调试与配对",
        zh: "### 步骤\n- 手机开启开发者选项和无线调试。\n- 用「使用配对码配对」的 IP、端口和 6 位码完成配对。\n- 再连接无线调试页面显示的另一个端口。\n### 联动\n配对端口与调试端口通常不同；配对成功不代表已连接。",
        en: "### Steps\n- Enable Developer options and Wireless debugging on the phone.\n- Pair with the IP, port and 6-digit code shown by Pair using pairing code.\n- Then connect to the separate debug port shown on the Wireless debugging page.\n### Relationship\nPairing and debugging use different ports; pairing alone does not connect the device."
      },
      {
        id: "help-adb-mirror",
        title: "投屏与反向控制",
        zh: "内置投屏适合快速查看和少量控制；需要更流畅的视频或更低延迟时使用 scrcpy。反向控制依赖 adb 输入注入，部分安全界面或厂商系统可能拒绝。",
        en: "Built-in mirroring is convenient for inspection and light control; use scrcpy for smoother video and lower latency. Reverse control depends on adb input injection and may be blocked by secure screens or vendor policies."
      },
      {
        id: "help-adb-transfer",
        title: "文件与截图",
        zh: "在电脑与设备之间执行 adb push/pull，或截图保存到本机。传大目录前确认设备剩余空间；失败时看 adb 返回的错误。",
        en: "Run adb push/pull between host and device, or save a screenshot. Check free space before large transfers and read the adb error on failure."
      },
      {
        id: "help-adb-apk",
        title: "APK 安装与卸载",
        zh: "选择 APK 后可普通安装、覆盖安装或卸载包名。覆盖安装需要签名兼容；系统应用卸载通常需要额外权限。操作会直接改变设备状态。",
        en: "Install an APK normally, overwrite it, or uninstall by package. Overwrite requires compatible signatures; system-app removal usually needs extra privileges. These actions change device state."
      },
      {
        id: "help-adb-commands",
        title: "常用命令",
        zh: "常用 adb shell 指令模板，点一下执行并回显输出。命令在设备上执行，可能改变文件或服务状态；Agent 的 adb_shell 同样需要权限。",
        en: "Common adb shell command templates; click to run and view output. They execute on the device and may change files or services; Agent adb_shell is permission-gated."
      },
    ],
  },
  {
    title: "环境配置",
    items: [
      {
        id: "help-env-first",
        title: "扫描与状态",
        zh: "### 用途\n扫描驱动、调试器、烧录器、工具链、抓包和便携分析器。\n### 状态\n- 已装：检测到命令行、注册表或驱动。\n- 已装 · 驱动未加载：软件在，但控制设备/服务还没上线。\n- 未安装：没有命中检测规则。\n### 联动\n- 进入页面读取缓存；外部安装/卸载后用「刷新同步」强制重扫。\n- 烧录、监听、逻辑分析仪、ADB 和运行结构都复用这里安装的组件。",
        en: "### Purpose\nScan drivers, debug probes, programmers, toolchains, capture tools and the portable analyzer.\n### States\n- Installed: CLI, registry or driver found.\n- Installed · driver not loaded: software exists but its device/service is not active.\n- Not installed: no detection rule matched.\n### Relationships\n- Page entry uses cache; use Refresh & sync after external install/uninstall.\n- Flashing, Monitor, Logic analyzer, ADB and Runtime graph reuse components installed here."
      },
      {
        id: "help-env-location",
        title: "安装位置",
        zh: "统一存放便携工具、工具链和 Git 仓库。留空使用默认目录；修改后后续扫描和安装都使用该目录。不要指向会被清理的临时目录。",
        en: "Shared location for portable tools, toolchains and Git repositories. Blank uses the default; scans and installs use the selected directory afterward. Avoid temporary folders."
      },
      {
        id: "help-env-progress",
        title: "安装进度与日志",
        zh: "进度条和日志分别显示下载、解包、提权、安装和重新扫描。失败时保留最后几行输出；驱动类安装后通常需要完整重启。",
        en: "Progress and log show download, extraction, elevation, installation and rescan. Keep the last lines on failure; driver installs often require a full restart."
      },
      {
        id: "help-env-install",
        title: "一键安装 / 检查 / 重装",
        zh: "### 行为\n- 未安装：下载或使用内置包执行安装。\n- 已安装：多数条目显示更新/重装；USBPcap 显示检查状态。\n- 需要 UAC 的驱动只弹出一次授权，不做静默绕过。\n### 联动\n- USBPcap 会先检测命令行、卸载项和控制设备，已安装时不会重复拉起安装器。\n- 安装完成后会强制重扫本页状态。",
        en: "### Behavior\n- Not installed: download or use a bundled package.\n- Installed: most items offer update/reinstall; USBPcap offers status check.\n- UAC is raised where needed; drivers are never silently bypassed.\n### Relationships\n- USBPcap checks CLI, uninstall entry and control devices before ever re-running its installer.\n- The page rescans after installation."
      },
      {
        id: "help-env-analyzer",
        title: "固件运行结构分析器",
        zh: "便携 Python + angr + pybingraph，仅由 KDock 使用，不需要系统 Python、uv 或 Graphviz。缺失时点「准备/更新分析器」，会下载约 500 MB 依赖；完成后「运行结构」页和 Agent 图工具都可用。",
        en: "Portable Python + angr + pybingraph used only by KDock; no system Python, uv or Graphviz needed. Prepare/update downloads about 500 MB of dependencies and enables Runtime graph plus Agent graph tools."
      },
    ],
  },
  {
    title: "监听",
    items: [
      {
        id: "help-usb-local",
        title: "本机 USB 抓包",
        zh: "### 用途\n通过 USBPcap 被动记录所选 USB 设备的 IN/OUT 传输。\n### 操作\n- 选择设备节点后开始；UAC 只用于启动抓包进程。\n- 控制传输适合看枚举、RNDIS 和厂商请求。\n- 关闭完整数据时每行截断，打开后显示完整载荷。\n### 联动\n- 抓包设备列表与右侧设备管理器相互对应。\n- 抓包不会占用传输页串口；停止后记录保留。\n- USBPcap 的安装/驱动状态在环境配置里检查。",
        en: "### Purpose\nPassively record IN/OUT transfers through USBPcap.\n### Usage\n- Select a device node and start; UAC launches the capture process.\n- Control transfers help inspect enumeration, RNDIS and vendor requests.\n- Full data controls payload truncation.\n### Relationships\n- Capture targets correspond to the device manager.\n- Capture does not take the Transfer serial port; records remain after stop.\n- USBPcap installation/driver state is checked in Environment setup."
      },
      {
        id: "help-usb-columns",
        title: "怎么看一行数据",
        zh: "### 列含义\n- 序号：当前来源内递增。\n- 时间：捕获时间。\n- EP / 方向：端点与 IN/OUT。\n- 状态：✓ 成功；✕ 悬停看错误码。\n- HEX/ASCII：原始载荷。\n- setup：控制传输的请求字段。\n### 排查顺序\n先看控制传输是否成功，再看端点方向和数据长度，最后检查载荷。",
        en: "### Columns\n- No.: increments within the current source.\n- Time: capture time.\n- EP / direction: endpoint and IN/OUT.\n- Status: ✓ success; hover ✕ for the error code.\n- HEX/ASCII: raw payload.\n- setup: control-request fields.\n### Troubleshooting order\nCheck control transfers, then endpoint/direction and length, then payload."
      },
      {
        id: "help-usb-manager",
        title: "设备管理器",
        zh: "右侧区分串口、Hub 端口树和所有 SetupAPI 设备。读取 Hub 端口/描述符可能需要管理员权限；点击设备或端口可高亮，并与抓包过滤目标对照。",
        en: "The right side separates serial ports, hub topology and all SetupAPI devices. Reading hub ports/descriptors may require elevation; selecting an item highlights it for comparison with the capture target."
      },
      {
        id: "help-usb-network",
        title: "网络抓包",
        zh: "使用 tshark 抓取所选网卡，显示时间、源、目的、协议、长度和信息。需要 tshark/Npcap；安装与环境操作在环境配置完成。与 USB 抓包共用自动滚动、清空和保存。",
        en: "Uses tshark on the selected interface and shows time, source, destination, protocol, length and info. Requires tshark/Npcap from Environment setup. Auto-scroll, Clear and Save are shared with USB capture."
      },
      {
        id: "help-usb-save",
        title: "清空与保存",
        zh: "清空只影响当前来源；保存把当前来源记录导出为文本。完整数据开启时导出完整 HEX/ASCII，关闭时按显示限制截断。",
        en: "Clear affects the active source only; Save exports its records as text. Full data controls whether exports contain complete HEX/ASCII or display-truncated rows."
      },
      {
        id: "help-usb-trouble",
        title: "抓不到数据怎么办",
        zh: "- 环境配置显示 USBPcap 已装但驱动未加载：使用完整重启，不要快速关机再开机。\n- 确认设备节点和 VID:PID/COM 对应。\n- 换端口或设备确认存在真实流量。\n- 查看 %TEMP% 下 kdock-usbpcap-*.err。\n- 根 Hub 可能被其它抓包软件占用。\n- 选「全部设备」会混入键盘、鼠标和 Hub 流量。",
        en: "- If USBPcap is installed but the driver is not loaded, use a full restart rather than fast shutdown/boot.\n- Confirm the node matches the device VID:PID/COM.\n- Try another port/device to confirm real traffic.\n- Check kdock-usbpcap-*.err under %TEMP%.\n- Another capture tool may hold the root hub.\n- All devices includes keyboard, mouse and hub traffic."
      },
    ],
  },
  {
    title: "实时图表",
    items: [
      {
        id: "help-chart-main",
        title: "图表",
        zh: "把收到的文本行解析成曲线。每行用逗号、空格或分号分隔数字；非数字行忽略。最多显示配置的通道数，适合观察传感器或 PID 数据。",
        en: "Plots numeric lines received as text. Separate numbers with comma, space or semicolon; non-numeric lines are ignored. Useful for sensors and PID data."
      },
      {
        id: "help-chart-channels",
        title: "通道与颜色",
        zh: "选择要显示的列、通道名称、颜色和是否隐藏。通道索引按每行数字顺序从 1 开始；增删通道只影响显示，不改原始日志。",
        en: "Choose columns, names, colors and visibility. Channel numbers follow the order of numbers in each line starting at 1; edits affect display only."
      },
      {
        id: "help-chart-link",
        title: "与传输/批量文本联动",
        zh: "图表读取主连接收到的数据，不单独打开串口。批量文本和 Agent 发到主连接的数据也会进入图表解析；图表本身不保存历史，需要保留时用会话日志。",
        en: "Charts consume data received on the main link and do not open their own serial port. Batch text and Agent writes to the main link also feed parsing; Charts do not persist history, so use session logs."
      },
    ],
  },
  {
    title: "中控编排",
    items: [
      {
        id: "help-seq-links",
        title: "中控连接与主连接",
        zh: "### 连接来源\n- 主连接：复用传输页当前连接，收包也出现在主日志。\n- 中控连接：为流程单独创建 TCP/UDP/串口连接。\n- 临时连接：节点执行时建立并关闭。\n### 联动\nAgent 的 flow_* 工具能读写当前画布；flow_run 会真实执行节点。",
        en: "### Link sources\n- Main: reuses Transfer's current link and mirrors packets into the main log.\n- Workflow link: creates an independent TCP/UDP/serial link for the flow.\n- Temporary link: opened for one node and closed afterward.\n### Relationships\nAgent flow_* tools can read/write the canvas; flow_run executes real nodes."
      },
      {
        id: "help-seq-node",
        title: "节点与选中参数",
        zh: "节点类型决定输入/输出端口和参数；选中节点后右栏编辑连接、内容、延时、等待条件和分支。连线只能从已有输出端口连到合法输入端口。",
        en: "Node type defines input/output ports and parameters. Select a node to edit its link, payload, delay, wait condition and branches. Edges connect existing outputs to valid inputs."
      },
      {
        id: "help-seq-branch",
        title: "连线、条件与反馈",
        zh: "条件节点根据响应或表达式选择出口；等待节点会占用流程直到超时或命中。反馈回路可能导致循环，务必设置超时/退出条件。连线端点吸附和选中态会同步高亮。",
        en: "Condition nodes choose an output from a response or expression; wait nodes block until timeout or match. Feedback loops can repeat, so always set timeouts/exits. Edge snapping and selection are highlighted."
      },
      {
        id: "help-seq-file",
        title: "导入、导出与清空",
        zh: "编排保存为 JSON，可导入/导出；清空只清当前画布。Agent 的 flow_get/flow_set 使用同一格式，可在画布与 Agent 之间迁移流程。",
        en: "Workflows are JSON and can be imported/exported; Clear removes the current canvas. Agent flow_get/flow_set use the same format, allowing workflows to move between UI and Agent."
      },
      {
        id: "help-seq-run",
        title: "运行、日志与停止",
        zh: "运行会真实执行本机命令和设备收发。日志显示节点开始/结束、响应和错误；停止会中断流程，但已经发出的数据不会撤回。",
        en: "Run performs real local commands and device I/O. The log shows node start/end, responses and errors. Stop interrupts the flow, but data already sent cannot be undone."
      },
    ],
  },
  {
    title: "示波器",
    items: [
      {
        id: "help-scope-connect",
        title: "连接与 SCPI",
        zh: "填写 RIGOL DS1000Z 系列示波器的 IP 和 SCPI TCP 端口（通常 5555）后连接。连接成功后可读状态、波形、测量和截屏。",
        en: "Enter the RIGOL DS1000Z-series IP and SCPI TCP port (usually 5555), then connect. Once connected, status, waveform, measurements and screenshots are available."
      },
      {
        id: "help-scope-status",
        title: "机器状态",
        zh: "显示型号、固件、通道和运行状态。状态读取失败通常说明网络、端口或 SCPI 会话不可用，而不是波形数据本身有问题。",
        en: "Shows model, firmware, channels and run state. A status failure usually means the network, port or SCPI session is unavailable."
      },
      {
        id: "help-scope-channels",
        title: "通道设置",
        zh: "开关通道并设置耦合、档位、偏移、探头倍数。档位和偏移决定波形是否被裁剪；探头倍数错误会让电压读数成倍偏差。",
        en: "Enable channels and set coupling, scale, offset and probe ratio. Scale/offset determine clipping; a wrong probe ratio multiplies voltage errors."
      },
      {
        id: "help-scope-measure",
        title: "自动测量",
        zh: "读取当前通道的幅值、频率、周期、占空比等测量值。测量基于示波器当前时基与触发状态，不是对整段历史数据重新计算。",
        en: "Reads amplitude, frequency, period, duty cycle and related values for the current channel. Measurements follow the scope's current timebase and trigger state."
      },
      {
        id: "help-scope-timebase",
        title: "时基、触发与波形",
        zh: "设置时间范围、触发源、电平、模式以及 RUN/STOP。波形读取会按当前时基和通道生成数据；中央舞台负责波形/截屏视图，右上角状态会同步连接结果。AUTO 设置可能改变通道档位和触发。",
        en: "Set timebase, trigger source, level, mode and RUN/STOP. Waveform reads use current timebase/channels. The central stage hosts wave/screenshot views and mirrors connection state; AUTO may change scale and trigger settings."
      },
      {
        id: "help-scope-scpi",
        title: "原始 SCPI",
        zh: "直接发送任意 SCPI 指令并查看响应。命令可能改变仪器状态；不确定时先查询 *IDN? 或具体状态查询命令。",
        en: "Send arbitrary SCPI commands and inspect responses. Commands may change instrument state; start with queries such as *IDN? when unsure."
      },
    ],
  },
  {
    title: "屏幕共享",
    items: [
      {
        id: "help-capture-source",
        title: "来源与连接",
        zh: "本机桌面、VNC、RTSP/RTMP 和 H.264 使用不同连接参数。VNC 可反向控制键鼠；流媒体来源通常只读。",
        en: "Local desktop, VNC, RTSP/RTMP and H.264 use different connection parameters. VNC can inject keyboard/mouse; stream sources are normally view-only."
      },
      {
        id: "help-capture-view",
        title: "画面与性能",
        zh: "帧率、画质、缩放和解码尺寸共同影响清晰度与资源占用。先降低帧率/尺寸定位性能问题，再逐步提高画质。",
        en: "Frame rate, quality, scale and decode size trade clarity for resource use. Lower frame rate/size first when diagnosing performance."
      },
      {
        id: "help-capture-control",
        title: "VNC 控制与截屏",
        zh: "VNC 反向控制会向被控端发送真实鼠标/键盘事件；安全界面可能屏蔽。截屏保存当前帧，不影响连接。快捷键可退出全屏或释放控制。",
        en: "VNC control sends real mouse/keyboard events to the remote host; secure screens may block it. Screenshot saves the current frame without disconnecting. Shortcuts exit fullscreen or release control."
      },
    ],
  },
  {
    title: "逻辑分析仪",
    items: [
      {
        id: "help-logic-source",
        title: "数据来源与采样",
        zh: "### 来源\n- 示例：内置总线场景。\n- VCD/CSV/原始二进制：导入已有采样。\n- 真机：通过 sigrok 支持的设备采集。\n### 联动\n- 真机采集需要环境配置中的 sigrok/sigrok-cli 和驱动。\n- 采样率、通道数和点数决定文件大小和内存占用。",
        en: "### Sources\n- Demo: built-in bus scenarios.\n- VCD/CSV/raw binary: import existing captures.\n- Hardware: capture through sigrok-supported devices.\n### Relationships\n- Hardware capture needs sigrok tools/drivers from Environment setup.\n- Rate, channel count and samples determine file size and memory use."
      },
      {
        id: "help-logic-decoder",
        title: "解码器与参数",
        zh: "为通道添加 UART、SPI、I2C、CAN 等协议解码器。参数必须和实际电平/位序/波特率一致；同一组采样可叠加多个解码器，结果按时间轴对齐。",
        en: "Add UART, SPI, I2C, CAN and other decoders to channels. Parameters must match actual levels, bit order and baud; multiple decoders can align on one capture."
      },
      {
        id: "help-logic-measure",
        title: "视图、测量与光标",
        zh: "频率、占空比和脉宽只统计当前视图窗口；光标 A/B 用于量时间差。缩放/平移会改变统计范围，不会改变原始采样。",
        en: "Frequency, duty cycle and pulse widths are calculated within the current view window; cursors A/B measure time differences. Zoom/pan changes the statistics window, not raw samples."
      },
      {
        id: "help-logic-export",
        title: "导入、导出与 Agent",
        zh: "可导入 VCD/CSV/二进制，导出 CSV/VCD。Agent 的 la_state/la_read 能读取当前采样和解码结果；la_capture 会真实采集或载入示例。",
        en: "Import VCD/CSV/binary and export CSV/VCD. Agent la_state/la_read inspect the current capture and decodes; la_capture performs a real capture or loads a demo."
      },
    ],
  },
  {
    title: "批量文本",
    items: [
      {
        id: "help-batch-main",
        title: "输入与处理",
        zh: "左侧输入、右侧查看结果，逐行处理多行文本：去重、排序、前后缀、编号、搜索替换、JSON/正则等。处理只改变当前编辑内容，不会自动写回设备；发送由底部队列单独控制。",
        en: "Input on the left and inspect results on the right. Process multiline text row by row: deduplicate, sort, prefix/suffix, number, search/replace, JSON, regex and more. Processing changes only the editor; the bottom queue controls sending."
      },
      {
        id: "help-batch-send",
        title: "逐行发送",
        zh: "设置间隔后把结果按行发到传输页主连接。发送会与其它 TX 共用日志；大批量发送前先缩小样本确认行尾和编码。",
        en: "Send processed rows to the Transfer main link at a configured interval. Sends share the TX log; test a small sample for line ending and encoding first."
      },
      {
        id: "help-batch-compare",
        title: "文本比对与转换",
        zh: "并排比对显示新增/删除行；转换可生成 HEX 数组、JSON、CSV 或 C 数组。转换结果可继续编辑、复制或发送。",
        en: "Side-by-side comparison highlights added/removed lines; conversion produces HEX arrays, JSON, CSV or C arrays. Results remain editable, copyable and sendable."
      },
    ],
  },
  {
    title: "计算器",
    items: [
      {
        id: "help-calc-history",
        title: "历史记录",
        zh: "保存表达式和结果，可标记、复用或清空。历史只留计算结果数据，不执行外部命令。",
        en: "Stores expressions and results for marking, reuse or clearing. History contains calculation data only and runs no external commands."
      },
      {
        id: "help-calc-bases",
        title: "各进制一览",
        zh: "同时显示当前值的十进制、十六进制、八进制和二进制。宽度和符号解释取决于当前位宽设置。",
        en: "Shows the current value in decimal, hex, octal and binary. Interpretation depends on the selected bit width and sign mode."
      },
      {
        id: "help-calc-input",
        title: "表达式与位宽",
        zh: "支持 C 风格运算符、括号、十六进制/二进制/八进制和幂。位宽影响取反、移位和溢出；显示过程可直接作为下一次输入。",
        en: "Supports C-style operators, parentheses, hex/binary/octal and powers. Bit width affects NOT, shifts and overflow; the expression row can be reused as input."
      },
      {
        id: "help-calc-bitboard",
        title: "32 位控制板",
        zh: "点击任意位可翻转并同步更新数值，适合寄存器位域调试。位宽增大时控制板会扩展；位操作与主表达式使用同一个当前值。",
        en: "Click any bit to toggle it and update the value, useful for register fields. The board grows with bit width and shares the current value with the expression."
      },
      {
        id: "help-calc-send",
        title: "与传输联动",
        zh: "计算结果可复制或发送到传输输入区；发送前确认文本/HEX 模式、位宽和行尾。计算器本身不占用串口。",
        en: "Copy a result or send it to the Transfer composer; confirm text/HEX mode, width and line ending first. Calculator does not open a serial port."
      },
    ],
  },
  {
    title: "数据计算",
    items: [
      {
        id: "help-datacalc-main",
        title: "本页总览",
        zh: "集中提供文件校验、浮点位域、进制/字节序、视频带宽、AES/RSA 等离线计算。所有计算在本机完成；输入内容不需要上传。",
        en: "Offline tools for file checksums, floating-point fields, bases/byte order, video bandwidth and AES/RSA. All calculations run locally."
      },
      {
        id: "help-datacalc-checksum",
        title: "文件校验与哈希",
        zh: "选择文件后可计算 CRC32、CRC16、MD5、SHA1、SHA256，并可限定字节范围。CRC 多项式/初值按页面所列标准执行；范围计算不会修改文件。",
        en: "Choose a file to calculate CRC32, CRC16, MD5, SHA1 or SHA256, optionally over a byte range. CRC parameters follow the displayed standard; the file is not modified."
      },
      {
        id: "help-datacalc-float",
        title: "浮点与字节序",
        zh: "在 IEEE754 浮点、整数和二进制位之间转换，支持大小端解释。字节序选错会出现“数值完全不对但位模式正确”，先确认设备端字节序。",
        en: "Convert between IEEE754 floats, integers and bits with endian selection. Wrong endianness produces a correct bit pattern but wrong numeric value."
      },
      {
        id: "help-datacalc-base",
        title: "进制、字节与视频带宽",
        zh: "进制换算和字节序适合协议字段；视频带宽计算根据分辨率、刷新率、色深、色度和 DSC 判断常见接口余量。结果用于估算，不替代硬件时序规范。",
        en: "Base/byte-order tools help decode protocol fields; video bandwidth estimates interface headroom from resolution, refresh, depth, chroma and DSC. It is an estimate, not a timing compliance test."
      },
      {
        id: "help-datacalc-crypto",
        title: "AES / RSA",
        zh: "仅做离线加解密、密钥/填充格式和摘要演示。密钥和明文留在本机；生产环境请使用经过审计的加密库和密钥管理。",
        en: "Offline encryption/decryption, key/padding and digest demonstrations. Keys and plaintext stay local; production systems should use audited crypto libraries and key management."
      },
    ],
  },
  {
    title: "调试",
    items: [
      {
        id: "help-debug-gdb",
        title: "GDB",
        zh: "连接 GDB/MI 会话，查看控制台、变量、线程和调用栈并发送命令。载入 ELF 后断点和源码信息才完整；与固件升级/烧录共享目标芯片，但不会自动同步操作。",
        en: "Connect a GDB/MI session to inspect console, variables, threads and stacks and send commands. ELF loading provides symbols and breakpoints; it shares the target with upgrade/flash but does not automate them."
      },
      {
        id: "help-debug-server",
        title: "GDB Server",
        zh: "启动 OpenOCD、J-Link GDB Server 或 pyOCD，为 GDB 提供调试端口。工具路径和探针来自环境配置；启动失败先看 Server 日志和端口占用。",
        en: "Start OpenOCD, J-Link GDB Server or pyOCD for GDB. Tool paths/probes come from Environment setup; check server logs and port conflicts on failure."
      },
      {
        id: "help-debug-firmware",
        title: "固件与运行控制",
        zh: "载入 ELF 后可以继续、暂停、单步、复位和查看断点。复位策略取决于调试探针；操作会真实改变目标运行状态。",
        en: "Load an ELF to continue, pause, step, reset and inspect breakpoints. Reset behavior depends on the probe; these actions change real target state."
      },
    ],
  },
  {
    title: "设置",
    items: [
      {
        id: "help-settings-general",
        title: "常规",
        zh: "语言、关闭到托盘、开机自启、自动重连等应用行为。修改立即写入本地偏好；自启依赖系统插件权限。",
        en: "Language, close-to-tray, autostart and reconnect behavior. Changes persist locally; autostart depends on the system plugin."
      },
      {
        id: "help-settings-theme",
        title: "主题与配色",
        zh: "选择亮/暗主题、主色、界面缩放和字体。UI 字体作用于菜单、对话、表单、占位符、状态和信息面板；代码块、日志、地址与文本编辑器保留等宽字体。配色变量会同步到图表、画布、日志和帮助页面；极端缩放后建议检查一次窄窗布局。",
        en: "Choose light/dark mode, accent, UI scale and font. The UI font applies to menus, chat, forms, placeholders, status and information panels; code, logs, addresses and text editors keep a monospace font. Theme variables apply to charts, canvases, logs and help; verify compact layouts after extreme scaling."
      },
      {
        id: "help-settings-model",
        title: "模型与供应商",
        zh: "管理 OpenAI 兼容/Anthropic 供应商、API Key、模型、温度、可选思考强度和价格。一个 profile 可以声明多个思考档位并设默认值；Agent 底栏会列出这些档位，选择按会话保存。\n### 思考强度测试\n「测试真实思考强度」会对每个勾选档位真实发一次小请求，记录接口可见的 reasoning、首字延迟、出字耗时和 token。隐藏 CoT 的接口显示 0 字只表示未暴露，不代表没有思考。",
        en: "Manage OpenAI-compatible/Anthropic providers, API keys, models, temperature, available reasoning efforts and prices. One profile can declare several efforts plus a default; the Agent composer lists them and stores the choice per session.\n### Reasoning test\nTest real reasoning efforts sends one small real request per selected effort and records exposed reasoning, first-token latency, generation time and tokens. A hidden-CoT API showing 0 chars means only that reasoning text was not exposed."
      },
      {
        id: "help-settings-skills",
        title: "技能管理",
        zh: "启用、停用、导入、编辑、常驻或归档技能。技能是全局/工作区共享的正文资料；停用后不会出现在清单，但明确点名仍可由 Agent 读取。",
        en: "Enable, disable, import, edit, pin or archive skills. Disabled skills leave the list but can still be read when explicitly named."
      },
      {
        id: "help-settings-tools",
        title: "工具开关",
        zh: "### 分类\n通信、工作区、设备固件、安卓、仪器分析、屏幕、编排、技能环境、界面上下文。\n### 操作\n- 每组可全开/全关，也可以逐项切换。\n- 22 个基本工具不可关闭。\n### 联动\n开关对新会话生效；会话冻结工具 schema 以复用上下文缓存。",
        en: "### Categories\nCommunication, workspace, devices/firmware, Android, analysis, screen, workflow, skills/environment and UI/context.\n### Usage\n- Enable/disable a whole category or individual tools.\n- 22 core tools cannot be disabled.\n### Relationships\nSwitches apply to new sessions; tool schemas are frozen per session for cache reuse."
      },
      {
        id: "help-settings-mcp",
        title: "MCP 管理",
        zh: "添加本地命令或远程 HTTP MCP 服务，配置参数、请求头、启停并测试。MCP 工具会进入 Agent 工具清单，调用同样受审批和输出预算控制。",
        en: "Add local-command or remote HTTP MCP servers, configure arguments/headers, enable/disable and test. MCP tools join the Agent catalog and use the same approvals/output budget."
      },
      {
        id: "help-settings-kb",
        title: "知识库 URL",
        zh: "分别配置对话页和管理页地址；它们是内嵌 WebView，不是 KDock 自己保存的文档。地址变更后返回知识库页面重新加载。",
        en: "Configure chat and admin URLs separately. These are embedded WebViews, not documents stored by KDock. Return to Knowledge base to reload after changes."
      },
      {
        id: "help-settings-netip",
        title: "网络与公网归属",
        zh: "控制公网 IP 归属探测的预算、代理、防抖和重试。界面只显示国家/地区，不保存公网 IP；网络变化事件触发探测。",
        en: "Controls public-IP location budget, proxy, debounce and retries. The UI shows country/region only and does not persist the IP; network events trigger probes."
      },
      {
        id: "help-settings-cache",
        title: "持久化数据与清理",
        zh: "列出偏好、密钥、会话、技能、MCP、工作区等本地数据的路径和大小，可分类删除。删除会重启应用；标记 ⚠ 的类别会丢数据，请先备份。",
        en: "Lists local preferences, keys, sessions, skills, MCP, workspaces and other data with paths and sizes. Deletion restarts the app; ⚠ categories lose data, so back up first."
      },
      {
        id: "help-settings-help",
        title: "帮助入口",
        zh: "这里列出所有页面的帮助条目。F1 默认打开当前页面的入口；卡片上的 ? 会直达对应单元。",
        en: "Lists help for every page. F1 opens the current page's root entry; ? on a card jumps to that unit."
      },
    ],
  },
];

export const HELP_TITLE_EN = {
  "Work with KDock": "Work with KDock",
  "快捷键与通用操作": "Shortcuts and common actions",
  "页面之间怎么联动": "How pages work together",
  "连接与参数": "Connection and parameters",
  "收发区与显示": "Traffic and display",
  "统计": "Statistics",
  "快捷发送": "Quick send",
  "会话日志与回放": "Session log and replay",
  "命令表": "Command table",
  "对话": "Chat",
  "工作区与会话": "Workspaces and sessions",
  "Agent 信息": "Agent info",
  "上下文成分": "Context breakdown",
  "技能": "Skills",
  "MCP 服务": "MCP servers",
  "页面里的链接": "Links on the page",
  "工具、权限与审批": "Tools, permissions and approvals",
  "对话页面": "Chat page",
  "管理页面": "Admin page",
  "连接与目标": "Connection and target",
  "固件包与来源": "Firmware package and source",
  "升级过程与失败处理": "Upgrade process and failures",
  "烧录工具路径": "Programmer paths",
  "烧录器与目标": "Programmer and target",
  "固件与地址": "Firmware and addresses",
  "命令预览与执行": "Command preview and execution",
  "分析器与输入": "Analyzer and input",
  "生成可分析的 ELF": "Produce an analyzable ELF",
  "全固件 / main / 链路": "Full firmware / main / chain",
  "拓扑整理、搜索与高亮": "Topology, search and highlighting",
  "拉一条链路与返回": "Draw a chain and return",
  "BIN 参数与 ELF 差异": "BIN parameters and ELF differences",
  "分组折叠、筛选与 CFG": "Group collapse, filters and CFG",
  "让 Agent 看这张图": "Let the Agent inspect this graph",
  "连接方式": "Connection mode",
  "目录": "Directories",
  "取回本机": "Pull to PC",
  "发到设备": "Send to device",
  "内置 TFTP 服务端": "Built-in TFTP server",
  "设备与连接状态": "Devices and connection state",
  "无线调试与配对": "Wireless debugging and pairing",
  "投屏与反向控制": "Mirroring and reverse control",
  "文件与截图": "Files and screenshots",
  "APK 安装与卸载": "APK install and uninstall",
  "常用命令": "Common commands",
  "扫描与状态": "Scan and status",
  "安装位置": "Install location",
  "安装进度与日志": "Install progress and log",
  "一键安装 / 检查 / 重装": "Install / check / reinstall",
  "固件运行结构分析器": "Firmware runtime analyzer",
  "本机 USB 抓包": "Local USB capture",
  "怎么看一行数据": "Reading a capture row",
  "设备管理器": "Device manager",
  "网络抓包": "Network capture",
  "清空与保存": "Clear and save",
  "抓不到数据怎么办": "No capture data",
  "图表": "Chart",
  "通道与颜色": "Channels and colors",
  "与传输/批量文本联动": "Transfer and Batch text integration",
  "中控连接与主连接": "Workflow and main links",
  "节点与选中参数": "Nodes and selected parameters",
  "连线、条件与反馈": "Edges, conditions and feedback",
  "导入、导出与清空": "Import, export and clear",
  "运行、日志与停止": "Run, log and stop",
  "连接与 SCPI": "Connection and SCPI",
  "机器状态": "Instrument state",
  "通道设置": "Channel settings",
  "自动测量": "Automatic measurements",
  "时基、触发与波形": "Timebase, trigger and waveform",
  "原始 SCPI": "Raw SCPI",
  "来源与连接": "Source and connection",
  "画面与性能": "Video and performance",
  "VNC 控制与截屏": "VNC control and screenshots",
  "数据来源与采样": "Sources and sampling",
  "解码器与参数": "Decoders and parameters",
  "视图、测量与光标": "View, measurements and cursors",
  "导入、导出与 Agent": "Import, export and Agent",
  "输入与处理": "Input and processing",
  "逐行发送": "Send line by line",
  "文本比对与转换": "Text comparison and conversion",
  "历史记录": "History",
  "各进制一览": "Base views",
  "表达式与位宽": "Expressions and bit width",
  "32 位控制板": "32-bit control board",
  "与传输联动": "Transfer integration",
  "本页总览": "Page overview",
  "文件校验与哈希": "File checksums and hashes",
  "浮点与字节序": "Floating point and byte order",
  "进制、字节与视频带宽": "Bases, bytes and video bandwidth",
  "AES / RSA": "AES / RSA",
  "GDB": "GDB",
  "GDB Server": "GDB Server",
  "固件与运行控制": "Firmware and execution control",
  "常规": "General",
  "主题与配色": "Theme and accent",
  "模型与供应商": "Models and providers",
  "技能管理": "Skill management",
  "工具开关": "Tool switches",
  "MCP 管理": "MCP management",
  "知识库 URL": "Knowledge-base URLs",
  "网络与公网归属": "Network and public-IP location",
  "持久化数据与清理": "Persistent data and cleanup",
  "帮助入口": "Help access",
};
