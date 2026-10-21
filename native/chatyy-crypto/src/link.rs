//! Vínculo de aparelho por QR (web/desktop/tablet), igual ao WhatsApp Web (CONTRATO §5 e §6.7).
//!
//! Canal: ECIES do vodozemac (X25519 + ChaCha20-Poly1305, o mesmo do login por QR do Matrix,
//! MSC4108) com info própria `CHATYY_LINK_V1`, sobre o rendezvous `e2ee5_link_*` do servidor
//! (que só vê bytes cifrados). O QR carrega a chave pública efêmera da web + um segredo de
//! 32 B: só quem LEU o QR consegue abrir o canal (o servidor não injeta um "celular" falso).
//!
//! Sequência (W = web, P = celular):
//!   W: link_begin → QR `chatyy-link:1:<link_id>:<pk>:<secret>`
//!   P: link_accept(QR) → 1ª msg {t:hello, secret, uid, msk}           (check_code nos dois)
//!   W: poll → Hello{uid}; host abre o CryptoCore(uid, device novo); send_device
//!   W → P {t:device, device_id, ed25519, curve25519}
//!   P: e2ee5_link_finish(device_id) → bearer vinculado ao aparelho; P → W {t:grant, bearer, msk}
//!   W: host instala o bearer; complete_upload (publica as chaves do aparelho); W → P {t:uploaded}
//!   P: sign_device(device_id, ed25519 do canal) — recusa se o servidor mostrar outra chave
//!   P → W {t:keys, i, n, keys:[…]} … {t:done}
//!   W: importa, confia na MSK recebida pelo canal; W → P {t:ok}
use crate::core::{CryptoCore, ExportFilter};
use crate::error::{CoreError, CoreResult};
use crate::transport::{actions, call_json, HttpTransport};
use crate::util::{b64url, fill_random, unb64url};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;
use vodozemac::ecies::{Ecies, EstablishedEcies, InitialMessage, Message};
use vodozemac::Curve25519PublicKey;

pub const LINK_INFO: &str = "CHATYY_LINK_V1";
const QR_PREFIX: &str = "chatyy-link:1";
/// Chaves por bloco no export (≈ 1 KB por chave).
const KEYS_PER_CHUNK: usize = 200;

