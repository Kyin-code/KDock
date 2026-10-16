//! 「屏幕共享」页的后端：VNC（RFB 3.8，含键鼠回传）+ RTSP / RTMP / H.264（交给 FFmpeg 解码）。
//!
//! 设计要点：
//!   · VNC 自己实现 RFB（None / VNC-Auth 两种认证、RAW + CopyRect + DesktopSize 三种编码）。
//!     VNC 的密码是"DES 挑战-应答"，用的是 RustCrypto 的 `des`（Apache-2.0/MIT，纯 Rust）；
//!     密钥按 RFB 规范要求把每个字节的比特反过来再用；
//!   · RTSP / RTMP / H.264 一律交给 ffmpeg **子进程**解码成裸帧（`-f rawvideo -pix_fmt bgra -`），
//!     KDock 不链接 ffmpeg 的库 —— 这样就不受 GPL/LGPL 传染，用户装不装、装哪个版本都行；
//!     确定性输出尺寸（scale + pad）→ Rust 这边按固定帧长读，不依赖探测分辨率；
//!   · 抓到的帧统一走 `rs://frame` 事件（和「桌面捕获」一个形状），前端一套渲染逻辑吃三种源。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::env_setup;

const FFMPEG_EXTRA: &str = "%ENVDIR%\\ffmpeg;%ENVDIR%;%ENVDIR%\\ffmpeg\\bin;C:\\ffmpeg;C:\\ffmpeg\\bin;D:\\ffmpeg;D:\\ffmpeg\\bin;E:\\ffmpeg\\bin;%USERPROFILE%\\ffmpeg;%LOCALAPPDATA%\\Microsoft\\WinGet\\Links";

pub fn find_ffmpeg() -> Option<std::path::PathBuf> {
    if let Some(p) = env_setup::find_tool("ffmpeg.exe", FFMPEG_EXTRA) {
        return Some(p);
    }
    // 顺带认一下 PATH 里的 ffmpeg（有些用户用 scoop/choco 装的）
    env_setup::find_tool("ffmpeg.exe", "")
}

/* ───────────────────────── 会话表 ───────────────────────── */

#[derive(Clone)]
enum VncEvt {
    Pointer { x: u16, y: u16, mask: u8 },
    Key { keysym: u32, down: bool },
}

struct RsSession {
    stop: Arc<AtomicBool>,
    kind: String,
    label: String,
    evt: Option<Sender<VncEvt>>,
    /// 最近一帧（agent 的 screen_shot 要用；界面那条路走 rs://frame 事件）
    last: Arc<Mutex<Option<LastFrame>>>,
}

/// 最近一帧的像素（RGB）。太大就压到 ~200 万像素以内再存，别让 4K 会话吃掉几十 MB。
#[derive(Clone)]
pub struct LastFrame {
    /// 原始桌面尺寸（服务器那头报的）
    pub nat_w: u32,
    pub nat_h: u32,
    /// 实际存下来的尺寸（≤ KEEP_MAX_PX 像素）
    pub w: u32,
    pub h: u32,
    pub rgb: Vec<u8>,
    pub ts: i64,
}

const KEEP_MAX_PX: u64 = 2_000_000;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 把这一帧的 RGB 存成"最近一帧"（超大帧先缩到 KEEP_MAX_PX 以内）
fn store_last(slot: &Arc<Mutex<Option<LastFrame>>>, rgb: Vec<u8>, w: u32, h: u32, nat_w: u32, nat_h: u32) {
    let px = (w as u64) * (h as u64);
    let (rgb, w, h) = if px > KEEP_MAX_PX {
        let k = (KEEP_MAX_PX as f64 / px as f64).sqrt() as f32;
        maybe_scale(rgb, w, h, k.max(0.05))
    } else {
        (rgb, w, h)
    };
    if let Ok(mut g) = slot.lock() {
        *g = Some(LastFrame { nat_w, nat_h, w, h, rgb, ts: now_ms() });
    }
}

/// 把一帧 RGB 画成粗糙的字符画（给看不到图片的 agent 一点版面信息：窗口在哪、有没有变化）
pub fn ascii_preview(rgb: &[u8], w: u32, h: u32, cols: usize, rows: usize) -> String {
    if w == 0 || h == 0 || rgb.len() < (w as usize) * (h as usize) * 3 {
        return String::new();
    }
    let ramp = b" .:-=+*#%@";
    let mut out = String::with_capacity((cols + 1) * rows);
    for r in 0..rows {
        for c in 0..cols {
            let x = (c * w as usize / cols).min(w as usize - 1);
            let y = (r * h as usize / rows).min(h as usize - 1);
            let o = (y * w as usize + x) * 3;
            // 亮度（0.299R + 0.587G + 0.114B）
            let lum = (rgb[o] as u32 * 299 + rgb[o + 1] as u32 * 587 + rgb[o + 2] as u32 * 114) / 1000;
            let k = (lum as usize * (ramp.len() - 1) / 255).min(ramp.len() - 1);
            out.push(ramp[k] as char);
        }
        out.push('\n');
    }
    out
}

static RS_SEQ: AtomicU32 = AtomicU32::new(1);
static RS: LazyLock<Mutex<HashMap<u32, RsSession>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn emit_frame(app: &AppHandle, session: u32, w: u32, h: u32, jpeg: Vec<u8>, fps: f32) {
    let _ = app.emit(
        "rs://frame",
        json!({
            "session": session, "w": w, "h": h, "bytes": jpeg.len(), "fps": fps,
            "data": crate::upgrade::b64_encode(&jpeg),
        }),
    );
}

