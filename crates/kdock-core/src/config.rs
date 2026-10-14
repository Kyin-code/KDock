//! 串口参数组合，以及到底层串口库（`serialport`）参数结构的映射。

use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, StopBits};

use crate::baud::{BaudError, BaudRate};

/// 数据位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataBitsCfg {
    Five,
    Six,
    Seven,
    Eight,
}

impl DataBitsCfg {
    pub const ALL: [DataBitsCfg; 4] = [
        DataBitsCfg::Five,
        DataBitsCfg::Six,
        DataBitsCfg::Seven,
        DataBitsCfg::Eight,
    ];
    pub fn label(self) -> &'static str {
        match self {
            DataBitsCfg::Five => "5",
            DataBitsCfg::Six => "6",
            DataBitsCfg::Seven => "7",
            DataBitsCfg::Eight => "8",
        }
    }
}

/// 停止位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopBitsCfg {
    One,
    Two,
}

impl StopBitsCfg {
    pub const ALL: [StopBitsCfg; 2] = [StopBitsCfg::One, StopBitsCfg::Two];
    pub fn label(self) -> &'static str {
        match self {
            StopBitsCfg::One => "1",
            StopBitsCfg::Two => "2",
        }
    }
}

/// 校验位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParityCfg {
    None,
    Odd,
    Even,
}

impl ParityCfg {
    pub const ALL: [ParityCfg; 3] = [
        ParityCfg::None,
        ParityCfg::Odd,
        ParityCfg::Even,
    ];
    pub fn label(self) -> &'static str {
        match self {
            ParityCfg::None => "None",
            ParityCfg::Odd => "Odd",
            ParityCfg::Even => "Even",
        }
    }
}

/// 流控。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowControlCfg {
    None,
    Hardware,
    Software,
}

impl FlowControlCfg {
    pub const ALL: [FlowControlCfg; 3] = [
        FlowControlCfg::None,
        FlowControlCfg::Hardware,
        FlowControlCfg::Software,
    ];
    pub fn label(self) -> &'static str {
        match self {
            FlowControlCfg::None => "无",
            FlowControlCfg::Hardware => "硬件 RTS/CTS",
            FlowControlCfg::Software => "软件 XON/XOFF",
        }
    }
}

/// 参数错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    BadBaud(BaudError),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::BadBaud(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ConfigError {}

/// 一次串口打开所需的全部参数。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SerialConfig {
    pub baud: u32,
    pub data_bits: DataBitsCfg,
    pub stop_bits: StopBitsCfg,
    pub parity: ParityCfg,
    pub flow_control: FlowControlCfg,
}

impl Default for SerialConfig {
    fn default() -> Self {
        SerialConfig {
            baud: 115_200,
            data_bits: DataBitsCfg::Eight,
            stop_bits: StopBitsCfg::One,
            parity: ParityCfg::None,
            flow_control: FlowControlCfg::None,
        }
    }
}

/// 映射结果——直接就是底层 `serialport` 库的参数枚举。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortParams {
    pub baud: u32,
    pub data_bits: DataBits,
    pub stop_bits: StopBits,
    pub parity: Parity,
    pub flow_control: FlowControl,
}

impl SerialConfig {
    /// 校验（目前只有波特率可能非法）。
    pub fn validate(&self) -> Result<(), ConfigError> {
        BaudRate::new(self.baud)
            .map(|_| ())
            .map_err(ConfigError::BadBaud)
    }

    /// 映射到底层串口库的参数结构。
    pub fn to_port_params(&self) -> Result<PortParams, ConfigError> {
        self.validate()?;
        Ok(PortParams {
            baud: self.baud,
            data_bits: match self.data_bits {
                DataBitsCfg::Five => DataBits::Five,
                DataBitsCfg::Six => DataBits::Six,
                DataBitsCfg::Seven => DataBits::Seven,
                DataBitsCfg::Eight => DataBits::Eight,
            },
            stop_bits: match self.stop_bits {
                StopBitsCfg::One => StopBits::One,
                StopBitsCfg::Two => StopBits::Two,
            },
            parity: match self.parity {
                ParityCfg::None => Parity::None,
                ParityCfg::Odd => Parity::Odd,
                ParityCfg::Even => Parity::Even,
            },
            flow_control: match self.flow_control {
                FlowControlCfg::None => FlowControl::None,
                FlowControlCfg::Hardware => FlowControl::Hardware,
                FlowControlCfg::Software => FlowControl::Software,
            },
        })
    }

