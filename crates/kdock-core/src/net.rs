//! TCP / UDP 传输层。
//!
//! 纯 std 实现，不依赖任何 UI 或 Tauri，也不重复实现 HEX / 行尾处理——
//! 那些仍然只在 [`crate::hex`] 与 [`crate::lineending`] 里有一份。

use std::fmt;
use std::io::ErrorKind;
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use socket2::{Domain, Protocol, Socket, Type};

/// 网络层错误。所有分支都带可读消息，不会 panic。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetError {
    /// 主机名 / 地址解析失败。
    BadAddress { text: String, msg: String },
    /// 绑定本地端口失败（例如端口被占用）。
    Bind { addr: String, msg: String },
    /// 连接远端失败。
    Connect { addr: String, msg: String },
    /// 其它 IO 错误。**保留 [`ErrorKind`]**，这样"读超时"这类
    /// 非致命情况在往上传递时不会被误判成真错误。
    Io { kind: ErrorKind, msg: String },
}

impl NetError {
    /// 构造一个保留 kind 的 IO 错误。
    pub fn io(kind: ErrorKind, msg: impl Into<String>) -> NetError {
        NetError::Io {
            kind,
            msg: msg.into(),
        }
    }

    /// 包住一个真实的 `std::io::Error`，保留它的 kind。
    pub fn from_io(e: &std::io::Error, ctx: &str) -> NetError {
        NetError::Io {
            kind: e.kind(),
            msg: format!("{ctx}: {e}"),
        }
    }

    pub fn kind(&self) -> Option<ErrorKind> {
        match self {
            NetError::Io { kind, .. } => Some(*kind),
            _ => None,
        }
    }

    /// 读超时（空闲）。
    pub fn is_timeout(&self) -> bool {
        matches!(self.kind(), Some(ErrorKind::TimedOut))
    }

    /// 读线程应当忽略、继续轮询的情况：空闲超时 / 被信号打断 / 非阻塞无数据。
    pub fn is_idle(&self) -> bool {
        matches!(
            self.kind(),
            Some(ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted)
        )
    }
}

impl fmt::Display for NetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NetError::BadAddress { text, msg } => write!(f, "地址 {text} 无法解析: {msg}"),
            NetError::Bind { addr, msg } => write!(f, "绑定 {addr} 失败: {msg}"),
            NetError::Connect { addr, msg } => write!(f, "连接 {addr} 失败: {msg}"),
            NetError::Io { msg, .. } => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for NetError {}

/// 解析 `host:port` 中的第一个地址。
pub fn resolve(host: &str, port: u16) -> Result<SocketAddr, NetError> {
    let text = format!("{host}:{port}");
    let mut addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| NetError::BadAddress {
            text: text.clone(),
            msg: e.to_string(),
        })?;
    addrs.next().ok_or(NetError::BadAddress {
        text,
        msg: "解析不到任何地址".into(),
    })
}

/// TCP 监听端。
#[derive(Debug, Clone)]
pub struct TcpServer {
    listener: Arc<TcpListener>,
    addr: SocketAddr,
}

impl TcpServer {
    /// 绑定并开始监听。端口填 0 表示由系统分配。
    pub fn bind(host: &str, port: u16) -> Result<TcpServer, NetError> {
        let addr = resolve(host, port)?;
        let listener = TcpListener::bind(addr).map_err(|e| NetError::Bind {
            addr: addr.to_string(),
            msg: e.to_string(),
        })?;
        let addr = listener
            .local_addr()
            .map_err(|e| NetError::from_io(&e, "读取本地地址失败"))?;
        Ok(TcpServer {
            listener: Arc::new(listener),
            addr,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn local_port(&self) -> u16 {
        self.addr.port()
    }

    pub fn set_nonblocking(&self, on: bool) -> Result<(), NetError> {
        self.listener
            .set_nonblocking(on)
            .map_err(|e| NetError::from_io(&e, "设置非阻塞失败"))
    }

    /// 阻塞接受一个连接。
    pub fn accept(&self) -> Result<TcpStream, NetError> {
        self.listener
            .accept()
            .map(|(s, _)| s)
            .map_err(|e| NetError::from_io(&e, "accept 失败"))
    }

    /// 非阻塞接受：没连接时返回 `Ok(None)`。
    pub fn try_accept(&self) -> Result<Option<TcpStream>, NetError> {
        match self.listener.accept() {
            Ok((s, _)) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
            Err(e) => Err(NetError::from_io(&e, "accept 失败")),
        }
    }
}

/// 作为客户端连接指定的 `host:port`。
pub fn connect_tcp(host: &str, port: u16, timeout: Duration) -> Result<TcpStream, NetError> {
    let addr = resolve(host, port)?;
    TcpStream::connect_timeout(&addr, timeout).map_err(|e| NetError::Connect {
        addr: addr.to_string(),
        msg: e.to_string(),
    })
}

/// 从指定本机网卡地址发起 TCP 连接。`local_host` 为空时按系统路由选择。
pub fn connect_tcp_from(
    local_host: &str,
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<TcpStream, NetError> {
    if local_host.trim().is_empty() {
        return connect_tcp(host, port, timeout);
    }
    let local_ip = local_host
        .trim()
        .parse::<IpAddr>()
        .map_err(|e| NetError::BadAddress {
            text: local_host.to_string(),
            msg: e.to_string(),
        })?;
    // 本机选的是 IPv4 就只连 IPv4，选 IPv6 就只连 IPv6：
    // 双栈主机名（比如 localhost）解析出的第一个地址未必同族，bind 会直接报 family 不支持。
    let remote = (host, port)
        .to_socket_addrs()
        .map_err(|e| NetError::BadAddress {
            text: format!("{host}:{port}"),
            msg: e.to_string(),
        })?
        .find(|a| a.is_ipv4() == local_ip.is_ipv4())
        .ok_or_else(|| NetError::BadAddress {
            text: format!("{host}:{port}"),
            msg: format!("没有与本机地址 {local_ip} 同族的地址"),
        })?;
    let local = SocketAddr::new(local_ip, 0);
    let domain = if local.is_ipv4() {
        Domain::IPV4
    } else {
        Domain::IPV6
    };
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))
        .map_err(|e| NetError::from_io(&e, "创建 TCP socket 失败"))?;
    socket.bind(&local.into()).map_err(|e| NetError::Bind {
        addr: local.to_string(),
        msg: e.to_string(),
    })?;
    socket
        .connect_timeout(&remote.into(), timeout)
        .map_err(|e| NetError::Connect {
            addr: remote.to_string(),
            msg: format!("经本机 {local} 连接失败: {e}"),
        })?;
    Ok(socket.into())
}

/// UDP 端点。内部用 `Arc` 共享 socket，因此 `clone()` 得到的是同一个端点，
/// 可以同时给读线程和写端用。
#[derive(Clone)]
pub struct UdpEndpoint {
    socket: Arc<UdpSocket>,
    remote: Arc<Mutex<Option<SocketAddr>>>,
    local: SocketAddr,
}

impl fmt::Debug for UdpEndpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UdpEndpoint")
            .field("local", &self.local)
            .field("remote", &self.remote())
            .finish()
    }
}

