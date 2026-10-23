//! Formato no fio do `chatyy/1` (lado cliente). TUDO o que precisa bater com o leaf (Go) mora AQUI.
//! Contrato: /root/quic-noise-2026-10-23/PROTOCOLO.md (versão 1-proto). Resumo:
//!
//! ```text
//! QUIC v1, ALPN "chatyy/1", 1 stream bidirecional aberto pelo cliente (stream 0).
//!   preâmbulo (§2):   "CY" | 0x01 | modo ('I' = Noise IK amarrado ao QUIC-TLS)
//!   handshake (§4.3): u16be(len) || msg1 (cliente)  ·  u16be(len) || msg2 (servidor)
//!   canal (§4.4):     u16be(len) || ciphertext   (≤ 65535; plaintext ≤ 65519; AD vazio)
//!   plaintext = fluxo contínuo de frames (§3): varint_quic(len(corpo)) || tipo(1 B) || corpo
//!       tipo: 0x01 text · 0x02 binary · 0x08 close (u16be código || motivo) · 0x09 ping · 0x0A pong
//! prólogo (§4.2) = "chatyy/1" 0x00 | região 0x00 | kid 0x00 | fio('q') | modo('I') | exporter(32)
//! exporter = TLS 1.3, label "EXPORTER-chatyy-noise-v1", contexto vazio, 32 B
//! msg1 payload = {"v":1,"dev":..,"ts":<unix ms>,"n":<16 B b64>,"ua":..}   (n único por tentativa)
//! ```
//!
//! Se o PROTOCOLO.md mudar, mude só este arquivo (e o teste `tests/loopback.rs`).

pub const ALPN: &[u8] = b"chatyy/1";
/// chatyy/2 (PROTOCOLO §0): TLS só por pin SPKI + msg1 IK no flight do Finished com os frames dentro.
pub const ALPN2: &[u8] = b"chatyy/2";
pub const MODE_E: u8 = b'E';
/// §0.3: até 64 frames dentro da msg1; payload da msg1 ≤ 60 KiB.
pub const MSG1_MAX_FRAMES: usize = 64;
pub const MSG1_MAX_PAYLOAD: usize = 60 * 1024;

pub fn alpn(version: u8) -> &'static [u8] {
    if version == 2 { ALPN2 } else { ALPN }
}

/// Preâmbulo "CY" | versão | modo.
pub fn preamble(version: u8, mode: u8) -> [u8; 4] {
    [b'C', b'Y', version, mode]
}
pub const NOISE_PARAMS: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";
/// Rótulo do exportador TLS (RFC 8446 §7.5) que amarra o Noise à conexão QUIC (§4.2).
pub const EXPORTER_LABEL: &[u8] = b"EXPORTER-chatyy-noise-v1";
pub const EXPORTER_CONTEXT: &[u8] = b"";
pub const EXPORTER_LEN: usize = 32;
/// Preâmbulo do stream, modo I (§2).
pub const PREAMBLE_I: &[u8; 4] = b"CY\x01I";
pub const WIRE_QUIC: u8 = b'q';
pub const MODE_I: u8 = b'I';

pub const OP_TEXT: u8 = 0x1;
pub const OP_BINARY: u8 = 0x2;
pub const OP_CLOSE: u8 = 0x8;
pub const OP_PING: u8 = 0x9;
pub const OP_PONG: u8 = 0xA;

/// Corpo máximo (§3: 1 MiB = ReadLimit do WS; maior → close 1009).
pub const MAX_FRAME: usize = 1 << 20;
/// Registro Noise: 65535 B no máximo, 16 B de tag.
pub const NOISE_MAX_MSG: usize = 65535;
pub const NOISE_TAG: usize = 16;
pub const NOISE_MAX_PLAIN: usize = NOISE_MAX_MSG - NOISE_TAG;

/// Close de app 4001 `go_ws` (§6): use WSS nesta região, lembrar 1 h.
pub const CLOSE_GO_WS: u16 = 4001;
pub const REASON_GO_WS: &str = "go_ws";

/// Prólogo §4.2 (modo I em QUIC, chatyy/1).
pub fn prologue(region: &str, kid: &str, exporter: &[u8]) -> Vec<u8> {
    prologue_v(1, MODE_I, region, kid, exporter)
}

/// Prólogo §4.2 / §0.3: "chatyy/<v>" 0 | região 0 | kid 0 | 'q' | modo | binding (vazio no modo E).
pub fn prologue_v(version: u8, mode: u8, region: &str, kid: &str, binding: &[u8]) -> Vec<u8> {
    let a = alpn(version);
    let mut p = Vec::with_capacity(a.len() + region.len() + kid.len() + 5 + binding.len());
    p.extend_from_slice(a);
    p.push(0);
    p.extend_from_slice(region.as_bytes());
    p.push(0);
    p.extend_from_slice(kid.as_bytes());
    p.push(0);
    p.push(WIRE_QUIC);
    p.push(mode);
    p.extend_from_slice(binding);
    p
}

