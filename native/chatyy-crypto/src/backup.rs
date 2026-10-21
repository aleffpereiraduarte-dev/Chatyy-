//! Backup de chaves + armazenamento de segredos (CONTRATO §6.8, PLANO §2.8).
//!
//! - As chaves Megolm de entrada vão ao servidor cifradas com a chave PÚBLICA do backup
//!   (`m.megolm_backup.v1.curve25519-aes-sha2`), aos poucos (`backup_step`).
//! - A chave PRIVADA do backup + MSK/SSK/USK ficam no "secret storage" do servidor, cifrados
//!   pela chave de recuperação (48 caracteres base58) — opcionalmente derivada de senha
//!   (Argon2id → PBKDF2 do padrão Matrix por cima).
//! - O servidor nunca vê nada em claro.
use crate::core::CryptoCore;
use crate::error::{CoreError, CoreResult};
use crate::requests::{drain, send_backup};
use crate::transport::{actions, call_json};
use crate::util::{b64, fill_random, unb64};
use matrix_sdk_crypto::{
    backups::MegolmV1BackupKey,
    olm::ExportedRoomKey,
    secret_storage::{AesHmacSha2EncryptedData, SecretStorageKey},
    store::types::{BackupDecryptionKey, CrossSigningKeyExport},
};
use ruma::{
    api::client::backup::{KeyBackupData, RoomKeyBackup},
    events::{secret::request::SecretName, secret_storage::key::SecretStorageKeyEventContent},
    serde::Raw,
    OwnedRoomId,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const S_MASTER: &str = "m.cross_signing.master";
const S_SELF: &str = "m.cross_signing.self_signing";
const S_USER: &str = "m.cross_signing.user_signing";
const S_BACKUP: &str = "m.megolm_backup.v1";
/// Parâmetros Argon2id (OWASP 2023: m=64 MiB, t=3, p=1).
const ARGON_M_KIB: u32 = 64 * 1024;
const ARGON_T: u32 = 3;
const ARGON_P: u32 = 1;

fn berr(m: impl std::fmt::Display) -> CoreError {
    CoreError::Backup { msg: m.to_string() }
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct BackupEnabled {
    /// Chave de recuperação para MOSTRAR ao usuário (grupos de 4). Nunca logar nem persistir.
    pub recovery_key: String,
    pub version: String,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct BackupStatus {
    pub enabled: bool,
    pub version: String,
    pub total_keys: u64,
    pub backed_up_keys: u64,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct RestoreResult {
    pub imported: u32,
    pub total: u32,
    /// MSK/SSK/USK restauradas: este aparelho virou o principal SEM trocar o código de segurança.
    pub identity_restored: bool,
    pub convs: Vec<String>,
}

fn argon2_derive(pass: &str, salt: &[u8]) -> CoreResult<String> {
    let params = argon2::Params::new(ARGON_M_KIB, ARGON_T, ARGON_P, Some(32)).map_err(berr)?;
    let a = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut out = [0u8; 32];
    a.hash_password_into(pass.as_bytes(), salt, &mut out).map_err(berr)?;
    Ok(b64(&out))
}

fn enc_to_json(e: &AesHmacSha2EncryptedData) -> Value {
    json!({"iv": b64(&e.iv), "ciphertext": e.ciphertext.encode(), "mac": b64(&e.mac)})
}
fn enc_from_json(v: &Value) -> CoreResult<AesHmacSha2EncryptedData> {
    let iv: [u8; 16] = unb64(v["iv"].as_str().unwrap_or("")).and_then(|x| x.try_into().ok()).ok_or_else(|| berr("iv"))?;
    let mac: [u8; 32] = unb64(v["mac"].as_str().unwrap_or("")).and_then(|x| x.try_into().ok()).ok_or_else(|| berr("mac"))?;
    let ct = unb64(v["ciphertext"].as_str().unwrap_or("")).ok_or_else(|| berr("ciphertext"))?;
    Ok(AesHmacSha2EncryptedData { iv, ciphertext: ruma::serde::Base64::new(ct), mac })
}

#[cfg_attr(feature = "uniffi", uniffi::export(async_runtime = "tokio"))]
impl CryptoCore {
    /// Liga o backup. `passphrase` vazio = só chave de recuperação aleatória (recomendado).
    /// Exige ser o aparelho principal (tem MSK/SSK/USK privadas).
    pub async fn backup_enable(&self, passphrase: String) -> CoreResult<BackupEnabled> {
        let op = self.op().await?;
        let m = &op.m;
        let cs = m.export_cross_signing_keys().await?.ok_or_else(|| CoreError::Identity { msg: "not_primary".into() })?;
        if cs.master_key.is_none() {
            return Err(CoreError::Identity { msg: "not_primary".into() });
        }
        let dk = BackupDecryptionKey::new();
        let mut info = dk.to_backup_info();
        m.backup_machine().sign_backup(&mut info).await.map_err(berr)?;
        let d = call_json(self.transport.as_ref(), actions::BACKUP_VERSION_CREATE, &serde_json::to_value(&info)?).await?;
        let version = d.get("version").and_then(Value::as_str).ok_or_else(|| berr("server sem version"))?.to_string();
        let pk: MegolmV1BackupKey = dk.megolm_v1_public_key();
        pk.set_version(version.clone());
        m.backup_machine().enable_backup_v1(pk).await?;
        m.backup_machine().save_decryption_key(Some(dk.clone()), Some(version.clone())).await?;

        let (ssk, argon) = if passphrase.is_empty() {
            (SecretStorageKey::new(), Value::Null)
        } else {
            if passphrase.chars().count() < 12 {
                return Err(crate::error::invalid("passphrase", "mínimo 12 caracteres"));
            }
            let mut salt = [0u8; 16];
            fill_random(&mut salt)?;
            let derived = argon2_derive(&passphrase, &salt)?;
            (SecretStorageKey::new_from_passphrase(&derived), json!({"alg": "argon2id", "salt": b64(&salt), "m": ARGON_M_KIB, "t": ARGON_T, "p": ARGON_P}))
        };
        let mut secrets = serde_json::Map::new();
        let mut put = |name: &str, val: Option<String>| {
            if let Some(v) = val {
                secrets.insert(name.to_string(), enc_to_json(&ssk.encrypt(v.into_bytes(), &SecretName::from(name))));
            }
        };
        put(S_MASTER, cs.master_key.clone());
        put(S_SELF, cs.self_signing_key.clone());
        put(S_USER, cs.user_signing_key.clone());
        put(S_BACKUP, Some(dk.to_base64()));
        let body = json!({
            "key_id": ssk.key_id(),
            "key_info": serde_json::to_value(ssk.event_content())?,
            "argon2": argon,
            "secrets": secrets,
        });
        call_json(self.transport.as_ref(), actions::SECRET_STORAGE_PUT, &body).await?;
        drop(op);
        self.backup_step(0).await?;
        Ok(BackupEnabled { recovery_key: ssk.to_base58(), version })
    }

    /// Envia ao servidor as chaves ainda não copiadas. `max_batches` 0 = até acabar.
    /// Devolve quantos lotes foram enviados. Chamar periodicamente (app em 1º plano / Wi-Fi).
    pub async fn backup_step(&self, max_batches: u32) -> CoreResult<u32> {
        let op = self.op().await?;
        let m = &op.m;
        if !m.backup_machine().enabled().await {
            return Ok(0);
        }
        let mut n = 0;
        loop {
            match m.backup_machine().backup().await? {
                Some((id, req)) => {
                    send_backup(m, self.transport.as_ref(), &id, &req).await?;
                    n += 1;
                }
                None => break,
            }
            if max_batches > 0 && n >= max_batches {
                break;
            }
        }
        Ok(n)
    }

    pub async fn backup_status(&self) -> CoreResult<BackupStatus> {
        let op = self.op().await?;
        let bm = op.m.backup_machine();
        let c = bm.room_key_counts().await?;
        Ok(BackupStatus {
            enabled: bm.enabled().await,
            version: bm.backup_version().await.unwrap_or_default(),
            total_keys: c.total as u64,
            backed_up_keys: c.backed_up as u64,
        })
    }

    /// Celular novo: restaura identidade + histórico com a chave de recuperação OU a senha.
    pub async fn backup_restore(&self, recovery_key_or_passphrase: String) -> CoreResult<RestoreResult> {
        let ss = call_json(self.transport.as_ref(), actions::SECRET_STORAGE_GET, &json!({})).await?;
        let key_id = ss.get("key_id").and_then(Value::as_str).ok_or_else(|| berr("sem secret storage"))?.to_string();
        let raw_info = serde_json::value::to_raw_value(&ss.get("key_info").cloned().unwrap_or(Value::Null))?;
        let content = <SecretStorageKeyEventContent as ruma::events::EventContentFromType>::from_parts(
            &format!("m.secret_storage.key.{key_id}"),
            &raw_info,
        )
        .map_err(|_| berr("key_info inválido"))?;
        let input = recovery_key_or_passphrase.trim().to_string();
        let ssk = match SecretStorageKey::from_account_data(&input, content.clone()) {
            Ok(k) => k,
            Err(_) => {
                // Senha com Argon2id por cima.
                let a = ss.get("argon2").cloned().unwrap_or(Value::Null);
                let salt = a.get("salt").and_then(Value::as_str).and_then(unb64).ok_or_else(|| berr("chave de recuperação errada"))?;
                let derived = argon2_derive(&input, &salt)?;
                SecretStorageKey::from_account_data(&derived, content).map_err(|_| berr("chave de recuperação errada"))?
            }
        };
        let secrets = ss.get("secrets").cloned().unwrap_or(Value::Null);
        let get = |name: &str| -> CoreResult<Option<String>> {
            match secrets.get(name) {
                None => Ok(None),
                Some(v) => {
                    let e = enc_from_json(v)?;
                    let p = ssk.decrypt(&e, &SecretName::from(name)).map_err(|_| berr("chave de recuperação errada"))?;
                    Ok(Some(String::from_utf8(p).map_err(berr)?))
                }
            }
        };
        let backup_b64 = get(S_BACKUP)?.ok_or_else(|| berr("sem chave de backup"))?;
        let export = CrossSigningKeyExport { master_key: get(S_MASTER)?, self_signing_key: get(S_SELF)?, user_signing_key: get(S_USER)? };
        let dk = BackupDecryptionKey::from_base64(&backup_b64).map_err(|_| berr("chave de backup inválida"))?;

        let vinfo = call_json(self.transport.as_ref(), actions::BACKUP_VERSION_GET, &json!({})).await?;
        let version = vinfo.get("version").and_then(Value::as_str).ok_or_else(|| berr("sem versão de backup"))?.to_string();
        let info: matrix_sdk_crypto::types::RoomKeyBackupInfo =
            serde_json::from_value(json!({"algorithm": vinfo["algorithm"], "auth_data": vinfo["auth_data"]})).map_err(|_| berr("backup info inválida"))?;
        if !dk.backup_key_matches(&info) {
            return Err(berr("chave do backup não confere com a versão do servidor"));
        }
        let rooms = call_json(self.transport.as_ref(), actions::BACKUP_KEYS_GET, &json!({"version": version})).await?;
        let rooms: BTreeMap<OwnedRoomId, RoomKeyBackup> =
            serde_json::from_value(rooms.get("rooms").cloned().unwrap_or(json!({}))).map_err(|_| berr("rooms inválido"))?;
        let mut keys: Vec<ExportedRoomKey> = vec![];
        for (room, rk) in rooms {
            for (sid, raw) in rk.sessions {
                let raw: Raw<KeyBackupData> = raw;
                if let Ok(kd) = raw.deserialize() {
                    if let Ok(k) = dk.decrypt_session_data(kd.session_data) {
                        keys.push(ExportedRoomKey::from_backed_up_room_key(room.clone(), sid, k));
                    }
                }
            }
        }

        let op = self.op().await?;
        let m = &op.m;
        // Identidade: importar MSK/SSK/USK (confere com o que o servidor publica) e assinar este aparelho.
        m.update_tracked_users([self.user_id.as_ref()]).await?;
        m.mark_all_tracked_users_as_dirty().await?;
        drain(m, self.transport.as_ref()).await?;
        let mut identity_restored = false;
        if export.master_key.is_some() {
            if m.import_cross_signing_keys(export).await.is_ok() {
                identity_restored = m.cross_signing_status().await.has_master;
                if identity_restored {
                    if let Some(d) = m.get_device(&self.user_id, &self.device_id, None).await? {
                        if let Ok(req) = d.verify().await {
                            let tid = ruma::TransactionId::new();
                            crate::requests::send_request(m, self.transport.as_ref(), &tid, &matrix_sdk_crypto::types::requests::AnyOutgoingRequest::SignatureUpload(req)).await?;
                        }
                    }
                }
            }
        }
        let r = self.import_keys_locked(m, keys, Some(&version)).await?;
        // Continua o backup deste aparelho na mesma versão.
        let pk = dk.megolm_v1_public_key();
        pk.set_version(version.clone());
        m.backup_machine().enable_backup_v1(pk).await?;
        m.backup_machine().save_decryption_key(Some(dk), Some(version)).await?;
        Ok(RestoreResult { imported: r.imported, total: r.total, identity_restored, convs: r.convs })
    }

    /// Desliga o backup (apaga a versão no servidor). As chaves locais continuam.
    pub async fn backup_disable(&self) -> CoreResult<()> {
        let op = self.op().await?;
        let v = op.m.backup_machine().backup_version().await.unwrap_or_default();
        op.m.backup_machine().disable_backup().await?;
        if !v.is_empty() {
            call_json(self.transport.as_ref(), actions::BACKUP_VERSION_DELETE, &json!({"version": v})).await?;
        }
        Ok(())
    }
}

impl CryptoCore {

}
