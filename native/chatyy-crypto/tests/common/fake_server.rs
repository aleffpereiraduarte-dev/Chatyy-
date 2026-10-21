//! Servidor falso `e2ee5.php` — ESPECIFICAÇÃO EXECUTÁVEL do CONTRATO §4.
//!
//! Implementa em memória as ações `e2ee5_*` com as mesmas regras que o PHP (WP-05) tem de ter:
//! autorização por relação (divide conversa), anti-dreno de OTK, verificação de assinatura
//! ed25519 sobre JSON canônico (falha fechada), carimbo do remetente no to-device, cursores de
//! sync com ack, backup, secret storage e rendezvous do vínculo. Tem também "modos malvados"
//! (servidor comprometido) para os testes de segurança.
#![allow(dead_code)]
use chatyy_crypto::{HttpResponse, HttpTransport, TransportError};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use vodozemac::{Ed25519PublicKey, Ed25519Signature};

pub const OTK_PER_HOUR_PER_PAIR: u32 = 5;

#[derive(Default)]
pub struct Evil {
    /// keys_query devolve ESTE objeto no lugar das chaves reais de (user, device).
    pub swap_device_keys: Option<(String, String, Value)>,
    /// Aparelhos injetados (sem assinatura do dono) que o servidor "acrescenta" ao user.
    pub injected: Vec<(String, String, Value)>,
}

#[derive(Default)]
pub struct State {
    pub devices: BTreeMap<String, BTreeMap<String, Value>>,
    pub xsign: BTreeMap<String, Map<String, Value>>,
    pub otks: HashMap<(String, String), Vec<(String, Value)>>,
    pub fallback: HashMap<(String, String), (String, Value)>,
    pub claims: HashMap<(String, String, String), u32>,
    pub td: Vec<(u64, String, String, Value)>,
    pub td_seq: u64,
    pub dc: Vec<(u64, String)>,
    pub dc_seq: u64,
    pub convs: BTreeMap<String, BTreeSet<String>>,
    pub txns: HashSet<(String, String, String)>,
    pub backup: Option<(String, Value, BTreeMap<String, BTreeMap<String, Value>>)>,
    pub backup_seq: u64,
    pub secret: Option<Value>,
    pub links: HashMap<String, Link>,
    pub bearers: HashMap<String, (String, String)>,
    pub bytes_to_device: usize,
    pub calls: BTreeMap<String, u64>,
    pub examples: BTreeMap<String, (Value, Value)>,
    pub evil: Evil,
}

#[derive(Default, Clone)]
pub struct Link {
    pub owner: Option<String>,
    pub p: Vec<(u64, String)>,
    pub w: Vec<(u64, String)>,
}

#[derive(Default)]
pub struct FakeServer {
    pub st: Mutex<State>,
}

pub fn uid_user(uid: &str) -> String {
    format!("@u{uid}:chatyy")
}

// ---------- JSON canônico + verificação (referência para o PHP, CONTRATO §4.4) ----------
pub fn canonical(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let inner: Vec<String> = keys.iter().map(|k| format!("{}:{}", serde_json::to_string(k).unwrap(), canonical(&m[*k]))).collect();
            format!("{{{}}}", inner.join(","))
        }
        Value::Array(a) => format!("[{}]", a.iter().map(canonical).collect::<Vec<_>>().join(",")),
        other => serde_json::to_string(other).unwrap(),
    }
}

pub fn verify_signed(obj: &Value, signer_user: &str, key_id: &str, pubkey_b64: &str) -> bool {
    let sig = match obj.get("signatures").and_then(|s| s.get(signer_user)).and_then(|s| s.get(key_id)).and_then(Value::as_str) {
        Some(s) => s,
        None => return false,
    };
    let mut o = obj.clone();
    if let Some(m) = o.as_object_mut() {
        m.remove("signatures");
        m.remove("unsigned");
    }
    let (Ok(pk), Ok(sig)) = (Ed25519PublicKey::from_base64(pubkey_b64), Ed25519Signature::from_base64(sig)) else { return false };
    pk.verify(canonical(&o).as_bytes(), &sig).is_ok()
}

