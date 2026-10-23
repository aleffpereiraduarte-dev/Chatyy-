//! Cliente de QA no host (worker NJ) contra o leaf de teste — o MESMO código da .so do Android.
//!
//!   cargo run --release --example probe -- <sni> <ip> <porta> <região> <kid> <pub_b64> [opções]
//!     --insecure          não confere o certificado (servidor de teste com cert próprio; Noise segue pinado)
//!     --auth-file <f>     1º frame de texto (JSON `{"type":"auth",...}`), igual ao do WS
//!     --migrate <s>       troca o socket UDP (rebind) depois de <s> segundos e manda um ping JSON
//!     --secs <s>          quanto tempo fica escutando (padrão 10)
//!     --dev <id>          e2ee5_device no payload da msg1
//! Saída: 1 linha por evento (frames de texto cortados em 200 caracteres; nada de token).

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use chatyy_net::{proto, Event, Params, Poll};

fn b64d(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => continue,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.len() < 6 {
        eprintln!("uso: probe <sni> <ip> <porta> <região> <kid> <pub_b64> [--insecure] [--auth-file f] [--migrate s] [--secs s] [--dev id]");
        std::process::exit(2);
    }
    let opt = |k: &str| a.iter().position(|x| x == k).and_then(|i| a.get(i + 1)).cloned();
    let addr: SocketAddr = SocketAddr::new(a[1].parse().expect("ip"), a[2].parse().expect("porta"));
    let pk: [u8; 32] = b64d(&a[5]).try_into().expect("pub = 32 bytes b64");
    let (csk, cpk) = chatyy_net::keypair().unwrap();
    println!("client_pub {}", proto::b64(&cpk));
    let p = Params {
        sni: a[0].clone(),
        addr,
        region: a[3].clone(),
        key_id: a[4].clone(),
        server_pub: pk,
        client_priv: csk,
        net_handle: 0,
        connect_timeout: Duration::from_secs(5),
        tls_verify: !a.iter().any(|x| x == "--insecure"),
        keep_alive: Duration::ZERO,
        idle_timeout: Duration::from_secs(60),
        dev: opt("--dev").unwrap_or_default(),
        ua: format!("chatyy-net-probe/{}", env!("CARGO_PKG_VERSION")),
    };
    let secs: u64 = opt("--secs").and_then(|s| s.parse().ok()).unwrap_or(10);
    let migrate: Option<u64> = opt("--migrate").and_then(|s| s.parse().ok());
    let auth = opt("--auth-file").map(|f| std::fs::read_to_string(f).expect("auth-file"));
    let t0 = Instant::now();
    let c = chatyy_net::Conn::start(p, chatyy_net::runtime());
    let (mut migrated, mut closing) = (false, false);
    loop {
        if !closing && t0.elapsed() > Duration::from_secs(secs) {
            closing = true;
            c.close(1000, "bye", false);
        }
        if let (Some(m), false) = (migrate, migrated) {
            if t0.elapsed() > Duration::from_secs(m) {
                migrated = true;
                let _g = chatyy_net::runtime().enter();
                println!("{:>6} ms MIGRATE {:?}", t0.elapsed().as_millis(), c.migrate(0));
                c.send(proto::OP_TEXT, b"{\"type\":\"ping\",\"after\":\"migrate\"}".to_vec());
            }
        }
        let ms = t0.elapsed().as_millis();
        match c.poll(Duration::from_millis(250)) {
            Poll::Timeout => continue,
            Poll::Gone => break,
            Poll::Event(Event::Open { hs_ms, quic_ms, hello }) => {
                println!("{ms:>6} ms OPEN quic={quic_ms}ms noise+quic={hs_ms}ms msg2={}", String::from_utf8_lossy(&hello));
                if let Some(au) = &auth {
                    c.send(proto::OP_TEXT, au.trim().as_bytes().to_vec());
                }
                c.send(proto::OP_TEXT, b"{\"type\":\"ping\"}".to_vec());
            }
            Poll::Event(Event::Frame { op, data }) => {
                let t = String::from_utf8_lossy(&data);
                let t: String = t.chars().take(200).collect();
                println!("{ms:>6} ms FRAME op={op:#x} len={} {t}", data.len());
            }
            Poll::Event(e) => println!("{ms:>6} ms {e:?} stats={}", c.stats_json()),
        }
    }
}
