//! chatyy-net — fio QUIC + Noise do transporte nativo (protótipo ESCURO, F-Q2/F-N1).
//!
//! Superfície JNI crua (sem UniFFI/JNA: o Kotlin declara `external fun` em
//! `expo.modules.chatyytransport.ChatyyNetJni`). Binário sem `libchatyy_net.so` → o
//! `System.loadLibrary` falha, o Kotlin marca "ausente" e usa o WSS de sempre.
//!
//! Toda função JNI é embrulhada em `catch_unwind` (perfil release com panic=unwind):
//! um pânico vira 0/false/null, nunca derruba o app.

pub mod conn;
pub mod proto;

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

pub use conn::{Conn, Event, Params, Poll};

pub const VERSION: &str = concat!("chatyy-net/", env!("CARGO_PKG_VERSION"), " proto=chatyy/1 noise=IK");

pub fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("chatyy-net")
            .enable_all()
            .build()
            .expect("tokio runtime")
    })
}

/// Par X25519 novo: (privada, pública).
pub fn keypair() -> Option<([u8; 32], [u8; 32])> {
    let b = snow::Builder::new(proto::NOISE_PARAMS.parse().ok()?);
    let kp = b.generate_keypair().ok()?;
    Some((kp.private.try_into().ok()?, kp.public.try_into().ok()?))
}

// ─── registro de conexões (handle = id, nunca ponteiro: handle velho = no-op) ─

fn registry() -> &'static Mutex<HashMap<i64, Arc<Conn>>> {
    static R: OnceLock<Mutex<HashMap<i64, Arc<Conn>>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}
static NEXT: AtomicI64 = AtomicI64::new(1);

fn get(h: i64) -> Option<Arc<Conn>> {
    registry().lock().ok()?.get(&h).cloned()
}

pub fn open(p: Params) -> i64 {
    let c = Conn::start(p, runtime());
    let h = NEXT.fetch_add(1, Ordering::SeqCst);
    registry().lock().unwrap().insert(h, c);
    h
}

/// Evento serializado p/ a JVM: 1 byte de tipo + corpo.
///   1 OPEN     u32be hs_ms | u32be quic_ms | hello
///   2 FRAME    op | dados
///   3 CLOSED   u16be código | u8 remoto | motivo utf-8
///   4 ERROR    texto utf-8
///   5 MIGRATED u8 ok | texto
///   6 GONE     (fim; liberar o handle)
pub fn encode_event(p: Poll) -> Option<Vec<u8>> {
    let mut o = Vec::new();
    match p {
        Poll::Timeout => return None,
        Poll::Gone => o.push(6),
        Poll::Event(Event::Open { hs_ms, quic_ms, hello }) => {
            o.push(1);
            o.extend_from_slice(&hs_ms.to_be_bytes());
            o.extend_from_slice(&quic_ms.to_be_bytes());
            o.extend_from_slice(&hello);
        }
        Poll::Event(Event::Frame { op, data }) => {
            o.reserve(data.len() + 2);
            o.push(2);
            o.push(op);
            o.extend_from_slice(&data);
        }
        Poll::Event(Event::Closed { code, reason, remote }) => {
            o.push(3);
            o.extend_from_slice(&code.to_be_bytes());
            o.push(remote as u8);
            o.extend_from_slice(reason.as_bytes());
        }
        Poll::Event(Event::Error(e)) => {
            o.push(4);
            o.extend_from_slice(e.as_bytes());
        }
        Poll::Event(Event::Migrated { ok, why }) => {
            o.push(5);
            o.push(ok as u8);
            o.extend_from_slice(why.as_bytes());
        }
    }
    Some(o)
}

// ─── JNI ────────────────────────────────────────────────────────────────────

mod jni_api {
    use super::*;
    use jni::objects::{JByteArray, JClass, JString};
    use jni::sys::{jboolean, jbyteArray, jint, jlong, jstring, JNI_FALSE, JNI_TRUE};
    use jni::JNIEnv;
    use std::net::{IpAddr, SocketAddr};