fn first_key(k: &Value) -> Option<(String, String)> {
    k.get("keys")?.as_object()?.iter().next().map(|(id, v)| (id.clone(), v.as_str().unwrap_or("").to_string()))
}

fn merge_sigs(target: &mut Value, from: &Value) {
    if let Some(fs) = from.get("signatures").and_then(Value::as_object) {
        for (u, m) in fs {
            for (kid, s) in m.as_object().into_iter().flatten() {
                target["signatures"][u][kid] = s.clone();
            }
        }
    }
}

fn ok(data: Value) -> HttpResponse {
    HttpResponse { status: 200, body: json!({"success": true, "data": data}).to_string() }
}
fn err(status: u16, code: &str) -> HttpResponse {
    HttpResponse { status, body: json!({"success": false, "data": {"code": code}, "message": code}).to_string() }
}

impl State {
    pub fn shares(&self, a: &str, b: &str) -> bool {
        a == b || self.convs.values().any(|m| m.contains(a) && m.contains(b))
    }
    fn device_change(&mut self, user: &str) {
        self.dc_seq += 1;
        let s = self.dc_seq;
        self.dc.push((s, user.to_string()));
    }
    fn device_ed(&self, user: &str, dev: &str) -> Option<String> {
        self.devices.get(user)?.get(dev)?.get("keys")?.get(format!("ed25519:{dev}"))?.as_str().map(String::from)
    }
}

impl FakeServer {
    pub fn new() -> Arc<FakeServer> {
        Arc::new(FakeServer::default())
    }
    pub fn set_conv(&self, conv: &str, uids: &[&str]) {
        let mut st = self.st.lock().unwrap();
        let set: BTreeSet<String> = uids.iter().map(|u| uid_user(u)).collect();
        let old = st.convs.insert(conv.to_string(), set.clone()).unwrap_or_default();
        // entrada/saída de membro = mudança de lista de aparelhos para quem divide a conversa
        for u in old.symmetric_difference(&set).cloned().collect::<Vec<_>>() {
            st.device_change(&u);
        }
    }
    pub fn otk_count(&self, uid: &str, dev: &str) -> usize {
        self.st.lock().unwrap().otks.get(&(uid_user(uid), dev.to_string())).map(|q| q.len()).unwrap_or(0)
    }
    pub fn drain_otks(&self, uid: &str, dev: &str) {
        self.st.lock().unwrap().otks.remove(&(uid_user(uid), dev.to_string()));
    }
    pub fn calls(&self, action: &str) -> u64 {
        self.st.lock().unwrap().calls.get(action).copied().unwrap_or(0)
    }
    pub fn bytes_to_device(&self) -> usize {
        self.st.lock().unwrap().bytes_to_device
    }
    pub fn device_keys(&self, uid: &str, dev: &str) -> Option<Value> {
        self.st.lock().unwrap().devices.get(&uid_user(uid)).and_then(|d| d.get(dev)).cloned()
    }
    pub fn examples(&self) -> BTreeMap<String, (Value, Value)> {
        self.st.lock().unwrap().examples.clone()
    }

    /// Despacha uma ação. `caller` = (user, device) já autenticado (bearer + X-E2EE-Device),
    /// ou None (sem bearer).
    pub fn handle(&self, action: &str, body: &Value, caller: Option<(&str, &str)>) -> HttpResponse {
        let mut st = self.st.lock().unwrap();
        *st.calls.entry(action.to_string()).or_default() += 1;
        let r = Self::dispatch(&mut st, action, body, caller);
        if r.status == 200 && !st.examples.contains_key(action) {
            let data: Value = serde_json::from_str::<Value>(&r.body).ok().and_then(|v| v.get("data").cloned()).unwrap_or(Value::Null);
            st.examples.insert(action.to_string(), (body.clone(), data));
        }
        r
    }

