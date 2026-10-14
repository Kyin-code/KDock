//! 行尾处理：CR / LF / CRLF / 无。

/// 发送时使用的行尾。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LineEnding {
    /// 不加任何行尾。
    None,
    /// `\r` (0x0D)
    Cr,
    /// `\n` (0x0A)
    Lf,
    /// `\r\n` (0x0D 0x0A)
    Crlf,
}

/// 去掉文本末尾的换行符（`\r\n` / `\n` / `\r`，连续多个也一起去掉）。
///
/// 发送时行尾**完全由 [`LineEnding`] 决定**，所以用户写在文本框末尾的回车
/// 必须先剥掉；中间的换行不受影响。
pub fn strip_trailing_newlines(text: &str) -> String {
    let mut end = text.len();
    loop {
        let head = &text[..end];
        if head.ends_with("\r\n") {
            end -= 2;
        } else if head.ends_with('\n') || head.ends_with('\r') {
            end -= 1;
        } else {
            break;
        }
    }
    text[..end].to_string()
}

impl LineEnding {
    /// 全部可选项，顺序固定（供 UI 下拉使用）。
    pub const ALL: [LineEnding; 4] = [
        LineEnding::None,
        LineEnding::Cr,
        LineEnding::Lf,
        LineEnding::Crlf,
    ];

    /// 行尾对应的字符串。
    pub fn suffix(self) -> &'static str {
        match self {
            LineEnding::None => "",
            LineEnding::Cr => "\r",
            LineEnding::Lf => "\n",
            LineEnding::Crlf => "\r\n",
        }
    }

    /// 行尾对应的字节。
    pub fn bytes(self) -> &'static [u8] {
        self.suffix().as_bytes()
    }

    /// UI 标签。
    pub fn label(self) -> &'static str {
        match self {
            LineEnding::None => "无",
            LineEnding::Cr => "CR",
            LineEnding::Lf => "LF",
            LineEnding::Crlf => "CRLF",
        }
    }

    /// 从 UI 值解析（大小写不敏感）。
    pub fn parse(s: &str) -> Option<LineEnding> {
        match s.trim().to_ascii_uppercase().as_str() {
            "" | "NONE" | "无" => Some(LineEnding::None),
            "CR" | "\\R" => Some(LineEnding::Cr),
            "LF" | "\\N" => Some(LineEnding::Lf),
            "CRLF" | "\\R\\N" => Some(LineEnding::Crlf),
            _ => None,
        }
    }

    /// 给单行文本追加行尾。
    pub fn apply(self, text: &str) -> String {
        let mut s = String::with_capacity(text.len() + 2);
        s.push_str(text);
        s.push_str(self.suffix());
        s
    }

    /// 多行输入：每一行都补上行尾。
    ///
    /// * 末尾的换行先被剥掉，避免"用户按了回车 + 行尾设置"变成两个换行。
    /// * **中间的换行保留**。
    /// * [`LineEnding::None`] 表示不追加任何东西，此时中间换行原样保留。
    /// * 空输入返回空串。
    pub fn apply_multiline(self, text: &str) -> String {
        let body = strip_trailing_newlines(text);
        if body.is_empty() {
            return String::new();
        }
        match self {
            // 不加行尾 = 什么都不加，中间换行保持原样
            LineEnding::None => body,
            le => {
                let mut out = String::with_capacity(body.len() + 4);
                for (i, line) in body.split('\n').enumerate() {
                    if i > 0 {
                        out.push_str(le.suffix());
                    }
                    out.push_str(line.strip_suffix('\r').unwrap_or(line));
                }
                out.push_str(le.suffix());
                out
            }
        }
    }

    /// 发送路径的唯一入口：文本 -> 实际要写到线上的字节。
    pub fn encode(self, text: &str) -> Vec<u8> {
        self.apply_multiline(text).into_bytes()
    }
}

