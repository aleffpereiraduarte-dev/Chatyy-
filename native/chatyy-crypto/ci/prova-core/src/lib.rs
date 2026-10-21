//! Núcleo TEMPORÁRIO do WP-02 (ver Cargo.toml). Porta da prova: Alice cifra com Megolm, a
//! chave vai por Olm (to-device) a Bob, Bob decifra, tudo contra um servidor falso em memória.
//! Exporta para Swift/Kotlin (UniFFI, async via tokio) e JS (wasm-bindgen, Promise).
use matrix_sdk_crypto::{
    types::requests::{AnyOutgoingRequest, ToDeviceRequest},
    DecryptionSettings, EncryptionSettings, EncryptionSyncChanges, OlmMachine, TrustRequirement,
};
use ruma::{
    api::client::sync::sync_events::DeviceLists,
    api::{
        client::keys::{claim_keys, get_keys, upload_keys, upload_signatures},
        client::to_device::send_event_to_device,
        IncomingResponse,
    },
    events::AnyToDeviceEvent,
    serde::Raw,
    to_device::DeviceIdOrAllDevices,
    OneTimeKeyAlgorithm, OwnedUserId, UInt,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

#[cfg(feature = "uniffi")]
uniffi::setup_scaffolding!("chatyy_crypto");

#[derive(Debug, thiserror::Error)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Error))]
pub enum ProvaError {
    #[error("prova: {msg}")]
    Failed { msg: String },
}
fn fail<E: std::fmt::Debug>(e: E) -> ProvaError {
    ProvaError::Failed { msg: format!("{e:?}") }
}
type R<T> = Result<T, ProvaError>;

/// Igual ao formato do núcleo real, marcado como prova.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn core_version() -> String {
    format!("chatyy-crypto-PROVA {}; matrix-sdk-crypto 0.18.0", env!("CARGO_PKG_VERSION"))
}

