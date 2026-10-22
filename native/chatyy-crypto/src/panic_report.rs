//! Telemetria de panic do núcleo (crash iOS 766, 2026-10-22).
//!
//! `install(dir)` (chamado no `CryptoCore::open`) registra UMA vez por processo um
//! `std::panic::set_hook` que acrescenta uma linha em `<raiz e2ee5>/core_panic.log` (pai do
//! `store_dir`: iOS = App Group …/e2ee5, Android = noBackupFilesDir/e2ee5) e depois chama o
//! hook anterior. O host lê+apaga no boot seguinte e manda pelo beacon `callkit_diag` kind
//! `e2ee5` code `core_panic`.
//!
//! Linha (≤ ~360 B, só ASCII seguro): `role=<papel> at=<arquivo:linha:col> msg=<mensagem do
//! panic> thread=<nome> ts=<ms> v=<versão>`. NUNCA conteúdo de mensagem nem chave: o
//! texto do panic vem de asserts/unwraps de código (o nosso e o das deps), é cortado em 160
//! caracteres e qualquer sequência longa de base64/hex (≥ 24) vira `<redacted>`.
#[cfg(not(target_family = "wasm"))]
mod imp {
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, Once, OnceLock};

    /// Arquivo (relativo à raiz e2ee5) — o host procura por este nome.
    pub const FILE: &str = "core_panic.log";
    /// Teto do arquivo: panics em laço não enchem o disco.
    const MAX_BYTES: u64 = 8 * 1024;

    static PATH: OnceLock<PathBuf> = OnceLock::new();
    static ROLE: Mutex<&'static str> = Mutex::new("?");
    static HOOK: Once = Once::new();

    pub fn install(store_dir: &str, role: &'static str) {
        if let Ok(mut r) = ROLE.lock() {
            *r = role;
        }
        let root = Path::new(store_dir).parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(store_dir));
        let _ = PATH.set(root.join(FILE));
        HOOK.call_once(|| {
            let prev = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                // Nada aqui pode dar panic (seria panic dentro do hook = abort).
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| record(info)));
                prev(info);
            }));
        });
    }

    fn record(info: &std::panic::PanicHookInfo<'_>) {
        let Some(path) = PATH.get() else { return };
        if std::fs::metadata(path).map(|m| m.len() >= MAX_BYTES).unwrap_or(false) {
            return;
        }
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "non-string payload".to_string()
        };
        let at = info.location().map(|l| format!("{}:{}:{}", short_file(l.file()), l.line(), l.column())).unwrap_or_else(|| "?".into());
        let th = std::thread::current();
        let role = ROLE.lock().map(|r| *r).unwrap_or("?");
        // Ordem = importância (o beacon corta em ~400): onde, o quê, quem, quando.
        let line = format!(
            "role={} at={} msg={} thread={} ts={} v={}\n",
            role,
            clean(&at, 100),
            redact(&clean(&msg, 160)),
            clean(th.name().unwrap_or("-"), 32),
            crate::util::now_ms(),
            env!("CARGO_PKG_VERSION"),
        );
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = f.write_all(line.as_bytes()); // 1 write com O_APPEND: app × NSE não se misturam
        }
    }

    /// `/cargo/registry/src/index…/deadpool-sync-0.2.0/src/lib.rs` → `deadpool-sync-0.2.0/src/lib.rs`.
    fn short_file(f: &str) -> &str {
        let parts: Vec<&str> = f.rsplitn(4, '/').collect();
        if parts.len() == 4 {
            &f[parts[3].len() + 1..]
        } else {
            f
        }
    }

    pub(crate) fn clean(s: &str, max: usize) -> String {
        s.chars()
            .map(|c| if c.is_ascii_alphanumeric() || " ._:/()-[]<>,'=#+".contains(c) { c } else { '_' })
            .take(max)
            .collect()
    }

    /// Sequências longas parecidas com chave/base64/hex → `<redacted>`.
    pub(crate) fn redact(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut run = String::new();
        let flush = |run: &mut String, out: &mut String| {
            if run.len() >= 24 {
                out.push_str("<redacted>");
            } else {
                out.push_str(run);
            }
            run.clear();
        };
        for c in s.chars() {
            if c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=' || c == '_' || c == '-' {
                run.push(c);
            } else {
                flush(&mut run, &mut out);
                out.push(c);
            }
        }
        flush(&mut run, &mut out);
        out
    }
}

#[cfg(not(target_family = "wasm"))]
pub(crate) use imp::install;
#[cfg(all(not(target_family = "wasm"), test))]
pub(crate) use imp::{redact, FILE};

#[cfg(target_family = "wasm")]
pub(crate) fn install(_store_dir: &str, _role: &'static str) {}

#[cfg(all(test, not(target_family = "wasm")))]
mod tests {
    #[test]
    fn redige_sequencias_longas() {
        let r = super::redact("called `Option::unwrap()` key=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3 ok");
        assert!(r.contains("<redacted>") && !r.contains("QUJD"), "{r}");
        assert_eq!(super::redact("must be called from the context of a Tokio 1.x runtime"), "must be called from the context of a Tokio 1.x runtime");
    }

    #[test]
    fn hook_grava_linha_sem_conteudo() {
        let d = tempfile::tempdir().unwrap();
        let store = d.path().join("u7");
        super::install(store.to_str().unwrap(), "app");
        let _ = std::thread::Builder::new()
            .name("t-panic".into())
            .spawn(|| panic!("teste do hook segredo=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3"))
            .unwrap()
            .join();
        let s = std::fs::read_to_string(d.path().join(super::FILE)).unwrap();
        assert!(s.contains("role=app") && s.contains("thread=t-panic") && s.contains("at=") && s.contains("msg=teste do hook"), "{s}");
        assert!(!s.contains("QUJD"), "{s}");
    }
}
