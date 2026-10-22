//! # chatyy-crypto — núcleo E2EE v5 do Chatyy
//!
//! Fonte da verdade das interfaces: `docs/e2ee/CONTRATO.md` (§6 = esta API).
//! Protocolo: Olm (pares de aparelhos) + Megolm (sessão por remetente em cada conversa, também
//! no 1:1) da `matrix-sdk-crypto =0.18.0` (vodozemac por baixo). Sem servidor Matrix: o
//! "servidor" é o `e2ee5.php` do Chatyy, falado pelo `HttpTransport` do host.
//!
//! Regras (CONTRATO §0): nada de primitivas próprias; nada de log com conteúdo/chave;
//! erros sem conteúdo; tudo determinístico e versionado.
#![forbid(unsafe_code)]

mod backup;
mod core;
mod envelope;
mod error;
mod identity;
mod ids;
mod link;
mod media;
mod metrics;
mod requests;
mod transport;
mod util;

pub use crate::backup::{BackupEnabled, BackupStatus, RestoreResult};
pub use crate::core::{
    ChatyyEvent, CryptoCore, DecryptInput, Decrypted, DeviceSummary, DeviceTarget, EncryptResult, ExportFilter,
    IdentityStatus, ImportResult, OpenOptions, ProcessRole, SendToDeviceResult, SyncResult, Trust,
};
pub use crate::envelope::{envelope_version, ENVELOPE_VERSION, INNER_EVENT_TYPE, MAX_ENVELOPE_BYTES, MAX_PAYLOAD_BYTES, PAYLOAD_VERSION};
pub use crate::error::{CoreError, CoreResult, UtdReason};
pub use crate::identity::{fingerprint_digits, safety_number_for, SafetyNumber};
pub use crate::ids::{conv_from_room_id, new_device_id, room_id_for_conv, uid_from_user_id, user_id_for_uid};
pub use crate::link::{LinkPhone, LinkPhoneState, LinkWeb, LinkWebState, LINK_INFO};
pub use crate::media::{decrypt_bytes, decrypt_file, encrypt_bytes, encrypt_file, EncryptedBytes, EncryptedFile};
pub use crate::metrics::MetricsSnapshot;
pub use crate::transport::{actions, HttpResponse, HttpTransport, TransportError};

/// Versão do contrato que este núcleo implementa (CONTRATO, cabeçalho).
pub const CONTRACT_VERSION: &str = "e2ee5-contrato/1.6";

/// `"chatyy-crypto 0.1.0; contrato e2ee5-contrato/1.6; matrix-sdk-crypto 0.18.0; vodozemac 0.10.0"`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn core_version() -> String {
    format!(
        "chatyy-crypto {}; contrato {}; matrix-sdk-crypto 0.18.0; vodozemac 0.10.0",
        env!("CARGO_PKG_VERSION"),
        CONTRACT_VERSION
    )
}

#[cfg(feature = "uniffi")]
uniffi::setup_scaffolding!("chatyy_crypto");