fn lerr(m: impl std::fmt::Display) -> CoreError {
    CoreError::Link { msg: m.to_string() }
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum LinkWebState {
    /// Esperando o celular ler o QR.
    Waiting,
    /// Celular conectou. Host: abrir CryptoCore(uid, device novo) e chamar `send_device`.
    Hello { uid: String, check_code: u8 },
    /// Celular emitiu o bearer deste aparelho. Host: instalar no transporte e chamar `complete_upload`.
    Granted { bearer: String },
    /// Recebendo chaves (progresso).
    Importing { received_chunks: u32, total_chunks: u32 },
    /// Pronto: aparelho vinculado e histórico importado.
    Done { imported: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum LinkPhoneState {
    WaitingDevice,
    WaitingUpload { device_id: String },
    /// Assinou o aparelho e mandou as chaves; esperando a confirmação.
    Sent { device_id: String, chunks: u32 },
    Done { device_id: String },
}

struct Chan {
    ecies: Option<EstablishedEcies>,
    /// Web: o Ecies não estabelecido (até a 1ª msg).
    pending: Option<Ecies>,
    read_after: u64,
    write_seq: u64,
}

async fn post(t: &dyn HttpTransport, link_id: &str, side: &str, seq: u64, data: String) -> CoreResult<()> {
    call_json(t, actions::LINK_POST, &json!({"link_id": link_id, "side": side, "seq": seq, "data": data})).await?;
    Ok(())
}

async fn poll_msgs(t: &dyn HttpTransport, link_id: &str, from_side: &str, after: u64) -> CoreResult<Vec<(u64, String)>> {
    let d = call_json(t, actions::LINK_POLL, &json!({"link_id": link_id, "side": from_side, "after": after})).await?;
    let mut v: Vec<(u64, String)> = d
        .get("msgs")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|m| Some((m.get("seq")?.as_u64()?, m.get("data")?.as_str()?.to_string()))).collect())
        .unwrap_or_default();
    v.sort_by_key(|x| x.0);
    Ok(v)
}

fn send_enc(ch: &mut Chan, v: &Value) -> CoreResult<(u64, String)> {
    let e = ch.ecies.as_mut().ok_or_else(|| lerr("canal não estabelecido"))?;
    let m = e.encrypt(v.to_string().as_bytes());
    ch.write_seq += 1;
    Ok((ch.write_seq, m.encode()))
}

fn open_enc(ch: &mut Chan, data: &str) -> CoreResult<Value> {
    let e = ch.ecies.as_mut().ok_or_else(|| lerr("canal não estabelecido"))?;
    let m = Message::decode(data).map_err(|_| lerr("mensagem inválida"))?;
    let p = e.decrypt(&m).map_err(|_| lerr("mensagem adulterada"))?;
    serde_json::from_slice(&p).map_err(|_| lerr("json inválido"))
}

/// Lado WEB do vínculo. Não precisa de CryptoCore até saber o uid (Hello).
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct LinkWeb {
    transport: Arc<dyn HttpTransport>,
    link_id: String,
    secret: [u8; 32],
    qr: String,
    inner: Mutex<(Chan, Option<Value>, LinkWebState, Vec<Value>)>,
}

#[cfg_attr(feature = "uniffi", uniffi::export(async_runtime = "tokio"))]
impl LinkWeb {
    /// Cria o rendezvous e o QR. TTL do servidor: 2 min (renovar = novo `link_begin`).
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub async fn begin(transport: Arc<dyn HttpTransport>) -> CoreResult<Arc<LinkWeb>> {
        let d = call_json(transport.as_ref(), actions::LINK_CREATE, &json!({})).await?;
        let link_id = d.get("link_id").and_then(Value::as_str).ok_or_else(|| lerr("sem link_id"))?.to_string();
        let ecies = Ecies::with_info(LINK_INFO);
        let mut secret = [0u8; 32];
        fill_random(&mut secret)?;
        let qr = format!("{QR_PREFIX}:{link_id}:{}:{}", b64url(ecies.public_key().as_bytes()), b64url(&secret));
        Ok(Arc::new(LinkWeb {
            transport,
            link_id,
            secret,
            qr,
            inner: Mutex::new((Chan { ecies: None, pending: Some(ecies), read_after: 0, write_seq: 0 }, None, LinkWebState::Waiting, vec![])),
        }))
    }

    pub fn qr_payload(&self) -> String {
        self.qr.clone()
    }
    pub fn link_id(&self) -> String {
        self.link_id.clone()
    }

    /// Uma rodada de leitura do rendezvous. `core` é obrigatório depois do `Hello`.
    pub async fn poll(&self, core: Option<Arc<CryptoCore>>) -> CoreResult<LinkWebState> {
        let mut g = self.inner.lock().await;
        let (ch, hello, state, chunks) = &mut *g;
        let msgs = poll_msgs(self.transport.as_ref(), &self.link_id, "p", ch.read_after).await?;
        for (seq, data) in msgs {
            ch.read_after = seq;
            if ch.ecies.is_none() {
                let ini = InitialMessage::decode(&data).map_err(|_| lerr("1ª mensagem inválida"))?;
                let pending = ch.pending.take().ok_or_else(|| lerr("estado"))?;
                let r = pending.establish_inbound_channel(&ini).map_err(|_| lerr("canal: falha ao abrir (QR errado?)"))?;
                let v: Value = serde_json::from_slice(&r.message).map_err(|_| lerr("hello inválido"))?;
                let sec = v.get("secret").and_then(Value::as_str).and_then(unb64url).unwrap_or_default();
                if v.get("t").and_then(Value::as_str) != Some("hello") || !ct_eq(&sec, &self.secret) {
                    return Err(lerr("segredo do QR não confere"));
                }
                let uid = v.get("uid").and_then(Value::as_str).unwrap_or("").to_string();
                crate::ids::user_id_for_uid(&uid)?;
                *state = LinkWebState::Hello { uid, check_code: r.ecies.check_code().to_digit() };
                ch.ecies = Some(r.ecies);
                *hello = Some(v);
                continue;
            }
            let v = open_enc(ch, &data)?;
            match v.get("t").and_then(Value::as_str).unwrap_or("") {
                "grant" => {
                    let bearer = v.get("bearer").and_then(Value::as_str).unwrap_or("").to_string();
                    if let Some(h) = hello.as_mut() {
                        h["msk_grant"] = v.get("msk").cloned().unwrap_or(Value::Null);
                    }
                    *state = LinkWebState::Granted { bearer };
                }
                "keys" => {
                    let n = v.get("n").and_then(Value::as_u64).unwrap_or(0) as u32;
                    chunks.push(v);
                    *state = LinkWebState::Importing { received_chunks: chunks.len() as u32, total_chunks: n };
                }
                "done" => {
                    let core = core.clone().ok_or_else(|| lerr("core necessário"))?;
                    let msk = hello
                        .as_ref()
                        .and_then(|h| h.get("msk").and_then(Value::as_str))
                        .unwrap_or("")
                        .to_string();
                    let msk_grant = hello.as_ref().and_then(|h| h.get("msk_grant").and_then(Value::as_str)).unwrap_or("");
                    if msk.is_empty() || msk != msk_grant {
                        return Err(lerr("msk divergente no canal"));
                    }
                    core.trust_own_identity(&msk).await?;
                    let mut imported = 0;
                    for c in chunks.drain(..) {
                        let keys: Vec<matrix_sdk_crypto::olm::ExportedRoomKey> =
                            serde_json::from_value(c.get("keys").cloned().unwrap_or(json!([]))).map_err(|_| lerr("bloco de chaves inválido"))?;
                        imported += core.import_keys_vec(keys, None).await?.imported;
                    }
                    let (s, d) = send_enc(ch, &json!({"t": "ok", "imported": imported}))?;
                    post(self.transport.as_ref(), &self.link_id, "w", s, d).await?;
                    *state = LinkWebState::Done { imported };
                }
                _ => {}
            }
        }
        Ok(state.clone())
    }

    /// Depois do `Hello`: manda as chaves públicas do aparelho novo pelo canal.
    pub async fn send_device(&self, core: Arc<CryptoCore>) -> CoreResult<()> {
        let mut g = self.inner.lock().await;
        let (ch, hello, _, _) = &mut *g;
        let uid = hello.as_ref().and_then(|h| h.get("uid").and_then(Value::as_str)).unwrap_or("");
        if uid != core.uid() {
            return Err(lerr("core aberto com outro uid"));
        }
        let d = core.this_device().await?;
        let (s, data) = send_enc(ch, &json!({"t": "device", "device_id": d.device_id, "ed25519": d.ed25519, "curve25519": d.curve25519}))?;
        post(self.transport.as_ref(), &self.link_id, "w", s, data).await
    }

    /// Depois do `Granted` (bearer instalado no transporte do core): publica as chaves do aparelho.
    pub async fn complete_upload(&self, core: Arc<CryptoCore>) -> CoreResult<()> {
        core.sync().await?;
        let mut g = self.inner.lock().await;
        let (ch, _, _, _) = &mut *g;
        let (s, data) = send_enc(ch, &json!({"t": "uploaded"}))?;
        post(self.transport.as_ref(), &self.link_id, "w", s, data).await
    }
}

/// Lado CELULAR (principal) do vínculo.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct LinkPhone {
    core: Arc<CryptoCore>,
    link_id: String,
    filter: ExportFilter,
    check_code: u8,
    inner: Mutex<(Chan, Option<(String, String)>, LinkPhoneState)>,
}