#[derive(Default)]
struct FakeServer {
    devices: BTreeMap<String, BTreeMap<String, Value>>,
    otks: HashMap<(String, String), Vec<(String, Value)>>,
    fallback: HashMap<(String, String), (String, Value)>,
    inbox: HashMap<(String, String), Vec<Value>>,
    xsign: BTreeMap<String, Value>,
}
fn resp<T: IncomingResponse>(v: Value) -> R<T> {
    let body = serde_json::to_vec(&v).map_err(fail)?;
    T::try_from_http_response(http::Response::builder().status(200).body(body).map_err(fail)?).map_err(fail)
}
impl FakeServer {
    async fn pump(&mut self, m: &OlmMachine) -> R<()> {
        for _ in 0..4 {
            let reqs = m.outgoing_requests().await.map_err(fail)?;
            if reqs.is_empty() {
                break;
            }
            for r in reqs {
                self.handle(m, r.request_id(), r.request()).await?;
            }
        }
        Ok(())
    }
    async fn handle(&mut self, m: &OlmMachine, id: &ruma::TransactionId, req: &AnyOutgoingRequest) -> R<()> {
        let me = m.user_id().to_string();
        let dev = m.device_id().to_string();
        match req {
            AnyOutgoingRequest::KeysUpload(r) => {
                if let Some(dk) = &r.device_keys {
                    self.devices.entry(me.clone()).or_default().insert(dev.clone(), serde_json::to_value(dk).map_err(fail)?);
                }
                let q = self.otks.entry((me.clone(), dev.clone())).or_default();
                for (k, v) in &r.one_time_keys {
                    q.push((k.to_string(), serde_json::to_value(v).map_err(fail)?));
                }
                for (k, v) in &r.fallback_keys {
                    self.fallback.insert((me.clone(), dev.clone()), (k.to_string(), serde_json::to_value(v).map_err(fail)?));
                }
                let n = q.len();
                let x: upload_keys::v3::Response = resp(json!({"one_time_key_counts": {"signed_curve25519": n}}))?;
                m.mark_request_as_sent(id, &x).await.map_err(fail)?;
            }
            AnyOutgoingRequest::KeysQuery(r) => {
                let mut dk = serde_json::Map::new();
                let (mut mk, mut ssk, mut usk) = (json!({}), json!({}), json!({}));
                for u in r.device_keys.keys() {
                    dk.insert(u.to_string(), json!(self.devices.get(u.as_str()).cloned().unwrap_or_default()));
                    if let Some(x) = self.xsign.get(u.as_str()) {
                        mk[u.as_str()] = x["master"].clone();
                        ssk[u.as_str()] = x["self_signing"].clone();
                        if u.as_str() == me {
                            usk[u.as_str()] = x["user_signing"].clone();
                        }
                    }
                }
                let x: get_keys::v3::Response = resp(json!({"device_keys": dk, "master_keys": mk, "self_signing_keys": ssk, "user_signing_keys": usk, "failures": {}}))?;
                m.mark_request_as_sent(id, &x).await.map_err(fail)?;
            }
            AnyOutgoingRequest::KeysClaim(r) => self.claim(m, id, &r.one_time_keys).await?,
            AnyOutgoingRequest::ToDeviceRequest(r) => self.to_device(m, id, r).await?,
            AnyOutgoingRequest::SignatureUpload(_) => {
                let x: upload_signatures::v3::Response = resp(json!({"failures": {}}))?;
                m.mark_request_as_sent(id, &x).await.map_err(fail)?;
            }
            _ => {}
        }
        Ok(())
    }
    async fn claim(
        &mut self,
        m: &OlmMachine,
        id: &ruma::TransactionId,
        want: &BTreeMap<OwnedUserId, BTreeMap<ruma::OwnedDeviceId, OneTimeKeyAlgorithm>>,
    ) -> R<()> {
        let mut out = serde_json::Map::new();
        for (u, devs) in want {
            let mut um = serde_json::Map::new();
            for d in devs.keys() {
                let key = (u.to_string(), d.to_string());
                let k = self.otks.get_mut(&key).and_then(|q| q.pop()).or_else(|| self.fallback.get(&key).cloned());
                if let Some((kid, kv)) = k {
                    um.insert(d.to_string(), json!({ kid: kv }));
                }
            }
            out.insert(u.to_string(), Value::Object(um));
        }
        let x: claim_keys::v3::Response = resp(json!({"one_time_keys": out, "failures": {}}))?;
        m.mark_request_as_sent(id, &x).await.map_err(fail)
    }
    async fn to_device(&mut self, m: &OlmMachine, id: &ruma::TransactionId, r: &ToDeviceRequest) -> R<()> {
        for (u, devs) in &r.messages {
            for (d, content) in devs {
                let targets: Vec<String> = match d {
                    DeviceIdOrAllDevices::DeviceId(d) => vec![d.to_string()],
                    _ => self.devices.get(u.as_str()).map(|x| x.keys().cloned().collect()).unwrap_or_default(),
                };
                let c: Value = serde_json::from_str(content.json().get()).map_err(fail)?;
                for t in targets {
                    self.inbox.entry((u.to_string(), t)).or_default().push(
                        json!({"type": r.event_type.to_string(), "sender": m.user_id().to_string(), "content": c}),
                    );
                }
            }
        }
        let x: send_event_to_device::v3::Response = resp(json!({}))?;
        m.mark_request_as_sent(id, &x).await.map_err(fail)
    }
    async fn sync(&mut self, m: &OlmMachine) -> R<()> {
        let key = (m.user_id().to_string(), m.device_id().to_string());
        let evs: Vec<Raw<AnyToDeviceEvent>> = self
            .inbox
            .remove(&key)
            .unwrap_or_default()
            .into_iter()
            .map(|v| Raw::from_json(serde_json::value::to_raw_value(&v).unwrap()))
            .collect();
        let n = self.otks.get(&key).map(|q| q.len()).unwrap_or(0);
        let dl = DeviceLists::new();
        let counts = BTreeMap::from([(OneTimeKeyAlgorithm::SignedCurve25519, UInt::new(n as u64).unwrap())]);
        let ds = DecryptionSettings { sender_device_trust_requirement: TrustRequirement::Untrusted };
        m.receive_sync_changes(
            EncryptionSyncChanges {
                to_device_events: evs,
                changed_devices: &dl,
                one_time_keys_counts: &counts,
                unused_fallback_keys: Some(&[]),
                next_batch_token: None,
            },
            &ds,
        )
        .await
        .map_err(fail)?;
        self.pump(m).await
    }
}

