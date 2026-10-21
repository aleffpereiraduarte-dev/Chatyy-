//! WP-04 — ponte wasm-bindgen do núcleo `chatyy-crypto` (CONTRATO §6) para o Web Worker.
//!
//! Regras:
//! - Nenhuma primitiva aqui: só conversão de tipos (JSON/bytes) entre JS e o núcleo.
//! - A fronteira é JSON em string (entrada e saída) + `Uint8Array` para bytes. O worker
//!   (`services/crypto/worker/worker.src.js`) faz `JSON.parse` e devolve objetos camelCase.
//! - Erros: a Promise rejeita com uma STRING JSON `{"code": "...", ...}` (sem conteúdo, sem
//!   chave — o núcleo já garante que `CoreError` não carrega segredo).
//! - O transporte é uma função JS `(action, bodyJson) => Promise<{status, body}>` (o worker
//!   faz o `fetch` com bearer + `X-E2EE-Device`).
use chatyy_crypto as cc;
use cc::{CoreError, CryptoCore, HttpResponse, HttpTransport, LinkWeb, LinkWebState, TransportError};
use js_sys::{Function, Promise, Reflect, Uint8Array};
use serde_json::{json, Value};
use std::sync::Arc;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::{future_to_promise, JsFuture};

// ---------------------------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------------------------

/// Função JS do worker. No wasm o trait `HttpTransport` do núcleo é `?Send` (uma thread só).
struct JsFn(Function);

struct JsTransport {
    f: JsFn,
}

#[async_trait::async_trait(?Send)]
impl HttpTransport for JsTransport {
    async fn call(&self, action: String, body_json: String) -> Result<HttpResponse, TransportError> {
        let net = |m: &str| TransportError::Network { msg: m.to_string() };
        let p = self
            .f
            .0
            .call2(&JsValue::NULL, &JsValue::from_str(&action), &JsValue::from_str(&body_json))
            .map_err(|_| net("transport_throw"))?;
        let p: Promise = p.dyn_into().map_err(|_| net("transport_not_promise"))?;
        let v = JsFuture::from(p).await.map_err(|e| net(&e.as_string().unwrap_or_else(|| "network".into())))?;
        let status = Reflect::get(&v, &JsValue::from_str("status"))
            .ok()
            .and_then(|s| s.as_f64())
            .ok_or_else(|| net("transport_no_status"))? as u16;
        let body = Reflect::get(&v, &JsValue::from_str("body")).ok().and_then(|b| b.as_string()).unwrap_or_default();
        Ok(HttpResponse { status, body })
    }
}

fn transport(f: Function) -> Arc<dyn HttpTransport> {
    Arc::new(JsTransport { f: JsFn(f) })
}

// ---------------------------------------------------------------------------------------------
// Erros e conversões
// ---------------------------------------------------------------------------------------------

fn err_json(e: &CoreError) -> Value {
    match e {
        CoreError::Utd { reason, session_id } => json!({"code": "utd", "reason": reason.as_str(), "retryable": reason.retryable(), "session_id": session_id}),
        CoreError::InvalidInput { field, msg } => json!({"code": "invalid_input", "field": field, "msg": msg}),
        CoreError::Transport { msg } => json!({"code": "transport", "msg": msg}),
        CoreError::Server { status, code } => json!({"code": "server", "status": status, "server_code": code}),
        CoreError::Store { msg } => json!({"code": "store", "msg": msg}),
        CoreError::LockBusy => json!({"code": "lock_busy"}),
        CoreError::Identity { msg } => json!({"code": "identity", "msg": msg}),
        CoreError::IdentityViolation { uids } => json!({"code": "identity_violation", "uids": uids}),
        CoreError::Media { msg } => json!({"code": "media", "msg": msg}),
        CoreError::Link { msg } => json!({"code": "link", "msg": msg}),
        CoreError::Backup { msg } => json!({"code": "backup", "msg": msg}),
        CoreError::Internal { msg } => json!({"code": "internal", "msg": msg}),
    }
}

fn js_err(e: CoreError) -> JsValue {
    JsValue::from_str(&err_json(&e).to_string())
}

