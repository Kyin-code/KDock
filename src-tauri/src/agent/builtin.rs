//! 内置指令：**跟着程序走**的那几段"给模型的规矩"，只读（改不了），但可选项能关。
//!
//! 为什么单独成一层（照 Codex 的分工）：
//!   · 内置指令 = 程序自带的、每轮都在的"规矩"（角色、工具用法、安全纪律）；
//!   · 全局/工作区指导文件（AGENTS.md）= 用户自己的持久约定（人格、口吻、项目规矩）；
//!   · 技能（SKILL.md）= 按需读的可复用流程，正文不进上下文，只在索引里露一行。
//! 这样"谁在一直占上下文"就是一眼能看明白的三件事，而不是"一堆技能里哪几个勾了常驻"。
//!
//! 关掉的项存在 `agent/builtin-off.json`（一串 id）。**顺序固定**（就是下面这个数组的顺序），
//! 文本里不含时间/路径这类会变的东西 —— 系统提示要吃前缀缓存，稳字第一。

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub struct Block {
    pub id: &'static str,
    pub title: &'static str,
    /// 内部说明（**不返回给界面**）：给写代码的人看这条是干嘛的
    #[allow(dead_code)]
    pub desc: &'static str,
    /// 核心项不给关：关掉它这个助手就不成立了
    pub optional: bool,
    pub body: &'static str,
}

/// 清单。顺序 = 进系统提示的顺序（也是界面上的顺序）。
pub static BLOCKS: &[Block] = &[
    Block {
        id: "role",
        title: "角色与能力",
        desc: "你是谁、跑在哪、KDock 内置了哪些能力 —— 关了就没人格了，不建议关。",
        optional: false,
        body: "你是 KDock 里的设备调试助手，跑在用户的电脑上（桌面版上位机）。\n\
               KDock 已经内置：串口/网口收发、设备文件读写、固件升级(OTA)、烧录器写片、示波器控制、\
               中控编排(时序流程)、屏幕捕获、安卓 ADB、SSH、FTP/TFTP。你能直接调它们。",
    },
    Block {
        id: "links",
        title: "两种连接：主连接 vs 私有链路",
        desc: "主连接是用户看着的那条；link_* 是你自己的私密链路。用途不同，别搞混。",
        optional: true,
        body: "传输页那条主连接是用户自己的；要**互不干扰**就用你自己的 link_*（那条用户看不见）。\n\
               但**用户想看着你干**、或者你想跟用户看同一份设备返回时，用 port_* 直接操作主连接：\n\
               port_list 看本机有哪些串口（别去跑 PowerShell 扫）、port_state 看主连接状态、\
               port_write 往主连接发、port_read 读主连接的收发记录（用户在传输页看到的就是这一份）。\n\
               你在主连接上做的事会实时出现在用户的传输页里，所以那是「看得见」的通道。",
    },
    Block {
        id: "principles",
        title: "做事原则",
        desc: "先观察再动手、一次一件事、不臆测输出、二进制用 HEX、收尾给结论。",
        optional: true,
        body: "做事原则：\n\
               1. 先观察再动手（先 list/read 看清现状），改设备状态前先说明你要做什么；\n\
               2. 危险动作（升级、烧录、写设备文件、复位、改远端服务）尽量先让用户确认；\n\
               3. 一条工具调用只做一件事，拿到结果再决定下一步；不要臆测输出；\n\
               4. 二进制内容用 HEX 描述，别贴乱码；\n\
               5. 收尾时用中文给一句结论 + 关键数据（做了什么、看到了什么、下一步建议）。",
    },
    Block {
        id: "context-hygiene",
        title: "上下文卫生",
        desc: "怎么用技能、怎么处理大输出、什么时候压上下文 —— 直接关系到花多少钱。",
        optional: true,
        body: "上下文卫生（直接影响用户的花费，务必照做）：\n\
               · 技能只在索引里有一行描述；要照它做事（或用户点名时）先 skill_read 读全文，读完照着做，别凭描述猜内容；\n\
               · 大输出（波形、日志、目录列表、网页正文）不要整段贴回对话：需要全量就用工具存成文件，再按需分批读；\n\
               · 已经读过的东西别重复读，同一轮里能用一次工具说明白就不要再补一次；\n\
               · 会话很长时可以用 /compact 让上下文压缩，压完继续做，不要重头再来。",
    },
];

fn off_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("agent").join("builtin-off.json"))
}

pub fn off_list(app: &AppHandle) -> Vec<String> {
    let mut v: Vec<String> = off_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
        .unwrap_or_default();
    v.sort();
    v.dedup();
    v
}

fn off_write(app: &AppHandle, ids: &[String]) -> Result<(), String> {
    let p = off_path(app).ok_or("拿不到数据目录")?;
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let mut v = ids.to_vec();
    v.sort();
    v.dedup();
    let text = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    std::fs::write(&p, text).map_err(|e| format!("写 {} 失败: {e}", p.display()))
}

pub fn set_enabled(app: &AppHandle, id: &str, on: bool) -> Result<(), String> {
    let Some(b) = BLOCKS.iter().find(|b| b.id == id) else {
        return Err(format!("没有这条内置指令：{id}"));
    };
    if !b.optional && !on {
        return Err(format!("「{}」是核心指令，不能关", b.title));
    }
    let mut cur = off_list(app);
    if on {
        cur.retain(|x| x != id);
    } else if !cur.contains(&id.to_string()) {
        cur.push(id.to_string());
    }
    off_write(app, &cur)
}

/// 给界面用的清单：**只给标题和开关**，不给正文/说明 ——
/// 这是程序自带的内部规矩，不该让终端用户看到内容（要改的是代码里的 BLOCKS）
pub fn list(app: &AppHandle) -> Vec<Value> {
    let off = off_list(app);
    BLOCKS
        .iter()
        .map(|b| {
            json!({
                "id": b.id, "title": b.title,
                "optional": b.optional, "enabled": !off.contains(&b.id.to_string()),
            })
        })
        .collect()
}

/// 进系统提示的正文（按清单顺序拼，关掉的不出现）
pub fn text(app: &AppHandle) -> String {
    let off = off_list(app);
    let mut out = String::new();
    for b in BLOCKS.iter().filter(|b| !off.contains(&b.id.to_string())) {
        out.push_str(b.body);
        out.push_str("\n\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_block_cannot_be_disabled() {
        let ids: Vec<&str> = BLOCKS.iter().map(|b| b.id).collect();
        assert!(ids.contains(&"role"));
        assert_eq!(BLOCKS.iter().filter(|b| !b.optional).count(), 1, "核心项只能有一个");
    }
}
