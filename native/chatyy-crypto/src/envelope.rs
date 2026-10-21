//! Envelope `{"e2e":5,"c":{…}}` e payload interno v1 (CONTRATO §2).
use crate::error::{invalid, CoreError, CoreResult, UtdReason};
use serde_json::{json, Value};

pub const ENVELOPE_VERSION: u64 = 5;
pub const PAYLOAD_VERSION: u64 = 1;
/// Tipo do evento interno Megolm (vai cifrado; o servidor nunca vê).
pub const INNER_EVENT_TYPE: &str = "chatyy.msg";
/// Limite do payload interno serializado (CONTRATO §2.6).
pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
/// Limite do envelope (o servidor recusa acima disso — §2.6).
pub const MAX_ENVELOPE_BYTES: usize = 96 * 1024;

/// Detecta a versão de um `content` de mensagem: `Some(n)` se for `{"e2e":n,…}`.
/// Útil para o host mostrar "Atualize o Chatyy" quando `n` > 5 (CONTRATO §2.1).
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn envelope_version(content: &str) -> Option<u64> {
    let s = content.trim_start();
    if !s.starts_with("{\"e2e\"") && !s.starts_with("{ \"e2e\"") {
        return None;
    }
    serde_json::from_str::<Value>(s).ok()?.get("e2e")?.as_u64()
}

pub(crate) fn wrap(c: Value) -> String {
    // Ordem de campos estável: "e2e" primeiro (o prefixo `{"e2e"` é usado como teste barato).
    format!("{{\"e2e\":{},\"c\":{}}}", ENVELOPE_VERSION, c)
}

pub(crate) fn unwrap(envelope: &str) -> CoreResult<Value> {
    if envelope.len() > MAX_ENVELOPE_BYTES {
        return Err(utd(UtdReason::BadEnvelope, ""));
    }
    let v: Value = serde_json::from_str(envelope).map_err(|_| utd(UtdReason::BadEnvelope, ""))?;
    if v.get("e2e").and_then(Value::as_u64) != Some(ENVELOPE_VERSION) {
        return Err(utd(UtdReason::BadEnvelope, ""));
    }
    let c = v.get("c").cloned().ok_or_else(|| utd(UtdReason::BadEnvelope, ""))?;
    if c.get("algorithm").and_then(Value::as_str) != Some("m.megolm.v1.aes-sha2") {
        return Err(utd(UtdReason::BadEnvelope, ""));
    }
    Ok(c)
}

pub(crate) fn utd(reason: UtdReason, session_id: &str) -> CoreError {
    CoreError::Utd { reason, session_id: session_id.to_string() }
}

/// Valida o payload ANTES de cifrar. O núcleo só impõe os invariantes de segurança
/// (versão, conversa, cmid, tamanho); o esquema por tipo é do WP-09 (payload.js).
pub(crate) fn validate_outgoing(conv_id: &str, payload_json: &str) -> CoreResult<Value> {
    if payload_json.len() > MAX_PAYLOAD_BYTES {
        return Err(invalid("payload", format!("maior que {MAX_PAYLOAD_BYTES} bytes")));
    }
    let v: Value = serde_json::from_str(payload_json).map_err(|e| invalid("payload", e))?;
    let o = v.as_object().ok_or_else(|| invalid("payload", "deve ser objeto"))?;
    if o.get("v").and_then(Value::as_u64) != Some(PAYLOAD_VERSION) {
        return Err(invalid("payload.v", "deve ser 1"));
    }
    if o.get("conv").and_then(Value::as_str) != Some(conv_id) {
        return Err(invalid("payload.conv", "deve ser igual ao conv_id"));
    }
    let cmid = o.get("cmid").and_then(Value::as_str).unwrap_or("");
    if cmid.len() < 8 || cmid.len() > 64 {
        return Err(invalid("payload.cmid", "8-64 caracteres"));
    }
    if o.get("t").and_then(Value::as_str).map(|t| t.is_empty() || t.len() > 32).unwrap_or(true) {
        return Err(invalid("payload.t", "tipo obrigatório (≤32)"));
    }
    Ok(v)
}

/// Confere o payload DEPOIS de decifrar contra os metadados em claro da linha.
pub(crate) fn validate_incoming(conv_id: &str, cmid: Option<&str>, payload: &Value, session_id: &str) -> CoreResult<()> {
    let ok_v = payload.get("v").and_then(Value::as_u64).map(|v| v >= 1).unwrap_or(false);
    let ok_conv = payload.get("conv").and_then(Value::as_str) == Some(conv_id);
    let ok_cmid = match cmid {
        Some(c) if !c.is_empty() => payload.get("cmid").and_then(Value::as_str) == Some(c),
        _ => true,
    };
    if !ok_v {
        return Err(utd(UtdReason::BadEnvelope, session_id));
    }
    if !ok_conv || !ok_cmid {
        return Err(utd(UtdReason::ContextMismatch, session_id));
    }
    Ok(())
}

/// Monta o evento Matrix que a OlmMachine espera para decifrar.
pub(crate) fn as_room_event(c: Value, sender: &str, room_id: &str, mid: &str, ts: u64) -> Value {
    json!({
        "type": "m.room.encrypted",
        "sender": sender,
        "event_id": format!("$m{mid}"),
        "origin_server_ts": ts,
        "room_id": room_id,
        "content": c,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn version_detection() {
        assert_eq!(envelope_version(r#"{"e2e":5,"c":{}}"#), Some(5));
        assert_eq!(envelope_version(r#"{"e2e":9,"c":{}}"#), Some(9));
        assert_eq!(envelope_version("olá"), None);
        assert_eq!(envelope_version(r#"{"type":"x"}"#), None);
        assert!(wrap(json!({"a":1})).starts_with("{\"e2e\":5,"));
    }
    #[test]
    fn outgoing_rules() {
        let ok = r#"{"v":1,"t":"text","conv":"9","cmid":"abcdefgh","body":"oi"}"#;
        validate_outgoing("9", ok).unwrap();
        assert!(validate_outgoing("8", ok).is_err());
        assert!(validate_outgoing("9", r#"{"v":2,"t":"text","conv":"9","cmid":"abcdefgh"}"#).is_err());
        assert!(validate_outgoing("9", r#"{"v":1,"t":"text","conv":"9","cmid":"a"}"#).is_err());
        let big = format!(r#"{{"v":1,"t":"text","conv":"9","cmid":"abcdefgh","body":"{}"}}"#, "x".repeat(MAX_PAYLOAD_BYTES));
        assert!(validate_outgoing("9", &big).is_err());
    }
}
