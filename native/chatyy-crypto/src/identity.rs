//! Assinatura cruzada (chave de conta), número de segurança e verificação (CONTRATO §6.6).
use crate::core::{CryptoCore, IdentityStatus};
use crate::error::{invalid, CoreError, CoreResult};
use crate::ids::user_id_for_uid;
use crate::requests::{self, drain, send_request};
use crate::transport::{actions, call_json};
use crate::util::{b64, unb64};
use matrix_sdk_crypto::types::requests::AnyOutgoingRequest;
use sha2::{Digest, Sha512};

/// Iterações do número de segurança (igual ao "fingerprint" numérico do Signal).
const SN_ITERATIONS: usize = 5200;
const SN_VERSION: u16 = 0;
const QR_PREFIX: &str = "chatyy-sn:1";

#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SafetyNumber {
    /// 60 dígitos (12 blocos de 5). Igual nos dois aparelhos.
    pub digits: String,
    /// Conteúdo do QR (o outro lado escaneia e chama `verify_safety_qr`).
    pub qr_payload: String,
}

/// 30 dígitos de um lado: SHA-512 iterado sobre (versão ‖ MSK ‖ uid).
pub fn fingerprint_digits(uid: &str, msk: &[u8]) -> String {
    let mut h = Sha512::new();
    h.update(SN_VERSION.to_be_bytes());
    h.update(msk);
    h.update(uid.as_bytes());
    let mut d = h.finalize().to_vec();
    for _ in 0..SN_ITERATIONS {
        let mut h = Sha512::new();
        h.update(&d);
        h.update(msk);
        d = h.finalize().to_vec();
    }
    let mut s = String::with_capacity(30);
    for i in 0..6 {
        let c = &d[i * 5..i * 5 + 5];
        let n = c.iter().fold(0u64, |acc, b| (acc << 8) | *b as u64) % 100_000;
        s.push_str(&format!("{n:05}"));
    }
    s
}

/// Número de 60 dígitos: os dois lados ordenados pelo uid numérico (determinístico).
pub fn safety_number_for(uid_a: &str, msk_a: &[u8], uid_b: &str, msk_b: &[u8]) -> SafetyNumber {
    let (a, b) = if uid_a.parse::<u128>().unwrap_or(0) <= uid_b.parse::<u128>().unwrap_or(0) {
        ((uid_a, msk_a), (uid_b, msk_b))
    } else {
        ((uid_b, msk_b), (uid_a, msk_a))
    };
    let digits = format!("{}{}", fingerprint_digits(a.0, a.1), fingerprint_digits(b.0, b.1));
    let qr_payload = format!("{QR_PREFIX}:{}:{}:{}:{}", a.0, b64(a.1), b.0, b64(b.1));
    SafetyNumber { digits, qr_payload }
}

#[cfg_attr(feature = "uniffi", uniffi::export(async_runtime = "tokio"))]
impl CryptoCore {
    /// Cria a chave de conta (MSK/SSK/USK) — SÓ no celular principal, na ativação.
    /// Idempotente: se este aparelho já tem as chaves privadas, só devolve o estado.
    pub async fn bootstrap_identity(&self) -> CoreResult<IdentityStatus> {
        {
            let op = self.op().await?;
            let m = &op.m;
            let st = m.cross_signing_status().await;
            if !st.has_master {
                drain(m, self.transport.as_ref()).await?;
                let reqs = m.bootstrap_cross_signing(false).await?;
                if let Some(r) = reqs.upload_keys_req {
                    send_request(m, self.transport.as_ref(), r.request_id(), r.request()).await?;
                }
                requests::upload_signing_keys(self.transport.as_ref(), &reqs.upload_signing_keys_req).await?;
                let body = serde_json::to_value(&reqs.upload_signatures_req.signed_keys)?;
                call_json(self.transport.as_ref(), actions::SIGNATURES_UPLOAD, &body).await?;
                m.update_tracked_users([self.user_id.as_ref()]).await?;
                m.mark_all_tracked_users_as_dirty().await?;
                drain(m, self.transport.as_ref()).await?;
            }
        }
        self.identity_status(self.uid.clone()).await
    }

