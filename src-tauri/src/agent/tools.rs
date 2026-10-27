//! Agent 能用的**工具**。
//!
//! 两类：
//! - **native**：直接调 KDock 自己那套 Rust 能力（链路、设备文件、OTA、烧录、示波器、工作区、技能）。
//!   agent 用**自己的一条连接**（不抢传输页那条主连接），所以你手动敲命令时它也能自己连一条。
//! - **host**：JS 那边实现的能力（中控编排、切页面、屏幕捕获…），走 `agent://host_call` 事件往返。

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

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
        t.push(ToolDef {
            name,
            description,
            schema,
            host,
        });
    };

    push(
        "link_open",
        "打开一条**本会话专属**的 agent 链路（串口/网口），不会影响其它会话的链路。会先关掉本会话的上一条。",
        json!({"type":"object","properties":{
            "mode":{"type":"string","enum":["serial","tcp","udp"],"description":"链路类型"},
            "port":{"type":"string","description":"串口名，如 COM7"},
            "baud":{"type":"integer","description":"波特率，默认 115200"},
            "host":{"type":"string","description":"TCP/UDP 目标 IP"},
            "remote_port":{"type":"integer","description":"TCP/UDP 目标端口"},
            "local_port":{"type":"integer","description":"UDP 本地端口"},
            "local_addr":{"type":"string","description":"本机网卡地址；多网卡时指定源地址，留空按系统路由"}
        },"required":["mode"]}),
        false,
    );
    push(
        "link_close",
        "关掉 agent 的链路。",
        json!({"type":"object","properties":{}}),
        false,
    );
    push(
        "link_status",
        "看 agent 链路现在通不通。",
        json!({"type":"object","properties":{}}),
        false,
    );
    push(
        "link_send",
        "往链路发数据（文本或 HEX）。",
        json!({"type":"object","properties":{
            "data":{"type":"string","description":"要发的内容"},
            "hex":{"type":"boolean","description":"true 表示 data 是十六进制，如 '41 54'"},
            "line_ending":{"type":"string","enum":["none","cr","lf","crlf"],"description":"行尾，默认 cr"}
        },"required":["data"]}),
        false,
    );
    push(
        "link_read",
        "读链路返回（等到静默超时或命中 until）。",
        json!({"type":"object","properties":{
            "timeout_ms":{"type":"integer","description":"最多等多久，默认 3000"},
            "idle_ms":{"type":"integer","description":"静默多久算读完，默认 400"},
            "until":{"type":"string","description":"命中这个子串就立刻返回"},
            "max_bytes":{"type":"integer","description":"最多读多少字节，默认 65536"}
        }}),
        false,
    );
    // ── 用户那条主连接（传输页里开的那条）：agent 也能用，而且用户全程看得见 ──
    push(
        "port_list",
        "列出本机串口（含友好名 / VID:PID）。要看有哪些口就用这个，别去跑 PowerShell 扫。",
        json!({"type":"object","properties":{}}),
        false,
    );
    push(
        "port_state",
        "看**用户在传输页开的那条主连接**的状态：类型 / 参数 / 是否连着 / 收发字节数。",
        json!({"type":"object","properties":{}}),
        false,
    );
    push("port_write", "往**主连接**（用户在传输页开的那条）发数据，文本或 HEX。发出去的内容会实时显示在用户的传输页里（TX 行），所以这是「用户看得见」的通道。**主连接是多会话共享的，写入会串行化**；要让多个会话各自独立操作设备，用 link_*。",
        json!({"type":"object","properties":{
            "data":{"type":"string","description":"要发的内容"},
            "hex":{"type":"boolean","description":"true 表示 data 是十六进制，如 '41 54'"},
            "line_ending":{"type":"string","enum":["none","cr","lf","crlf"],"description":"行尾，默认 cr"}
        },"required":["data"]}), false);
    push("port_read", "读**主连接**最近的收发记录（用户在传输页看到的就是这一份）：每行给方向 + 毫秒时间戳 + 内容。",
        json!({"type":"object","properties":{"tail":{"type":"integer","description":"取最近多少条，默认 40，最多 400"}}}), false);
    push("port_open", "打开**主连接**（用户在传输页那条）：串口 / TCP 客户端 / TCP 服务端 / UDP。连上之后界面里的方式和参数会同步过去，用户看得见。已经连着时要先 port_close。**主连接是多会话共享的**；要隔离设备操作请用 link_*。",
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
            "local_addr":{"type":"string","description":"本机网卡地址；多网卡时指定源地址，留空按系统路由"},
            "remote_host":{"type":"string","description":"udp 的远端 IP"}
        },"required":["mode"]}), false);
    push(
        "port_close",
        "断开**主连接**（用户在传输页那条）。",
        json!({"type":"object","properties":{}}),
        false,
    );
    push("net_local_ips", "列本机 IPv4 地址：开 TCP 服务端 / UDP 时该填哪个本机地址、该让用户连哪个地址，用这个看（0.0.0.0 表示所有网卡）。",
        json!({"type":"object","properties":{}}), false);
    push(
        "device_list",
        "列设备上的目录（串口走 cshell ls，网口走 6666 服务通道）。",
        json!({"type":"object","properties":{"path":{"type":"string","description":"设备上的路径，默认 /"}}}),
        false,
    );
    push(
        "device_pull",
        "把设备上的文件取回本机（带 CRC32 校验）。",
        json!({"type":"object","properties":{
            "path":{"type":"string","description":"设备上的文件路径"},
            "save_to":{"type":"string","description":"本机保存路径；不填就存到工作区里"}
        },"required":["path"]}),
        false,
    );
    push(
        "device_push",
        "把本机文件发到设备。",
        json!({"type":"object","properties":{
            "local":{"type":"string","description":"本机文件路径"},
            "remote":{"type":"string","description":"设备上的目标路径，默认同名放根目录"}
        },"required":["local"]}),
        false,
    );
    push(
        "firmware_info",
        "读一个 .fw 升级包的版本/大小/CRC32。",
        json!({"type":"object","properties":{"local":{"type":"string"}},"required":["local"]}),
        false,
    );
    push(
        "firmware_upgrade",
        "把 .fw 包升级进设备（串口或网口）。**会复位设备**，做完最好再确认一次版本。",
        json!({"type":"object","properties":{
            "local":{"type":"string","description":"本机 .fw 路径"},
            "transport":{"type":"string","enum":["auto","serial","net"],"description":"默认跟着当前链路走"},
            "host":{"type":"string","description":"走网口时的设备 IP"},
            "remote_port":{"type":"integer","description":"网口服务端口，默认 6666"}
        },"required":["local"]}),
        false,
    );
    push(
        "local_run",
        "在本机跑一条命令（cmd /C），返回退出码和输出。",
        json!({"type":"object","properties":{
            "cmd":{"type":"string"},
            "timeout_ms":{"type":"integer","description":"默认 15000"}
        },"required":["cmd"]}),
        false,
    );
    push(
        "flash",
        "用烧录器写片（J-Link / openocd / STM32CubeProgrammer）。",
        json!({"type":"object","properties":{
            "tool":{"type":"string","enum":["jlink","openocd","stm32"]},
            "file":{"type":"string","description":"要烧的 .hex/.bin/.elf"},
            "exe":{"type":"string","description":"工具可执行文件路径，不填就按 PATH 找"},
            "device":{"type":"string","description":"芯片型号，如 STM32F407VG"},
            "addr":{"type":"string","description":"bin 的烧写地址，如 0x08000000"}
        },"required":["tool","file"]}),
        false,
    );
    push(
        "scope",
        "给示波器发一条裸 SCPI 命令（RIGOL），返回设备回包。要连通就用 scope_connect。",
        json!({"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}),
        false,
    );
    push(
        "scope_connect",
        "连示波器（RIGOL DS1000Z 系，SCPI over TCP）。连上会回 *IDN?（型号+序列号+固件）。",
        json!({"type":"object","properties":{
            "ip":{"type":"string","description":"示波器 IP；不填就试上次用的那个"},
            "port":{"type":"integer","description":"默认 5555"}
        }}),
        false,
    );
    push(
        "scope_info",
        "读示波器当前状态：型号、各通道开关/档位/偏移/耦合/探头、时基、采样率、触发源与电平。",
        json!({"type":"object","properties":{}}),
        false,
    );
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
    push(
        "scope_screenshot",
        "截示波器屏幕，存成 PNG 并回存到哪了（同时回一张可给用户看的图）。",
        json!({"type":"object","properties":{
            "path":{"type":"string","description":"存哪；不填就存到 agent 工作区"}
        }}),
        false,
    );
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
    push(
        "workspace_list",
        "列 agent 工作区里的文件。",
        json!({"type":"object","properties":{"path":{"type":"string","description":"相对路径，默认 ."}}}),
        false,
    );
    push(
        "workspace_read",
        "读工作区里的文本文件。一次可以给 path，或者给 paths 数组批量读多个文件（推荐）。",
        json!({"type":"object","properties":{
            "path":{"type":"string","description":"单个文件路径"},
            "paths":{"type":"array","items":{"type":"string"},"description":"批量读取多个文件"},
            "max_bytes":{"type":"integer","description":"默认 65536"}
        }}),
        false,
    );
    push(
        "workspace_write",
        "写工作区里的文件（会自动建目录）。一次可以给 path+content，或者给 files 数组批量创建/覆盖多个文件。",
        json!({"type":"object","properties":{
            "path":{"type":"string"},
            "content":{"type":"string"},
            "files":{"type":"array","items":{"type":"object","properties":{
                "path":{"type":"string"},"content":{"type":"string"}
            },"required":["path","content"]},"description":"批量文件"},
            "append":{"type":"boolean","description":"true 表示追加"}
        }}),
        false,
    );
    push(
        "workspace_mkdir",
        "在工作区里建目录。",
        json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
        false,
    );
    push(
        "workspace_edit",
        "结构化改文件：把 old_text 精确替换成 new_text，返回 unified diff。支持一次给 edits 数组批量改多个位置/文件；old_text 必须唯一（除非 replace_all=true）。",
        json!({"type":"object","properties":{
            "path":{"type":"string","description":"单个文件的相对路径（批量时可在每个 edit 里给 path）"},
            "old_text":{"type":"string","description":"要替换的原文（精确匹配）"},
            "new_text":{"type":"string","description":"替换后的文本，可为空"},
            "replace_all":{"type":"boolean","description":"默认 false；true 才允许替换所有出现"},
            "edits":{"type":"array","items":{"type":"object","properties":{
                "path":{"type":"string"},
                "old_text":{"type":"string"},
                "new_text":{"type":"string"},
                "replace_all":{"type":"boolean"}
            },"required":["old_text","new_text"]},"description":"批量编辑"}
        }}),
        false,
    );
    push(
        "workspace_diff",
        "审查工作区改动：在 git 仓库里返回 git status + unified diff（可选 path 只看某个文件）；非 git 仓库会明确报错。",
        json!({"type":"object","properties":{
            "path":{"type":"string","description":"可选的相对路径"}
        }}),
        false,
    );
    push(
        "workspace_search",
        "在工作区里按子串搜索代码（自动跳过 .git/target/node_modules 等），返回 路径:行号: 文本。比全盘 local_run grep 更安全、更快。",
        json!({"type":"object","properties":{
            "pattern":{"type":"string","description":"要找的子串"},
            "path":{"type":"string","description":"搜索起点，默认工作区根"},
            "ext":{"type":"string","description":"可选扩展名过滤，如 rs 或 .rs"},
            "max_results":{"type":"integer","description":"默认 50，最多 500"},
            "case_sensitive":{"type":"boolean","description":"默认 false"}
        },"required":["pattern"]}),
        false,
    );
    push(
        "workspace_run",
        "在工作区目录里跑一条本机命令（cmd /C），返回退出码和输出。命令仍然拥有本机权限；需要审批。",
        json!({"type":"object","properties":{
            "cmd":{"type":"string"},
            "cwd":{"type":"string","description":"相对工作区的子目录，默认工作区根"},
            "timeout_ms":{"type":"integer","description":"默认 120000"}
        },"required":["cmd"]}),
        false,
    );
    push(
        "workspace_test",
        "跑项目测试：自动识别 Cargo.toml / package.json / pytest，也允许显式给 cmd；在工作区目录执行，返回退出码 + 尾部输出。",
        json!({"type":"object","properties":{
            "cmd":{"type":"string","description":"不填就自动识别"},
            "cwd":{"type":"string","description":"相对工作区的子目录，默认工作区根"},
            "timeout_ms":{"type":"integer","description":"默认 300000"}
        }}),
        false,
    );
    push(
        "workspace_context",
        "一次拿齐上下文：目录列表 + 可选搜索命中 + 指定文件内容。适合“先看项目再动手”，减少多次 workspace_list/search/read。",
        json!({"type":"object","properties":{
            "path":{"type":"string","description":"目录，默认工作区根"},
            "pattern":{"type":"string","description":"可选搜索词"},
            "paths":{"type":"array","items":{"type":"string"},"description":"要一起读的文件"},
            "max_files":{"type":"integer","description":"目录最多列多少项，默认 80"},
            "max_bytes":{"type":"integer","description":"每个文件最多读多少字节，默认 20000"}
        }}),
        false,
    );
    push(
        "workspace_check",
        "一次完成验证：git status/diff + 项目测试（自动识别或显式 cmd），返回两段结果。改完代码优先用它，减少 diff/test 两次调用。",
        json!({"type":"object","properties":{
            "cmd":{"type":"string","description":"测试命令，不填自动识别"},
            "cwd":{"type":"string","description":"相对工作区的子目录，默认根"},
            "timeout_ms":{"type":"integer","description":"默认 300000"}
        }}),
        false,
    );
    push(
        "output_read",
        "读被截断的工具输出全文（大输出会落到 tool-output 目录，工具结果里会给出路径）。\
offset/limit 按**字符**算，默认从 0 读 1200 字；一次读不完就接着往后读，别整段贴回对话。\
每次只读真正需要的那一段（日志先看 tail/头尾），这是控制缓存命中率的关键。",
        json!({"type":"object","properties":{
            "path":{"type":"string","description":"工具结果里给出的那个路径（也可以只给文件名）"},
            "offset":{"type":"integer","description":"从第几个字符开始（默认 0）"},
            "limit":{"type":"integer","description":"最多读多少字符（默认 1200，上限 40000）"}
        },"required":["path"]}),
        false,
    );
    push(
        "skill_list",
        "列出**可用**的技能（名字 + 描述）。被用户停用的技能不会出现在这里。",
        json!({"type":"object","properties":{}}),
        false,
    );
    push("skill_read", "按名字读一个技能的完整 SKILL.md。停用技能不会出现在 skill_list 或系统提示里；只有用户明确点名某个技能时才按名字读取，不要自行猜测停用技能的存在。",
        json!({"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}), false);
    push(
        "skill_create",
        "新建一个技能（一份带 frontmatter 的 SKILL.md）。",
        json!({"type":"object","properties":{
            "name":{"type":"string","description":"技能名，会做 slug 化"},
            "description":{"type":"string","description":"一句话说明什么时候用它"},
            "body":{"type":"string","description":"正文（Markdown）"},
            "scope":{"type":"string","enum":["global","workspace"],"description":"存哪一层：global=用户级（默认），workspace=只在本项目生效（<工作区>/.kdock_skill）"}
        },"required":["name","description"]}),
        false,
    );
    push(
        "skill_update",
        "整体覆盖一个技能的 SKILL.md。",
        json!({"type":"object","properties":{"name":{"type":"string"},"content":{"type":"string"},
            "scope":{"type":"string","enum":["global","workspace"],"description":"改哪一层（默认 global）"}},"required":["name","content"]}),
        false,
    );
    push(
        "skill_delete",
        "删掉一个技能。",
        json!({"type":"object","properties":{"name":{"type":"string"},
            "scope":{"type":"string","enum":["global","workspace"],"description":"删哪一层（默认 global；本项目技能删之前会自动归档一份）"}},"required":["name"]}),
        false,
    );
    push(
        "plan_write",
        "更新当前会话的计划/待办。items 是数组，每项 {id?, title, status}；status 用 pending / in_progress / completed。用于多步任务先列计划、每完成一步更新。",
        json!({"type":"object","properties":{
            "items":{"type":"array","items":{"type":"object","properties":{
                "id":{"type":"string"},
                "title":{"type":"string"},
                "status":{"type":"string","enum":["pending","in_progress","completed"]}
            },"required":["title","status"]}}
        },"required":["items"]}),
        false,
    );
    push("plan_read", "读当前会话的计划/待办。", json!({"type":"object","properties":{}}), false);
    push(
        "subagent_spawn",
        "开一个子会话在后台执行独立任务（继承当前工作区和权限，返回子会话 id）。适合并行做多个互不依赖的调查/实现；用 subagent_wait 等结果。",
        json!({"type":"object","properties":{
            "task":{"type":"string","description":"交给子会话的完整任务"},
            "title":{"type":"string","description":"可选标题"},
            "provider_id":{"type":"string","description":"可选模型 profile；默认继承当前会话"}
        },"required":["task"]}),
        false,
    );
    push(
        "subagent_wait",
        "等一个子会话跑完（最多 timeout_ms），返回状态和最后一条回复。",
        json!({"type":"object","properties":{
            "session":{"type":"string","description":"subagent_spawn 返回的 id"},
            "timeout_ms":{"type":"integer","description":"默认 120000，最大 600000"}
        },"required":["session"]}),
        false,
    );
    push(
        "subagent_result",
        "读子会话的最终回复和工具调用摘要（不等待）。",
        json!({"type":"object","properties":{
            "session":{"type":"string","description":"subagent_spawn 返回的 id"}
        },"required":["session"]}),
        false,
    );
    push(
        "parallel_read",
        "并行执行多个**只读**工具（workspace_read / workspace_list / workspace_search / output_read / port_list / port_state / port_read / net_local_ips / adb_devices / adb_mdns / screen_list / skill_list / history_search），一次返回全部结果。用来减少多文件读取的模型往返。",
        json!({"type":"object","properties":{
            "ops":{"type":"array","items":{"type":"object","properties":{
                "tool":{"type":"string"},
                "args":{"type":"object"}
            },"required":["tool"]}}
        },"required":["ops"]}),
        false,
    );

    // ── SSH：远程跑一条命令（给"让 agent 去操作另一台机器"用）─────────────
    push("ssh_run", "SSH 到一台机器上跑一条命令，回退出码 + 输出。\
密码登录走 PuTTY plink（Windows 自带的 ssh.exe 只在控制台里读密码）；没密码就用 ssh.exe + 密钥（给 key 参数）。\
首次连接会自动记住主机指纹，之后对不上会拒绝。\
**启动常驻服务/守护进程时把 background 设为 true**（工具会自动 setsid + disown，只回 started）；\
日志请在 cmd 里重定向到文件。普通命令不要设 background。",
        json!({"type":"object","properties":{
            "host":{"type":"string","description":"主机名或 IP"},
            "user":{"type":"string","description":"用户名"},
            "password":{"type":"string","description":"密码（可空；空就走密钥/ssh-agent）"},
            "key":{"type":"string","description":"私钥路径（可空）"},
            "port":{"type":"integer","description":"端口，默认 22"},
            "cmd":{"type":"string","description":"要跑的命令（远端 shell 一行）"},
            "background":{"type":"boolean","description":"true = 远端后台运行（setsid/disown），适合起服务；日志在 cmd 里自行重定向"},
            "timeout_ms":{"type":"integer","description":"超时毫秒，默认 60000"}
        },"required":["host","cmd"]}), false);

    // ── host：JS 那边实现 ───────────────────────────────────────────
    push(
        "browser_open",
        "用内置浏览器打开一个网页（抓下来抽正文，页面同时会显示在右侧「浏览器」里）。",
        json!({"type":"object","properties":{
            "url":{"type":"string","description":"网址，可以不带 https://"}
        },"required":["url"]}),
        false,
    );
    push(
        "browser_read",
        "读「当前页」的正文（browser_open 之后用；不传 url 就是当前页）。",
        json!({"type":"object","properties":{
            "url":{"type":"string","description":"可选，先抓这个再读"},
            "max_chars":{"type":"integer","description":"最多返回多少字，默认 12000"}
        }}),
        false,
    );
    push(
        "browser_find",
        "在「当前页」正文里找一段文字，返回前后文。",
        json!({"type":"object","properties":{
            "text":{"type":"string"},
            "max_hits":{"type":"integer","description":"默认 5"}
        },"required":["text"]}),
        false,
    );
    push("history_search", "在**本会话的原始记录**里按关键词回查（包括已经被摘要压缩掉的那段）。上下文被压缩后，想找回细节就用它。",
        json!({"type":"object","properties":{
            "text":{"type":"string","description":"要找的关键词"},
            "max_hits":{"type":"integer","description":"最多返回几条，默认 8"}
        },"required":["text"]}), false);
    push(
        "ui_show_text",
        "把一段文本显示到右侧「文本」页（给用户看 / 自己回头看）。",
        json!({"type":"object","properties":{
            "title":{"type":"string"},
            "text":{"type":"string"}
        },"required":["text"]}),
        true,
    );
    push(
        "ui_goto",
        "把界面切到某个页（transfer/upgrade/flash/files/runtime/chart/flow/capture/scope）。",
        json!({"type":"object","properties":{"page":{"type":"string"}},"required":["page"]}),
        true,
    );
    push(
        "flow_run",
        "跑中控编排（不传 graph 就跑当前画布上的）。",
        json!({"type":"object","properties":{
            "graph":{"type":"object","description":"可选，直接给编排 JSON"},
            "wait":{"type":"boolean","description":"等它跑完再返回，默认 true"}
        }}),
        true,
    );
    push("la_state", "读逻辑分析仪的**当前状态**：数据来源、采样率、通道数/点数/时长、视图窗口、光标 A/B 与 Δt、通道列表（含当前电平）、已加的解码器、选中通道的测量（频率/占空比/脉冲/脉宽）。只读，不改任何东西。",
        json!({"type":"object","properties":{}}), true);
    push("la_read", "读逻辑分析仪**解码出来的结果**（只读）：每个解码器解出来的全部项（协议字节/字段 + 起止时间 + CRC/校验/应答这类判定），以及每一路在当前视图窗口里的频率/占空比/脉冲数。",
        json!({"type":"object","properties":{
            "tail":{"type":"integer","description":"每个解码器只返回最后 N 项，默认 200，最多 2000"}
        }}), true);
    push("la_decoders", "看逻辑分析仪**支持哪些协议**、每种协议能配哪些参数（通道 / 波特率 / 模式 / 位序 …）与默认值，另外列出内置的示例场景 id。配 la_config 的 decoders 之前先调它，别猜参数名。只读。",
        json!({"type":"object","properties":{}}), true);
    push("la_config", "改逻辑分析仪的**配置**（不动采集到的数据）：设采样率、整份替换解码器列表（19 种协议：uart/spi/i2c/can/1wire/ds18b20/dht/ps2/nec/i2s/jtag/swd/modbus/lin/dmx512/manchester/diff_manchester/miller/pwm —— 每种协议要哪些参数先调 la_decoders 看）、显示/隐藏通道、选中某一路、移动视图窗口、放/清光标。改完界面立刻生效。",
        json!({"type":"object","properties":{
            "sampleRate":{"type":"number"},
            "decoders":{"type":"array","description":"整份替换，参数名按 la_decoders：uart {kind,ch,baud,dataBits,parity,stop,polarity}；spi {kind,clk,mosi,miso,cs,mode,order,wordSize}；i2c {kind,scl,sda}；can {kind,ch,bitrate}；dht {kind,ch,model}；modbus {kind,ch,baud}；lin {kind,ch,baud}…",
                "items":{"type":"object","properties":{"kind":{"type":"string","enum":["uart","spi"]},"ch":{"type":"integer"},"baud":{"type":"integer"},"cs":{"type":"integer"},"clk":{"type":"integer"},"mosi":{"type":"integer"}},"required":["kind"]}},
            "channels":{"type":"array","description":"通道显隐","items":{"type":"object","properties":{"i":{"type":"integer"},"on":{"type":"boolean"}}}},
            "select":{"type":"integer","description":"选中哪一路（测量就是它）"},
            "view":{"type":"object","description":"单位秒","properties":{"t0":{"type":"number"},"span":{"type":"number"}}},
            "cursors":{"type":"object","description":"单位秒；a/b 给 null 表示清掉","properties":{"a":{"type":"number"},"b":{"type":"number"}}}
        }}), true);
    push("la_capture", "**开始一次采集**。source=demo 载入内置示例场景（scenario 可选：bus = 常用总线 UART/PWM/I2C/SPI/DS18B20/NEC；more = 调试与音频 CAN/JTAG/I2S/PS2；enc = 编码与工业总线 Manchester/DHT/LIN/Modbus/SWD/DMX；不给就用第一个，场景 id 也能从 la_decoders 拿）；source=device 用接在机器上的真机采一段（sigrok-cli / fx2lafw 这类；device 不填就用当前选中的那台，rate 默认 1 MHz，samples 默认 200000）。",
        json!({"type":"object","properties":{
            "source":{"type":"string","enum":["demo","device"],"description":"默认 demo"},
            "scenario":{"type":"string","description":"示例场景 id，见 la_decoders"},
            "device":{"type":"string","description":"sigrok 设备 id（不填 = 当前选中的）"},
            "rate":{"type":"integer","description":"采样率 Hz，默认 1000000"},
            "samples":{"type":"integer","description":"采样点数，默认 200000"},
            "channels":{"type":"array","items":{"type":"string"},"description":"通道名，如 [\"D0\",\"D1\"]；不填 = 当前勾选的"}
        }}), true);
    push("la_save", "把当前逻辑分析仪的数据**存成文件**（要 path）。format=csv（time + 各通道）或 vcd（PulseView / DSView / GTKWave 能打开）；超过 20 万点只存前 20 万。",
        json!({"type":"object","properties":{
            "path":{"type":"string"},
            "format":{"type":"string","enum":["csv","vcd"]}
        },"required":["path"]}), true);
    push(
        "runtime_graph_analyze",
        "分析一份 ELF/PE/AXF/OUT/BIN 固件的运行结构，结果同时缓存给 Agent 查询。scope=all 返回全固件函数与调用边；runtime 返回 main/中断运行链。BIN 必须给 base（如 0x08000000）和 arch（默认 ARMCortexM）。只读，不上传文件。",
        json!({"type":"object","properties":{
            "path":{"type":"string","description":"本机固件绝对路径"},
            "scope":{"type":"string","enum":["all","runtime"],"description":"默认 all"},
            "base":{"type":"string","description":"裸机 BIN 加载基址，如 0x08000000"},
            "arch":{"type":"string","description":"裸机 BIN 架构，默认 ARMCortexM"},
            "entry":{"type":"string","description":"裸机 BIN 入口地址，可选"},
            "vector_base":{"type":"string","description":"Cortex-M 向量表基址，可选"}
        },"required":["path"]}),
        false,
    );
    push(
        "runtime_graph_query",
        "查询最近一次 runtime_graph_analyze 的函数图。按函数名或地址查匹配节点，返回大小、基本块、被调用者 calls、调用者 callers 和调用点地址。用于回答“谁调用了这个函数”“这个中断往下走到哪”等。",
        json!({"type":"object","properties":{
            "query":{"type":"string","description":"函数名的一部分或地址，如 HAL_UART_Transmit / 0x80549fd"},
            "limit":{"type":"integer","description":"最多返回几个匹配，默认 8，最多 50"}
        },"required":["query"]}),
        false,
    );
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
    push(
        "flow_delete",
        "从画布上删掉一个节点或一条连线（id 传节点 id 或连线 key 都行；开始节点不能删）。",
        json!({"type":"object","properties":{
            "id":{"type":"string","description":"节点 id 或连线 key"}
        },"required":["id"]}),
        true,
    );
    push("flow_set", "把一份编排**整体导入画布**（**会替换掉当前画布上原有的东西**并保存，用户在界面上直接能看到/编辑/运行）。格式：{nodes:[{id,type,x,y,...该类型的参数}],edges:[{from:'节点id',port:'输出端口名',to:'节点id'}]}；不认识的类型和悬空连线会被自动丢掉并在返回值里说明。会动用户的画布，所以要先说清楚你要导入什么。",
        json!({"type":"object","properties":{
            "graph":{"type":"object","description":"{nodes:[…],edges:[…]}"}
        },"required":["graph"]}), true);
    push(
        "flow_status",
        "看中控编排跑到哪了／日志尾巴。",
        json!({"type":"object","properties":{}}),
        true,
    );
    push(
        "flow_stop",
        "停掉正在跑的中控编排。",
        json!({"type":"object","properties":{}}),
        true,
    );
    push(
        "capture_save",
        "抓一张屏幕（存到工作区）。",
        json!({"type":"object","properties":{
            "monitor":{"type":"integer","description":"显示器序号，默认 0"},
            "save_as":{"type":"string","description":"相对工作区的文件名，默认 shot.png"}
        }}),
        true,
    );

    // ── 环境配置（左导航「环境 → 环境配置」那一页）：扫描只读，安装要审批 ──
    push("env_scan", "扫描本机已有的**驱动与工具链**（只读）：CH34x / CH340 串口驱动、FTDI FT2232 / D2XX、Infineon TriBoard / DAS JDS、SEGGER J-Link / J-Link OB、CMSIS-DAP / DAPLink、GNU Arm Embedded Toolchain、OpenOCD、逻辑分析仪（PulseView / sigrok）、RT-Thread Env、ST-Link 驱动、Zadig。每项给：装没装、版本（有的才知道）、路径或命中的驱动/注册项。缺哪些**必需项**也一并回。跟环境配置页看到的是同一份数据。",
        json!({"type":"object","properties":{
            "force":{"type":"boolean","description":"true = 丢掉 15 分钟缓存重新扫"}
        }}), true);
    push("env_install", "装 / 更新环境配置里的某一项（**会真的下载并安装，可能弹一次 UAC**，所以要先说清楚你要装什么、装到哪）。id 取自 env_scan 的返回，例如 ch34x / ft2232 / infineon_das / jlink / jlink_probe / cmsis_dap_probe / armgcc / openocd / pulseview / rtthread_env / stlink / zadig。装的时候界面会自动切到环境配置页、进度和日志都在那儿，用户全程看得见。优先用内置安装包（<exe 同目录>\\drivers\\<id>\\），没有才走 winget / git clone / 下载安装器。",
        json!({"type":"object","properties":{
            "id":{"type":"string","description":"组件 id，取自 env_scan"},
            "dir":{"type":"string","description":"便携类（工具链 / git 仓库）的安装目录；留空就用环境配置页里设置的那个"}
        },"required":["id"]}), true);

    // ── 安卓（ADB）：agent 直接用，不必再靠 local_run 全盘找 adb.exe ──
    push(
        "adb_devices",
        "列安卓设备（USB 直连 + 已经连上的无线调试）。想用安卓做什么，先看这个。",
        json!({"type":"object","properties":{}}),
        false,
    );
    push("adb_mdns", "列无线调试的广播（Android 11+ 的 `adb mdns services`）：配对之前先看设备叫什么、在哪个 IP:端口。",
        json!({"type":"object","properties":{}}), false);
    push("adb_connect", "连一台无线调试设备（`adb connect`）。前提是设备上已经打开「开发者选项 → 无线调试」，并且已经配对过。",
        json!({"type":"object","properties":{
            "host":{"type":"string","description":"设备 IP，也可以直接给 IP:端口"},
            "port":{"type":"string","description":"端口，默认 5555（Android 11+ 的无线调试端口是设备上显示的随机端口，要用它）"}
        },"required":["host"]}), false);
    push("adb_pair", "配对新设备（Android 11+ 的「使用配对码配对设备」）：要填设备上显示的 IP:端口 + 6 位配对码。配对成功后还要 adb_connect 到它「无线调试」页面上显示的那个端口。",
        json!({"type":"object","properties":{
            "host":{"type":"string"},
            "port":{"type":"string","description":"配对端口（设备上「使用配对码配对设备」弹窗里那个）"},
            "code":{"type":"string","description":"6 位配对码"}
        },"required":["host","port","code"]}), false);
    push("adb_shell", "在安卓设备上跑一条 shell 命令（getprop / dumpsys / pm list packages / ls /sdcard / screencap …），返回退出码和输出。serial 从 adb_devices 拿。",
        json!({"type":"object","properties":{
            "serial":{"type":"string","description":"设备序列号（adb_devices 里的 serial）"},
            "cmd":{"type":"string"},
            "timeout_ms":{"type":"integer","description":"默认 20000"}
        },"required":["serial","cmd"]}), false);
    push(
        "adb_screenshot",
        "给安卓设备截屏（走 adb exec-out screencap）并存成 PNG，默认存到这个会话的工作区。",
        json!({"type":"object","properties":{
            "serial":{"type":"string"},
            "save_as":{"type":"string","description":"相对工作区的文件名，默认 adb_shot_<时间>.png"}
        },"required":["serial"]}),
        false,
    );
    push(
        "adb_push",
        "本机文件 → 安卓设备。",
        json!({"type":"object","properties":{
            "serial":{"type":"string"},
            "local":{"type":"string","description":"本机路径（相对工作区也行）"},
            "remote":{"type":"string","description":"设备上的目标路径"}
        },"required":["serial","local","remote"]}),
        false,
    );
    push(
        "adb_pull",
        "安卓设备上的文件 → 本机（默认存到这个会话的工作区）。",
        json!({"type":"object","properties":{
            "serial":{"type":"string"},
            "remote":{"type":"string"},
            "save_as":{"type":"string","description":"相对工作区的保存名"}
        },"required":["serial","remote"]}),
        false,
    );
    push(
        "adb_install",
        "给安卓设备装 APK（reinstall=true 就是覆盖安装）。",
        json!({"type":"object","properties":{
            "serial":{"type":"string"},
            "apk":{"type":"string","description":"本机 APK 路径"},
            "reinstall":{"type":"boolean","description":"默认 true"}
        },"required":["serial","apk"]}),
        false,
    );

    // ── 屏幕（本机桌面 / VNC / RTSP / RTMP / H.264）：一条真正能用的"看屏 + 操作"通道 ──
    push("screen_open", "开一路屏幕会话，拿 session id。kind=vnc 时能**被控制端回传鼠标键盘**（screen_pointer / screen_key / screen_type）；kind=desktop/rtsp/rtmp/h264 只能看（rtsp/rtmp/h264 的 width/height 是解码画布尺寸，不是源分辨率）。会话一直活着，不用了记得 screen_close。",
        json!({"type":"object","properties":{
            "kind":{"type":"string","enum":["vnc","desktop","rtsp","rtmp","h264"],"description":"默认 vnc"},
            "host":{"type":"string","description":"vnc 的服务器地址"},
            "port":{"type":"integer","description":"vnc 端口，默认 5900"},
            "password":{"type":"string","description":"vnc 密码（没设就留空）"},
            "url":{"type":"string","description":"rtsp://… / rtmp://… / 本地 .h264 路径"},
            "monitor":{"type":"integer","description":"kind=desktop 时的显示器序号，默认 0"},
            "fps":{"type":"integer","description":"默认 8，最高 60"},
            "quality":{"type":"integer","description":"JPEG 画质 20-95，默认 70"},
            "scale":{"type":"number","description":"缩放，1=原始；0.5 省带宽"},
            "transport":{"type":"string","enum":["tcp","udp","auto"],"description":"RTSP 传输方式，默认 tcp"},
            "width":{"type":"integer","description":"RTSP/RTMP/H.264 解码后的宽度，默认 1280"},
            "height":{"type":"integer","description":"RTSP/RTMP/H.264 解码后的高度，默认 720"},
            "view_only":{"type":"boolean","description":"true = 只看不动（VNC）"}
        }}), false);
    push(
        "screen_list",
        "列当前活着的屏幕会话（id / 类型 / 标签）。",
        json!({"type":"object","properties":{}}),
        false,
    );
    push("screen_shot", "把某一路屏幕会话的**当前画面**存成 PNG（默认存工作区），返回值里带一张粗字符画：@ = 亮/白、空格 = 暗/黑。字符画只能看版面（窗口在哪、画面有没有变），**读不了文字**；要读文字用 screen_ocr 或视觉模型。",
        json!({"type":"object","properties":{
            "session":{"type":"integer","description":"screen_open 返回的 id"},
            "save_as":{"type":"string","description":"相对工作区的文件名，默认 shot_<时间>.png"}
        },"required":["session"]}), false);
    push("screen_ocr", "对当前屏幕截图跑 Windows 自带 OCR，返回识别出的文字（需要系统 OCR 语言包）。比 screen_shot 的字符画多一层“读字”能力；它不替代视觉模型。",
        json!({"type":"object","properties":{
            "session":{"type":"integer","description":"screen_open 返回的 id"},
            "save_as":{"type":"string","description":"相对工作区的 PNG 文件名，默认 ocr_<时间>.png"}
        },"required":["session"]}), false);
    push("image_ocr", "对工作区里的一张图片（PNG/JPG）跑 Windows 自带 OCR，返回文字。可以先把截图/图片放到工作区再调用。",
        json!({"type":"object","properties":{
            "path":{"type":"string","description":"相对工作区的图片路径"}
        },"required":["path"]}), false);
    push("screen_pointer", "把对方屏幕上的鼠标移到 (x,y)；click=true 就点一下左键。**会真的操作对方机器**，只在 kind=vnc 的会话上有效。",
        json!({"type":"object","properties":{
            "session":{"type":"integer"},
            "x":{"type":"integer"},
            "y":{"type":"integer"},
            "click":{"type":"boolean","description":"默认 false（只移动）"},
            "button":{"type":"string","enum":["left","middle","right"],"description":"默认 left"}
        },"required":["session","x","y"]}), false);
    push("screen_key", "按一个键：enter / tab / esc / backspace / delete / space / up / down / left / right / home / end / pgup / pgdn / insert / f1…f12 / ctrl / shift / alt / 单个字符。不给 down 就是「按一下」（按下+抬起）。**会真的敲到对方机器上**（VNC）。",
        json!({"type":"object","properties":{
            "session":{"type":"integer"},
            "key":{"type":"string"},
            "down":{"type":"boolean","description":"true=只按下，false=只抬起；不给=按一下"}
        },"required":["session","key"]}), false);
    push("screen_type", "把一段文字逐字敲进对方屏幕（VNC；大小写按原样，回车用 screen_key enter）。**会真的敲到对方机器上**。",
        json!({"type":"object","properties":{
            "session":{"type":"integer"},
            "text":{"type":"string"}
        },"required":["session","text"]}), false);
    push(
        "screen_close",
        "关掉一路屏幕会话（不给 session 就全关）。",
        json!({"type":"object","properties":{"session":{"type":"integer"}}}),
        false,
    );

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

pub fn is_known(name: &str) -> bool {
    catalog().iter().any(|d| d.name == name)
}
pub fn is_host(name: &str) -> bool {
    catalog().iter().any(|d| d.name == name && d.host)
}

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
    /// 用户在这次会话里点过「本会话都允许」的工具：这些直接放行，不再弹审批
    pub allowed: &'a dyn Fn(&str, &Value) -> bool,
    /// host 工具：发事件给前端并等结果
    pub host: &'a dyn Fn(&str, &Value, u64) -> Result<String, String>,
    /// 进度日志
    pub log: &'a dyn Fn(&str),
}

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
}
fn arg_u64(args: &Value, key: &str, default: u64) -> u64 {
    args.get(key).and_then(|v| v.as_u64()).unwrap_or(default)
}
fn arg_u16(args: &Value, key: &str) -> Option<u16> {
    args.get(key).and_then(|v| v.as_u64()).map(|v| v as u16)
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
                c.get("scale")
                    .and_then(|x| x.as_f64())
                    .map(|x| fmt_num(x, "V"))
                    .unwrap_or_else(|| "?".into()),
                c.get("offset")
                    .and_then(|x| x.as_f64())
                    .map(|x| format!("{x:.3} V"))
                    .unwrap_or_else(|| "?".into()),
                c.get("coupling").and_then(|x| x.as_str()).unwrap_or("?"),
                c.get("probe")
                    .and_then(|x| x.as_f64())
                    .map(|x| format!("{x:.0}"))
                    .unwrap_or_else(|| "?".into()),
            ));
        }
    }
    let tb = v.get("timebase").and_then(|x| x.as_f64());
    let sr = v.get("sample_rate").and_then(|x| x.as_f64());
    s.push_str(&format!(
        "时基：{}\n采样率：{}\n",
        tb.map(fmt_time).unwrap_or_else(|| "?".into()),
        sr.map(|x| format!("{} Sa/s", fmt_num(x, "")))
            .unwrap_or_else(|| "?".into()),
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
        t.get("level")
            .and_then(|x| x.as_f64())
            .map(|x| format!("{x:.3} V"))
            .unwrap_or_else(|| "?".into()),
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
            grid[r][c] = if r1 == r2 {
                '-'
            } else if r == r1 {
                '\''
            } else if r == r2 {
                '.'
            } else {
                '|'
            };
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
        out.push_str(&format!(
            "（返回时抽稀成 {} 点，每 {} 点取 1）\n",
            y.len(),
            stride
        ));
    }
    if cross >= 2 && span > 0.0 {
        let f_est = cross as f64 / span;
        // 一个周期至少要有 8 个采样点，否则这个"数穿越"的估计就是在数噪声
        let per_period = if f_est > 0.0 && xinc > 0.0 {
            (1.0 / f_est) / xinc
        } else {
            0.0
        };
        if per_period >= 8.0 {
            out.push_str(&format!(
                "按上升穿越估的频率：约 {:.4} Hz（{} 个周期）\n",
                f_est, cross
            ));
        } else {
            out.push_str(
                "（这路信号相对采样率太快，数穿越估频率不可靠 —— 要准数就用 scope_measure）\n",
            );
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
    // 判"是不是文本"**不能**用"可打印 ASCII 占比"：UTF-8 的中文一个字 3 字节、
    // 全都不在 32..127 里，一份纯中文的 markdown 会被算成二进制（实测踩过：
    // 自己的 RTT_req.md 被回成 HEX，模型只能再写脚本去转码）。
    // 正确口径：先看**整段是不是合法 UTF-8**（是 → 文本，除非含 NUL）；
    // 不是合法 UTF-8 时再看控制字符占比（GBK 这种本地编码也当文本）。
    // UTF-8 BOM：去掉 BOM，正文仍是普通文本
    if data.starts_with(&[0xEF, 0xBB, 0xBF]) {
        if let Ok(s) = std::str::from_utf8(&data[3..]) {
            if !s.contains('\u{0}') {
                return s.to_string();
            }
        }
    }
    // UTF-16 BOM
    if data.starts_with(&[0xFF, 0xFE]) || data.starts_with(&[0xFE, 0xFF]) {
        if let Some(s) = decode_utf16(data, data[0] == 0xFF) {
            return s;
        }
    }
    if let Ok(s) = std::str::from_utf8(data) {
        if !s.contains('\u{0}') {
            return s.to_string();
        }
    }
    // 无 BOM 的 UTF-16：ASCII 内容的另一半字节通常是 NUL。
    // 只在"偶数个字节 + 单侧 NUL 比例高 + 解出来控制字符很少"时才认，
    // 避免把真正的二进制（比如固件）误当文本。
    if data.len() >= 4 && data.len() % 2 == 0 {
        let even_nul = data.iter().step_by(2).filter(|b| **b == 0).count();
        let odd_nul = data.iter().skip(1).step_by(2).filter(|b| **b == 0).count();
        let units = data.len() / 2;
        if even_nul * 10 > units * 3 || odd_nul * 10 > units * 3 {
            let le = odd_nul >= even_nul;
            if let Some(s) = decode_utf16(data, le) {
                return s;
            }
        }
    }
    let ctrl = data
        .iter()
        .filter(|b| **b < 0x09 || (**b > 0x0d && **b < 0x20) || **b == 0x7f)
        .count();
    if ctrl * 100 / data.len().max(1) < 5 {
        return crate::shell::decode(data);
    }
    format!(
        "(二进制 {} 字节)\nHEX: {}",
        data.len(),
        kdock_core::hex::bytes_to_hex(data)
    )
}

/// 解 UTF-16；`le=true` 表示小端（没有 BOM 时由调用方判断）。
fn decode_utf16(data: &[u8], le: bool) -> Option<String> {
    let body = if data.starts_with(&[0xFF, 0xFE]) || data.starts_with(&[0xFE, 0xFF]) {
        &data[2..]
    } else {
        data
    };
    if body.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = body
        .chunks_exact(2)
        .map(|b| if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) })
        .collect();
    let s = String::from_utf16(&units).ok()?;
    if s.contains('\u{0}') {
        return None;
    }
    let ctrl = s
        .chars()
        .filter(|c| (*c as u32) < 0x20 && !matches!(*c, '\n' | '\r' | '\t'))
        .count();
    if ctrl * 100 / s.chars().count().max(1) >= 5 {
        return None;
    }
    Some(s)
}