fn bad_input(field: &str) -> JsValue {
    JsValue::from_str(&json!({"code": "invalid_input", "field": field, "msg": "json"}).to_string())
}

fn parse(field: &str, s: &str) -> Result<Value, JsValue> {
    serde_json::from_str(s).map_err(|_| bad_input(field))
}

fn str_vec(field: &str, s: &str) -> Result<Vec<String>, JsValue> {
    serde_json::from_str::<Vec<String>>(s).map_err(|_| bad_input(field))
}

fn s(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn u(v: &Value, k: &str) -> u64 {
    match v.get(k) {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
        Some(Value::String(x)) => x.parse().unwrap_or(0),
        _ => 0,
    }
}

fn trust_str(t: cc::Trust) -> &'static str {
    match t {
        cc::Trust::Verified => "verified",
        cc::Trust::Tofu => "tofu",
        cc::Trust::Changed => "changed",
    }
}

fn device_json(d: &cc::DeviceSummary) -> Value {
    json!({"uid": d.uid, "deviceId": d.device_id, "ed25519": d.ed25519, "curve25519": d.curve25519,
           "signedByOwner": d.signed_by_owner, "isThisDevice": d.is_this_device})
}

fn identity_json(i: &cc::IdentityStatus) -> Value {
    json!({"uid": i.uid, "hasIdentity": i.has_identity, "masterKey": i.master_key, "verified": i.verified,
           "needsApproval": i.needs_approval, "isPrimary": i.is_primary})
}

fn sync_json(r: &cc::SyncResult) -> Value {
    let evs: Vec<Value> = r
        .chatyy_events
        .iter()
        .map(|e| json!({"eventType": e.event_type, "senderUid": e.sender_uid, "senderDeviceId": e.sender_device_id, "contentJson": e.content_json}))
        .collect();
    json!({"toDeviceProcessed": r.to_device_processed, "toDeviceUtd": r.to_device_utd, "convsWithNewKeys": r.convs_with_new_keys,
           "chatyyEvents": evs, "identityChangedUids": r.identity_changed_uids, "more": r.more})
}

fn import_json(r: &cc::ImportResult) -> Value {
    json!({"imported": r.imported, "total": r.total, "convs": r.convs})
}

fn filter_from(v: &Value) -> cc::ExportFilter {
    let conv_ids = v
        .get("convIds")
        .or_else(|| v.get("conv_ids"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from).or_else(|| x.as_u64().map(|n| n.to_string()))).collect())
        .unwrap_or_default();
    let since_ms = if v.get("sinceMs").is_some() { u(v, "sinceMs") } else { u(v, "since_ms") };
    cc::ExportFilter { conv_ids, since_ms }
}

fn ok_str(v: Value) -> Result<JsValue, JsValue> {
    Ok(JsValue::from_str(&v.to_string()))
}

macro_rules! promise {
    ($body:expr) => {
        future_to_promise(async move { $body })
    };
}

// ---------------------------------------------------------------------------------------------
// Funções livres (CONTRATO §6.3)
// ---------------------------------------------------------------------------------------------

#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
    cc::core_version()
}

#[wasm_bindgen(js_name = newDeviceId)]
pub fn new_device_id(prefix: &str) -> Result<String, JsValue> {
    cc::new_device_id(prefix).map_err(js_err)
}

/// `-1` = não é envelope `{"e2e":N}`; senão N.
#[wasm_bindgen(js_name = envelopeVersion)]
pub fn envelope_version(content: &str) -> f64 {
    cc::envelope_version(content).map(|v| v as f64).unwrap_or(-1.0)
}

/// Devolve `{info_json}` em JSON; os bytes cifrados ficam em `out` via `encryptBytesData`.
/// Para evitar cópia dupla, a API é: `encryptBytes(plain) -> [Uint8Array data, infoJson]`.
#[wasm_bindgen(js_name = encryptBytes)]
pub fn encrypt_bytes(plain: &[u8]) -> Result<js_sys::Array, JsValue> {
    let r = cc::encrypt_bytes(plain.to_vec()).map_err(js_err)?;
    let a = js_sys::Array::new();
    a.push(&Uint8Array::from(r.data.as_slice()).into());
    a.push(&JsValue::from_str(&r.info_json));
    Ok(a)
}

