//! Mede o pico de memória do cenário NSE (WP-01 "meta < 15 MB"): processo novo abre o store
//! SQLite existente, faz 1 sync com a chave pendente e decifra 1 mensagem.
//! `cargo run --release --example nse_mem --features testing` (Linux: lê VmHWM de /proc).
#[path = "../tests/common/mod.rs"]
mod common;
use chatyy_crypto::*;
use common::fake_server::*;
use common::*;

fn hwm_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmHWM")).map(|l| l.split_whitespace().nth(1).unwrap_or("0").parse().unwrap_or(0)))
        .unwrap_or(0)
}
fn rss_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmRSS")).map(|l| l.split_whitespace().nth(1).unwrap_or("0").parse().unwrap_or(0)))
        .unwrap_or(0)
}

fn main() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let s = FakeServer::new();
        let a = Client::phone(&s, "7").await;
        let b = Client::phone(&s, "42").await;
        s.set_conv("1", &["7", "42"]);
        let (env, cmid, _) = a.send("1", &[&a, &b], "prévia do push").await;
        let dir = b.dir.clone();
        let dev = b.device_id.clone();
        drop(b);
        let before = rss_kb();
        let t0 = std::time::Instant::now();
        let nse = Client::open_at(&s, "42", &dev, dir, ProcessRole::Push, "nse").await;
        let d = nse.recv("1", &a, &env, &cmid, "1").await.unwrap();
        let ms = t0.elapsed().as_millis();
        let after = rss_kb();
        println!("NSE: abrir+sync+decifrar = {ms} ms; RSS antes {} KB, depois {} KB (Δ {} KB); pico do processo (VmHWM, inclui o cenário inteiro) {} KB; texto = {} B",
            before, after, after.saturating_sub(before), hwm_kb(), body_of(&d).len());
        let _ = core_version();
    });
}
