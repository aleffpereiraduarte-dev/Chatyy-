//! Servidor `chatyy/1` de REFERÊNCIA (Rust) no loopback + cliente da lib: handshake QUIC+IK,
//! quadros, ping→pong automático, migração (rebind do socket UDP), go_ws, chave pinada errada.
//! Serve também de especificação executável para o leaf Go (mesmo proto.rs).

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use chatyy_net::{proto, Event, Params, Poll};

struct Srv {
    addr: SocketAddr,
    pub_key: [u8; 32],
}

fn server_tls() -> quinn::ServerConfig {
    let ck = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let cert = rustls::pki_types::CertificateDer::from(ck.cert.der().to_vec());
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(rustls::pki_types::PrivatePkcs8KeyDer::from(ck.key_pair.serialize_der()));
    let mut tls = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)
        .unwrap();
    tls.alpn_protocols = vec![proto::ALPN.to_vec()];
    quinn::ServerConfig::with_crypto(Arc::new(quinn::crypto::rustls::QuicServerConfig::try_from(tls).unwrap()))
}

async fn rec(r: &mut quinn::RecvStream) -> Option<Vec<u8>> {
    let mut l = [0u8; 2];
    r.read_exact(&mut l).await.ok()?;
    let mut b = vec![0u8; u16::from_be_bytes(l) as usize];
    r.read_exact(&mut b).await.ok()?;
    Some(b)
}

fn seal(ns: &mut snow::TransportState, pt: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut tmp = vec![0u8; 65535];
    for ch in pt.chunks(proto::NOISE_MAX_PLAIN) {
        let n = ns.write_message(ch, &mut tmp).unwrap();
        out.extend_from_slice(&(n as u16).to_be_bytes());
        out.extend_from_slice(&tmp[..n]);
    }
    out
}

async fn handle(conn: quinn::Connection, sk: [u8; 32]) {
    let mut exp = [0u8; proto::EXPORTER_LEN];
    conn.export_keying_material(&mut exp, proto::EXPORTER_LABEL, proto::EXPORTER_CONTEXT).unwrap();
    let prologue = proto::prologue("test", "t1", &exp);
    let Ok((mut send, mut recv)) = conn.accept_bi().await else { return };
    let mut pre = [0u8; 4];
    if recv.read_exact(&mut pre).await.is_err() || &pre != proto::PREAMBLE_I {
        conn.close(0x105u32.into(), b"bad_preamble");
        return;
    }
    let Some(m1) = rec(&mut recv).await else { return };
    let mut hs = snow::Builder::new(proto::NOISE_PARAMS.parse().unwrap())
        .local_private_key(&sk)
        .prologue(&prologue)
        .build_responder()
        .unwrap();
    let mut pl = vec![0u8; 65535];
    let Ok(n) = hs.read_message(&m1, &mut pl) else {
        conn.close(0x102u32.into(), b"noise_fail");
        return;
    };
    let hello = String::from_utf8(pl[..n].to_vec()).unwrap();
    assert!(hello.starts_with("{\"v\":1,\"dev\":") && hello.contains("\"n\":\"") && hello.contains("\"ts\":"), "{hello}");
    if hello.contains("\"dev\":\"deny-q\"") {
        conn.close(0x101u32.into(), b"go_ws");
        tokio::time::sleep(Duration::from_millis(100)).await;
        return;
    }
    let mut buf = vec![0u8; 65535];
    let n = hs.write_message(b"{\"srv\":\"ref\"}", &mut buf).unwrap();
    let mut m2 = (n as u16).to_be_bytes().to_vec();
    m2.extend_from_slice(&buf[..n]);
    send.write_all(&m2).await.unwrap();
    let mut ns = hs.into_transport_mode().unwrap();
    if hello.contains("\"dev\":\"deny\"") {
        send.write_all(&seal(&mut ns, &proto::encode_close(proto::CLOSE_GO_WS, proto::REASON_GO_WS))).await.unwrap();
        let _ = send.finish();
        tokio::time::sleep(Duration::from_millis(200)).await;
        return;
    }
    send.write_all(&seal(&mut ns, &proto::encode_frame(proto::OP_PING, b"srv-ping"))).await.unwrap();
    let mut parser = proto::FrameParser::default();
    let mut pt = vec![0u8; 65535];
    while let Some(r) = rec(&mut recv).await {
        let n = ns.read_message(&r, &mut pt).unwrap();
        parser.push(&pt[..n]);
        while let Some((op, body)) = parser.next().unwrap() {
            match op {
                proto::OP_TEXT => {
                    let reply = format!("{}|{}", String::from_utf8_lossy(&body), conn.remote_address());
                    send.write_all(&seal(&mut ns, &proto::encode_frame(proto::OP_TEXT, reply.as_bytes()))).await.unwrap();
                }
                proto::OP_BINARY => {
                    send.write_all(&seal(&mut ns, &proto::encode_frame(proto::OP_BINARY, &body))).await.unwrap();
                }
                proto::OP_PONG => {
                    send.write_all(&seal(&mut ns, &proto::encode_frame(proto::OP_TEXT, b"got-pong"))).await.unwrap();
                }
                proto::OP_CLOSE => {
                    let _ = send.write_all(&seal(&mut ns, &body_close(&body))).await;
                    let _ = send.finish();
                    return;
                }
                _ => {}
            }
        }
    }
}

fn body_close(b: &[u8]) -> Vec<u8> {
    let (c, r) = proto::decode_close(b);
    proto::encode_close(c, &r)
}

