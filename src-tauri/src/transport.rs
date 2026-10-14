//! 传输抽象：串口 / TCP / UDP 都收敛成同一个 [`Conn`]。
//!
//! UI 只依赖这一层，命令层里没有任何 `if 是串口 … else if 是 TCP …` 的分支。
//! HEX 编解码与行尾处理不在这一层——它们只有 `kdock-core` 里那一份。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serialport::SerialPort;

use kdock_core::net::{connect_tcp, NetError, TcpServer, UdpEndpoint};
use kdock_core::SerialConfig;

/// 读超时。所有实现都用它，好让 reader 线程周期性检查停止开关。
pub const POLL_TIMEOUT: Duration = Duration::from_millis(50);

/// 读线程的"空闲"判定：这些错误表示**当前没有数据**，不该让读线程退出。
/// 串口、TCP、UDP 三种实现共用这一条判定。
pub fn is_idle_read_error(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
            | std::io::ErrorKind::WouldBlock
    )
}

/// 连接参数。`mode` 决定后面读哪几个字段。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum Endpoint {
    Serial {
        port: String,
        config: SerialConfig,
    },
    TcpClient {
        host: String,
        port: u16,
    },
    TcpServer {
        #[serde(default)]
        host: Option<String>,
        port: u16,
    },
    Udp {
        local_port: u16,
        #[serde(default)]
        remote_host: String,
        #[serde(default)]
        remote_port: u16,
    },
}

impl Endpoint {
    pub fn mode(&self) -> &'static str {
        match self {
            Endpoint::Serial { .. } => "serial",
            Endpoint::TcpClient { .. } => "tcp_client",
            Endpoint::TcpServer { .. } => "tcp_server",
            Endpoint::Udp { .. } => "udp",
        }
    }

    pub fn label(&self) -> String {
        match self {
            Endpoint::Serial { port, config } => format!("{port} @ {}", config.summary()),
            Endpoint::TcpClient { host, port } => format!("TCP {host}:{port}"),
            Endpoint::TcpServer { host, port } => {
                let h = host.clone().unwrap_or_else(|| "0.0.0.0".into());
                format!("TCP 监听 {h}:{port}")
            }
            Endpoint::Udp {
                local_port,
                remote_host,
                remote_port,
            } => {
                if remote_host.is_empty() || *remote_port == 0 {
                    format!("UDP 本地 {local_port}")
                } else {
                    format!("UDP {local_port} <-> {remote_host}:{remote_port}")
                }
            }
        }
    }
}

fn net_to_io(e: NetError) -> std::io::Error {
    // 保留 kind：读超时等"空闲"情况必须能被读线程识别，否则 UDP 读线程
    // 会在第一个空闲 poll 周期就退出。
    match e {
        NetError::Io { kind, msg } => std::io::Error::new(kind, msg),
        other => std::io::Error::new(std::io::ErrorKind::Other, other.to_string()),
    }
}

/// 一条已经建立的双向连接。
pub enum Conn {
    Serial(Box<dyn SerialPort>),
    Tcp(TcpStream),
    Udp(UdpEndpoint),
}

impl Conn {
    /// 给 reader 线程用的复制品。UDP 是共享同一个 socket。
    pub fn try_clone(&self) -> Result<Conn, String> {
        match self {
            Conn::Serial(p) => p
                .try_clone()
                .map(Conn::Serial)
                .map_err(|e| format!("克隆串口句柄失败: {e}")),
            Conn::Tcp(s) => s
                .try_clone()
                .map(Conn::Tcp)
                .map_err(|e| format!("克隆 TCP 连接失败: {e}")),
            Conn::Udp(u) => Ok(Conn::Udp(u.clone())),
        }
    }

