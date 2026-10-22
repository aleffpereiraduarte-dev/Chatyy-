//! [1.7] Pedido de chave de sala ("nunca perder mensagem", nível WhatsApp/Matrix).
//!
//! Quando um aparelho NÃO tem a chave Megolm de uma sessão que já existe (to-device perdido,
//! sessão Olm emperrada, lista de aparelhos velha no remetente…), ele pede a chave ao remetente:
//!
//! 1. destinatário: `request_room_key(conv, session, sender_uid, mid)` → servidor
//!    `e2ee5_key_request` confere (membro da conversa NA HORA da mensagem, aparelho já existia,
//!    a mensagem é dessa sessão e desse remetente), grava o pedido (dedupe/limite) e devolve o
//!    `min_index` (índice Megolm da mensagem). Em seguida vai `chatyy.key_request` (Olm) aos
//!    aparelhos do remetente.
//! 2. remetente (só o aparelho DONO da sessão, i.e. quem a criou): `share_room_key(conv, session,
//!    target_uid, target_devices)` → servidor `e2ee5_key_request_check` atesta quais aparelhos
//!    pediram (e o `min_index`); o núcleo ainda aplica as regras LOCAIS: registro de com quem a
//!    sessão foi compartilhada (`share_log`) — se a sessão tem registro e o usuário-alvo não
//!    estava nele, recusa (entrou depois); índice = max(min_index do servidor, índice do registro).
//!    A chave vai num `chatyy.room_key` (Olm, só para o aparelho que pediu e é assinado pelo dono),
//!    exportada A PARTIR desse índice (nunca o passado anterior).
//! 3. destinatário: o `sync()` intercepta `chatyy.room_key` DENTRO do núcleo (a chave nunca vai ao
//!    host), confere que foi pedida, que veio do aparelho criador da sessão (curve25519 + ed25519 da
//!    sessão = do aparelho Olm remetente, assinado pelo dono) e importa; a conversa entra em
//!    `convs_with_new_keys` e o host re-tenta as mensagens "aguardando".
//!
//! Por que não `m.forwarded_room_key` da matrix-sdk-crypto 0.18: o receptor só aceita forward de
//! aparelho PRÓPRIO verificado (`should_accept_forward`) e o reenvio do `m.room_key` da sessão de
//! SAÍDA só serve do índice ATUAL em diante (a catraca já passou das mensagens perdidas). O
//! `chatyy.room_key` é o equivalente seguro do `m.room_key` do criador: autenticado pela sessão
//! Olm do próprio aparelho criador, com as mesmas chaves que a matrix-sdk grava em sessões importadas.
use crate::core::{CryptoCore, DeviceTarget};
use crate::error::{invalid, CoreResult};
use crate::ids::{room_id_for_conv, uid_from_user_id, user_id_for_uid, validate_device_id};
use crate::transport::{actions, call_json};
use crate::util::now_ms;
use matrix_sdk_common::deserialized_responses::{AlgorithmInfo, EncryptionInfo};
use matrix_sdk_crypto::{types::requests::ToDeviceRequest, CollectStrategy, OlmMachine};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

pub(crate) const EV_KEY_REQUEST: &str = "chatyy.key_request";
pub(crate) const EV_ROOM_KEY: &str = "chatyy.room_key";

