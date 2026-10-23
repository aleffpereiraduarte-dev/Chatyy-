//! Uma conexão `chatyy/1`: QUIC (quinn) → stream 0 → Noise IK (snow) → quadros de app.
//!
//! Modelo de threads: tudo roda no runtime tokio da lib; quem usa (JNI/Kotlin ou o exemplo
//! `probe`) só empurra saídas por canal (`send`/`close`) e PUXA eventos com `poll` bloqueante
//! (sem callback de thread Rust para a JVM — nada de AttachCurrentThread).

use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc as smpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use quinn::{ClientConfig, Connection, Endpoint, EndpointConfig, IdleTimeout, TransportConfig, VarInt};
use tokio::sync::mpsc;

use crate::proto::{self, FrameParser};

#[derive(Clone, Debug)]
pub struct Params {
    /// Nome TLS (SNI) — ex.: api-br.chatyy.com.br.
    pub sni: String,
    /// Endereço já resolvido (o Kotlin resolve na `Network` certa).
    pub addr: SocketAddr,
    pub region: String,
    pub key_id: String,
    /// Chave estática X25519 da região (PINADA no binário).
    pub server_pub: [u8; 32],
    /// Chave estática X25519 do aparelho.
    pub client_priv: [u8; 32],
    /// `Network.getNetworkHandle()` do Android (0 = socket sem amarra).
    pub net_handle: u64,
    pub connect_timeout: Duration,
    /// false = não confere o certificado QUIC-TLS (só aceitável porque o Noise pina a chave do servidor).
    pub tls_verify: bool,
    /// Keepalive do QUIC (0 = desligado: quem pinga é o app, como no WS).
    pub keep_alive: Duration,
    pub idle_timeout: Duration,
    /// `e2ee5_device` do aparelho (vai no payload da msg1, §4.3). Pode ser vazio.
    pub dev: String,
    /// User-Agent curto (ex.: "Chatyy-Android/<versão>").
    pub ua: String,
}

#[derive(Debug)]
pub enum Event {
    /// Noise pronto. `hello` = payload da msg2 do servidor.
    Open { hs_ms: u32, quic_ms: u32, hello: Vec<u8> },
    Frame { op: u8, data: Vec<u8> },
    /// Fim limpo (close de app do servidor ou nosso). `remote` = quem fechou foi o servidor.
    Closed { code: u16, reason: String, remote: bool },
    /// Fim com erro (handshake, Noise, rede, idle). Texto curto, sem dado do usuário.
    Error(String),
    Migrated { ok: bool, why: String },
}

enum Out {
    Frame(u8, Vec<u8>),
    Close(u16, String),
    Abort,
}

pub struct Conn {
    out_tx: mpsc::UnboundedSender<Out>,
    events: Mutex<smpsc::Receiver<Event>>,
    ev_tx: Mutex<Option<smpsc::Sender<Event>>>,
    endpoint: Mutex<Option<Endpoint>>,
    connection: Mutex<Option<Connection>>,
    queued: Arc<AtomicU64>,
    migrations: AtomicU64,
    remote_v6: bool,
    done: Arc<AtomicBool>,
}

pub enum Poll {
    Event(Event),
    Timeout,
    /// Tarefa acabou e todos os eventos já foram lidos.
    Gone,
}

