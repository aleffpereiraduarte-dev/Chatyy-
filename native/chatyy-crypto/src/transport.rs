//! Transporte HTTP fornecido pelo host (CONTRATO §4.1 e §6.2).
//!
//! O núcleo é "sans-IO" por cima: ele decide QUAL ação chamar e com qual JSON; o host só faz o
//! POST autenticado (bearer, base URL, região) e devolve status + corpo cru. O núcleo entende o
//! envelope `{success, data, message}` do `email.php`.
use crate::error::{CoreError, CoreResult};
use serde_json::Value;

/// Resposta HTTP crua devolvida pelo host.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// Falha de rede (sem resposta HTTP). Erros HTTP com corpo vão em `HttpResponse`.
#[derive(Debug, thiserror::Error)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Error))]
pub enum TransportError {
    #[error("network: {msg}")]
    Network { msg: String },
}

#[cfg(feature = "uniffi")]
impl From<uniffi::UnexpectedUniFFICallbackError> for TransportError {
    fn from(e: uniffi::UnexpectedUniFFICallbackError) -> Self {
        TransportError::Network { msg: e.reason }
    }
}

/// Callback do host. `action` é o nome SEM prefixo (`"keys_upload"`); o host monta
/// `POST {base}/api/email.php?action=e2ee5_<action>` com `Authorization: Bearer …`,
/// `X-E2EE-Device: <device_id>` e `Content-Type: application/json`, corpo = `body_json`.
#[cfg(not(target_family = "wasm"))]
#[cfg_attr(feature = "uniffi", uniffi::export(with_foreign))]
#[async_trait::async_trait]
pub trait HttpTransport: Send + Sync {
    async fn call(&self, action: String, body_json: String) -> Result<HttpResponse, TransportError>;
}

/// Na web (wasm, uma thread só) o transporte embrulha `fetch` (JsValue não é `Send`).
#[cfg(target_family = "wasm")]
#[async_trait::async_trait(?Send)]
pub trait HttpTransport {
    async fn call(&self, action: String, body_json: String) -> Result<HttpResponse, TransportError>;
}

/// Nomes de ação (sem o prefixo `e2ee5_`). Fonte: CONTRATO §4.2.
pub mod actions {
    pub const STATUS: &str = "status";
    pub const KEYS_UPLOAD: &str = "keys_upload";
    pub const KEYS_QUERY: &str = "keys_query";
    pub const KEYS_CLAIM: &str = "keys_claim";
    pub const SIGNING_KEYS_UPLOAD: &str = "signing_keys_upload";
    pub const SIGNATURES_UPLOAD: &str = "signatures_upload";
    pub const TO_DEVICE_SEND: &str = "to_device_send";
    pub const SYNC: &str = "sync";
    pub const DEVICE_DELETE: &str = "device_delete";
    pub const BACKUP_VERSION_CREATE: &str = "backup_version_create";
    pub const BACKUP_VERSION_GET: &str = "backup_version_get";
    pub const BACKUP_VERSION_DELETE: &str = "backup_version_delete";
    pub const BACKUP_KEYS_PUT: &str = "backup_keys_put";
    pub const BACKUP_KEYS_GET: &str = "backup_keys_get";
    pub const SECRET_STORAGE_PUT: &str = "secret_storage_put";
    pub const SECRET_STORAGE_GET: &str = "secret_storage_get";
    pub const LINK_CREATE: &str = "link_create";
    pub const LINK_POST: &str = "link_post";
    pub const LINK_POLL: &str = "link_poll";
    pub const LINK_FINISH: &str = "link_finish";
    pub const METRICS: &str = "metrics";
    /// [1.7] pedido de chave de sala (destinatário) e atestado do pedido (remetente).
    pub const KEY_REQUEST: &str = "key_request";
    pub const KEY_REQUEST_CHECK: &str = "key_request_check";
    /// [1.7] aparelhos já desconectados (chaves assinadas) — histórico importado continua legível.
    pub const DEVICES_FORMER: &str = "devices_former";
}

/// Chama a ação e devolve `data` (o JSON no formato Matrix) ou erro tipado.
pub(crate) async fn call_json(t: &dyn HttpTransport, action: &str, body: &Value) -> CoreResult<Value> {
    let resp = t
        .call(action.to_string(), body.to_string())
        .await
        .map_err(|e| CoreError::Transport { msg: e.to_string() })?;
    parse_response(resp)
}

pub(crate) fn parse_response(resp: HttpResponse) -> CoreResult<Value> {
    let v: Value = serde_json::from_str(&resp.body).map_err(|_| CoreError::Server {
        status: resp.status,
        code: if resp.status >= 500 { "server_error".into() } else { "bad_response".into() },
    })?;
    let ok = v.get("success").and_then(Value::as_bool).unwrap_or(false);
    if ok && (200..300).contains(&resp.status) {
        return Ok(v.get("data").cloned().unwrap_or(Value::Object(Default::default())));
    }
    let code = v
        .get("data")
        .and_then(|d| d.get("code"))
        .and_then(Value::as_str)
        .unwrap_or(if resp.status == 401 { "unauthorized" } else { "error" })
        .to_string();
    Err(CoreError::Server { status: resp.status, code })
}
