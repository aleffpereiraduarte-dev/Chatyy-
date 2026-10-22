//! `CryptoCore`: a fachada única que app, fila nativa, NSE, extensão e web usam
//! (CONTRATO §6). Todas as operações públicas:
//!   1. serializam dentro do processo (mutex da OlmMachine);
//!   2. pegam a trava ENTRE processos do store (app × NSE × extensão);
//!   3. se outro processo mexeu no store desde a última vez ("dirty"), recarregam a OlmMachine
//!      do disco antes de continuar (padrão Element X).
use crate::envelope::{self, utd, INNER_EVENT_TYPE};
use crate::error::{internal, invalid, CoreError, CoreResult, UtdReason};
use crate::ids::{conv_from_room_id, room_id_for_conv, uid_from_user_id, user_id_for_uid, validate_device_id};
use crate::metrics::{Metrics, MetricsSnapshot};
use crate::requests::{self, drain, send_request};
use crate::transport::{actions, call_json, HttpTransport};
use crate::util::now_ms;
use matrix_sdk_common::cross_process_lock::{CrossProcessLock, CrossProcessLockConfig, CrossProcessLockState};
use matrix_sdk_common::deserialized_responses::{ProcessedToDeviceEvent, VerificationLevel, VerificationState};
use matrix_sdk_crypto::{
    store::{DynCryptoStore, IntoCryptoStore, LockableCryptoStore},
    types::requests::AnyOutgoingRequest,
    CollectStrategy, DecryptionSettings, EncryptionSettings, EncryptionSyncChanges, MegolmError, OlmMachine,
    TrustRequirement,
};
use ruma::{
    api::client::sync::sync_events::DeviceLists,
    events::{room::history_visibility::HistoryVisibility, AnyToDeviceEvent},
    serde::Raw,
    OneTimeKeyAlgorithm, OwnedDeviceId, OwnedUserId, UInt,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

/// Papel do processo que abre o store. Vira o "holder" da trava entre processos.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ProcessRole {
    App,
    /// Notification Service Extension (iOS) / serviço FCM (Android): memória e tempo curtos.
    Push,
    /// Extensão de compartilhar / resposta pela notificação / Siri.
    Extension,
    Web,
}

impl ProcessRole {
    fn holder(&self) -> &'static str {
        match self {
            ProcessRole::App => "app",
            ProcessRole::Push => "push",
            ProcessRole::Extension => "ext",
            ProcessRole::Web => "web",
        }
    }
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct OpenOptions {
    /// Diretório do store (iOS: App Group; Android: noBackupFilesDir; web: nome do banco IndexedDB).
    pub store_dir: String,
    /// 32 B aleatórios em base64, guardados no Keychain/Keystore/WebCrypto (nunca no disco claro).
    pub store_passphrase: String,
    /// uid estável emitido pelo servidor (`e2ee5_status.uid`).
    pub uid: String,
    /// device_id desta instalação (`new_device_id`), persistido pelo host.
    pub device_id: String,
    pub role: ProcessRole,
    /// Sufixo opcional do holder (ex.: id do processo) para depuração. Pode ser vazio.
    pub holder_suffix: String,
}

