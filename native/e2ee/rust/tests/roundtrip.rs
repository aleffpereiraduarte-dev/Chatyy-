//! Native ↔ native: same scenarios as /root/chatyy-e2ee-wasm/test/t.mjs.
use chatyy_e2ee::*;

#[test]
fn olm_roundtrip_pickles_replay_and_errors() {
    let key = vec![7u8; 32];
    let a = OlmAccount::new();
    let b = OlmAccount::new();
    assert!(b.max_one_time_keys() >= 50);
    b.generate_one_time_keys(5);
    b.generate_fallback_key();
    let otks: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&b.one_time_keys()).unwrap();
    let (kid, otk) = otks.iter().next().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).unwrap();
    let msg = format!("chatyy-otk:{kid}:{otk}");
    let sig = b.sign(msg.clone());
    assert!(ed25519_verify(b.ed25519(), msg.clone(), sig.clone()));
    assert!(!ed25519_verify(b.ed25519(), "x".into(), sig));
    b.mark_keys_as_published();

    let sa = a.create_outbound_session(b.curve25519(), otk).unwrap();
    let m1: serde_json::Value = serde_json::from_str(&sa.encrypt("oi B 1".into()).unwrap()).unwrap();
    let m2: serde_json::Value = serde_json::from_str(&sa.encrypt("oi B 2".into()).unwrap()).unwrap();
    let t = |v: &serde_json::Value| v["t"].as_u64().unwrap() as u32;
    let bb = |v: &serde_json::Value| v["b"].as_str().unwrap().to_string();
    assert_eq!((t(&m1), t(&m2)), (0, 0));
    assert_eq!(pre_key_session_id(t(&m2), bb(&m2)), sa.session_id());

    // pickle round trips
    let sa = OlmSession::from_pickle(sa.pickle(key.clone()).unwrap(), key.clone()).unwrap();
    let a2 = OlmAccount::from_pickle(a.pickle(key.clone()).unwrap(), key.clone()).unwrap();
    assert_eq!(a2.curve25519(), a.curve25519());
    assert!(OlmSession::from_pickle(sa.pickle(key.clone()).unwrap(), vec![0u8; 32]).is_err());

    // inbound from the SECOND pre-key message, then the first
    let r = b.create_inbound_session(a.curve25519(), t(&m2), bb(&m2)).unwrap();
    assert_eq!(r.plaintext, "oi B 2");
    assert_eq!(r.session.decrypt(t(&m1), bb(&m1)).unwrap(), "oi B 1");
    assert!(r.session.decrypt(t(&m1), bb(&m1)).is_err(), "replay must be rejected");
    let rep: serde_json::Value = serde_json::from_str(&r.session.encrypt("oi A".into()).unwrap()).unwrap();
    assert_eq!(t(&rep), 1);
    assert_eq!(sa.decrypt(t(&rep), bb(&rep)).unwrap(), "oi A");
    let m3: serde_json::Value = serde_json::from_str(&sa.encrypt("depois".into()).unwrap()).unwrap();
    assert_eq!(t(&m3), 1, "after a reply the sender switches to normal messages");
    assert_eq!(r.session.decrypt(t(&m3), bb(&m3)).unwrap(), "depois");
    assert!(b.create_inbound_session(a.curve25519(), t(&m1), bb(&m1)).is_err(), "OTK consumed");

    // bad inputs → errors, never panics
    assert!(a.create_outbound_session("not-a-key".into(), "x".into()).is_err());
    assert!(b.create_inbound_session(a.curve25519(), 1, bb(&m3)).is_err());
    assert!(r.session.decrypt(9, "AAAA".into()).is_err());
    assert!(r.session.decrypt(1, "%%%".into()).is_err());
    assert!(OlmAccount::from_pickle("garbage".into(), key.clone()).is_err());
    assert!(MegolmInbound::new("garbage".into()).is_err());
    assert!(!core_version().is_empty());
}

#[test]
fn megolm_roundtrip() {
    let g = MegolmOutbound::new();
    let gi = MegolmInbound::new(g.session_key()).unwrap();
    let m = g.encrypt("grupo".into());
    let o: serde_json::Value = serde_json::from_str(&gi.decrypt(m).unwrap()).unwrap();
    assert_eq!(o["p"], "grupo");
    assert_eq!(o["i"], 0);
    let key = vec![1u8; 32];
    let gi2 = MegolmInbound::from_pickle(gi.pickle(key.clone()).unwrap(), key).unwrap();
    assert_eq!(gi2.session_id(), g.session_id());
}

#[test]
fn concurrent_calls_do_not_deadlock() {
    use std::sync::Arc;
    let a = OlmAccount::new();
    let mut hs = vec![];
    for _ in 0..8 {
        let a: Arc<OlmAccount> = a.clone();
        hs.push(std::thread::spawn(move || {
            for _ in 0..20 {
                a.generate_one_time_keys(1);
                let _ = a.one_time_keys();
                let _ = a.sign("m".into());
            }
        }));
    }
    for h in hs {
        h.join().unwrap();
    }
}
