//! Métricas agregadas (CONTRATO §4.2 `e2ee5_metrics`). SÓ contagens — nunca ids de mensagem,
//! conteúdo ou chaves.
use crate::error::UtdReason;
use std::collections::BTreeMap;
use std::sync::Mutex;

#[derive(Debug, Clone, Default, serde::Serialize)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct MetricsSnapshot {
    pub encrypt: u64,
    pub decrypt_ok: u64,
    /// `{"missing_session": 3, …}` como JSON (UniFFI não tem mapa ordenado estável).
    pub utd_json: String,
    pub utd_total: u64,
    pub to_device_in: u64,
    pub to_device_utd: u64,
    pub dropped_untrusted: u64,
    pub store_reloads: u64,
    /// [1.7] pedidos de chave de sala: enviados (destinatário sem chave), servidos (remetente
    /// reenviou), recebidos e importados (destinatário), recusados (regras de membro/índice).
    pub key_req_sent: u64,
    pub key_req_served: u64,
    pub key_req_ok: u64,
    pub key_req_refused: u64,
}

#[derive(Default)]
pub(crate) struct Metrics(Mutex<(MetricsSnapshot, BTreeMap<&'static str, u64>)>);

impl Metrics {
    fn with(&self, f: impl FnOnce(&mut MetricsSnapshot, &mut BTreeMap<&'static str, u64>)) {
        if let Ok(mut g) = self.0.lock() {
            let (a, b) = &mut *g;
            f(a, b)
        }
    }
    pub fn inc_encrypt(&self) { self.with(|s, _| s.encrypt += 1) }
    pub fn inc_decrypt(&self) { self.with(|s, _| s.decrypt_ok += 1) }
    pub fn inc_utd(&self, r: UtdReason) { self.with(|s, m| { s.utd_total += 1; *m.entry(r.as_str()).or_default() += 1; }) }
    pub fn add_td(&self, n: u64) { self.with(|s, _| s.to_device_in += n) }
    pub fn inc_td_utd(&self) { self.with(|s, _| s.to_device_utd += 1) }
    pub fn inc_dropped_untrusted(&self) { self.with(|s, _| s.dropped_untrusted += 1) }
    pub fn inc_reload(&self) { self.with(|s, _| s.store_reloads += 1) }
    pub fn inc_key_req_sent(&self) { self.with(|s, _| s.key_req_sent += 1) }
    pub fn add_key_req_served(&self, n: u64) { self.with(|s, _| s.key_req_served += n) }
    pub fn inc_key_req_ok(&self) { self.with(|s, _| s.key_req_ok += 1) }
    pub fn add_key_req_refused(&self, n: u64) { self.with(|s, _| s.key_req_refused += n) }
    pub fn snapshot(&self) -> MetricsSnapshot {
        let g = self.0.lock().map(|g| g.clone()).unwrap_or_default();
        let mut s = g.0;
        s.utd_json = serde_json::to_string(&g.1).unwrap_or_else(|_| "{}".into());
        s
    }
    pub fn take_snapshot(&self) -> MetricsSnapshot {
        let s = self.snapshot();
        if let Ok(mut g) = self.0.lock() { *g = Default::default(); }
        s
    }
}