    fn guard<T>(def: T, f: impl FnOnce() -> T) -> T {
        catch_unwind(AssertUnwindSafe(f)).unwrap_or(def)
    }

    fn jstr(env: &mut JNIEnv, s: &JString) -> Option<String> {
        if s.is_null() {
            return None;
        }
        env.get_string(s).ok().map(|x| x.into())
    }

    fn bytes(env: &mut JNIEnv, a: &JByteArray) -> Option<Vec<u8>> {
        if a.is_null() {
            return None;
        }
        env.convert_byte_array(a).ok()
    }

    fn out_bytes(env: &mut JNIEnv, b: &[u8]) -> jbyteArray {
        env.byte_array_from_slice(b).map(|a| a.into_raw()).unwrap_or(std::ptr::null_mut())
    }

    #[no_mangle]
    pub extern "system" fn Java_expo_modules_chatyytransport_ChatyyNetJni_nativeVersion<'l>(
        env: JNIEnv<'l>,
        _c: JClass<'l>,
    ) -> jstring {
        guard(std::ptr::null_mut(), || env.new_string(VERSION).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut()))
    }

    /// 64 bytes: privada(32) || pública(32). null em erro.
    #[no_mangle]
    pub extern "system" fn Java_expo_modules_chatyytransport_ChatyyNetJni_nativeKeypair<'l>(
        mut env: JNIEnv<'l>,
        _c: JClass<'l>,
    ) -> jbyteArray {
        guard(std::ptr::null_mut(), || match keypair() {
            Some((sk, pk)) => {
                let mut b = [0u8; 64];
                b[..32].copy_from_slice(&sk);
                b[32..].copy_from_slice(&pk);
                out_bytes(&mut env, &b)
            }
            None => std::ptr::null_mut(),
        })
    }

    /// Não bloqueia: devolve o handle (>0) já; o resultado chega por nativePoll. 0 = parâmetro inválido.
    #[no_mangle]
    #[allow(clippy::too_many_arguments)]
    pub extern "system" fn Java_expo_modules_chatyytransport_ChatyyNetJni_nativeConnect<'l>(
        mut env: JNIEnv<'l>,
        _c: JClass<'l>,
        sni: JString<'l>,
        ip: JString<'l>,
        port: jint,
        region: JString<'l>,
        key_id: JString<'l>,
        server_pub: JByteArray<'l>,
        client_priv: JByteArray<'l>,
        net_handle: jlong,
        timeout_ms: jint,
        tls_verify: jboolean,
        keep_alive_ms: jint,
        dev: JString<'l>,
        ua: JString<'l>,
    ) -> jlong {
        guard(0, || {
            let (Some(sni), Some(ip), Some(region), Some(key_id)) =
                (jstr(&mut env, &sni), jstr(&mut env, &ip), jstr(&mut env, &region), jstr(&mut env, &key_id))
            else {
                return 0;
            };
            let Ok(ip) = ip.parse::<IpAddr>() else { return 0 };
            if !(1..=65535).contains(&port) {
                return 0;
            }
            let Some(spk) = bytes(&mut env, &server_pub).and_then(|v| <[u8; 32]>::try_from(v).ok()) else { return 0 };
            let Some(csk) = bytes(&mut env, &client_priv).and_then(|v| <[u8; 32]>::try_from(v).ok()) else { return 0 };
            let dev = jstr(&mut env, &dev).unwrap_or_default();
            let ua = jstr(&mut env, &ua).unwrap_or_default();
            let p = Params {
                sni,
                addr: SocketAddr::new(ip, port as u16),
                region,
                key_id,
                server_pub: spk,
                client_priv: csk,
                net_handle: net_handle as u64,
                connect_timeout: Duration::from_millis(timeout_ms.clamp(500, 30_000) as u64),
                tls_verify: tls_verify != JNI_FALSE,
                keep_alive: Duration::from_millis(keep_alive_ms.clamp(0, 120_000) as u64),
                idle_timeout: Duration::from_secs(60),
                dev,
                ua,
            };
            open(p)
        })
    }

    #[no_mangle]
    pub extern "system" fn Java_expo_modules_chatyytransport_ChatyyNetJni_nativeSend<'l>(
        mut env: JNIEnv<'l>,
        _c: JClass<'l>,
        h: jlong,
        op: jint,
        data: JByteArray<'l>,
    ) -> jboolean {
        guard(JNI_FALSE, || {
            let Some(c) = get(h) else { return JNI_FALSE };
            let Some(d) = bytes(&mut env, &data) else { return JNI_FALSE };
            if c.send(op as u8, d) { JNI_TRUE } else { JNI_FALSE }
        })
    }

    /// Bloqueia até `timeout_ms`. null = nada no prazo.
    #[no_mangle]
    pub extern "system" fn Java_expo_modules_chatyytransport_ChatyyNetJni_nativePoll<'l>(
        mut env: JNIEnv<'l>,
        _c: JClass<'l>,
        h: jlong,
        timeout_ms: jint,
    ) -> jbyteArray {
        guard(std::ptr::null_mut(), || {
            let ev = match get(h) {
                Some(c) => encode_event(c.poll(Duration::from_millis(timeout_ms.clamp(0, 60_000) as u64))),
                None => Some(vec![6]),
            };
            match ev {
                Some(b) => out_bytes(&mut env, &b),
                None => std::ptr::null_mut(),
            }
        })
    }

    #[no_mangle]
    pub extern "system" fn Java_expo_modules_chatyytransport_ChatyyNetJni_nativeMigrate<'l>(
        _env: JNIEnv<'l>,
        _c: JClass<'l>,
        h: jlong,
        net_handle: jlong,
    ) -> jboolean {
        guard(JNI_FALSE, || {
            let Some(c) = get(h) else { return JNI_FALSE };
            let _g = runtime().enter();
            if c.migrate(net_handle as u64).is_ok() { JNI_TRUE } else { JNI_FALSE }
        })
    }

    #[no_mangle]
    pub extern "system" fn Java_expo_modules_chatyytransport_ChatyyNetJni_nativeClose<'l>(
        mut env: JNIEnv<'l>,
        _c: JClass<'l>,
        h: jlong,
        code: jint,
        reason: JString<'l>,
        abort: jboolean,
    ) {
        guard((), || {
            let r = jstr(&mut env, &reason).unwrap_or_default();
            if let Some(c) = get(h) {
                c.close(code.clamp(1000, 4999) as u16, &r, abort != JNI_FALSE);
            }
        })
    }

    #[no_mangle]
    pub extern "system" fn Java_expo_modules_chatyytransport_ChatyyNetJni_nativeQueued<'l>(
        _env: JNIEnv<'l>,
        _c: JClass<'l>,
        h: jlong,
    ) -> jlong {
        guard(0, || get(h).map(|c| c.queued() as jlong).unwrap_or(0))
    }

    #[no_mangle]
    pub extern "system" fn Java_expo_modules_chatyytransport_ChatyyNetJni_nativeStats<'l>(
        env: JNIEnv<'l>,
        _c: JClass<'l>,
        h: jlong,
    ) -> jstring {
        guard(std::ptr::null_mut(), || {
            let s = get(h).map(|c| c.stats_json()).unwrap_or_else(|| "{}".into());
            env.new_string(s).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
        })
    }

    /// Solta o handle (aborta se ainda vivo). Chamar 1 vez, depois do GONE.
    #[no_mangle]
    pub extern "system" fn Java_expo_modules_chatyytransport_ChatyyNetJni_nativeFree<'l>(
        _env: JNIEnv<'l>,
        _c: JClass<'l>,
        h: jlong,
    ) {
        guard((), || {
            let c = registry().lock().ok().and_then(|mut r| r.remove(&h));
            if let Some(c) = c {
                c.close(1001, "free", true);
            }
        })
    }
}
