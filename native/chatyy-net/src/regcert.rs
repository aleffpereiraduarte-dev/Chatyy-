//! Certificado de REGIÃO assinado pela raiz Ed25519 offline (PROTOCOLO §9.2) — lado cliente.
//!
//! Espelho do `VerifyNC` do Go (`leaf/src/qnwire/regcert.go`), mesma ordem de conferência:
//! formato do `nc` → formato do cert → raiz conhecida → assinatura → região → kid → validade.
//! Vetores: `tests/regcert_vectors.json` (raiz de TESTE `vr1`, 11 casos).
//!
//! ```text
//! certBytes = "CYRC" | 0x01 | u8 len + rootId | u8 len + region | u8 len + kid | noisePub(32)
//!             | u8 nPins (1..4) | pins (32 × n) | u64 notBefore | u64 notAfter     (BE, nada sobrando)
//! sig       = Ed25519(raiz, "chatyy-region-cert/1" 0x00 || certBytes)
//! nc        = b64url_sem_padding(certBytes) "." b64url_sem_padding(sig)          (≤ 1024 chars)
//! ```
//!
//! Base64url ESTRITO: '=' inválido, sem espaço/quebra de linha, bits de sobra do último caractere têm
//! de ser 0 (forma canônica). O Go aceita '\r'/'\n' e bits de sobra ≠ 0 (decoder não-Strict); aqui é
//! mais estrito de propósito — o encoder do Go (`EncodeNC`) nunca produz essas formas, então nenhum
//! `nc` legítimo é recusado, e o cliente não aceita grafias alternativas do mesmo certificado.

use ring::signature::{UnparsedPublicKey, ED25519};

pub const MAGIC: &[u8; 4] = b"CYRC";
pub const VERSION: u8 = 1;
pub const CONTEXT: &[u8] = b"chatyy-region-cert/1";
pub const MAX_PINS: usize = 4;
pub const MAX_NC: usize = 1024;
/// Tolerância de relógio antes do notBefore (24 h).
pub const SKEW_S: i64 = 24 * 3600;

/// Resultado de um `nc` válido: chave estática Noise da região (`rs`) e os pins SPKI do chatyy/2.
pub type Verified = ([u8; 32], Vec<[u8; 32]>);

fn id_ok(s: &[u8]) -> bool {
    (1..=16).contains(&s.len()) && s.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn b64v(c: u8) -> Option<u32> {
    Some(match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'-' => 62,
        b'_' => 63,
        _ => return None,
    } as u32)
}

/// base64url SEM padding, estrito (ver cabeçalho). None = inválido.
pub fn b64url_decode_strict(s: &[u8]) -> Option<Vec<u8>> {
    if s.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for ch in s.chunks(4) {
        let mut n = 0u32;
        for &c in ch {
            n = (n << 6) | b64v(c)?;
        }
        match ch.len() {
            4 => out.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8, n as u8]),
            3 => {
                if n & 0x3 != 0 {
                    return None;
                }
                out.extend_from_slice(&[(n >> 10) as u8, (n >> 2) as u8]);
            }
            2 => {
                if n & 0xF != 0 {
                    return None;
                }
                out.push((n >> 4) as u8);
            }
            _ => return None,
        }
    }
    Some(out)
}

/// Campos do certificado (só formato, sem assinatura) — espelho do `ParseRegCert`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegCert {
    pub root_id: String,
    pub region: String,
    pub kid: String,
    pub noise_pub: [u8; 32],
    pub pins: Vec<[u8; 32]>,
    pub not_before: i64,
    pub not_after: i64,
}

pub fn parse(b: &[u8]) -> Result<RegCert, &'static str> {
    const BAD: &str = "regcert: formato";
    if b.len() < 5 || &b[..4] != MAGIC || b[4] != VERSION {
        return Err(BAD);
    }
    let mut p = 5usize;
    let mut s = || -> Option<String> {
        let n = *b.get(p)? as usize;
        p += 1;
        if n == 0 || p + n > b.len() {
            return None;
        }
        let v = &b[p..p + n];
        p += n;
        id_ok(v).then(|| String::from_utf8(v.to_vec()).ok()).flatten()
    };
    let root_id = s().ok_or(BAD)?;
    let region = s().ok_or(BAD)?;
    let kid = s().ok_or(BAD)?;
    if p + 33 > b.len() {
        return Err(BAD);
    }
    let noise_pub: [u8; 32] = b[p..p + 32].try_into().map_err(|_| BAD)?;
    p += 32;
    let n = b[p] as usize;
    p += 1;
    if !(1..=MAX_PINS).contains(&n) || p + 32 * n + 16 != b.len() {
        return Err(BAD);
    }
    let mut pins = Vec::with_capacity(n);
    for _ in 0..n {
        pins.push(b[p..p + 32].try_into().map_err(|_| BAD)?);
        p += 32;
    }
    // Go: time.Unix(int64(u64)) — mesma conversão (com sinal).
    let not_before = u64::from_be_bytes(b[p..p + 8].try_into().map_err(|_| BAD)?) as i64;
    let not_after = u64::from_be_bytes(b[p + 8..p + 16].try_into().map_err(|_| BAD)?) as i64;
    if not_after <= not_before {
        return Err(BAD);
    }
    Ok(RegCert { root_id, region, kid, noise_pub, pins, not_before, not_after })
}