#[wasm_bindgen(js_name = decryptBytes)]
pub fn decrypt_bytes(data: &[u8], info_json: &str) -> Result<Vec<u8>, JsValue> {
    cc::decrypt_bytes(data.to_vec(), info_json.to_string()).map_err(js_err)
}

/// `msk_a`/`msk_b` em bytes crus (32 B). Devolve JSON `{digits, qrPayload}`.
#[wasm_bindgen(js_name = safetyNumberFor)]
pub fn safety_number_for(uid_a: &str, msk_a: &[u8], uid_b: &str, msk_b: &[u8]) -> String {
    let n = cc::safety_number_for(uid_a, msk_a, uid_b, msk_b);
    json!({"digits": n.digits, "qrPayload": n.qr_payload}).to_string()
}

// ---------------------------------------------------------------------------------------------
// CryptoCore (CONTRATO §6.4)
// ---------------------------------------------------------------------------------------------

#[wasm_bindgen]
pub struct WasmCore {
    inner: Arc<CryptoCore>,
    tr: Arc<dyn HttpTransport>,
}

/// Abre o store IndexedDB `store_name` (`chatyy-e2ee5-<uid>`) com a senha derivada no worker.
/// Sem rede. Resolve com um `WasmCore`.
#[wasm_bindgen(js_name = openCore)]
pub fn open_core(store_name: String, store_passphrase: String, uid: String, device_id: String, holder_suffix: String, transport_fn: Function) -> Promise {
    let tr = transport(transport_fn);
    promise!({
        let opts = cc::OpenOptions { store_dir: store_name, store_passphrase, uid, device_id, role: cc::ProcessRole::Web, holder_suffix };
        let inner = CryptoCore::open(opts, tr.clone()).await.map_err(js_err)?;
        Ok(JsValue::from(WasmCore { inner, tr }))
    })
}

#[wasm_bindgen]
impl WasmCore {
    pub fn uid(&self) -> String {
        self.inner.uid()
    }

    #[wasm_bindgen(js_name = deviceId)]
    pub fn device_id(&self) -> String {
        self.inner.device_id()
    }

    #[wasm_bindgen(js_name = thisDevice)]
    pub fn this_device(&self) -> Promise {
        let c = self.inner.clone();
        promise!(ok_str(device_json(&c.this_device().await.map_err(js_err)?)))
    }

    pub fn sync(&self) -> Promise {
        let c = self.inner.clone();
        promise!(ok_str(sync_json(&c.sync().await.map_err(js_err)?)))
    }

    #[wasm_bindgen(js_name = syncWith)]
    pub fn sync_with(&self, sync_data_json: String) -> Promise {
        let c = self.inner.clone();
        promise!(ok_str(sync_json(&c.sync_with(sync_data_json).await.map_err(js_err)?)))
    }

    /// `uids_json` = `["7","42"]`.
    #[wasm_bindgen(js_name = trackUsers)]
    pub fn track_users(&self, uids_json: String) -> Promise {
        let c = self.inner.clone();
        promise!({
            let uids = str_vec("uids", &uids_json)?;
            c.track_users(uids).await.map_err(js_err)?;
            ok_str(json!({}))
        })
    }

    pub fn encrypt(&self, conv_id: String, member_uids_json: String, payload_json: String) -> Promise {
        let c = self.inner.clone();
        promise!({
            let members = str_vec("member_uids", &member_uids_json)?;
            let r = c.encrypt(conv_id, members, payload_json).await.map_err(js_err)?;
            ok_str(json!({"envelopeJson": r.envelope_json, "sessionId": r.session_id, "keyShareRequests": r.key_share_requests, "keyShareBytes": r.key_share_bytes}))
        })
    }