fn emit_error(app: &AppHandle, session: u32, msg: &str) {
    let _ = app.emit("rs://error", json!({ "session": session, "msg": msg }));
}

fn encode_jpeg(rgb: &[u8], w: u32, h: u32, q: u8) -> Option<Vec<u8>> {
    if w == 0 || h == 0 || rgb.len() < (w as usize) * (h as usize) * 3 {
        return None;
    }
    let mut buf: Vec<u8> = Vec::with_capacity(256 * 1024);
    use image::ImageEncoder;
    let ok = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, q)
        .write_image(rgb, w, h, image::ColorType::Rgb8.into())
        .is_ok();
    if ok && !buf.is_empty() {
        Some(buf)
    } else {
        None
    }
}

/// 想缩小就先缩（VNC 1080p 的 RAW 帧很大，缩一半能省一半带宽+一半 JPEG 时间）
fn maybe_scale(rgb: Vec<u8>, w: u32, h: u32, scale: f32) -> (Vec<u8>, u32, u32) {
    if scale >= 0.999 {
        return (rgb, w, h);
    }
    let tw = (((w as f32) * scale) as u32).max(1);
    let th = (((h as f32) * scale) as u32).max(1);
    match image::RgbImage::from_raw(w, h, rgb) {
        Some(img) => {
            let small = image::imageops::resize(&img, tw, th, image::imageops::FilterType::Triangle);
            (small.into_raw(), tw, th)
        }
        None => (vec![0u8; (tw as usize) * (th as usize) * 3], tw, th),
    }
}

/* ───────────────────────── VNC ───────────────────────── */

struct Rect {
    x: u16,
    y: u16,
    w: u16,
    h: u16,
    enc: i32,
}

fn read_u8(s: &mut TcpStream) -> Result<u8, String> {
    let mut b = [0u8; 1];
    s.read_exact(&mut b).map_err(|e| e.to_string())?;
    Ok(b[0])
}
fn read_u16(s: &mut TcpStream) -> Result<u16, String> {
    let mut b = [0u8; 2];
    s.read_exact(&mut b).map_err(|e| e.to_string())?;
    Ok(u16::from_be_bytes(b))
}
fn read_u32(s: &mut TcpStream) -> Result<u32, String> {
    let mut b = [0u8; 4];
    s.read_exact(&mut b).map_err(|e| e.to_string())?;
    Ok(u32::from_be_bytes(b))
}
fn read_i32(s: &mut TcpStream) -> Result<i32, String> {
    let mut b = [0u8; 4];
    s.read_exact(&mut b).map_err(|e| e.to_string())?;
    Ok(i32::from_be_bytes(b))
}
fn read_exact_n(s: &mut TcpStream, n: usize) -> Result<Vec<u8>, String> {
    let mut v = vec![0u8; n];
    s.read_exact(&mut v).map_err(|e| e.to_string())?;
    Ok(v)
}

/// VNC 密码 → DES 响应：8 字节密钥（不够补 0、每字节比特倒序），16 字节挑战分两块加密
fn vnc_des_response(password: &str, challenge: &[u8]) -> Vec<u8> {
    use des::cipher::array::Array;
    use des::cipher::{BlockCipherEncrypt, KeyInit};
    let mut key = [0u8; 8];
    for (i, b) in password.as_bytes().iter().take(8).enumerate() {
        key[i] = b.reverse_bits(); // RFB 规范：每个字节的比特要反过来
    }
    let key_arr = des::cipher::Key::<des::Des>::try_from(&key[..]).expect("DES 密钥固定 8 字节");
    let cipher = des::Des::new(&key_arr);
    let mut out = Vec::with_capacity(16);
    for chunk in challenge.chunks(8).take(2) {
        let mut blk: des::cipher::Block<des::Des> = Array::default();
        blk.copy_from_slice(&chunk[..chunk.len().min(8)]);
        cipher.encrypt_block(&mut blk);
        out.extend_from_slice(&blk);
    }
    out
}

/// 一次完整的 RFB 握手，成功后返回 (宽, 高, 名字)
/// SetPixelFormat：32bpp / depth24 / 小端 / true-colour（内存里就是 B,G,R,X）
/// 消息结构：type(1) + padding(3) + PixelFormat(16) = 20 字节
fn msg_set_pixel_format() -> Vec<u8> {
    let mut v = vec![0u8, 0, 0, 0];
    v.extend_from_slice(&[32, 24, 0, 1]);
    v.extend_from_slice(&[0, 255, 0, 255, 0, 255]); // max r/g/b（大端 u16）
    v.extend_from_slice(&[16, 8, 0]);               // shift r/g/b
    v.extend_from_slice(&[0, 0, 0]);                // PixelFormat 里的 padding
    v
}

/// SetEncodings：type(2) + padding(1) + 个数(2) + 各编码(4) = 2+2+4n 字节
fn msg_set_encodings(encs: &[i32]) -> Vec<u8> {
    let mut v = vec![2u8, 0];
    v.extend_from_slice(&(encs.len() as u16).to_be_bytes());
    for e in encs {
        v.extend_from_slice(&e.to_be_bytes());
    }
    v
}

