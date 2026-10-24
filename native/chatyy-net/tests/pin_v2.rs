//! chatyy/2 (PROTOCOLO §0.2): TLS SÓ por pin SPKI. Pin errado → erro "pin_mismatch" (o Kotlin NÃO cai
//! para o chatyy/1/WebPKI com esse texto); pin certo → TLS completa (assinatura do handshake conferida
//! pelo rustls com a chave do folha) e o servidor de teste fecha 0x105 depois do handshake.

use std::sync::Arc;
use std::time::Duration;

use chatyy_net::{proto, Event, Params, Poll};

fn start() -> (std::net::SocketAddr, [u8; 32]) {
    let ck = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let cert = rustls::pki_types::CertificateDer::from(ck.cert.der().to_vec());
    let pin = chatyy_net::conn::spki_pin(&cert).unwrap();
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(rustls::pki_types::PrivatePkcs8KeyDer::from(ck.key_pair.serialize_der()));
    let mut tls = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)
        .unwrap();
    tls.alpn_protocols = vec![proto::ALPN2.to_vec()];
    let sc = quinn::ServerConfig::with_crypto(Arc::new(quinn::crypto::rustls::QuicServerConfig::try_from(tls).unwrap()));
    let rt = chatyy_net::runtime();
    let ep = {
        let _g = rt.enter();
        quinn::Endpoint::server(sc, "127.0.0.1:0".parse().unwrap()).unwrap()
    };
    let addr = ep.local_addr().unwrap();
    rt.spawn(async move {
        while let Some(inc) = ep.accept().await {
            tokio::spawn(async move {
                if let Ok(c) = inc.await {
                    c.close(0x105u32.into(), b"bad_preamble");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            });
        }
    });
    (addr, pin)
}

fn params(addr: std::net::SocketAddr, pins: Vec<[u8; 32]>) -> Params {
    Params {
        sni: "localhost".into(),
        addr,
        region: "test".into(),
        key_id: "t1".into(),
        server_pub: chatyy_net::keypair().unwrap().1,
        client_priv: chatyy_net::keypair().unwrap().0,
        net_handle: 0,
        connect_timeout: Duration::from_secs(3),
        tls_verify: true,
        keep_alive: Duration::ZERO,
        idle_timeout: Duration::from_secs(10),
        dev: String::new(),
        ua: "t".into(),
        version: 2,
        pins,
        frames: vec![r#"{"type":"auth","token":"SEGREDO"}"#.into()],
        early_count: 1,
        allow_0rtt: false,
    }
}

fn first_err(p: Params) -> String {
    let c = chatyy_net::Conn::start(p, chatyy_net::runtime());
    loop {
        match c.poll(Duration::from_secs(5)) {
            Poll::Event(Event::Error(e)) => return e,
            Poll::Event(Event::Open { .. }) | Poll::Event(Event::Migrated { .. }) => continue,
            Poll::Event(e) => panic!("{e:?}"),
            Poll::Timeout | Poll::Gone => panic!("sem erro"),
        }
    }
}

#[test]
fn pin_errado_nao_vira_webpki() {
    let (addr, pin) = start();
    let mut bad = pin;
    bad[0] ^= 1;
    let e = first_err(params(addr, vec![bad, [7u8; 32]]));
    assert_eq!(e, "quic: pin_mismatch");
    assert!(!e.contains("SEGREDO"));
}

#[test]
fn pin_certo_completa_tls() {
    let (addr, pin) = start();
    let e = first_err(params(addr, vec![[7u8; 32], pin]));
    assert!(e.contains("0x105"), "{e}");
    assert!(!e.contains("SEGREDO"));
}