    fn dispatch(st: &mut State, action: &str, b: &Value, caller: Option<(&str, &str)>) -> HttpResponse {
        let anon_ok = matches!(action, "link_create" | "link_post" | "link_poll");
        let (me, dev) = match caller {
            Some((u, d)) => (u.to_string(), d.to_string()),
            None if anon_ok => (String::new(), String::new()),
            None => return err(401, "unauthorized"),
        };
        match action {
            "status" => ok(json!({"user_id": me, "contract": "e2ee5-contrato/1.3", "enabled": true, "kill": false})),
            "keys_upload" => {
                if let Some(dk) = b.get("device_keys").filter(|v| !v.is_null()) {
                    if dk["user_id"] != json!(me) || dk["device_id"] != json!(dev) {
                        return err(400, "e2ee5_bad_request");
                    }
                    let ed = dk["keys"][format!("ed25519:{dev}")].as_str().unwrap_or("");
                    if !verify_signed(dk, &me, &format!("ed25519:{dev}"), ed) {
                        return err(400, "e2ee5_bad_signature");
                    }
                    if let Some(old) = st.devices.get(&me).and_then(|d| d.get(&dev)) {
                        if old["keys"] != dk["keys"] {
                            return err(409, "e2ee5_device_key_changed");
                        }
                    }
                    let mut stored = dk.clone();
                    if let Some(old) = st.devices.get(&me).and_then(|d| d.get(&dev)) {
                        merge_sigs(&mut stored, old);
                    }
                    st.devices.entry(me.clone()).or_default().insert(dev.clone(), stored);
                    st.device_change(&me);
                }
                let ed = match st.device_ed(&me, &dev) {
                    Some(e) => e,
                    None => return err(400, "e2ee5_device_required"),
                };
                let kid = format!("ed25519:{dev}");
                for (k, v) in b.get("one_time_keys").and_then(Value::as_object).into_iter().flatten() {
                    if !verify_signed(v, &me, &kid, &ed) {
                        return err(400, "e2ee5_bad_signature");
                    }
                    let q = st.otks.entry((me.clone(), dev.clone())).or_default();
                    if q.len() < 100 {
                        q.push((k.clone(), v.clone()));
                    }
                }
                for (k, v) in b.get("fallback_keys").and_then(Value::as_object).into_iter().flatten() {
                    if !verify_signed(v, &me, &kid, &ed) {
                        return err(400, "e2ee5_bad_signature");
                    }
                    st.fallback.insert((me.clone(), dev.clone()), (k.clone(), v.clone()));
                }
                let n = st.otks.get(&(me.clone(), dev.clone())).map(|q| q.len()).unwrap_or(0);
                ok(json!({"one_time_key_counts": {"signed_curve25519": n}}))
            }
            "keys_query" => {
                let mut dk = Map::new();
                let (mut mk, mut ssk, mut usk, mut fail) = (Map::new(), Map::new(), Map::new(), Map::new());
                for (u, want) in b.get("device_keys").and_then(Value::as_object).into_iter().flatten() {
                    if !st.shares(&me, u) {
                        fail.insert(u.clone(), json!({"code": "forbidden"}));
                        continue;
                    }
                    let want: Vec<String> = want.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                    let mut devs: Map<String, Value> = st.devices.get(u).cloned().unwrap_or_default().into_iter().filter(|(d, _)| want.is_empty() || want.contains(d)).collect();
                    for (eu, ed, v) in &st.evil.injected {
                        if eu == u {
                            devs.insert(ed.clone(), v.clone());
                        }
                    }
                    if let Some((su, sd, v)) = &st.evil.swap_device_keys {
                        if su == u && devs.contains_key(sd) {
                            devs.insert(sd.clone(), v.clone());
                        }
                    }
                    dk.insert(u.clone(), Value::Object(devs));
                    if let Some(x) = st.xsign.get(u) {
                        if let Some(v) = x.get("master") { mk.insert(u.clone(), v.clone()); }
                        if let Some(v) = x.get("self_signing") { ssk.insert(u.clone(), v.clone()); }
                        if *u == me {
                            if let Some(v) = x.get("user_signing") { usk.insert(u.clone(), v.clone()); }
                        }
                    }
                }
                ok(json!({"device_keys": dk, "master_keys": mk, "self_signing_keys": ssk, "user_signing_keys": usk, "failures": fail}))
            }
            "keys_claim" => {
                let mut out = Map::new();
                let mut fail = Map::new();
                for (u, devs) in b.get("one_time_keys").and_then(Value::as_object).into_iter().flatten() {
                    if !st.shares(&me, u) {
                        fail.insert(u.clone(), json!({"code": "forbidden"}));
                        continue;
                    }
                    let mut um = Map::new();
                    for d in devs.as_object().into_iter().flatten().map(|(d, _)| d.clone()) {
                        let key = (u.clone(), d.clone());
                        let pair = (me.clone(), u.clone(), d.clone());
                        let n = *st.claims.get(&pair).unwrap_or(&0);
                        let got = if n < OTK_PER_HOUR_PER_PAIR { st.otks.get_mut(&key).and_then(|q| q.pop()) } else { None };
                        let got = got.or_else(|| st.fallback.get(&key).cloned());
                        *st.claims.entry(pair).or_default() += 1;
                        if let Some((kid, kv)) = got {
                            um.insert(d.clone(), json!({ kid: kv }));
                        }
                    }
                    out.insert(u.clone(), Value::Object(um));
                }
                ok(json!({"one_time_keys": out, "failures": fail}))
            }
            "signing_keys_upload" => {
                let msk = b.get("master_key").cloned().unwrap_or(Value::Null);
                let ssk_v = b.get("self_signing_key").cloned().unwrap_or(Value::Null);
                let usk_v = b.get("user_signing_key").cloned().unwrap_or(Value::Null);
                let (mkid, mpub) = match first_key(&msk) { Some(x) => x, None => return err(400, "e2ee5_bad_request") };
                // MSK: auto-assinada E assinada pelo aparelho que a criou (o novo principal).
                let ed = st.device_ed(&me, &dev).unwrap_or_default();
                if msk["user_id"] != json!(me) || !verify_signed(&msk, &me, &mkid, &mpub) || !verify_signed(&msk, &me, &format!("ed25519:{dev}"), &ed) {
                    return err(400, "e2ee5_bad_signature");
                }
                for k in [&ssk_v, &usk_v] {
                    if !k.is_null() && !verify_signed(k, &me, &mkid, &mpub) {
                        return err(400, "e2ee5_bad_signature");
                    }
                }
                let replaced = st.xsign.contains_key(&me);
                let mut m = Map::new();
                m.insert("master".into(), msk);
                m.insert("self_signing".into(), ssk_v);
                m.insert("user_signing".into(), usk_v);
                st.xsign.insert(me.clone(), m);
                if replaced {
                    // reset de identidade: assinaturas antigas dos aparelhos deixam de valer
                    if let Some(ds) = st.devices.get_mut(&me) {
                        for v in ds.values_mut() {
                            let own = v["signatures"][&me].as_object().cloned().unwrap_or_default();
                            let keep: Map<String, Value> = own.into_iter().filter(|(k, _)| k.starts_with("ed25519:") && k.len() < 30).collect();
                            v["signatures"][&me] = Value::Object(keep);
                        }
                    }
                }
                st.device_change(&me);
                ok(json!({}))
            }
            "signatures_upload" => {
                let mut fail = Map::new();
                for (u, objs) in b.as_object().into_iter().flatten() {
                    for (kid, obj) in objs.as_object().into_iter().flatten() {
                        // quais chaves do chamador podem ter assinado isto?
                        let mut signers: Vec<(String, String)> = vec![];
                        if let Some(e) = st.device_ed(&me, &dev) { signers.push((format!("ed25519:{dev}"), e)); }
                        if let Some(x) = st.xsign.get(&me) {
                            for k in ["self_signing", "user_signing", "master"] {
                                if let Some(p) = x.get(k).and_then(first_key) { signers.push(p); }
                            }
                        }
                        let new_sigs = obj["signatures"][&me].as_object().cloned().unwrap_or_default();
                        let mut valid = !new_sigs.is_empty();
                        for (skid, _) in &new_sigs {
                            if let Some((_, pubk)) = signers.iter().find(|(k, _)| k == skid) {
                                if !verify_signed(obj, &me, skid, pubk) { valid = false; }
                            }
                        }
                        if !valid {
                            fail.insert(u.clone(), json!({kid: {"errcode": "M_INVALID_SIGNATURE"}}));
                            continue;
                        }
                        let is_device = st.devices.get(u).map(|d| d.contains_key(kid)).unwrap_or(false);
                        if is_device && *u == me {
                            let mut target = st.devices.get(u).unwrap().get(kid).unwrap().clone();
                            merge_sigs(&mut target, obj);
                            st.devices.get_mut(u).unwrap().insert(kid.clone(), target);
                        } else if let Some(x) = st.xsign.get_mut(u) {
                            if let Some(m) = x.get_mut("master") {
                                merge_sigs(m, obj);
                            }
                        }
                        let uu = u.clone();
                        st.device_change(&uu);
                    }
                }
                ok(json!({"failures": fail}))
            }
            "to_device_send" => {
                let txn = b["txn_id"].as_str().unwrap_or("").to_string();
                if !st.txns.insert((me.clone(), dev.clone(), txn)) {
                    return ok(json!({}));
                }
                let et = b["event_type"].as_str().unwrap_or("").to_string();
                if !matches!(et.as_str(), "m.room.encrypted" | "m.room_key_request" | "m.room_key.withheld" | "m.secret.request") {
                    return err(400, "e2ee5_bad_event");
                }
                for (u, devs) in b["messages"].as_object().into_iter().flatten() {
                    if !st.shares(&me, u) {
                        continue; // proibido: ignora em silêncio
                    }
                    for (d, content) in devs.as_object().into_iter().flatten() {
                        st.bytes_to_device += content.to_string().len();
                        let targets: Vec<String> = if d == "*" { st.devices.get(u).map(|x| x.keys().cloned().collect()).unwrap_or_default() } else { vec![d.clone()] };
                        for t in targets {
                            st.td_seq += 1;
                            let id = st.td_seq;
                            let ev = json!({"type": et, "sender": me, "content": content});
                            st.td.push((id, u.clone(), t, ev));
                        }
                    }
                }
                ok(json!({}))
            }
            "sync" | "to_device_pull" | "device_changes" => {
                let td_since: u64 = b["td_since"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0);
                let dc_since: Option<u64> = b["dc_since"].as_str().and_then(|s| s.parse().ok());
                let limit = b["limit"].as_u64().unwrap_or(100).min(500) as usize;
                // ack: apaga o que já foi processado
                st.td.retain(|(id, u, d, _)| !(u == &me && d == &dev && *id <= td_since));
                let mine: Vec<&(u64, String, String, Value)> = st.td.iter().filter(|(_, u, d, _)| u == &me && d == &dev).collect();
                let more = mine.len() > limit;
                let page: Vec<Value> = mine.iter().take(limit).map(|x| x.3.clone()).collect();
                let td_next = mine.iter().take(limit).last().map(|x| x.0).unwrap_or(td_since);
                let changed: BTreeSet<String> = match dc_since {
                    None => BTreeSet::new(),
                    Some(s) => st.dc.iter().filter(|(id, u)| *id > s && st.shares(&me, u)).map(|x| x.1.clone()).collect(),
                };
                let n = st.otks.get(&(me.clone(), dev.clone())).map(|q| q.len()).unwrap_or(0);
                let fb: Vec<&str> = if st.fallback.contains_key(&(me.clone(), dev.clone())) { vec!["signed_curve25519"] } else { vec![] };
                ok(json!({
                    "to_device": page, "td_next": td_next.to_string(), "more": more,
                    "device_lists": {"changed": changed, "left": []}, "dc_next": st.dc_seq.to_string(),
                    "one_time_key_counts": {"signed_curve25519": n}, "unused_fallback_key_types": fb,
                }))
            }
            "device_delete" => {
                let d = b["device_id"].as_str().unwrap_or("").to_string();
                if st.devices.get_mut(&me).and_then(|x| x.remove(&d)).is_none() {
                    return err(400, "e2ee5_bad_request");
                }
                st.otks.remove(&(me.clone(), d.clone()));
                st.fallback.remove(&(me.clone(), d.clone()));
                st.td.retain(|(_, u, dd, _)| !(u == &me && dd == &d));
                st.bearers.retain(|_, (u, dd)| !(u == &me && dd == &d));
                st.device_change(&me);
                ok(json!({}))
            }
            "backup_version_create" => {
                st.backup_seq += 1;
                let v = st.backup_seq.to_string();
                st.backup = Some((v.clone(), b.clone(), BTreeMap::new()));
                ok(json!({"version": v}))
            }
            "backup_version_get" => match &st.backup {
                Some((v, info, rooms)) => ok(json!({"version": v, "algorithm": info["algorithm"], "auth_data": info["auth_data"], "count": rooms.values().map(|r| r.len()).sum::<usize>(), "etag": "1"})),
                None => err(404, "e2ee5_no_backup"),
            },
            "backup_version_delete" => {
                st.backup = None;
                ok(json!({}))
            }
            "backup_keys_put" => {
                let Some((v, _, rooms)) = st.backup.as_mut() else { return err(404, "e2ee5_no_backup") };
                if b["version"].as_str() != Some(v.as_str()) {
                    return err(403, "e2ee5_wrong_backup_version");
                }
                for (room, r) in b["rooms"].as_object().into_iter().flatten() {
                    for (sid, kd) in r["sessions"].as_object().into_iter().flatten() {
                        let e = rooms.entry(room.clone()).or_default();
                        let better = e.get(sid).map(|old| kd["first_message_index"].as_u64() < old["first_message_index"].as_u64()).unwrap_or(true);
                        if better {
                            e.insert(sid.clone(), kd.clone());
                        }
                    }
                }
                let count: usize = rooms.values().map(|r| r.len()).sum();
                ok(json!({"etag": count.to_string(), "count": count}))
            }
            "backup_keys_get" => {
                let Some((v, _, rooms)) = &st.backup else { return err(404, "e2ee5_no_backup") };
                if b["version"].as_str() != Some(v.as_str()) {
                    return err(403, "e2ee5_wrong_backup_version");
                }
                let out: Map<String, Value> = rooms.iter().map(|(r, s)| (r.clone(), json!({"sessions": s}))).collect();
                ok(json!({"rooms": out}))
            }
            "secret_storage_put" => {
                st.secret = Some(b.clone());
                ok(json!({}))
            }
            "secret_storage_get" => match &st.secret {
                Some(s) => ok(s.clone()),
                None => err(404, "e2ee5_no_backup"),
            },
            "link_create" => {
                let mut r = [0u8; 16];
                getrandom::getrandom(&mut r).unwrap();
                let id: String = r.iter().map(|b| format!("{b:02x}")).collect();
                st.links.insert(id.clone(), Link::default());
                ok(json!({"link_id": id, "expires_in": 120}))
            }
            "link_post" => {
                let id = b["link_id"].as_str().unwrap_or("");
                let side = b["side"].as_str().unwrap_or("");
                let seq = b["seq"].as_u64().unwrap_or(0);
                let data = b["data"].as_str().unwrap_or("").to_string();
                let Some(l) = st.links.get_mut(id) else { return err(410, "e2ee5_link_expired") };
                match side {
                    "p" => {
                        if me.is_empty() { return err(401, "unauthorized"); }
                        if l.owner.get_or_insert(me.clone()) != &me { return err(403, "e2ee5_link_forbidden"); }
                        if l.p.last().map(|x| x.0 >= seq).unwrap_or(false) { return err(409, "e2ee5_link_seq"); }
                        l.p.push((seq, data));
                    }
                    "w" => {
                        if l.w.last().map(|x| x.0 >= seq).unwrap_or(false) { return err(409, "e2ee5_link_seq"); }
                        l.w.push((seq, data));
                    }
                    _ => return err(400, "e2ee5_bad_request"),
                }
                ok(json!({}))
            }
            "link_poll" => {
                let id = b["link_id"].as_str().unwrap_or("");
                let side = b["side"].as_str().unwrap_or("");
                let after = b["after"].as_u64().unwrap_or(0);
                let Some(l) = st.links.get(id) else { return err(410, "e2ee5_link_expired") };
                let src = match side {
                    "p" => &l.p,
                    "w" => {
                        if l.owner.as_deref() != Some(me.as_str()) { return err(403, "e2ee5_link_forbidden"); }
                        &l.w
                    }
                    _ => return err(400, "e2ee5_bad_request"),
                };
                let msgs: Vec<Value> = src.iter().filter(|x| x.0 > after).map(|x| json!({"seq": x.0, "data": x.1})).collect();
                ok(json!({"msgs": msgs, "state": "open"}))
            }
            "link_finish" => {
                let id = b["link_id"].as_str().unwrap_or("");
                let d = b["device_id"].as_str().unwrap_or("").to_string();
                let Some(l) = st.links.get(id) else { return err(410, "e2ee5_link_expired") };
                if l.owner.as_deref() != Some(me.as_str()) { return err(403, "e2ee5_link_forbidden"); }
                let mut r = [0u8; 16];
                getrandom::getrandom(&mut r).unwrap();
                let bearer: String = r.iter().map(|b| format!("{b:02x}")).collect();
                st.bearers.insert(bearer.clone(), (me.clone(), d));
                ok(json!({"bearer": bearer}))
            }
            "metrics" => ok(json!({})),
            _ => err(400, "e2ee5_bad_request"),
        }
    }
}