impl Conn {
    pub fn start(p: Params, rt: &tokio::runtime::Runtime) -> Arc<Conn> {
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let (ev_tx, ev_rx) = smpsc::channel();
        let conn = Arc::new(Conn {
            out_tx,
            events: Mutex::new(ev_rx),
            ev_tx: Mutex::new(Some(ev_tx.clone())),
            endpoint: Mutex::new(None),
            connection: Mutex::new(None),
            queued: Arc::new(AtomicU64::new(0)),
            migrations: AtomicU64::new(0),
            remote_v6: p.addr.is_ipv6(),
            done: Arc::new(AtomicBool::new(false)),
        });
        // O Sender guardado no Conn é só para o evento 'Migrated'; sai quando a tarefa acaba.
        let c2 = conn.clone();
        rt.spawn(async move {
            let r = run(&p, &c2, out_rx, &ev_tx).await;
            let ev = match r {
                Ok((code, reason, remote)) => Event::Closed { code, reason, remote },
                Err(e) => Event::Error(e),
            };
            if let Some(cn) = c2.connection.lock().unwrap().take() {
                cn.close(VarInt::from_u32(0), b"");
            }
            c2.done.store(true, Ordering::SeqCst);
            let _ = ev_tx.send(ev);
            c2.ev_tx.lock().unwrap().take();
            // Endpoint: drop depois de um respiro p/ o CONNECTION_CLOSE sair.
            let ep = c2.endpoint.lock().unwrap().take();
            if let Some(ep) = ep {
                let _ = tokio::time::timeout(Duration::from_millis(300), ep.wait_idle()).await;
            }
        });
        conn
    }

    pub fn send(&self, op: u8, data: Vec<u8>) -> bool {
        if self.done.load(Ordering::SeqCst) {
            return false;
        }
        let n = data.len() as u64;
        self.queued.fetch_add(n, Ordering::SeqCst);
        if self.out_tx.send(Out::Frame(op, data)).is_err() {
            self.queued.fetch_sub(n, Ordering::SeqCst);
            return false;
        }
        true
    }

    pub fn close(&self, code: u16, reason: &str, abort: bool) {
        let _ = self.out_tx.send(if abort { Out::Abort } else { Out::Close(code, reason.to_string()) });
    }

    pub fn queued(&self) -> u64 {
        self.queued.load(Ordering::SeqCst)
    }

    pub fn poll(&self, timeout: Duration) -> Poll {
        let rx = self.events.lock().unwrap();
        match rx.recv_timeout(timeout) {
            Ok(e) => Poll::Event(e),
            Err(smpsc::RecvTimeoutError::Timeout) => Poll::Timeout,
            Err(smpsc::RecvTimeoutError::Disconnected) => Poll::Gone,
        }
    }

    /// Troca o socket UDP (rede nova) sem derrubar a conexão: o servidor valida o caminho
    /// novo pelo connection ID (QUIC RFC 9000 §9). Chamar com o runtime "entrado".
    pub fn migrate(&self, net_handle: u64) -> Result<(), String> {
        let ep = self.endpoint.lock().unwrap().clone().ok_or("no_endpoint")?;
        if self.done.load(Ordering::SeqCst) {
            return Err("done".into());
        }
        let sock = new_socket(self.remote_v6, net_handle)?;
        let r = ep.rebind(sock).map_err(|e| format!("rebind: {e}"));
        let ok = r.is_ok();
        if ok {
            self.migrations.fetch_add(1, Ordering::SeqCst);
        }
        if let Some(tx) = self.ev_tx.lock().unwrap().as_ref() {
            let _ = tx.send(Event::Migrated { ok, why: r.as_ref().err().cloned().unwrap_or_default() });
        }
        r
    }

    pub fn stats_json(&self) -> String {
        let migr = self.migrations.load(Ordering::SeqCst);
        let q = self.queued();
        match self.connection.lock().unwrap().as_ref() {
            Some(c) => {
                let s = c.stats();
                format!(
                    "{{\"rttMs\":{},\"migrations\":{},\"queued\":{},\"lost\":{},\"sent\":{},\"txBytes\":{},\"rxBytes\":{},\"cwnd\":{}}}",
                    c.rtt().as_millis(),
                    migr,
                    q,
                    s.path.lost_packets,
                    s.path.sent_packets,
                    s.udp_tx.bytes,
                    s.udp_rx.bytes,
                    s.path.cwnd
                )
            }
            None => format!("{{\"migrations\":{migr},\"queued\":{q}}}"),
        }
    }
}

// ─── socket UDP (amarrado à Network do Android) ─────────────────────────────

