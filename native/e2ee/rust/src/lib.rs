//! Chatyy E2EE v4 — native (iOS/Android) wrapper around matrix-org/vodozemac
//! (Apache-2.0, audited by Least Authority 2022), exported with UniFFI.
//!
//! This is the SAME surface as the wasm wrapper in /root/chatyy-e2ee-wasm/src/lib.rs
//! (same vodozemac version, same wire format `{"t":0|1,"b":base64}`, same
//! pickles), so a message encrypted on the web opens on the phone and vice
//! versa, and a pickle written by one opens in the other. NO cryptography is
//! implemented here: every primitive / protocol step is vodozemac's.
//!
//! Every input is validated and every vodozemac error becomes `E2eeError`
//! (thrown as a Swift `Error` / Kotlin exception). Objects are `Send + Sync`
//! (a `Mutex` per object) because UniFFI may call them from any thread; the
//! JS side still serializes all ratchet operations (E2EEv4._locked).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use vodozemac::megolm::{
    GroupSession, GroupSessionPickle, InboundGroupSession, InboundGroupSessionPickle, MegolmMessage,
    SessionConfig as MegolmConfig, SessionKey,
};
use vodozemac::olm::{Account, AccountPickle, OlmMessage, Session, SessionConfig, SessionPickle};
use vodozemac::{base64_decode, base64_encode, Curve25519PublicKey, Ed25519PublicKey, Ed25519Signature};

uniffi::setup_scaffolding!("chatyy_e2ee");

#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum E2eeError {
    #[error("decode: {0}")]
    Decode(String),
    #[error("pickle: {0}")]
    Pickle(String),
    #[error("session: {0}")]
    Session(String),
    #[error("key: {0}")]
    Key(String),
}

type R<T> = Result<T, E2eeError>;

