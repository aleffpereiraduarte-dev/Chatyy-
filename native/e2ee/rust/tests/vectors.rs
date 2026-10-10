//! Compatibility with the web (wasm) build — both directions.
//!
//! * `wasm_to_native`: opens ../../vectors/wasm-to-native.json (made by
//!   `node native/e2ee/vectors/wasm-vectors.mjs gen`) with the NATIVE crate.
//! * `native_to_wasm`: produces ../../vectors/native-to-wasm.json, which
//!   `node native/e2ee/vectors/wasm-vectors.mjs check` opens with the wasm.
//!   Written only when CHATYY_WRITE_VECTORS=1 (the JSON is committed).

use std::path::PathBuf;

use chatyy_e2ee::*;
use serde::Deserialize;

fn vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vectors")
}

fn b64d(s: &str) -> Vec<u8> {
    // std-only base64 (standard alphabet, with or without padding)
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in s.bytes().filter(|c| *c != b'=') {
        let v = A.iter().position(|x| *x == c).expect("b64") as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    out
}

#[derive(Deserialize)]
struct Msg {
    t: u32,
    b: String,
    pt: String,
}
#[derive(Deserialize)]
struct Party {
    curve25519: String,
    ed25519: String,
    account_pickle: String,
    #[serde(default)]
    session_pickle: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    otk_sig: String,
    #[serde(default)]
    otk_sig_msg: String,
}
#[derive(Deserialize)]
struct GMsg {
    b: String,
    i: u32,
    pt: String,
}
#[derive(Deserialize)]
struct Megolm {
    session_key: String,
    session_id: String,
    messages: Vec<GMsg>,
}
#[derive(Deserialize)]
struct Vectors {
    pickle_key: String,
    alice: Party,
    bob: Party,
    messages: Vec<Msg>,
    pre_key_session_id: String,
    megolm: Megolm,
    megolm_outbound_pickle: String,
}

#[test]
fn wasm_to_native() {
    let raw = std::fs::read_to_string(vectors_dir().join("wasm-to-native.json")).expect("wasm-to-native.json");
    let d: Vectors = serde_json::from_str(&raw).expect("json");
    let key = b64d(&d.pickle_key);
    assert_eq!(key.len(), 32);

    // signatures made by the wasm verify natively
    assert!(ed25519_verify(d.bob.ed25519.clone(), d.bob.otk_sig_msg.clone(), d.bob.otk_sig.clone()));
    assert!(!ed25519_verify(d.bob.ed25519.clone(), format!("{}x", d.bob.otk_sig_msg), d.bob.otk_sig.clone()));
    assert!(!ed25519_verify("garbage".into(), "m".into(), "garbage".into()));

    // wasm pickles open natively
    let alice = OlmAccount::from_pickle(d.alice.account_pickle.clone(), key.clone()).expect("alice pickle");
    assert_eq!(alice.curve25519(), d.alice.curve25519);
    assert_eq!(alice.ed25519(), d.alice.ed25519);
    let bob = OlmAccount::from_pickle(d.bob.account_pickle.clone(), key.clone()).expect("bob pickle");
    assert_eq!(bob.curve25519(), d.bob.curve25519);
    assert!(OlmAccount::from_pickle(d.bob.account_pickle.clone(), vec![0u8; 32]).is_err(), "wrong key must fail");
    assert!(OlmAccount::from_pickle(d.bob.account_pickle.clone(), vec![0u8; 31]).is_err(), "short key must fail");

    // messages encrypted by the wasm decrypt natively
    let m0 = &d.messages[0];
    assert_eq!(m0.t, 0, "first message is pre-key");
    assert_eq!(pre_key_session_id(m0.t, m0.b.clone()), d.pre_key_session_id);
    assert_eq!(pre_key_session_id(1, "AAAA".into()), "");
    let r = bob.create_inbound_session(d.alice.curve25519.clone(), m0.t, m0.b.clone()).expect("inbound");
    assert_eq!(r.plaintext, m0.pt);
    assert_eq!(r.session.session_id(), d.pre_key_session_id);
    for m in &d.messages[1..] {
        assert_eq!(r.session.decrypt(m.t, m.b.clone()).expect("decrypt"), m.pt);
    }
    // replay of a message already decrypted is rejected
    assert!(r.session.decrypt(d.messages[1].t, d.messages[1].b.clone()).is_err());
    // the one-time key is consumed
    assert!(bob.create_inbound_session(d.alice.curve25519.clone(), m0.t, m0.b.clone()).is_err());

    // native reply opens in Alice's session restored from the WASM pickle
    let sa = OlmSession::from_pickle(d.alice.session_pickle.clone(), key.clone()).expect("alice session pickle");
    assert_eq!(sa.session_id(), d.alice.session_id);
    let rep: serde_json::Value = serde_json::from_str(&r.session.encrypt("resposta nativa".into()).unwrap()).unwrap();
    let pt = sa.decrypt(rep["t"].as_u64().unwrap() as u32, rep["b"].as_str().unwrap().into()).expect("reply");
    assert_eq!(pt, "resposta nativa");

    // megolm
    let gi = MegolmInbound::new(d.megolm.session_key.clone()).expect("megolm key");
    assert_eq!(gi.session_id(), d.megolm.session_id);
    for m in &d.megolm.messages {
        let o: serde_json::Value = serde_json::from_str(&gi.decrypt(m.b.clone()).unwrap()).unwrap();
        assert_eq!(o["p"].as_str().unwrap(), m.pt);
        assert_eq!(o["i"].as_u64().unwrap() as u32, m.i);
    }
    let go = MegolmOutbound::from_pickle(d.megolm_outbound_pickle.clone(), key.clone()).expect("megolm out pickle");
    assert_eq!(go.session_id(), d.megolm.session_id);
}

#[test]
fn native_to_wasm() {
    let mut key = vec![0u8; 32];
    for (i, k) in key.iter_mut().enumerate() {
        *k = (i as u8).wrapping_mul(11).wrapping_add(5);
    }
    let alice = OlmAccount::new();
    let bob = OlmAccount::new();
    bob.generate_one_time_keys(3);
    bob.generate_fallback_key();
    let otks: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&bob.one_time_keys()).unwrap();
    assert_eq!(otks.len(), 3);
    let fb: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&bob.fallback_key()).unwrap();
    assert_eq!(fb.len(), 1);
    let (otk_id, otk) = otks.iter().next().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).unwrap();
    let sig_msg = format!("chatyy-e2ee-v4:otk:bob@x:dB:{otk_id}:{otk}");
    let sig = bob.sign(sig_msg.clone());
    bob.mark_keys_as_published();
    assert_eq!(bob.one_time_keys(), "{}");
    let bob_pickle = bob.pickle(key.clone()).unwrap();

    let sa = alice.create_outbound_session(bob.curve25519(), otk.clone()).unwrap();
    let texts = ["olá do nativo 1", "olá do nativo 2 — ç ã é", "{\"v\":1,\"mid\":\"n3\",\"txt\":\"json\"}"];
    let mut msgs = Vec::new();
    for pt in texts {
        let mut v: serde_json::Value = serde_json::from_str(&sa.encrypt(pt.into()).unwrap()).unwrap();
        v["pt"] = serde_json::Value::String(pt.into());
        msgs.push(v);
    }
    assert_eq!(msgs[0]["t"].as_u64(), Some(0));
    let g = MegolmOutbound::new();
    let gkey = g.session_key();
    let gmsgs: Vec<_> = ["grupo nativo 1", "grupo nativo 2"]
        .iter()
        .enumerate()
        .map(|(i, p)| serde_json::json!({ "b": g.encrypt((*p).into()), "i": i, "pt": p }))
        .collect();

    // sanity: native ↔ native before handing it to the wasm
    let bob2 = OlmAccount::from_pickle(bob_pickle.clone(), key.clone()).unwrap();
    let r = bob2
        .create_inbound_session(alice.curve25519(), 0, msgs[0]["b"].as_str().unwrap().into())
        .unwrap();
    assert_eq!(r.plaintext, texts[0]);

    let data = serde_json::json!({
        "about": "gerado por native/e2ee/rust/tests/vectors.rs (CHATYY_WRITE_VECTORS=1 cargo test) — vodozemac 0.11.1 nativo",
        "pickle_key": vodozemac::base64_encode(&key),
        "alice": { "curve25519": alice.curve25519(), "ed25519": alice.ed25519(), "account_pickle": alice.pickle(key.clone()).unwrap(),
                   "session_pickle": sa.pickle(key.clone()).unwrap(), "session_id": sa.session_id() },
        "bob": { "curve25519": bob.curve25519(), "ed25519": bob.ed25519(), "account_pickle": bob_pickle,
                 "otk_id": otk_id, "otk": otk, "otk_sig": sig, "otk_sig_msg": sig_msg },
        "messages": msgs,
        "pre_key_session_id": sa.session_id(),
        "megolm": { "session_key": gkey, "session_id": g.session_id(), "messages": gmsgs },
        "megolm_outbound_pickle": g.pickle(key.clone()).unwrap(),
    });
    if std::env::var("CHATYY_WRITE_VECTORS").ok().as_deref() == Some("1") {
        let p = vectors_dir().join("native-to-wasm.json");
        std::fs::write(&p, serde_json::to_string_pretty(&data).unwrap() + "\n").unwrap();
        eprintln!("wrote {}", p.display());
    }
}