async fn roundtrip_inner(text: String) -> R<String> {
    let mut s = FakeServer::default();
    let (alice, bob) = (ruma::user_id!("@u1:chatyy"), ruma::user_id!("@u2:chatyy"));
    let a = OlmMachine::new(alice, ruma::device_id!("PALICE")).await;
    let b = OlmMachine::new(bob, ruma::device_id!("PBOB")).await;
    for m in [&a, &b] {
        let reqs = m.bootstrap_cross_signing(false).await.map_err(fail)?;
        let up = &reqs.upload_signing_keys_req;
        s.xsign.insert(
            m.user_id().to_string(),
            json!({"master": up.master_key, "self_signing": up.self_signing_key, "user_signing": up.user_signing_key}),
        );
        if let Some(r) = reqs.upload_keys_req {
            s.handle(m, r.request_id(), r.request()).await?;
        }
    }
    for m in [&a, &b] {
        s.pump(m).await?;
    }
    let room = ruma::room_id!("!c1:chatyy");
    for m in [&a, &b] {
        m.update_tracked_users([alice, bob]).await.map_err(fail)?;
        s.pump(m).await?;
    }
    if let Some((id, req)) = a.get_missing_sessions([alice, bob].into_iter()).await.map_err(fail)? {
        s.claim(&a, &id, &req.one_time_keys).await?;
    }
    for r in a.share_room_key(room, [alice, bob].into_iter(), EncryptionSettings::default()).await.map_err(fail)? {
        s.to_device(&a, &r.txn_id.clone(), &r).await?;
    }
    let content = json!({"msgtype": "m.text", "body": text});
    let raw = Raw::from_json(serde_json::value::to_raw_value(&content).map_err(fail)?);
    let enc = a.encrypt_room_event_raw(room, "m.room.message", &raw).await.map_err(fail)?;
    let enc_v: Value = serde_json::from_str(enc.content.json().get()).map_err(fail)?;
    s.sync(&b).await?;
    let ev = json!({"type": "m.room.encrypted", "sender": alice.to_string(), "event_id": "$m1",
                    "origin_server_ts": 1, "room_id": room.to_string(), "content": enc_v});
    let ds = DecryptionSettings { sender_device_trust_requirement: TrustRequirement::Untrusted };
    let d = b
        .decrypt_room_event(&Raw::from_json(serde_json::value::to_raw_value(&ev).map_err(fail)?), room, &ds)
        .await
        .map_err(fail)?;
    let body: Value = serde_json::from_str(d.event.json().get()).map_err(fail)?;
    body["content"]["body"].as_str().map(str::to_owned).ok_or_else(|| fail("sem body"))
}

/// Olm + Megolm ida e volta em memória; devolve o texto decifrado por Bob.
#[cfg(not(target_family = "wasm"))]
#[cfg_attr(feature = "uniffi", uniffi::export(async_runtime = "tokio"))]
pub async fn prova_roundtrip(text: String) -> Result<String, ProvaError> {
    roundtrip_inner(text).await
}

/// Abre um store SQLite cifrado (o mesmo crate do núcleo real) e devolve o tamanho da chave
/// curve25519 em base64 (43). Exercita SQLite "bundled" no alvo (iOS/Android).
#[cfg(not(target_family = "wasm"))]
#[cfg_attr(feature = "uniffi", uniffi::export(async_runtime = "tokio"))]
pub async fn prova_store_open(dir: String, passphrase: String) -> Result<u32, ProvaError> {
    let store = matrix_sdk_sqlite::SqliteCryptoStore::open(&dir, Some(passphrase.as_str())).await.map_err(fail)?;
    let m = OlmMachine::with_store(ruma::user_id!("@u1:chatyy"), ruma::device_id!("PSTORE"), store, None)
        .await
        .map_err(fail)?;
    Ok(m.identity_keys().curve25519.to_base64().len() as u32)
}

#[cfg(all(target_family = "wasm", feature = "wasm"))]
mod web {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen(js_name = coreVersion)]
    pub fn core_version() -> String {
        super::core_version()
    }

    #[wasm_bindgen(js_name = provaRoundtrip)]
    pub async fn prova_roundtrip(text: String) -> Result<String, JsError> {
        super::roundtrip_inner(text).await.map_err(|e| JsError::new(&e.to_string()))
    }

    /// Abre o store IndexedDB (mesmo crate da web real). Só no navegador/worker.
    #[wasm_bindgen(js_name = provaStoreOpen)]
    pub async fn prova_store_open(name: String, passphrase: String) -> Result<u32, JsError> {
        let store = matrix_sdk_indexeddb::IndexeddbCryptoStore::open_with_passphrase(&name, &passphrase)
            .await
            .map_err(|e| JsError::new(&format!("{e:?}")))?;
        let m = matrix_sdk_crypto::OlmMachine::with_store(ruma::user_id!("@u1:chatyy"), ruma::device_id!("WSTORE"), store, None)
            .await
            .map_err(|e| JsError::new(&format!("{e:?}")))?;
        Ok(m.identity_keys().curve25519.to_base64().len() as u32)
    }
}

#[cfg(all(test, not(target_family = "wasm")))]
mod tests {
    #[tokio::test]
    async fn roundtrip() {
        assert_eq!(super::prova_roundtrip("oi 🔒".into()).await.unwrap(), "oi 🔒");
    }
    #[tokio::test]
    async fn store() {
        let d = std::env::temp_dir().join(format!("prova-store-{}", std::process::id()));
        assert_eq!(super::prova_store_open(d.to_string_lossy().into(), "x".repeat(32)).await.unwrap(), 43);
        let _ = std::fs::remove_dir_all(d);
    }
}