/// FramebufferUpdateRequest：type(1) + incremental(1) + x(2) + y(2) + w(2) + h(2) = 10 字节
fn msg_update_request(incremental: bool, x: u16, y: u16, w: u16, h: u16) -> Vec<u8> {
    let mut b = vec![3u8, if incremental { 1 } else { 0 }];
    b.extend_from_slice(&x.to_be_bytes());
    b.extend_from_slice(&y.to_be_bytes());
    b.extend_from_slice(&w.to_be_bytes());
    b.extend_from_slice(&h.to_be_bytes());
    b
}

/// PointerEvent：type(5) + mask(1) + x(2) + y(2) = 6 字节
fn msg_pointer(mask: u8, x: u16, y: u16) -> Vec<u8> {
    let mut b = vec![5u8, mask];
    b.extend_from_slice(&x.to_be_bytes());
    b.extend_from_slice(&y.to_be_bytes());
    b
}

/// KeyEvent：type(4) + down(1) + padding(2) + keysym(4) = 8 字节
fn msg_key(keysym: u32, down: bool) -> Vec<u8> {
    let mut b = vec![4u8, if down { 1 } else { 0 }, 0, 0];
    b.extend_from_slice(&keysym.to_be_bytes());
    b
}

fn vnc_handshake(s: &mut TcpStream, password: &str) -> Result<(u16, u16, String), String> {
    let ver = read_exact_n(s, 12)?;
    let vt = String::from_utf8_lossy(&ver).trim().to_string();
    if !vt.starts_with("RFB ") {
        return Err(format!("对端不像 VNC 服务器（先收到：{vt:?}）"));
    }
    // RFB 3.3 老协议：直接给 4 字节安全类型；3.7/3.8 给一个列表
    let minor: u32 = vt.rsplit('.').next().and_then(|x| x.parse().ok()).unwrap_or(8);
    s.write_all(b"RFB 003.008\n").map_err(|e| e.to_string())?;
    let sec_type: u8;
    if minor <= 3 {
        let t = read_u32(s)?;
        if t == 0 {
            return Err("服务器拒绝了连接（3.3 版没给安全类型）".into());
        }
        sec_type = t as u8;
    } else {
        let n = read_u8(s)?;
        if n == 0 {
            let len = read_u32(s)? as usize;
            let why = read_exact_n(s, len.min(4096)).unwrap_or_default();
            return Err(format!("服务器拒绝：{}", String::from_utf8_lossy(&why)));
        }
        let types = read_exact_n(s, n as usize)?;
        // 能不用密码就不用（None=1）；要密码时有 2 就用 2
        let pick = if !password.is_empty() && types.contains(&2) {
            2
        } else if types.contains(&1) {
            1
        } else if types.contains(&2) {
            2
        } else {
            return Err(format!(
                "这台服务器只支持安全类型 {:?}（KDock 现在支持 None(1) / VNC 密码(2)）",
                types
            ));
        };
        s.write_all(&[pick]).map_err(|e| e.to_string())?;
        sec_type = pick;
    }
    if sec_type == 2 {
        let challenge = read_exact_n(s, 16)?;
        let resp = vnc_des_response(password, &challenge);
        s.write_all(&resp).map_err(|e| e.to_string())?;
    } else if sec_type != 1 {
        return Err(format!("不支持的 VNC 安全类型 {sec_type}"));
    }
    if minor >= 7 {
        let r = read_u32(s)?;
        match r {
            0 => {}
            1 => return Err("VNC 密码不对".into()),
            2 => return Err("VNC 密码试太多次了".into()),
            other => return Err(format!("VNC 认证失败（结果码 {other}）")),
        }
    }
    s.write_all(&[1u8]).map_err(|e| e.to_string())?; // ClientInit：共享连接
    let w = read_u16(s)?;
    let h = read_u16(s)?;
    let _pf = read_exact_n(s, 16)?;
    let name_len = read_u32(s)? as usize;
    let name = String::from_utf8_lossy(&read_exact_n(s, name_len.min(4096))?).to_string();
    s.write_all(&msg_set_pixel_format()).map_err(|e| e.to_string())?;
    s.write_all(&msg_set_encodings(&[0, 1, -223])).map_err(|e| e.to_string())?; // RAW + CopyRect + DesktopSize
    Ok((w, h, name))
}