/// Transporte de um cliente: simula bearer + X-E2EE-Device.
pub struct ClientTransport {
    pub server: Arc<FakeServer>,
    pub user: Mutex<Option<String>>,
    pub device: Mutex<String>,
    pub offline: std::sync::atomic::AtomicBool,
}

impl ClientTransport {
    pub fn new(server: &Arc<FakeServer>, uid: Option<&str>, device: &str) -> Arc<ClientTransport> {
        Arc::new(ClientTransport {
            server: server.clone(),
            user: Mutex::new(uid.map(uid_user)),
            device: Mutex::new(device.to_string()),
            offline: Default::default(),
        })
    }
    /// Instala um bearer emitido pelo `link_finish`.
    pub fn install_bearer(&self, bearer: &str) {
        let st = self.server.st.lock().unwrap();
        let (u, d) = st.bearers.get(bearer).cloned().expect("bearer desconhecido");
        *self.user.lock().unwrap() = Some(u);
        *self.device.lock().unwrap() = d;
    }
}

#[async_trait::async_trait]
impl HttpTransport for ClientTransport {
    async fn call(&self, action: String, body_json: String) -> Result<HttpResponse, TransportError> {
        if self.offline.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(TransportError::Network { msg: "offline".into() });
        }
        let body: Value = serde_json::from_str(&body_json).map_err(|e| TransportError::Network { msg: e.to_string() })?;
        let user = self.user.lock().unwrap().clone();
        let dev = self.device.lock().unwrap().clone();
        let caller = user.as_deref().map(|u| (u, dev.as_str()));
        Ok(self.server.handle(&action, &body, caller))
    }
}