    pub fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Conn::Serial(p) => p.read(buf),
            Conn::Tcp(s) => s.read(buf),
            Conn::Udp(u) => u.recv_learn(buf).map_err(net_to_io),
        }
    }

    pub fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        match self {
            Conn::Serial(p) => p.write(data),
            Conn::Tcp(s) => s.write(data),
            Conn::Udp(u) => u.send(data).map_err(net_to_io),
        }
    }

    /// 写满整段：`write` 允许只写进去一部分（串口和 TCP 都会），
    /// 剩下的必须接着写，否则这一段数据就**悄悄丢**了。
    /// 一次 0 字节（真写不进去）直接报错，避免在这儿死循环。
    pub fn write_all(&mut self, data: &[u8]) -> std::io::Result<()> {
        let mut off = 0usize;
        while off < data.len() {
            match self.write(&data[off..])? {
                0 => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WriteZero,
                        "写出去 0 字节",
                    ))
                }
                n => off += n,
            }
        }
        Ok(())
    }

    /// 写出去。串口**一段一段发**：设备那边的 UART 接收没有流控，
    /// 一次性灌几千字节会把它的接收缓冲冲掉(丢字节甚至丢命令)，
    /// 所以按 16 字节 / 2ms 的节奏喂 —— 大约 8KB/s，比 115200 的线速还低一点，
    /// 对长报文不会额外变慢，短报文也几乎无感(像人一个一个敲)。
    pub fn write_paced(&mut self, data: &[u8]) -> std::io::Result<()> {
        const CHUNK: usize = 16;
        const GAP_MS: u64 = 2;
        if !matches!(self, Conn::Serial(_)) {
            self.write_all(data)?;
            return self.flush();
        }
        let mut off = 0;
        while off < data.len() {
            let n = (data.len() - off).min(CHUNK);
            // 每一段都要写满：短写在这里同样会丢字节
            self.write_all(&data[off..off + n])?;
            off += n;
            if off < data.len() {
                std::thread::sleep(std::time::Duration::from_millis(GAP_MS));
            }
        }
        self.flush()
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Conn::Serial(p) => p.flush(),
            Conn::Tcp(s) => s.flush(),
            // UDP 每次 send 就是一个报文，没有缓冲
            Conn::Udp(_) => Ok(()),
        }
    }

    pub fn shutdown(&mut self) {
        if let Conn::Tcp(s) = self {
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
    }

    /// 是不是流式（TCP/串口）传输——流读到 0 字节意味着对端关了。
    pub fn is_stream(&self) -> bool {
        !matches!(self, Conn::Udp(_))
    }

    /// UDP 端点（非 UDP 返回 `None`）。UI 可以据此显示真实绑定的端口。
    pub fn udp(&self) -> Option<&UdpEndpoint> {
        match self {
            Conn::Udp(u) => Some(u),
            _ => None,
        }
    }
}

/// 打开一个「立刻就有连接」的传输：串口 / TCP Client / UDP。
pub fn open_endpoint(endpoint: &Endpoint) -> Result<Conn, String> {
    match endpoint {
        Endpoint::Serial { port, config } => {
            let params = config
                .to_port_params()
                .map_err(|e| format!("串口参数非法: {e}"))?;
            let p = serialport::new(port, params.baud)
                .data_bits(params.data_bits)
                .stop_bits(params.stop_bits)
                .parity(params.parity)
                .flow_control(params.flow_control)
                .timeout(POLL_TIMEOUT)
                .open()
                .map_err(|e| format!("打开 {port} 失败: {e}"))?;
            Ok(Conn::Serial(p))
        }
        Endpoint::TcpClient { host, port } => {
            let s = connect_tcp(host, *port, Duration::from_secs(5)).map_err(|e| e.to_string())?;
            s.set_read_timeout(Some(POLL_TIMEOUT))
                .map_err(|e| format!("设置读超时失败: {e}"))?;
            Ok(Conn::Tcp(s))
        }
        Endpoint::Udp {
            local_port,
            remote_host,
            remote_port,
        } => {
            let ep = UdpEndpoint::bind(*local_port).map_err(|e| e.to_string())?;
            if !remote_host.is_empty() && *remote_port != 0 {
                ep.set_remote(remote_host, *remote_port)
                    .map_err(|e| e.to_string())?;
            }
            ep.set_read_timeout(POLL_TIMEOUT)
                .map_err(|e| format!("设置读超时失败: {e}"))?;
            Ok(Conn::Udp(ep))
        }
        Endpoint::TcpServer { .. } => Err("TCP Server 用 bind_server 打开".into()),
    }
}

/// TCP Server：绑定并监听。
pub fn bind_server(endpoint: &Endpoint) -> Result<TcpServer, String> {
    match endpoint {
        Endpoint::TcpServer { host, port } => {
            let h = host.clone().unwrap_or_else(|| "0.0.0.0".into());
            TcpServer::bind(&h, *port).map_err(|e| e.to_string())
        }
        _ => Err("不是 TCP Server 参数".into()),
    }
}