fn json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut o = String::with_capacity((data.len() + 2) / 3 * 4);
    for ch in data.chunks(3) {
        let b = [ch[0], *ch.get(1).unwrap_or(&0), *ch.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        o.push(T[(n >> 18) as usize & 63] as char);
        o.push(T[(n >> 12) as usize & 63] as char);
        o.push(if ch.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        o.push(if ch.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    o
}

/// Payload da msg1 (§4.3). `n` = 16 B aleatórios NOVOS a cada tentativa. Sem `early` (0-RTT = F-N1).
pub fn msg1_payload(dev: &str, ua: &str, ts_ms: u64, n: &[u8; 16]) -> Vec<u8> {
    msg1_payload_x(1, dev, ua, ts_ms, n, None, &[])
}

/// Payload genérico: v=1 (chatyy/1 e retomada 'E', lista `early`) ou v=2 (chatyy/2 'I', lista `frames`).
/// `list` = nome da lista ("early" | "frames") ou None.
pub fn msg1_payload_x(v: u8, dev: &str, ua: &str, ts_ms: u64, n: &[u8; 16], list: Option<&str>, frames: &[String]) -> Vec<u8> {
    let mut s = format!("{{\"v\":{v},\"dev\":");
    json_str(&mut s, dev);
    s.push_str(&format!(",\"ts\":{ts_ms},\"n\":\"{}\",\"ua\":", b64(n)));
    json_str(&mut s, ua);
    if let (Some(name), false) = (list, frames.is_empty()) {
        s.push_str(&format!(",\"{name}\":["));
        for (i, f) in frames.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            json_str(&mut s, f);
        }
        s.push(']');
    }
    s.push('}');
    s.into_bytes()
}

/// Quantos frames do prefixo cabem na msg1 (≤ 64 e payload ≤ 60 KiB).
pub fn msg1_fit(frames: &[String]) -> usize {
    let mut total = 200usize;
    for (i, f) in frames.iter().enumerate() {
        total += f.len() + f.len() / 8 + 4; // folga p/ escapes
        if i >= MSG1_MAX_FRAMES || total > MSG1_MAX_PAYLOAD {
            return i;
        }
    }
    frames.len()
}

/// `early_n` do Accept (msg2). Ausente = 0.
pub fn accept_early_n(msg2: &[u8]) -> usize {
    let s = String::from_utf8_lossy(msg2);
    let Some(i) = s.find("\"early_n\":") else { return 0 };
    s[i + 10..].trim_start().chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0)
}

/// varint do QUIC (RFC 9000 §16).
pub fn put_varint(out: &mut Vec<u8>, v: u64) {
    if v < 1 << 6 {
        out.push(v as u8);
    } else if v < 1 << 14 {
        out.extend_from_slice(&((v as u16) | 0x4000).to_be_bytes());
    } else if v < 1 << 30 {
        out.extend_from_slice(&((v as u32) | 0x8000_0000).to_be_bytes());
    } else {
        out.extend_from_slice(&(v | 0xC000_0000_0000_0000).to_be_bytes());
    }
}

/// (valor, bytes usados) ou None se faltam bytes.
pub fn get_varint(b: &[u8]) -> Option<(u64, usize)> {
    let first = *b.first()?;
    let n = 1usize << (first >> 6);
    if b.len() < n {
        return None;
    }
    let mut v = (first & 0x3F) as u64;
    for x in &b[1..n] {
        v = (v << 8) | *x as u64;
    }
    Some((v, n))
}

pub fn encode_frame(op: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 9);
    put_varint(&mut out, body.len() as u64);
    out.push(op);
    out.extend_from_slice(body);
    out
}

pub fn encode_close(code: u16, reason: &str) -> Vec<u8> {
    let r = reason.as_bytes();
    let r = &r[..r.len().min(123)];
    let mut body = Vec::with_capacity(2 + r.len());
    body.extend_from_slice(&code.to_be_bytes());
    body.extend_from_slice(r);
    encode_frame(OP_CLOSE, &body)
}

pub fn decode_close(body: &[u8]) -> (u16, String) {
    if body.len() < 2 {
        return (1005, String::new());
    }
    (u16::from_be_bytes([body[0], body[1]]), String::from_utf8_lossy(&body[2..]).into_owned())
}

