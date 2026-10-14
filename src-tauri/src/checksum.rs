//! 文件校验：一次读盘把 CRC16 / CRC32 / MD5 / SHA1 / SHA256 全算出来。
//!
//! 为什么放后端：固件动辄几十上百 MB，一次性读到前端既慢又占内存；
//! 这里按块流式读，顺带支持"只算某个区间"（查固件里某一段是否被改过很有用）。

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use digest::Digest;
use serde_json::{json, Value};

const CHUNK: usize = 1 << 20; // 1 MiB

/// CRC32（IEEE 802.3，和 zip/PNG 那个一样），forward 多项式 0xEDB88320
fn crc16_ccitt(data: &[u8], crc: u16) -> u16 {
    // CCITT-FALSE：init 0xFFFF，poly 0x1021，不反转
    let mut c = crc;
    for b in data {
        c ^= (*b as u16) << 8;
        for _ in 0..8 {
            c = if c & 0x8000 != 0 { (c << 1) ^ 0x1021 } else { c << 1 };
        }
    }
    c
}

/// CRC16/MODBUS：init 0xFFFF，poly 0xA001（反射写法），结果就是线上那两字节
fn crc16_modbus(data: &[u8], crc: u16) -> u16 {
    let mut c = crc;
    for b in data {
        c ^= *b as u16;
        for _ in 0..8 {
            c = if c & 1 != 0 { (c >> 1) ^ 0xA001 } else { c >> 1 };
        }
    }
    c
}

/// 算一个文件（或它的一段）的各种校验值。
/// `offset` / `length` 都给 0 时表示整个文件。
pub fn file_digest(path: &str, offset: u64, length: u64) -> Result<Value, String> {
    let p = Path::new(path);
    let meta = std::fs::metadata(p).map_err(|e| format!("读不到 {}: {e}", p.display()))?;
    if meta.is_dir() {
        return Err("这是个目录，不是文件".into());
    }
    let total = meta.len();
    let start = offset.min(total);
    let want = if length == 0 { total - start } else { length.min(total - start) };

    let f = File::open(p).map_err(|e| format!("打不开 {}: {e}", p.display()))?;
    let mut r = BufReader::with_capacity(CHUNK, f);
    let mut skip = start;
    // 跳过前面 offset 个字节（用读+丢，兼容性最好）
    let mut tmp = vec![0u8; CHUNK.min(64 * 1024)];
    while skip > 0 {
        let want = skip.min(tmp.len() as u64) as usize;
        let n = r.read(&mut tmp[..want]).map_err(|e| format!("读失败: {e}"))?;
        if n == 0 {
            break;
        }
        skip -= n as u64;
    }

    let mut crc32 = crc32fast::Hasher::new();
    let mut c16f: u16 = 0xFFFF;
    let mut c16m: u16 = 0xFFFF;
    let mut md5 = md5::Md5::new();
    let mut sha1 = sha1::Sha1::new();
    let mut sha256 = sha2::Sha256::new();
    let mut left = want;
    let mut buf = vec![0u8; CHUNK];
    while left > 0 {
        let want = left.min(buf.len() as u64) as usize;
        let n = r.read(&mut buf[..want]).map_err(|e| format!("读失败: {e}"))?;
        if n == 0 {
            break;
        }
        let d = &buf[..n];
        crc32.update(d);
        c16f = crc16_ccitt(d, c16f);
        c16m = crc16_modbus(d, c16m);
        md5.update(d);
        sha1.update(d);
        sha256.update(d);
        left -= n as u64;
    }
    let done = want - left;
    let hex = |b: Vec<u8>| b.iter().map(|x| format!("{x:02X}")).collect::<String>();
    let crc32v = crc32.finalize();
    Ok(json!({
        "path": p.to_string_lossy(),
        "size": total,
        "offset": start,
        "length": done,
        "crc32": format!("{crc32v:08X}"),
        "crc32Int": crc32v,
        "crc16Ccitt": format!("{:04X}", c16f),
        "crc16Modbus": format!("{:04X}", c16m),
        "md5": hex(md5.finalize().to_vec()),
        "sha1": hex(sha1.finalize().to_vec()),
        "sha256": hex(sha256.finalize().to_vec()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_of_123456789_matches_the_standard_check_value() {
        let d = b"123456789";
        // 标准检查值（CRC catalog）：CRC16/CCITT-FALSE = 0x29B1，CRC16/MODBUS = 0x4B37
        assert_eq!(crc16_ccitt(d, 0xFFFF), 0x29B1);
        assert_eq!(crc16_modbus(d, 0xFFFF), 0x4B37);
        let mut h = crc32fast::Hasher::new();
        h.update(d);
        assert_eq!(h.finalize(), 0xCBF4_3926); // CRC32 检查值
    }

    #[test]
    fn digest_supports_ranges() {
        let dir = std::env::temp_dir().join("kdock-checksum-test");
        let _ = std::fs::create_dir_all(&dir);
        let f = dir.join("range.bin");
        std::fs::write(&f, b"0123456789").unwrap();
        let all = file_digest(f.to_str().unwrap(), 0, 0).unwrap();
        assert_eq!(all["length"], 10);
        assert_eq!(all["md5"], "781E5E245D69B566979B86E28D23F2C7"); // md5("0123456789")
        let part = file_digest(f.to_str().unwrap(), 5, 5).unwrap();
        assert_eq!(part["offset"], 5);
        assert_eq!(part["length"], 5);
        assert_eq!(part["md5"], "099EBEA48EA9666A7DA2177267983138"); // md5("56789")
        let _ = std::fs::remove_file(&f);
    }
}