    /// `input_json` = `{convId, envelopeJson, senderUid, serverMid, cmid, tsMs}`.
    pub fn decrypt(&self, input_json: String) -> Promise {
        let c = self.inner.clone();
        promise!({
            let v = parse("input", &input_json)?;
            let input = cc::DecryptInput {
                conv_id: s(&v, "convId"),
                envelope_json: s(&v, "envelopeJson"),
                sender_uid: s(&v, "senderUid"),
                server_mid: s(&v, "serverMid"),
                cmid: s(&v, "cmid"),
                ts_ms: u(&v, "tsMs"),
            };
            let d = c.decrypt(input).await.map_err(js_err)?;
            ok_str(json!({"payloadJson": d.payload_json, "senderUid": d.sender_uid, "senderDeviceId": d.sender_device_id,
                          "trust": trust_str(d.trust), "sessionId": d.session_id}))
        })
    }

    /// `targets_json` = `[{uid, deviceId}]` (deviceId vazio = todos os assinados).
    #[wasm_bindgen(js_name = sendToDevice)]
    pub fn send_to_device(&self, event_type: String, targets_json: String, content_json: String) -> Promise {
        let c = self.inner.clone();
        promise!({
            let arr = parse("targets", &targets_json)?;
            let targets = arr
                .as_array()
                .ok_or_else(|| bad_input("targets"))?
                .iter()
                .map(|t| cc::DeviceTarget { uid: s(t, "uid"), device_id: if t.get("deviceId").is_some() { s(t, "deviceId") } else { s(t, "device_id") } })
                .collect();
            let r = c.send_to_device(event_type, targets, content_json).await.map_err(js_err)?;
            ok_str(json!({"sentDevices": r.sent_devices, "withheld": r.withheld}))
        })
    }

    #[wasm_bindgen(js_name = rotateConversation)]
    pub fn rotate_conversation(&self, conv_id: String) -> Promise {
        let c = self.inner.clone();
        promise!(ok_str(json!(c.rotate_conversation(conv_id).await.map_err(js_err)?)))
    }

    #[wasm_bindgen(js_name = onMembersChanged)]
    pub fn on_members_changed(&self, conv_id: String, member_uids_json: String, removed_uids_json: String) -> Promise {
        let c = self.inner.clone();
        promise!({
            let m = str_vec("member_uids", &member_uids_json)?;
            let r = str_vec("removed_uids", &removed_uids_json)?;
            c.on_members_changed(conv_id, m, r).await.map_err(js_err)?;
            ok_str(json!({}))
        })
    }

    #[wasm_bindgen(js_name = forgetDevice)]
    pub fn forget_device(&self, device_id: String) -> Promise {
        let c = self.inner.clone();
        promise!(ok_str(json!(c.forget_device(device_id).await.map_err(js_err)?)))
    }

    #[wasm_bindgen(js_name = listDevices)]
    pub fn list_devices(&self, uid: String) -> Promise {
        let c = self.inner.clone();
        promise!({
            let v: Vec<Value> = c.list_devices(uid).await.map_err(js_err)?.iter().map(device_json).collect();
            ok_str(Value::Array(v))
        })
    }

    #[wasm_bindgen(js_name = bootstrapIdentity)]
    pub fn bootstrap_identity(&self) -> Promise {
        let c = self.inner.clone();
        promise!(ok_str(identity_json(&c.bootstrap_identity().await.map_err(js_err)?)))
    }

    #[wasm_bindgen(js_name = signDevice)]
    pub fn sign_device(&self, device_id: String, expected_ed25519: String) -> Promise {
        let c = self.inner.clone();
        promise!({
            c.sign_device(device_id, expected_ed25519).await.map_err(js_err)?;
            ok_str(json!({}))
        })
    }

    #[wasm_bindgen(js_name = identityStatus)]
    pub fn identity_status(&self, uid: String) -> Promise {
        let c = self.inner.clone();
        promise!(ok_str(identity_json(&c.identity_status(uid).await.map_err(js_err)?)))
    }

    #[wasm_bindgen(js_name = pinIdentity)]
    pub fn pin_identity(&self, uid: String) -> Promise {
        let c = self.inner.clone();
        promise!({
            c.pin_identity(uid).await.map_err(js_err)?;
            ok_str(json!({}))
        })
    }