const CV_SHARE_LOG: &str = "chatyy.share_log";
const CV_REQ_OUT: &str = "chatyy.keyreq_out";
const CV_SERVED: &str = "chatyy.keyreq_served";
/// Sessões guardadas no registro de compartilhamento (as mais recentes).
const SHARE_LOG_MAX: usize = 2000;
const SHARE_LOG_MAX_AGE_MS: u64 = 120 * 24 * 3600 * 1000;
/// Destinatário: o mesmo pedido (sessão) não sai de novo antes disto, e no máx. N/24 h.
pub(crate) const REQ_DEDUP_MS: u64 = 30_000;
pub(crate) const REQ_MAX_PER_DAY: u32 = 6;
/// Pedido local aceito por até 48 h (chave que chega depois disso é descartada).
const REQ_ACCEPT_MS: u64 = 48 * 3600 * 1000;
/// Remetente: o mesmo (sessão, aparelho) não é servido de novo antes disto.
pub(crate) const SERVE_DEDUP_MS: u64 = 120_000;
pub(crate) const SERVE_MAX_DEVICES: usize = 20;

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct KeyRequestResult {
    /// `chatyy.key_request` saiu para os aparelhos do remetente.
    pub sent: bool,
    /// Pedido repetido (local ou no servidor): nada saiu de novo.
    pub dedup: bool,
    pub req_id: String,
    pub sent_devices: u32,
    /// "" (ok) · `dedup` · `rate_limited` · `refused:<motivo do servidor>` · `own_session`.
    pub reason: String,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ShareKeyResult {
    /// Aparelhos que receberam `chatyy.room_key`.
    pub shared_devices: u32,
    /// "uid/device:motivo" dos recusados/pulados.
    pub refused: Vec<String>,
    /// "" (ok) · `unknown_session` · `not_owner` · `not_attested` · `not_member_at_share`.
    pub reason: String,
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct ShareLogEntry {
    conv: String,
    ts: u64,
    /// "uid/device" → 1º índice Megolm com que o aparelho recebeu a chave.
    devs: BTreeMap<String, u32>,
}

#[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
struct ReqOut {
    conv: String,
    last: u64,
    day_start: u64,
    n: u32,
}

impl CryptoCore {
    async fn kr_get<T: serde::de::DeserializeOwned + Default>(m: &OlmMachine, k: &str) -> CoreResult<T> {
        Ok(m
            .store()
            .get_custom_value(k)
            .await?
            .and_then(|v| serde_json::from_slice(&v).ok())
            .unwrap_or_default())
    }
    async fn kr_set<T: serde::Serialize>(m: &OlmMachine, k: &str, v: &T) -> CoreResult<()> {
        m.store().set_custom_value(k, serde_json::to_vec(v)?).await?;
        Ok(())
    }

    /// Chamado pelo `encrypt`: guarda com quais aparelhos a sessão foi compartilhada e a partir
    /// de qual índice (a fonte LOCAL da regra "só quem era membro quando a chave saiu").
    pub(crate) async fn record_share(m: &OlmMachine, conv_id: &str, session_id: &str, index: u32, reqs: &[Arc<ToDeviceRequest>]) -> CoreResult<()> {
        let mut devs: Vec<String> = vec![];
        for r in reqs {
            if r.event_type.to_string() != "m.room.encrypted" {
                continue; // withheld etc.
            }
            for (u, ds) in &r.messages {
                let Some(uid) = uid_from_user_id(u.as_str()) else { continue };
                for d in ds.keys() {
                    if let ruma::to_device::DeviceIdOrAllDevices::DeviceId(d) = d {
                        devs.push(format!("{uid}/{d}"));
                    }
                }
            }
        }
        if devs.is_empty() || session_id.is_empty() {
            return Ok(());
        }
        let mut log: BTreeMap<String, ShareLogEntry> = Self::kr_get(m, CV_SHARE_LOG).await?;
        let now = now_ms();
        let e = log.entry(session_id.to_string()).or_insert_with(|| ShareLogEntry { conv: conv_id.to_string(), ts: now, devs: BTreeMap::new() });
        e.ts = now;
        for d in devs {
            e.devs.entry(d).or_insert(index);
        }
        log.retain(|_, v| now.saturating_sub(v.ts) <= SHARE_LOG_MAX_AGE_MS);
        if log.len() > SHARE_LOG_MAX {
            let mut by_ts: Vec<(u64, String)> = log.iter().map(|(k, v)| (v.ts, k.clone())).collect();
            by_ts.sort();
            for (_, k) in by_ts.into_iter().take(log.len() - SHARE_LOG_MAX) {
                log.remove(&k);
            }
        }
        Self::kr_set(m, CV_SHARE_LOG, &log).await
    }

    /// Recebeu `chatyy.room_key` (já decifrado por Olm, de aparelho assinado pelo dono).
    /// Ok(Some(conv)) = chave importada. Ok(None) = descartado (não pedido, chaves não batem…).
    pub(crate) async fn receive_room_key_share(&self, m: &OlmMachine, content: &Value, info: &EncryptionInfo) -> CoreResult<Option<String>> {
        let conv = content.get("conv_id").and_then(Value::as_str).unwrap_or("").to_string();
        let sid = content.get("session_id").and_then(Value::as_str).unwrap_or("").to_string();
        let key = content.get("key").cloned().unwrap_or(Value::Null);
        let refuse = |_why: &str| -> CoreResult<Option<String>> {
            self.metrics.add_key_req_refused(1);
            Ok(None)
        };
        let Ok(room) = room_id_for_conv(&conv) else { return refuse("conv") };
        if sid.is_empty() || key.get("session_id").and_then(Value::as_str) != Some(sid.as_str()) || key.get("room_id").and_then(Value::as_str) != Some(room.as_str()) {
            return refuse("ids");
        }
        // Só aceito o que EU pedi (e há pouco tempo).
        let mut out: BTreeMap<String, ReqOut> = Self::kr_get(m, CV_REQ_OUT).await?;
        match out.get(&sid) {
            Some(r) if r.conv == conv && now_ms().saturating_sub(r.last) <= REQ_ACCEPT_MS => {}
            _ => return refuse("unsolicited"),
        }
        // A chave tem de ser do aparelho que a CRIOU e que agora a mandou por Olm.
        if key.get("forwarding_curve25519_key_chain").and_then(Value::as_array).map(|a| !a.is_empty()).unwrap_or(false) {
            return refuse("forwarded");
        }
        let Some(dev_id) = info.sender_device.clone() else { return refuse("no_device") };
        let Some(dev) = m.get_device(&info.sender, &dev_id, None).await? else { return refuse("unknown_device") };
        if !dev.is_cross_signed_by_owner() {
            return refuse("unsigned");
        }
        let dev_curve = dev.curve25519_key().map(|k| k.to_base64()).unwrap_or_default();
        let dev_ed = dev.ed25519_key().map(|k| k.to_base64()).unwrap_or_default();
        let olm_curve = match &info.algorithm_info {
            AlgorithmInfo::OlmV1Curve25519AesSha2 { curve25519_public_key_base64 } => curve25519_public_key_base64.clone(),
            _ => String::new(),
        };
        let key_curve = key.get("sender_key").and_then(Value::as_str).unwrap_or("");
        let key_ed = key.get("sender_claimed_keys").and_then(|k| k.get("ed25519")).and_then(Value::as_str).unwrap_or("");
        if dev_curve.is_empty() || dev_ed.is_empty() || key_curve != dev_curve || olm_curve != dev_curve || key_ed != dev_ed {
            return refuse("keys_mismatch");
        }
        let Ok(k) = serde_json::from_value::<matrix_sdk_crypto::olm::ExportedRoomKey>(key) else { return refuse("bad_key") };
        let r = self.import_keys_locked(m, vec![k], None).await?;
        out.remove(&sid);
        Self::kr_set(m, CV_REQ_OUT, &out).await?;
        self.metrics.inc_key_req_ok();
        Ok(if r.total > 0 { Some(conv) } else { None })
    }
}

#[cfg_attr(feature = "uniffi", uniffi::export(async_runtime = "tokio"))]
impl CryptoCore {
    /// [1.7] Destinatário sem a chave da sessão `session_id` (mensagem `server_mid` de
    /// `sender_uid`): pede ao remetente. Dedupe local (30 s, 6/24 h por sessão) + servidor.
    pub async fn request_room_key(&self, conv_id: String, session_id: String, sender_uid: String, server_mid: String) -> CoreResult<KeyRequestResult> {
        room_id_for_conv(&conv_id)?;
        user_id_for_uid(&sender_uid)?;
        if session_id.is_empty() || session_id.len() > 128 {
            return Err(invalid("session_id", "obrigatório (≤128)"));
        }
        if !server_mid.chars().all(|c| c.is_ascii_digit()) || server_mid.is_empty() || server_mid.len() > 20 {
            return Err(invalid("server_mid", "id numérico da mensagem"));
        }
        let mut res = KeyRequestResult { sent: false, dedup: false, req_id: String::new(), sent_devices: 0, reason: String::new() };
        let op = self.op().await?;
        let m = &op.m;
        // Já tenho a sessão (ex.: chegou enquanto o host esperava)? Não pede.
        if let Some(s) = m.store().get_inbound_group_session(&room_id_for_conv(&conv_id)?, &session_id).await? {
            if s.sender_key() == m.identity_keys().curve25519 {
                res.reason = "own_session".into();
                return Ok(res);
            }
        }
        let now = now_ms();
        let mut out: BTreeMap<String, ReqOut> = Self::kr_get(m, CV_REQ_OUT).await?;
        out.retain(|_, r| now.saturating_sub(r.last) <= REQ_ACCEPT_MS);
        let mut r = out.get(&session_id).cloned().unwrap_or_default();
        if now.saturating_sub(r.day_start) > 24 * 3600 * 1000 {
            r.day_start = now;
            r.n = 0;
        }
        if r.last != 0 && now.saturating_sub(r.last) < REQ_DEDUP_MS {
            res.dedup = true;
            res.reason = "dedup".into();
            return Ok(res);
        }
        if r.n >= REQ_MAX_PER_DAY {
            res.reason = "rate_limited".into();
            return Ok(res);
        }
        let d = match call_json(
            self.transport.as_ref(),
            actions::KEY_REQUEST,
            &json!({"conv_id": conv_id, "session_id": session_id, "sender_uid": sender_uid, "mid": server_mid}),
        )
        .await
        {
            Ok(d) => d,
            Err(crate::error::CoreError::Server { status: 403, code }) if code == "e2ee5_key_request_refused" => {
                res.reason = "refused".into();
                return Ok(res);
            }
            Err(e) => return Err(e),
        };
        res.req_id = d.get("req_id").and_then(|v| v.as_str().map(String::from).or_else(|| v.as_u64().map(|n| n.to_string()))).unwrap_or_default();
        // Conta a tentativa e marca o pedido como MEU (a resposta só é aceita se eu pedi).
        r.conv = conv_id.clone();
        r.last = now;
        r.n += 1;
        out.insert(session_id.clone(), r);
        Self::kr_set(m, CV_REQ_OUT, &out).await?;
        if d.get("dedup").and_then(Value::as_bool).unwrap_or(false) {
            res.dedup = true;
            res.reason = "dedup".into();
            return Ok(res);
        }
        let content = json!({"v": 1, "req_id": res.req_id, "conv_id": conv_id, "session_id": session_id, "mid": server_mid});
        let sr = self
            .send_to_device_locked(m, EV_KEY_REQUEST, &[DeviceTarget { uid: sender_uid, device_id: String::new() }], &content)
            .await?;
        res.sent_devices = sr.sent_devices;
        res.sent = sr.sent_devices > 0;
        if res.sent {
            self.metrics.inc_key_req_sent();
        }
        Ok(res)
    }

    /// [1.7] Remetente: reenvia a chave da sessão `session_id` (que ESTE aparelho criou) aos
    /// aparelhos `target_devices` de `target_uid` (vazio = todos que pediram), só se o servidor
    /// atesta o pedido (membro na hora da mensagem) e o registro local de compartilhamento não
    /// contradiz (quem entrou depois nunca recebe; índice nunca anterior ao que já tinha).
    pub async fn share_room_key(&self, conv_id: String, session_id: String, target_uid: String, target_devices: Vec<String>) -> CoreResult<ShareKeyResult> {
        let room = room_id_for_conv(&conv_id)?;
        let target = user_id_for_uid(&target_uid)?;
        if target_devices.len() > SERVE_MAX_DEVICES {
            return Err(invalid("target_devices", "máx 20"));
        }
        for d in &target_devices {
            validate_device_id(d)?;
        }
        let mut res = ShareKeyResult { shared_devices: 0, refused: vec![], reason: String::new() };
        let op = self.op().await?;
        let m = &op.m;
        let Some(session) = m.store().get_inbound_group_session(&room, &session_id).await? else {
            res.reason = "unknown_session".into();
            return Ok(res);
        };
        if session.sender_key() != m.identity_keys().curve25519 {
            // Só o aparelho que criou a sessão reenvia (os outros aparelhos do remetente ignoram).
            res.reason = "not_owner".into();
            return Ok(res);
        }
        let d = call_json(
            self.transport.as_ref(),
            actions::KEY_REQUEST_CHECK,
            &json!({"conv_id": conv_id, "session_id": session_id, "target_uid": target_uid, "target_devices": target_devices}),
        )
        .await?;
        let allowed: Vec<(String, u32, String)> = d
            .get("allowed")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| {
                        let dev = x.get("device_id")?.as_str()?.to_string();
                        let idx = x.get("min_index").and_then(Value::as_u64).unwrap_or(0).min(u32::MAX as u64) as u32;
                        let rid = x.get("req_id").map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).unwrap_or_default();
                        Some((dev, idx, rid))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if allowed.is_empty() {
            res.reason = "not_attested".into();
            self.metrics.add_key_req_refused(target_devices.len().max(1) as u64);
            return Ok(res);
        }
        let log: BTreeMap<String, ShareLogEntry> = Self::kr_get(m, CV_SHARE_LOG).await?;
        let entry = log.get(&session_id);
        let prefix = format!("{target_uid}/");
        let uid_min: Option<u32> = entry.and_then(|e| e.devs.iter().filter(|(k, _)| k.starts_with(&prefix)).map(|(_, v)| *v).min());
        if entry.is_some() && uid_min.is_none() {
            // A sessão saiu para os membros de então e este usuário não estava entre eles.
            res.reason = "not_member_at_share".into();
            res.refused = allowed.iter().map(|(d, _, _)| format!("{target_uid}/{d}:not_member_at_share")).collect();
            self.metrics.add_key_req_refused(allowed.len() as u64);
            return Ok(res);
        }
        let now = now_ms();
        let mut served: BTreeMap<String, u64> = Self::kr_get(m, CV_SERVED).await?;
        served.retain(|_, t| now.saturating_sub(*t) <= 24 * 3600 * 1000);
        self.ensure_sessions(m, &[target.clone()]).await?;
        let mut n = 0u32;
        for (dev, srv_idx, rid) in allowed.into_iter().take(SERVE_MAX_DEVICES) {
            if !target_devices.is_empty() && !target_devices.contains(&dev) {
                continue;
            }
            let tag = format!("{target_uid}/{dev}");
            if target == self.user_id && dev == self.device_id.as_str() {
                continue;
            }
            let skey = format!("{session_id}|{tag}");
            if served.get(&skey).map(|t| now.saturating_sub(*t) < SERVE_DEDUP_MS).unwrap_or(false) {
                res.refused.push(format!("{tag}:dedup"));
                continue;
            }
            let Ok(dev_id) = validate_device_id(&dev) else { continue };
            let Some(device) = m.get_device(&target, &dev_id, None).await? else {
                res.refused.push(format!("{tag}:unknown_device"));
                continue;
            };
            if !device.is_cross_signed_by_owner() {
                res.refused.push(format!("{tag}:unsigned"));
                continue;
            }
            let local_idx = entry.and_then(|e| e.devs.get(&tag).copied()).or(uid_min).unwrap_or(0);
            let idx = srv_idx.max(local_idx);
            let key = session.export_at_index(idx).await;
            let content = json!({"v": 1, "req_id": rid, "conv_id": conv_id, "session_id": session_id, "key": serde_json::to_value(&key)?});
            let (reqs, withheld) = m
                .encrypt_content_for_devices(vec![(*device).clone()], EV_ROOM_KEY, &content, CollectStrategy::IdentityBasedStrategy)
                .await?;
            if !withheld.is_empty() || reqs.is_empty() {
                res.refused.push(format!("{tag}:withheld"));
                continue;
            }
            for r in &reqs {
                crate::requests::send_to_device_req(m, self.transport.as_ref(), r, false).await?;
            }
            served.insert(skey, now);
            n += 1;
        }
        Self::kr_set(m, CV_SERVED, &served).await?;
        res.shared_devices = n;
        if n > 0 {
            self.metrics.add_key_req_served(n as u64);
        }
        Ok(res)
    }
}

/// Índice Megolm de um envelope v5 (`ciphertext` = MegolmMessage base64).
pub(crate) fn megolm_index(c: &Value) -> Option<u32> {
    let ct = c.get("ciphertext")?.as_str()?;
    vodozemac::megolm::MegolmMessage::from_base64(ct).ok().map(|m| m.message_index())
}