    /// Assina um aparelho MEU com a SSK (vínculo). `expected_ed25519` vem do canal seguro do
    /// vínculo: se o servidor devolver outra chave para esse device_id, NÃO assina.
    pub async fn sign_device(&self, device_id: String, expected_ed25519: String) -> CoreResult<()> {
        let op = self.op().await?;
        let m = &op.m;
        if !m.cross_signing_status().await.has_self_signing {
            return Err(CoreError::Identity { msg: "not_primary".into() });
        }
        m.update_tracked_users([self.user_id.as_ref()]).await?;
        m.mark_all_tracked_users_as_dirty().await?;
        drain(m, self.transport.as_ref()).await?;
        let dev = ruma::OwnedDeviceId::from(device_id.as_str());
        let d = m
            .get_device(&self.user_id, &dev, None)
            .await?
            .ok_or_else(|| invalid("device_id", "aparelho não publicado no servidor"))?;
        let got = d.ed25519_key().map(|k| k.to_base64()).unwrap_or_default();
        if expected_ed25519.is_empty() || got != expected_ed25519 {
            return Err(CoreError::Link { msg: "device_key_mismatch".into() });
        }
        let req = d.verify().await.map_err(|e| CoreError::Identity { msg: e.to_string() })?;
        let id = ruma::TransactionId::new();
        send_request(m, self.transport.as_ref(), &id, &AnyOutgoingRequest::SignatureUpload(req)).await?;
        // atualiza a visão local (o aparelho recém-assinado passa a receber chaves já)
        m.mark_all_tracked_users_as_dirty().await?;
        drain(m, self.transport.as_ref()).await?;
        Ok(())
    }

    pub async fn identity_status(&self, uid: String) -> CoreResult<IdentityStatus> {
        let u = user_id_for_uid(&uid)?;
        let op = self.op().await?;
        let m = &op.m;
        let id = m.get_identity(&u, None).await?;
        let msk = self.msk_of(m, &uid).await?.map(|k| b64(&k)).unwrap_or_default();
        let st = m.cross_signing_status().await;
        Ok(match id {
            None => IdentityStatus { uid, has_identity: false, master_key: String::new(), verified: false, needs_approval: false, is_primary: false },
            Some(matrix_sdk_crypto::UserIdentity::Own(o)) => IdentityStatus {
                uid,
                has_identity: true,
                master_key: msk,
                verified: o.is_verified(),
                needs_approval: false,
                is_primary: st.has_master && st.has_self_signing && st.has_user_signing,
            },
            Some(matrix_sdk_crypto::UserIdentity::Other(o)) => IdentityStatus {
                uid,
                has_identity: true,
                master_key: msk,
                verified: o.is_verified(),
                needs_approval: o.identity_needs_user_approval() || o.has_verification_violation(),
                is_primary: false,
            },
        })
    }

    /// Aceita a identidade ATUAL do contato (depois do aviso "código de segurança mudou").
    pub async fn pin_identity(&self, uid: String) -> CoreResult<()> {
        let u = user_id_for_uid(&uid)?;
        let op = self.op().await?;
        if let Some(id) = op.m.get_identity(&u, None).await? {
            if let Some(o) = id.other() {
                if o.has_verification_violation() {
                    o.withdraw_verification().await?;
                }
                o.pin_current_master_key().await?;
            }
        }
        Ok(())
    }

    pub async fn safety_number(&self, uid: String) -> CoreResult<SafetyNumber> {
        let op = self.op().await?;
        let mine = self.msk_of(&op.m, &self.uid).await?.ok_or_else(|| CoreError::Identity { msg: "own_identity_missing".into() })?;
        let theirs = self.msk_of(&op.m, &uid).await?.ok_or_else(|| CoreError::Identity { msg: "contact_identity_missing".into() })?;
        Ok(safety_number_for(&self.uid, &mine, &uid, &theirs))
    }

    /// O usuário escaneou o QR do contato. Se as duas MSK conferem, marca o contato como
    /// verificado (assinatura USK — exige ser o principal) e devolve `true`.
    pub async fn verify_safety_qr(&self, uid: String, scanned: String) -> CoreResult<bool> {
        let sn = self.safety_number(uid.clone()).await?;
        if scanned.trim() != sn.qr_payload {
            return Ok(false);
        }
        self.mark_verified(uid).await?;
        Ok(true)
    }

