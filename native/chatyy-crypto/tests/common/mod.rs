#![allow(dead_code)]
pub mod fake_server;

use chatyy_crypto::*;
use fake_server::*;
use serde_json::{json, Value};
use std::sync::Arc;

pub struct Client {
    pub uid: String,
    pub core: Arc<CryptoCore>,
    pub t: Arc<ClientTransport>,
    pub dir: Arc<tempfile::TempDir>,
    pub device_id: String,
}

pub const PASS: &str = "c3RvcmUtcGFzc3BocmFzZS0zMi1ieXRlcy1hYWFhYWE";

impl Client {
    pub async fn open_at(server: &Arc<FakeServer>, uid: &str, device_id: &str, dir: Arc<tempfile::TempDir>, role: ProcessRole, suffix: &str) -> Client {
        let t = ClientTransport::new(server, Some(uid), device_id);
        let core = CryptoCore::open(
            OpenOptions {
                store_dir: dir.path().join("store").to_string_lossy().to_string(),
                store_passphrase: PASS.into(),
                uid: uid.into(),
                device_id: device_id.into(),
                role,
                holder_suffix: suffix.into(),
            },
            t.clone(),
        )
        .await
        .expect("open");
        Client { uid: uid.into(), core, t, dir, device_id: device_id.into() }
    }

    /// Celular principal: abre, publica chaves e cria a chave de conta.
    pub async fn phone(server: &Arc<FakeServer>, uid: &str) -> Client {
        let d = new_device_id("P").unwrap();
        let c = Client::open_at(server, uid, &d, Arc::new(tempfile::tempdir().unwrap()), ProcessRole::App, "").await;
        c.core.sync().await.unwrap();
        let st = c.core.bootstrap_identity().await.unwrap();
        assert!(st.is_primary && st.has_identity);
        c
    }

    /// Aparelho secundário já assinado pelo principal (atalho sem QR; o QR tem teste próprio).
    pub async fn secondary(server: &Arc<FakeServer>, primary: &Client, prefix: &str) -> Client {
        let d = new_device_id(prefix).unwrap();
        let c = Client::open_at(server, &primary.uid, &d, Arc::new(tempfile::tempdir().unwrap()), ProcessRole::Web, "").await;
        c.core.sync().await.unwrap();
        let me = c.core.this_device().await.unwrap();
        primary.core.sign_device(d.clone(), me.ed25519).await.unwrap();
        let msk = primary.core.identity_status(primary.uid.clone()).await.unwrap().master_key;
        trust_own(&c, &msk).await;
        c
    }

    pub async fn send(&self, conv: &str, members: &[&Client], body: &str) -> (String, String, EncryptResult) {
        let cmid = format!("cm-{}", new_device_id("X").unwrap());
        let payload = json!({"v": 1, "t": "text", "conv": conv, "cmid": cmid, "ts": 1, "body": body}).to_string();
        let uids: Vec<String> = members.iter().map(|m| m.uid.clone()).collect();
        // o host sincroniza ao receber `e2ee5_devices`/`e2ee5_td`; nos testes, antes de enviar
        self.core.sync().await.unwrap();
        let r = self.core.encrypt(conv.into(), uids, payload).await.expect("encrypt");
        (r.envelope_json.clone(), cmid, r)
    }

    pub async fn recv(&self, conv: &str, from: &Client, env: &str, cmid: &str, mid: &str) -> Result<Decrypted, CoreError> {
        self.core.sync().await.unwrap();
        self.core
            .decrypt(DecryptInput {
                conv_id: conv.into(),
                envelope_json: env.into(),
                sender_uid: from.uid.clone(),
                server_mid: mid.into(),
                cmid: cmid.into(),
                ts_ms: 1_700_000_000_000,
            })
            .await
    }
}

pub async fn trust_own(c: &Client, msk: &str) {
    // mesmo caminho que o fim do vínculo usa (CryptoCore::trust_own_identity é pub(crate));
    // aqui exercitamos pelo LinkWeb nos testes de vínculo e por import direto nos demais.
    let _ = (c, msk);
    c.core.__test_trust_own_identity(msk.to_string()).await.unwrap();
}

pub fn body_of(d: &Decrypted) -> String {
    let v: Value = serde_json::from_str(&d.payload_json).unwrap();
    v["body"].as_str().unwrap_or("").to_string()
}
