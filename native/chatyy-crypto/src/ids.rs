//! IDs do contrato (CONTRATO §1). O núcleo nunca vê e-mail: só `uid` (inteiro estável emitido
//! pelo servidor em `e2ee5_status`) e `conv_id` (id bigint de `chat_conversations`).
use crate::error::{invalid, CoreResult};
use ruma::{OwnedDeviceId, OwnedRoomId, OwnedUserId};

/// Domínio fixo dos ids internos. Nunca aparece na UI.
pub const ID_DOMAIN: &str = "chatyy";

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.len() <= 19 && s.bytes().all(|b| b.is_ascii_digit()) && !(s.len() > 1 && s.starts_with('0'))
}

/// `"42"` → `@u42:chatyy`.
pub fn user_id_for_uid(uid: &str) -> CoreResult<OwnedUserId> {
    if !is_digits(uid) {
        return Err(invalid("uid", "uid deve ser inteiro decimal sem zeros à esquerda"));
    }
    OwnedUserId::try_from(format!("@u{uid}:{ID_DOMAIN}")).map_err(|e| invalid("uid", e))
}

/// `@u42:chatyy` → `Some("42")`.
pub fn uid_from_user_id(user_id: &str) -> Option<String> {
    let rest = user_id.strip_prefix("@u")?.strip_suffix(&format!(":{ID_DOMAIN}"))?;
    is_digits(rest).then(|| rest.to_string())
}

/// `"971"` → `!c971:chatyy`.
pub fn room_id_for_conv(conv_id: &str) -> CoreResult<OwnedRoomId> {
    if !is_digits(conv_id) {
        return Err(invalid("conv_id", "conv_id deve ser inteiro decimal"));
    }
    OwnedRoomId::try_from(format!("!c{conv_id}:{ID_DOMAIN}")).map_err(|e| invalid("conv_id", e))
}

pub fn conv_from_room_id(room_id: &str) -> Option<String> {
    let rest = room_id.strip_prefix("!c")?.strip_suffix(&format!(":{ID_DOMAIN}"))?;
    is_digits(rest).then(|| rest.to_string())
}

/// device_id: 10–32 chars `[A-Z0-9]`, gerado pelo host/núcleo uma vez por instalação.
pub fn validate_device_id(d: &str) -> CoreResult<OwnedDeviceId> {
    if d.len() < 10 || d.len() > 32 || !d.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()) {
        return Err(invalid("device_id", "device_id: 10-32 caracteres [A-Z0-9]"));
    }
    Ok(OwnedDeviceId::from(d))
}

/// Novo device_id aleatório (CONTRATO §1.3): prefixo de plataforma + 12 base32.
/// `P` celular principal iOS/Android, `W` web, `T` tablet/desktop, `X` testes.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn new_device_id(platform_prefix: &str) -> CoreResult<String> {
    let p = platform_prefix.to_ascii_uppercase();
    if !matches!(p.as_str(), "P" | "W" | "T" | "X") {
        return Err(invalid("platform_prefix", "use P, W, T ou X"));
    }
    const ALPH: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut b = [0u8; 12];
    crate::util::fill_random(&mut b)?;
    let s: String = b.iter().map(|x| ALPH[(x & 31) as usize] as char).collect();
    Ok(format!("{p}{s}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_ids() {
        assert_eq!(user_id_for_uid("42").unwrap().as_str(), "@u42:chatyy");
        assert_eq!(uid_from_user_id("@u42:chatyy").as_deref(), Some("42"));
        assert!(user_id_for_uid("042").is_err());
        assert!(user_id_for_uid("a@b").is_err());
        assert_eq!(conv_from_room_id(room_id_for_conv("971").unwrap().as_str()).as_deref(), Some("971"));
        let d = new_device_id("p").unwrap();
        assert_eq!(d.len(), 13);
        validate_device_id(&d).unwrap();
        assert!(validate_device_id("abc").is_err());
    }
}