#[derive(Debug)]
pub struct ProtoError(pub &'static str);

/// Remonta quadros de app a partir do texto claro dos registros Noise.
#[derive(Default)]
pub struct FrameParser {
    buf: Vec<u8>,
    pos: usize,
}

impl FrameParser {
    pub fn push(&mut self, data: &[u8]) {
        if self.pos > 0 && self.pos == self.buf.len() {
            self.buf.clear();
            self.pos = 0;
        } else if self.pos > 64 * 1024 {
            self.buf.drain(..self.pos);
            self.pos = 0;
        }
        self.buf.extend_from_slice(data);
    }

    pub fn next(&mut self) -> Result<Option<(u8, Vec<u8>)>, ProtoError> {
        let rest = &self.buf[self.pos..];
        let Some((len, n)) = get_varint(rest) else { return Ok(None) };
        if len as usize > MAX_FRAME {
            return Err(ProtoError("frame_too_big"));
        }
        let len = len as usize;
        if rest.len() < n + 1 + len {
            return Ok(None);
        }
        let op = rest[n];
        let body = rest[n + 1..n + 1 + len].to_vec();
        self.pos += n + 1 + len;
        Ok(Some((op, body)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_roundtrip() {
        for v in [0u64, 1, 63, 64, 16383, 16384, (1 << 30) - 1, 1 << 30, 1 << 40] {
            let mut b = Vec::new();
            put_varint(&mut b, v);
            assert_eq!(get_varint(&b), Some((v, b.len())));
            assert_eq!(get_varint(&b[..b.len() - 1]), None);
        }
        // vetores do RFC 9000 §A.1
        assert_eq!(get_varint(&[0x25]), Some((37, 1)));
        assert_eq!(get_varint(&[0x7b, 0xbd]), Some((15293, 2)));
        assert_eq!(get_varint(&[0x9d, 0x7f, 0x3e, 0x7d]), Some((494878333, 4)));
    }

    #[test]
    fn parser_split_and_join() {
        let mut all = encode_frame(OP_TEXT, b"{\"type\":\"ping\"}");
        all.extend(encode_frame(OP_BINARY, &vec![7u8; 70_000]));
        all.extend(encode_close(4002, "session_replaced"));
        let mut p = FrameParser::default();
        let mut got = Vec::new();
        for ch in all.chunks(997) {
            p.push(ch);
            while let Some(f) = p.next().unwrap() {
                got.push(f);
            }
        }
        assert_eq!(got.len(), 3);
        assert_eq!(got[0], (OP_TEXT, b"{\"type\":\"ping\"}".to_vec()));
        assert_eq!(got[1].1.len(), 70_000);
        assert_eq!(decode_close(&got[2].1), (4002, "session_replaced".into()));
    }

    #[test]
    fn prologue_and_payload() {
        let p = prologue("mex", "t1", &[0xAB; 32]);
        let mut want = b"chatyy/1\0mex\0t1\0qI".to_vec();
        want.extend_from_slice(&[0xAB; 32]);
        assert_eq!(p, want);
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foo"), "Zm9v");
        let m = String::from_utf8(msg1_payload("d\"1", "Chatyy/a", 1700000000000, &[0u8; 16])).unwrap();
        assert_eq!(m, r#"{"v":1,"dev":"d\"1","ts":1700000000000,"n":"AAAAAAAAAAAAAAAAAAAAAA==","ua":"Chatyy/a"}"#);
    }

    #[test]
    fn v2_bits() {
        let p = prologue_v(2, MODE_I, "us2", "t1", &[1; 32]);
        assert!(p.starts_with(b"chatyy/2\0us2\0t1\0qI"));
        assert_eq!(prologue_v(2, MODE_E, "us2", "t1", &[]), b"chatyy/2\0us2\0t1\0qE".to_vec());
        assert_eq!(&preamble(2, MODE_I), b"CY\x02I");
        let f = vec![r#"{"type":"auth","token":"a\"b"}"#.to_string()];
        let m = String::from_utf8(msg1_payload_x(2, "d", "u", 1, &[0; 16], Some("frames"), &f)).unwrap();
        assert_eq!(m, r#"{"v":2,"dev":"d","ts":1,"n":"AAAAAAAAAAAAAAAAAAAAAA==","ua":"u","frames":["{\"type\":\"auth\",\"token\":\"a\\\"b\"}"]}"#);
        assert_eq!(accept_early_n(br#"{"v":2,"ok":true,"early_n":3,"x":1}"#), 3);
        assert_eq!(accept_early_n(br#"{"v":2}"#), 0);
        let many: Vec<String> = (0..100).map(|_| "x".repeat(10)).collect();
        assert_eq!(msg1_fit(&many), 64);
        let big = vec!["y".repeat(40_000), "y".repeat(40_000)];
        assert_eq!(msg1_fit(&big), 1);
    }

    #[test]
    fn parser_rejects_huge() {
        let mut b = Vec::new();
        put_varint(&mut b, (MAX_FRAME + 1) as u64);
        b.push(OP_TEXT);
        let mut p = FrameParser::default();
        p.push(&b);
        assert!(p.next().is_err());
    }
}