/// Separa o `nc` em (certBytes, sig) — espelho do `SplitNC`.
pub fn split(nc: &str) -> Result<(Vec<u8>, Vec<u8>), &'static str> {
    let b = nc.as_bytes();
    let dots = b.iter().filter(|&&c| c == b'.').count();
    let i = b.iter().position(|&c| c == b'.').unwrap_or(0);
    if b.len() > MAX_NC || i == 0 || dots != 1 {
        return Err("nc: formato");
    }
    let cb = b64url_decode_strict(&b[..i]).ok_or("nc: base64")?;
    let sig = b64url_decode_strict(&b[i + 1..]).ok_or("nc: assinatura")?;
    if sig.len() != 64 {
        return Err("nc: assinatura");
    }
    Ok((cb, sig))
}

/// O que o cliente faz com o `nc` da região (PROTOCOLO §9.2). Função pura (relógio vem de fora).
/// `roots` = (rootId, chave pública Ed25519) do binário. `kid` vazio = não confere o kid (como o Go);
/// o gate do app sempre passa o `nk`.
pub fn verify_region_cert(
    nc: &str,
    roots: &[(String, [u8; 32])],
    region: &str,
    kid: &str,
    now_unix: i64,
) -> Result<Verified, &'static str> {
    let (cb, sig) = split(nc)?;
    let c = parse(&cb)?;
    let pk = roots.iter().find(|(id, _)| *id == c.root_id).map(|(_, k)| k).ok_or("regcert: raiz desconhecida")?;
    let mut msg = Vec::with_capacity(CONTEXT.len() + 1 + cb.len());
    msg.extend_from_slice(CONTEXT);
    msg.push(0);
    msg.extend_from_slice(&cb);
    UnparsedPublicKey::new(&ED25519, &pk[..]).verify(&msg, &sig).map_err(|_| "regcert: assinatura")?;
    if c.region != region {
        return Err("regcert: região");
    }
    if !kid.is_empty() && c.kid != kid {
        return Err("regcert: kid");
    }
    if now_unix < c.not_before.saturating_sub(SKEW_S) {
        return Err("regcert: ainda não vale");
    }
    if now_unix > c.not_after {
        return Err("regcert: vencido");
    }
    Ok((c.noise_pub, c.pins))
}

/// Raízes vindas do JNI: sequência de `u8 len | id ASCII | 32 B chave`. None = malformado.
pub fn decode_roots(b: &[u8]) -> Option<Vec<(String, [u8; 32])>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let n = b[i] as usize;
        i += 1;
        if out.len() >= 8 || b.len() < i + n + 32 || !id_ok(&b[i..i + n]) {
            return None;
        }
        let id = String::from_utf8(b[i..i + n].to_vec()).ok()?;
        i += n;
        out.push((id, b[i..i + 32].try_into().ok()?));
        i += 32;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64url_strict() {
        assert_eq!(b64url_decode_strict(b"").unwrap(), b"");
        assert_eq!(b64url_decode_strict(b"Zg").unwrap(), b"f");
        assert_eq!(b64url_decode_strict(b"Zm8").unwrap(), b"fo");
        assert_eq!(b64url_decode_strict(b"Zm9v").unwrap(), b"foo");
        assert_eq!(b64url_decode_strict(b"-_8").unwrap(), vec![0xfb, 0xff]);
        assert!(b64url_decode_strict(b"Zg==").is_none());
        assert!(b64url_decode_strict(b"Zh").is_none()); // bits de sobra ≠ 0
        assert!(b64url_decode_strict(b"Z").is_none());
        assert!(b64url_decode_strict(b"Zm9v\n").is_none());
        assert!(b64url_decode_strict(b"Zm+v").is_none());
    }

    #[test]
    fn roots_codec() {
        let mut b = vec![2u8, b'r', b'1'];
        b.extend_from_slice(&[7u8; 32]);
        assert_eq!(decode_roots(&b).unwrap(), vec![("r1".to_string(), [7u8; 32])]);
        assert!(decode_roots(&b[..10]).is_none());
        assert_eq!(decode_roots(&[]).unwrap(), vec![]);
        let mut bad = vec![2u8, b'R', b'1'];
        bad.extend_from_slice(&[7u8; 32]);
        assert!(decode_roots(&bad).is_none());
    }
}