#[cfg(target_os = "android")]
mod android_net {
    #[link(name = "android")]
    extern "C" {
        // <android/multinetwork.h>, API 23+. net_handle_t = uint64_t.
        pub fn android_setsocknetwork(network: u64, fd: libc::c_int) -> libc::c_int;
    }
}

fn new_socket(v6: bool, net_handle: u64) -> Result<UdpSocket, String> {
    let bind: SocketAddr = if v6 { "[::]:0".parse().unwrap() } else { "0.0.0.0:0".parse().unwrap() };
    let s = UdpSocket::bind(bind).map_err(|e| format!("bind: {e}"))?;
    #[cfg(target_os = "android")]
    if net_handle != 0 {
        use std::os::fd::AsRawFd;
        let r = unsafe { android_net::android_setsocknetwork(net_handle, s.as_raw_fd()) };
        if r != 0 {
            return Err(format!("setsocknetwork: {}", std::io::Error::last_os_error()));
        }
    }
    #[cfg(not(target_os = "android"))]
    let _ = net_handle;
    Ok(s)
}

// ─── TLS do QUIC ────────────────────────────────────────────────────────────

fn tls_config(verify: bool) -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let b = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| format!("tls: {e}"))?;
    let mut cfg = if verify {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        b.with_root_certificates(roots).with_no_client_auth()
    } else {
        b.dangerous()
            .with_custom_certificate_verifier(Arc::new(NoCertCheck(provider)))
            .with_no_client_auth()
    };
    cfg.alpn_protocols = vec![proto::ALPN.to_vec()];
    cfg.enable_early_data = false; // 0-RTT só na F-N1 (replay)
    Ok(cfg)
}

