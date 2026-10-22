//! Regressão do crash iOS 766 (2026-10-22 12:49Z): SIGABRT "thread caused non-unwinding panic".
//!
//! O host (Swift deinit / Kotlin Cleaner) libera o `CryptoCore` num thread SEM runtime tokio.
//! O store SQLite (matrix-sdk-sqlite → deadpool-sync) fecha cada conexão com
//! `tokio::task::spawn_blocking` no `Drop` do `SyncWrapper` → fora do runtime isso dá panic; a
//! conexão seguinte (pool + conexão de escrita) dá outro panic durante o 1º → abort do processo.
//!
//! Como um abort derruba o binário de teste inteiro, o drop roda num PROCESSO FILHO (o próprio
//! binário re-executado com `CHATYY_DROP_CHILD=1`) e o pai confere que ele saiu limpo.
use chatyy_crypto::{new_device_id, CryptoCore, HttpResponse, HttpTransport, OpenOptions, ProcessRole, TransportError};
use std::sync::Arc;

struct Offline;

#[async_trait::async_trait]
impl HttpTransport for Offline {
    async fn call(&self, _action: String, _body_json: String) -> Result<HttpResponse, TransportError> {
        Ok(HttpResponse { status: 503, body: "{}".into() })
    }
}

const PASS: &str = "c3RvcmUtcGFzc3BocmFzZS0zMi1ieXRlcy1hYWFhYWE";

fn open_core(rt: &tokio::runtime::Runtime, dir: &std::path::Path, dev: &str, role: ProcessRole) -> Arc<CryptoCore> {
    rt.block_on(async {
        let core = CryptoCore::open(
            OpenOptions {
                store_dir: dir.join("u7").to_string_lossy().to_string(),
                store_passphrase: PASS.into(),
                uid: "7".into(),
                device_id: dev.into(),
                role,
                holder_suffix: format!("{role:?}"),
            },
            Arc::new(Offline),
        )
        .await
        .expect("open");
        // Algumas leituras concorrentes: o pool passa a ter mais de uma conexão viva.
        let (a, b, c) = tokio::join!(core.this_device(), core.list_devices("7".into()), core.this_device());
        let _ = (a, b, c);
        core
    })
}

/// Corpo do filho: abre o núcleo dentro de um runtime e o libera num thread std sem tokio
/// (o que o deinit do Swift faz), depois de o runtime já ter sido derrubado (reload do JS).
fn child_body() {
    let dir = tempfile::tempdir().unwrap();
    let dev = new_device_id("P").unwrap();
    let dev = dev.as_str();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let core = open_core(&rt, dir.path(), dev, ProcessRole::App);
    let core2 = open_core(&rt, dir.path(), dev, ProcessRole::Push); // app + NSE no mesmo store
    // 1) drop num thread sem runtime enquanto o runtime ainda existe
    std::thread::spawn(move || drop(core)).join().expect("drop fora do runtime não pode dar panic");
    // 2) drop num thread sem runtime depois de o runtime morrer
    drop(rt);
    std::thread::spawn(move || drop(core2)).join().expect("drop após o runtime morrer não pode dar panic");
    // 3) o store continua abrível (as conexões foram fechadas de verdade, sem trava presa)
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
    let core3 = open_core(&rt, dir.path(), dev, ProcessRole::App);
    drop(rt);
    drop(core3); // no thread principal, sem runtime
}

#[test]
fn drop_do_core_fora_do_runtime_tokio_nao_aborta() {
    if std::env::var("CHATYY_DROP_CHILD").as_deref() == Ok("1") {
        child_body();
        return;
    }
    let exe = std::env::current_exe().unwrap();
    let out = std::process::Command::new(exe)
        .args(["--exact", "drop_do_core_fora_do_runtime_tokio_nao_aborta", "--nocapture", "--test-threads=1"])
        .env("CHATYY_DROP_CHILD", "1")
        .output()
        .unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "filho saiu com {:?}\nstderr:\n{}", out.status, err);
    assert!(!err.contains("panicked"), "houve panic no filho:\n{}", err);
}