#[cfg_attr(feature = "uniffi", uniffi::export(async_runtime = "tokio"))]
impl LinkPhone {
    /// Lê o QR e abre o canal. Mostra `check_code()` se o QR foi lido de longe (opcional).
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub async fn accept(core: Arc<CryptoCore>, qr_payload: String, filter: ExportFilter) -> CoreResult<Arc<LinkPhone>> {
        let parts: Vec<&str> = qr_payload.trim().split(':').collect();
        if parts.len() != 5 || format!("{}:{}", parts[0], parts[1]) != QR_PREFIX {
            return Err(lerr("QR não é do Chatyy"));
        }
        let link_id = parts[2].to_string();
        let pk = unb64url(parts[3]).and_then(|b| Curve25519PublicKey::from_slice(&b).ok()).ok_or_else(|| lerr("chave do QR inválida"))?;
        let secret = unb64url(parts[4]).filter(|s| s.len() == 32).ok_or_else(|| lerr("segredo do QR inválido"))?;
        let st = core.identity_status(core.uid()).await?;
        if !st.is_primary {
            return Err(CoreError::Identity { msg: "not_primary".into() });
        }
        let hello = json!({"t": "hello", "v": 1, "secret": b64url(&secret), "uid": core.uid(), "msk": st.master_key});
        let r = Ecies::with_info(LINK_INFO)
            .establish_outbound_channel(pk, hello.to_string().as_bytes())
            .map_err(|_| lerr("chave do QR inválida"))?;
        let check_code = r.ecies.check_code().to_digit();
        post(core.transport.as_ref(), &link_id, "p", 1, r.message.encode()).await?;
        Ok(Arc::new(LinkPhone {
            core,
            link_id,
            filter,
            check_code,
            inner: Mutex::new((Chan { ecies: Some(r.ecies), pending: None, read_after: 0, write_seq: 1 }, None, LinkPhoneState::WaitingDevice)),
        }))
    }