/// 借用 agent 的链路跑一段（用完还回去）
fn with_conn<T>(
    ctx: &ToolCtx,
    f: impl FnOnce(&mut Conn) -> Result<T, String>,
) -> Result<T, String> {
    let link = ctx.state.link_for(ctx.session)?;
    let mut g = link.lock().map_err(|_| "link mutex".to_string())?;
    let mut conn = g.conn.take().ok_or("还没有链路，先 link_open")?;
    set_timeout(&mut conn, 6000);
    let r = f(&mut conn);
    g.conn = Some(conn);
    r
}

/// 网口那几个操作要 `Svc` 按值拿走 Conn，所以单独一个壳：拿出来 -> 包 Svc -> 用完再还
fn with_svc<T>(
    ctx: &ToolCtx,
    f: impl FnOnce(&mut upgrade::Svc) -> Result<T, String>,
) -> Result<T, String> {
    let link = ctx.state.link_for(ctx.session)?;
    let mut g = link.lock().map_err(|_| "link mutex".to_string())?;
    let conn = g.conn.take().ok_or("还没有链路，先 link_open")?;
    let mut svc = upgrade::Svc::from_conn(conn);
    let r = f(&mut svc);
    let back = svc.into_conn();
    g.conn = Some(back);
    r
}

/// 当前是不是串口链路
fn is_serial(ctx: &ToolCtx) -> bool {
    ctx.state
        .link_for(ctx.session)
        .ok()
        .and_then(|l| l.lock().ok().map(|g| g.mode == "serial"))
        .unwrap_or(false)
}

