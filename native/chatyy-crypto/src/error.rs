//! Erros tipados do núcleo (CONTRATO §6.4). Mensagens NUNCA carregam conteúdo, chave ou segredo.
use thiserror::Error;

/// Motivo de "não foi possível decifrar" (UTD). Vai para a métrica `e2ee5_metrics` e para o
/// evento `chatyy.decrypt_report` — por isso é um código curto e estável.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
#[serde(rename_all = "snake_case")]
pub enum UtdReason {
    /// A chave Megolm da sessão ainda não chegou (to-device atrasado). Recuperável.
    MissingSession,
    /// A sessão existe, mas não cobre este índice (entrou depois / chave parcial).
    UnknownIndex,
    /// O remetente reteve a chave de propósito (aparelho não assinado, bloqueado…).
    Withheld,
    /// O aparelho remetente não é assinado pelo dono (possível aparelho injetado).
    UntrustedDevice,
    /// O remetente declarado não bate com o dono da sessão.
    SenderMismatch,
    /// O payload decifrado diz outra conversa ou outro client_message_id (mensagem movida).
    ContextMismatch,
    /// Envelope mal formado, versão desconhecida ou JSON inválido.
    BadEnvelope,
    /// Falha de MAC/decodificação (adulteração).
    Corrupted,
    /// Erro de store (disco, trava). Recuperável.
    Store,
    /// [1.7] Sessão importada (backup/vínculo/export) cujo aparelho remetente não é — nem foi —
    /// assinado pelo dono (nem na lista atual nem entre os aparelhos já desconectados). Definitivo.
    UnverifiedSender,
}

impl UtdReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            UtdReason::MissingSession => "missing_session",
            UtdReason::UnknownIndex => "unknown_index",
            UtdReason::Withheld => "withheld",
            UtdReason::UntrustedDevice => "untrusted_device",
            UtdReason::SenderMismatch => "sender_mismatch",
            UtdReason::ContextMismatch => "context_mismatch",
            UtdReason::BadEnvelope => "bad_envelope",
            UtdReason::Corrupted => "corrupted",
            UtdReason::Store => "store",
            UtdReason::UnverifiedSender => "unverified_sender",
        }
    }
    /// Vale a pena tentar de novo depois de um `sync()`?
    pub fn retryable(&self) -> bool {
        matches!(self, UtdReason::MissingSession | UtdReason::UnknownIndex | UtdReason::Store | UtdReason::UntrustedDevice)
    }
}

#[derive(Debug, Error)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Error))]
pub enum CoreError {
    /// Não foi possível decifrar. `session_id` ajuda o host a pedir a chave / reagendar.
    #[error("utd: {reason:?}")]
    Utd { reason: UtdReason, session_id: String },
    /// Entrada inválida do host (JSON, ids, tamanho). `field` diz qual.
    #[error("invalid input: {field}: {msg}")]
    InvalidInput { field: String, msg: String },
    /// Falha de rede/transporte (o host não conseguiu falar com o servidor).
    #[error("transport: {msg}")]
    Transport { msg: String },
    /// O servidor respondeu `success:false` com um código do contrato (§4.3).
    #[error("server {status}: {code}")]
    Server { status: u16, code: String },
    /// Store de cripto (SQLite/IndexedDB) falhou ou senha errada.
    #[error("store: {msg}")]
    Store { msg: String },
    /// A trava entre processos não foi obtida a tempo (NSE x app).
    #[error("lock busy")]
    LockBusy,
    /// Identidade de conta (MSK) ainda não existe / este aparelho não é o principal.
    #[error("identity: {msg}")]
    Identity { msg: String },
    /// Um contato VERIFICADO trocou de identidade: o host pede confirmação e chama
    /// `pin_identity(uid)` antes de reenviar. `uids` separados por vírgula.
    #[error("identity changed for verified users")]
    IdentityViolation { uids: Vec<String> },
    /// Mídia adulterada / hash não confere / info inválida.
    #[error("media: {msg}")]
    Media { msg: String },
    /// Vínculo QR: segredo, código ou chave não conferem; ou rendezvous expirou.
    #[error("link: {msg}")]
    Link { msg: String },
    /// Backup: chave de recuperação errada, versão ausente…
    #[error("backup: {msg}")]
    Backup { msg: String },
    /// Erro interno inesperado (bug). Nunca contém conteúdo.
    #[error("internal: {msg}")]
    Internal { msg: String },
}

pub type CoreResult<T> = Result<T, CoreError>;

pub(crate) fn internal(e: impl std::fmt::Display) -> CoreError {
    CoreError::Internal { msg: e.to_string() }
}
pub(crate) fn store_err(e: impl std::fmt::Display) -> CoreError {
    CoreError::Store { msg: e.to_string() }
}
pub(crate) fn invalid(field: &str, msg: impl std::fmt::Display) -> CoreError {
    CoreError::InvalidInput { field: field.to_string(), msg: msg.to_string() }
}

impl From<serde_json::Error> for CoreError {
    fn from(e: serde_json::Error) -> Self {
        CoreError::InvalidInput { field: "json".into(), msg: e.to_string() }
    }
}
impl From<matrix_sdk_crypto::CryptoStoreError> for CoreError {
    fn from(e: matrix_sdk_crypto::CryptoStoreError) -> Self {
        store_err(e)
    }
}
impl From<matrix_sdk_crypto::OlmError> for CoreError {
    fn from(e: matrix_sdk_crypto::OlmError) -> Self {
        use matrix_sdk_crypto::{OlmError, SessionRecipientCollectionError as S};
        match e {
            OlmError::SessionRecipientCollectionError(S::VerifiedUserChangedIdentity(users)) => {
                CoreError::IdentityViolation { uids: users.iter().filter_map(|u| crate::ids::uid_from_user_id(u.as_str())).collect() }
            }
            OlmError::SessionRecipientCollectionError(S::CrossSigningNotSetup) => {
                CoreError::Identity { msg: "cross_signing_not_setup".into() }
            }
            OlmError::SessionRecipientCollectionError(S::SendingFromUnverifiedDevice) => {
                CoreError::Identity { msg: "own_device_not_verified".into() }
            }
            OlmError::Store(s) => store_err(s),
            other => internal(other),
        }
    }
}
