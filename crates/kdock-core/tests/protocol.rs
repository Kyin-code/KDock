//! 跨模块的协议层集成测试（不碰 UI、不碰真实串口）。

use kdock_core::{
    ascii_column, bytes_to_hex, hex_to_bytes, standard_bauds, DataBitsCfg, Direction, FlowControlCfg,
    LineEnding, ParityCfg, SessionLog, SerialConfig, StopBitsCfg, COMBINATION_COUNT,
};

#[test]
fn line_ending_applies_to_hex_send_path() {
    // 用户输入 "AT" + CRLF，HEX 视图里应当就是 41 54 0D 0A
    let wire = LineEnding::Crlf.apply("AT").into_bytes();
    assert_eq!(bytes_to_hex(&wire), "41 54 0D 0A");
    assert_eq!(hex_to_bytes("41 54 0D 0A").unwrap(), wire);
}

#[test]
fn hex_view_roundtrip_with_ascii_column() {
    let payload: Vec<u8> = (0u8..=255).collect();
    let hex = bytes_to_hex(&payload);
    assert_eq!(hex_to_bytes(&hex).unwrap(), payload);
    let ascii = ascii_column(&payload);
    assert_eq!(ascii.len(), payload.len());
    assert!(ascii.starts_with("."));
}

#[test]
fn all_serial_parameter_combinations_validate() {
    let mut n = 0;
    for baud in standard_bauds() {
        let cfg = SerialConfig {
            baud,
            data_bits: DataBitsCfg::Eight,
            stop_bits: StopBitsCfg::One,
            parity: ParityCfg::None,
            flow_control: FlowControlCfg::None,
        };
        assert!(cfg.to_port_params().is_ok());
        n += 1;
    }
    assert!(n >= 8);

    let mut combos = 0;
    for data_bits in DataBitsCfg::ALL {
        for stop_bits in StopBitsCfg::ALL {
            for parity in ParityCfg::ALL {
                for flow_control in FlowControlCfg::ALL {
                    let cfg = SerialConfig {
                        baud: 57_600,
                        data_bits,
                        stop_bits,
                        parity,
                        flow_control,
                    };
                    assert!(cfg.to_port_params().is_ok());
                    combos += 1;
                }
            }
        }
    }
    assert_eq!(combos, COMBINATION_COUNT);
}

#[test]
fn session_log_roundtrip_is_lossless() {
    let mut log = SessionLog::new();
    log.push(1, Direction::Tx, vec![0x41]);
    log.push(2, Direction::Rx, vec![0x01, 0x02, 0x03]);
    let back = SessionLog::from_jsonl(&log.to_jsonl()).unwrap();
    assert_eq!(back, log);
}