fn cached_read(
    ctx: &ToolCtx,
    tool: &str,
    args: &Value,
    f: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    if let Some(v) = ctx.state.cache_get(ctx.session, tool, args) {
        return Ok(format!("（缓存命中，未重复执行）\n{v}"));
    }
    let out = f()?;
    ctx.state.cache_put(ctx.session, tool, args, &out);
    Ok(out)
}

fn plan_write(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let items = args
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or("items 必须是数组")?;
    for (i, it) in items.iter().enumerate() {
        let title = it.get("title").and_then(|v| v.as_str()).unwrap_or("").trim();
        if title.is_empty() {
            return Err(format!("第 {} 项缺 title", i + 1));
        }
        let status = it.get("status").and_then(|v| v.as_str()).unwrap_or("");
        if !matches!(status, "pending" | "in_progress" | "completed") {
            return Err(format!("第 {} 项 status 必须是 pending / in_progress / completed", i + 1));
        }
    }
    let mut meta = store::session_meta_of(ctx.app, ctx.session).ok_or("找不到会话")?;
    meta.plan = items.clone();
    meta.updated = crate::now_ms();
    store::session_update_meta(ctx.app, &meta)?;
    let _ = ctx.app.emit(
        "agent://plan",
        json!({ "session": ctx.session, "items": items }),
    );
    Ok(format!(
        "计划已更新（{} 项）：\n{}",
        items.len(),
        format_plan(items)
    ))
}

fn plan_read(ctx: &ToolCtx) -> Result<String, String> {
    let meta = store::session_meta_of(ctx.app, ctx.session).ok_or("找不到会话")?;
    if meta.plan.is_empty() {
        return Ok("（当前没有计划）".into());
    }
    Ok(format_plan(&meta.plan))
}

fn format_plan(items: &[Value]) -> String {
    let mut out = Vec::new();
    for (i, it) in items.iter().enumerate() {
        let status = it.get("status").and_then(|v| v.as_str()).unwrap_or("pending");
        let mark = match status {
            "completed" => "✓",
            "in_progress" => "▶",
            _ => "○",
        };
        let id = it.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let title = it.get("title").and_then(|v| v.as_str()).unwrap_or("");
        out.push(format!(
            "{mark} {}{}  {}",
            if id.is_empty() { String::new() } else { format!("[{id}] ") },
            title,
            status
        ));
        let _ = i;
    }
    out.join("\n")
}

