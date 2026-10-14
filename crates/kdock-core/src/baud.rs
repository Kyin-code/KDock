//! 波特率选项与校验。

/// UI 里直接列出的标准波特率。
pub const STANDARD_BAUDS: [u32; 12] = [
    300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
];

/// 验收要求必须出现的那几个值。
pub const REQUIRED_BAUDS: [u32; 6] = [9600, 19200, 38400, 57600, 115200, 230400];

/// 波特率上限——再高就不像串口了，用来挡住明显的误输入。
pub const MAX_BAUD: u32 = 4_000_000;

/// 波特率错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BaudError {
    /// 0 或负数（负数在这里以 `TooHigh` 之外的形态不可能出现，因为是 u32）。
    Zero,
    /// 超过 [`MAX_BAUD`]。
    TooHigh(u32),
}

impl std::fmt::Display for BaudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BaudError::Zero => write!(f, "波特率不能为 0"),
            BaudError::TooHigh(v) => write!(f, "波特率 {v} 超出上限 {MAX_BAUD}"),
        }
    }
}

impl std::error::Error for BaudError {}

/// 已校验的波特率——要么是标准值，要么是合法的自定义值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BaudRate(u32);

impl BaudRate {
    pub fn new(value: u32) -> Result<BaudRate, BaudError> {
        if value == 0 {
            return Err(BaudError::Zero);
        }
        if value > MAX_BAUD {
            return Err(BaudError::TooHigh(value));
        }
        Ok(BaudRate(value))
    }

    pub fn value(self) -> u32 {
        self.0
    }

    /// 是否是 UI 列出的标准值之一。
    pub fn is_standard(self) -> bool {
        STANDARD_BAUDS.contains(&self.0)
    }
}

impl std::fmt::Display for BaudRate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// UI 下拉用的标准波特率列表。
pub fn standard_bauds() -> Vec<u32> {
    STANDARD_BAUDS.to_vec()
}

/// 不做构造、只做一次判断时的便捷函数。
pub fn is_valid_baud(value: u32) -> bool {
    BaudRate::new(value).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_bauds_are_offered() {
        let offered = standard_bauds();
        for b in REQUIRED_BAUDS {
            assert!(offered.contains(&b), "缺少必备波特率 {b}");
        }
        assert!(offered.len() >= 8, "至少要有 8 个波特率选项");
    }

    #[test]
    fn custom_baud_is_accepted() {
        let custom = BaudRate::new(250_000).unwrap();
        assert_eq!(custom.value(), 250_000);
        assert!(!custom.is_standard());
    }

    #[test]
    fn zero_and_huge_are_rejected() {
        assert_eq!(BaudRate::new(0), Err(BaudError::Zero));
        assert_eq!(BaudRate::new(MAX_BAUD + 1), Err(BaudError::TooHigh(MAX_BAUD + 1)));
        assert!(!is_valid_baud(0));
        assert!(is_valid_baud(115_200));
    }
}