fn key32(k: &[u8]) -> R<[u8; 32]> {
    if k.len() != 32 {
        return Err(E2eeError::Pickle("pickle key must be 32 bytes".into()));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(k);
    Ok(out)
}

fn olm_from_wire(msg_type: u32, body_b64: &str) -> R<OlmMessage> {
    let bytes = base64_decode(body_b64).map_err(|e| E2eeError::Decode(e.to_string()))?;
    OlmMessage::from_parts(msg_type as usize, &bytes).map_err(|e| E2eeError::Decode(e.to_string()))
}

fn curve(b64: &str) -> R<Curve25519PublicKey> {
    Curve25519PublicKey::from_base64(b64).map_err(|e| E2eeError::Key(e.to_string()))
}

/// A poisoned mutex only means another call panicked mid-way; vodozemac
/// state is still a valid value, so keep going rather than wedging the object.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn key_map<I, K, V>(it: I) -> String
where
    I: IntoIterator<Item = (K, V)>,
    K: KeyB64,
    V: KeyB64,
{
    let m: BTreeMap<String, String> = it.into_iter().map(|(k, v)| (k.b64(), v.b64())).collect();
    serde_json::to_string(&m).unwrap_or_else(|_| "{}".into())
}

trait KeyB64 {
    fn b64(&self) -> String;
}
impl KeyB64 for vodozemac::KeyId {
    fn b64(&self) -> String {
        self.to_base64()
    }
}
impl KeyB64 for Curve25519PublicKey {
    fn b64(&self) -> String {
        self.to_base64()
    }
}

// ---------------------------------------------------------------- utilities

/// Ed25519 signature check (strict). Returns false on any decode error.
#[uniffi::export]
pub fn ed25519_verify(public_key_b64: String, message: String, signature_b64: String) -> bool {
    let Ok(pk) = Ed25519PublicKey::from_base64(&public_key_b64) else { return false };
    let Ok(sig) = Ed25519Signature::from_base64(&signature_b64) else { return false };
    pk.verify(message.as_bytes(), &sig).is_ok()
}

/// Session id carried inside an Olm pre-key message. Empty if not pre-key.
#[uniffi::export]
pub fn pre_key_session_id(msg_type: u32, body_b64: String) -> String {
    match olm_from_wire(msg_type, &body_b64) {
        Ok(OlmMessage::PreKey(m)) => m.session_id(),
        _ => String::new(),
    }
}

/// Version string, for diagnostics / the JS loader's sanity check.
#[uniffi::export]
pub fn core_version() -> String {
    format!("chatyy-e2ee-native {} / vodozemac 0.11.1", env!("CARGO_PKG_VERSION"))
}

// ---------------------------------------------------------------- Olm account

#[derive(uniffi::Object)]
pub struct OlmAccount {
    inner: Mutex<Account>,
}

#[derive(uniffi::Record)]
pub struct InboundResult {
    pub session: Arc<OlmSession>,
    pub plaintext: String,
}

#[uniffi::export]
impl OlmAccount {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self { inner: Mutex::new(Account::new()) })
    }

    #[uniffi::constructor]
    pub fn from_pickle(pickle: String, pickle_key: Vec<u8>) -> R<Arc<Self>> {
        let p = AccountPickle::from_encrypted(&pickle, &key32(&pickle_key)?)
            .map_err(|e| E2eeError::Pickle(e.to_string()))?;
        Ok(Arc::new(Self { inner: Mutex::new(Account::from_pickle(p)) }))
    }

    pub fn pickle(&self, pickle_key: Vec<u8>) -> R<String> {
        let k = key32(&pickle_key)?;
        Ok(lock(&self.inner).pickle().encrypt(&k))
    }

    pub fn curve25519(&self) -> String {
        lock(&self.inner).curve25519_key().to_base64()
    }

    pub fn ed25519(&self) -> String {
        lock(&self.inner).ed25519_key().to_base64()
    }

    pub fn sign(&self, message: String) -> String {
        lock(&self.inner).sign(message.as_bytes()).to_base64()
    }

    pub fn generate_one_time_keys(&self, count: u32) {
        // vodozemac caps the pool itself (max_number_of_one_time_keys).
        let _ = lock(&self.inner).generate_one_time_keys(count as usize);
    }

    /// JSON object { key_id: curve25519_b64 } of unpublished one-time keys.
    pub fn one_time_keys(&self) -> String {
        key_map(lock(&self.inner).one_time_keys())
    }

    pub fn generate_fallback_key(&self) {
        let _ = lock(&self.inner).generate_fallback_key();
    }

    pub fn fallback_key(&self) -> String {
        key_map(lock(&self.inner).fallback_key())
    }

    pub fn mark_keys_as_published(&self) {
        lock(&self.inner).mark_keys_as_published();
    }

    pub fn max_one_time_keys(&self) -> u32 {
        lock(&self.inner).max_number_of_one_time_keys() as u32
    }

    pub fn create_outbound_session(&self, identity_key_b64: String, one_time_key_b64: String) -> R<Arc<OlmSession>> {
        let ik = curve(&identity_key_b64)?;
        let otk = curve(&one_time_key_b64)?;
        let s = lock(&self.inner)
            .create_outbound_session(SessionConfig::version_1(), ik, otk)
            .map_err(|e| E2eeError::Session(e.to_string()))?;
        Ok(Arc::new(OlmSession { inner: Mutex::new(s) }))
    }

    /// Consumes the one-time key on success (in memory — the caller decides
    /// when to persist the account pickle, exactly like the wasm build).
    pub fn create_inbound_session(&self, their_identity_key_b64: String, msg_type: u32, body_b64: String) -> R<InboundResult> {
        let ik = curve(&their_identity_key_b64)?;
        let OlmMessage::PreKey(pk) = olm_from_wire(msg_type, &body_b64)? else {
            return Err(E2eeError::Decode("not a pre-key message".into()));
        };
        let r = lock(&self.inner)
            .create_inbound_session(SessionConfig::version_1(), ik, &pk)
            .map_err(|e| E2eeError::Session(e.to_string()))?;
        let plaintext = String::from_utf8(r.plaintext).map_err(|e| E2eeError::Decode(e.to_string()))?;
        Ok(InboundResult { session: Arc::new(OlmSession { inner: Mutex::new(r.session) }), plaintext })
    }
}

// ---------------------------------------------------------------- Olm session

#[derive(uniffi::Object)]
pub struct OlmSession {
    inner: Mutex<Session>,
}

#[uniffi::export]
impl OlmSession {
    #[uniffi::constructor]
    pub fn from_pickle(pickle: String, pickle_key: Vec<u8>) -> R<Arc<Self>> {
        let p = SessionPickle::from_encrypted(&pickle, &key32(&pickle_key)?)
            .map_err(|e| E2eeError::Pickle(e.to_string()))?;
        Ok(Arc::new(Self { inner: Mutex::new(Session::from_pickle(p)) }))
    }