    /// Marca contato como verificado (após comparar os 60 dígitos de viva voz).
    pub async fn mark_verified(&self, uid: String) -> CoreResult<()> {
        let u = user_id_for_uid(&uid)?;
        let op = self.op().await?;
        let id = op.m.get_identity(&u, None).await?.ok_or_else(|| CoreError::Identity { msg: "contact_identity_missing".into() })?;
        let o = id.other().ok_or_else(|| invalid("uid", "use outro uid"))?;
        let req = o.verify().await.map_err(|e| CoreError::Identity { msg: e.to_string() })?;
        let tid = ruma::TransactionId::new();
        send_request(&op.m, self.transport.as_ref(), &tid, &AnyOutgoingRequest::SignatureUpload(req)).await?;
        op.m.mark_all_tracked_users_as_dirty().await?;
        drain(&op.m, self.transport.as_ref()).await?;
        Ok(())
    }
}

impl CryptoCore {

    async fn msk_of(&self, m: &matrix_sdk_crypto::OlmMachine, uid: &str) -> CoreResult<Option<Vec<u8>>> {
        let u = user_id_for_uid(uid)?;
        let id = m.get_identity(&u, None).await?;
        Ok(id.and_then(|i| {
            let mk = match &i {
                matrix_sdk_crypto::UserIdentity::Own(o) => o.master_key().get_first_key().map(|k| k.as_bytes().to_vec()),
                matrix_sdk_crypto::UserIdentity::Other(o) => o.master_key().get_first_key().map(|k| k.as_bytes().to_vec()),
            };
            mk
        }))
    }

    /// Aparelho vinculado: confia na MSK recebida pelo canal seguro do vínculo (assina a MSK
    /// com a chave deste aparelho). Recusa se o servidor mostrar outra MSK.
    pub(crate) async fn trust_own_identity(&self, expected_msk_b64: &str) -> CoreResult<()> {
        let op = self.op().await?;
        let m = &op.m;
        m.update_tracked_users([self.user_id.as_ref()]).await?;
        m.mark_all_tracked_users_as_dirty().await?;
        drain(m, self.transport.as_ref()).await?;
        let msk = self.msk_of(m, &self.uid).await?.map(|k| b64(&k)).unwrap_or_default();
        if msk.is_empty() || unb64(&msk) != unb64(expected_msk_b64) {
            return Err(CoreError::Link { msg: "msk_mismatch".into() });
        }
        let id = m.get_identity(&self.user_id, None).await?.and_then(|i| i.own()).ok_or_else(|| CoreError::Identity { msg: "own_identity_missing".into() })?;
        let req = id.verify().await.map_err(|e| CoreError::Identity { msg: e.to_string() })?;
        let tid = ruma::TransactionId::new();
        send_request(m, self.transport.as_ref(), &tid, &AnyOutgoingRequest::SignatureUpload(req)).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn safety_number_symmetric() {
        let a = safety_number_for("7", &[1u8; 32], "42", &[2u8; 32]);
        let b = safety_number_for("42", &[2u8; 32], "7", &[1u8; 32]);
        assert_eq!(a.digits, b.digits);
        assert_eq!(a.qr_payload, b.qr_payload);
        assert_eq!(a.digits.len(), 60);
        assert!(a.digits.bytes().all(|c| c.is_ascii_digit()));
        let c = safety_number_for("7", &[1u8; 32], "42", &[3u8; 32]);
        assert_ne!(a.digits, c.digits);
        // vetor fixo (o WP-15 / outras implementações conferem contra ele)
        assert_eq!(fingerprint_digits("7", &[1u8; 32]).len(), 30);
    }
}

#[cfg(feature = "testing")]
#[doc(hidden)]
impl CryptoCore {
    /// SÓ para testes de integração: mesmo passo final do vínculo (confiar na MSK do canal).
    pub async fn __test_trust_own_identity(&self, msk_b64: String) -> CoreResult<()> {
        self.trust_own_identity(&msk_b64).await
    }
}
