//! TCP / UDP 回环测试。全部在同进程内完成，不需要任何硬件。

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use kdock_core::net::{connect_tcp, TcpServer, UdpEndpoint};

const T: Duration = Duration::from_secs(3);

/// AC-1 / AC-3 回归测试。
///
/// 旧代码里 `UdpEndpoint::recv` 把读超时压成了通用 IO 错误（kind 丢失），
/// 上层再包一层就变成 `ErrorKind::Other`，读线程匹配不到 TimedOut，
/// 于是**在第一个空闲 poll 周期就退出**，接收永久失效。
/// 这条测试模拟读线程：只把"空闲"当成继续，其余错误一律视为读线程死亡。
#[test]
fn ac1_udp_survives_idle_poll_then_receives() {
    let poll = Duration::from_millis(60);

    let a = UdpEndpoint::bind(0).expect("bind a");
    let b = UdpEndpoint::bind(0).expect("bind b");
    a.set_read_timeout(poll).unwrap();
    a.set_remote("127.0.0.1", b.local_port()).unwrap();
    b.set_remote("127.0.0.1", a.local_port()).unwrap();

    let mut buf = [0u8; 128];
    let mut idle_polls = 0usize;
    let until = Instant::now() + poll * 3;
    while Instant::now() < until {
        match a.recv(&mut buf) {
            Ok((n, _)) => panic!("空闲期不该收到数据（收到 {n} 字节）"),
            Err(e) if e.is_idle() => {
                assert!(e.is_timeout(), "空闲错误应当来自读超时: {e}");
                idle_polls += 1;
            }
            Err(e) => panic!("空闲读超时被当成致命错误，读线程会因此退出: {e}"),
        }
    }
    assert!(idle_polls >= 1, "至少要经历一次读超时，实际 {idle_polls} 次");

    // 空闲之后双向仍然可用——旧代码就在这里挂掉
    b.send(b"after idle: b->a").unwrap();
    let (n, _) = a.recv(&mut buf).expect("空闲之后应当还能收到");
    assert_eq!(&buf[..n], b"after idle: b->a");

    a.send(b"after idle: a->b").unwrap();
    b.set_read_timeout(poll * 5).unwrap();
    let mut buf2 = [0u8; 128];
    let (n2, _) = b.recv(&mut buf2).expect("反向也应当能收到");
    assert_eq!(&buf2[..n2], b"after idle: a->b");
}

/// 非致命错误的三种情况都要被认成"空闲"，读线程才不会误退出。
#[test]
fn ac3_idle_classification_covers_timeout_and_nonblocking() {
    use kdock_core::net::NetError;
    use std::io::ErrorKind;

    assert!(NetError::io(ErrorKind::TimedOut, "x").is_idle());
    assert!(NetError::io(ErrorKind::WouldBlock, "x").is_idle());
    assert!(NetError::io(ErrorKind::Interrupted, "x").is_idle());
    assert!(!NetError::io(ErrorKind::ConnectionReset, "x").is_idle());
    assert!(!NetError::io(ErrorKind::Other, "x").is_idle());
}

// AC-4：同进程内起 TCP Server + Client，双向收发，断言内容一致。
#[test]
fn ac4_tcp_loopback_roundtrip() {
    let server = TcpServer::bind("127.0.0.1", 0).expect("server bind");
    let port = server.local_port();

    let handle = std::thread::spawn(move || {
        let mut stream = server.accept().expect("accept");
        stream.set_read_timeout(Some(T)).unwrap();
        stream.write_all(b"hello from server").unwrap();
        stream.flush().unwrap();

        let mut buf = [0u8; 128];
        let n = stream.read(&mut buf).unwrap();
        buf[..n].to_vec()
    });

    let mut client = connect_tcp("127.0.0.1", port, T).expect("client connect");
    client.set_read_timeout(Some(T)).unwrap();

    let mut buf = [0u8; 128];
    let n = client.read(&mut buf).unwrap();
    assert_eq!(&buf[..n], b"hello from server");

    client.write_all(b"hello from client").unwrap();
    client.flush().unwrap();

    assert_eq!(handle.join().unwrap(), b"hello from client");
}