impl UdpEndpoint {
    /// 绑定 `0.0.0.0:local_port`。端口填 0 表示由系统分配。
    pub fn bind(local_port: u16) -> Result<UdpEndpoint, NetError> {
        UdpEndpoint::bind_host("0.0.0.0", local_port)
    }

    pub fn bind_host(host: &str, local_port: u16) -> Result<UdpEndpoint, NetError> {
        let addr = match host.parse::<IpAddr>() {
            Ok(ip) => SocketAddr::new(ip, local_port),
            Err(_) => resolve(host, local_port)?,
        };
        let socket = UdpSocket::bind(addr).map_err(|e| NetError::Bind {
            addr: addr.to_string(),
            msg: e.to_string(),
        })?;
        let local = socket
            .local_addr()
            .map_err(|e| NetError::from_io(&e, "读取本地地址失败"))?;
        Ok(UdpEndpoint {
            socket: Arc::new(socket),
            remote: Arc::new(Mutex::new(None)),
            local,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }

    pub fn local_port(&self) -> u16 {
        self.local.port()
    }

    pub fn remote(&self) -> Option<SocketAddr> {
        *self.remote.lock().expect("remote mutex")
    }

    pub fn set_remote(&self, host: &str, port: u16) -> Result<(), NetError> {
        let addr = resolve(host, port)?;
        *self.remote.lock().expect("remote mutex") = Some(addr);
        Ok(())
    }

    pub fn set_read_timeout(&self, timeout: Duration) -> Result<(), NetError> {
        self.socket
            .set_read_timeout(Some(timeout))
            .map_err(|e| NetError::from_io(&e, "设置读超时失败"))
    }

    pub fn socket(&self) -> &UdpSocket {
        &self.socket
    }

    pub fn send_to(&self, data: &[u8], addr: SocketAddr) -> Result<usize, NetError> {
        self.socket
            .send_to(data, addr)
            .map_err(|e| NetError::from_io(&e, "UDP 发送失败"))
    }

    /// 发往已配置的远端。
    pub fn send(&self, data: &[u8]) -> Result<usize, NetError> {
        let addr = self
            .remote()
            .ok_or_else(|| NetError::io(ErrorKind::NotConnected, "UDP 还没有设置远端地址"))?;
        self.send_to(data, addr)
    }

    /// 收一个报文。读超时会以 `ErrorKind::TimedOut` 的形式返回，
    /// 调用方据此判断"当前没有数据"，而不是把它当成致命错误。
    pub fn recv(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr), NetError> {
        self.socket
            .recv_from(buf)
            .map_err(|e| NetError::from_io(&e, "UDP 接收失败"))
    }

    /// 收数据；如果此前没配置远端，就把发送方记成远端（UDP 调试常见用法）。
    pub fn recv_learn(&self, buf: &mut [u8]) -> Result<usize, NetError> {
        let (n, from) = self.recv(buf)?;
        let mut remote = self.remote.lock().expect("remote mutex");
        if remote.is_none() {
            *remote = Some(from);
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tcp_client_can_bind_to_a_selected_local_address() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let port = listener.local_addr().expect("local addr").port();
        let accept = std::thread::spawn(move || listener.accept().expect("accept"));
        let client = connect_tcp_from("127.0.0.1", "127.0.0.1", port, Duration::from_secs(2))
            .expect("connect from local address");
        let (server, _) = accept.join().expect("accept thread");
        assert_eq!(client.local_addr().unwrap().ip().to_string(), "127.0.0.1");
        drop(server);
    }

    #[test]
    fn udp_can_bind_to_a_selected_local_address() {
        let ep = UdpEndpoint::bind_host("127.0.0.1", 0).expect("bind udp");
        assert_eq!(ep.local_addr().ip().to_string(), "127.0.0.1");
    }
}