    #[wasm_bindgen(js_name = safetyNumber)]
    pub fn safety_number(&self, uid: String) -> Promise {
        let c = self.inner.clone();
        promise!({
            let n = c.safety_number(uid).await.map_err(js_err)?;
            ok_str(json!({"digits": n.digits, "qrPayload": n.qr_payload}))
        })
    }

    #[wasm_bindgen(js_name = verifySafetyQr)]
    pub fn verify_safety_qr(&self, uid: String, scanned: String) -> Promise {
        let c = self.inner.clone();
        promise!(ok_str(json!(c.verify_safety_qr(uid, scanned).await.map_err(js_err)?)))
    }

    #[wasm_bindgen(js_name = markVerified)]
    pub fn mark_verified(&self, uid: String) -> Promise {
        let c = self.inner.clone();
        promise!({
            c.mark_verified(uid).await.map_err(js_err)?;
            ok_str(json!({}))
        })
    }

    /// Resolve com `Uint8Array` (SEGREDO: nunca logar/persistir em claro).
    #[wasm_bindgen(js_name = exportRoomKeys)]
    pub fn export_room_keys(&self, filter_json: String) -> Promise {
        let c = self.inner.clone();
        promise!({
            let f = filter_from(&parse("filter", &filter_json)?);
            let b = c.export_room_keys(f).await.map_err(js_err)?;
            Ok(Uint8Array::from(b.as_slice()).into())
        })
    }

    #[wasm_bindgen(js_name = importRoomKeys)]
    pub fn import_room_keys(&self, blob: Vec<u8>) -> Promise {
        let c = self.inner.clone();
        promise!(ok_str(import_json(&c.import_room_keys(blob).await.map_err(js_err)?)))
    }

    #[wasm_bindgen(js_name = exportRoomKeysWithPassphrase)]
    pub fn export_room_keys_with_passphrase(&self, passphrase: String) -> Promise {
        let c = self.inner.clone();
        promise!(Ok(JsValue::from_str(&c.export_room_keys_with_passphrase(passphrase).await.map_err(js_err)?)))
    }

    #[wasm_bindgen(js_name = importRoomKeysWithPassphrase)]
    pub fn import_room_keys_with_passphrase(&self, data: String, passphrase: String) -> Promise {
        let c = self.inner.clone();
        promise!(ok_str(import_json(&c.import_room_keys_with_passphrase(data, passphrase).await.map_err(js_err)?)))
    }

    #[wasm_bindgen(js_name = backupEnable)]
    pub fn backup_enable(&self, passphrase: String) -> Promise {
        let c = self.inner.clone();
        promise!({
            let r = c.backup_enable(passphrase).await.map_err(js_err)?;
            ok_str(json!({"recoveryKey": r.recovery_key, "version": r.version}))
        })
    }

    #[wasm_bindgen(js_name = backupStep)]
    pub fn backup_step(&self, max_batches: u32) -> Promise {
        let c = self.inner.clone();
        promise!(ok_str(json!(c.backup_step(max_batches).await.map_err(js_err)?)))
    }

    #[wasm_bindgen(js_name = backupStatus)]
    pub fn backup_status(&self) -> Promise {
        let c = self.inner.clone();
        promise!({
            let r = c.backup_status().await.map_err(js_err)?;
            ok_str(json!({"enabled": r.enabled, "version": r.version, "totalKeys": r.total_keys, "backedUpKeys": r.backed_up_keys}))
        })
    }

    #[wasm_bindgen(js_name = backupDisable)]
    pub fn backup_disable(&self) -> Promise {
        let c = self.inner.clone();
        promise!({
            c.backup_disable().await.map_err(js_err)?;
            ok_str(json!({}))
        })
    }

    #[wasm_bindgen(js_name = backupRestore)]
    pub fn backup_restore(&self, key_or_passphrase: String) -> Promise {
        let c = self.inner.clone();
        promise!({
            let r = c.backup_restore(key_or_passphrase).await.map_err(js_err)?;
            ok_str(json!({"imported": r.imported, "total": r.total, "identityRestored": r.identity_restored, "convs": r.convs}))
        })
    }

