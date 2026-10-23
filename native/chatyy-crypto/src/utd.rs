//! [e2ee5 utd-wa 2026-10-23] "Aguardando esta mensagem" nível WhatsApp (BUILD).
//!
//! Dois atalhos que o host usa para que a 1ª mensagem de uma sessão Megolm nunca chegue antes da chave:
//!
//! 1. `prewarm_conversation(conv, membros)` — ao ABRIR a conversa (ou ao saber de aparelho novo de um
//!    membro), faz o mesmo que o `encrypt` faz antes de cifrar: `keys_query` (lista de aparelhos
//!    atualizada) + `keys_claim` (sessões Olm) + `share_room_key` (manda a chave da sessão de saída
//!    atual — ou de uma nova, se a atual girou — para TODOS os aparelhos que ainda não a têm). Assim,
//!    quando o usuário toca em enviar, a chave já está na caixa to-device do destinatário. Idempotente:
//!    aparelho que já tem a chave não recebe nada de novo (a matrix-sdk só gera pedidos para quem falta).
//!    Grava o registro de compartilhamento (`record_share`, regra do pedido de chave) com o índice atual.
//!
//! 2. `backup_fetch_session(conv, session_id)` — sem a chave de uma sessão e com o backup de chaves
//!    LIGADO neste aparelho (chave de decifração do backup no store), busca no servidor só essa sessão
//!    (`backup_keys_get` com `room_id`/`session_id`; servidor antigo devolve tudo e o filtro é aqui),
//!    decifra com a chave do backup e importa. O servidor nunca vê nada em claro.
use crate::core::CryptoCore;
use crate::error::{CoreError, CoreResult};
use crate::ids::room_id_for_conv;
use crate::requests;
use crate::transport::{actions, call_json};
use matrix_sdk_crypto::olm::ExportedRoomKey;
use ruma::{
    api::client::backup::{KeyBackupData, RoomKeyBackup},
    serde::Raw,
    OwnedRoomId,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PrewarmResult {
    /// Pedidos to-device (lotes) que saíram com a chave da sessão; 0 = todos já tinham.
    pub key_share_requests: u32,
    pub key_share_bytes: u64,
    /// Sessão de saída atual da conversa ("" se a matrix-sdk não criou nenhuma).
    pub session_id: String,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct BackupFetchResult {
    pub imported: u32,
    /// "" (ok) · `no_backup` (backup desligado neste aparelho) · `not_found` (sessão não está no backup).
    pub reason: String,
    pub convs: Vec<String>,
}

#[cfg_attr(feature = "uniffi", uniffi::export(async_runtime = "tokio"))]
impl CryptoCore {
    /// Compartilha a chave da sessão de saída da conversa com todos os aparelhos dos membros, sem cifrar nada.
    pub async fn prewarm_conversation(&self, conv_id: String, member_uids: Vec<String>) -> CoreResult<PrewarmResult> {
        let room = room_id_for_conv(&conv_id)?;
        let users = self.users_for(&member_uids)?;
        let op = self.op().await?;
        let m = &op.m;
        self.ensure_sessions(m, &users).await?;
        let reqs = m.share_room_key(&room, crate::core::refs(&users).into_iter(), crate::core::encryption_settings()).await?;
        let mut bytes = 0u64;
        for r in &reqs {
            bytes += requests::send_to_device_req(m, self.transport.as_ref(), r, true).await? as u64;
        }
        let mut sid = String::new();
        if let Some(s) = m.store().get_outbound_group_session(&room).await? {
            sid = s.session_id().to_string();
            Self::remember_sessions(m, &[(conv_id.clone(), sid.clone())]).await?;
            if !reqs.is_empty() {
                let idx = s.message_index().await;
                Self::record_share(m, &conv_id, &sid, idx, &reqs).await?;
            }
        }
        Ok(PrewarmResult { key_share_requests: reqs.len() as u32, key_share_bytes: bytes, session_id: sid })
    }

    /// Busca UMA sessão Megolm no backup de chaves (se ligado neste aparelho) e importa.
    pub async fn backup_fetch_session(&self, conv_id: String, session_id: String) -> CoreResult<BackupFetchResult> {
        let room = room_id_for_conv(&conv_id)?;
        if session_id.is_empty() || session_id.len() > 128 {
            return Err(crate::error::invalid("session_id", "obrigatório (≤128)"));
        }
        let mut res = BackupFetchResult { imported: 0, reason: String::new(), convs: vec![] };
        let (dk, version) = {
            let op = self.op().await?;
            // Já tenho? (chegou por to-device enquanto o host esperava)
            if op.m.store().get_inbound_group_session(&room, &session_id).await?.is_some() {
                res.reason = "have".into();
                return Ok(res);
            }
            let k = op.m.backup_machine().get_backup_keys().await?;
            match (k.decryption_key, k.backup_version) {
                (Some(dk), Some(v)) => (dk, v),
                _ => {
                    res.reason = "no_backup".into();
                    return Ok(res);
                }
            }
        }; // trava solta durante a ida ao servidor
        let d = call_json(
            self.transport.as_ref(),
            actions::BACKUP_KEYS_GET,
            &json!({"version": version, "room_id": room.as_str(), "session_id": session_id}),
        )
        .await?;
        let rooms: BTreeMap<OwnedRoomId, RoomKeyBackup> = serde_json::from_value(d.get("rooms").cloned().unwrap_or(Value::Null))
            .map_err(|_| CoreError::Backup { msg: "rooms inválido".into() })?;
        let mut keys: Vec<ExportedRoomKey> = vec![];
        if let Some(rk) = rooms.get(&room) {
            if let Some(raw) = rk.sessions.get(&session_id) {
                let raw: &Raw<KeyBackupData> = raw;
                if let Ok(kd) = raw.deserialize() {
                    if let Ok(k) = dk.decrypt_session_data(kd.session_data) {
                        keys.push(ExportedRoomKey::from_backed_up_room_key(room.clone(), session_id.clone(), k));
                    }
                }
            }
        }
        if keys.is_empty() {
            res.reason = "not_found".into();
            return Ok(res);
        }
        let r = self.import_keys_vec(keys, Some(&version)).await?;
        res.imported = r.imported;
        res.convs = r.convs;
        Ok(res)
    }
}
