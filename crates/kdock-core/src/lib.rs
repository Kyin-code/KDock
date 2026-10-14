//! 串口调试工具的协议 / 逻辑层。
//!
//! 这一层**不依赖任何 UI 或 Tauri**，可以被独立单测覆盖：
//! * [`hex`]        —— HEX 文本 <-> 字节的编解码，含 ASCII 对照列
//! * [`lineending`] —— CR / LF / CRLF / 无 的行尾处理
//! * [`baud`]       —— 波特率选项与校验（含非标准自定义值）
//! * [`config`]     —— 数据位 / 停止位 / 校验位 / 流控 的组合与到底层串口库的映射
//! * [`session`]    —— 会话日志的落盘 / 回放 / 导出

pub mod baud;
pub mod config;
pub mod hex;
pub mod lineending;
pub mod net;
pub mod session;

pub use baud::{standard_bauds, BaudError, BaudRate, REQUIRED_BAUDS, STANDARD_BAUDS};
pub use config::{
    ConfigError, DataBitsCfg, FlowControlCfg, ParityCfg, PortParams, SerialConfig, StopBitsCfg,
    COMBINATION_COUNT,
};
pub use hex::{ascii_column, bytes_to_hex, bytes_to_hex_compact, hex_to_bytes, HexError};
pub use lineending::{strip_trailing_newlines, LineEnding};
pub use net::{connect_tcp, resolve, NetError, TcpServer, UdpEndpoint};
pub use session::{now_ms, Direction, LogError, LogLine, SessionLog};