// AC-5：同进程内两个 UDP socket 互发，断言内容一致。
#[test]
fn ac5_udp_loopback_roundtrip() {
    let a = UdpEndpoint::bind(0).expect("bind a");
    let b = UdpEndpoint::bind(0).expect("bind b");
    a.set_read_timeout(T).unwrap();
    b.set_read_timeout(T).unwrap();

    a.set_remote("127.0.0.1", b.local_port()).unwrap();
    a.send(b"udp from a").unwrap();

    let mut buf = [0u8; 128];
    let (n, from) = b.recv(&mut buf).unwrap();
    assert_eq!(&buf[..n], b"udp from a");
    assert_eq!(from.port(), a.local_port());

    b.set_remote("127.0.0.1", a.local_port()).unwrap();
    b.send(b"udp from b").unwrap();

    let mut buf2 = [0u8; 128];
    let (n2, _) = a.recv(&mut buf2).unwrap();
    assert_eq!(&buf2[..n2], b"udp from b");
}

// UDP 未配置远端时，收包后自动把发送方记为远端。
#[test]
fn udp_learns_remote_from_first_packet() {
    let a = UdpEndpoint::bind(0).unwrap();
    let b = UdpEndpoint::bind(0).unwrap();
    a.set_read_timeout(T).unwrap();
    b.set_remote("127.0.0.1", a.local_port()).unwrap();
    b.send(b"ping").unwrap();

    let mut buf = [0u8; 32];
    let n = a.recv_learn(&mut buf).unwrap();
    assert_eq!(&buf[..n], b"ping");
    assert_eq!(a.remote().unwrap().port(), b.local_port());
}

// AC-6：可以绑定指定的监听端口；端口被占用时给出可读错误而不是 panic。
#[test]
fn ac6_explicit_port_and_occupied_port_error() {
    let probe = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = probe.local_addr().unwrap().port();

    // 端口被占用 -> Err，且消息里能看到端口号
    let err = TcpServer::bind("127.0.0.1", port).expect_err("占用端口应当失败");
    let msg = err.to_string();
    assert!(msg.contains(&port.to_string()), "错误信息应包含端口: {msg}");
    assert!(msg.contains("绑定"), "错误信息应当可读: {msg}");

    drop(probe);

    // 释放后用显式端口号绑定成功，并且端口就是指定的那个
    let server = TcpServer::bind("127.0.0.1", port).expect("释放后应当能绑定");
    assert_eq!(server.local_port(), port);
    assert_eq!(server.local_addr().port(), port);
}

// AC-7：能连到指定的 host:port；连不上时报可读错误。
#[test]
fn ac7_connect_to_configured_host_port() {
    let server = TcpServer::bind("127.0.0.1", 0).unwrap();
    let port = server.local_port();

    let handle = std::thread::spawn(move || {
        let _stream = server.accept().unwrap();
    });

    let client = connect_tcp("127.0.0.1", port, T).expect("应当能连上指定端口");
    assert_eq!(client.peer_addr().unwrap().port(), port);
    handle.join().unwrap();

    // 无人监听的端口：应当是 Err 而不是 panic
    let probe = TcpListener::bind("127.0.0.1:0").unwrap();
    let dead = probe.local_addr().unwrap().port();
    drop(probe);
    let err = connect_tcp("127.0.0.1", dead, Duration::from_millis(800)).expect_err("应当连不上");
    assert!(err.to_string().contains("连接"), "错误的可读性: {err}");

    // 域名解析失败：同样是可读的 Err
    let err = connect_tcp("no-such-host.invalid", 1234, Duration::from_millis(500))
        .expect_err("非法主机名应当失败");
    assert!(err.to_string().contains("无法解析"), "错误的可读性: {err}");
}
