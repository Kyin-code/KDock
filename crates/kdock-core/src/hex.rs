//! HEX 文本与字节之间的编解码。

use std::fmt::Write as _;

/// HEX 解析错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HexError {
    /// 有效十六进制位个数是奇数（例如 `"ABC"`）。
    OddLength(usize),
    /// 出现了非十六进制、也非分隔符的字符。
    InvalidChar(char),
}

impl std::fmt::Display for HexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HexError::OddLength(n) => write!(f, "hex 有效位数为奇数（{n} 位）"),
            HexError::InvalidChar(c) => write!(f, "不是合法的 hex 字符: {c:?}"),
        }
    }
}

impl std::error::Error for HexError {}

/// 允许的分隔符：空白、逗号、下划线。
#[inline]
fn is_separator(c: char) -> bool {
    c.is_whitespace() || c == ',' || c == '_'
}

#[inline]
fn nibble(c: char) -> Option<u8> {
    c.to_digit(16).map(|d| d as u8)
}

/// 把 HEX 字符串解析成字节。
///
/// * 分隔符（空白 / 逗号 / 下划线）会被忽略，`"48 65"`、`"48,65"`、`"4865"` 等价。
/// * 支持 `0x` / `0X` 前缀：`"0x48 0x65"`。
/// * 空串、或只由分隔符组成的串，解析为空字节序列（**不是错误**）。
pub fn hex_to_bytes(input: &str) -> Result<Vec<u8>, HexError> {
    let chars: Vec<char> = input.chars().collect();
    let mut digits: Vec<u8> = Vec::with_capacity(chars.len());

    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        // 跳过 0x / 0X 前缀
        if c == '0' && i + 1 < chars.len() && (chars[i + 1] == 'x' || chars[i + 1] == 'X') {
            i += 2;
            continue;
        }
        if is_separator(c) {
            i += 1;
            continue;
        }
        match nibble(c) {
            Some(d) => digits.push(d),
            None => return Err(HexError::InvalidChar(c)),
        }
        i += 1;
    }

    if digits.len() % 2 != 0 {
        return Err(HexError::OddLength(digits.len()));
    }

    let mut out = Vec::with_capacity(digits.len() / 2);
    for pair in digits.chunks_exact(2) {
        out.push((pair[0] << 4) | pair[1]);
    }
    Ok(out)
}

/// 字节 -> 大写 HEX，字节之间用单个空格分隔：`AA BB CC`。
pub fn bytes_to_hex(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len() * 3);
    for (i, b) in data.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        // 写入 String 不会失败
        let _ = write!(s, "{b:02X}");
    }
    s
}

/// 字节 -> 连续大写 HEX（无分隔）：`AABBCC`。
pub fn bytes_to_hex_compact(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len() * 2);
    for b in data {
        let _ = write!(s, "{b:02X}");
    }
    s
}

/// HEX 视图的 ASCII 对照列：可打印 ASCII（0x20..=0x7E）原样，其余显示 `.`。
pub fn ascii_column(data: &[u8]) -> String {
    data.iter()
        .map(|&b| {
            if (0x20..=0x7E).contains(&b) {
                b as char
            } else {
                '.'
            }
        })
        .collect()
}

/// 单行 HEX + ASCII 对照（给 HEX 视图用）：`48 65 6C 6C 6F   |Hello|`
pub fn hex_line(data: &[u8]) -> String {
    format!("{:<48} |{}|", bytes_to_hex(data), ascii_column(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_is_empty_bytes() {
        assert_eq!(hex_to_bytes("").unwrap(), Vec::<u8>::new());
        assert_eq!(hex_to_bytes("   ").unwrap(), Vec::<u8>::new());
        assert_eq!(hex_to_bytes(" , _ ").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn separators_are_ignored() {
        let expect = vec![0x48, 0x65, 0x6C, 0x6C, 0x6F];
        assert_eq!(hex_to_bytes("48 65 6C 6C 6F").unwrap(), expect);
        assert_eq!(hex_to_bytes("48656C6C6F").unwrap(), expect);
        assert_eq!(hex_to_bytes("48,65,6c,6c,6f").unwrap(), expect);
        assert_eq!(hex_to_bytes("0x48 0x65 0x6C 0x6C 0x6F").unwrap(), expect);
    }

    #[test]
    fn odd_length_is_rejected() {
        assert_eq!(hex_to_bytes("ABC"), Err(HexError::OddLength(3)));
        assert_eq!(hex_to_bytes("4"), Err(HexError::OddLength(1)));
        // 分隔符不计入有效位数
        assert_eq!(hex_to_bytes("A B C"), Err(HexError::OddLength(3)));
    }

    #[test]
    fn invalid_char_is_rejected() {
        assert_eq!(hex_to_bytes("48 6G"), Err(HexError::InvalidChar('G')));
        assert_eq!(hex_to_bytes("zz"), Err(HexError::InvalidChar('z')));
    }

    #[test]
    fn bytes_to_hex_roundtrip() {
        let data: Vec<u8> = (0u8..=255).collect();
        let text = bytes_to_hex(&data);
        assert_eq!(hex_to_bytes(&text).unwrap(), data);
        assert_eq!(hex_to_bytes(&bytes_to_hex_compact(&data)).unwrap(), data);
    }

    #[test]
    fn ascii_column_masks_non_printable() {
        assert_eq!(ascii_column(b"Hello"), "Hello");
        assert_eq!(ascii_column(&[0x00, 0x1F, 0x20, 0x7E, 0x7F]), ".. ~.");
    }
}