fn start_server() -> Srv {
    let rt = chatyy_net::runtime();
    let (sk, pk) = chatyy_net::keypair().unwrap();
    let ep = {
        let _g = rt.enter();
        quinn::Endpoint::server(server_tls(), "127.0.0.1:0".parse().unwrap()).unwrap()
    };
    let addr = ep.local_addr().unwrap();
    rt.spawn(async move {
        while let Some(inc) = ep.accept().await {
            tokio::spawn(async move {
                if let Ok(c) = inc.await {
                    handle(c, sk).await;
                }
            });
        }
    });
    Srv { addr, pub_key: pk }
}

fn params(s: &Srv, dev: &str) -> Params {
    let (csk, _) = chatyy_net::keypair().unwrap();
    Params {
        sni: "localhost".into(),
        addr: s.addr,
        region: "test".into(),
        key_id: "t1".into(),
        server_pub: s.pub_key,
        client_priv: csk,
        net_handle: 0,
        connect_timeout: Duration::from_secs(3),
        tls_verify: false,
        keep_alive: Duration::ZERO,
        idle_timeout: Duration::from_secs(10),
        dev: dev.into(),
        ua: "chatyy-net-test".into(),
        version: 1,
        pins: Vec::new(),
        frames: Vec::new(),
        early_count: 0,
        allow_0rtt: false,
    }
}

fn next(c: &chatyy_net::Conn) -> Event {
    loop {
        match c.poll(Duration::from_secs(5)) {
            Poll::Event(Event::Migrated { .. }) => continue,
            Poll::Event(e) => return e,
            Poll::Timeout => panic!("timeout"),
            Poll::Gone => panic!("gone"),
        }
    }
}

fn text(e: Event) -> String {
    match e {
        Event::Frame { op: proto::OP_TEXT, data } => String::from_utf8(data).unwrap(),
        other => panic!("esperava texto, veio {other:?}"),
    }
}

#[test]
fn echo_pong_migrate_close() {
    let s = start_server();
    let c = chatyy_net::Conn::start(params(&s, "dev1"), chatyy_net::runtime());
    match next(&c) {
        Event::Open { hello, hs_ms, .. } => {
            assert_eq!(hello, b"{\"srv\":\"ref\"}");
            assert!(hs_ms < 3000);
        }
        e => panic!("{e:?}"),
    }
    // ping do servidor → pong automático da lib → servidor responde "got-pong"
    assert_eq!(text(next(&c)), "got-pong");

    assert!(c.send(proto::OP_TEXT, b"{\"type\":\"ping\"}".to_vec()));
    let r1 = text(next(&c));
    assert!(r1.starts_with("{\"type\":\"ping\"}|127.0.0.1:"), "{r1}");
    let port1 = r1.rsplit(':').next().unwrap().to_string();

    // quadro grande (> 1 registro Noise)
    let big = vec![0x5Au8; 300_000];
    assert!(c.send(proto::OP_BINARY, big.clone()));
    match next(&c) {
        Event::Frame { op: proto::OP_BINARY, data } => assert_eq!(data, big),
        e => panic!("{e:?}"),
    }

    // migração: socket UDP novo (porta nova) — mesma conexão, sem handshake novo
    {
        let _g = chatyy_net::runtime().enter();
        c.migrate(0).unwrap();
    }
    assert!(c.send(proto::OP_TEXT, b"after".to_vec()));
    let r2 = text(next(&c));
    let port2 = r2.rsplit(':').next().unwrap().to_string();
    assert!(r2.starts_with("after|127.0.0.1:"), "{r2}");
    assert_ne!(port1, port2, "servidor devia ver o endereço novo");

    c.close(1000, "bye", false);
    match next(&c) {
        Event::Closed { code: 1000, remote: false, .. } => {}
        e => panic!("{e:?}"),
    }
    assert!(matches!(c.poll(Duration::from_secs(2)), Poll::Gone));
}

#[test]
fn server_says_go_ws() {
    let s = start_server();
    let c = chatyy_net::Conn::start(params(&s, "deny"), chatyy_net::runtime());
    assert!(matches!(next(&c), Event::Open { .. }));
    match next(&c) {
        Event::Closed { code: proto::CLOSE_GO_WS, reason, remote: true } => assert_eq!(reason, proto::REASON_GO_WS),
        e => panic!("{e:?}"),
    }
}

#[test]
fn server_quic_close_go_ws() {
    let s = start_server();
    let c = chatyy_net::Conn::start(params(&s, "deny-q"), chatyy_net::runtime());
    match next(&c) {
        Event::Error(e) => assert_eq!(e, "qclose 0x101 go_ws"),
        e => panic!("{e:?}"),
    }
}

#[test]
fn wrong_pinned_key_fails() {
    let s = start_server();
    let mut p = params(&s, "dev1");
    p.server_pub = chatyy_net::keypair().unwrap().1; // chave que o servidor não tem
    let c = chatyy_net::Conn::start(p, chatyy_net::runtime());
    match next(&c) {
        Event::Error(e) => assert_eq!(e, "qclose 0x102 noise_fail"),
        e => panic!("devia falhar: {e:?}"),
    }
}

#[test]
fn udp_blackhole_times_out() {
    // porta UDP sem ninguém → sem handshake no prazo (o Kotlin cai para o WSS)
    let sock = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let s = Srv { addr: sock.local_addr().unwrap(), pub_key: [9u8; 32] };
    let mut p = params(&s, "dev1");
    p.connect_timeout = Duration::from_millis(600);
    let c = chatyy_net::Conn::start(p, chatyy_net::runtime());
    match next(&c) {
        Event::Error(e) => assert_eq!(e, "quic_timeout"),
        e => panic!("{e:?}"),
    }
    drop(sock);
}
