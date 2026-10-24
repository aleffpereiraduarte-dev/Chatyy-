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
    /// 1 = chatyy/1 (WebPKI, msg1 sem frames, cliente espera a msg2 p/ mandar);
    /// 2 = chatyy/2 (PROTOCOLO §0: TLS SÓ por pin SPKI, frames dentro da msg1, msg2 com auth_success).
    pub version: u8,
    /// chatyy/2: SHA-256 do SPKI do certificado folha aceitos (atual + próximo).
    pub pins: Vec<[u8; 32]>,
    /// Frames de texto do WS p/ a 1ª ida (o 1º = auth). chatyy/2 'I': todos (até caber) dentro da msg1;
    /// retomada 'E': só o prefixo `early_count` (idempotentes, §5); o resto sai depois da msg2.
    pub frames: Vec<String>,
    pub early_count: usize,
    /// chatyy/2: tentar retomada QUIC 0-RTT + IK modo 'E' quando houver ticket desta região.
    pub allow_0rtt: bool,
}

#[derive(Debug)]
pub enum Event {
    /// Fio pronto p/ o app mandar. chatyy/1 e 'E': depois da msg2 (`hello` = Accept).
    /// chatyy/2 'I': logo que a msg1 (com o auth dentro) saiu, no flight do Finished — `hello` vazio,
    /// o Accept vem em [Event::Accept]. `mode` = b'I' | b'E'.
    Open { hs_ms: u32, quic_ms: u32, hello: Vec<u8>, version: u8, mode: u8 },
    /// chatyy/2 'I': msg2 (Accept) chegou — o servidor a segura até o auth_success (§0.3).
    Accept { ms: u32, hello: Vec<u8> },
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
        if self.done.load(Ordering::SeqCst) || data.len() > proto::MAX_FRAME {
            return false; // §3: > 1 MiB o servidor fecha 1009 — recusa já, sem gastar o fio
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

/// Config TLS/QUIC CACHEADA por (versão, pins, verify, 0-RTT): o cache de sessão do rustls mora nela,
/// então reusar o mesmo Arc é o que guarda o ticket p/ a retomada 'E' (§0.6).
fn quic_client_config(version: u8, pins: &[[u8; 32]], verify: bool, early: bool) -> Result<Arc<quinn::crypto::rustls::QuicClientConfig>, String> {
    type Key = (u8, Vec<[u8; 32]>, bool, bool);
    static CACHE: std::sync::OnceLock<Mutex<std::collections::HashMap<Key, Arc<quinn::crypto::rustls::QuicClientConfig>>>> = std::sync::OnceLock::new();
    let key: Key = (version, pins.to_vec(), verify, early);
    let m = CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    if let Some(c) = m.lock().unwrap().get(&key) {
        return Ok(c.clone());
    }
    let tls = if version == 2 { tls_config_pinned(pins, early)? } else { tls_config(verify)? };
    let q = Arc::new(quinn::crypto::rustls::QuicClientConfig::try_from(tls).map_err(|e| format!("quic_tls: {e}"))?);
    m.lock().unwrap().insert(key, q.clone());
    Ok(q)
}

/// chatyy/2: SEM WebPKI — só o pin SPKI do folha (§0.2). Pin fora da lista → aborta o TLS.
fn tls_config_pinned(pins: &[[u8; 32]], early: bool) -> Result<rustls::ClientConfig, String> {
    if pins.is_empty() {
        return Err("no_pins".into());
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| format!("tls: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinCheck { pins: pins.to_vec(), provider }))
        .with_no_client_auth();
    cfg.alpn_protocols = vec![proto::ALPN2.to_vec()];
    cfg.enable_early_data = early;
    Ok(cfg)
}

pub fn spki_pin(cert: &rustls::pki_types::CertificateDer<'_>) -> Option<[u8; 32]> {
    let ee = webpki::EndEntityCert::try_from(cert).ok()?;
    let spki = ee.subject_public_key_info();
    ring::digest::digest(&ring::digest::SHA256, spki.as_ref()).as_ref().try_into().ok()
}

#[derive(Debug)]
struct PinCheck {
    pins: Vec<[u8; 32]>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl rustls::client::danger::ServerCertVerifier for PinCheck {
    fn verify_server_cert(
        &self,
        ee: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        match spki_pin(ee) {
            Some(h) if self.pins.iter().any(|p| *p == h) => Ok(rustls::client::danger::ServerCertVerified::assertion()),
            Some(_) => Err(rustls::Error::InvalidCertificate(rustls::CertificateError::ApplicationVerificationFailure)),
            None => Err(rustls::Error::InvalidCertificate(rustls::CertificateError::BadEncoding)),
        }
    }
    // A assinatura do handshake (CertificateVerify) continua conferida com a chave do certificado pinado.
    fn verify_tls12_signature(
        &self,
        m: &[u8],
        c: &rustls::pki_types::CertificateDer<'_>,
        d: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.provider.signature_verification_algorithms)
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &rustls::pki_types::CertificateDer<'_>,
        d: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.provider.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

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
        // TLS recusado AQUI (cliente): no chatyy/2 o único verificador é o PinCheck → pin/assinatura.
        // Texto fixo p/ o Kotlin NÃO cair para o chatyy/1 (WebPKI) nesse caso (anti-downgrade).
        quinn::ConnectionError::TransportError(t) if t.code == quinn::TransportErrorCode::crypto(49) => "pin_mismatch".into(),
        quinn::ConnectionError::TransportError(t) if t.code == quinn::TransportErrorCode::crypto(51) => "pin_tls_sig_bad".into(),
        quinn::ConnectionError::TransportError(t) if t.code == quinn::TransportErrorCode::crypto(50) => "pin_bad_cert".into(),
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
        Err(quinn::ReadExactError::ReadError(quinn::ReadError::ZeroRttRejected)) => return Err(ZRTT_REJ.into()),
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

const ZRTT_REJ: &str = "0rtt_rejected";

fn write_err(e: quinn::WriteError) -> String {
    match e {
        quinn::WriteError::ZeroRttRejected => ZRTT_REJ.into(),
        quinn::WriteError::ConnectionLost(c) => conn_err(c),
        other => format!("write: {other}"),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct Hs {
    send: quinn::SendStream,
    recv: quinn::RecvStream,
    hs: snow::HandshakeState,
}

/// Abre o stream 0 e manda "CY" v modo | u16 | msg1 NUM write só.
async fn hs_start(conn: &Connection, p: &Params, version: u8, mode: u8, binding: &[u8], payload: &[u8]) -> Result<Hs, String> {
    let (mut send, recv) = conn.open_bi().await.map_err(|e| format!("open_bi: {}", conn_err(e)))?;
    let prologue = proto::prologue_v(version, mode, &p.region, &p.key_id, binding);
    let mut hs = snow::Builder::new(proto::NOISE_PARAMS.parse().map_err(|_| "noise_params")?)
        .local_private_key(&p.client_priv)
        .remote_public_key(&p.server_pub)
        .prologue(&prologue)
        .build_initiator()
        .map_err(|e| format!("noise_init: {e}"))?;
    let mut buf = vec![0u8; proto::NOISE_MAX_MSG];
    let n = hs.write_message(payload, &mut buf).map_err(|e| format!("noise_w1: {e}"))?;
    let mut rec = Vec::with_capacity(n + 6);
    rec.extend_from_slice(&proto::preamble(version, mode));
    rec.extend_from_slice(&(n as u16).to_be_bytes());
    rec.extend_from_slice(&buf[..n]);
    send.write_all(&rec).await.map_err(write_err)?;
    Ok(Hs { send, recv, hs })
}

/// Lê a msg2 → (canal Noise, payload Accept).
async fn hs_finish(mut h: Hs) -> Result<(quinn::SendStream, quinn::RecvStream, snow::TransportState, Vec<u8>), String> {
    let mut m2 = Vec::new();
    if !read_record(&mut h.recv, &mut m2).await? {
        return Err("eof_in_handshake".to_string());
    }
    let mut pl = vec![0u8; m2.len()];
    // Falha aqui = chave da região errada/MITM: NÃO cair p/ "sem Noise" (downgrade).
    let pn = h.hs.read_message(&m2, &mut pl).map_err(|_| "noise_auth_failed".to_string())?;
    pl.truncate(pn);
    let ts = h.hs.into_transport_mode().map_err(|e| format!("noise_tm: {e}"))?;
    Ok((h.send, h.recv, ts, pl))
}

fn nonce() -> Result<[u8; 16], String> {
    let mut n = [0u8; 16];
    getrandom::getrandom(&mut n).map_err(|_| "rng")?;
    Ok(n)
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
    out_rx: mpsc::UnboundedReceiver<Out>,
    ev: &smpsc::Sender<Event>,
) -> Result<CloseInfo, String> {
    let t0 = Instant::now();
    let deadline = t0 + p.connect_timeout;

    let sock = new_socket(p.addr.is_ipv6(), p.net_handle)?;
    let ep = Endpoint::new(EndpointConfig::default(), None, sock, Arc::new(quinn::TokioRuntime))
        .map_err(|e| format!("endpoint: {e}"))?;
    *me.endpoint.lock().unwrap() = Some(ep.clone());

    let v2 = p.version == 2;
    let want_0rtt = v2 && p.allow_0rtt;
    let qtls = quic_client_config(p.version, &p.pins, p.tls_verify, want_0rtt)?;
    let mut tc = TransportConfig::default();
    tc.max_idle_timeout(Some(IdleTimeout::try_from(p.idle_timeout).map_err(|_| "idle")?));
    tc.keep_alive_interval(if p.keep_alive.is_zero() { None } else { Some(p.keep_alive) });
    let mut cc = ClientConfig::new(qtls);
    cc.transport_config(Arc::new(tc));

    let connecting = ep.connect_with(cc, p.addr, &p.sni).map_err(|e| format!("connect: {e}"))?;

    // ── retomada 'E' (§0.6): ticket do chatyy/2 → QUIC 0-RTT + IK sem exporter, early idempotente ──
    let mut resumed: Option<(Connection, Hs)> = None;
    let mut connecting = Some(connecting);
    if want_0rtt {
        match connecting.take().unwrap().into_0rtt() {
            Ok((conn, accepted)) => {
                *me.connection.lock().unwrap() = Some(conn.clone());
                let k = proto::early_prefix(&p.frames, p.early_count);
                let pl = proto::msg1_payload_x(1, &p.dev, &p.ua, now_ms(), &nonce()?, Some("early"), &p.frames[..k]);
                let r = tokio::time::timeout_at(deadline.into(), async {
                    let h = hs_start(&conn, p, 2, proto::MODE_E, &[], &pl).await?;
                    // msg2 só depois de saber se o 0-RTT valeu: recusado → stream some → refaz em 'I'
                    Ok::<_, String>(h)
                })
                .await;
                match r {
                    Err(_) => return Err("quic_timeout".into()),
                    Ok(Ok(h)) => resumed = Some((conn.clone(), h)),
                    Ok(Err(e)) if e == ZRTT_REJ => {}
                    Ok(Err(e)) => return Err(e),
                }
                // O handshake TLS precisa terminar de qualquer jeito (accepted = servidor aceitou o 0-RTT).
                let ok = match tokio::time::timeout_at(deadline.into(), accepted).await {
                    Err(_) => return Err("quic_timeout".into()),
                    Ok(b) => b,
                };
                if !ok {
                    resumed = None; // streams do 0-RTT descartados pelo quinn (zero_rtt_rejected)
                }
                connecting = None;
                if resumed.is_none() {
                    // segue em 'I' na MESMA conexão (handshake já completo)
                    return run_after_connect(p, me, out_rx, ev, conn, t0, deadline, None).await;
                }
            }
            Err(c) => connecting = Some(c),
        }
    }
    if let Some((conn, h)) = resumed {
        return run_after_connect(p, me, out_rx, ev, conn, t0, deadline, Some(h)).await;
    }
    let conn = match tokio::time::timeout_at(deadline.into(), connecting.unwrap()).await {
        Err(_) => return Err("quic_timeout".into()),
        Ok(Err(e)) => return Err(format!("quic: {}", conn_err(e))),
        Ok(Ok(c)) => c,
    };
    run_after_connect(p, me, out_rx, ev, conn, t0, deadline, None).await
}

#[allow(clippy::too_many_arguments)]
async fn run_after_connect(
    p: &Params,
    me: &Arc<Conn>,
    mut out_rx: mpsc::UnboundedReceiver<Out>,
    ev: &smpsc::Sender<Event>,
    conn: Connection,
    t0: Instant,
    deadline: Instant,
    resumed: Option<Hs>,
) -> Result<CloseInfo, String> {
    *me.connection.lock().unwrap() = Some(conn.clone());
    let quic_ms = t0.elapsed().as_millis() as u32;
    let v2 = p.version == 2;

    // (canal, Accept, quantos de `frames` o servidor já recebeu)
    let (mut send, mut recv, ts, hello, sent_in_msg1, mode) = if let Some(h) = resumed {
        let k = proto::early_prefix(&p.frames, p.early_count);
        let (s, r, ts, hello) = match tokio::time::timeout_at(deadline.into(), hs_finish(h)).await {
            Err(_) => return Err("noise_timeout".into()),
            Ok(x) => x?,
        };
        let en = proto::accept_early_n(&hello).min(k);
        let _ = ev.send(Event::Open { hs_ms: t0.elapsed().as_millis() as u32, quic_ms, hello: hello.clone(), version: 2, mode: proto::MODE_E });
        (s, r, ts, hello, en, proto::MODE_E)
    } else {
        // Prólogo amarrado ao exporter TLS DESTA conexão (channel binding).
        let mut exp = [0u8; proto::EXPORTER_LEN];
        conn.export_keying_material(&mut exp, proto::EXPORTER_LABEL, proto::EXPORTER_CONTEXT)
            .map_err(|_| "exporter")?;
        let k = if v2 { proto::msg1_fit(&p.frames) } else { 0 };
        let pl = if v2 {
            proto::msg1_payload_x(2, &p.dev, &p.ua, now_ms(), &nonce()?, Some("frames"), &p.frames[..k])
        } else {
            proto::msg1_payload(&p.dev, &p.ua, now_ms(), &nonce()?)
        };
        let h = match tokio::time::timeout_at(deadline.into(), hs_start(&conn, p, p.version, proto::MODE_I, &exp, &pl)).await {
            Err(_) => return Err("noise_timeout".into()),
            Ok(x) => x?,
        };
        if v2 {
            // chatyy/2: auth já foi (dentro da msg1) → o app pode "mandar" já; o resto espera a msg2 na fila.
            let _ = ev.send(Event::Open { hs_ms: t0.elapsed().as_millis() as u32, quic_ms, hello: Vec::new(), version: 2, mode: proto::MODE_I });
        }
        // msg2: no chatyy/2 o servidor a segura até o auth_success (≤ 1,5 s) → prazo próprio.
        let dl2 = if v2 { Instant::now() + Duration::from_millis(1500) + p.connect_timeout / 2 } else { deadline };
        let (s, r, ts, hello) = match tokio::time::timeout_at(dl2.into(), hs_finish(h)).await {
            Err(_) => return Err("noise_timeout".into()),
            Ok(x) => x?,
        };
        if v2 {
            let _ = ev.send(Event::Accept { ms: t0.elapsed().as_millis() as u32, hello: hello.clone() });
        } else {
            let _ = ev.send(Event::Open { hs_ms: t0.elapsed().as_millis() as u32, quic_ms, hello: hello.clone(), version: 1, mode: proto::MODE_I });
        }
        let en = if v2 { proto::accept_early_n(&hello).min(k) } else { 0 };
        (s, r, ts, hello, en, proto::MODE_I)
    };
    let _ = (&hello, mode);
    let noise = Arc::new(Mutex::new(ts));
    // Frames que o servidor não recebeu na msg1 (early recusado, não coube, chatyy/1) saem já, na ordem.
    if p.version == 2 && sent_in_msg1 < p.frames.len() {
        let mut pt = Vec::new();
        for f in &p.frames[sent_in_msg1..] {
            pt.extend(proto::encode_frame(proto::OP_TEXT, f.as_bytes()));
        }
        let rec = seal_records(&noise, &pt)?;
        send.write_all(&rec).await.map_err(write_err)?;
    }

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