fn subagent_spawn(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let task = arg_str(args, "task").ok_or("缺少 task")?;
    let parent = store::session_meta_of(ctx.app, ctx.session).ok_or("找不到当前会话")?;
    let title = arg_str(args, "title")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            let head: String = task.chars().take(24).collect();
            format!("子任务：{head}")
        });
    let provider = arg_str(args, "provider_id").or_else(|| {
        if parent.provider_id.trim().is_empty() {
            None
        } else {
            Some(parent.provider_id.clone())
        }
    });
    let sub = crate::agent::agent_session_new(
        ctx.app.clone(),
        Some(title),
        provider,
        Some(parent.ws.clone()),
    )?;
    if let Some(mut m) = store::session_meta_of(ctx.app, &sub.id) {
        // 子会话继承父会话权限；父会话是 auto 时子会话也自动，避免后台任务卡在没人看的审批上。
        m.perm = parent.perm.clone();
        let _ = store::session_update_meta(ctx.app, &m);
    }
    crate::agent::agent_send(ctx.app.clone(), sub.id.clone(), task, None)?;
    Ok(format!(
        "已启动子会话 {}（{}）。用 subagent_wait 等它完成，或 subagent_result 查看。",
        sub.id, sub.title
    ))
}

fn subagent_wait(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let sid = arg_str(args, "session").ok_or("缺少 session")?;
    let timeout = arg_u64(args, "timeout_ms", 120_000).min(600_000);
    let start = Instant::now();
    while ctx.state.running(Some(&sid)) {
        if start.elapsed().as_millis() as u64 > timeout {
            return Ok(format!("子会话 {sid} 还在跑（已等 {timeout} ms，未超时结束）"));
        }
        if crate::agent::stop_requested() {
            return Err("父会话被停止，子会话仍在后台跑（可用 subagent_result 查看）".into());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    subagent_result(ctx, args)
}

fn subagent_result(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let sid = arg_str(args, "session").ok_or("缺少 session")?;
    let meta = store::session_meta_of(ctx.app, &sid).ok_or("找不到这个子会话")?;
    let events = store::session_read(ctx.app, &sid);
    let answer = events
        .iter()
        .rev()
        .find_map(|e| match e {
            store::Event::Assistant { text, .. } if !text.trim().is_empty() => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_else(|| "（还没有最终回复）".into());
    let calls: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            store::Event::ToolCall { name, .. } => Some(name.clone()),
            _ => None,
        })
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Ok(format!(
        "子会话：{}（{}）\n标题：{}\n状态：{}\n工具调用（最近）：{}\n--- 最终回复 ---\n{}",
        sid,
        meta.model,
        meta.title,
        if ctx.state.running(Some(&sid)) { "运行中" } else { "已结束" },
        if calls.is_empty() { "（无）".into() } else { calls.join(", ") },
        answer.chars().take(6000).collect::<String>()
    ))
}

fn parallel_safe(name: &str) -> bool {
    matches!(
        name,
        "workspace_read"
            | "workspace_list"
            | "workspace_search"
            | "workspace_diff"
            | "output_read"
            | "port_list"
            | "port_state"
            | "port_read"
            | "net_local_ips"
            | "adb_devices"
            | "adb_mdns"
            | "screen_list"
            | "skill_list"
            | "history_search"
    )
}

fn parallel_read(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let ops = args
        .get("ops")
        .and_then(|v| v.as_array())
        .ok_or("ops 必须是数组")?;
    if ops.is_empty() {
        return Err("ops 不能为空".into());
    }
    if ops.len() > 8 {
        return Err("一次最多并行 8 个只读工具".into());
    }
    let mut parsed: Vec<(String, Value)> = Vec::new();
    for op in ops {
        let name = op.get("tool").and_then(|v| v.as_str()).unwrap_or("");
        if !parallel_safe(name) {
            return Err(format!("{name} 不是 parallel_read 允许的只读工具"));
        }
        parsed.push((name.to_string(), op.get("args").cloned().unwrap_or_else(|| json!({}))));
    }
    let results: Vec<Result<String, String>> = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for (name, op_args) in parsed.iter() {
            let name = name.clone();
            let op_args = op_args.clone();
            let app = ctx.app.clone();
            let ws = ctx.workspace.clone();
            let sid = ctx.session.to_string();
            handles.push(scope.spawn(move || {
                let approve = |_: &str, _: &Value| Err("parallel_read 不执行危险工具".to_string());
                let allowed = |_: &str, _: &Value| true;
                let host = |_: &str, _: &Value, _: u64| {
                    Err("parallel_read 不执行 host 工具".to_string())
                };
                let log = |_: &str| {};
                let st = app.state::<std::sync::Arc<super::AgentState>>().inner().clone();
                let tctx = ToolCtx {
                    app: &app,
                    state: &st,
                    workspace: ws,
                    session: &sid,
                    perm: "read",
                    approve: &approve,
                    allowed: &allowed,
                    host: &host,
                    log: &log,
                };
                execute(&tctx, &name, &op_args)
            }));
        }
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_else(|_| Err("并行任务线程 panic".into())))
            .collect()
    });
    let mut out = Vec::new();
    for (i, (res, (name, _))) in results.into_iter().zip(parsed.iter()).enumerate() {
        match res {
            Ok(t) => out.push(format!("## {} ({name})\n{}", i + 1, t)),
            Err(e) => out.push(format!("## {} ({name}) 失败\n{e}", i + 1)),
        }
    }
    Ok(out.join("\n\n"))
}

/// 会改设备/改盘上东西的工具：权限管的就是这些
#[cfg(test)]
mod tests {
    use super::*;

    /// 中文纯文本**不能**被当成二进制（实测踩过：自己的 RTT_req.md 读回来是 HEX）
    #[test]
    fn chinese_text_is_text_not_binary() {
        let s = "# 服务器端 agent 需要完成的事项\n中文说明：这是一份纯文本，含标点。\n";
        assert_eq!(text_and_hex(s.as_bytes()), s, "UTF-8 中文文本应原样返回");
        // GBK 的中文（不是合法 UTF-8）也按文本处理
        let gbk = [0xD6u8, 0xD0, 0xCE, 0xC4, b'\n'];
        assert_eq!(text_and_hex(&gbk), "中文\n", "GBK 文本应按本机代码页解出来");
        // 真二进制还是给 HEX
        let bin = [0x00u8, 0x01, 0x02, 0x00, 0x03, 0x00, 0xff, 0xfe];
        assert!(
            text_and_hex(&bin).starts_with("(二进制"),
            "含 NUL 的按二进制走"
        );
    }