fn request_update(s: &mut TcpStream, incremental: bool, w: u16, h: u16) -> Result<(), String> {
    s.write_all(&msg_update_request(incremental, 0, 0, w, h)).map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
fn vnc_thread(
    app: AppHandle,
    session: u32,
    stop: Arc<AtomicBool>,
    host: String,
    port: u16,
    password: String,
    fps: u32,
    quality: u8,
    scale: f32,
    view_only: bool,
    last: Arc<Mutex<Option<LastFrame>>>,
    evt: Receiver<VncEvt>,
) {
    let addr = match (host.as_str(), port).to_socket_addrs().ok().and_then(|mut it| it.next()) {
        Some(a) => a,
        None => {
            emit_error(&app, session, &format!("解析不到地址：{host}:{port}"));
            let _ = app.emit("rs://stopped", json!({ "session": session }));
            return;
        }
    };
    let mut tcp = match TcpStream::connect_timeout(&addr, Duration::from_secs(8)) {
        Ok(t) => t,
        Err(e) => {
            emit_error(&app, session, &format!("连不上 VNC {host}:{port} → {e}"));
            let _ = app.emit("rs://stopped", json!({ "session": session }));
            return;
        }
    };
    tcp.set_nodelay(true).ok();
    tcp.set_read_timeout(Some(Duration::from_millis(300))).ok();
    let (mut w, mut h, name) = match vnc_handshake(&mut tcp, &password) {
        Ok(v) => v,
        Err(e) => {
            emit_error(&app, session, &format!("VNC 握手失败：{e}"));
            let _ = app.emit("rs://stopped", json!({ "session": session }));
            return;
        }
    };
    let _ = app.emit("rs://info", json!({ "session": session, "w": w, "h": h, "name": name, "kind": "vnc" }));
    let mut fb = vec![0u8; (w as usize) * (h as usize) * 4];
    let mut need_full = true;
    let frame_ms = (1000 / fps.max(1)) as u64;
    let mut last_emit = Instant::now() - Duration::from_millis(frame_ms);
    // agent 的 screen_shot 用：最多 500ms 存一帧，别每帧都克隆一份原图
    let mut last_store = Instant::now() - Duration::from_millis(1000);
    let mut frames = 0u32;
    let mut fps_t0 = Instant::now();
    let mut cur_fps = 0f32;
    let mut dirty = false;

    while !stop.load(Ordering::Relaxed) {
        // ① 先把用户在这段时间里的键鼠操作发出去
        loop {
            match evt.try_recv() {
                Ok(VncEvt::Pointer { x, y, mask }) => {
                    if !view_only {
                        if tcp.write_all(&msg_pointer(mask, x, y)).is_err() {
                            break;
                        }
                    }
                }
                Ok(VncEvt::Key { keysym, down }) => {
                    if !view_only {
                        if tcp.write_all(&msg_key(keysym, down)).is_err() {
                            break;
                        }
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }
        // ② 要一帧
        if let Err(e) = request_update(&mut tcp, !need_full, w, h) {
            emit_error(&app, session, &format!("请求刷新失败：{e}"));
            break;
        }
        need_full = false;
        // ③ 收消息（一次 framebuffer update 可能分几个 TCP 段；读超时就回去处理键鼠）
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let mt = match read_u8(&mut tcp) {
                Ok(v) => v,
                Err(e) => {
                    let es = e.to_string();
                    if es.contains("timed out") || es.contains("WouldBlock") || es.contains("10060") {
                        break; // 空闲：回去发键鼠/再要一帧
                    }
                    emit_error(&app, session, &format!("连接断了：{es}"));
                    let _ = app.emit("rs://stopped", json!({ "session": session }));
                    return;
                }
            };
            match mt {
                0 => {
                    if read_u8(&mut tcp).is_err() {
                        break;
                    }
                    let nrects = match read_u16(&mut tcp) {
                        Ok(v) => v,
                        Err(_) => break,
                    };
                    for _ in 0..nrects {
                        let rect = match (read_u16(&mut tcp), read_u16(&mut tcp), read_u16(&mut tcp), read_u16(&mut tcp), read_i32(&mut tcp)) {
                            (Ok(x), Ok(y), Ok(rw), Ok(rh), Ok(enc)) => Rect { x, y, w: rw, h: rh, enc },
                            _ => {
                                // 读到一半没数据了：服务器发的东西跟我们理解的对不上（或链路断了）
                                emit_error(&app, session, "读画面更新失败（服务器发的内容对不上，或连接断了）");
                                let _ = app.emit("rs://stopped", json!({ "session": session }));
                                return;
                            }
                        };
                        match rect.enc {
                            0 => {
                                let need = (rect.w as usize) * (rect.h as usize) * 4;
                                let mut data = vec![0u8; need];
                                if tcp.read_exact(&mut data).is_err() {
                                    emit_error(&app, session, "读像素数据失败（连接断了？）");
                                    let _ = app.emit("rs://stopped", json!({ "session": session }));
                                    return;
                                }
                                // 搬进帧缓冲（越界的部分丢掉，别 panic）
                                for row in 0..rect.h as usize {
                                    let fy = rect.y as usize + row;
                                    if fy >= h as usize {
                                        break;
                                    }
                                    let fx = rect.x as usize;
                                    let n = (rect.w as usize).min((w as usize).saturating_sub(fx));
                                    if n == 0 {
                                        continue;
                                    }
                                    let dst = (fy * w as usize + fx) * 4;
                                    fb[dst..dst + n * 4].copy_from_slice(&data[row * rect.w as usize * 4..row * rect.w as usize * 4 + n * 4]);
                                }
                                dirty = true;
                            }
                            1 => {
                                // CopyRect：把已有的一块搬过去（滚动型界面省一大截带宽）
                                let (sx, sy) = match (read_u16(&mut tcp), read_u16(&mut tcp)) {
                                    (Ok(a), Ok(b)) => (a as usize, b as usize),
                                    _ => {
                                        emit_error(&app, session, "读 CopyRect 失败（连接断了？）");
                                        let _ = app.emit("rs://stopped", json!({ "session": session }));
                                        return;
                                    }
                                };
                                let (dx, dy) = (rect.x as usize, rect.y as usize);
                                for row in 0..rect.h as usize {
                                    if dy + row >= h as usize || sy + row >= h as usize {
                                        break;
                                    }
                                    let n = (rect.w as usize).min((w as usize).saturating_sub(dx)).min((w as usize).saturating_sub(sx));
                                    if n == 0 {
                                        continue;
                                    }
                                    let s0 = ((sy + row) * w as usize + sx) * 4;
                                    let d0 = ((dy + row) * w as usize + dx) * 4;
                                    let tmp = fb[s0..s0 + n * 4].to_vec();
                                    fb[d0..d0 + n * 4].copy_from_slice(&tmp);
                                }
                                dirty = true;
                            }
                            -223 => {
                                // DesktopSize：服务器那头的分辨率变了 —— 重建帧缓冲，下一轮要全量
                                w = rect.w.max(1);
                                h = rect.h.max(1);
                                fb = vec![0u8; (w as usize) * (h as usize) * 4];
                                need_full = true;
                                let _ = app.emit("rs://info", json!({ "session": session, "w": w, "h": h, "kind": "vnc" }));
                            }
                            other => {
                                // 不认识的编码：没法安全跳过（不知道长度），只能报错退出
                                emit_error(&app, session, &format!("服务器用了 KDock 还不支持的编码 {other}（到设置里把服务端编码改成 RAW/Hextile 试试）"));
                                let _ = app.emit("rs://stopped", json!({ "session": session }));
                                return;
                            }
                        }
                    }
                    // 一整帧收完 → 转 JPEG 推给界面（按帧率上限压一压）
                    if dirty && last_emit.elapsed().as_millis() as u64 >= frame_ms {
                        let mut rgb = Vec::with_capacity((w as usize) * (h as usize) * 3);
                        for px in fb.chunks_exact(4) {
                            rgb.push(px[2]);
                            rgb.push(px[1]);
                            rgb.push(px[0]);
                        }
                        let (rgb, tw, th) = maybe_scale(rgb, w as u32, h as u32, scale);
                        if let Some(j) = encode_jpeg(&rgb, tw, th, quality) {
                            frames += 1;
                            if fps_t0.elapsed().as_millis() >= 500 {
                                cur_fps = frames as f32 * 1000.0 / fps_t0.elapsed().as_millis() as f32;
                                frames = 0;
                                fps_t0 = Instant::now();
                            }
                            emit_frame(&app, session, tw, th, j, cur_fps);
                        }
                        // 存一份最近一帧：agent 的 screen_shot 从这儿取（界面那条路仍是 rs://frame）
                        if last_store.elapsed().as_millis() >= 500 {
                            store_last(&last, rgb, tw, th, w as u32, h as u32);
                            last_store = Instant::now();
                        }
                        dirty = false;
                        last_emit = Instant::now();
                    }
                    // 帧率上限：不要的帧就别催服务器（否则服务器会把 CPU/带宽全烧在 RAW 上）
                    let spent = last_emit.elapsed().as_millis() as u64;
                    if spent < frame_ms {
                        std::thread::sleep(Duration::from_millis(frame_ms - spent));
                    }
                    break; // 回去处理键鼠，再要下一帧
                }
                1 => {
                    // SetColourMapEntries：读掉不理
                    if read_u8(&mut tcp).is_err() {
                        break;
                    }
                    let n = match (read_u16(&mut tcp), read_u16(&mut tcp)) {
                        (Ok(_), Ok(n)) => n as usize,
                        _ => break,
                    };
                    let _ = read_exact_n(&mut tcp, n * 6);
                }
                2 => {
                    let _ = app.emit("rs://bell", json!({ "session": session }));
                }
                3 => {
                    if read_exact_n(&mut tcp, 3).is_err() {
                        break;
                    }
                    let n = match read_u32(&mut tcp) {
                        Ok(v) => v as usize,
                        Err(_) => break,
                    };
                    let txt = match read_exact_n(&mut tcp, n.min(1 << 20)) {
                        Ok(v) => v,
                        Err(_) => break,
                    };
                    let _ = app.emit("rs://clipboard", json!({ "session": session, "text": String::from_utf8_lossy(&txt) }));
                }
                other => {
                    emit_error(&app, session, &format!("收到不认识的 VNC 消息类型 {other}"));
                    let _ = app.emit("rs://stopped", json!({ "session": session }));
                    return;
                }
            }
        }
    }
    let _ = app.emit("rs://stopped", json!({ "session": session }));
}

/* ───────────────────────── FFmpeg（RTSP / RTMP / H.264） ───────────────────────── */

/// ffmpeg 的参数表（纯函数，方便钉死"到底会跑什么"）：
/// 输入的 rtsp/rtmp/裸流都交给它解，输出**固定尺寸的 BGRA 裸帧**走 stdout ——
/// 尺寸由 scale+pad 钉死，Rust 这边就能按固定帧长读，不用探测分辨率。
fn ffmpeg_args(url: &str, transport: &str, w: u32, h: u32, fps: u32) -> Vec<String> {
    let vf = format!(
        "scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"
    );
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-fflags".into(),
        "nobuffer".into(),
        "-flags".into(),
        "low_delay".into(),
    ];
    if url.to_lowercase().starts_with("rtsp") && transport != "auto" {
        args.push("-rtsp_transport".into());
        args.push(transport.to_string());
    }
    // 本地文件要循环播，网络流不要
    let is_local = !url.contains("://");
    if is_local {
        args.push("-stream_loop".into());
        args.push("-1".into());
    }
    args.extend(["-i".into(), url.to_string(), "-an".into(), "-sn".into(), "-vf".into(), vf, "-r".into(), fps.to_string(), "-f".into(), "rawvideo".into(), "-pix_fmt".into(), "bgra".into(), "-".into()]);
    args
}

#[allow(clippy::too_many_arguments)]
fn ffmpeg_thread(
    app: AppHandle,
    session: u32,
    stop: Arc<AtomicBool>,
    url: String,
    transport: String,
    w: u32,
    h: u32,
    fps: u32,
    quality: u8,
    last: Arc<Mutex<Option<LastFrame>>>,
) {
    let exe = match find_ffmpeg() {
        Some(p) => p,
        None => {
            emit_error(&app, session, "没找到 ffmpeg.exe。到「环境配置 → FFmpeg」点一键安装（RTSP/RTMP/H.264 都靠它解码）");
            let _ = app.emit("rs://stopped", json!({ "session": session }));
            return;
        }
    };
    let args = ffmpeg_args(&url, &transport, w, h, fps);
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(&args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit_error(&app, session, &format!("起 ffmpeg 失败: {e}"));
            let _ = app.emit("rs://stopped", json!({ "session": session }));
            return;
        }
    };
    let stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let errs: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(mut e) = stderr.take() {
        let store = errs.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut acc = String::new();
            loop {
                match e.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                        while let Some(i) = acc.find('\n') {
                            let line = acc[..i].trim().to_string();
                            acc.drain(..=i);
                            if line.is_empty() {
                                continue;
                            }
                            if let Ok(mut g) = store.lock() {
                                g.push(line);
                                if g.len() > 40 {
                                    g.remove(0);
                                }
                            }
                        }
                    }
                }
            }
        });
    }
    let mut out = match stdout {
        Some(o) => o,
        None => {
            emit_error(&app, session, "拿不到 ffmpeg 的输出管");
            return;
        }
    };
    let frame_bytes = (w as usize) * (h as usize) * 4;
    let mut buf = vec![0u8; frame_bytes];
    let mut rgb = vec![0u8; (w as usize) * (h as usize) * 3];
    let frame_ms = (1000 / fps.max(1)) as u64;
    let mut frames = 0u32;
    let mut fps_t0 = Instant::now();
    let mut cur_fps = 0f32;
    let mut last_store = Instant::now() - Duration::from_millis(1000);
    while !stop.load(Ordering::Relaxed) {
        let t0 = Instant::now();
        if out.read_exact(&mut buf).is_err() {
            break;
        }
        for (i, px) in buf.chunks_exact(4).enumerate() {
            rgb[i * 3] = px[2];
            rgb[i * 3 + 1] = px[1];
            rgb[i * 3 + 2] = px[0];
        }
        if let Some(j) = encode_jpeg(&rgb, w, h, quality) {
            frames += 1;
            if fps_t0.elapsed().as_millis() >= 500 {
                cur_fps = frames as f32 * 1000.0 / fps_t0.elapsed().as_millis() as f32;
                frames = 0;
                fps_t0 = Instant::now();
            }
            emit_frame(&app, session, w, h, j, cur_fps);
        }
        // 存一份最近一帧给 agent 的 screen_shot（500ms 一次，别每帧克隆）
        if last_store.elapsed().as_millis() >= 500 {
            store_last(&last, rgb.clone(), w, h, w, h);
            last_store = Instant::now();
        }
        let used = t0.elapsed().as_millis() as u64;
        if used < frame_ms {
            std::thread::sleep(Duration::from_millis(frame_ms - used));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    if let Ok(g) = errs.lock() {
        if !g.is_empty() {
            emit_error(&app, session, &format!("ffmpeg：{}", g.iter().rev().take(3).cloned().collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" | ")));
        }
    }
    let _ = app.emit("rs://stopped", json!({ "session": session }));
}