    pub fn pickle(&self, pickle_key: Vec<u8>) -> R<String> {
        let k = key32(&pickle_key)?;
        Ok(lock(&self.inner).pickle().encrypt(&k))
    }

    pub fn session_id(&self) -> String {
        lock(&self.inner).session_id()
    }

    /// Returns JSON {"t": 0|1, "b": base64}. t=0 pre-key, t=1 normal.
    pub fn encrypt(&self, plaintext: String) -> R<String> {
        let m = lock(&self.inner)
            .encrypt(plaintext.as_bytes())
            .map_err(|e| E2eeError::Session(e.to_string()))?;
        let (t, bytes) = m.to_parts();
        Ok(format!("{{\"t\":{},\"b\":\"{}\"}}", t, base64_encode(bytes)))
    }

    pub fn decrypt(&self, msg_type: u32, body_b64: String) -> R<String> {
        let m = olm_from_wire(msg_type, &body_b64)?;
        let pt = lock(&self.inner).decrypt(&m).map_err(|e| E2eeError::Session(e.to_string()))?;
        String::from_utf8(pt).map_err(|e| E2eeError::Decode(e.to_string()))
    }
}

// ---------------------------------------------------------------- Megolm (groups, phase 2)

#[derive(uniffi::Object)]
pub struct MegolmOutbound {
    inner: Mutex<GroupSession>,
}

#[uniffi::export]
impl MegolmOutbound {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self { inner: Mutex::new(GroupSession::new(MegolmConfig::version_1())) })
    }
    #[uniffi::constructor]
    pub fn from_pickle(pickle: String, pickle_key: Vec<u8>) -> R<Arc<Self>> {
        let p = GroupSessionPickle::from_encrypted(&pickle, &key32(&pickle_key)?)
            .map_err(|e| E2eeError::Pickle(e.to_string()))?;
        Ok(Arc::new(Self { inner: Mutex::new(GroupSession::from_pickle(p)) }))
    }
    pub fn pickle(&self, pickle_key: Vec<u8>) -> R<String> {
        let k = key32(&pickle_key)?;
        Ok(lock(&self.inner).pickle().encrypt(&k))
    }
    pub fn session_id(&self) -> String {
        lock(&self.inner).session_id()
    }
    pub fn session_key(&self) -> String {
        lock(&self.inner).session_key().to_base64()
    }
    pub fn encrypt(&self, plaintext: String) -> String {
        lock(&self.inner).encrypt(plaintext.as_bytes()).to_base64()
    }
}

#[derive(uniffi::Object)]
pub struct MegolmInbound {
    inner: Mutex<InboundGroupSession>,
}

#[uniffi::export]
impl MegolmInbound {
    #[uniffi::constructor]
    pub fn new(session_key_b64: String) -> R<Arc<Self>> {
        let k = SessionKey::from_base64(&session_key_b64).map_err(|e| E2eeError::Key(e.to_string()))?;
        Ok(Arc::new(Self { inner: Mutex::new(InboundGroupSession::new(&k, MegolmConfig::version_1())) }))
    }
    #[uniffi::constructor]
    pub fn from_pickle(pickle: String, pickle_key: Vec<u8>) -> R<Arc<Self>> {
        let p = InboundGroupSessionPickle::from_encrypted(&pickle, &key32(&pickle_key)?)
            .map_err(|e| E2eeError::Pickle(e.to_string()))?;
        Ok(Arc::new(Self { inner: Mutex::new(InboundGroupSession::from_pickle(p)) }))
    }
    pub fn pickle(&self, pickle_key: Vec<u8>) -> R<String> {
        let k = key32(&pickle_key)?;
        Ok(lock(&self.inner).pickle().encrypt(&k))
    }
    pub fn session_id(&self) -> String {
        lock(&self.inner).session_id()
    }
    /// Returns JSON {"i": message_index, "p": plaintext}
    pub fn decrypt(&self, message_b64: String) -> R<String> {
        let m = MegolmMessage::from_base64(&message_b64).map_err(|e| E2eeError::Decode(e.to_string()))?;
        let d = lock(&self.inner).decrypt(&m).map_err(|e| E2eeError::Session(e.to_string()))?;
        let p = String::from_utf8(d.plaintext).map_err(|e| E2eeError::Decode(e.to_string()))?;
        Ok(serde_json::json!({ "i": d.message_index, "p": p }).to_string())
    }
}
