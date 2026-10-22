//! Destruição do store DENTRO de um runtime tokio (crash iOS 766, 2026-10-22).
//!
//! O store SQLite (matrix-sdk-sqlite → deadpool-sync) fecha cada conexão no `Drop` do
//! `SyncWrapper` com `tokio::task::spawn_blocking(..)` — que dá PANIC fora de um runtime. O host
//! libera o `CryptoCore` onde quiser: deinit do Swift (thread do actor / main), Cleaner do Kotlin,
//! `rust_future_free` do último Future… Fora do runtime: 1º panic na 1ª conexão e o 2º (pool +
//! conexão de escrita) durante o unwind do 1º → "thread caused non-unwinding panic. aborting."
//!
//! `InRuntime<T>` embrulha tudo o que segura o store (OlmMachine, Arc do store, trava entre
//! processos) e, no drop, entra no runtime em que o núcleo foi aberto (Handle guardado) ou num
//! runtime reserva estático (nunca derrubado). Deref transparente: nada muda para quem usa.
use std::ops::Deref;

#[cfg(not(target_family = "wasm"))]
mod imp {
    use std::sync::OnceLock;
    use tokio::runtime::{Builder, Handle, Runtime};

    /// Runtime reserva (só o pool de bloqueio é usado: `spawn_blocking` de quem fecha a conexão).
    fn fallback() -> Option<&'static Runtime> {
        static RT: OnceLock<Option<Runtime>> = OnceLock::new();
        RT.get_or_init(|| Builder::new_current_thread().thread_name("chatyy-crypto-drop").build().ok()).as_ref()
    }

    pub(super) fn current() -> Option<Handle> {
        Handle::try_current().ok()
    }

    pub(super) fn drop_in<T>(v: T, h: Option<&Handle>) {
        if Handle::try_current().is_ok() {
            drop(v);
            return;
        }
        // Runtime do open (no app: o global do UniFFI, nunca derrubado); sem ele, o reserva. Se o
        // runtime do open já foi derrubado, o tokio descarta a tarefa sem panic e a conexão fecha
        // aqui mesmo (teste `drop_fora_do_runtime`).
        let h = h.cloned().or_else(|| fallback().map(|r| r.handle().clone()));
        match h {
            Some(h) => {
                let _g = h.enter();
                drop(v);
            }
            // Sem runtime nenhum (não deveria acontecer): vazar é melhor que abortar o app/NSE.
            None => std::mem::forget(v),
        }
    }
}

#[cfg(target_family = "wasm")]
mod imp {
    pub(crate) type Handle = ();
    pub(super) fn current() -> Option<Handle> {
        None
    }
    pub(super) fn drop_in<T>(v: T, _h: Option<&Handle>) {
        drop(v)
    }
}

#[cfg(not(target_family = "wasm"))]
type H = tokio::runtime::Handle;
#[cfg(target_family = "wasm")]
type H = imp::Handle;

pub(crate) struct InRuntime<T> {
    v: Option<T>,
    h: Option<H>,
}

impl<T> InRuntime<T> {
    /// Guarda `v` e o runtime corrente (chamar de dentro do `open`, que roda no runtime).
    pub(crate) fn new(v: T) -> Self {
        InRuntime { v: Some(v), h: imp::current() }
    }
}

impl<T> Deref for InRuntime<T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.v.as_ref().expect("InRuntime: valor presente até o drop")
    }
}

impl<T> Drop for InRuntime<T> {
    fn drop(&mut self) {
        if let Some(v) = self.v.take() {
            imp::drop_in(v, self.h.as_ref());
        }
    }
}