/// 同一监听 socket 上**反复**收客户端：返回下一个连进来的 stream（每 50ms 检查一次停止开关）。
/// 多客户端 TCP Server 用它，而不是"收一个就把监听丢掉"。
pub fn accept_client(server: &TcpServer, stop: &AtomicBool) -> Option<TcpStream> {
    let _ = server.set_nonblocking(true);
    loop {
        if stop.load(Ordering::Relaxed) {
            return None;
        }
        match server.try_accept() {
            Ok(Some(stream)) => {
                let _ = stream.set_read_timeout(Some(POLL_TIMEOUT));
                return Some(stream);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::ErrorKind;

    /// AC-3 的可观察证据：UDP 的空闲读超时穿到 transport 层之后，
    /// `ErrorKind` 仍然是 `TimedOut`——读线程正是按它判断"空闲"的。
    #[test]
    fn udp_idle_timeout_keeps_its_kind_across_transport_layer() {
        let ep = UdpEndpoint::bind(0).expect("bind");
        ep.set_read_timeout(Duration::from_millis(40)).unwrap();

        let mut buf = [0u8; 16];
        let err = ep.recv(&mut buf).expect_err("空闲时应当读超时");
        assert!(err.is_timeout(), "kdock-core 这一层就该认出超时: {err}");

        let io_err = net_to_io(err);
        assert_eq!(
            io_err.kind(),
            ErrorKind::TimedOut,
            "kind 不能在 transport 层被压成 Other"
        );
        // 与 lib.rs 读线程里的判定完全一致
        assert!(matches!(
            io_err.kind(),
            ErrorKind::TimedOut | ErrorKind::Interrupted | ErrorKind::WouldBlock
        ));
    }

    /// 反过来：真正的错误不能被当成"空闲"悄悄吞掉。
    #[test]
    fn real_errors_are_not_classified_as_idle() {
        let err = serialize_only_error_kind();
        assert!(!matches!(
            err,
            ErrorKind::TimedOut | ErrorKind::Interrupted | ErrorKind::WouldBlock
        ));
    }

    fn serialize_only_error_kind() -> ErrorKind {
        let ep = UdpEndpoint::bind(0).unwrap();
        // 没设置远端时发送是错误，但不是"空闲"
        let e = ep.send(b"x").expect_err("没远端时应当失败");
        assert!(!e.is_idle());
        net_to_io(e).kind()
    }

    /// 端到端（应用层）回归：UDP 连接先空闲若干个 poll 周期，
    /// 读线程判定必须一直认为"空闲"，之后仍然能双向收发。
    #[test]
    fn udp_conn_survives_idle_polls_then_round_trips() {
        let mut a = open_endpoint(&Endpoint::Udp {
            local_port: 0,
            remote_host: String::new(),
            remote_port: 0,
        })
        .expect("open a");
        let mut b = open_endpoint(&Endpoint::Udp {
            local_port: 0,
            remote_host: String::new(),
            remote_port: 0,
        })
        .expect("open b");

        let pa = a.udp().unwrap().local_port();
        let pb = b.udp().unwrap().local_port();
        a.udp().unwrap().set_remote("127.0.0.1", pb).unwrap();
        b.udp().unwrap().set_remote("127.0.0.1", pa).unwrap();

        let mut buf = [0u8; 128];
        let mut idle_polls = 0usize;
        let until = std::time::Instant::now() + POLL_TIMEOUT * 3;
        while std::time::Instant::now() < until {
            match a.read(&mut buf) {
                Ok(n) => panic!("空闲期不该有数据（{n} 字节）"),
                Err(e) if is_idle_read_error(&e) => idle_polls += 1,
                Err(e) => panic!("空闲读超时被当成真错误，读线程会退出: {e}"),
            }
        }
        assert!(idle_polls >= 1, "至少经历一次空闲 poll");

        a.write(b"ping from a").unwrap();
        let n = b.read(&mut buf).expect("a -> b 应当收得到");
        assert_eq!(&buf[..n], b"ping from a");

        b.write(b"pong from b").unwrap();
        let n2 = a.read(&mut buf).expect("b -> a 应当收得到");
        assert_eq!(&buf[..n2], b"pong from b");
    }
}
