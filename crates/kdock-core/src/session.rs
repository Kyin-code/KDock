//! 会话日志：落盘 / 重新加载 / 导出 / 回放。

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::hex::{ascii_column, bytes_to_hex, hex_to_bytes};

/// 一条日志的方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Direction {
    /// 本机发出
    Tx,
    /// 从串口收到
    Rx,
    /// 工具自身的事件（打开/关闭/错误）
    Sys,
}

impl Direction {
    pub fn tag(self) -> &'static str {
        match self {
            Direction::Tx => "TX",
            Direction::Rx => "RX",
            Direction::Sys => "SYS",
        }
    }
}

/// 一条日志。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogLine {
    /// 毫秒时间戳（Unix epoch）。
    pub ts_ms: i64,
    pub dir: Direction,
    /// 原始字节。落盘（JSON）时以 HEX 字符串表示，方便人读也方便 diff。
    #[serde(serialize_with = "ser_data", deserialize_with = "de_data")]
    pub data: Vec<u8>,
}

fn ser_data<S: Serializer>(data: &[u8], s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&bytes_to_hex(data))
}

fn de_data<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
    let text = String::deserialize(d)?;
    hex_to_bytes(&text).map_err(serde::de::Error::custom)
}

impl LogLine {
    pub fn new(ts_ms: i64, dir: Direction, data: Vec<u8>) -> Self {
        LogLine { ts_ms, dir, data }
    }
    pub fn hex(&self) -> String {
        bytes_to_hex(&self.data)
    }
    pub fn ascii(&self) -> String {
        ascii_column(&self.data)
    }
}

/// 日志错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogError {
    /// 某一行不是合法 JSON。
    BadJson { line: usize, msg: String },
    /// 某一行的 hex 字段解不开。
    BadHex { line: usize, msg: String },
}

impl std::fmt::Display for LogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LogError::BadJson { line, msg } => write!(f, "第 {line} 行不是合法 JSON: {msg}"),
            LogError::BadHex { line, msg } => write!(f, "第 {line} 行的 hex 字段非法: {msg}"),
        }
    }
}

impl std::error::Error for LogError {}

/// 会话日志。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionLog {
    lines: Vec<LogLine>,
}

impl SessionLog {
    pub fn new() -> Self {
        SessionLog { lines: Vec::new() }
    }

    pub fn push(&mut self, ts_ms: i64, dir: Direction, data: Vec<u8>) {
        self.lines.push(LogLine::new(ts_ms, dir, data));
    }

    pub fn lines(&self) -> &[LogLine] {
        &self.lines
    }

    pub fn len(&self) -> usize {
        self.lines.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    pub fn clear(&mut self) {
        self.lines.clear();
    }

    /// 收/发的总字节数。
    pub fn total_bytes(&self) -> usize {
        self.lines.iter().map(|l| l.data.len()).sum()
    }

    /// 按方向分桶的字节数：`(tx, rx, sys)`。
    pub fn bytes_by_direction(&self) -> (usize, usize, usize) {
        let mut tx = 0;
        let mut rx = 0;
        let mut sys = 0;
        for l in &self.lines {
            match l.dir {
                Direction::Tx => tx += l.data.len(),
                Direction::Rx => rx += l.data.len(),
                Direction::Sys => sys += l.data.len(),
            }
        }
        (tx, rx, sys)
    }

    /// 落盘格式：JSONL，一行一条。
    pub fn to_jsonl(&self) -> String {
        let mut out = String::new();
        for l in &self.lines {
            out.push_str(&serde_json::to_string(l).expect("LogLine 一定能序列化"));
            out.push('\n');
        }
        out
    }

    /// 从 JSONL 重新加载。空行会被忽略。
    pub fn from_jsonl(text: &str) -> Result<SessionLog, LogError> {
        let mut log = SessionLog::new();
        for (idx, raw) in text.lines().enumerate() {
            let line_no = idx + 1;
            if raw.trim().is_empty() {
                continue;
            }
            let value: serde_json::Value = serde_json::from_str(raw).map_err(|e| LogError::BadJson {
                line: line_no,
                msg: e.to_string(),
            })?;
            if let Some(field) = value.get("data") {
                let text = field.as_str().unwrap_or("");
                if hex_to_bytes(text).is_err() {
                    return Err(LogError::BadHex {
                        line: line_no,
                        msg: format!("{text:?} 不是合法 HEX"),
                    });
                }
            }
            let l: LogLine = serde_json::from_value(value).map_err(|e| LogError::BadJson {
                line: line_no,
                msg: e.to_string(),
            })?;
            log.lines.push(l);
        }
        Ok(log)
    }

    /// 导出 CSV：`ts_ms,dir,hex,ascii`。
    pub fn to_csv(&self) -> String {
        let mut out = String::from("ts_ms,dir,hex,ascii\n");
        for l in &self.lines {
            out.push_str(&format!(
                "{},{},{},\"{}\"\n",
                l.ts_ms,
                l.dir.tag(),
                l.hex(),
                l.ascii().replace('"', "\"\"")
            ));
        }
        out
    }

    /// 回放节奏：返回相邻两条之间的间隔（毫秒），按 `speed` 缩放。
    /// `speed <= 0` 视作 1.0。
    pub fn replay_gaps(&self, speed: f64) -> Vec<u64> {
        let speed = if speed > 0.0 { speed } else { 1.0 };
        self.lines
            .windows(2)
            .map(|w| {
                let d = (w[1].ts_ms - w[0].ts_ms).max(0) as f64 / speed;
                d.round().max(0.0) as u64
            })
            .collect()
    }
}

/// 当前毫秒时间戳。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hex::hex_to_bytes;