/// Sem cadeia de certificado (servidor de TESTE com cert próprio). A identidade vem do Noise
/// pinado + exportador no prólogo: um MITM no TLS muda o exportador e o IK falha.
#[derive(Debug)]
struct NoCertCheck(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for NoCertCheck {
    fn verify_server_cert(
        &self,
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        m: &[u8],
        c: &rustls::pki_types::CertificateDer<'_>,
        d: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &rustls::pki_types::CertificateDer<'_>,
        d: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

// ─── a conexão ──────────────────────────────────────────────────────────────

type CloseInfo = (u16, String, bool);

fn conn_err(e: quinn::ConnectionError) -> String {
    match e {
        // §6: CloseWithError do servidor antes da sessão (0x101 go_ws, 0x102 noise_fail, …).
        quinn::ConnectionError::ApplicationClosed(a) => {
            format!("qclose {:#x} {}", a.error_code.into_inner(), String::from_utf8_lossy(&a.reason))
        }
        quinn::ConnectionError::TimedOut => "idle_timeout".into(),
        quinn::ConnectionError::Reset => "reset".into(),
        other => format!("{other}"),
    }
}

async fn read_record(r: &mut quinn::RecvStream, buf: &mut Vec<u8>) -> Result<bool, String> {
    let mut lb = [0u8; 2];
    match r.read_exact(&mut lb).await {
        Ok(()) => {}
        Err(quinn::ReadExactError::FinishedEarly(0)) => return Ok(false),
        Err(quinn::ReadExactError::FinishedEarly(_)) => return Err("eof_mid_record".into()),
        Err(quinn::ReadExactError::ReadError(quinn::ReadError::ConnectionLost(e))) => return Err(conn_err(e)),
        Err(e) => return Err(format!("read: {e}")),
    }
    let n = u16::from_be_bytes(lb) as usize;
    buf.resize(n, 0);
    match r.read_exact(&mut buf[..]).await {
        Ok(()) => Ok(true),
        Err(quinn::ReadExactError::ReadError(quinn::ReadError::ConnectionLost(e))) => Err(conn_err(e)),
        Err(e) => Err(format!("read: {e}")),
    }
}

fn seal_records(noise: &Mutex<snow::TransportState>, pt: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(pt.len() + (pt.len() / proto::NOISE_MAX_PLAIN + 1) * (2 + proto::NOISE_TAG));
    let mut tmp = vec![0u8; proto::NOISE_MAX_MSG];
    let mut ns = noise.lock().unwrap();
    for ch in pt.chunks(proto::NOISE_MAX_PLAIN) {
        let n = ns.write_message(ch, &mut tmp).map_err(|e| format!("noise_seal: {e}"))?;
        out.extend_from_slice(&(n as u16).to_be_bytes());
        out.extend_from_slice(&tmp[..n]);
    }
    Ok(out)
}

async fn run(
    p: &Params,
    me: &Arc<Conn>,
    mut out_rx: mpsc::UnboundedReceiver<Out>,
    ev: &smpsc::Sender<Event>,
) -> Result<CloseInfo, String> {
    let t0 = Instant::now();
    let deadline = t0 + p.connect_timeout;

    let sock = new_socket(p.addr.is_ipv6(), p.net_handle)?;
    let ep = Endpoint::new(EndpointConfig::default(), None, sock, Arc::new(quinn::TokioRuntime))
        .map_err(|e| format!("endpoint: {e}"))?;
    *me.endpoint.lock().unwrap() = Some(ep.clone());

    let qtls = quinn::crypto::rustls::QuicClientConfig::try_from(tls_config(p.tls_verify)?)
        .map_err(|e| format!("quic_tls: {e}"))?;
    let mut tc = TransportConfig::default();
    tc.max_idle_timeout(Some(IdleTimeout::try_from(p.idle_timeout).map_err(|_| "idle")?));
    tc.keep_alive_interval(if p.keep_alive.is_zero() { None } else { Some(p.keep_alive) });
    let mut cc = ClientConfig::new(Arc::new(qtls));
    cc.transport_config(Arc::new(tc));

    let connecting = ep.connect_with(cc, p.addr, &p.sni).map_err(|e| format!("connect: {e}"))?;
    let conn = match tokio::time::timeout_at(deadline.into(), connecting).await {
        Err(_) => return Err("quic_timeout".into()),
        Ok(Err(e)) => return Err(format!("quic: {}", conn_err(e))),
        Ok(Ok(c)) => c,
    };
    *me.connection.lock().unwrap() = Some(conn.clone());
    let quic_ms = t0.elapsed().as_millis() as u32;

    // Prólogo = ALPN || região || id da chave || exportador TLS (channel binding).
    let mut exp = [0u8; proto::EXPORTER_LEN];
    conn.export_keying_material(&mut exp, proto::EXPORTER_LABEL, proto::EXPORTER_CONTEXT)
        .map_err(|_| "exporter")?;
    let prologue = proto::prologue(&p.region, &p.key_id, &exp);

    let hs_fut = async {
        let (mut send, mut recv) = conn.open_bi().await.map_err(|e| format!("open_bi: {}", conn_err(e)))?;
        let mut hs = snow::Builder::new(proto::NOISE_PARAMS.parse().map_err(|_| "noise_params")?)
            .local_private_key(&p.client_priv)
            .remote_public_key(&p.server_pub)
            .prologue(&prologue)
            .build_initiator()
            .map_err(|e| format!("noise_init: {e}"))?;
        let mut buf = vec![0u8; proto::NOISE_MAX_MSG];
        let mut nonce = [0u8; 16];
        getrandom::getrandom(&mut nonce).map_err(|_| "rng")?;
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let payload = proto::msg1_payload(&p.dev, &p.ua, ts, &nonce);
        let n = hs.write_message(&payload, &mut buf).map_err(|e| format!("noise_w1: {e}"))?;
        // preâmbulo "CY" 01 'I' + msg1 na mesma escrita (§2, §4.3)
        let mut rec = Vec::with_capacity(n + 6);
        rec.extend_from_slice(proto::PREAMBLE_I);
        rec.extend_from_slice(&(n as u16).to_be_bytes());
        rec.extend_from_slice(&buf[..n]);
        send.write_all(&rec).await.map_err(|e| format!("write: {e}"))?;
        let mut m2 = Vec::new();
        if !read_record(&mut recv, &mut m2).await? {
            return Err("eof_in_handshake".to_string());
        }
        let mut pl = vec![0u8; m2.len()];
        // Falha aqui = chave da região errada/MITM: NÃO cair p/ "sem Noise" (downgrade).
        let pn = hs.read_message(&m2, &mut pl).map_err(|_| "noise_auth_failed".to_string())?;
        pl.truncate(pn);
        let ts = hs.into_transport_mode().map_err(|e| format!("noise_tm: {e}"))?;
        Ok::<_, String>((send, recv, ts, pl))
    };
    let (mut send, mut recv, ts, hello) = match tokio::time::timeout_at(deadline.into(), hs_fut).await {
        Err(_) => return Err("noise_timeout".into()),
        Ok(r) => r?,
    };
    let noise = Arc::new(Mutex::new(ts));
    let _ = ev.send(Event::Open { hs_ms: t0.elapsed().as_millis() as u32, quic_ms, hello });

    // Leitor: registros → quadros → eventos. Ping do servidor é respondido aqui.
    let (pong_tx, mut pong_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let ev_r = ev.clone();
    let noise_r = noise.clone();
    let mut reader = tokio::spawn(async move {
        let mut parser = FrameParser::default();
        let mut rec = Vec::new();
        let mut pt = vec![0u8; proto::NOISE_MAX_MSG];
        loop {
            if !read_record(&mut recv, &mut rec).await? {
                return Ok::<CloseInfo, String>((1006, "eof".into(), true));
            }
            let n = noise_r.lock().unwrap().read_message(&rec, &mut pt).map_err(|_| "noise_open".to_string())?;
            parser.push(&pt[..n]);
            while let Some((op, body)) = parser.next().map_err(|e| e.0.to_string())? {
                match op {
                    proto::OP_CLOSE => {
                        let (c, r) = proto::decode_close(&body);
                        return Ok((c, r, true));
                    }
                    proto::OP_PING => {
                        let _ = pong_tx.send(body);
                    }
                    proto::OP_PONG => {}
                    _ => {
                        if ev_r.send(Event::Frame { op, data: body }).is_err() {
                            return Ok((1001, "gone".into(), false));
                        }
                    }
                }
            }
        }
    });

    let queued = me.queued.clone();
    loop {
        tokio::select! {
            r = &mut reader => {
                return match r {
                    Ok(x) => x,
                    Err(_) => Err("reader_panic".into()),
                };
            }
            pg = pong_rx.recv() => {
                if let Some(body) = pg {
                    let rec = seal_records(&noise, &proto::encode_frame(proto::OP_PONG, &body))?;
                    send.write_all(&rec).await.map_err(|e| format!("write: {e}"))?;
                }
            }
            m = out_rx.recv() => match m {
                Some(Out::Frame(op, data)) => {
                    let n = data.len() as u64;
                    let rec = seal_records(&noise, &proto::encode_frame(op, &data));
                    queued.fetch_sub(n, Ordering::SeqCst);
                    send.write_all(&rec?).await.map_err(|e| format!("write: {e}"))?;
                }
                Some(Out::Close(code, reason)) => {
                    if let Ok(rec) = seal_records(&noise, &proto::encode_close(code, &reason)) {
                        let _ = tokio::time::timeout(Duration::from_millis(500), send.write_all(&rec)).await;
                    }
                    let _ = send.finish();
                    // Espera curta pelo eco/fim do servidor (como o close do WS).
                    let _ = tokio::time::timeout(Duration::from_millis(300), &mut reader).await;
                    reader.abort();
                    conn.close(VarInt::from_u32(0), reason.as_bytes());
                    return Ok((code, reason, false));
                }
                Some(Out::Abort) | None => {
                    reader.abort();
                    conn.close(VarInt::from_u32(0), b"abort");
                    return Ok((1006, "abort".into(), false));
                }
            }
        }
    }
}