/* ───────────────────────── 命令 ───────────────────────── */

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn rs_open(
    app: AppHandle,
    kind: String,
    host: Option<String>,
    port: Option<u16>,
    password: Option<String>,
    url: Option<String>,
    fps: Option<u32>,
    quality: Option<u8>,
    scale: Option<f32>,
    size_w: Option<u32>,
    size_h: Option<u32>,
    transport: Option<String>,
    view_only: Option<bool>,
) -> Result<Value, String> {
    let id = RS_SEQ.fetch_add(1, Ordering::Relaxed);
    let stop = Arc::new(AtomicBool::new(false));
    let fps = fps.unwrap_or(15).clamp(1, 60);
    let quality = quality.unwrap_or(70).clamp(20, 95);
    let scale = scale.unwrap_or(1.0);
    let kind = kind.to_lowercase();
    let label = match kind.as_str() {
        "vnc" => {
            let host = host.unwrap_or_default().trim().to_string();
            if host.is_empty() {
                return Err("VNC 要填服务器地址".into());
            }
            let port = port.unwrap_or(5900);
            let (tx, rx) = channel::<VncEvt>();
            let (a2, st2) = (app.clone(), stop.clone());
            let (h2, pw, sc, vo) = (host.clone(), password.unwrap_or_default(), scale, view_only.unwrap_or(false));
            let last = Arc::new(Mutex::new(None));
            let last2 = last.clone();
            std::thread::spawn(move || vnc_thread(a2, id, st2, h2, port, pw, fps, quality, sc, vo, last2, rx));
            RS.lock().expect("rs mutex").insert(id, RsSession { stop, kind: kind.clone(), label: format!("VNC {host}:{port}"), evt: Some(tx), last });
            format!("VNC {host}:{port}")
        }
        "rtsp" | "rtmp" | "h264" | "ffmpeg" => {
            let url = url.unwrap_or_default().trim().to_string();
            if url.is_empty() {
                return Err("要填流地址（rtsp://… / rtmp://… / 本地 .h264 文件路径）".into());
            }
            let w = size_w.unwrap_or(1280).clamp(64, 3840);
            let h = size_h.unwrap_or(720).clamp(64, 2160);
            let tr = transport.unwrap_or_else(|| "tcp".into());
            let (a2, st2, u2) = (app.clone(), stop.clone(), url.clone());
            let last = Arc::new(Mutex::new(None));
            let last2 = last.clone();
            std::thread::spawn(move || ffmpeg_thread(a2, id, st2, u2, tr, w, h, fps, quality, last2));
            RS.lock().expect("rs mutex").insert(id, RsSession { stop, kind: kind.clone(), label: format!("{} {url}", kind.to_uppercase()), evt: None, last });
            format!("{kind} {url}")
        }
        other => return Err(format!("不认识的来源：{other}（vnc / rtsp / rtmp / h264）")),
    };
    Ok(json!({
        "id": id, "label": label,
        "ffmpeg": find_ffmpeg().map(|p| p.to_string_lossy().to_string()),
    }))
}