    #[wasm_bindgen(js_name = metricsSnapshot)]
    pub fn metrics_snapshot(&self) -> String {
        let m = self.inner.metrics_snapshot();
        json!({"encrypt": m.encrypt, "decryptOk": m.decrypt_ok, "utdJson": m.utd_json, "utdTotal": m.utd_total,
               "toDeviceIn": m.to_device_in, "toDeviceUtd": m.to_device_utd, "droppedUntrusted": m.dropped_untrusted,
               "storeReloads": m.store_reloads})
        .to_string()
    }

    #[wasm_bindgen(js_name = flushMetrics)]
    pub fn flush_metrics(&self) -> Promise {
        let c = self.inner.clone();
        promise!({
            c.flush_metrics().await.map_err(js_err)?;
            ok_str(json!({}))
        })
    }

    // ----- Vínculo por QR, lado web (CONTRATO §6.7, F4) -----

    /// O `LinkWeb` não precisa de core até o `Hello`; mas o worker só cria core depois de saber
    /// o uid, então expomos o vínculo como objeto separado (`linkWebBegin`).
    #[wasm_bindgen(js_name = linkSendDevice)]
    pub fn link_send_device(&self, link: &WasmLinkWeb) -> Promise {
        let c = self.inner.clone();
        let l = link.inner.clone();
        promise!({
            l.send_device(c).await.map_err(js_err)?;
            ok_str(json!({}))
        })
    }

    #[wasm_bindgen(js_name = linkCompleteUpload)]
    pub fn link_complete_upload(&self, link: &WasmLinkWeb) -> Promise {
        let c = self.inner.clone();
        let l = link.inner.clone();
        promise!({
            l.complete_upload(c).await.map_err(js_err)?;
            ok_str(json!({}))
        })
    }

    #[wasm_bindgen(js_name = linkPoll)]
    pub fn link_poll(&self, link: &WasmLinkWeb) -> Promise {
        let c = self.inner.clone();
        let l = link.inner.clone();
        promise!(ok_str(link_state_json(&l.poll(Some(c)).await.map_err(js_err)?)))
    }

    /// Transporte em uso (o vínculo web reaproveita o mesmo `fetch`).
    #[wasm_bindgen(js_name = hasTransport)]
    pub fn has_transport(&self) -> bool {
        Arc::strong_count(&self.tr) > 0
    }
}

fn link_state_json(s: &LinkWebState) -> Value {
    match s {
        LinkWebState::Waiting => json!({"state": "waiting"}),
        // `bearer` vai só ao worker (que o instala no transporte e NÃO o devolve à página).
        LinkWebState::Hello { uid, check_code } => json!({"state": "hello", "uid": uid, "checkCode": check_code}),
        LinkWebState::Granted { bearer } => json!({"state": "granted", "bearer": bearer}),
        LinkWebState::Importing { received_chunks, total_chunks } => {
            json!({"state": "importing", "receivedChunks": received_chunks, "totalChunks": total_chunks})
        }
        LinkWebState::Done { imported } => json!({"state": "done", "imported": imported}),
    }
}

#[wasm_bindgen]
pub struct WasmLinkWeb {
    inner: Arc<LinkWeb>,
}

#[wasm_bindgen(js_name = linkWebBegin)]
pub fn link_web_begin(transport_fn: Function) -> Promise {
    let tr = transport(transport_fn);
    promise!({
        let inner = LinkWeb::begin(tr).await.map_err(js_err)?;
        Ok(JsValue::from(WasmLinkWeb { inner }))
    })
}

#[wasm_bindgen]
impl WasmLinkWeb {
    /// Conteúdo do QR (SEGREDO de 32 B dentro: só para desenhar o QR, nunca logar).
    #[wasm_bindgen(js_name = qrPayload)]
    pub fn qr_payload(&self) -> String {
        self.inner.qr_payload()
    }
    #[wasm_bindgen(js_name = linkId)]
    pub fn link_id(&self) -> String {
        self.inner.link_id()
    }
    /// Poll ANTES de existir core (até o `Hello`).
    #[wasm_bindgen(js_name = pollNoCore)]
    pub fn poll_no_core(&self) -> Promise {
        let l = self.inner.clone();
        promise!(ok_str(link_state_json(&l.poll(None).await.map_err(js_err)?)))
    }
}