    pub fn check_code(&self) -> u8 {
        self.check_code
    }

    pub async fn poll(&self) -> CoreResult<LinkPhoneState> {
        let mut g = self.inner.lock().await;
        let (ch, dev, state) = &mut *g;
        let t = self.core.transport.clone();
        let msgs = poll_msgs(t.as_ref(), &self.link_id, "w", ch.read_after).await?;
        for (seq, data) in msgs {
            ch.read_after = seq;
            let v = open_enc(ch, &data)?;
            match v.get("t").and_then(Value::as_str).unwrap_or("") {
                "device" => {
                    let device_id = v.get("device_id").and_then(Value::as_str).unwrap_or("").to_string();
                    let ed = v.get("ed25519").and_then(Value::as_str).unwrap_or("").to_string();
                    crate::ids::validate_device_id(&device_id)?;
                    let d = call_json(t.as_ref(), actions::LINK_FINISH, &json!({"link_id": self.link_id, "device_id": device_id})).await?;
                    let bearer = d.get("bearer").and_then(Value::as_str).ok_or_else(|| lerr("servidor não emitiu bearer"))?.to_string();
                    let msk = self.core.identity_status(self.core.uid()).await?.master_key;
                    let (s, data) = send_enc(ch, &json!({"t": "grant", "bearer": bearer, "msk": msk}))?;
                    post(t.as_ref(), &self.link_id, "p", s, data).await?;
                    *dev = Some((device_id.clone(), ed));
                    *state = LinkPhoneState::WaitingUpload { device_id };
                }
                "uploaded" => {
                    let (device_id, ed) = dev.clone().ok_or_else(|| lerr("estado"))?;
                    self.core.sign_device(device_id.clone(), ed).await?;
                    let blob = self.core.export_room_keys(self.filter.clone()).await?;
                    let keys: Vec<Value> = serde_json::from_slice(&blob)?;
                    let n = keys.len().div_ceil(KEYS_PER_CHUNK).max(1);
                    let mut chunks = 0u32;
                    for (i, c) in keys.chunks(KEYS_PER_CHUNK).enumerate() {
                        let (s, data) = send_enc(ch, &json!({"t": "keys", "i": i, "n": n, "keys": c}))?;
                        post(t.as_ref(), &self.link_id, "p", s, data).await?;
                        chunks += 1;
                    }
                    let (s, data) = send_enc(ch, &json!({"t": "done"}))?;
                    post(t.as_ref(), &self.link_id, "p", s, data).await?;
                    *state = LinkPhoneState::Sent { device_id, chunks };
                }
                "ok" => {
                    if let Some((d, _)) = dev.clone() {
                        *state = LinkPhoneState::Done { device_id: d };
                    }
                }
                _ => {}
            }
        }
        Ok(state.clone())
    }
}