/// Nível de confiança do remetente de uma mensagem decifrada (CONTRATO §6.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
#[serde(rename_all = "snake_case")]
pub enum Trust {
    /// Aparelho assinado pelo dono E o dono foi verificado por mim (QR/60 dígitos).
    Verified,
    /// Aparelho assinado pelo dono; identidade do dono fixada no 1º contato (TOFU). Normal.
    Tofu,
    /// A identidade do dono mudou desde que foi fixada/verificada (mostrar aviso).
    Changed,
    /// [1.7] Mensagem (histórico de backup/vínculo) enviada de um aparelho do dono que JÁ FOI
    /// assinado por ele e hoje está desconectado: "enviada de um aparelho que não está mais conectado".
    DeviceRemoved,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct DecryptInput {
    pub conv_id: String,
    /// `chat_messages.content` (`{"e2e":5,"c":{…}}`).
    pub envelope_json: String,
    /// uid do remetente segundo o servidor (metadado em claro).
    pub sender_uid: String,
    /// id da mensagem no servidor (`chat_messages.id`), vira o event_id `$m<id>`.
    pub server_mid: String,
    /// `client_message_id` em claro; tem de bater com `payload.cmid`. Vazio = não confere.
    pub cmid: String,
    pub ts_ms: u64,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct Decrypted {
    pub payload_json: String,
    pub sender_uid: String,
    pub sender_device_id: String,
    pub trust: Trust,
    pub session_id: String,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct EncryptResult {
    pub envelope_json: String,
    pub session_id: String,
    /// Pedidos to-device enviados para compartilhar a chave (0 = sessão já compartilhada).
    pub key_share_requests: u32,
    pub key_share_bytes: u64,
}

/// Evento to-device `chatyy.*` decifrado e de aparelho ASSINADO pelo dono.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ChatyyEvent {
    pub event_type: String,
    pub sender_uid: String,
    pub sender_device_id: String,
    pub content_json: String,
}

#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SyncResult {
    pub to_device_processed: u32,
    pub to_device_utd: u32,
    /// Conversas que receberam chave nova: o host re-tenta decifrar as mensagens "aguardando".
    pub convs_with_new_keys: Vec<String>,
    pub chatyy_events: Vec<ChatyyEvent>,
    /// Contatos cuja identidade (MSK) mudou desde a fixação: host grava a mensagem de sistema
    /// "o código de segurança de X mudou" e chama `pin_identity`.
    pub identity_changed_uids: Vec<String>,
    /// O servidor tem mais to-device pendentes: chamar `sync()` de novo.
    pub more: bool,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct DeviceTarget {
    pub uid: String,
    /// Vazio = todos os aparelhos ASSINADOS do usuário.
    pub device_id: String,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SendToDeviceResult {
    pub sent_devices: u32,
    /// Aparelhos que NÃO receberam (não assinados, sem sessão Olm…), "uid/device".
    pub withheld: Vec<String>,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct DeviceSummary {
    pub uid: String,
    pub device_id: String,
    pub ed25519: String,
    pub curve25519: String,
    pub signed_by_owner: bool,
    pub is_this_device: bool,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct IdentityStatus {
    pub uid: String,
    pub has_identity: bool,
    /// MSK pública (ed25519, base64) — base do número de segurança.
    pub master_key: String,
    /// Eu verifiquei este contato (QR/60 dígitos). Para mim mesmo: este aparelho confia na MSK.
    pub verified: bool,
    /// A MSK mudou desde a fixação e ainda não foi aceita (`pin_identity`).
    pub needs_approval: bool,
    /// Só para o próprio usuário: este aparelho tem as chaves privadas MSK/SSK/USK (principal).
    pub is_primary: bool,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ExportFilter {
    /// Vazio = todas as conversas.
    pub conv_ids: Vec<String>,
    /// 0 = sem limite. Senão, só sessões vistas por este aparelho a partir deste instante (D5 "3 meses").
    pub since_ms: u64,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ImportResult {
    pub imported: u32,
    pub total: u32,
    pub convs: Vec<String>,
}

const LOCK_KEY: &str = "chatyy_crypto_v1";
const CV_TD_SINCE: &str = "chatyy.td_since";
const CV_DC_SINCE: &str = "chatyy.dc_since";
const CV_SEEN: &str = "chatyy.session_seen";
const CV_CONVS: &str = "chatyy.convs";
/// Fila persistida (CONTRATO §6.4): o que um processo NÃO-App (NSE/extensão) consumiu do
/// to-device — eventos `chatyy.*` e conversas com chave nova — fica guardado no store e é
/// entregue no próximo `sync()` do papel App/Web (o cursor do servidor já avançou).
const CV_PENDING: &str = "chatyy.pending_for_app";
/// [1.7] cache dos aparelhos já desconectados (assinatura do dono conferida) por usuário.
const CV_FORMER: &str = "chatyy.former_devices";
const FORMER_TTL_MS: u64 = 10 * 60 * 1000;

/// [1.7] Quem mandou a sessão importada.
enum SenderCheck {
    Current(OwnedDeviceId),
    Former(OwnedDeviceId),
    /// `definitive` = o servidor respondeu e nada confere (UTD não retentável).
    Unknown { definitive: bool },
}
const PENDING_MAX_EVENTS: usize = 1000;
const PENDING_MAX_AGE_MS: u64 = 7 * 24 * 3600 * 1000;

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct PendingForApp {
    events: Vec<(u64, ChatyyEvent)>,
    convs: BTreeSet<String>,
}
pub(crate) const ROTATION_MSGS: u64 = 100;
pub(crate) const ROTATION_PERIOD: Duration = Duration::from_secs(7 * 24 * 3600);

pub(crate) fn encryption_settings() -> EncryptionSettings {
    EncryptionSettings {
        sharing_strategy: CollectStrategy::IdentityBasedStrategy,
        rotation_period: ROTATION_PERIOD,
        rotation_period_msgs: ROTATION_MSGS,
        history_visibility: HistoryVisibility::Shared,
        ..Default::default()
    }
}

/// `Vec<&UserId>` (iterador sem closure: mantém os futures `Send` para o UniFFI).
pub(crate) fn refs(v: &[OwnedUserId]) -> Vec<&ruma::UserId> {
    v.iter().map(|u| &**u).collect()
}

pub(crate) fn decryption_settings() -> DecryptionSettings {
    // Só aceitamos mensagens de aparelhos ASSINADOS pelo dono (aparelho injetado → UTD).
    DecryptionSettings { sender_device_trust_requirement: TrustRequirement::CrossSigned }
}

#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct CryptoCore {
    pub(crate) transport: Arc<dyn HttpTransport>,
    pub(crate) user_id: OwnedUserId,
    pub(crate) device_id: OwnedDeviceId,
    pub(crate) machine: Mutex<OlmMachine>,
    store: Arc<DynCryptoStore>,
    lock: CrossProcessLock<LockableCryptoStore>,
    pub(crate) metrics: Metrics,
    pub(crate) uid: String,
    role: ProcessRole,
}

/// Guarda de operação: segura a OlmMachine e a trava entre processos.
pub(crate) struct Op<'a> {
    pub m: tokio::sync::MutexGuard<'a, OlmMachine>,
    _guard: matrix_sdk_common::cross_process_lock::CrossProcessLockGuard,
}

async fn open_store(opts: &OpenOptions) -> CoreResult<Arc<DynCryptoStore>> {
    #[cfg(all(feature = "sqlite", not(target_family = "wasm")))]
    {
        std::fs::create_dir_all(&opts.store_dir).map_err(crate::error::store_err)?;
        let s = matrix_sdk_sqlite::SqliteCryptoStore::open(&opts.store_dir, Some(&opts.store_passphrase))
            .await
            .map_err(crate::error::store_err)?;
        return Ok(s.into_crypto_store());
    }
    #[cfg(all(feature = "js", target_family = "wasm"))]
    {
        let s = matrix_sdk_indexeddb::IndexeddbCryptoStore::open_with_passphrase(&opts.store_dir, &opts.store_passphrase)
            .await
            .map_err(crate::error::store_err)?;
        return Ok(s.into_crypto_store());
    }
    #[allow(unreachable_code)]
    {
        let _ = opts;
        Ok(matrix_sdk_crypto::store::MemoryStore::new().into_crypto_store())
    }
}

#[cfg_attr(feature = "uniffi", uniffi::export(async_runtime = "tokio"))]
impl CryptoCore {
    /// Abre (ou cria) o store e a conta deste aparelho. NÃO faz rede (serve à NSE offline).
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub async fn open(opts: OpenOptions, transport: Arc<dyn HttpTransport>) -> CoreResult<Arc<CryptoCore>> {
        let user_id = user_id_for_uid(&opts.uid)?;
        let device_id = validate_device_id(&opts.device_id)?;
        if opts.store_passphrase.len() < 16 {
            return Err(invalid("store_passphrase", "mínimo 16 caracteres (use 32 B aleatórios em base64)"));
        }
        let store = open_store(&opts).await?;
        let machine = OlmMachine::with_store(&user_id, &device_id, store.clone(), None).await.map_err(|e| match e {
            matrix_sdk_crypto::CryptoStoreError::MismatchedAccount { .. } => {
                invalid("device_id", "store pertence a outro uid/device (reinstalação = store novo)")
            }
            other => crate::error::store_err(other),
        })?;
        let holder = if opts.holder_suffix.is_empty() {
            opts.role.holder().to_string()
        } else {
            format!("{}-{}", opts.role.holder(), opts.holder_suffix)
        };
        let lock = machine.store().create_store_lock(LOCK_KEY.to_string(), CrossProcessLockConfig::multi_process(holder));
        Ok(Arc::new(CryptoCore {
            transport,
            uid: opts.uid.clone(),
            role: opts.role,
            user_id,
            device_id,
            machine: Mutex::new(machine),
            store,
            lock,
            metrics: Metrics::default(),
        }))
    }

    pub fn uid(&self) -> String {
        self.uid.clone()
    }
    pub fn device_id(&self) -> String {
        self.device_id.to_string()
    }

    /// Chaves públicas deste aparelho (o vínculo QR e a tela de aparelhos usam).
    pub async fn this_device(&self) -> CoreResult<DeviceSummary> {
        let op = self.op().await?;
        let k = op.m.identity_keys();
        Ok(DeviceSummary {
            uid: self.uid.clone(),
            device_id: self.device_id.to_string(),
            ed25519: k.ed25519.to_base64(),
            curve25519: k.curve25519.to_base64(),
            signed_by_owner: op
                .m
                .get_device(&self.user_id, &self.device_id, None)
                .await?
                .map(|d| d.is_cross_signed_by_owner())
                .unwrap_or(false),
            is_this_device: true,
        })
    }

    /// Começa a acompanhar a lista de aparelhos destes usuários (membros das conversas E2EE).
    pub async fn track_users(&self, uids: Vec<String>) -> CoreResult<()> {
        let users = self.users_for(&uids)?;
        let op = self.op().await?;
        op.m.update_tracked_users(refs(&users).into_iter()).await?;
        drain(&op.m, self.transport.as_ref()).await?;
        Ok(())
    }

    /// Uma rodada de `e2ee5_sync`: to-device + mudanças de aparelhos + contagem de OTK,
    /// processa tudo e esvazia os pedidos pendentes (upload de chaves etc.).
    pub async fn sync(&self) -> CoreResult<SyncResult> {
        let op = self.op().await?;
        let m = &op.m;
        drain(m, self.transport.as_ref()).await?;
        let td_since = Self::cv_get(m, CV_TD_SINCE).await?.unwrap_or_default();
        let dc_since = Self::cv_get(m, CV_DC_SINCE).await?.unwrap_or_default();
        let d = call_json(self.transport.as_ref(), actions::SYNC, &json!({"td_since": td_since, "dc_since": dc_since, "limit": 100})).await?;
        let mut res = self.process_sync(m, &d).await?;
        if let Some(n) = d.get("td_next").and_then(Value::as_str) {
            Self::cv_set(m, CV_TD_SINCE, n).await?;
        }
        if let Some(n) = d.get("dc_next").and_then(Value::as_str) {
            Self::cv_set(m, CV_DC_SINCE, n).await?;
        }
        drain(m, self.transport.as_ref()).await?;
        res.identity_changed_uids = self.identity_changes(m, &res.identity_changed_uids).await?;
        self.hand_over(m, &mut res).await?;
        Ok(res)
    }

    /// Variante em que o HOST já tem o corpo de `e2ee5_sync` (ex.: veio no push/WS).
    /// Não avança cursores (o próximo `sync()` repete com segurança: Olm descarta duplicatas).
    pub async fn sync_with(&self, sync_data_json: String) -> CoreResult<SyncResult> {
        let d: Value = serde_json::from_str(&sync_data_json)?;
        let op = self.op().await?;
        let mut r = self.process_sync(&op.m, &d).await?;
        drain(&op.m, self.transport.as_ref()).await?;
        r.identity_changed_uids = self.identity_changes(&op.m, &r.identity_changed_uids).await?;
        self.hand_over(&op.m, &mut r).await?;
        Ok(r)
    }

    /// Cifra o payload interno v1 para a conversa. `member_uids` = membros ATUAIS (o servidor é a
    /// fonte; o próprio usuário entra sempre para os meus outros aparelhos).
    pub async fn encrypt(&self, conv_id: String, member_uids: Vec<String>, payload_json: String) -> CoreResult<EncryptResult> {
        let payload = envelope::validate_outgoing(&conv_id, &payload_json)?;
        let room = room_id_for_conv(&conv_id)?;
        let users = self.users_for(&member_uids)?;
        let op = self.op().await?;
        let m = &op.m;
        self.ensure_sessions(m, &users).await?;
        let reqs = m.share_room_key(&room, refs(&users).into_iter(), encryption_settings()).await?;
        let mut bytes = 0u64;
        for r in &reqs {
            bytes += requests::send_to_device_req(m, self.transport.as_ref(), r, true).await? as u64;
        }
        let raw = Raw::from_json(serde_json::value::to_raw_value(&payload)?);
        let enc = m.encrypt_room_event_raw(&room, INNER_EVENT_TYPE, &raw).await.map_err(|e| internal(e))?;
        let c: Value = serde_json::from_str(enc.content.json().get())?;
        let sid = c.get("session_id").and_then(Value::as_str).unwrap_or("").to_string();
        Self::remember_sessions(m, &[(conv_id.clone(), sid.clone())]).await?;
        if !reqs.is_empty() {
            // [1.7] com quem esta sessão saiu e a partir de qual índice (regra do pedido de chave)
            if let Some(idx) = crate::keyreq::megolm_index(&c) {
                Self::record_share(m, &conv_id, &sid, idx, &reqs).await?;
            }
        }
        let envelope_json = envelope::wrap(c);
        self.metrics.inc_encrypt();
        Ok(EncryptResult { envelope_json, session_id: sid, key_share_requests: reqs.len() as u32, key_share_bytes: bytes })
    }

    /// Decifra um envelope v5. Erro `Utd{reason}` quando não dá (ver `UtdReason::retryable`).
    pub async fn decrypt(&self, input: DecryptInput) -> CoreResult<Decrypted> {
        let c = envelope::unwrap(&input.envelope_json)?;
        let sid = c.get("session_id").and_then(Value::as_str).unwrap_or("").to_string();
        let room = room_id_for_conv(&input.conv_id)?;
        let sender = user_id_for_uid(&input.sender_uid)?;
        let ev = envelope::as_room_event(c, sender.as_str(), room.as_str(), &input.server_mid, input.ts_ms);
        let raw = Raw::from_json(serde_json::value::to_raw_value(&ev)?);
        let op = self.op().await?;
        let mut r = op.m.decrypt_room_event(&raw, &room, &decryption_settings()).await;
        if matches!(r, Err(MegolmError::SenderIdentityNotTrusted(_))) {
            // Ainda não conhecíamos os aparelhos/assinaturas do remetente: consulta e tenta de novo.
            op.m.update_tracked_users([sender.as_ref()]).await?;
            op.m.mark_all_tracked_users_as_dirty().await?;
            drain(&op.m, self.transport.as_ref()).await?;
            r = op.m.decrypt_room_event(&raw, &room, &decryption_settings()).await;
        }
        let mut former = false;
        let mut unverified = false;
        if matches!(r, Err(MegolmError::SenderIdentityNotTrusted(_))) {
            // Sessões IMPORTADAS (vínculo, backup, export) não trazem a prova Olm do remetente.
            // Aceitamos só se as chaves da sessão (curve25519 + ed25519 declarada) são de um
            // aparelho do remetente ASSINADO pelo dono — mesma garantia, verificada aqui. [1.7]
            // Vale também aparelho JÁ desconectado, desde que a assinatura do dono (SSK atual)
            // sobre as chaves dele confira (histórico não some quando o aparelho sai).
            let loose = DecryptionSettings { sender_device_trust_requirement: TrustRequirement::Untrusted };
            if let Ok(mut d) = op.m.decrypt_room_event(&raw, &room, &loose).await {
                let chk = self.imported_session_sender(&op.m, &sender, &d.encryption_info).await?;
                let dev = match chk {
                    SenderCheck::Current(dev) => Some(dev),
                    SenderCheck::Former(dev) => {
                        former = true;
                        Some(dev)
                    }
                    SenderCheck::Unknown { definitive } => {
                        unverified = definitive;
                        None
                    }
                };
                if let Some(dev) = dev {
                    // sessão importada não traz o aparelho: preenche com o aparelho conferido
                    if d.encryption_info.sender_device.is_none() {
                        let mut info = (*d.encryption_info).clone();
                        info.sender_device = Some(dev);
                        d.encryption_info = Arc::new(info);
                    }
                    r = Ok(d);
                }
            }
        }
        let d = match r {
            Ok(d) => d,
            Err(e) => {
                // [1.7] chave existe mas o aparelho remetente não confere de jeito nenhum: definitivo
                let reason = if unverified { UtdReason::UnverifiedSender } else { map_megolm_err(&e) };
                self.metrics.inc_utd(reason);
                return Err(utd(reason, &sid));
            }
        };
        let ev: Value = serde_json::from_str(d.event.json().get()).map_err(|_| utd(UtdReason::BadEnvelope, &sid))?;
        if ev.get("type").and_then(Value::as_str) != Some(INNER_EVENT_TYPE) {
            self.metrics.inc_utd(UtdReason::BadEnvelope);
            return Err(utd(UtdReason::BadEnvelope, &sid));
        }
        let payload = ev.get("content").cloned().unwrap_or(Value::Null);
        let cmid = (!input.cmid.is_empty()).then_some(input.cmid.as_str());
        if let Err(e) = envelope::validate_incoming(&input.conv_id, cmid, &payload, &sid) {
            self.metrics.inc_utd(UtdReason::ContextMismatch);
            return Err(e);
        }
        let info = &d.encryption_info;
        let trust = match &info.verification_state {
            VerificationState::Verified => Trust::Verified,
            VerificationState::Unverified(VerificationLevel::VerificationViolation) => Trust::Changed,
            _ => {
                // Identidade fixada mudou (TOFU) mas ainda não aceita?
                let changed = match op.m.get_identity(&sender, None).await? {
                    Some(id) => id.other().map(|o| o.identity_needs_user_approval()).unwrap_or(false),
                    None => false,
                };
                if changed { Trust::Changed } else { Trust::Tofu }
            }
        };
        let trust = if former && trust != Trust::Changed { Trust::DeviceRemoved } else { trust };
        self.metrics.inc_decrypt();
        Ok(Decrypted {
            payload_json: payload.to_string(),
            sender_uid: input.sender_uid,
            sender_device_id: info.sender_device.as_ref().map(|d| d.to_string()).unwrap_or_default(),
            trust,
            session_id: sid,
        })
    }

    /// to-device cifrado Olm com evento `chatyy.*` (chave de ligação, SDP, relatório de UTD…).
    /// Só chega a aparelhos ASSINADOS pelo dono. Nunca vai ao aparelho atual.
    pub async fn send_to_device(&self, event_type: String, targets: Vec<DeviceTarget>, content_json: String) -> CoreResult<SendToDeviceResult> {
        if !event_type.starts_with("chatyy.") || event_type.len() > 64 {
            return Err(invalid("event_type", "deve começar com chatyy. (≤64)"));
        }
        if event_type == crate::keyreq::EV_ROOM_KEY {
            // [1.7] chave de sala só sai pelo `share_room_key` (regras de membro/índice).
            return Err(invalid("event_type", "reservado ao share_room_key"));
        }
        if content_json.len() > 32 * 1024 {
            return Err(invalid("content_json", "máx 32 KiB"));
        }
        let content: Value = serde_json::from_str(&content_json)?;
        let op = self.op().await?;
        self.send_to_device_locked(&op.m, &event_type, &targets, &content).await
    }

    /// Força rotação da sessão Megolm de saída (ex.: alguém saiu, aparelho revogado).
    pub async fn rotate_conversation(&self, conv_id: String) -> CoreResult<bool> {
        let room = room_id_for_conv(&conv_id)?;
        let op = self.op().await?;
        Ok(op.m.discard_room_key(&room).await?)
    }

    /// Mudança de membros: acompanha os atuais; se alguém SAIU, rotaciona já (quem sai não lê a
    /// próxima). Entradas não precisam rotacionar (quem entra não recebe o passado: a sessão
    /// é compartilhada a partir do índice atual).
    pub async fn on_members_changed(&self, conv_id: String, member_uids: Vec<String>, removed_uids: Vec<String>) -> CoreResult<()> {
        let room = room_id_for_conv(&conv_id)?;
        let users = self.users_for(&member_uids)?;
        let op = self.op().await?;
        op.m.update_tracked_users(refs(&users).into_iter()).await?;
        if !removed_uids.is_empty() {
            op.m.discard_room_key(&room).await?;
        }
        drain(&op.m, self.transport.as_ref()).await?;
        Ok(())
    }

    /// Revoga um aparelho MEU (vinculado). Servidor apaga; rotaciono todas as conversas.
    pub async fn forget_device(&self, device_id: String) -> CoreResult<u32> {
        validate_device_id(&device_id)?;
        if device_id == self.device_id.as_str() {
            return Err(invalid("device_id", "não dá para revogar o próprio aparelho por aqui"));
        }
        let op = self.op().await?;
        call_json(self.transport.as_ref(), actions::DEVICE_DELETE, &json!({"device_id": device_id})).await?;
        let convs = Self::known_convs(&op.m).await?;
        let mut n = 0;
        for c in convs {
            if let Ok(r) = room_id_for_conv(&c) {
                if op.m.discard_room_key(&r).await? {
                    n += 1;
                }
            }
        }
        op.m.mark_all_tracked_users_as_dirty().await?;
        drain(&op.m, self.transport.as_ref()).await?;
        Ok(n)
    }

    pub async fn list_devices(&self, uid: String) -> CoreResult<Vec<DeviceSummary>> {
        let u = user_id_for_uid(&uid)?;
        let op = self.op().await?;
        let ds = op.m.get_user_devices(&u, None).await?;
        Ok(ds
            .devices()
            .map(|d| DeviceSummary {
                uid: uid.clone(),
                device_id: d.device_id().to_string(),
                ed25519: d.ed25519_key().map(|k| k.to_base64()).unwrap_or_default(),
                curve25519: d.curve25519_key().map(|k| k.to_base64()).unwrap_or_default(),
                signed_by_owner: d.is_cross_signed_by_owner(),
                is_this_device: u == self.user_id && d.device_id() == &*self.device_id,
            })
            .collect())
    }

    /// Exporta chaves Megolm de entrada (JSON `ExportedRoomKey[]`) — vínculo web e celular novo.
    /// O blob é SEGREDO: só sai por canal cifrado (ECIES do vínculo) ou cifrado por senha.
    pub async fn export_room_keys(&self, filter: ExportFilter) -> CoreResult<Vec<u8>> {
        let op = self.op().await?;
        let seen = Self::session_seen(&op.m).await?;
        let convs: BTreeSet<String> = filter.conv_ids.iter().cloned().collect();
        let keys = op
            .m
            .store()
            .export_room_keys(|s| {
                let conv = conv_from_room_id(s.room_id().as_str()).unwrap_or_default();
                let conv_ok = convs.is_empty() || convs.contains(&conv);
                let time_ok = filter.since_ms == 0 || seen.get(s.session_id()).map(|t| *t >= filter.since_ms).unwrap_or(true);
                !conv.is_empty() && conv_ok && time_ok
            })
            .await?;
        Ok(serde_json::to_vec(&keys)?)
    }

    pub async fn import_room_keys(&self, blob: Vec<u8>) -> CoreResult<ImportResult> {
        let keys: Vec<matrix_sdk_crypto::olm::ExportedRoomKey> =
            serde_json::from_slice(&blob).map_err(|_| invalid("blob", "export inválido"))?;
        self.import_keys_vec(keys, None).await
    }

    /// Export cifrado por senha (formato padrão de export de chaves Matrix, PBKDF2) para
    /// "salvar arquivo de chaves" manual. Não é usado no vínculo nem no backup.
    pub async fn export_room_keys_with_passphrase(&self, passphrase: String) -> CoreResult<String> {
        if passphrase.chars().count() < 12 {
            return Err(invalid("passphrase", "mínimo 12 caracteres"));
        }
        let op = self.op().await?;
        let keys = op.m.store().export_room_keys(|_| true).await?;
        matrix_sdk_crypto::encrypt_room_key_export(&keys, &passphrase, 200_000).map_err(internal)
    }

    pub async fn import_room_keys_with_passphrase(&self, data: String, passphrase: String) -> CoreResult<ImportResult> {
        let keys = matrix_sdk_crypto::decrypt_room_key_export(std::io::Cursor::new(data), &passphrase)
            .map_err(|_| CoreError::Backup { msg: "senha errada ou arquivo inválido".into() })?;
        self.import_keys_vec(keys, None).await
    }

    pub fn metrics_snapshot(&self) -> MetricsSnapshot {
        self.metrics.snapshot()
    }

    /// Envia a métrica agregada ao servidor (`e2ee5_metrics`). Só contagens.
    pub async fn flush_metrics(&self) -> CoreResult<()> {
        let s = self.metrics.take_snapshot();
        call_json(self.transport.as_ref(), actions::METRICS, &serde_json::to_value(&s)?).await?;
        Ok(())
    }
}

impl CryptoCore {

    /// Corpo do `send_to_device` com a OlmMachine já travada (também usado pelo pedido de chave).
    pub(crate) async fn send_to_device_locked(&self, m: &OlmMachine, event_type: &str, targets: &[DeviceTarget], content: &Value) -> CoreResult<SendToDeviceResult> {
        let uids: Vec<String> = targets.iter().map(|t| t.uid.clone()).collect();
        let users = self.users_for(&uids)?;
        self.ensure_sessions(m, &users).await?;
        let mut devices = vec![];
        for t in targets {
            let u = user_id_for_uid(&t.uid)?;
            let ds = m.get_user_devices(&u, None).await?;
            for d in ds.devices() {
                if u == self.user_id && d.device_id() == &*self.device_id {
                    continue;
                }
                if !t.device_id.is_empty() && d.device_id().as_str() != t.device_id {
                    continue;
                }
                devices.push((*d).clone());
            }
        }
        let n = devices.len();
        let (reqs, withheld) = m
            .encrypt_content_for_devices(devices, event_type, content, CollectStrategy::IdentityBasedStrategy)
            .await?;
        for r in &reqs {
            requests::send_to_device_req(m, self.transport.as_ref(), r, false).await?;
        }
        let withheld: Vec<String> = withheld
            .iter()
            .map(|(d, _)| format!("{}/{}", uid_from_user_id(d.user_id().as_str()).unwrap_or_default(), d.device_id()))
            .collect();
        Ok(SendToDeviceResult { sent_devices: (n - withheld.len().min(n)) as u32, withheld })
    }

    pub(crate) async fn op(&self) -> CoreResult<Op<'_>> {
        let mut m = self.machine.lock().await;
        let state = match self.lock.spin_lock(Some(2_000)).await {
            Ok(Ok(s)) => s,
            Ok(Err(_)) => return Err(CoreError::LockBusy),
            Err(e) => return Err(crate::error::store_err(e)),
        };
        let guard = match state {
            CrossProcessLockState::Clean(g) => g,
            CrossProcessLockState::Dirty(g) => {
                // Outro processo (NSE/extensão) escreveu: caches da OlmMachine estão velhos.
                *m = OlmMachine::with_store(&self.user_id, &self.device_id, self.store.clone(), None)
                    .await
                    .map_err(crate::error::store_err)?;
                self.lock.clear_dirty();
                self.metrics.inc_reload();
                g
            }
        };
        Ok(Op { m, _guard: guard })
    }

    async fn cv_get(m: &OlmMachine, k: &str) -> CoreResult<Option<String>> {
        Ok(m.store().get_custom_value(k).await?.map(|v| String::from_utf8_lossy(&v).to_string()))
    }
    async fn cv_set(m: &OlmMachine, k: &str, v: &str) -> CoreResult<()> {
        m.store().set_custom_value(k, v.as_bytes().to_vec()).await?;
        Ok(())
    }

    pub(crate) async fn remember_sessions(m: &OlmMachine, items: &[(String, String)]) -> CoreResult<()> {
        if items.is_empty() {
            return Ok(());
        }
        let mut seen: BTreeMap<String, u64> =
            Self::cv_get(m, CV_SEEN).await?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let mut convs: BTreeSet<String> =
            Self::cv_get(m, CV_CONVS).await?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let now = now_ms();
        for (conv, sid) in items {
            seen.entry(sid.clone()).or_insert(now);
            convs.insert(conv.clone());
        }
        Self::cv_set(m, CV_SEEN, &serde_json::to_string(&seen)?).await?;
        Self::cv_set(m, CV_CONVS, &serde_json::to_string(&convs)?).await?;
        Ok(())
    }
    pub(crate) async fn known_convs(m: &OlmMachine) -> CoreResult<BTreeSet<String>> {
        Ok(Self::cv_get(m, CV_CONVS).await?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
    }
    pub(crate) async fn session_seen(m: &OlmMachine) -> CoreResult<BTreeMap<String, u64>> {
        Ok(Self::cv_get(m, CV_SEEN).await?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
    }

    fn users_for(&self, uids: &[String]) -> CoreResult<Vec<OwnedUserId>> {
        let mut set: BTreeSet<OwnedUserId> = BTreeSet::new();
        set.insert(self.user_id.clone());
        for u in uids {
            set.insert(user_id_for_uid(u)?);
        }
        Ok(set.into_iter().collect())
    }

    /// Papel Push/Extension: guarda o que consumiu para o app. Papel App/Web: entrega o que
    /// outro processo consumiu (uma vez só) junto com o resultado deste sync.
    async fn hand_over(&self, m: &OlmMachine, res: &mut SyncResult) -> CoreResult<()> {
        let mut p: PendingForApp = Self::cv_get(m, CV_PENDING).await?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let had = !p.events.is_empty() || !p.convs.is_empty();
        match self.role {
            ProcessRole::Push | ProcessRole::Extension => {
                if res.chatyy_events.is_empty() && res.convs_with_new_keys.is_empty() {
                    return Ok(());
                }
                let now = now_ms();
                p.events.extend(res.chatyy_events.iter().cloned().map(|e| (now, e)));
                p.events.retain(|(t, _)| now.saturating_sub(*t) <= PENDING_MAX_AGE_MS);
                if p.events.len() > PENDING_MAX_EVENTS {
                    let cut = p.events.len() - PENDING_MAX_EVENTS;
                    p.events.drain(..cut);
                }
                p.convs.extend(res.convs_with_new_keys.iter().cloned());
                Self::cv_set(m, CV_PENDING, &serde_json::to_string(&p)?).await?;
            }
            ProcessRole::App | ProcessRole::Web => {
                if !had {
                    return Ok(());
                }
                let mut evs: Vec<ChatyyEvent> = p.events.into_iter().map(|(_, e)| e).collect();
                evs.append(&mut res.chatyy_events);
                res.chatyy_events = evs;
                let mut convs: BTreeSet<String> = p.convs;
                convs.extend(res.convs_with_new_keys.drain(..));
                res.convs_with_new_keys = convs.into_iter().collect();
                Self::cv_set(m, CV_PENDING, "{}").await?;
            }
        }
        Ok(())
    }

    /// Depois do keys_query: dos usuários com mudança, quais tiveram a MSK trocada.
    async fn identity_changes(&self, m: &OlmMachine, candidates: &[String]) -> CoreResult<Vec<String>> {
        let mut out = vec![];
        for uid in candidates {
            let Ok(u) = user_id_for_uid(uid) else { continue };
            if u == self.user_id {
                continue;
            }
            if let Some(id) = m.get_identity(&u, None).await? {
                if let Some(o) = id.other() {
                    if o.identity_needs_user_approval() || o.has_verification_violation() {
                        out.push(uid.clone());
                    }
                }
            }
        }
        Ok(out)
    }

    async fn process_sync(&self, m: &OlmMachine, d: &Value) -> CoreResult<SyncResult> {
        let evs: Vec<Raw<AnyToDeviceEvent>> = d
            .get("to_device")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| serde_json::value::to_raw_value(v).ok().map(Raw::from_json)).collect())
            .unwrap_or_default();
        let n_events = evs.len() as u32;
        let mut dl = DeviceLists::new();
        let to_users = |k: &str| -> Vec<OwnedUserId> {
            d.get("device_lists")
                .and_then(|x| x.get(k))
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|u| u.as_str()).filter_map(|u| OwnedUserId::try_from(u).ok()).collect())
                .unwrap_or_default()
        };
        dl.changed = to_users("changed");
        dl.left = to_users("left");
        let changed_users = dl.changed.clone();
        let otk = d
            .get("one_time_key_counts")
            .and_then(|x| x.get("signed_curve25519"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let counts = BTreeMap::from([(OneTimeKeyAlgorithm::SignedCurve25519, UInt::new(otk).unwrap_or_default())]);
        let fb: Vec<OneTimeKeyAlgorithm> = d
            .get("unused_fallback_key_types")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str()).map(OneTimeKeyAlgorithm::from).collect())
            .unwrap_or_default();
        let (processed, keys) = m
            .receive_sync_changes(
                EncryptionSyncChanges {
                    to_device_events: evs,
                    changed_devices: &dl,
                    one_time_keys_counts: &counts,
                    unused_fallback_keys: Some(&fb),
                    next_batch_token: None,
                },
                &decryption_settings(),
            )
            .await?;
        let mut new_key_convs: BTreeSet<String> = BTreeSet::new();
        let mut out = SyncResult { to_device_processed: n_events, more: d.get("more").and_then(Value::as_bool).unwrap_or(false), ..Default::default() };
        for p in processed {
            match p {
                ProcessedToDeviceEvent::Decrypted { raw, encryption_info } => {
                    let v: Value = match serde_json::from_str(raw.json().get()) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let t = v.get("type").and_then(Value::as_str).unwrap_or("");
                    if !t.starts_with("chatyy.") {
                        continue;
                    }
                    let trusted = matches!(
                        encryption_info.verification_state,
                        VerificationState::Verified | VerificationState::Unverified(VerificationLevel::UnverifiedIdentity)
                    );
                    if !trusted {
                        self.metrics.inc_dropped_untrusted();
                        continue;
                    }
                    if t == crate::keyreq::EV_ROOM_KEY {
                        // [1.7] chave de sala pedida: fica DENTRO do núcleo (nunca vai ao host).
                        let content = v.get("content").cloned().unwrap_or(Value::Null);
                        if let Some(c) = self.receive_room_key_share(m, &content, &encryption_info).await? {
                            new_key_convs.insert(c);
                        }
                        continue;
                    }
                    out.chatyy_events.push(ChatyyEvent {
                        event_type: t.to_string(),
                        sender_uid: uid_from_user_id(encryption_info.sender.as_str()).unwrap_or_default(),
                        sender_device_id: encryption_info.sender_device.map(|d| d.to_string()).unwrap_or_default(),
                        content_json: v.get("content").cloned().unwrap_or(Value::Null).to_string(),
                    });
                }
                ProcessedToDeviceEvent::UnableToDecrypt { .. } => {
                    out.to_device_utd += 1;
                    self.metrics.inc_td_utd();
                }
                // Evento to-device EM CLARO nunca é confiável no protocolo Chatyy.
                ProcessedToDeviceEvent::PlainText(_) | ProcessedToDeviceEvent::Invalid(_) => {}
            }
        }
        let mut convs = new_key_convs;
        let mut items = vec![];
        for k in keys {
            if let Some(c) = conv_from_room_id(k.room_id.as_str()) {
                items.push((c.clone(), k.session_id.clone()));
                convs.insert(c);
            }
        }
        Self::remember_sessions(m, &items).await?;
        out.convs_with_new_keys = convs.into_iter().collect();
        out.identity_changed_uids = changed_users.iter().filter_map(|u| uid_from_user_id(u.as_str())).collect();
        self.metrics.add_td(n_events as u64);
        Ok(out)
    }

    /// Garante sessões Olm com todos os aparelhos dos usuários (keys_query + keys_claim).
    pub(crate) async fn ensure_sessions(&self, m: &OlmMachine, users: &[OwnedUserId]) -> CoreResult<()> {
        m.update_tracked_users(refs(&users).into_iter()).await?;
        drain(m, self.transport.as_ref()).await?;
        if let Some((id, req)) = m.get_missing_sessions(refs(&users).into_iter()).await? {
            send_request(m, self.transport.as_ref(), &id, &AnyOutgoingRequest::KeysClaim(req)).await?;
        }
        drain(m, self.transport.as_ref()).await?;
        Ok(())
    }

    async fn imported_session_sender(
        &self,
        m: &OlmMachine,
        sender: &ruma::UserId,
        info: &matrix_sdk_common::deserialized_responses::EncryptionInfo,
    ) -> CoreResult<SenderCheck> {
        use matrix_sdk_common::deserialized_responses::AlgorithmInfo;
        let AlgorithmInfo::MegolmV1AesSha2 { curve25519_key, sender_claimed_keys, .. } = &info.algorithm_info else {
            return Ok(SenderCheck::Unknown { definitive: true });
        };
        if info.sender != *sender {
            return Ok(SenderCheck::Unknown { definitive: true });
        }
        let claimed_ed = sender_claimed_keys.get(&ruma::DeviceKeyAlgorithm::Ed25519).cloned().unwrap_or_default();
        let devs = m.get_user_devices(sender, None).await?;
        let ok = devs.devices().find(|d| {
            d.is_cross_signed_by_owner()
                && d.curve25519_key().map(|k| k.to_base64()) == Some(curve25519_key.clone())
                && d.ed25519_key().map(|k| k.to_base64()) == Some(claimed_ed.clone())
        });
        if let Some(d) = ok {
            return Ok(SenderCheck::Current(d.device_id().to_owned()));
        }
        // [1.7] aparelho já desconectado (revogado): o servidor devolve as chaves ASSINADAS dele e
        // conferimos a assinatura com a SSK atual do dono.
        match self.former_devices(m, sender).await? {
            None => Ok(SenderCheck::Unknown { definitive: false }),
            Some(list) => Ok(list
                .into_iter()
                .find(|(_, c, e)| *c == *curve25519_key && *e == claimed_ed)
                .and_then(|(d, _, _)| OwnedDeviceId::try_from(d).ok())
                .map(SenderCheck::Former)
                .unwrap_or(SenderCheck::Unknown { definitive: true })),
        }
    }

    /// [1.7] Aparelhos JÁ desconectados de `user`, conferidos contra a SSK atual (cache 10 min no
    /// store). None = não deu para saber (rede, identidade do dono ainda desconhecida).
    async fn former_devices(&self, m: &OlmMachine, user: &ruma::UserId) -> CoreResult<Option<Vec<(String, String, String)>>> {
        type Cache = BTreeMap<String, (u64, Vec<(String, String, String)>)>;
        let mut cache: Cache = Self::cv_get(m, CV_FORMER).await?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let now = now_ms();
        let key = user.to_string();
        if let Some((t, l)) = cache.get(&key) {
            if now.saturating_sub(*t) < FORMER_TTL_MS {
                return Ok(Some(l.clone()));
            }
        }
        let Some(identity) = m.get_identity(user, None).await? else { return Ok(None) };
        let d = match call_json(self.transport.as_ref(), actions::DEVICES_FORMER, &json!({"user_ids": [user.as_str()]})).await {
            Ok(d) => d,
            Err(CoreError::Server { status, .. }) if status < 500 && status != 429 => json!({}),
            Err(_) => return Ok(cache.get(&key).map(|(_, l)| l.clone())),
        };
        let mut out = vec![];
        if let Some(map) = d.get("device_keys").and_then(|x| x.get(user.as_str())).and_then(Value::as_object) {
            for (dev, v) in map.iter().take(200) {
                let Ok(dk) = serde_json::from_value::<matrix_sdk_crypto::types::DeviceKeys>(v.clone()) else { continue };
                if dk.user_id != *user || dk.device_id.as_str() != dev {
                    continue;
                }
                let signed = match &identity {
                    matrix_sdk_crypto::UserIdentity::Own(o) => o.self_signing_key().verify_device_keys(&dk).is_ok(),
                    matrix_sdk_crypto::UserIdentity::Other(o) => o.self_signing_key().verify_device_keys(&dk).is_ok(),
                };
                if !signed {
                    continue;
                }
                if let (Some(c), Some(e)) = (dk.curve25519_key(), dk.ed25519_key()) {
                    out.push((dev.clone(), c.to_base64(), e.to_base64()));
                }
            }
        }
        cache.retain(|_, (t, _)| now.saturating_sub(*t) < 24 * 3600 * 1000);
        if cache.len() > 500 {
            cache.clear();
        }
        cache.insert(key, (now, out.clone()));
        Self::cv_set(m, CV_FORMER, &serde_json::to_string(&cache)?).await?;
        Ok(Some(out))
    }

    pub(crate) async fn import_keys_vec(&self, keys: Vec<matrix_sdk_crypto::olm::ExportedRoomKey>, backup_version: Option<&str>) -> CoreResult<ImportResult> {
        let op = self.op().await?;
        self.import_keys_locked(&op.m, keys, backup_version).await
    }

    pub(crate) async fn import_keys_locked(&self, m: &OlmMachine, keys: Vec<matrix_sdk_crypto::olm::ExportedRoomKey>, backup_version: Option<&str>) -> CoreResult<ImportResult> {
        let items: Vec<(String, String)> = keys
            .iter()
            .filter_map(|k| conv_from_room_id(k.room_id.as_str()).map(|c| (c, k.session_id.clone())))
            .collect();
        let r = m.store().import_room_keys(keys, backup_version, |_, _| {}).await?;
        Self::remember_sessions(m, &items).await?;
        let convs: BTreeSet<String> = r.keys.keys().filter_map(|room| conv_from_room_id(room.as_str())).collect();
        Ok(ImportResult { imported: r.imported_count as u32, total: r.total_count as u32, convs: convs.into_iter().collect() })
    }
}

fn map_megolm_err(e: &MegolmError) -> UtdReason {
    use vodozemac::megolm::DecryptionError as D;
    match e {
        MegolmError::MissingRoomKey(Some(_)) => UtdReason::Withheld,
        MegolmError::MissingRoomKey(None) => UtdReason::MissingSession,
        MegolmError::Decryption(D::UnknownMessageIndex(..)) => UtdReason::UnknownIndex,
        MegolmError::Decryption(_) => UtdReason::Corrupted,
        MegolmError::Decode(_) => UtdReason::BadEnvelope,
        MegolmError::JsonError(_) => UtdReason::BadEnvelope,
        MegolmError::MismatchedIdentityKeys(_) => UtdReason::SenderMismatch,
        MegolmError::EventError(_) => UtdReason::SenderMismatch,
        MegolmError::SenderIdentityNotTrusted(_) => UtdReason::UntrustedDevice,
        MegolmError::Store(_) => UtdReason::Store,
        #[allow(unreachable_patterns)]
        _ => UtdReason::Corrupted,
    }
}