    /// UI 上的一行摘要，例如 `115200 8N1 / 无`。
    pub fn summary(&self) -> String {
        let parity = match self.parity {
            ParityCfg::None => "N",
            ParityCfg::Odd => "O",
            ParityCfg::Even => "E",
        };
        format!(
            "{} {}{}{} / {}",
            self.baud,
            self.data_bits.label(),
            parity,
            self.stop_bits.label(),
            self.flow_control.label()
        )
    }
}

/// 组合总数，测试用。
pub const COMBINATION_COUNT: usize = 4 * 2 * 3 * 3;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_115200_8n1_no_flow() {
        let c = SerialConfig::default();
        assert_eq!(c.summary(), "115200 8N1 / 无");
        let p = c.to_port_params().unwrap();
        assert_eq!(p.baud, 115_200);
        assert_eq!(p.data_bits, DataBits::Eight);
        assert_eq!(p.stop_bits, StopBits::One);
        assert_eq!(p.parity, Parity::None);
        assert_eq!(p.flow_control, FlowControl::None);
    }

    #[test]
    fn every_combination_maps_to_the_library_enums() {
        let mut seen = 0usize;
        for db in DataBitsCfg::ALL {
            for sb in StopBitsCfg::ALL {
                for pa in ParityCfg::ALL {
                    for fc in FlowControlCfg::ALL {
                        let cfg = SerialConfig {
                            baud: 9600,
                            data_bits: db,
                            stop_bits: sb,
                            parity: pa,
                            flow_control: fc,
                        };
                        let p = cfg.to_port_params().expect("组合应当合法");
                        let expect_db = match db {
                            DataBitsCfg::Five => DataBits::Five,
                            DataBitsCfg::Six => DataBits::Six,
                            DataBitsCfg::Seven => DataBits::Seven,
                            DataBitsCfg::Eight => DataBits::Eight,
                        };
                        let expect_sb = match sb {
                            StopBitsCfg::One => StopBits::One,
                            StopBitsCfg::Two => StopBits::Two,
                        };
                        let expect_pa = match pa {
                            ParityCfg::None => Parity::None,
                            ParityCfg::Odd => Parity::Odd,
                            ParityCfg::Even => Parity::Even,
                        };
                        let expect_fc = match fc {
                            FlowControlCfg::None => FlowControl::None,
                            FlowControlCfg::Hardware => FlowControl::Hardware,
                            FlowControlCfg::Software => FlowControl::Software,
                        };
                        assert_eq!(p.data_bits, expect_db);
                        assert_eq!(p.stop_bits, expect_sb);
                        assert_eq!(p.parity, expect_pa);
                        assert_eq!(p.flow_control, expect_fc);
                        seen += 1;
                    }
                }
            }
        }
        assert_eq!(seen, COMBINATION_COUNT);
    }

    #[test]
    fn invalid_baud_is_rejected_before_mapping() {
        let cfg = SerialConfig {
            baud: 0,
            ..SerialConfig::default()
        };
        assert!(cfg.to_port_params().is_err());

        let cfg = SerialConfig {
            baud: crate::baud::MAX_BAUD + 1,
            ..SerialConfig::default()
        };
        assert!(cfg.to_port_params().is_err());
    }

    #[test]
    fn config_survives_json_roundtrip() {
        let cfg = SerialConfig {
            baud: 250_000,
            data_bits: DataBitsCfg::Seven,
            stop_bits: StopBitsCfg::Two,
            parity: ParityCfg::Even,
            flow_control: FlowControlCfg::Software,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"seven\""));
        assert!(json.contains("\"software\""));
        let back: SerialConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg);
    }
}
