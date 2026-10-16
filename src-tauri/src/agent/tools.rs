//! Agent 能用的**工具**。
//!
//! 两类：
//! - **native**：直接调 KDock 自己那套 Rust 能力（链路、设备文件、OTA、烧录、示波器、工作区、技能）。
//!   agent 用**自己的一条连接**（不抢传输页那条主连接），所以你手动敲命令时它也能自己连一条。
//! - **host**：JS 那边实现的能力（中控编排、切页面、屏幕捕获…），走 `agent://host_call` 事件往返。

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::Emitter;

use crate::transport::Conn;
use crate::upgrade;

use super::store;

pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: Value,
    pub host: bool,
}

/// agent 自己那条链路的当前状态
#[derive(Default)]
pub struct Link {
    pub conn: Option<Conn>,
    pub mode: String,
    pub label: String,
}

/// 工具清单（同时也是给模型看的 schema）
pub fn catalog() -> Vec<ToolDef> {
    let mut t: Vec<ToolDef> = Vec::new();
    let mut push = |name: &'static str, description: &'static str, schema: Value, host: bool| {
        t.push(ToolDef { name, description, schema, host });
    };

    push("link_open", "打开一条 agent 自己的链路（串口/网口）。会先关掉上一条。",
        json!({"type":"object","properties":{
            "mode":{"type":"string","enum":["serial","tcp","udp"],"description":"链路类型"},
            "port":{"type":"string","description":"串口名，如 COM7"},
            "baud":{"type":"integer","description":"波特率，默认 115200"},
            "host":{"type":"string","description":"TCP/UDP 目标 IP"},
            "remote_port":{"type":"integer","description":"TCP/UDP 目标端口"},
            "local_port":{"type":"integer","description":"UDP 本地端口"}
        },"required":["mode"]}), false);
    push("link_close", "关掉 agent 的链路。", json!({"type":"object","properties":{}}), false);
    push("link_status", "看 agent 链路现在通不通。", json!({"type":"object","properties":{}}), false);
    push("link_send", "往链路发数据（文本或 HEX）。",
        json!({"type":"object","properties":{
            "data":{"type":"string","description":"要发的内容"},
            "hex":{"type":"boolean","description":"true 表示 data 是十六进制，如 '41 54'"},
            "line_ending":{"type":"string","enum":["none","cr","lf","crlf"],"description":"行尾，默认 cr"}
        },"required":["data"]}), false);
    push("link_read", "读链路返回（等到静默超时或命中 until）。",
        json!({"type":"object","properties":{
            "timeout_ms":{"type":"integer","description":"最多等多久，默认 3000"},
            "idle_ms":{"type":"integer","description":"静默多久算读完，默认 400"},
            "until":{"type":"string","description":"命中这个子串就立刻返回"},
            "max_bytes":{"type":"integer","description":"最多读多少字节，默认 65536"}
        }}), false);
    // ── 用户那条主连接（传输页里开的那条）：agent 也能用，而且用户全程看得见 ──
    push("port_list", "列出本机串口（含友好名 / VID:PID）。要看有哪些口就用这个，别去跑 PowerShell 扫。",
        json!({"type":"object","properties":{}}), false);
    push("port_state", "看**用户在传输页开的那条主连接**的状态：类型 / 参数 / 是否连着 / 收发字节数。",
        json!({"type":"object","properties":{}}), false);
    push("port_write", "往**主连接**（用户在传输页开的那条）发数据，文本或 HEX。发出去的内容会实时显示在用户的传输页里（TX 行），所以这是「用户看得见」的通道。",
        json!({"type":"object","properties":{
            "data":{"type":"string","description":"要发的内容"},
            "hex":{"type":"boolean","description":"true 表示 data 是十六进制，如 '41 54'"},
            "line_ending":{"type":"string","enum":["none","cr","lf","crlf"],"description":"行尾，默认 cr"}
        },"required":["data"]}), false);
    push("port_read", "读**主连接**最近的收发记录（用户在传输页看到的就是这一份）：每行给方向 + 毫秒时间戳 + 内容。",
        json!({"type":"object","properties":{"tail":{"type":"integer","description":"取最近多少条，默认 40，最多 400"}}}), false);
    push("port_open", "打开**主连接**（用户在传输页那条）：串口 / TCP 客户端 / TCP 服务端 / UDP。连上之后界面里的方式和参数会同步过去，用户看得见。已经连着时要先 port_close。",
        json!({"type":"object","properties":{
            "mode":{"type":"string","enum":["serial","tcp_client","tcp_server","udp"],"description":"连接类型"},
            "port":{"type":"string","description":"串口名（mode=serial），如 COM7；先用 port_list 看有哪些"},
            "baud":{"type":"integer","description":"波特率（serial），默认 115200"},
            "data_bits":{"type":"string","enum":["five","six","seven","eight"],"description":"数据位，默认 eight（8）"},
            "stop_bits":{"type":"string","enum":["one","two"],"description":"停止位，默认 one（1）"},
            "parity":{"type":"string","enum":["none","odd","even"],"description":"校验位，默认 none"},
            "flow_control":{"type":"string","enum":["none","hardware","software"],"description":"流控，默认 none"},
            "host":{"type":"string","description":"tcp_client=远端 IP；tcp_server=本机监听地址（不填 0.0.0.0，表示所有网卡）"},
            "remote_port":{"type":"integer","description":"tcp_client 的远端端口 / udp 的远端端口"},
            "local_port":{"type":"integer","description":"tcp_server 要监听的端口 / udp 的本地端口"},
            "remote_host":{"type":"string","description":"udp 的远端 IP"}
        },"required":["mode"]}), false);
    push("port_close", "断开**主连接**（用户在传输页那条）。", json!({"type":"object","properties":{}}), false);
    push("net_local_ips", "列本机 IPv4 地址：开 TCP 服务端 / UDP 时该填哪个本机地址、该让用户连哪个地址，用这个看（0.0.0.0 表示所有网卡）。",
        json!({"type":"object","properties":{}}), false);
    push("device_list", "列设备上的目录（串口走 cshell ls，网口走 6666 服务通道）。",
        json!({"type":"object","properties":{"path":{"type":"string","description":"设备上的路径，默认 /"}}}), false);
    push("device_pull", "把设备上的文件取回本机（带 CRC32 校验）。",
        json!({"type":"object","properties":{
            "path":{"type":"string","description":"设备上的文件路径"},
            "save_to":{"type":"string","description":"本机保存路径；不填就存到工作区里"}
        },"required":["path"]}), false);
    push("device_push", "把本机文件发到设备。",
        json!({"type":"object","properties":{
            "local":{"type":"string","description":"本机文件路径"},
            "remote":{"type":"string","description":"设备上的目标路径，默认同名放根目录"}
        },"required":["local"]}), false);
    push("firmware_info", "读一个 .fw 升级包的版本/大小/CRC32。",
        json!({"type":"object","properties":{"local":{"type":"string"}},"required":["local"]}), false);
    push("firmware_upgrade", "把 .fw 包升级进设备（串口或网口）。**会复位设备**，做完最好再确认一次版本。",
        json!({"type":"object","properties":{
            "local":{"type":"string","description":"本机 .fw 路径"},
            "transport":{"type":"string","enum":["auto","serial","net"],"description":"默认跟着当前链路走"},
            "host":{"type":"string","description":"走网口时的设备 IP"},
            "remote_port":{"type":"integer","description":"网口服务端口，默认 6666"}
        },"required":["local"]}), false);
    push("local_run", "在本机跑一条命令（cmd /C），返回退出码和输出。",
        json!({"type":"object","properties":{
            "cmd":{"type":"string"},
            "timeout_ms":{"type":"integer","description":"默认 15000"}
        },"required":["cmd"]}), false);
    push("flash", "用烧录器写片（J-Link / openocd / STM32CubeProgrammer）。",
        json!({"type":"object","properties":{
            "tool":{"type":"string","enum":["jlink","openocd","stm32"]},
            "file":{"type":"string","description":"要烧的 .hex/.bin/.elf"},
            "exe":{"type":"string","description":"工具可执行文件路径，不填就按 PATH 找"},
            "device":{"type":"string","description":"芯片型号，如 STM32F407VG"},
            "addr":{"type":"string","description":"bin 的烧写地址，如 0x08000000"}
        },"required":["tool","file"]}), false);
    push("scope", "给示波器发一条裸 SCPI 命令（RIGOL），返回设备回包。要连通就用 scope_connect。",
        json!({"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}), false);
    push("scope_connect", "连示波器（RIGOL DS1000Z 系，SCPI over TCP）。连上会回 *IDN?（型号+序列号+固件）。",
        json!({"type":"object","properties":{
            "ip":{"type":"string","description":"示波器 IP；不填就试上次用的那个"},
            "port":{"type":"integer","description":"默认 5555"}
        }}), false);
    push("scope_info", "读示波器当前状态：型号、各通道开关/档位/偏移/耦合/探头、时基、采样率、触发源与电平。",
        json!({"type":"object","properties":{}}), false);
    push("scope_measure", "自动测量某个通道：峰峰值/频率/周期/有效值/平均值/最大最小/上升下降时间/占空比。测不到（没接信号）的项回 null。",
        json!({"type":"object","properties":{
            "channel":{"type":"integer","description":"通道号 1~4"},
            "items":{"type":"array","items":{"type":"string"},
                "description":"要测哪几项，默认 [VPP,FREQ,VMAX,VMIN]；可选 VPP,VMAX,VMIN,VAVG,VRMS,VTOP,VBASE,FREQ,PER,RTIM,FTIM,PDUT,NDUT"}
        }}), false);
    push("scope_waveform", "读波形：回一份摘要（点数/跨度/最大最小/峰峰/平均/按上升穿越估的频率）+ 一张字符画波形图。要看原始采样点就别用这个，用 workspace 写文件那套。",
        json!({"type":"object","properties":{
            "channel":{"type":"integer","description":"通道号，默认 1"},
            "points":{"type":"integer","description":"点数：屏幕最多 1200，RAW 最多 120000"},
            "mode":{"type":"string","description":"NORM（默认，屏幕数据快）/ RAW（深存储，慢）"},
            "ascii_plot":{"type":"boolean","description":"true 就只回一张字符画（几十行文本，适合快速瞄一眼）"}
        }}), false);
    push("scope_screenshot", "截示波器屏幕，存成 PNG 并回存到哪了（同时回一张可给用户看的图）。",
        json!({"type":"object","properties":{
            "path":{"type":"string","description":"存哪；不填就存到 agent 工作区"}
        }}), false);
    push("scope_control", "改示波器设置：通道档位/偏移/开关/耦合/探头、时基、触发源与电平、触发方式、RUN/STOP、自动设置。",
        json!({"type":"object","properties":{
            "channel":{"type":"integer","description":"要改的通道 1~4"},
            "display":{"type":"boolean","description":"这个通道开不开"},
            "scale":{"type":"number","description":"电压档位 V/div，如 0.5"},
            "offset":{"type":"number","description":"垂直偏移 V"},
            "probe":{"type":"number","description":"探头衰减倍数，如 10"},
            "coupling":{"type":"string","description":"AC / DC / GND"},
            "timebase":{"type":"number","description":"时基 s/div，如 2e-4"},
            "timebase_offset":{"type":"number","description":"水平偏移 s"},
            "trigger_source":{"type":"string","description":"CHAN1~CHAN4"},
            "trigger_level":{"type":"number","description":"触发电平 V"},
            "trigger_sweep":{"type":"string","description":"AUTO / NORMAL / SINGLE"},
            "run":{"type":"boolean","description":"true=RUN，false=STOP"},
            "autoset":{"type":"boolean","description":"true = 让示波器自己找档位（:AUT）"}
        }}), false);
    push("workspace_list", "列 agent 工作区里的文件。",
        json!({"type":"object","properties":{"path":{"type":"string","description":"相对路径，默认 ."}}}), false);
    push("workspace_read", "读工作区里的文本文件。",
        json!({"type":"object","properties":{
            "path":{"type":"string"},
            "max_bytes":{"type":"integer","description":"默认 65536"}
        },"required":["path"]}), false);
    push("workspace_write", "写工作区里的文件（会自动建目录）。",
        json!({"type":"object","properties":{
            "path":{"type":"string"},
            "content":{"type":"string"},
            "append":{"type":"boolean","description":"true 表示追加"}
        },"required":["path","content"]}), false);
    push("workspace_mkdir", "在工作区里建目录。",
        json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}), false);
    push("skill_list", "列出已安装的技能（名字 + 描述；标了「常驻」的技能每轮都注入全文）。",
        json!({"type":"object","properties":{}}), false);
    push("skill_read", "读一个技能的完整 SKILL.md。任务或问题匹配某个技能的描述时就该先读它 —— 包括身份、口吻、自我介绍、闲聊这类问题，不是只有硬件操作才读技能。",
        json!({"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}), false);
    push("skill_create", "新建一个技能（一份带 frontmatter 的 SKILL.md）。",
        json!({"type":"object","properties":{
            "name":{"type":"string","description":"技能名，会做 slug 化"},
            "description":{"type":"string","description":"一句话说明什么时候用它"},
            "body":{"type":"string","description":"正文（Markdown）"}
        },"required":["name","description"]}), false);
    push("skill_update", "整体覆盖一个技能的 SKILL.md。",
        json!({"type":"object","properties":{"name":{"type":"string"},"content":{"type":"string"}},"required":["name","content"]}), false);
    push("skill_delete", "删掉一个技能。",
        json!({"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}), false);

    // ── host：JS 那边实现 ───────────────────────────────────────────
    push("browser_open", "用内置浏览器打开一个网页（抓下来抽正文，页面同时会显示在右侧「浏览器」里）。",
        json!({"type":"object","properties":{
            "url":{"type":"string","description":"网址，可以不带 https://"}
        },"required":["url"]}), false);
    push("browser_read", "读「当前页」的正文（browser_open 之后用；不传 url 就是当前页）。",
        json!({"type":"object","properties":{
            "url":{"type":"string","description":"可选，先抓这个再读"},
            "max_chars":{"type":"integer","description":"最多返回多少字，默认 12000"}
        }}), false);
    push("browser_find", "在「当前页」正文里找一段文字，返回前后文。",
        json!({"type":"object","properties":{
            "text":{"type":"string"},
            "max_hits":{"type":"integer","description":"默认 5"}
        },"required":["text"]}), false);
    push("history_search", "在**本会话的原始记录**里按关键词回查（包括已经被摘要压缩掉的那段）。上下文被压缩后，想找回细节就用它。",
        json!({"type":"object","properties":{
            "text":{"type":"string","description":"要找的关键词"},
            "max_hits":{"type":"integer","description":"最多返回几条，默认 8"}
        },"required":["text"]}), false);
    push("ui_show_text", "把一段文本显示到右侧「文本」页（给用户看 / 自己回头看）。",
        json!({"type":"object","properties":{
            "title":{"type":"string"},
            "text":{"type":"string"}
        },"required":["text"]}), true);
    push("ui_goto", "把界面切到某个页（transfer/upgrade/flash/files/chart/flow/capture/scope）。",
        json!({"type":"object","properties":{"page":{"type":"string"}},"required":["page"]}), true);
    push("flow_run", "跑中控编排（不传 graph 就跑当前画布上的）。",
        json!({"type":"object","properties":{
            "graph":{"type":"object","description":"可选，直接给编排 JSON"},
            "wait":{"type":"boolean","description":"等它跑完再返回，默认 true"}
        }}), true);
    push("la_state", "读逻辑分析仪的**当前状态**：数据来源、采样率、通道数/点数/时长、视图窗口、光标 A/B 与 Δt、通道列表（含当前电平）、已加的解码器、选中通道的测量（频率/占空比/脉冲/脉宽）。只读，不改任何东西。",
        json!({"type":"object","properties":{}}), true);
    push("la_read", "读逻辑分析仪**解码出来的结果**（只读）：每个解码器的全部项（UART：字节 + 起止时间 + 停止位是否合法；SPI：字节 + 起止时间），以及每一路在当前视图窗口里的频率/占空比/脉冲数。",
        json!({"type":"object","properties":{
            "tail":{"type":"integer","description":"每个解码器只返回最后 N 项，默认 200，最多 2000"}
        }}), true);
    push("la_config", "改逻辑分析仪的**配置**（不动采集到的数据）：设采样率、加/删/改解码器（uart/spi + 通道 + 波特率）、显示/隐藏通道、选中某一路、移动视图窗口、放/清光标。改完界面立刻生效。",
        json!({"type":"object","properties":{
            "sampleRate":{"type":"number"},
            "decoders":{"type":"array","description":"整份替换。uart: {kind,ch,baud}；spi: {kind,cs,clk,mosi}",
                "items":{"type":"object","properties":{"kind":{"type":"string","enum":["uart","spi"]},"ch":{"type":"integer"},"baud":{"type":"integer"},"cs":{"type":"integer"},"clk":{"type":"integer"},"mosi":{"type":"integer"}},"required":["kind"]}},
            "channels":{"type":"array","description":"通道显隐","items":{"type":"object","properties":{"i":{"type":"integer"},"on":{"type":"boolean"}}}},
            "select":{"type":"integer","description":"选中哪一路（测量就是它）"},
            "view":{"type":"object","description":"单位秒","properties":{"t0":{"type":"number"},"span":{"type":"number"}}},
            "cursors":{"type":"object","description":"单位秒；a/b 给 null 表示清掉","properties":{"a":{"type":"number"},"b":{"type":"number"}}}
        }}), true);
    push("la_capture", "**开始一次采集**。现在支持 source=demo（内置示例信号：UART 115200 / 1kHz PWM / SPI 读 JEDEC ID）；source=device 会给明确报错（真机驱动还没接）。",
        json!({"type":"object","properties":{
            "source":{"type":"string","enum":["demo","device"],"description":"默认 demo"}
        }}), true);
    push("la_save", "把当前逻辑分析仪的数据**存成文件**（要 path）。format=csv（time + 各通道）或 vcd（PulseView / DSView / GTKWave 能打开）；超过 20 万点只存前 20 万。",
        json!({"type":"object","properties":{
            "path":{"type":"string"},
            "format":{"type":"string","enum":["csv","vcd"]}
        },"required":["path"]}), true);
    push("flow_get", "读**当前画布上的编排**：节点（含各自参数与坐标）+ 连线（from/port/to）+ 可用的节点类型清单（每种类型有哪些输入/输出端口）。想看懂/复述用户画的流程、或者要自己排一条，先调它拿格式。",
        json!({"type":"object","properties":{}}), true);
    push("flow_add_node", "在**现有画布上新增一个节点**（不动别人已画的东西）。type 取自 flow_get 的 kinds；x/y 不给就自动摆在最右边节点的右侧；params 里的字段会并到该节点上（比如 label）。返回新节点的 id。",
        json!({"type":"object","properties":{
            "type":{"type":"string","description":"节点类型，如 start / step / cond …（先 flow_get 看 kinds）"},
            "x":{"type":"integer","description":"可选，画布坐标"},
            "y":{"type":"integer","description":"可选，画布坐标"},
            "params":{"type":"object","description":"可选，要并到节点上的字段（label 等）"}
        },"required":["type"]}), true);
    push("flow_connect", "在**现有画布上连一条线**：from.port → to。端口名取自 flow_get 的 kinds[type].outs；自环、重复线、端口不存在都会被拦下。",
        json!({"type":"object","properties":{
            "from":{"type":"string","description":"起点节点 id"},
            "port":{"type":"string","description":"起点节点的输出端口名"},
            "to":{"type":"string","description":"终点节点 id"}
        },"required":["from","port","to"]}), true);
    push("flow_delete", "从画布上删掉一个节点或一条连线（id 传节点 id 或连线 key 都行；开始节点不能删）。",
        json!({"type":"object","properties":{
            "id":{"type":"string","description":"节点 id 或连线 key"}
        },"required":["id"]}), true);
    push("flow_set", "把一份编排**整体导入画布**（**会替换掉当前画布上原有的东西**并保存，用户在界面上直接能看到/编辑/运行）。格式：{nodes:[{id,type,x,y,...该类型的参数}],edges:[{from:'节点id',port:'输出端口名',to:'节点id'}]}；不认识的类型和悬空连线会被自动丢掉并在返回值里说明。会动用户的画布，所以要先说清楚你要导入什么。",
        json!({"type":"object","properties":{
            "graph":{"type":"object","description":"{nodes:[…],edges:[…]}"}
        },"required":["graph"]}), true);
    push("flow_status", "看中控编排跑到哪了／日志尾巴。", json!({"type":"object","properties":{}}), true);
    push("flow_stop", "停掉正在跑的中控编排。", json!({"type":"object","properties":{}}), true);
    push("capture_save", "抓一张屏幕（存到工作区）。",
        json!({"type":"object","properties":{
            "monitor":{"type":"integer","description":"显示器序号，默认 0"},
            "save_as":{"type":"string","description":"相对工作区的文件名，默认 shot.png"}
        }}), true);

    t
}

/// 给模型的 tools 数组（OpenAI function 格式）
pub fn schema_json(defs: &[ToolDef], allow_host: bool) -> Vec<Value> {
    defs.iter()
        .filter(|d| !d.host || allow_host)
        .map(|d| {
            json!({"type":"function","function":{
                "name": d.name, "description": d.description, "parameters": d.schema}})
        })
        .collect()
}

pub fn is_known(name: &str) -> bool { catalog().iter().any(|d| d.name == name) }
pub fn is_host(name: &str) -> bool { catalog().iter().any(|d| d.name == name && d.host) }

/// 工具执行的环境
pub struct ToolCtx<'a> {
    pub app: &'a tauri::AppHandle,
    pub state: &'a super::AgentState,
    pub workspace: std::path::PathBuf,
    /// 当前会话 id（history_search 要用来翻原始记录）
    pub session: &'a str,
    /// 权限：read / ask / auto
    pub perm: &'a str,
    /// perm=ask 时问用户（返回 true 才执行）
    pub approve: &'a dyn Fn(&str, &Value) -> Result<bool, String>,
    /// host 工具：发事件给前端并等结果
    pub host: &'a dyn Fn(&str, &Value, u64) -> Result<String, String>,
    /// 进度日志
    pub log: &'a dyn Fn(&str),
}

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string()).filter(|s| !s.trim().is_empty())
}
fn arg_u64(args: &Value, key: &str, default: u64) -> u64 {
    args.get(key).and_then(|v| v.as_u64()).unwrap_or(default)
}
fn arg_bool(args: &Value, key: &str, default: bool) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

// ── 示波器：把 JSON 抹成人话（agent 看的是文本，不是 JSON）────────────

/// 数字怎么显示：小数位按量级给，别搞出 0.30000000000000004
fn fmt_num(v: f64, unit: &str) -> String {
    let a = v.abs();
    let s = if a == 0.0 {
        "0".to_string()
    } else if a >= 1e6 {
        format!("{:.3}e6", v / 1e6)
    } else if a >= 1000.0 {
        format!("{v:.2}")
    } else if a >= 1.0 {
        format!("{v:.4}")
    } else if a >= 1e-3 {
        format!("{:.4}", v)
    } else if a >= 1e-6 {
        format!("{:.4}m", v * 1e3) // mV / ms 这类小量纲一律转成"毫"
    } else {
        format!("{v:.4e}")
    };
    if unit.is_empty() {
        s
    } else {
        format!("{s} {unit}")
    }
}

/// 时间类读数按 µs / ms / s 挑一个顺眼的单位
fn fmt_time(v: f64) -> String {
    let a = v.abs();
    if a >= 1.0 {
        format!("{v:.4} s")
    } else if a >= 1e-3 {
        format!("{:.4} ms", v * 1e3)
    } else {
        format!("{:.4} µs", v * 1e6)
    }
}

fn meas_text(item: &str, v: Option<f64>) -> (String, String) {
    let name = match item {
        "VPP" => "峰峰值",
        "VMAX" => "最大值",
        "VMIN" => "最小值",
        "VAVG" => "平均值",
        "VRMS" => "有效值",
        "VTOP" => "顶电平",
        "VBASE" => "底电平",
        "FREQ" => "频率",
        "PER" => "周期",
        "RIS" => "上升时间",
        "FALL" => "下降时间",
        "PDUT" => "正占空比",
        "NDUT" => "负占空比",
        other => other,
    };
    let text = match v {
        None => "测不到（这一路大概没接信号）".to_string(),
        Some(x) => match item {
            "FREQ" => {
                if x.abs() >= 1000.0 {
                    format!("{:.4} kHz", x / 1e3)
                } else {
                    format!("{x:.4} Hz")
                }
            }
            "PER" | "RIS" | "FALL" => fmt_time(x),
            "PDUT" | "NDUT" => format!("{x:.2} %"),
            _ => fmt_num(x, "V"),
        },
    };
    (name.to_string(), text)
}

fn scope_measure_text(v: &Value) -> String {
    let ch = v.get("channel").and_then(|x| x.as_u64()).unwrap_or(0);
    let mut s = format!("CH{ch} 自动测量：\n");
    if let Some(items) = v.get("items").and_then(|x| x.as_object()) {
        for (k, val) in items {
            let (name, text) = meas_text(k, val.as_f64());
            s.push_str(&format!("- {name}({k})：{text}\n"));
        }
    }
    s
}

fn scope_info_text() -> Result<String, String> {
    let v = crate::scope::info()?;
    let mut s = String::new();
    s.push_str(&format!(
        "{}（{}）\n",
        v.get("idn").and_then(|x| x.as_str()).unwrap_or("?"),
        v.get("model").and_then(|x| x.as_str()).unwrap_or("?")
    ));
    if let Some(chs) = v.get("channels").and_then(|x| x.as_array()) {
        for c in chs {
            let n = c.get("n").and_then(|x| x.as_u64()).unwrap_or(0);
            if !c.get("display").and_then(|x| x.as_bool()).unwrap_or(false) {
                s.push_str(&format!("CH{n}：关闭\n"));
                continue;
            }
            s.push_str(&format!(
                "CH{n}：开 · {} V/div · 偏移 {} · {} · 探头 {}x\n",
                c.get("scale").and_then(|x| x.as_f64()).map(|x| fmt_num(x, "V")).unwrap_or_else(|| "?".into()),
                c.get("offset").and_then(|x| x.as_f64()).map(|x| format!("{x:.3} V")).unwrap_or_else(|| "?".into()),
                c.get("coupling").and_then(|x| x.as_str()).unwrap_or("?"),
                c.get("probe").and_then(|x| x.as_f64()).map(|x| format!("{x:.0}")).unwrap_or_else(|| "?".into()),
            ));
        }
    }
    let tb = v.get("timebase").and_then(|x| x.as_f64());
    let sr = v.get("sample_rate").and_then(|x| x.as_f64());
    s.push_str(&format!(
        "时基：{}\n采样率：{}\n",
        tb.map(fmt_time).unwrap_or_else(|| "?".into()),
        sr.map(|x| format!("{} Sa/s", fmt_num(x, ""))).unwrap_or_else(|| "?".into()),
    ));
    if let Some(md) = v.get("memory_depth").and_then(|x| x.as_str()) {
        if !md.trim().is_empty() {
            s.push_str(&format!("存储深度：{}\n", md.trim()));
        }
    }
    let t = &v["trigger"];
    s.push_str(&format!(
        "触发：源 {} · 电平 {} · 方式 {} · 状态 {}",
        t.get("source").and_then(|x| x.as_str()).unwrap_or("?"),
        t.get("level").and_then(|x| x.as_f64()).map(|x| format!("{x:.3} V")).unwrap_or_else(|| "?".into()),
        t.get("sweep").and_then(|x| x.as_str()).unwrap_or("?"),
        t.get("status").and_then(|x| x.as_str()).unwrap_or("?"),
    ));
    Ok(s)
}

/// 字符画波形：60 列 × 12 行（每列取这一段的最小/最大值）
fn ascii_plot(y: &[f64], cols: usize, rows: usize) -> String {
    if y.is_empty() {
        return "（没有数据）".into();
    }
    let (mut lo, mut hi) = (f64::MAX, f64::MIN);
    for v in y {
        if *v < lo {
            lo = *v;
        }
        if *v > hi {
            hi = *v;
        }
    }
    if (hi - lo).abs() < 1e-12 {
        hi = lo + 1e-3;
    }
    let mut grid = vec![vec![' '; cols]; rows];
    for c in 0..cols {
        let a = c * y.len() / cols;
        let b = (((c + 1) * y.len() / cols).max(a + 1)).min(y.len());
        let seg = &y[a..b];
        let smin = seg.iter().copied().fold(f64::MAX, f64::min);
        let smax = seg.iter().copied().fold(f64::MIN, f64::max);
        let row_of = |v: f64| -> usize {
            let t = ((v - lo) / (hi - lo)).clamp(0.0, 1.0);
            ((1.0 - t) * (rows - 1) as f64).round() as usize
        };
        let (r1, r2) = (row_of(smax), row_of(smin));
        for r in r1..=r2 {
            grid[r][c] = if r1 == r2 { '-' } else if r == r1 { '\'' } else if r == r2 { '.' } else { '|' };
        }
    }
    let mut out = String::new();
    for (i, row) in grid.iter().enumerate() {
        let v = hi - (hi - lo) * i as f64 / (rows - 1) as f64;
        out.push_str(&format!("{v:>8.3} |{}|\n", row.iter().collect::<String>()));
    }
    out.push_str(&format!("{:>8} +{}+\n", "", "-".repeat(cols)));
    out
}

fn scope_wave_text(args: &Value) -> Result<String, String> {
    let ch = arg_u64(args, "channel", 1) as u8;
    let points = arg_u64(args, "points", 1200) as usize;
    let mode = arg_str(args, "mode").unwrap_or_else(|| "NORM".into());
    let v = crate::scope::wave(ch, points, &mode)?;
    let y: Vec<f64> = v
        .get("y")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_f64()).collect())
        .unwrap_or_default();
    let acquired = v.get("acquired").and_then(|x| x.as_u64()).unwrap_or(0);
    let stride = v.get("stride").and_then(|x| x.as_u64()).unwrap_or(1);
    let xinc = v.get("xinc").and_then(|x| x.as_f64()).unwrap_or(0.0);
    if y.is_empty() {
        return Err("读到 0 个点".into());
    }
    let (mut lo, mut hi, mut sum) = (f64::MAX, f64::MIN, 0.0);
    for s in &y {
        lo = lo.min(*s);
        hi = hi.max(*s);
        sum += *s;
    }
    let avg = sum / y.len() as f64;
    // 估算频率：以均值为界数上升穿越
    let mut cross = 0usize;
    let mut above = y[0] > avg;
    for s in y.iter().skip(1) {
        let now = *s > avg;
        if now && !above {
            cross += 1;
        }
        above = now;
    }
    let span = xinc * (acquired.max(1) as f64);
    let mut out = format!(
        "CH{ch} 波形：{} 点（mode={}），跨度约 {}，{}/点\n最大 {:+.4} V · 最小 {:+.4} V · 峰峰 {:.4} V · 平均 {:+.4} V\n",
        acquired,
        v.get("mode").and_then(|x| x.as_str()).unwrap_or("NORM"),
        fmt_time(span),
        fmt_time(xinc),
        hi,
        lo,
        hi - lo,
        avg
    );
    if stride > 1 {
        out.push_str(&format!("（返回时抽稀成 {} 点，每 {} 点取 1）\n", y.len(), stride));
    }
    if cross >= 2 && span > 0.0 {
        let f_est = cross as f64 / span;
        // 一个周期至少要有 8 个采样点，否则这个"数穿越"的估计就是在数噪声
        let per_period = if f_est > 0.0 && xinc > 0.0 { (1.0 / f_est) / xinc } else { 0.0 };
        if per_period >= 8.0 {
            out.push_str(&format!(
                "按上升穿越估的频率：约 {:.4} Hz（{} 个周期）\n",
                f_est, cross
            ));
        } else {
            out.push_str("（这路信号相对采样率太快，数穿越估频率不可靠 —— 要准数就用 scope_measure）\n");
        }
    }
    if arg_bool(args, "ascii_plot", true) {
        out.push_str("\n");
        out.push_str(&ascii_plot(&y, 60, 12));
    }
    Ok(out)
}

fn line_ending(kind: &str) -> &'static [u8] {
    match kind {
        "none" => b"",
        "lf" => b"\n",
        "crlf" => b"\r\n",
        _ => b"\r",
    }
}

fn set_timeout(conn: &mut Conn, ms: u64) {
    if let Conn::Serial(p) = conn {
        let _ = p.set_timeout(Duration::from_millis(ms));
    }
}

/// 二进制就用 HEX 呈现，免得模型把乱码当成内容
fn text_and_hex(data: &[u8]) -> String {
    let printable = data.iter().filter(|b| **b == b'\n' || **b == b'\r' || (32..127).contains(*b)).count();
    if printable * 100 / data.len().max(1) >= 90 {
        String::from_utf8_lossy(data).to_string()
    } else {
        format!("(二进制 {} 字节)\nHEX: {}", data.len(), kdock_core::hex::bytes_to_hex(data))
    }
}

/// 借用 agent 的链路跑一段（用完还回去）
fn with_conn<T>(ctx: &ToolCtx, f: impl FnOnce(&mut Conn) -> Result<T, String>) -> Result<T, String> {
    let mut g = ctx.state.link.lock().map_err(|_| "link mutex".to_string())?;
    let mut conn = g.conn.take().ok_or("还没有链路，先 link_open")?;
    set_timeout(&mut conn, 6000);
    let r = f(&mut conn);
    g.conn = Some(conn);
    r
}

/// 网口那几个操作要 `Svc` 按值拿走 Conn，所以单独一个壳：拿出来 -> 包 Svc -> 用完再还
fn with_svc<T>(ctx: &ToolCtx, f: impl FnOnce(&mut upgrade::Svc) -> Result<T, String>) -> Result<T, String> {
    let mut g = ctx.state.link.lock().map_err(|_| "link mutex".to_string())?;
    let conn = g.conn.take().ok_or("还没有链路，先 link_open")?;
    let mut svc = upgrade::Svc::from_conn(conn);
    let r = f(&mut svc);
    let back = svc.into_conn();
    g.conn = Some(back);
    r
}

/// 当前是不是串口链路
fn is_serial(ctx: &ToolCtx) -> bool {
    ctx.state.link.lock().map(|g| g.mode == "serial").unwrap_or(false)
}

/// 会改设备/改盘上东西的工具：权限管的就是这些
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_tools_are_registered_and_gated() {
        let names: Vec<&str> = catalog().iter().map(|d| d.name).collect();
        for n in ["port_list", "port_state", "port_write", "port_read", "port_open", "port_close", "net_local_ips"] {
            assert!(names.contains(&n), "缺工具 {n}");
        }
        // 三个只读的不该要审批，写入的要
        assert!(!is_dangerous("port_list"));
        assert!(!is_dangerous("port_state"));
        assert!(!is_dangerous("port_read"));
        assert!(!is_dangerous("net_local_ips"));
        assert!(is_dangerous("port_write"));
        assert!(is_dangerous("port_open") && is_dangerous("port_close"));
        // 都是 Rust 侧实现（host=false）；标成 host 会走 agent://host_call 那条路，前端没有对应实现
        assert!(!is_host("port_write") && !is_host("port_read") && !is_host("port_list"));
        // port_open 的参数要覆盖：连接类型 / 串口 + 串口参数 / 本机地址 / 本机端口 / 远端地址 / 远端端口
        let po = catalog().into_iter().find(|d| d.name == "port_open").unwrap();
        let props = po.schema["properties"].as_object().unwrap();
        for k in [
            "mode", "port", "baud", "data_bits", "stop_bits", "parity", "flow_control",
            "host", "local_port", "remote_host", "remote_port",
        ] {
            assert!(props.contains_key(k), "port_open 缺参数 {k}");
        }
        assert!(po.schema["required"].as_array().unwrap().iter().any(|v| v == "mode"));
    }
}