    fn sample() -> SessionLog {
        let mut log = SessionLog::new();
        log.push(1_000, Direction::Sys, b"open COM3".to_vec());
        log.push(1_010, Direction::Tx, b"AT\r\n".to_vec());
        log.push(1_020, Direction::Rx, b"OK\r\n".to_vec());
        log.push(1_030, Direction::Rx, vec![0x00, 0xFF]);
        log
    }

    #[test]
    fn jsonl_roundtrip_keeps_lines_and_timestamps() {
        let log = sample();
        let text = log.to_jsonl();
        assert_eq!(text.lines().count(), log.len());
        let back = SessionLog::from_jsonl(&text).unwrap();
        assert_eq!(back.len(), log.len());
        assert_eq!(back, log);
        assert_eq!(
            back.lines().iter().map(|l| l.ts_ms).collect::<Vec<_>>(),
            vec![1_000, 1_010, 1_020, 1_030]
        );
    }

    #[test]
    fn jsonl_ignores_blank_lines() {
        let text = "{\"ts_ms\":1,\"dir\":\"RX\",\"data\":\"0A\"}\n\n";
        let log = SessionLog::from_jsonl(text).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log.lines()[0].data, vec![0x0A]);
    }

    #[test]
    fn bad_json_is_reported_with_line_number() {
        let text = "{\"ts_ms\":1,\"dir\":\"RX\",\"data\":\"0A\"}\nnot-json\n";
        match SessionLog::from_jsonl(text) {
            Err(LogError::BadJson { line, .. }) => assert_eq!(line, 2),
            other => panic!("应当报 BadJson，得到 {other:?}"),
        }
    }

    #[test]
    fn bad_hex_is_reported_with_line_number() {
        let text = "{\"ts_ms\":1,\"dir\":\"RX\",\"data\":\"ZZ\"}\n";
        match SessionLog::from_jsonl(text) {
            Err(LogError::BadHex { line, .. }) => assert_eq!(line, 1),
            other => panic!("应当报 BadHex，得到 {other:?}"),
        }
    }

    #[test]
    fn csv_has_header_plus_one_row_per_line() {
        let log = sample();
        let csv = log.to_csv();
        assert!(csv.starts_with("ts_ms,dir,hex,ascii\n"));
        assert_eq!(csv.lines().count(), log.len() + 1);
        assert!(csv.contains("1010,TX,41 54 0D 0A,\"AT..\""));
    }

    #[test]
    fn stats_count_bytes_per_direction() {
        let log = sample();
        let (tx, rx, sys) = log.bytes_by_direction();
        assert_eq!(tx, 4);
        assert_eq!(rx, 6);
        assert_eq!(sys, 9); // "open COM3"
        assert_eq!(log.total_bytes(), 19);
    }

    #[test]
    fn replay_gaps_respect_speed() {
        let log = sample();
        assert_eq!(log.replay_gaps(1.0), vec![10, 10, 10]);
        assert_eq!(log.replay_gaps(2.0), vec![5, 5, 5]);
        assert_eq!(log.replay_gaps(0.0), vec![10, 10, 10]);
    }

    #[test]
    fn hex_helpers_agree_with_hex_module() {
        let log = sample();
        assert_eq!(hex_to_bytes(&log.lines()[1].hex()).unwrap(), b"AT\r\n");
        assert_eq!(log.lines()[2].ascii(), "OK..");
    }
}