    #[test]
    fn utf16_verilog_is_text_not_binary() {
        let src = "module top;\n  wire a;\nendmodule\n";
        let mut le = vec![0xFF, 0xFE];
        for u in src.encode_utf16() {
            le.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(text_and_hex(&le), src, "UTF-16LE BOM 应显示为文本");

        let mut be = vec![0xFE, 0xFF];
        for u in src.encode_utf16() {
            be.extend_from_slice(&u.to_be_bytes());
        }
        assert_eq!(text_and_hex(&be), src, "UTF-16BE BOM 应显示为文本");

        let mut plain = Vec::new();
        for u in src.encode_utf16() {
            plain.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(text_and_hex(&plain), src, "无 BOM UTF-16LE 也应识别");
    }

    #[test]
    fn truncate_chars_never_slices_utf8_in_the_middle() {
        let s = "中文输出".repeat(100);
        let got = truncate_chars(s, 5);
        assert!(got.starts_with("中文输出中"));
        assert!(got.contains("已截"));
        assert_eq!(truncate_chars("短".into(), 5), "短");
    }

    #[test]
    fn background_shell_quote_is_safe_for_quotes_and_spaces() {
        assert_eq!(shell_quote_posix("echo hello world"), "'echo hello world'");
        assert_eq!(shell_quote_posix("echo it's ok"), "'echo it'\\''s ok'");
    }

    #[test]
    fn unified_diff_marks_removed_and_added_lines() {
        let d = unified_diff("src/a.rs", "one\ntwo\nthree\n", "one\nTWO\nthree\n");
        assert!(d.contains("--- a/src/a.rs"));
        assert!(d.contains("+++ b/src/a.rs"));
        assert!(d.contains("-two"));
        assert!(d.contains("+TWO"));
    }

    #[test]
    fn workspace_search_finds_files_and_skips_noise_dirs() {
        let d = std::env::temp_dir().join(format!("kdock-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::create_dir_all(d.join("target")).unwrap();
        std::fs::write(d.join("src/main.rs"), "fn main() { let needle = 1; }\n").unwrap();
        std::fs::write(d.join("target/noise.rs"), "needle in target\n").unwrap();
        let mut hits = Vec::new();
        search_dir(&d, &d, "needle", Some(".rs"), false, 50, 0, &mut hits);
        assert!(hits.iter().any(|h| h.starts_with("src/main.rs:")));
        assert!(!hits.iter().any(|h| h.contains("target/")));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn test_command_autodetection_covers_cargo_npm_pytest() {
        let d = std::env::temp_dir().join(format!("kdock-testcmd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(detect_test_cmd(&d), None);
        std::fs::write(d.join("Cargo.toml"), "[package]\nname='x'\n").unwrap();
        assert_eq!(detect_test_cmd(&d).as_deref(), Some("cargo test"));
        std::fs::remove_file(d.join("Cargo.toml")).unwrap();
        std::fs::write(d.join("package.json"), r#"{"scripts":{"test":"vitest"}}"#).unwrap();
        assert_eq!(detect_test_cmd(&d).as_deref(), Some("npm test"));
        std::fs::remove_file(d.join("package.json")).unwrap();
        std::fs::write(d.join("pytest.ini"), "[pytest]\n").unwrap();
        assert_eq!(detect_test_cmd(&d).as_deref(), Some("python -m pytest"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn parallel_read_only_accepts_read_tools() {
        assert!(parallel_safe("workspace_read"));
        assert!(parallel_safe("workspace_search"));
        assert!(parallel_safe("output_read"));
        assert!(!parallel_safe("local_run"));
        assert!(!parallel_safe("workspace_edit"));
        assert!(!parallel_safe("screen_pointer"));
    }

    #[test]
    fn planning_workspace_and_subagent_tools_are_registered() {
        let names: Vec<&str> = catalog().iter().map(|d| d.name).collect();
        for n in [
            "workspace_edit",
            "workspace_diff",
            "workspace_search",
            "workspace_run",
            "workspace_test",
            "workspace_context",
            "workspace_check",
            "plan_write",
            "plan_read",
            "subagent_spawn",
            "subagent_wait",
            "subagent_result",
            "parallel_read",
            "screen_ocr",
            "image_ocr",
        ] {
            assert!(names.contains(&n), "缺工具 {n}");
        }
        assert!(is_dangerous("workspace_run"));
        assert!(is_dangerous("workspace_test"));
        assert!(is_dangerous("workspace_check"));
        assert!(is_dangerous("subagent_spawn"));
        for n in ["workspace_edit", "workspace_search", "plan_write", "parallel_read", "screen_ocr"] {
            assert!(!is_dangerous(n), "{n} 不该要审批");
        }
    }

    /// 逻辑分析仪工具：注册齐全，读类不审批、写类审批
    #[test]
    fn logic_tools_are_registered_and_gated() {
        let names: Vec<&str> = catalog().iter().map(|d| d.name).collect();
        for n in [
            "la_state",
            "la_read",
            "la_decoders",
            "la_config",
            "la_capture",
            "la_save",
        ] {
            assert!(names.contains(&n), "缺工具 {n}");
        }
        assert!(
            !is_dangerous("la_state") && !is_dangerous("la_read") && !is_dangerous("la_decoders")
        );
        assert!(is_dangerous("la_config") && is_dangerous("la_capture") && is_dangerous("la_save"));
        // 都是 host 工具（活在前端）
        for n in [
            "la_state",
            "la_read",
            "la_decoders",
            "la_config",
            "la_capture",
            "la_save",
        ] {
            assert!(is_host(n), "{n} 应该是 host 工具");
        }
        // la_config 的参数名要齐全（agent 靠它知道能改什么）
        let d = catalog()
            .into_iter()
            .find(|d| d.name == "la_config")
            .unwrap();
        let props = d.schema["properties"].as_object().unwrap();
        for k in [
            "sampleRate",
            "decoders",
            "channels",
            "select",
            "view",
            "cursors",
        ] {
            assert!(props.contains_key(k), "la_config 缺参数 {k}");
        }
    }

    #[test]
    fn runtime_graph_tools_are_registered_and_read_only() {
        let names: Vec<&str> = catalog().iter().map(|d| d.name).collect();
        for n in ["runtime_graph_analyze", "runtime_graph_query"] {
            assert!(names.contains(&n), "缺工具 {n}");
            assert!(!is_dangerous(n), "{n} 是只读工具，不应要求审批");
            assert!(!is_host(n), "{n} 应该在 Rust 侧直接执行");
        }
        let analyze = catalog()
            .into_iter()
            .find(|d| d.name == "runtime_graph_analyze")
            .unwrap();
        let props = analyze.schema["properties"].as_object().unwrap();
        for k in ["path", "scope", "base", "arch", "entry", "vector_base"] {
            assert!(props.contains_key(k), "runtime_graph_analyze 缺参数 {k}");
        }
        assert!(is_core_tool("port_open"));
        assert!(is_core_tool("workspace_read"));
        assert!(!is_core_tool("env_install"));
        assert_eq!(tool_category("runtime_graph_query"), "仪器与固件分析");
        assert_eq!(tool_category("workspace_edit"), "工作区与执行");
    }

    /// adb / screen 这组工具：注册了、该要审批的要、只读的不要、参数名别写错
    #[test]
    fn adb_and_screen_tools_are_registered_and_gated() {
        let names: Vec<&str> = catalog().iter().map(|d| d.name).collect();
        for n in [
            "adb_devices",
            "adb_mdns",
            "adb_connect",
            "adb_pair",
            "adb_shell",
            "adb_screenshot",
            "adb_push",
            "adb_pull",
            "adb_install",
        ] {
            assert!(names.contains(&n), "缺 adb 工具 {n}");
        }
        for n in [
            "screen_open",
            "screen_list",
            "screen_shot",
            "screen_ocr",
            "image_ocr",
            "screen_pointer",
            "screen_key",
            "screen_type",
            "screen_close",
        ] {
            assert!(names.contains(&n), "缺 screen 工具 {n}");
        }
        // 只读 / 无害的：不该弹审批（截图只往工作区写文件）
        for n in [
            "adb_devices",
            "adb_mdns",
            "adb_connect",
            "adb_pair",
            "adb_screenshot",
            "adb_pull",
            "screen_open",
            "screen_list",
            "screen_shot",
            "screen_close",
        ] {
            assert!(!is_dangerous(n), "{n} 不该要审批");
        }
        // 会改设备 / 会操作对方机器的：必须审批
        for n in [
            "adb_shell",
            "adb_push",
            "adb_install",
            "screen_pointer",
            "screen_key",
            "screen_type",
        ] {
            assert!(is_dangerous(n), "{n} 必须审批");
        }
        // 全是 Rust 侧实现（host 工具要前端配合，这组不能标 host）
        for n in [
            "adb_devices",
            "adb_shell",
            "screen_open",
            "screen_shot",
            "screen_pointer",
        ] {
            assert!(!is_host(n), "{n} 不该是 host 工具");
        }
        // 参数名最容易写错的两个
        let sh = catalog()
            .into_iter()
            .find(|d| d.name == "adb_shell")
            .unwrap();
        for k in ["serial", "cmd", "timeout_ms"] {
            assert!(
                sh.schema["properties"].as_object().unwrap().contains_key(k),
                "adb_shell 缺参数 {k}"
            );
        }
        let so = catalog()
            .into_iter()
            .find(|d| d.name == "screen_open")
            .unwrap();
        for k in [
            "kind",
            "host",
            "port",
            "password",
            "fps",
            "quality",
            "scale",
            "view_only",
            "transport",
            "width",
            "height",
        ] {
            assert!(
                so.schema["properties"].as_object().unwrap().contains_key(k),
                "screen_open 缺参数 {k}"
            );
        }
    }

    /// 键名表：常用键都要认得；单个字符按 Unicode → keysym；十六进制也认
    #[test]
    fn keysym_table_covers_common_keys() {
        assert_eq!(keysym_of("enter"), Some(0xff0d));
        assert_eq!(keysym_of("Enter"), Some(0xff0d));
        assert_eq!(keysym_of("esc"), Some(0xff1b));
        assert_eq!(keysym_of("F5"), Some(0xffbe + 4));
        assert_eq!(keysym_of("a"), Some(b'a' as u32));
        assert_eq!(keysym_of("中"), Some('中' as u32));
        assert_eq!(keysym_of("0xff0d"), Some(0xff0d));
        assert_eq!(keysym_of(" "), Some(0x20), "空格不能被 trim 掉");
        assert_eq!(keysym_of("a"), Some(0x61));
        assert_eq!(keysym_of("nosuchkey"), None);
    }

    /// local_run 的 PATH 前缀要把 KDock 自己装工具的目录带上（它们都在 %ENVDIR% 下）
    #[test]
    fn env_path_prefix_mentions_env_dir() {
        let p = env_path_prefix();
        assert!(
            p.contains(&crate::env_setup::env_dir()),
            "PATH 前缀里没带 %ENVDIR%：{p}"
        );
    }

    #[test]
    fn port_tools_are_registered_and_gated() {
        let names: Vec<&str> = catalog().iter().map(|d| d.name).collect();
        for n in [
            "port_list",
            "port_state",
            "port_write",
            "port_read",
            "port_open",
            "port_close",
            "net_local_ips",
        ] {
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
        let po = catalog()
            .into_iter()
            .find(|d| d.name == "port_open")
            .unwrap();
        let props = po.schema["properties"].as_object().unwrap();
        for k in [
            "mode",
            "port",
            "baud",
            "data_bits",
            "stop_bits",
            "parity",
            "flow_control",
            "host",
            "local_port",
            "remote_host",
            "remote_port",
        ] {
            assert!(props.contains_key(k), "port_open 缺参数 {k}");
        }
        assert!(po.schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "mode"));
    }

    #[test]
    fn env_tools_are_registered_and_gated() {
        let names: Vec<&str> = catalog().iter().map(|d| d.name).collect();
        for n in ["env_scan", "env_install"] {
            assert!(names.contains(&n), "缺工具 {n}");
        }
        // 扫描只读、不审批；安装会动系统、必须审批
        assert!(!is_dangerous("env_scan"));
        assert!(is_dangerous("env_install"));
        // 两个都在前端实现（装的时候要把进度画出来），所以必须是 host
        assert!(is_host("env_scan") && is_host("env_install"));
        let ins = catalog()
            .into_iter()
            .find(|d| d.name == "env_install")
            .unwrap();
        assert!(ins.schema["properties"]
            .as_object()
            .unwrap()
            .contains_key("id"));
        assert!(ins.schema["properties"]
            .as_object()
            .unwrap()
            .contains_key("dir"));
        assert!(ins.schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "id"));
    }
}

/// 设置页的工具分类。分类只影响展示与批量开关，不改变工具执行逻辑。
pub fn tool_category(name: &str) -> &'static str {
    if name.starts_with("link_") || name.starts_with("port_") || name.starts_with("ssh_") || name == "net_local_ips" {
        "通信"
    } else if name.starts_with("workspace_")
        || name.starts_with("plan_")
        || name.starts_with("subagent_")
        || name.starts_with("parallel_")
        || matches!(name, "local_run" | "output_read")
    {
        "工作区与执行"
    } else if name.starts_with("device_") || name.starts_with("firmware_") || name == "flash" {
        "设备与固件"
    } else if name.starts_with("adb_") {
        "安卓调试"
    } else if name.starts_with("scope")
        || name.starts_with("la_")
        || name.starts_with("logic_")
        || name.starts_with("runtime_graph_")
    {
        "仪器与固件分析"
    } else if name.starts_with("screen_") || name.starts_with("capture_") || name.starts_with("image_") {
        "屏幕与图像"
    } else if name.starts_with("flow_") {
        "中控编排"
    } else if name.starts_with("skill_") || name.starts_with("mcp_") || name.starts_with("env_") {
        "技能与环境"
    } else if name.starts_with("ui_") || name.starts_with("browser_") || name == "history_search" {
        "界面与上下文"
    } else {
        "其他"
    }
}

/// 这些工具是 Agent 完成基本工作的底座，设置页只能看不能关。
pub fn is_core_tool(name: &str) -> bool {
    matches!(
        name,
        "link_open"
            | "link_close"
            | "link_status"
            | "link_send"
            | "link_read"
            | "port_list"
            | "port_state"
            | "port_write"
            | "port_read"
            | "port_open"
            | "port_close"
            | "net_local_ips"
            | "workspace_list"
            | "workspace_read"
            | "workspace_write"
            | "workspace_edit"
            | "workspace_diff"
            | "workspace_search"
            | "workspace_context"
            | "output_read"
            | "skill_list"
            | "skill_read"
    )
}

pub fn is_dangerous(name: &str) -> bool {
    matches!(
        name,
        "link_send" | "device_push" | "firmware_upgrade" | "flash" | "local_run" | "workspace_run" | "workspace_test" | "workspace_check" | "subagent_spawn" | "port_write" | "flow_set" | "flow_add_node" | "flow_connect" | "flow_delete"
            | "port_open" | "port_close"
            | "ssh_run"
            | "skill_create" | "skill_update"
            | "skill_delete" | "flow_run" | "capture_save"
            | "la_config" | "la_capture" | "la_save"
            | "env_install"
            // 安卓：会改设备状态的动作。截图/取文件只是往工作区写，不拦。
            | "adb_shell" | "adb_push" | "adb_install"
            // 屏幕：**会真的操作对方机器**的输入注入
            | "screen_pointer" | "screen_key" | "screen_type"
    )
}

pub fn execute(ctx: &ToolCtx, name: &str, args: &Value) -> Result<String, String> {
    // 权限闸门：只读直接拒；需要批准就先问人
    if is_dangerous(name) || name.starts_with("mcp__") {
        if !(ctx.allowed)(name, args) {
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
                        p.friendly
                            .as_ref()
                            .map(|f| format!("  {f}"))
                            .unwrap_or_default()
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
                s.push_str(&format!(
                    "已持续：{:.1} 秒\n",
                    st.elapsed_ms as f64 / 1000.0
                ));
            }
            Ok(s)
        }
        "port_write" => {
            let _gate = ctx
                .state
                .port_gate
                .lock()
                .map_err(|_| "port gate mutex".to_string())?;
            let data = arg_str(args, "data").ok_or("缺少 data")?;
            let is_hex = args.get("hex").and_then(|v| v.as_bool()).unwrap_or(false);
            let le = arg_str(args, "line_ending").unwrap_or_else(|| "cr".to_string());
            let ack = crate::write_main(
                ctx.app,
                &data,
                if is_hex { "hex" } else { "text" },
                &le,
                false,
            )?;
            // 让用户在传输页里实时看到 agent 发出去的东西（补一条 TX 行）
            let _ = ctx.app.emit(
                "log://tx",
                json!({ "ts_ms": kdock_core::session::now_ms(),
                        "hex": ack.hex, "text": ack.text, "ascii": ack.ascii }),
            );
            Ok(format!("已发 {} 字节到主连接：{}", ack.bytes, ack.hex))
        }
        "port_read" => {
            let tail = args
                .get("tail")
                .and_then(|v| v.as_u64())
                .unwrap_or(40)
                .clamp(1, 400) as usize;
            Ok(crate::main_log_text(ctx.app, tail))
        }
        "port_open" => {
            let _gate = ctx
                .state
                .port_gate
                .lock()
                .map_err(|_| "port gate mutex".to_string())?;
            let mode = arg_str(args, "mode").ok_or("缺少 mode")?;
            let mut ep = json!({ "mode": mode });
            let sarg = |k: &str| arg_str(args, k);
            let uarg = |k: &str| args.get(k).and_then(|v| v.as_u64());
            match mode.as_str() {
                "serial" => {
                    ep["port"] =
                        json!(sarg("port")
                            .ok_or("mode=serial 需要 port（先用 port_list 看有哪些）")?);
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
                    ep["port"] =
                        json!(uarg("remote_port").ok_or("mode=tcp_client 需要 remote_port")?);
                    if let Some(local) = sarg("local_addr") {
                        ep["local_addr"] = json!(local);
                    }
                }
                "tcp_server" => {
                    ep["host"] = json!(sarg("host").unwrap_or_else(|| "0.0.0.0".into()));
                    ep["port"] = json!(uarg("local_port")
                        .ok_or("mode=tcp_server 需要 local_port（要监听的端口）")?);
                }
                "udp" => {
                    ep["local_port"] = json!(uarg("local_port").unwrap_or(0));
                    if let Some(local) = sarg("local_addr") {
                        ep["local_addr"] = json!(local);
                    }
                    ep["remote_host"] = json!(sarg("remote_host").unwrap_or_default());
                    ep["remote_port"] = json!(uarg("remote_port").unwrap_or(0));
                }
                other => {
                    return Err(format!(
                        "不认识的 mode: {other}（serial / tcp_client / tcp_server / udp）"
                    ))
                }
            }
            let endpoint: crate::transport::Endpoint =
                serde_json::from_value(ep).map_err(|e| format!("参数不对: {e}"))?;
            crate::open_main(ctx.app, endpoint, "agent")
        }
        "port_close" => {
            let _gate = ctx
                .state
                .port_gate
                .lock()
                .map_err(|_| "port gate mutex".to_string())?;
            crate::close_main(ctx.app)
        }
        "net_local_ips" => {
            let ips = crate::local_ips();
            if ips.is_empty() {
                return Ok("（没查到本机 IPv4；开服务端可以填 0.0.0.0 = 所有网卡）".into());
            }
            Ok(format!("{}\n（0.0.0.0 = 所有网卡）", ips.join("\n")))
        }
        "link_open" => link_open(ctx, args),
        "link_close" => {
            let link = ctx.state.link_for(ctx.session)?;
            let mut g = link.lock().map_err(|_| "link mutex".to_string())?;
            let had = g.conn.take();
            g.mode.clear();
            g.label.clear();
            if let Some(mut c) = had {
                c.shutdown();
            }
            Ok("链路已关闭".into())
        }
        "link_status" => {
            let link = ctx.state.link_for(ctx.session)?;
            let g = link.lock().map_err(|_| "link mutex".to_string())?;
            Ok(if g.conn.is_some() {
                format!("已连接（{}）", g.label)
            } else {
                "未连接（先 link_open）".into()
            })
        }
        "link_send" => link_send(ctx, args),
        "link_read" => link_read(ctx, args),
        "runtime_graph_analyze" => {
            let raw = arg_str(args, "path").ok_or("缺少 path")?;
            let raw_path = std::path::PathBuf::from(&raw);
            let path = if raw_path.is_absolute() {
                raw_path
            } else {
                ctx.workspace.join(raw_path)
            };
            let scope = arg_str(args, "scope").unwrap_or_else(|| "all".into());
            if scope != "all" && scope != "runtime" {
                return Err("scope 只能是 all 或 runtime".into());
            }
            crate::runtime_graph::agent_analyze(
                ctx.app,
                &path.to_string_lossy(),
                &scope,
                &arg_str(args, "base").unwrap_or_default(),
                &arg_str(args, "arch").unwrap_or_else(|| "ARMCortexM".into()),
                &arg_str(args, "entry").unwrap_or_default(),
                &arg_str(args, "vector_base").unwrap_or_default(),
            )
        }
        "runtime_graph_query" => crate::runtime_graph::agent_query(
            &arg_str(args, "query").ok_or("缺少 query")?,
            arg_u64(args, "limit", 8) as usize,
        ),
        "device_list" => device_list(ctx, args),
        "device_pull" => device_pull(ctx, args),
        "device_push" => device_push(ctx, args),
        "firmware_info" => firmware_info(args),
        "firmware_upgrade" => firmware_upgrade(ctx, args),
        "local_run" => local_run(args),
        "flash" => flash(ctx, args),
        "adb_devices" => adb_devices_text(),
        "adb_mdns" => adb_mdns_text(),
        "adb_connect" => adb_connect_text(args),
        "adb_pair" => adb_pair_text(args),
        "adb_shell" => adb_shell_text(args),
        "adb_screenshot" => adb_screenshot_text(ctx, args),
        "adb_push" => adb_push_text(ctx, args),
        "adb_pull" => adb_pull_text(ctx, args),
        "adb_install" => adb_install_text(ctx, args),
        "screen_open" => screen_open(ctx, args),
        "screen_list" => screen_list_text(ctx),
        "screen_shot" => screen_shot(ctx, args),
        "screen_ocr" => screen_ocr(ctx, args),
        "image_ocr" => image_ocr(ctx, args),
        "screen_pointer" => screen_pointer(ctx, args),
        "screen_key" => screen_key(ctx, args),
        "screen_type" => screen_type(ctx, args),
        "screen_close" => screen_close(ctx, args),
        "scope" => crate::scope::raw(&arg_str(args, "cmd").ok_or("缺少 cmd")?),
        "scope_connect" => {
            let ip = arg_str(args, "ip").unwrap_or_else(|| "192.168.1.100".into());
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
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let v = crate::scope::measure(ch, &items)?;
            Ok(scope_measure_text(&v))
        }
        "scope_waveform" => scope_wave_text(args),
        "scope_screenshot" => {
            // 不给路径就存进这个会话的工作区（用户能直接从界面打开）
            let p = arg_str(args, "path")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| ctx.workspace.join(format!("scope_{}.png", crate::now_ms())));
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
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join("、")
                })
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
        "workspace_edit" => workspace_edit(ctx, args),
        "workspace_diff" => workspace_diff(ctx, args),
        "workspace_search" => workspace_search(ctx, args),
        "workspace_run" => workspace_run(ctx, args),
        "workspace_test" => workspace_test(ctx, args),
        "workspace_context" => workspace_context(ctx, args),
        "workspace_check" => workspace_check(ctx, args),
        "output_read" => {
            let path = arg_str(args, "path").ok_or("缺少 path")?;
            let off = arg_u64(args, "offset", 0) as usize;
            let lim = arg_u64(args, "limit", 1200) as usize;
            store::tool_output_read(ctx.app, &path, off, lim)
        }
        "skill_list" => {
            // 只报**启用**的：skills_list() 会把 skills-off/ 里的也扫出来（enabled=false），
            // 那是给界面画开关用的。技能关闭 = 用户明确表示"别用它"，这里再报出来等于把开关架空。
            let list: Vec<_> = store::skills_list(ctx.app)
                .into_iter()
                .filter(|s| s.enabled)
                .collect();
            let local = store::workspace_skills(&ctx.workspace);
            let mut out = String::new();
            out.push_str("全局技能（用户级）：\n");
            if list.is_empty() {
                out.push_str("（没有）\n");
            }
            for s in list.iter() {
                out.push_str(&format!("- {} — {}\n", s.slug, s.description));
            }
            out.push_str("本项目技能（工作区 .kdock_skill，存在即生效）：\n");
            if local.is_empty() {
                out.push_str("（没有）\n");
            }
            for s in local.iter() {
                out.push_str(&format!("- {} — {}\n", s.slug, s.description));
            }
            Ok(out)
        }
        "skill_read" => store::skill_read_in(
            ctx.app,
            &ctx.workspace,
            &arg_str(args, "name").ok_or("缺少 name")?,
        ),
        "skill_create" => {
            let name = arg_str(args, "name").ok_or("缺少 name")?;
            let desc = arg_str(args, "description").ok_or("缺少 description")?;
            let body = arg_str(args, "body").unwrap_or_default();
            let scope = arg_str(args, "scope").unwrap_or_else(|| "global".into());
            let slug = store::slugify(&name);
            let content = format!("---\nname: {name}\ndescription: {desc}\n---\n\n{body}\n");
            let path = store::skill_write_in(ctx.app, &ctx.workspace, &scope, &slug, &content)?;
            Ok(format!(
                "技能已建：{slug}（{}，{path}）",
                if scope == "workspace" {
                    "本项目"
                } else {
                    "全局"
                }
            ))
        }
        "skill_update" => {
            let name = arg_str(args, "name").ok_or("缺少 name")?;
            let content = arg_str(args, "content").ok_or("缺少 content")?;
            let scope = arg_str(args, "scope").unwrap_or_else(|| "global".into());
            let path = store::skill_write_in(ctx.app, &ctx.workspace, &scope, &name, &content)?;
            Ok(format!("技能已更新：{path}"))
        }
        "skill_delete" => {
            let name = arg_str(args, "name").ok_or("缺少 name")?;
            let scope = arg_str(args, "scope").unwrap_or_else(|| "global".into());
            store::skill_delete_in(ctx.app, &ctx.workspace, &scope, &name)?;
            Ok(format!(
                "技能已删除：{name}（{}）",
                if scope == "workspace" {
                    "已归档一份到 skill-archive"
                } else {
                    "全局"
                }
            ))
        }
        "plan_write" => plan_write(ctx, args),
        "plan_read" => plan_read(ctx),
        "subagent_spawn" => subagent_spawn(ctx, args),
        "subagent_wait" => subagent_wait(ctx, args),
        "subagent_result" => subagent_result(ctx, args),
        "parallel_read" => parallel_read(ctx, args),
        "ssh_run" => ssh_run(ctx, args),
        other if other.starts_with("mcp__") => super::mcp::call_by_full_name(ctx.app, other, args),
        other if !is_known(other) => Err(format!("不认识工具 {other}")),
        other => Err(format!("工具 {other} 还没实现")),
    }
}

fn link_open(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    ssh_or_link(ctx, args)
}

/// `ssh_run`：远程跑一条命令。有密码走 plink、没密码走 ssh.exe（见 transport::ssh_run_once）
fn ssh_run(_ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let host = arg_str(args, "host").ok_or("缺少 host")?;
    let mut cmd = arg_str(args, "cmd").ok_or("缺少 cmd")?;
    let user = arg_str(args, "user").unwrap_or_default();
    let password = arg_str(args, "password").unwrap_or_default();
    let key = arg_str(args, "key").unwrap_or_default();
    let port = arg_u16(args, "port").unwrap_or(22);
    let background = args
        .get("background")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut timeout = arg_u64(args, "timeout_ms", 60_000).min(30 * 60_000);
    if background {
        // 远端后台进程如果继承 SSH 的 stdout/stderr，plink 会一直等它退出；
        // 这里用 setsid + disown 把它从会话里摘出去，并且只给启动动作 15 秒。
        cmd = format!(
            "setsid bash -c {} </dev/null >/dev/null 2>&1 & disown; echo started",
            shell_quote_posix(&cmd)
        );
        timeout = timeout.min(15_000);
    }
    let (code, text) =
        crate::transport::ssh_run_once(&host, port, &user, &password, &key, &cmd, timeout)?;
    // 只做一个内存安全上限；真正进上下文的截断由 mod.rs 的 cap_tool_result
    // 按 token 预算做（并落盘给 output_read）。这里用 chars()，避免 UTF-8
    // 输出里 6000 正好落在汉字中间时 panic。
    let tail = truncate_chars(text, 256 * 1024);
    Ok(format!("退出码 {code}\n{tail}"))
}

/// POSIX shell 单引号转义（给 background 包装用）
fn shell_quote_posix(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 按字符截断（不按字节），给外部进程输出做一个内存上限。
fn truncate_chars(text: String, max: usize) -> String {
    if text.chars().count() > max {
        let head: String = text.chars().take(max).collect();
        format!("{head}\n…（输出超过 {max} 字符，已截）")
    } else {
        text
    }
}

fn ssh_or_link(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let mode = arg_str(args, "mode").ok_or("缺少 mode")?;
    let endpoint = match mode.as_str() {
        "serial" => {
            let port = arg_str(args, "port").ok_or("串口链路要给 port，例如 COM7")?;
            let baud = arg_u64(args, "baud", 115200) as u32;
            let config: kdock_core::config::SerialConfig = serde_json::from_value(json!({
                "baud": baud, "data_bits": "eight", "stop_bits": "one",
                "parity": "none", "flow_control": "none"
            }))
            .map_err(|e| format!("串口参数不对: {e}"))?;
            crate::transport::Endpoint::Serial { port, config }
        }
        "tcp" => crate::transport::Endpoint::TcpClient {
            host: arg_str(args, "host").ok_or("TCP 链路要给 host")?,
            port: arg_u64(args, "remote_port", 6666) as u16,
            local_addr: arg_str(args, "local_addr"),
        },
        "udp" => crate::transport::Endpoint::Udp {
            local_port: arg_u64(args, "local_port", 0) as u16,
            local_addr: arg_str(args, "local_addr"),
            remote_host: arg_str(args, "host").unwrap_or_default(),
            remote_port: arg_u64(args, "remote_port", 0) as u16,
        },
        other => return Err(format!("不支持的链路类型 {other}")),
    };
    let label = endpoint.label();
    let mut conn = crate::transport::open_endpoint(&endpoint)?;
    let link = ctx.state.link_for(ctx.session)?;
    let mut g = link.lock().map_err(|_| "link mutex".to_string())?;
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
        conn.write_all(&payload)
            .map_err(|e| format!("写失败: {e}"))?;
        conn.flush().map_err(|e| format!("flush 失败: {e}"))
    })?;
    Ok(format!(
        "已发送 {} 字节（{}）",
        payload.len(),
        if hex { "HEX" } else { "文本" }
    ))
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
            Ok(format!(
                "（{}ms 内没有收到数据）",
                start.elapsed().as_millis()
            ))
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
            store::resolve_in_workspace(&ctx.workspace, &name)?
                .to_string_lossy()
                .to_string()
        }
    };
    if let Some(parent) = std::path::Path::new(&save_to).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log = ctx.log;
    let r = if is_serial(ctx) {
        with_conn(ctx, |conn| {
            upgrade::serial_pull(conn, &path, &save_to, |s| log(s))
        })?
    } else {
        with_svc(ctx, |svc| {
            upgrade::svc_pull(svc, &path, &save_to, |s| log(s))
        })?
    };
    Ok(format!(
        "已取回 {} 字节 -> {}\ncrc32={:08X}",
        r.bytes, save_to, r.crc32
    ))
}

fn device_push(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let local = arg_str(args, "local").ok_or("缺少 local")?;
    let data = std::fs::read(&local).map_err(|e| format!("读不了 {local}: {e}"))?;
    let remote = arg_str(args, "remote").unwrap_or_else(|| {
        format!(
            "/{}",
            std::path::Path::new(&local)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "up.bin".into())
        )
    });
    let log = ctx.log;
    let crc = if is_serial(ctx) {
        with_conn(ctx, |conn| {
            upgrade::serial_upload(conn, &remote, &data, |s| log(s))
        })?
    } else {
        with_svc(ctx, |svc| {
            upgrade::svc_upload(svc, &remote, &data, |s| log(s))
        })?
    };
    Ok(format!(
        "已发送 {} 字节 -> {}\ncrc32={:08X}",
        data.len(),
        remote,
        crc
    ))
}

fn firmware_info(args: &Value) -> Result<String, String> {
    let local = arg_str(args, "local").ok_or("缺少 local")?;
    let data = std::fs::read(&local).map_err(|e| format!("读不了 {local}: {e}"))?;
    let name = std::path::Path::new(&local)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let info = upgrade::parse_fw(&data, &name)?;
    Ok(format!(
        "版本 v{}\npayload {} B  crc32={:08X}\n整包 {} B  crc32={:08X}\nboard={} name={}",
        info.version,
        info.payload_size,
        info.payload_crc32,
        info.file_size,
        info.file_crc32,
        info.board,
        info.name
    ))
}

fn firmware_upgrade(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let local = arg_str(args, "local").ok_or("缺少 local")?;
    let data = std::fs::read(&local).map_err(|e| format!("读不了 {local}: {e}"))?;
    let name = std::path::Path::new(&local)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let transport = arg_str(args, "transport").unwrap_or_else(|| "auto".into());
    let use_net = match transport.as_str() {
        "net" => true,
        "serial" => false,
        _ => !is_serial(ctx),
    };
    let log = ctx.log;
    let mut lines: Vec<String> = Vec::new();
    {
        let mut log_fn = |s: &str| {
            log(s);
        };
        let mut prog_fn = |_p: f64| {};
        let mut cx = upgrade::Ctx {
            log: &mut log_fn,
            progress: &mut prog_fn,
        };
        if use_net {
            let host = arg_str(args, "host")
                .or_else(|| {
                    ctx.state
                        .link_for(ctx.session)
                        .ok()
                        .and_then(|l| l.lock().ok().map(|g| g.label.clone()))
                        .and_then(|l| {
                            l.strip_prefix("TCP ")
                                .and_then(|r| r.split(':').next().map(|s| s.to_string()))
                        })
                })
                .ok_or("网口升级要知道设备 IP：给 host，或者先 link_open 一条 TCP 链路")?;
            let port = arg_u64(args, "remote_port", 6666) as u16;
            upgrade::net_upgrade(&mut cx, &host, port, &name, &data)?;
            lines.push(format!("网口升级完成：{host}:{port}"));
        } else {
            with_conn(ctx, |conn| {
                upgrade::serial_upgrade(&mut cx, conn, &name, &data)
            })?;
            lines.push("串口升级完成".to_string());
        }
    }
    let info = upgrade::parse_fw(&data, &name)?;
    Ok(format!("{}\npayload {} B  crc32={:08X}\n设备已复位；等它起来后建议 device_list / firmware 版本确认一次。",
        lines.join("\n"), info.payload_size, info.payload_crc32))
}

/// KDock 自己装的工具（adb / scrcpy / ffmpeg / plink）在哪个目录，拼成 PATH 前缀。
/// agent 用 local_run 时看到的只是系统 PATH，以前它只能全盘搜（实测白烧好几分钟）。
fn env_path_prefix() -> String {
    let d = crate::env_setup::env_dir();
    let mut parts: Vec<String> = vec![d.clone()];
    for sub in [
        "adb",
        "scrcpy",
        "plink",
        "ffmpeg",
        "ffmpeg\\bin",
        "platform-tools",
        "JLink",
        "openocd",
    ] {
        let p = format!("{d}\\{sub}");
        if std::path::Path::new(&p).exists() {
            parts.push(p);
        }
    }
    parts.join(";")
}

fn local_run(args: &Value) -> Result<String, String> {
    let cmd = arg_str(args, "cmd").ok_or("缺少 cmd")?;
    let timeout = Duration::from_millis(arg_u64(args, "timeout_ms", 15_000));
    // 引号与输出编码统一走 shell 模块：以前 args(["/C", cmd]) 会被再包一层引号，
    // 命令里的 $_ / $env: 被外层吃掉、结尾的 D:\ 被当成转义引号，中文输出还会变乱码
    // 再把 KDock 自己的工具目录塞进 PATH 最前面 —— agent 就不用去找 adb/ffmpeg 在哪了
    let (code, stdout, stderr) = crate::shell::run_with_path(
        &cmd,
        timeout.as_millis() as u64,
        &crate::agent::stop_requested,
        &env_path_prefix(),
    )?;
    let mut text = format!("exit={code}\n");
    if !stdout.trim().is_empty() {
        text.push_str(&format!("--- stdout ---\n{}\n", stdout.trim_end()));
    }
    if !stderr.trim().is_empty() {
        text.push_str(&format!("--- stderr ---\n{}\n", stderr.trim_end()));
    }
    Ok(truncate_chars(text, 256 * 1024))
}

/* ───────────────────────── 安卓（ADB） ───────────────────────── */

fn jstr(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn adb_devices_text() -> Result<String, String> {
    let list = crate::android::adb_devices()?;
    if list.is_empty() {
        return Ok("（没有设备）\nUSB：手机要先打开「开发者选项 → USB 调试」，插线后在手机上允许这台电脑。\n无线：设备上打开「无线调试」→ adb_mdns 看广播 → adb_pair 配对 → adb_connect 连它显示的那个端口。".into());
    }
    Ok(list
        .iter()
        .map(|d| {
            let mut line = format!("{}  [{}]", jstr(d, "serial"), jstr(d, "state"));
            let model = jstr(d, "model");
            if !model.is_empty() {
                line.push_str(&format!("  {model}"));
            }
            if jstr(d, "state") != "device" {
                line.push_str("   ← 不是 device 状态，先用不了（未授权 / 离线）");
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

fn adb_mdns_text() -> Result<String, String> {
    let v = crate::android::adb_mdns()?;
    let raw = jstr(&v, "raw");
    if raw.trim().is_empty() {
        Ok("（没发现无线调试广播）\n设备上要打开「无线调试」；两边要在同一网段；刚开机的话等几秒再试。\n\
            小提示：mDNS 广播的是**配对(pairstate)** 和 **可连接(connect)** 两个端口，它们和 5555 不是一回事。".into())
    } else {
        Ok(raw)
    }
}

fn adb_port_arg(args: &Value) -> Option<u16> {
    args.get("port").and_then(|v| {
        v.as_str()
            .and_then(|s| s.trim().parse::<u16>().ok())
            .or_else(|| v.as_u64().map(|n| n as u16))
    })
}

fn adb_connect_text(args: &Value) -> Result<String, String> {
    let host = arg_str(args, "host").ok_or("缺少 host")?;
    let v = crate::android::adb_connect(host, adb_port_arg(args))?;
    Ok(format!(
        "adb connect {}：{}",
        jstr(&v, "target"),
        jstr(&v, "text")
    ))
}

fn adb_pair_text(args: &Value) -> Result<String, String> {
    let host = arg_str(args, "host").ok_or("缺少 host")?;
    let code = arg_str(args, "code").ok_or("缺少 code（6 位配对码）")?;
    let v = crate::android::adb_pair(host, adb_port_arg(args), code)?;
    Ok(format!(
        "配对成功：{}\n{}\n（接下来 adb_connect 到设备「无线调试」页上显示的那个 **连接** 端口，通常和配对端口不同）",
        jstr(&v, "target"),
        jstr(&v, "text")
    ))
}

fn adb_shell_text(args: &Value) -> Result<String, String> {
    let serial = arg_str(args, "serial").ok_or("缺少 serial（先用 adb_devices 看）")?;
    let cmd = arg_str(args, "cmd").ok_or("缺少 cmd")?;
    let t = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(20_000);
    let v = crate::android::adb_shell(serial, cmd, Some(t))?;
    let mut out = format!(
        "exit={}\n",
        v.get("code").and_then(|x| x.as_i64()).unwrap_or(-1)
    );
    let so = jstr(&v, "stdout");
    let se = jstr(&v, "stderr");
    if !so.trim().is_empty() {
        out.push_str(&format!("--- stdout ---\n{}\n", so.trim_end()));
    }
    if !se.trim().is_empty() {
        out.push_str(&format!("--- stderr ---\n{}\n", se.trim_end()));
    }
    Ok(out.chars().take(8000).collect())
}

fn adb_screenshot_text(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let serial = arg_str(args, "serial").ok_or("缺少 serial")?;
    let rel =
        arg_str(args, "save_as").unwrap_or_else(|| format!("adb_shot_{}.png", crate::now_ms()));
    let path = ws_path(ctx, &rel)?;
    let v = crate::android::adb_screenshot(serial, path.to_string_lossy().to_string())?;
    Ok(format!(
        "已截图存到 {}（{} 字节）\n（这是**安卓设备自己的屏幕**；KDock 的「安卓 ADB」页也能直接投屏看）",
        path.display(),
        v.get("bytes").and_then(|x| x.as_u64()).unwrap_or(0)
    ))
}

fn adb_push_text(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let serial = arg_str(args, "serial").ok_or("缺少 serial")?;
    let local = arg_str(args, "local").ok_or("缺少 local（本机文件）")?;
    let remote = arg_str(args, "remote").ok_or("缺少 remote（设备上的目标路径）")?;
    let local_abs = ws_path(ctx, &local)?.to_string_lossy().to_string();
    let v = crate::android::adb_push(serial, local_abs, remote)?;
    Ok(jstr(&v, "text"))
}

fn adb_pull_text(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let serial = arg_str(args, "serial").ok_or("缺少 serial")?;
    let remote = arg_str(args, "remote").ok_or("缺少 remote（设备上的路径）")?;
    let rel = arg_str(args, "save_as").unwrap_or_else(|| {
        std::path::Path::new(&remote)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("adb_pull_{}", crate::now_ms()))
    });
    let path = ws_path(ctx, &rel)?;
    let v = crate::android::adb_pull(serial, remote, path.to_string_lossy().to_string())?;
    Ok(format!(
        "已取回 {}（{} 字节）\n{}",
        path.display(),
        v.get("bytes").and_then(|x| x.as_u64()).unwrap_or(0),
        jstr(&v, "text")
    ))
}

fn adb_install_text(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let serial = arg_str(args, "serial").ok_or("缺少 serial")?;
    let apk = arg_str(args, "apk").ok_or("缺少 apk（本机 APK 路径）")?;
    let apk_abs = ws_path(ctx, &apk)?.to_string_lossy().to_string();
    let re = args
        .get("reinstall")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let v = crate::android::adb_install(serial, apk_abs, Some(re))?;
    Ok(jstr(&v, "text"))
}

/* ───────────────────────── 屏幕（VNC / RTSP / RTMP / H.264） ───────────────────────── */

/// 相对工作区的文件名 → 工作区内的绝对路径（也允许直接给工作区里的绝对路径；跑到外面就拒）
fn ws_path(ctx: &ToolCtx, rel: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(rel.trim());
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        ctx.workspace.join(p)
    };
    let ws = ctx
        .workspace
        .canonicalize()
        .unwrap_or_else(|_| ctx.workspace.clone());
    let probe = joined.parent().unwrap_or(&joined);
    let parent = probe.canonicalize().unwrap_or_else(|_| probe.to_path_buf());
    if !parent.starts_with(&ws) {
        return Err(format!("只能写到这个会话的工作区里（{rel} 看着在外面）"));
    }
    Ok(joined)
}

#[allow(clippy::too_many_arguments)]
fn screen_open(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let kind = arg_str(args, "kind").unwrap_or_else(|| "vnc".into());
    let v = crate::remote_screen::rs_open(
        ctx.app.clone(),
        kind.clone(),
        arg_str(args, "host"),
        args.get("port").and_then(|x| x.as_u64()).map(|n| n as u16),
        arg_str(args, "password"),
        arg_str(args, "url"),
        args.get("fps").and_then(|x| x.as_u64()).map(|n| n as u32),
        args.get("quality")
            .and_then(|x| x.as_u64())
            .map(|n| n as u8),
        args.get("scale").and_then(|x| x.as_f64()).map(|n| n as f32),
        args.get("width").and_then(|x| x.as_u64()).map(|n| n as u32),
        args.get("height")
            .and_then(|x| x.as_u64())
            .map(|n| n as u32),
        arg_str(args, "transport"),
        args.get("view_only").and_then(|x| x.as_bool()),
    )?;
    let id = v.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
    if let Ok(mut g) = ctx.state.screen_owners.lock() {
        g.insert(id as u32, ctx.session.to_string());
    }
    Ok(format!(
        "已开屏幕会话 #{id}（{}）\n接下来：screen_shot 截图；kind=vnc 时还能 screen_pointer / screen_key / screen_type 操作对面；不用了 screen_close。",
        jstr(&v, "label")
    ))
}

/// 屏幕会话的归属检查：A 会话不能截图/按键/关闭 B 会话打开的屏幕。
fn screen_owned(ctx: &ToolCtx, id: u32) -> Result<(), String> {
    let g = ctx
        .state
        .screen_owners
        .lock()
        .map_err(|_| "screen owner mutex".to_string())?;
    if let Some(owner) = g.get(&id) {
        if owner != ctx.session {
            return Err(format!(
                "屏幕会话 #{id} 是另一个会话打开的（owner={}），不能跨会话操作",
                owner
            ));
        }
    }
    Ok(())
}

fn screen_list_text(ctx: &ToolCtx) -> Result<String, String> {
    let owners = ctx
        .state
        .screen_owners
        .lock()
        .map_err(|_| "screen owner mutex".to_string())?;
    let list: Vec<Value> = crate::remote_screen::rs_list()
        .into_iter()
        .filter(|s| {
            let id = s.get("id").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            owners.get(&id).map(|o| o == ctx.session).unwrap_or(true)
        })
        .collect();
    if list.is_empty() {
        return Ok("（没有活着的屏幕会话；screen_open 开一路）".into());
    }
    Ok(list
        .iter()
        .map(|s| {
            format!(
                "#{}  {}  {}",
                s.get("id").and_then(|x| x.as_u64()).unwrap_or(0),
                jstr(s, "kind"),
                jstr(s, "label")
            )
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

fn screen_shot(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let id = args
        .get("session")
        .and_then(|v| v.as_u64())
        .ok_or("缺少 session（screen_open 给的 id）")? as u32;
    screen_owned(ctx, id)?;
    let rel = arg_str(args, "save_as").unwrap_or_else(|| format!("shot_{}.png", crate::now_ms()));
    let path = ws_path(ctx, &rel)?;
    let v = crate::remote_screen::rs_snapshot(id, Some(path.to_string_lossy().to_string()))?;
    Ok(format!(
        "会话 #{}（{}）\nPNG：{}（{} 字节，输出 {}x{}；会话尺寸 {}x{}，帧时间 {}ms 前）\n\n字符画（@ 亮 / 空格 暗，只能看版面，读不了文字）：\n{}",
        id,
        jstr(&v, "label"),
        path.display(),
        v.get("bytes").and_then(|x| x.as_u64()).unwrap_or(0),
        v.get("w").and_then(|x| x.as_u64()).unwrap_or(0),
        v.get("h").and_then(|x| x.as_u64()).unwrap_or(0),
        v.get("nat_w").and_then(|x| x.as_u64()).unwrap_or(0),
        v.get("nat_h").and_then(|x| x.as_u64()).unwrap_or(0),
        v.get("age_ms").and_then(|x| x.as_i64()).unwrap_or(0),
        jstr(&v, "preview"),
    ))
}

fn image_ocr(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let rel = arg_str(args, "path").ok_or("缺少 path")?;
    let path = ws_path(ctx, &rel)?;
    if !path.is_file() {
        return Err(format!("图片不存在：{}", path.display()));
    }
    let text = crate::ocr::ocr_image(&path)?;
    Ok(format!("图片：{}\n--- OCR ---\n{}", path.display(), text))
}

fn screen_ocr(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let id = args
        .get("session")
        .and_then(|v| v.as_u64())
        .ok_or("缺少 session（screen_open 给的 id）")? as u32;
    screen_owned(ctx, id)?;
    let rel = arg_str(args, "save_as").unwrap_or_else(|| format!("ocr_{}.png", crate::now_ms()));
    let path = ws_path(ctx, &rel)?;
    let v = crate::remote_screen::rs_snapshot(id, Some(path.to_string_lossy().to_string()))?;
    let text = crate::ocr::ocr_image(&path)?;
    Ok(format!(
        "屏幕会话 #{}（{}）\nPNG：{}（{}x{}，{}ms 前）\n--- OCR ---\n{}",
        id,
        jstr(&v, "label"),
        path.display(),
        v.get("w").and_then(|x| x.as_u64()).unwrap_or(0),
        v.get("h").and_then(|x| x.as_u64()).unwrap_or(0),
        v.get("age_ms").and_then(|x| x.as_i64()).unwrap_or(0),
        text
    ))
}

/// 键名 → X11 keysym（和前端 capKeysym 一张表，别各写一套）
fn keysym_of(key: &str) -> Option<u32> {
    // 空格要单独处理：下面做了 trim()，单个空格会被 trim 成空串 → 被当成"认不得这个键"丢掉。
    // 实测就是这样：agent 敲 `echo abc > f` 时那个空格没了，它只好改用 ${IFS} 绕过去。
    if key == " " {
        return Some(0x20);
    }
    let k = key.trim();
    let named: &[(&str, u32)] = &[
        ("enter", 0xff0d),
        ("return", 0xff0d),
        ("tab", 0xff09),
        ("esc", 0xff1b),
        ("escape", 0xff1b),
        ("backspace", 0xff08),
        ("delete", 0xffff),
        ("del", 0xffff),
        ("space", 0x20),
        ("up", 0xff52),
        ("down", 0xff54),
        ("left", 0xff51),
        ("right", 0xff53),
        ("home", 0xff50),
        ("end", 0xff57),
        ("pgup", 0xff55),
        ("pgdn", 0xff56),
        ("insert", 0xff63),
        ("ctrl", 0xffe3),
        ("shift", 0xffe1),
        ("alt", 0xffe9),
        ("super", 0xffeb),
        ("caps", 0xffe5),
        ("num", 0xff7f),
    ];
    let low = k.to_ascii_lowercase();
    if let Some((_, ks)) = named.iter().find(|(n, _)| *n == low) {
        return Some(*ks);
    }
    if let Some(n) = low.strip_prefix('f') {
        if let Ok(i) = n.parse::<u32>() {
            if (1..=12).contains(&i) {
                return Some(0xffbe + i - 1);
            }
        }
    }
    if let Ok(n) = low.parse::<u32>() {
        return Some(n); // 直接给 keysym 数值也行
    }
    if let Some(hex) = low.strip_prefix("0x") {
        if let Ok(n) = u32::from_str_radix(hex, 16) {
            return Some(n); // 0xff0d 这种写法也认
        }
    }
    let mut it = k.chars();
    let c = it.next()?;
    if it.next().is_none() {
        let cp = c as u32;
        return Some(if cp <= 0xff {
            cp
        } else if cp <= 0xffff {
            cp
        } else {
            0x0100_0000 + cp
        });
    }
    None
}

fn screen_pointer(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let id = args
        .get("session")
        .and_then(|v| v.as_u64())
        .ok_or("缺少 session")? as u32;
    screen_owned(ctx, id)?;
    let x = args.get("x").and_then(|v| v.as_i64()).ok_or("缺少 x")?;
    let y = args.get("y").and_then(|v| v.as_i64()).ok_or("缺少 y")?;
    if !(0..=32767).contains(&x) || !(0..=32767).contains(&y) {
        return Err("x/y 要在 0..32767 之间".into());
    }
    let button = arg_str(args, "button").unwrap_or_else(|| "left".into());
    let mask = match button.as_str() {
        "middle" => 2u8,
        "right" => 4u8,
        _ => 1u8,
    };
    crate::remote_screen::rs_pointer(id, x as u16, y as u16, 0)?;
    if args.get("click").and_then(|v| v.as_bool()).unwrap_or(false) {
        std::thread::sleep(Duration::from_millis(80));
        crate::remote_screen::rs_pointer(id, x as u16, y as u16, mask)?;
        std::thread::sleep(Duration::from_millis(60));
        crate::remote_screen::rs_pointer(id, x as u16, y as u16, 0)?;
        Ok(format!("已移动到 ({x},{y}) 并点了一下（{button}）"))
    } else {
        Ok(format!("已移动到 ({x},{y})"))
    }
}

fn screen_key(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let id = args
        .get("session")
        .and_then(|v| v.as_u64())
        .ok_or("缺少 session")? as u32;
    screen_owned(ctx, id)?;
    let key = arg_str(args, "key").ok_or("缺少 key")?;
    let ks = keysym_of(&key).ok_or_else(|| {
        format!("认不得这个键：{key}（可以用 enter/tab/esc/backspace/up/down/left/right/home/end/pgup/pgdn/f1-f12，或单个字符）")
    })?;
    match args.get("down").and_then(|v| v.as_bool()) {
        Some(true) => crate::remote_screen::rs_key(id, ks, true)?,
        Some(false) => crate::remote_screen::rs_key(id, ks, false)?,
        None => {
            crate::remote_screen::rs_key(id, ks, true)?;
            std::thread::sleep(Duration::from_millis(30));
            crate::remote_screen::rs_key(id, ks, false)?;
        }
    }
    Ok(format!("已按键 {key}（keysym 0x{ks:04X}）"))
}

fn screen_type(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let id = args
        .get("session")
        .and_then(|v| v.as_u64())
        .ok_or("缺少 session")? as u32;
    screen_owned(ctx, id)?;
    let text = arg_str(args, "text").ok_or("缺少 text")?;
    let mut n = 0usize;
    for c in text.chars() {
        let key = match c {
            '\n' => "enter".to_string(),
            '\t' => "tab".to_string(),
            other => other.to_string(),
        };
        let Some(ks) = keysym_of(&key) else { continue };
        crate::remote_screen::rs_key(id, ks, true)?;
        std::thread::sleep(Duration::from_millis(25));
        crate::remote_screen::rs_key(id, ks, false)?;
        std::thread::sleep(Duration::from_millis(25));
        n += 1;
    }
    Ok(format!(
        "已敲入 {n} 个字符（回车用 enter）\n注意：对方如果没把焦点放在输入框里，字符会丢 —— 先 screen_shot 看画面，必要时 screen_pointer 点一下要输入的地方。"
    ))
}

fn screen_close(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    match args.get("session").and_then(|v| v.as_u64()) {
        Some(id) => {
            screen_owned(ctx, id as u32)?;
            crate::remote_screen::rs_stop(id as u32);
            if let Ok(mut g) = ctx.state.screen_owners.lock() {
                g.remove(&(id as u32));
            }
            Ok(format!("已关屏幕会话 #{id}"))
        }
        None => {
            // 只能关自己名下的会话；UI 打开的（没有 owner）留给用户自己关。
            let ids: Vec<u32> = {
                let g = ctx
                    .state
                    .screen_owners
                    .lock()
                    .map_err(|_| "screen owner mutex".to_string())?;
                g.iter()
                    .filter(|(_, o)| o.as_str() == ctx.session)
                    .map(|(id, _)| *id)
                    .collect()
            };
            for id in &ids {
                crate::remote_screen::rs_stop(*id);
            }
            if let Ok(mut g) = ctx.state.screen_owners.lock() {
                for id in &ids {
                    g.remove(id);
                }
            }
            Ok(format!("已关掉本会话的 {} 个屏幕会话", ids.len()))
        }
    }
}

fn which(exe: &str) -> Option<String> {
    let out = if cfg!(windows) {
        std::process::Command::new("where").arg(exe).output().ok()?
    } else {
        std::process::Command::new("sh")
            .args(["-c", &format!("command -v {exe}")])
            .output()
            .ok()?
    };
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
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
            "jlink" => which("JLink.exe")
                .or_else(|| which("JLink"))
                .ok_or("PATH 里没有 JLink.exe，请用 exe 指定全路径")?,
            "openocd" => which("openocd.exe")
                .or_else(|| which("openocd"))
                .ok_or("PATH 里没有 openocd.exe，请用 exe 指定全路径")?,
            "stm32" => which("STM32_Programmer_CLI.exe")
                .or_else(|| which("STM32_Programmer_CLI"))
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
            argv = vec![
                "-ExitOnError".into(),
                "1".into(),
                "-CommanderScript".into(),
                tmp.to_string_lossy().to_string(),
            ];
        }
        "openocd" => {
            let cfg = arg_str(args, "config").unwrap_or_else(|| "interface/cmsis-dap.cfg".into());
            let target = arg_str(args, "target").unwrap_or_else(|| "target/stm32f4x.cfg".into());
            argv = vec![
                "-f".into(),
                cfg,
                "-f".into(),
                target,
                "-c".into(),
                "init".into(),
                "-c".into(),
                "halt".into(),
                "-c".into(),
                format!("program \"{file}\" verify reset exit"),
            ];
        }
        _ => {
            argv = vec![
                "-c".into(),
                "port=SWD".into(),
                "-w".into(),
                file.clone(),
                addr.clone(),
                "-v".into(),
                "-rst".into(),
            ];
        }
    }
    let (log, app) = (ctx.log, ctx.app);
    (log)(&format!("[agent] 烧录: {} {}\n", exe, argv.join(" ")));
    let _ = app.emit(
        "flash://log",
        format!("\n[agent] $ {} {}\n", exe, argv.join(" ")),
    );
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(&argv)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = crate::process_guard::spawn(&mut cmd)
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
                    String::from_utf8_lossy(&out.stderr)
                );
                let _ = app.emit("flash://log", text.clone());
                let tail: Vec<&str> = text.lines().rev().take(40).collect();
                let mut tail: Vec<&str> = tail.into_iter().collect();
                tail.reverse();
                let ok = status.success();
                return Ok(format!(
                    "烧录退出码 {}（{}）\n--- 末尾输出 ---\n{}",
                    status.code().unwrap_or(-1),
                    if ok { "成功" } else { "失败" },
                    tail.join("\n")
                ));
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
            "user" | "assistant" | "note" => ev
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            "tool_call" => format!(
                "{} {}",
                ev.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                ev.get("args").cloned().unwrap_or(Value::Null)
            ),
            "tool_result" => ev
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            "summary" => ev
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
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
    Ok(format!(
        "在会话记录里找到 {} 处（含已压缩部分）：\n{}",
        hits.len(),
        hits.join("\n")
    ))
}

fn set_page(ctx: &ToolCtx, page: super::browser::Page) {
    if let Ok(mut g) = ctx.state.page.lock() {
        if let Some(old) = g.insert(ctx.session.to_string(), page.clone()) {
            if let Ok(mut h) = ctx.state.history.lock() {
                let history = h.entry(ctx.session.to_string()).or_default();
                history.push(old);
                if history.len() > 30 {
                    history.remove(0);
                }
            }
        }
    }
    let _ = ctx.app.emit(
        "agent://browser",
        json!({ "session": ctx.session, "page": page }),
    );
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
    let g = ctx
        .state
        .page
        .lock()
        .map_err(|_| "page mutex".to_string())?;
    let page = g
        .get(ctx.session)
        .ok_or("还没有打开任何网页，先 browser_open")?;
    let body: String = page.text.chars().take(max).collect();
    let more = if page.text.chars().count() > max {
        "\n…(截断)"
    } else {
        ""
    };
    Ok(format!(
        "{}\n标题：{}\n--- 正文 ---\n{}{}",
        page.url, page.title, body, more
    ))
}

fn browser_find(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let needle = arg_str(args, "text").ok_or("缺少 text")?;
    if needle.is_empty() {
        return Err("text 不能为空".into());
    }
    let max_hits = arg_u64(args, "max_hits", 5) as usize;
    let g = ctx
        .state
        .page
        .lock()
        .map_err(|_| "page mutex".to_string())?;
    let page = g
        .get(ctx.session)
        .ok_or("还没有打开任何网页，先 browser_open")?;
    let text = &page.text;
    let mut out = Vec::new();
    let mut pos = 0usize;
    while out.len() < max_hits {
        let Some(rel) = text[pos..].find(&needle) else {
            break;
        };
        let at = pos + rel;
        let start = text[..at].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let end = text[at..].find('\n').map(|i| at + i).unwrap_or(text.len());
        out.push(format!("…{}…", text[start..end].trim()));
        // 用 needle.len() 前进，至少跨过一个完整字符；at + 1 可能落在多字节 UTF-8
        // 字符中间，下一轮 text[pos..] 会直接 panic。
        pos = end.max(at + needle.len());
    }
    if out.is_empty() {
        return Ok(format!("当前页 {} 里没有找到「{needle}」", page.url));
    }
    Ok(format!(
        "在 {} 里找到 {} 处：\n{}",
        page.url,
        out.len(),
        out.join("\n")
    ))
}

fn workspace_list(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    cached_read(ctx, "workspace_list", args, || {
        let rel = arg_str(args, "path").unwrap_or_else(|| ".".into());
        let dir = store::resolve_in_workspace(&ctx.workspace, &rel)?;
        std::fs::create_dir_all(&dir).ok();
        let mut lines = vec![format!("工作区 {}/ 下：", rel)];
        for entry in std::fs::read_dir(&dir)
            .map_err(|e| format!("读目录失败: {e}"))?
            .flatten()
        {
            let md = entry.metadata().ok();
            let is_dir = md.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
            let name = entry.file_name().to_string_lossy().to_string();
            lines.push(if is_dir {
                format!("D {name}/")
            } else {
                format!("F {size:>10}  {name}")
            });
        }
        Ok(lines.join("\n"))
    })
}

fn workspace_read(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    cached_read(ctx, "workspace_read", args, || {
        if let Some(paths) = args.get("paths").and_then(|v| v.as_array()) {
            if paths.is_empty() {
                return Err("paths 不能为空".into());
            }
            let max = arg_u64(args, "max_bytes", 32_768) as usize;
            let mut out = Vec::new();
            for p in paths {
                let rel = p.as_str().ok_or("paths 里必须是字符串")?;
                let path = store::resolve_in_workspace(&ctx.workspace, rel)?;
                let data = std::fs::read(&path).map_err(|e| format!("读不了 {rel}: {e}"))?;
                let cut = &data[..data.len().min(max)];
                out.push(format!(
                    "===== {rel} ({} bytes) =====\n{}",
                    data.len(),
                    text_and_hex(cut)
                ));
            }
            return Ok(out.join("\n\n"));
        }
        let rel = arg_str(args, "path").ok_or("缺少 path")?;
        let max = arg_u64(args, "max_bytes", 65_536) as usize;
        let path = store::resolve_in_workspace(&ctx.workspace, &rel)?;
        let data = std::fs::read(&path).map_err(|e| format!("读不了 {rel}: {e}"))?;
        let cut = &data[..data.len().min(max)];
        Ok(text_and_hex(cut))
    })
}

fn workspace_write(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let mut files: Vec<(String, String)> = Vec::new();
    if let Some(arr) = args.get("files").and_then(|v| v.as_array()) {
        for f in arr {
            let rel = f.get("path").and_then(|v| v.as_str()).ok_or("files 每项缺 path")?;
            let content = f.get("content").and_then(|v| v.as_str()).unwrap_or("");
            files.push((rel.to_string(), content.to_string()));
        }
    } else {
        let rel = arg_str(args, "path").ok_or("缺少 path（或给 files 数组）")?;
        let content = arg_str(args, "content").unwrap_or_default();
        files.push((rel, content));
    }
    let append = arg_bool(args, "append", false);
    let mut out = Vec::new();
    for (rel, content) in files {
        let path = store::resolve_in_workspace(&ctx.workspace, &rel)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let size = content.len();
        if append {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|e| format!("打开失败: {e}"))?;
            f.write_all(content.as_bytes())
                .map_err(|e| format!("写失败: {e}"))?;
        } else {
            std::fs::write(&path, content).map_err(|e| format!("写失败: {e}"))?;
        }
        out.push(format!("已写 {size} 字节 -> {}", path.display()));
    }
    ctx.state.cache_clear(ctx.session);
    Ok(out.join("\n"))
}

fn workspace_mkdir(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let rel = arg_str(args, "path").ok_or("缺少 path")?;
    let path = store::resolve_in_workspace(&ctx.workspace, &rel)?;
    std::fs::create_dir_all(&path).map_err(|e| format!("建目录失败: {e}"))?;
    ctx.state.cache_clear(ctx.session);
    Ok(format!("已建目录 {}", path.display()))
}

fn unified_diff(rel: &str, old: &str, new: &str) -> String {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let mut pre = 0usize;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0usize;
    while suf < a.len().saturating_sub(pre)
        && suf < b.len().saturating_sub(pre)
        && a[a.len() - 1 - suf] == b[b.len() - 1 - suf]
    {
        suf += 1;
    }
    let start = pre.saturating_sub(2);
    let end = (a.len() - suf + 2).min(a.len());
    let b_end = (b.len() - suf + 2).min(b.len());
    let mut out = format!(
        "--- a/{rel}\n+++ b/{rel}\n@@ -{},{} +{},{} @@\n",
        start + 1,
        end.saturating_sub(start),
        start + 1,
        b_end.saturating_sub(start)
    );
    for line in &a[start..pre] {
        out.push(' ');
        out.push_str(line);
        out.push('\n');
    }
    for line in &a[pre..a.len() - suf] {
        out.push('-');
        out.push_str(line);
        out.push('\n');
    }
    for line in &b[pre..b.len() - suf] {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    for line in &a[a.len() - suf..end] {
        out.push(' ');
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn workspace_edit(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let default_path = arg_str(args, "path");
    let mut specs: Vec<(String, String, String, bool)> = Vec::new();
    if let Some(edits) = args.get("edits").and_then(|v| v.as_array()) {
        for (i, e) in edits.iter().enumerate() {
            let rel = e
                .get("path")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| default_path.clone())
                .ok_or_else(|| format!("第 {} 个 edit 缺 path", i + 1))?;
            let old = e.get("old_text").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let new = e.get("new_text").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if old.is_empty() {
                return Err(format!("第 {} 个 edit 的 old_text 不能为空", i + 1));
            }
            let all = e.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);
            specs.push((rel, old, new, all));
        }
    } else {
        let rel = default_path.ok_or("缺少 path（或给 edits 数组）")?;
        let old = arg_str(args, "old_text").ok_or("缺少 old_text")?;
        let new = arg_str(args, "new_text").ok_or("缺少 new_text")?;
        if old.is_empty() {
            return Err("old_text 不能为空（新建文件请用 workspace_write）".into());
        }
        specs.push((rel, old, new, arg_bool(args, "replace_all", false)));
    }

    // 先全部校验/在内存里改，确认无误后再落盘，避免批量编辑改到一半失败。
    let mut files: std::collections::HashMap<String, (String, String, usize)> =
        std::collections::HashMap::new();
    for (rel, old, new, all) in specs {
        if !files.contains_key(&rel) {
            let path = store::resolve_in_workspace(&ctx.workspace, &rel)?;
            let text = std::fs::read_to_string(&path).map_err(|e| format!("读不了 {rel}: {e}"))?;
            files.insert(rel.clone(), (text.clone(), text, 0));
        }
        let (_, text, count) = files.get_mut(&rel).unwrap();
        let hit = text.matches(&old).count();
        if hit == 0 {
            return Err(format!("old_text 在 {rel} 里找不到；没有改任何东西"));
        }
        if hit > 1 && !all {
            return Err(format!(
                "old_text 在 {rel} 里出现 {hit} 次；要么给更长上下文，要么 replace_all=true"
            ));
        }
        *text = if all {
            text.replace(&old, &new)
        } else {
            text.replacen(&old, &new, 1)
        };
        *count += if all { hit } else { 1 };
    }
    let mut out = Vec::new();
    for (rel, (before, after, count)) in files {
        let path = store::resolve_in_workspace(&ctx.workspace, &rel)?;
        std::fs::write(&path, &after).map_err(|e| format!("写失败: {e}"))?;
        out.push(format!(
            "已改 {}（{} 处）\n{}",
            path.display(),
            count,
            unified_diff(&rel, &before, &after)
        ));
    }
    ctx.state.cache_clear(ctx.session);
    Ok(out.join("\n\n"))
}

fn workspace_diff(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let mut git = std::process::Command::new("git");
    git.args(["status", "--short"]);
    git.current_dir(&ctx.workspace);
    let status = git.output().map_err(|e| format!("工作区不是可用的 git 仓库（找不到 git）: {e}"))?;
    if !status.status.success() {
        return Err("工作区不是 git 仓库，暂时没有基线可 diff；请用 workspace_edit 的返回 diff 审查".into());
    }
    let mut diff = std::process::Command::new("git");
    diff.args(["diff", "--no-color", "--"]);
    if let Some(p) = arg_str(args, "path") {
        diff.arg(p);
    }
    diff.current_dir(&ctx.workspace);
    let out = diff.output().map_err(|e| format!("git diff 失败: {e}"))?;
    let status_text = crate::shell::decode(&status.stdout);
    let diff_text = crate::shell::decode(&out.stdout);
    Ok(format!(
        "--- git status ---\n{}\n--- git diff ---\n{}",
        if status_text.trim().is_empty() { "（干净）" } else { status_text.trim() },
        if diff_text.trim().is_empty() { "（没有未提交改动）" } else { diff_text.trim() }
    ))
}

fn workspace_search(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    cached_read(ctx, "workspace_search", args, || workspace_search_inner(ctx, args))
}

fn workspace_search_inner(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let pattern = arg_str(args, "pattern").ok_or("缺少 pattern")?;
    if pattern.is_empty() {
        return Err("pattern 不能为空".into());
    }
    let root_rel = arg_str(args, "path").unwrap_or_else(|| ".".into());
    let root = store::resolve_in_workspace(&ctx.workspace, &root_rel)?;
    let ext = arg_str(args, "ext").map(|s| {
        let s = s.trim().trim_start_matches('.').to_lowercase();
        format!(".{s}")
    });
    let max = arg_u64(args, "max_results", 50).clamp(1, 500) as usize;
    let case = arg_bool(args, "case_sensitive", false);
    let needle = if case { pattern.clone() } else { pattern.to_lowercase() };
    let mut hits = Vec::new();
    search_dir(&root, &ctx.workspace, &needle, ext.as_deref(), case, max, 0, &mut hits);
    if hits.is_empty() {
        return Ok(format!("没有找到「{pattern}」"));
    }
    Ok(format!(
        "找到 {} 处（最多显示 {max} 处）：\n{}",
        hits.len(),
        hits.join("\n")
    ))
}

fn search_dir(
    dir: &std::path::Path,
    root: &std::path::Path,
    needle: &str,
    ext: Option<&str>,
    case: bool,
    max: usize,
    depth: usize,
    out: &mut Vec<String>,
) {
    if out.len() >= max || depth > 16 {
        return;
    }
    let skip = [".git", "target", "node_modules", "dist", "build", ".venv", "__pycache__", ".kdock_skill"];
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if out.len() >= max {
            break;
        }
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            if !skip.iter().any(|s| *s == name) {
                search_dir(&p, root, needle, ext, case, max, depth + 1, out);
            }
            continue;
        }
        if let Some(want) = ext {
            let got = p.extension().map(|x| format!(".{}", x.to_string_lossy().to_lowercase())).unwrap_or_default();
            if got != want {
                continue;
            }
        }
        let Ok(md) = e.metadata() else { continue };
        if md.len() > 1_500_000 {
            continue;
        }
        let Ok(bytes) = std::fs::read(&p) else { continue };
        if bytes.contains(&0) {
            continue;
        }
        let text = crate::shell::decode(&bytes);
        for (i, line) in text.lines().enumerate() {
            let hay = if case { line.to_string() } else { line.to_lowercase() };
            if hay.contains(needle) {
                let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
                let preview: String = line.trim().chars().take(300).collect();
                out.push(format!("{rel}:{}: {preview}", i + 1));
                if out.len() >= max {
                    break;
                }
            }
        }
    }
}

fn workspace_run(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let cmd = arg_str(args, "cmd").ok_or("缺少 cmd")?;
    let cwd_rel = arg_str(args, "cwd").unwrap_or_else(|| ".".into());
    let cwd = store::resolve_in_workspace(&ctx.workspace, &cwd_rel)?;
    let timeout = arg_u64(args, "timeout_ms", 120_000).min(600_000);
    let (code, stdout, stderr) = crate::shell::run_with_path_in(
        &cmd,
        timeout,
        &crate::agent::stop_requested,
        &env_path_prefix(),
        &cwd,
    )?;
    let mut text = format!("exit={code}\n");
    if !stdout.trim().is_empty() {
        text.push_str(&format!("--- stdout ---\n{}\n", stdout.trim_end()));
    }
    if !stderr.trim().is_empty() {
        text.push_str(&format!("--- stderr ---\n{}\n", stderr.trim_end()));
    }
    Ok(truncate_chars(text, 16_000))
}

fn detect_test_cmd(dir: &std::path::Path) -> Option<String> {
    if dir.join("Cargo.toml").is_file() {
        return Some("cargo test".into());
    }
    let pkg = dir.join("package.json");
    if pkg.is_file() {
        if let Ok(txt) = std::fs::read_to_string(&pkg) {
            if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                if v.get("scripts").and_then(|s| s.get("test")).and_then(|t| t.as_str()).is_some() {
                    return Some("npm test".into());
                }
            }
        }
    }
    if dir.join("pyproject.toml").is_file()
        || dir.join("pytest.ini").is_file()
        || dir.join("tox.ini").is_file()
    {
        return Some("python -m pytest".into());
    }
    None
}

fn workspace_test(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let cwd_rel = arg_str(args, "cwd").unwrap_or_else(|| ".".into());
    let cwd = store::resolve_in_workspace(&ctx.workspace, &cwd_rel)?;
    let cmd = arg_str(args, "cmd")
        .or_else(|| detect_test_cmd(&cwd))
        .ok_or("没识别出测试命令（没有 Cargo.toml / npm test / pytest），请显式给 cmd")?;
    let mut a = args.clone();
    a["cmd"] = json!(cmd);
    workspace_run(ctx, &a)
}

fn workspace_context(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    cached_read(ctx, "workspace_context", args, || {
        let mut out = Vec::new();
        let max_files = arg_u64(args, "max_files", 80).clamp(1, 500) as usize;
        let list_args = json!({ "path": arg_str(args, "path").unwrap_or_else(|| ".".into()) });
        let listing = workspace_list(ctx, &list_args)?;
        out.push(format!(
            "--- 目录 ---\n{}",
            listing.lines().take(max_files + 1).collect::<Vec<_>>().join("\n")
        ));
        if let Some(pattern) = arg_str(args, "pattern").filter(|s| !s.trim().is_empty()) {
            let mut sargs = json!({ "pattern": pattern, "max_results": 30 });
            if let Some(p) = arg_str(args, "path") {
                sargs["path"] = json!(p);
            }
            let hits = workspace_search_inner(ctx, &sargs)?;
            out.push(format!("--- 搜索 ---\n{}", hits));
        }
        if let Some(paths) = args.get("paths").and_then(|v| v.as_array()) {
            let max = arg_u64(args, "max_bytes", 20_000) as usize;
            let mut reads = Vec::new();
            for p in paths {
                let Some(rel) = p.as_str() else { continue };
                let path = store::resolve_in_workspace(&ctx.workspace, rel)?;
                let data = std::fs::read(&path).map_err(|e| format!("读不了 {rel}: {e}"))?;
                let body = text_and_hex(&data[..data.len().min(max)]);
                reads.push(format!("===== {rel} =====\n{body}"));
            }
            if !reads.is_empty() {
                out.push(format!("--- 文件 ---\n{}", reads.join("\n\n")));
            }
        }
        Ok(out.join("\n\n"))
    })
}

fn workspace_check(ctx: &ToolCtx, args: &Value) -> Result<String, String> {
    let diff = workspace_diff(ctx, args).unwrap_or_else(|e| format!("（diff 不可用）{e}"));
    let test = workspace_test(ctx, args)?;
    Ok(format!("--- diff / status ---\n{diff}\n\n--- test ---\n{test}"))
}