pub fn is_dangerous(name: &str) -> bool {
    matches!(
        name,
        "link_send" | "device_push" | "firmware_upgrade" | "flash" | "local_run" | "port_write" | "flow_set" | "flow_add_node" | "flow_connect" | "flow_delete"
            | "port_open" | "port_close"
            | "workspace_write" | "workspace_mkdir" | "skill_create" | "skill_update"
            | "skill_delete" | "flow_run" | "capture_save"
            | "la_config" | "la_capture" | "la_save"
    )
}

pub fn execute(ctx: &ToolCtx, name: &str, args: &Value) -> Result<String, String> {
    // 权限闸门：只读直接拒；需要批准就先问人
    if is_dangerous(name) || name.starts_with("mcp__") {
        match ctx.perm {
            "read" => {
                return Err(format!(
                    "当前权限是「只读」，{name} 不执行。要用的话，在输入框下面那行把权限切成「需要批准」或「自动」。"
                ))
            }
            "ask" => {
                if !(ctx.approve)(name, args)? {
                    return Err(format!("用户拒绝了 {name}（可以问问他为什么，或者换个做法）"));
                }
            }
            _ => {}
        }
    }
    if is_host(name) {
        return (ctx.host)(name, args, 120_000);
    }
    match name {
        "port_list" => {
            let ports = crate::list_ports()?;
            if ports.is_empty() {
                return Ok("（本机没有可用串口）".into());
            }
            Ok(ports
                .iter()
                .map(|p| {
                    let mut s = format!(
                        "{}  {}{}",
                        p.port_name,
                        p.port_type,
                        p.friendly.as_ref().map(|f| format!("  {f}")).unwrap_or_default()
                    );
                    if let (Some(v), Some(d)) = (p.vid, p.pid) {
                        s.push_str(&format!("  (VID:PID {v:04X}:{d:04X})"));
                    }
                    s
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "port_state" => {
            let st = crate::stats_of(ctx.app)?;
            let mut s = String::new();
            s.push_str(&format!(
                "主连接：{}\n",
                if st.connected {
                    "已连接"
                } else if st.listening {
                    "监听中（等客户端接入）"
                } else {
                    "未连接"
                }
            ));
            if let (Some(m), Some(l)) = (&st.mode, &st.label) {
                s.push_str(&format!("类型 / 参数：{m} {l}\n"));
            }
            s.push_str(&format!(
                "收发：TX {} 字节 / RX {} 字节（共 {} 行记录）\n",
                st.tx_bytes, st.rx_bytes, st.log_lines
            ));
            if st.elapsed_ms > 0 {
                s.push_str(&format!("已持续：{:.1} 秒\n", st.elapsed_ms as f64 / 1000.0));
            }
            Ok(s)
        }
        "port_write" => {
            let data = arg_str(args, "data").ok_or("缺少 data")?;
            let is_hex = args.get("hex").and_then(|v| v.as_bool()).unwrap_or(false);
            let le = arg_str(args, "line_ending").unwrap_or_else(|| "cr".to_string());
            let ack = crate::write_main(ctx.app, &data, if is_hex { "hex" } else { "text" }, &le, false)?;
            // 让用户在传输页里实时看到 agent 发出去的东西（补一条 TX 行）
            let _ = ctx.app.emit(
                "log://tx",
                json!({ "ts_ms": kdock_core::session::now_ms(),
                        "hex": ack.hex, "text": ack.text, "ascii": ack.ascii }),
            );
            Ok(format!("已发 {} 字节到主连接：{}", ack.bytes, ack.hex))
        }
        "port_read" => {
            let tail = args.get("tail").and_then(|v| v.as_u64()).unwrap_or(40).clamp(1, 400) as usize;
            Ok(crate::main_log_text(ctx.app, tail))
        }
        "port_open" => {
            let mode = arg_str(args, "mode").ok_or("缺少 mode")?;
            let mut ep = json!({ "mode": mode });
            let sarg = |k: &str| arg_str(args, k);
            let uarg = |k: &str| args.get(k).and_then(|v| v.as_u64());
            match mode.as_str() {
                "serial" => {
                    ep["port"] = json!(sarg("port").ok_or("mode=serial 需要 port（先用 port_list 看有哪些）")?);
                    ep["config"] = json!({
                        "baud": uarg("baud").unwrap_or(115_200),
                        "data_bits": sarg("data_bits").unwrap_or_else(|| "eight".into()),
                        "stop_bits": sarg("stop_bits").unwrap_or_else(|| "one".into()),
                        "parity": sarg("parity").unwrap_or_else(|| "none".into()),
                        "flow_control": sarg("flow_control").unwrap_or_else(|| "none".into()),
                    });
                }
                "tcp_client" => {
                    ep["host"] = json!(sarg("host").ok_or("mode=tcp_client 需要 host（远端 IP）")?);
                    ep["port"] = json!(uarg("remote_port").ok_or("mode=tcp_client 需要 remote_port")?);
                }
                "tcp_server" => {
                    ep["host"] = json!(sarg("host").unwrap_or_else(|| "0.0.0.0".into()));
                    ep["port"] = json!(uarg("local_port").ok_or("mode=tcp_server 需要 local_port（要监听的端口）")?);
                }
                "udp" => {
                    ep["local_port"] = json!(uarg("local_port").unwrap_or(0));
                    ep["remote_host"] = json!(sarg("remote_host").unwrap_or_default());
                    ep["remote_port"] = json!(uarg("remote_port").unwrap_or(0));
                }
                other => return Err(format!("不认识的 mode: {other}（serial / tcp_client / tcp_server / udp）")),
            }
            let endpoint: crate::transport::Endpoint =
                serde_json::from_value(ep).map_err(|e| format!("参数不对: {e}"))?;
            crate::open_main(ctx.app, endpoint, "agent")
        }
        "port_close" => crate::close_main(ctx.app),
        "net_local_ips" => {
            let ips = crate::local_ips();
            if ips.is_empty() {
                return Ok("（没查到本机 IPv4；开服务端可以填 0.0.0.0 = 所有网卡）".into());
            }
            Ok(format!("{}\n（0.0.0.0 = 所有网卡）", ips.join("\n")))
        }
        "link_open" => link_open(ctx, args),
        "link_close" => {
            let mut g = ctx.state.link.lock().map_err(|_| "link mutex".to_string())?;
            let had = g.conn.take();
            g.mode.clear();
            g.label.clear();
            if let Some(mut c) = had {
                c.shutdown();
            }
            Ok("链路已关闭".into())
        }
        "link_status" => {
            let g = ctx.state.link.lock().map_err(|_| "link mutex".to_string())?;
            Ok(if g.conn.is_some() { format!("已连接（{}）", g.label) } else { "未连接（先 link_open）".into() })
        }
        "link_send" => link_send(ctx, args),
        "link_read" => link_read(ctx, args),
        "device_list" => device_list(ctx, args),
        "device_pull" => device_pull(ctx, args),
        "device_push" => device_push(ctx, args),
        "firmware_info" => firmware_info(args),
        "firmware_upgrade" => firmware_upgrade(ctx, args),
        "local_run" => local_run(args),
        "flash" => flash(ctx, args),
        "scope" => crate::scope::raw(&arg_str(args, "cmd").ok_or("缺少 cmd")?),
        "scope_connect" => {
            let ip = arg_str(args, "ip").unwrap_or_else(|| "192.168.1.23".into());
            let port = arg_u64(args, "port", 5555) as u16;
            let idn = crate::scope::connect(&ip, port)?;
            Ok(format!("已连接 {ip}:{port}\n{idn}"))
        }
        "scope_info" => scope_info_text(),
        "scope_measure" => {
            let ch = arg_u64(args, "channel", 1) as u8;
            let items: Vec<String> = args
                .get("items")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            let v = crate::scope::measure(ch, &items)?;
            Ok(scope_measure_text(&v))
        }
        "scope_waveform" => scope_wave_text(args),
        "scope_screenshot" => {
            // 不给路径就存进这个会话的工作区（用户能直接从界面打开）
            let p = arg_str(args, "path")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    ctx.workspace.join(format!("scope_{}.png", crate::now_ms()))
                });
            let v = crate::scope::screenshot(Some(p))?;
            Ok(format!(
                "截屏已保存：{}\n（{} 字节的 PNG；界面上「示波器」页点「截屏」也能直接看）",
                v.get("path").and_then(|x| x.as_str()).unwrap_or("?"),
                v.get("bytes").and_then(|x| x.as_u64()).unwrap_or(0)
            ))
        }
        "scope_control" => {
            let v = crate::scope::control(args)?;
            let list = v
                .get("applied")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("、"))
                .unwrap_or_default();
            Ok(format!("已改：{list}"))
        }
        "history_search" => history_search(ctx, args),
        "browser_open" => browser_open(ctx, args),
        "browser_read" => browser_read(ctx, args),
        "browser_find" => browser_find(ctx, args),
        "workspace_list" => workspace_list(ctx, args),
        "workspace_read" => workspace_read(ctx, args),
        "workspace_write" => workspace_write(ctx, args),
        "workspace_mkdir" => workspace_mkdir(ctx, args),
        "skill_list" => {
            let list = store::skills_list(ctx.app);
            if list.is_empty() {
                return Ok("（还没有技能）".into());
            }
            let always = store::skills_always(ctx.app);
            Ok(list
                .iter()
                .map(|s| {
                    format!(
                        "{} — {}{}",
                        s.slug,
                        s.description,
                        if always.contains(&s.slug) { "（常驻：正文每轮都在系统提示里）" } else { "" }
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "skill_read" => store::skill_read(ctx.app, &arg_str(args, "name").ok_or("缺少 name")?),
        "skill_create" => {
            let name = arg_str(args, "name").ok_or("缺少 name")?;
            let desc = arg_str(args, "description").ok_or("缺少 description")?;
            let body = arg_str(args, "body").unwrap_or_default();
            let slug = store::slugify(&name);
            let content = format!("---\nname: {name}\ndescription: {desc}\n---\n\n{body}\n");
            let path = store::skill_write(ctx.app, &slug, &content)?;
            Ok(format!("技能已建：{slug}（{path}）"))
        }
        "skill_update" => {
            let name = arg_str(args, "name").ok_or("缺少 name")?;
            let content = arg_str(args, "content").ok_or("缺少 content")?;
            let path = store::skill_write(ctx.app, &name, &content)?;
            Ok(format!("技能已更新：{path}"))
        }
        "skill_delete" => {
            let name = arg_str(args, "name").ok_or("缺少 name")?;
            store::skill_delete(ctx.app, &name)?;
            Ok(format!("技能已删除：{name}"))
        }
        other if other.starts_with("mcp__") => super::mcp::call_by_full_name(ctx.app, other, args),
        other if !is_known(other) => Err(format!("不认识工具 {other}")),
        other => Err(format!("工具 {other} 还没实现")),
    }
}

fn link_open(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let mode = arg_str(args, "mode").ok_or("缺少 mode")?;
    let endpoint = match mode.as_str() {
        "serial" => {
            let port = arg_str(args, "port").ok_or("串口链路要给 port，例如 COM7")?;
            let baud = arg_u64(args, "baud", 115200) as u32;
            let config: kdock_core::config::SerialConfig =
                serde_json::from_value(json!({
                    "baud": baud, "data_bits": "eight", "stop_bits": "one",
                    "parity": "none", "flow_control": "none"
                })).map_err(|e| format!("串口参数不对: {e}"))?;
            crate::transport::Endpoint::Serial { port, config }
        }
        "tcp" => crate::transport::Endpoint::TcpClient {
            host: arg_str(args, "host").ok_or("TCP 链路要给 host")?,
            port: arg_u64(args, "remote_port", 6666) as u16,
        },
        "udp" => crate::transport::Endpoint::Udp {
            local_port: arg_u64(args, "local_port", 0) as u16,
            remote_host: arg_str(args, "host").unwrap_or_default(),
            remote_port: arg_u64(args, "remote_port", 0) as u16,
        },
        other => return Err(format!("不支持的链路类型 {other}")),
    };
    let label = endpoint.label();
    let mut conn = crate::transport::open_endpoint(&endpoint)?;
    let mut g = ctx.state.link.lock().map_err(|_| "link mutex".to_string())?;
    if let Some(mut old) = g.conn.take() {
        old.shutdown();
    }
    set_timeout(&mut conn, 200);
    g.conn = Some(conn);
    g.mode = mode.clone();
    g.label = label.clone();
    (ctx.log)(&format!("[agent] 链路已打开：{label}\n"));
    Ok(format!("已打开 {label}"))
}

fn link_send(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let data = arg_str(args, "data").ok_or("缺少 data")?;
    let hex = arg_bool(args, "hex", false);
    let le = arg_str(args, "line_ending").unwrap_or_else(|| "cr".into());
    let mut payload: Vec<u8> = if hex {
        kdock_core::hex::hex_to_bytes(&data).map_err(|e| format!("HEX 解析失败: {e:?}"))?
    } else {
        data.as_bytes().to_vec()
    };
    payload.extend_from_slice(line_ending(&le));
    // 写满 + flush 放在**同一次** with_conn 里：中间松手等于把链路还回去，
    // 中控/前端可能正好插进来抢这条连接；而且 write 允许短写，必须写满。
    with_conn(ctx, |conn| {
        conn.write_all(&payload).map_err(|e| format!("写失败: {e}"))?;
        conn.flush().map_err(|e| format!("flush 失败: {e}"))
    })?;
    Ok(format!("已发送 {} 字节（{}）", payload.len(), if hex { "HEX" } else { "文本" }))
}

fn link_read(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let timeout = Duration::from_millis(arg_u64(args, "timeout_ms", 3000));
    let idle = Duration::from_millis(arg_u64(args, "idle_ms", 400));
    let until = arg_str(args, "until");
    let max_bytes = arg_u64(args, "max_bytes", 65_536) as usize;
    with_conn(ctx, |conn| {
        set_timeout(conn, 50);
        let mut out: Vec<u8> = Vec::new();
        let mut buf = [0u8; 1024];
        let start = Instant::now();
        let mut last = Instant::now();
        loop {
            if start.elapsed() > timeout || out.len() >= max_bytes {
                break;
            }
            // 用户点了停止：别在这儿干等到超时
            if crate::agent::stop_requested() {
                return Err("用户停止了这次等待（link_read）".into());
            }
            match conn.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    out.extend_from_slice(&buf[..n]);
                    last = Instant::now();
                    if let Some(k) = &until {
                        if String::from_utf8_lossy(&out).contains(k.as_str()) {
                            break;
                        }
                    }
                }
                Err(e) => {
                    if crate::transport::is_idle_read_error(&e) {
                        if !out.is_empty() && last.elapsed() > idle {
                            break;
                        }
                    } else {
                        return Err(format!("读失败: {e}"));
                    }
                }
            }
        }
        if out.is_empty() {
            Ok(format!("（{}ms 内没有收到数据）", start.elapsed().as_millis()))
        } else {
            Ok(text_and_hex(&out))
        }
    })
}

fn device_list(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let path = arg_str(args, "path").unwrap_or_else(|| "/".into());
    let entries = if is_serial(ctx) {
        with_conn(ctx, |conn| upgrade::serial_list(conn, &path))?
    } else {
        with_svc(ctx, |svc| svc.list_dir(&path))?
    };
    if entries.is_empty() {
        return Ok(format!("{path}：空目录"));
    }
    let mut lines = vec![format!("{path} 下的 {} 项：", entries.len())];
    for e in entries.iter().take(300) {
        lines.push(if e.is_dir {
            format!("D {}", e.name)
        } else {
            format!("F {:>10}  {}", e.size, e.name)
        });
    }
    Ok(lines.join("\n"))
}

fn device_pull(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let path = arg_str(args, "path").ok_or("缺少 path")?;
    let save_to = match arg_str(args, "save_to") {
        Some(p) => p,
        None => {
            let name = path.rsplit('/').next().unwrap_or("pull.bin").to_string();
            store::resolve_in_workspace(&ctx.workspace, &name)?.to_string_lossy().to_string()
        }
    };
    if let Some(parent) = std::path::Path::new(&save_to).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log = ctx.log;
    let r = if is_serial(ctx) {
        with_conn(ctx, |conn| upgrade::serial_pull(conn, &path, &save_to, |s| log(s)))?
    } else {
        with_svc(ctx, |svc| upgrade::svc_pull(svc, &path, &save_to, |s| log(s)))?
    };
    Ok(format!("已取回 {} 字节 -> {}\ncrc32={:08X}", r.bytes, save_to, r.crc32))
}

fn device_push(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let local = arg_str(args, "local").ok_or("缺少 local")?;
    let data = std::fs::read(&local).map_err(|e| format!("读不了 {local}: {e}"))?;
    let remote = arg_str(args, "remote").unwrap_or_else(|| {
        format!("/{}", std::path::Path::new(&local).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "up.bin".into()))
    });
    let log = ctx.log;
    let crc = if is_serial(ctx) {
        with_conn(ctx, |conn| upgrade::serial_upload(conn, &remote, &data, |s| log(s)))?
    } else {
        with_svc(ctx, |svc| upgrade::svc_upload(svc, &remote, &data, |s| log(s)))?
    };
    Ok(format!("已发送 {} 字节 -> {}\ncrc32={:08X}", data.len(), remote, crc))
}

fn firmware_info(args: &Value) -> Result<String, String> {
    let local = arg_str(args, "local").ok_or("缺少 local")?;
    let data = std::fs::read(&local).map_err(|e| format!("读不了 {local}: {e}"))?;
    let name = std::path::Path::new(&local).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let info = upgrade::parse_fw(&data, &name)?;
    Ok(format!(
        "版本 v{}\npayload {} B  crc32={:08X}\n整包 {} B  crc32={:08X}\nboard={} name={}",
        info.version, info.payload_size, info.payload_crc32, info.file_size, info.file_crc32, info.board, info.name))
}

fn firmware_upgrade(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let local = arg_str(args, "local").ok_or("缺少 local")?;
    let data = std::fs::read(&local).map_err(|e| format!("读不了 {local}: {e}"))?;
    let name = std::path::Path::new(&local).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let transport = arg_str(args, "transport").unwrap_or_else(|| "auto".into());
    let use_net = match transport.as_str() {
        "net" => true,
        "serial" => false,
        _ => !is_serial(ctx),
    };
    let log = ctx.log;
    let mut lines: Vec<String> = Vec::new();
    {
        let mut log_fn = |s: &str| { log(s); };
        let mut prog_fn = |_p: f64| {};
        let mut cx = upgrade::Ctx { log: &mut log_fn, progress: &mut prog_fn };
        if use_net {
            let host = arg_str(args, "host")
                .or_else(|| ctx.state.link.lock().ok().and_then(|g| {
                    let l = g.label.clone();
                    l.strip_prefix("TCP ").and_then(|r| r.split(':').next().map(|s| s.to_string()))
                }))
                .ok_or("网口升级要知道设备 IP：给 host，或者先 link_open 一条 TCP 链路")?;
            let port = arg_u64(args, "remote_port", 6666) as u16;
            upgrade::net_upgrade(&mut cx, &host, port, &name, &data)?;
            lines.push(format!("网口升级完成：{host}:{port}"));
        } else {
            with_conn(ctx, |conn| upgrade::serial_upgrade(&mut cx, conn, &name, &data))?;
            lines.push("串口升级完成".to_string());
        }
    }
    let info = upgrade::parse_fw(&data, &name)?;
    Ok(format!("{}\npayload {} B  crc32={:08X}\n设备已复位；等它起来后建议 device_list / firmware 版本确认一次。",
        lines.join("\n"), info.payload_size, info.payload_crc32))
}

fn local_run(args: &Value) -> Result<String, String> {
    let cmd = arg_str(args, "cmd").ok_or("缺少 cmd")?;
    let timeout = Duration::from_millis(arg_u64(args, "timeout_ms", 15_000));
    let mut child = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", &cmd]);
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", &cmd]);
        c
    }
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .spawn()
    .map_err(|e| format!("起进程失败: {e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                let out = child.wait_with_output().map_err(|e| e.to_string())?;
                let mut text = String::new();
                text.push_str(&format!("exit={}\n", status.code().unwrap_or(-1)));
                let so = String::from_utf8_lossy(&out.stdout);
                let se = String::from_utf8_lossy(&out.stderr);
                if !so.trim().is_empty() { text.push_str(&format!("--- stdout ---\n{}\n", so.trim_end())); }
                if !se.trim().is_empty() { text.push_str(&format!("--- stderr ---\n{}\n", se.trim_end())); }
                let cut: String = text.chars().take(8000).collect();
                return Ok(cut);
            }
            None => {
                if crate::agent::stop_requested() {
                    let _ = child.kill();
                    return Err("用户停止了这条本机命令（进程已杀掉）".into());
                }
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return Err(format!("命令超过 {}ms 没结束，已杀掉", timeout.as_millis()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

fn which(exe: &str) -> Option<String> {
    let out = if cfg!(windows) {
        std::process::Command::new("where").arg(exe).output().ok()?
    } else {
        std::process::Command::new("sh").args(["-c", &format!("command -v {exe}")]).output().ok()?
    };
    if !out.status.success() { return None; }
    String::from_utf8_lossy(&out.stdout).lines().next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn flash(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let tool = arg_str(args, "tool").ok_or("缺少 tool")?;
    let file = arg_str(args, "file").ok_or("缺少 file")?;
    if !std::path::Path::new(&file).exists() {
        return Err(format!("找不到固件文件 {file}"));
    }
    let exe = match arg_str(args, "exe") {
        Some(p) => p,
        None => match tool.as_str() {
            "jlink" => which("JLink.exe").or_else(|| which("JLink")).ok_or("PATH 里没有 JLink.exe，请用 exe 指定全路径")?,
            "openocd" => which("openocd.exe").or_else(|| which("openocd")).ok_or("PATH 里没有 openocd.exe，请用 exe 指定全路径")?,
            "stm32" => which("STM32_Programmer_CLI.exe").or_else(|| which("STM32_Programmer_CLI"))
                .ok_or("PATH 里没有 STM32_Programmer_CLI.exe，请用 exe 指定全路径")?,
            other => return Err(format!("不支持的烧录工具 {other}")),
        },
    };
    let addr = arg_str(args, "addr").unwrap_or_else(|| "0x08000000".into());
    let device = arg_str(args, "device").unwrap_or_else(|| "STM32F407VG".into());
    let argv: Vec<String>;
    match tool.as_str() {
        "jlink" => {
            // 用命令行脚本方式：先写一份临时 script，再让 JLink.exe 跑它
            let script = format!(
                "device {device}\nsi SWD\nspeed 4000\nconnect\nh\nloadfile \"{file}\"\nr\ng\nexit\n");
            let tmp = std::env::temp_dir().join("kdock_agent_flash.jlink");
            std::fs::write(&tmp, script).map_err(|e| format!("写 J-Link 脚本失败: {e}"))?;
            argv = vec!["-ExitOnError".into(), "1".into(), "-CommanderScript".into(), tmp.to_string_lossy().to_string()];
        }
        "openocd" => {
            let cfg = arg_str(args, "config").unwrap_or_else(|| "interface/cmsis-dap.cfg".into());
            let target = arg_str(args, "target").unwrap_or_else(|| "target/stm32f4x.cfg".into());
            argv = vec![
                "-f".into(), cfg, "-f".into(), target,
                "-c".into(), "init".into(), "-c".into(), "halt".into(),
                "-c".into(), format!("program \"{file}\" verify reset exit"),
            ];
        }
        _ => {
            argv = vec![
                "-c".into(), "port=SWD".into(), "-w".into(), file.clone(), addr.clone(),
                "-v".into(), "-rst".into(),
            ];
        }
    }
    let (log, app) = (ctx.log, ctx.app);
    (log)(&format!("[agent] 烧录: {} {}\n", exe, argv.join(" ")));
    let _ = app.emit("flash://log", format!("\n[agent] $ {} {}\n", exe, argv.join(" ")));
    let mut child = std::process::Command::new(&exe)
        .args(&argv)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("起 {exe} 失败: {e}"))?;
    let start = Instant::now();
    let timeout = Duration::from_millis(180_000);
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                let out = child.wait_with_output().map_err(|e| e.to_string())?;
                let text = format!(
                    "exit={}\n{}\n{}",
                    status.code().unwrap_or(-1),
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr));
                let _ = app.emit("flash://log", text.clone());
                let tail: Vec<&str> = text.lines().rev().take(40).collect();
                let mut tail: Vec<&str> = tail.into_iter().collect();
                tail.reverse();
                let ok = status.success();
                return Ok(format!("烧录退出码 {}（{}）\n--- 末尾输出 ---\n{}",
                    status.code().unwrap_or(-1), if ok { "成功" } else { "失败" }, tail.join("\n")));
            }
            None => {
                if crate::agent::stop_requested() {
                    let _ = child.kill();
                    return Err("用户停止了这次烧录（烧录器进程已杀掉）".into());
                }
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return Err("烧录超过 180s，已中断".into());
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

/// codex/magic-context 那套"原始记录永不丢，细节按需回查"的出口
fn history_search(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let needle = arg_str(args, "text").ok_or("缺少 text")?;
    let max_hits = arg_u64(args, "max_hits", 8) as usize;
    let raw = crate::agent::store::session_raw(ctx.app, ctx.session);
    if raw.is_empty() {
        return Ok("会话记录是空的".into());
    }
    let mut hits: Vec<String> = Vec::new();
    for line in raw.lines() {
        if hits.len() >= max_hits {
            break;
        }
        if !line.contains(&needle) {
            continue;
        }
        let ev: Value = serde_json::from_str(line).unwrap_or(Value::Null);
        let kind = ev.get("type").and_then(|v| v.as_str()).unwrap_or("?");
        let text = match kind {
            "user" | "assistant" | "note" => ev.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            "tool_call" => format!("{} {}", ev.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                                   ev.get("args").cloned().unwrap_or(Value::Null)),
            "tool_result" => ev.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            "summary" => ev.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            _ => String::new(),
        };
        let at = text.find(&needle).unwrap_or(0);
        let start = at.saturating_sub(80);
        let end = (at + needle.len() + 160).min(text.len());
        let mut s0 = start;
        while s0 < text.len() && !text.is_char_boundary(s0) {
            s0 += 1;
        }
        let mut e0 = end;
        while e0 > 0 && !text.is_char_boundary(e0) {
            e0 -= 1;
        }
        hits.push(format!("[{kind}] …{}…", &text[s0..e0]));
    }
    if hits.is_empty() {
        return Ok(format!("会话记录里没找到「{needle}」"));
    }
    Ok(format!("在会话记录里找到 {} 处（含已压缩部分）：\n{}", hits.len(), hits.join("\n")))
}

fn set_page(ctx: &ToolCtx, page: super::browser::Page) {
    if let Ok(mut g) = ctx.state.page.lock() {
        if let Some(old) = g.replace(page.clone()) {
            if let Ok(mut h) = ctx.state.history.lock() {
                h.push(old);
                if h.len() > 30 {
                    h.remove(0);
                }
            }
        }
    }
    let _ = ctx.app.emit("agent://browser", &page);
}

fn browser_open(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let url = arg_str(args, "url").ok_or("缺少 url")?;
    let page = super::browser::fetch(&url)?;
    let chars = page.text.chars().count();
    let links = page.links.len();
    let out = format!(
        "已打开 {}\n标题：{}\n正文 {} 字 / {} 个链接\n--- 正文开头 ---\n{}",
        page.url,
        page.title,
        chars,
        links,
        page.text.chars().take(3000).collect::<String>()
    );
    set_page(ctx, page);
    Ok(out)
}

fn browser_read(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    if let Some(url) = arg_str(args, "url") {
        let page = super::browser::fetch(&url)?;
        set_page(ctx, page);
    }
    let max = arg_u64(args, "max_chars", 12_000) as usize;
    let g = ctx.state.page.lock().map_err(|_| "page mutex".to_string())?;
    let page = g.as_ref().ok_or("还没有打开任何网页，先 browser_open")?;
    let body: String = page.text.chars().take(max).collect();
    let more = if page.text.chars().count() > max { "\n…(截断)" } else { "" };
    Ok(format!("{}\n标题：{}\n--- 正文 ---\n{}{}", page.url, page.title, body, more))
}

fn browser_find(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let needle = arg_str(args, "text").ok_or("缺少 text")?;
    let max_hits = arg_u64(args, "max_hits", 5) as usize;
    let g = ctx.state.page.lock().map_err(|_| "page mutex".to_string())?;
    let page = g.as_ref().ok_or("还没有打开任何网页，先 browser_open")?;
    let text = &page.text;
    let mut out = Vec::new();
    let mut pos = 0usize;
    while out.len() < max_hits {
        let Some(rel) = text[pos..].find(&needle) else { break };
        let at = pos + rel;
        let start = text[..at].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let end = text[at..].find('\n').map(|i| at + i).unwrap_or(text.len());
        out.push(format!("…{}…", text[start..end].trim()));
        pos = end.max(at + 1);
    }
    if out.is_empty() {
        return Ok(format!("当前页 {} 里没有找到「{needle}」", page.url));
    }
    Ok(format!("在 {} 里找到 {} 处：\n{}", page.url, out.len(), out.join("\n")))
}

fn workspace_list(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let rel = arg_str(args, "path").unwrap_or_else(|| ".".into());
    let dir = store::resolve_in_workspace(&ctx.workspace, &rel)?;
    std::fs::create_dir_all(&dir).ok();
    let mut lines = vec![format!("工作区 {}/ 下：", rel)];
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("读目录失败: {e}"))?.flatten() {
        let md = entry.metadata().ok();
        let is_dir = md.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
        let name = entry.file_name().to_string_lossy().to_string();
        lines.push(if is_dir { format!("D {name}/") } else { format!("F {size:>10}  {name}") });
    }
    Ok(lines.join("\n"))
}

fn workspace_read(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let rel = arg_str(args, "path").ok_or("缺少 path")?;
    let max = arg_u64(args, "max_bytes", 65_536) as usize;
    let path = store::resolve_in_workspace(&ctx.workspace, &rel)?;
    let data = std::fs::read(&path).map_err(|e| format!("读不了 {rel}: {e}"))?;
    let cut = &data[..data.len().min(max)];
    Ok(text_and_hex(cut))
}

fn workspace_write(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let rel = arg_str(args, "path").ok_or("缺少 path")?;
    let content = arg_str(args, "content").unwrap_or_default();
    let path = store::resolve_in_workspace(&ctx.workspace, &rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let size = content.len();
    if arg_bool(args, "append", false) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path)
            .map_err(|e| format!("打开失败: {e}"))?;
        f.write_all(content.as_bytes()).map_err(|e| format!("写失败: {e}"))?;
    } else {
        std::fs::write(&path, content).map_err(|e| format!("写失败: {e}"))?;
    }
    Ok(format!("已写 {} 字节 -> {}", size, path.display()))
}

fn workspace_mkdir(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let rel = arg_str(args, "path").ok_or("缺少 path")?;
    let path = store::resolve_in_workspace(&ctx.workspace, &rel)?;
    std::fs::create_dir_all(&path).map_err(|e| format!("建目录失败: {e}"))?;
    Ok(format!("已建目录 {}", path.display()))
}