impl Default for LineEnding {
    fn default() -> Self {
        LineEnding::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffixes_match_spec() {
        assert_eq!(LineEnding::None.suffix(), "");
        assert_eq!(LineEnding::Cr.suffix(), "\r");
        assert_eq!(LineEnding::Lf.suffix(), "\n");
        assert_eq!(LineEnding::Crlf.suffix(), "\r\n");
        assert_eq!(LineEnding::Crlf.bytes(), &[0x0D, 0x0A]);
    }

    #[test]
    fn apply_appends_suffix() {
        assert_eq!(LineEnding::None.apply("AT"), "AT");
        assert_eq!(LineEnding::Cr.apply("AT"), "AT\r");
        assert_eq!(LineEnding::Lf.apply("AT"), "AT\n");
        assert_eq!(LineEnding::Crlf.apply("AT"), "AT\r\n");
    }

    #[test]
    fn multiline_terminates_every_line() {
        assert_eq!(LineEnding::Lf.apply_multiline("a\nb"), "a\nb\n");
        assert_eq!(LineEnding::Crlf.apply_multiline("a\nb"), "a\r\nb\r\n");
        // 结尾多余的换行不产生空行（也不叠加行尾）
        assert_eq!(LineEnding::Crlf.apply_multiline("a\nb\n"), "a\r\nb\r\n");
        // 已经带 CRLF 的输入不会叠加
        assert_eq!(LineEnding::Crlf.apply_multiline("a\r\nb"), "a\r\nb\r\n");
        // 行尾设成"无"时什么都不加，中间的换行原样保留
        assert_eq!(LineEnding::None.apply_multiline("a\nb"), "a\nb");
        assert_eq!(LineEnding::None.apply_multiline("a\nb\n"), "a\nb");
        assert_eq!(LineEnding::None.apply_multiline("a\r\nb\r\n"), "a\r\nb");
        assert_eq!(LineEnding::Crlf.apply_multiline(""), "");
        assert_eq!(LineEnding::Crlf.apply_multiline("\n"), "");
    }

    #[test]
    fn strip_trailing_newlines_only_touches_the_tail() {
        assert_eq!(strip_trailing_newlines("AT"), "AT");
        assert_eq!(strip_trailing_newlines("AT\n"), "AT");
        assert_eq!(strip_trailing_newlines("AT\r\n"), "AT");
        assert_eq!(strip_trailing_newlines("AT\r"), "AT");
        assert_eq!(strip_trailing_newlines("AT\n\n\n"), "AT");
        assert_eq!(strip_trailing_newlines("\n"), "");
        assert_eq!(strip_trailing_newlines(""), "");
        // 中间换行保留
        assert_eq!(strip_trailing_newlines("A\nB"), "A\nB");
        assert_eq!(strip_trailing_newlines("A\nB\n"), "A\nB");
    }

    /// AC-4：行尾设置决定最终发出去的字节。
    #[test]
    fn encode_matches_the_line_ending_setting() {
        // "AT\n" 在 none 下就是 AT；在 crlf 下是 AT\r\n（不是 AT\n\r\n）
        assert_eq!(LineEnding::None.encode("AT\n"), b"AT");
        assert_eq!(LineEnding::Crlf.encode("AT\n"), b"AT\r\n");
        assert_eq!(LineEnding::Crlf.encode("AT\r\n"), b"AT\r\n");
        assert_eq!(LineEnding::Cr.encode("AT\r\n\r\n"), b"AT\r");
        assert_eq!(LineEnding::Lf.encode("AT"), b"AT\n");
        assert_eq!(LineEnding::None.encode("AT"), b"AT");
        assert_eq!(LineEnding::Crlf.encode(""), b"");
        assert_eq!(LineEnding::Crlf.encode("\n"), b"");
        // 多行的中间换行保留
        assert_eq!(LineEnding::None.encode("A\nB"), b"A\nB");
        assert_eq!(LineEnding::Crlf.encode("A\nB\n"), b"A\r\nB\r\n");
        assert_eq!(LineEnding::Lf.encode("A\nB\nC"), b"A\nB\nC\n");
    }

    #[test]
    fn parse_roundtrip() {
        for le in LineEnding::ALL {
            assert_eq!(LineEnding::parse(le.label()), Some(le));
        }
        assert_eq!(LineEnding::parse("crlf"), Some(LineEnding::Crlf));
        assert_eq!(LineEnding::parse(""), Some(LineEnding::None));
        assert_eq!(LineEnding::parse("bogus"), None);
    }
}
