//! Tradução dos pedidos sans-IO da OlmMachine ↔ ações `e2ee5_*` (CONTRATO §4.2).
//! Corpo e resposta = JSON Matrix, sem transformação, para o PHP (WP-05) ser fino.
use crate::error::{internal, CoreResult};
use crate::transport::{actions, call_json, HttpTransport};
use matrix_sdk_crypto::{
    types::requests::{AnyOutgoingRequest, KeysBackupRequest, ToDeviceRequest, UploadSigningKeysRequest},
    OlmMachine,
};
use ruma::{
    api::{
        client::{
            backup::add_backup_keys,
            keys::{claim_keys, get_keys, upload_keys, upload_signatures},
            to_device::send_event_to_device,
        },
        IncomingResponse,
    },
    to_device::DeviceIdOrAllDevices,
    TransactionId,
};
use serde_json::{json, Map, Value};

pub(crate) fn ruma_resp<R: IncomingResponse>(v: &Value) -> CoreResult<R> {
    let body = serde_json::to_vec(v)?;
    let r = http::Response::builder().status(200).body(body).map_err(internal)?;
    R::try_from_http_response(r).map_err(|e| crate::error::CoreError::Server { status: 200, code: format!("bad_matrix_body:{e:?}").chars().take(120).collect() })
}

pub(crate) fn to_device_body(r: &ToDeviceRequest) -> CoreResult<Value> {
    let mut msgs = Map::new();
    for (u, devs) in &r.messages {
        let mut m = Map::new();
        for (d, content) in devs {
            let key = match d {
                DeviceIdOrAllDevices::DeviceId(d) => d.to_string(),
                DeviceIdOrAllDevices::AllDevices => "*".to_string(),
            };
            m.insert(key, serde_json::from_str(content.json().get())?);
        }
        msgs.insert(u.to_string(), Value::Object(m));
    }
    Ok(json!({"event_type": r.event_type.to_string(), "txn_id": r.txn_id.to_string(), "messages": msgs}))
}

/// Envia um pedido e marca como enviado. Devolve o `data` cru (para métricas/testes).
pub(crate) async fn send_request(
    m: &OlmMachine,
    t: &dyn HttpTransport,
    id: &TransactionId,
    req: &AnyOutgoingRequest,
) -> CoreResult<()> {
    match req {
        AnyOutgoingRequest::KeysUpload(r) => {
            let body = json!({"device_keys": r.device_keys, "one_time_keys": r.one_time_keys, "fallback_keys": r.fallback_keys});
            let d = call_json(t, actions::KEYS_UPLOAD, &body).await?;
            let x: upload_keys::v3::Response = ruma_resp(&d)?;
            m.mark_request_as_sent(id, &x).await?;
        }
        AnyOutgoingRequest::KeysQuery(r) => {
            let body = json!({"device_keys": r.device_keys});
            let d = call_json(t, actions::KEYS_QUERY, &body).await?;
            let x: get_keys::v3::Response = ruma_resp(&d)?;
            m.mark_request_as_sent(id, &x).await?;
        }
        AnyOutgoingRequest::KeysClaim(r) => {
            let body = json!({"one_time_keys": r.one_time_keys});
            let d = call_json(t, actions::KEYS_CLAIM, &body).await?;
            let x: claim_keys::v3::Response = ruma_resp(&d)?;
            m.mark_request_as_sent(id, &x).await?;
        }
        AnyOutgoingRequest::ToDeviceRequest(r) => {
            send_to_device_req(m, t, r, true).await?;
        }
        AnyOutgoingRequest::SignatureUpload(r) => {
            let body = serde_json::to_value(&r.signed_keys)?;
            let d = call_json(t, actions::SIGNATURES_UPLOAD, &body).await?;
            let x: upload_signatures::v3::Response = ruma_resp(&d)?;
            m.mark_request_as_sent(id, &x).await?;
        }
        AnyOutgoingRequest::RoomMessage(_) => {
            // Verificação dentro de sala não é usada no Chatyy (verificação = QR/60 dígitos
            // fora de banda). Ignorado de propósito; a OlmMachine não espera resposta crítica.
        }
    }
    Ok(())
}

pub(crate) async fn send_to_device_req(m: &OlmMachine, t: &dyn HttpTransport, r: &ToDeviceRequest, mark: bool) -> CoreResult<usize> {
    let body = to_device_body(r)?;
    let n = body.to_string().len();
    let d = call_json(t, actions::TO_DEVICE_SEND, &body).await?;
    if mark {
        let x: send_event_to_device::v3::Response = ruma_resp(&d)?;
        m.mark_request_as_sent(&r.txn_id, &x).await?;
    }
    Ok(n)
}

pub(crate) async fn upload_signing_keys(t: &dyn HttpTransport, r: &UploadSigningKeysRequest) -> CoreResult<()> {
    let body = json!({"master_key": r.master_key, "self_signing_key": r.self_signing_key, "user_signing_key": r.user_signing_key});
    call_json(t, actions::SIGNING_KEYS_UPLOAD, &body).await?;
    Ok(())
}

pub(crate) async fn send_backup(m: &OlmMachine, t: &dyn HttpTransport, id: &TransactionId, r: &KeysBackupRequest) -> CoreResult<()> {
    let body = json!({"version": r.version, "rooms": r.rooms});
    let d = call_json(t, actions::BACKUP_KEYS_PUT, &body).await?;
    let x: add_backup_keys::v3::Response = ruma_resp(&d)?;
    m.mark_request_as_sent(id, &x).await?;
    Ok(())
}

/// Esvazia `outgoing_requests` (até 8 rodadas: upload → query → claim → …).
pub(crate) async fn drain(m: &OlmMachine, t: &dyn HttpTransport) -> CoreResult<usize> {
    let mut n = 0;
    for _ in 0..8 {
        let reqs = m.outgoing_requests().await?;
        if reqs.is_empty() {
            break;
        }
        for r in reqs {
            send_request(m, t, r.request_id(), r.request()).await?;
            n += 1;
        }
    }
    Ok(n)
}