#[tauri::command]
pub fn rs_stop(id: u32) {
    let mut g = RS.lock().expect("rs mutex");
    if let Some(s) = g.remove(&id) {
        s.stop.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn rs_stop_all() {
    let mut g = RS.lock().expect("rs mutex");
    for (_, s) in g.drain() {
        s.stop.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn rs_list() -> Vec<Value> {
    RS.lock()
        .expect("rs mutex")
        .iter()
        .map(|(id, s)| json!({ "id": id, "kind": s.kind, "label": s.label }))
        .collect()
}

#[tauri::command]
pub fn rs_pointer(id: u32, x: u16, y: u16, mask: u8) -> Result<(), String> {
    let g = RS.lock().expect("rs mutex");
    let s = g.get(&id).ok_or_else(|| format!("会话 {id} 不在"))?;
    if let Some(tx) = &s.evt {
        let _ = tx.send(VncEvt::Pointer { x, y, mask });
    }
    Ok(())
}

#[tauri::command]
pub fn rs_key(id: u32, keysym: u32, down: bool) -> Result<(), String> {
    let g = RS.lock().expect("rs mutex");
    let s = g.get(&id).ok_or_else(|| format!("会话 {id} 不在"))?;
    if let Some(tx) = &s.evt {
        let _ = tx.send(VncEvt::Key { keysym, down });
    }
    Ok(())
}

/// 把某个会话**当前这一帧**存成 PNG —— 给 agent 的 screen_shot 用。
///
/// 为什么要存文件：模型自己看不到像素（Kimi/DeepSeek 这类文本模型）或要交给别的工具看图，
/// 所以这里把帧落到磁盘，同时回一张粗字符画让它至少能判断"窗口在哪、画面变没变"。
#[tauri::command]
pub fn rs_snapshot(id: u32, save_to: Option<String>) -> Result<Value, String> {
    let (label, kind, mut frame) = {
        let g = RS.lock().expect("rs mutex");
        let s = g.get(&id).ok_or_else(|| format!("会话 {id} 不在（先用 screen_open 开一路）"))?;
        let f = s.last.lock().map_err(|_| "帧缓存锁坏了".to_string())?.clone();
        (s.label.clone(), s.kind.clone(), f)
    };
    // 刚开的会话往往还没收到第一帧（VNC 握手 + 首个全量要一两秒）——
    // 这里等一等，别让 agent 刚 screen_open 就白挨一次 "还没收到画面"。
    let mut waited = 0u64;
    while frame.is_none() && waited < 10_000 {
        std::thread::sleep(Duration::from_millis(120));
        waited += 120;
        if let Ok(g) = RS.lock() {
            if let Some(s) = g.get(&id) {
                frame = s.last.lock().map(|x| x.clone()).unwrap_or(None);
            } else {
                break;
            }
        }
    }
    let Some(f) = frame else {
        return Err(format!("{label}：等了 10 秒还没收到画面（服务端没推帧？检查对端 VNC 是不是在共享桌面）"));
    };
    let preview = ascii_preview(&f.rgb, f.w, f.h, 72, 22);
    let img = image::RgbImage::from_raw(f.w, f.h, f.rgb).ok_or("帧数据不完整")?;
    let path = save_to.unwrap_or_else(|| format!("shot_{}.png", now_ms()));
    let bytes = {
        use image::ImageEncoder;
        let mut buf: Vec<u8> = Vec::new();
        image::codecs::png::PngEncoder::new(&mut buf)
            .write_image(img.as_raw(), f.w, f.h, image::ColorType::Rgb8.into())
            .map_err(|e| format!("编码 PNG 失败: {e}"))?;
        std::fs::write(&path, &buf).map_err(|e| format!("写 {path} 失败: {e}"))?;
        buf.len()
    };
    Ok(json!({
        "path": path, "bytes": bytes, "label": label, "kind": kind,
        "w": f.w, "h": f.h, "nat_w": f.nat_w, "nat_h": f.nat_h,
        "age_ms": (now_ms() - f.ts).max(0),
        "preview": preview,
        "hint": "preview 是粗字符画：@ = 亮/白，空格 = 暗/黑；它只能看版面（窗口位置/画面有没有变），读不了文字。",
    }))
}

#[tauri::command]
pub fn rs_ffmpeg() -> Value {
    json!({ "path": find_ffmpeg().map(|p| p.to_string_lossy().to_string()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vnc_des_response_matches_reference() {
        // 对拍：密码 "abc"（密钥 = 0x86,0x46,0xc6,0,0,0,0,0，即每个字节比特倒序），
        // 挑战 = 00 01 … 0f，用 .NET 的 DES(ECB/NoPadding) 独立算出来的应答如下。
        let challenge: Vec<u8> = (0u8..16).collect();
        let got = vnc_des_response("abc", &challenge);
        let want: Vec<u8> = vec![
            0x9c, 0x22, 0xb4, 0xf2, 0x08, 0x8c, 0x34, 0x65, 0xa1, 0x56, 0x2c, 0x4b, 0x9d, 0x6e, 0xdb, 0x04,
        ];
        assert_eq!(got, want, "VNC 的 DES 挑战应答要跟参考实现一致");
    }

    #[test]
    fn raw_vnc_rect_lands_in_framebuffer() {
        // 手工核对 4x2 帧缓冲里第 (1,1) 个像素的搬运
        let (w, h) = (4usize, 2usize);
        let mut fb = vec![0u8; w * h * 4];
        let rect = Rect { x: 1, y: 1, w: 2, h: 1, enc: 0 };
        let data = vec![0x11, 0x22, 0x33, 0xff, 0x44, 0x55, 0x66, 0xff];
        for row in 0..rect.h as usize {
            let fy = rect.y as usize + row;
            let fx = rect.x as usize;
            let n = (rect.w as usize).min(w - fx);
            let dst = (fy * w + fx) * 4;
            fb[dst..dst + n * 4].copy_from_slice(&data[row * rect.w as usize * 4..row * rect.w as usize * 4 + n * 4]);
        }
        assert_eq!(&fb[(1 * w + 1) * 4..(1 * w + 1) * 4 + 4], &[0x11, 0x22, 0x33, 0xff]);
        assert_eq!(&fb[(1 * w + 2) * 4..(1 * w + 2) * 4 + 4], &[0x44, 0x55, 0x66, 0xff]);
    }

    /// RFB 的消息长度是硬约束：服务器按长度解析，多一个字节整条流就废了。
    /// 这里把每条客户端消息的长度钉死（曾经把 SetPixelFormat 少写 3 字节、
    /// FramebufferUpdateRequest 多写 2 字节，都是靠这条测试才发现的）。
    #[test]
    fn rfb_client_message_lengths_match_spec() {
        assert_eq!(msg_set_pixel_format().len(), 20, "SetPixelFormat = 1 + 3 + 16");
        assert_eq!(msg_set_encodings(&[0, 1, -223]).len(), 2 + 2 + 12);
        assert_eq!(msg_update_request(true, 0, 0, 1920, 1080).len(), 10);
        assert_eq!(msg_pointer(1, 300, 400).len(), 6);
        assert_eq!(msg_key(0xff0d, true).len(), 8);
        // 内容也顺手核一下：x/y/w/h 必须是紧跟在 incremental 后面的四个大端 u16
        let m = msg_update_request(false, 0, 0, 320, 240);
        assert_eq!(&m[..4], &[3, 0, 0, 0]);
        assert_eq!(u16::from_be_bytes([m[4], m[5]]), 0);
        assert_eq!(u16::from_be_bytes([m[2], m[3]]), 0);   // x
        assert_eq!(u16::from_be_bytes([m[4], m[5]]), 0);   // y
        assert_eq!(u16::from_be_bytes([m[6], m[7]]), 320); // w
        assert_eq!(u16::from_be_bytes([m[8], m[9]]), 240); // h
        let p = msg_pointer(4, 12, 34);
        assert_eq!(p, vec![5, 4, 0, 12, 0, 34]);
        let k = msg_key(0x41, false);
        assert_eq!(k, vec![4, 0, 0, 0, 0, 0, 0, 0x41]);
    }

    /// 钉死"到底给 ffmpeg 传了什么"：RTSP 要指定传输方式、输出必须是固定尺寸的 BGRA 裸帧、
    /// 本地文件要循环、网络流不能循环。
    #[test]
    fn ffmpeg_args_are_exactly_what_we_expect() {
        let a = ffmpeg_args("rtsp://192.168.1.10:554/s1", "tcp", 1280, 720, 15);
        let s = a.join(" ");
        assert!(s.contains("-rtsp_transport tcp"), "{s}");
        assert!(s.contains("-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2"), "{s}");
        assert!(s.contains("-f rawvideo -pix_fmt bgra -"), "{s}");
        assert!(s.contains("-an -sn"), "音视频只要视频：{s}");
        assert!(!s.contains("-stream_loop"), "网络流不能循环：{s}");
        assert!(s.ends_with("-"), "最后一帧要从 stdout 出来：{s}");

        // 本地文件：循环播 + 不加 rtsp 参数
        let b = ffmpeg_args(r"D:\clip.mp4", "auto", 640, 360, 10).join(" ");
        assert!(b.contains("-stream_loop -1"), "{b}");
        assert!(!b.contains("-rtsp_transport"), "{b}");

        // UDP 模式的 RTSP
        let c = ffmpeg_args("rtsp://x/y", "udp", 640, 360, 10).join(" ");
        assert!(c.contains("-rtsp_transport udp"), "{c}");
        // auto 就不写，交给 ffmpeg 自己协商
        let d = ffmpeg_args("rtsp://x/y", "auto", 640, 360, 10).join(" ");
        assert!(!d.contains("-rtsp_transport"), "{d}");
    }
}
