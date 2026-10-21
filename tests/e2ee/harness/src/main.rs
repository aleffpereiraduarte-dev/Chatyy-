//! WP-18 — regressão E2EE v5 ponta a ponta.
//!
//! OlmMachine REAL (matrix-sdk-crypto =0.18.0, o mesmo motor do `chatyy-crypto`) falando com o
//! `e2ee5.php` REAL (https://chatyy.com.br/api/email.php?action=e2ee5_*) com as contas de QA
//! apitest@onemundo.com.br (A) e qa2@chatyy.com.br (B). Nunca usuários reais.
//!
//! Uso (o `tests/e2ee/run.sh` faz tudo isso):
//!   TOK_A=<arquivo bearer A> TOK_B=<arquivo bearer B> [OUT_JSON=arq] [E2EE_TEST_CONV=<id>] cargo run --release
//!
//! Cenários (cada um vira uma linha OK / FALHOU / PENDENTE no relatório):
//!   S*  status, allowlist, bearer inválido.
//!   R1  1:1 A→B (celular + web assinado) e 2ª mensagem sem nova troca de chave.
//!   R2  aparelho NÃO assinado: (a) como destino não recebe a chave Megolm; (b) como remetente é
//!       recusado por quem exige CrossSigned; (c) servidor recusa device_keys adulterado e
//!       device_keys de outro usuário.
//!   R3  perda de aparelho: o principal revoga o web → o web não sincroniza mais, a sessão
//!       Megolm rotaciona, a chave nova não vai para o aparelho perdido, e as mensagens ANTIGAS
//!       continuam legíveis no aparelho que ficou.
//!   R4  mensagens antigas em texto (conversa QA 971) continuam legíveis pela API atual.
//!   R5  rebaixamento bloqueado: set:0 sem confirm recusado; texto puro em conversa e2ee_mode=1
//!       recusado (só com E2EE_TEST_CONV apontando para uma conversa QA já cifrada).
//!   R6  beacon de métricas aceito pelo servidor (plataforma "qa", ignorada pelo gate).
//!   T*  tempos: 1ª mensagem (claim+share+encrypt), encrypt p50/p95 com sessão pronta, decrypt p50.
//! Limpeza: revoga SEMPRE os aparelhos criados (prefixo XRG), mesmo se algo falhar.
//!
//! Tolerante a duas formas de resposta: a do CONTRATO (§4.2.8 td_next/dc_next…) e a do e2ee5.php
//! de 21/10 (to_device_next/device_changes_next…). Cada divergência vai para "divergencias" no JSON.
//! Nunca imprime conteúdo de to-device, chave ou bearer — só ids, contagens e tempos.
use std::collections::BTreeMap;
use std::process::Command;
use std::time::Instant;

use anyhow::{anyhow, bail, Result};
use matrix_sdk_crypto::{
    types::requests::{AnyOutgoingRequest, ToDeviceRequest},
    CollectStrategy, DecryptionSettings, EncryptionSettings, EncryptionSyncChanges, OlmMachine,
    TrustRequirement,
};
use ruma::{
    api::client::sync::sync_events::DeviceLists,
    api::{
        client::keys::{claim_keys, get_keys, upload_keys, upload_signatures},
        client::to_device::send_event_to_device,
        IncomingResponse,
    },
    events::AnyToDeviceEvent,
    serde::Raw,
    to_device::DeviceIdOrAllDevices,
    DeviceId, OneTimeKeyAlgorithm, OwnedDeviceId, OwnedRoomId, OwnedUserId, RoomId, UInt, UserId,
};
use serde_json::{json, Value};

const DEV_PREFIX: &str = "XRG"; // aparelhos deste harness ("RG" = regressão; limpeza só mexe nestes)

fn base() -> String {
    std::env::var("E2EE5_BASE").unwrap_or_else(|_| "https://chatyy.com.br/api/email.php?action=".into())
}

// ───────────────────────── relatório ─────────────────────────

#[derive(Default)]
struct Report {
    rows: Vec<Value>,
    divergences: Vec<String>,
    timings: serde_json::Map<String, Value>,
}
impl Report {
    fn put(&mut self, id: &str, status: &str, what: &str, detail: &str) {
        println!("  [{status:<8}] {id:<4} {what}{}", if detail.is_empty() { String::new() } else { format!("  ({detail})") });
        self.rows.push(json!({"id": id, "status": status, "what": what, "detail": detail}));
    }
    fn check(&mut self, id: &str, cond: bool, what: &str, detail: &str) {
        self.put(id, if cond { "OK" } else { "FALHOU" }, what, detail);
    }
    fn pending(&mut self, id: &str, what: &str, why: &str) { self.put(id, "PENDENTE", what, why); }
    fn diverge(&mut self, s: String) {
        if !self.divergences.contains(&s) { println!("  (divergência do contrato) {s}"); self.divergences.push(s); }
    }
    fn failed(&self) -> usize { self.rows.iter().filter(|r| r["status"] == "FALHOU").count() }
}

// ───────────────────────── transporte (curl, sem TLS próprio) ─────────────────────────

fn scratch() -> String { std::env::var("SCRATCH").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().into()) }

fn call(tok: &str, dev: &str, action: &str, body: &Value) -> Result<(u16, Value)> {
    let dir = scratch();
    let tag = format!("{}-{}", std::process::id(), rand::random::<u32>());
    let f = format!("{dir}/e5q-body-{tag}.json");
    let hf = format!("{dir}/e5q-hdr-{tag}.txt");
    std::fs::write(&f, serde_json::to_vec(body)?)?;
    // Os dois nomes de cabeçalho: CONTRATO §4.1 (X-E2EE-Device) e o e2ee5.php de 21/10 (X-E2EE5-Device).
    let mut h = format!("Authorization: Bearer {tok}\nContent-Type: application/json\nUser-Agent: chatyy-e2ee5-qa-wp18\n");
    if !dev.is_empty() { h.push_str(&format!("X-E2EE-Device: {dev}\nX-E2EE5-Device: {dev}\n")); }
    std::fs::write(&hf, h)?;
    let out = Command::new("curl")
        .args(["-s", "-m", "30", "-w", "\n%{http_code}", "-X", "POST", &format!("{}{action}", base()), "-H", &format!("@{hf}"), "--data-binary", &format!("@{f}")])
        .output();
    let _ = std::fs::remove_file(&hf);
    let _ = std::fs::remove_file(&f);
    let out = out?;
    let s = String::from_utf8_lossy(&out.stdout).to_string();
    let (b, code) = s.rsplit_once('\n').ok_or(anyhow!("{action}: sem resposta"))?;
    let code: u16 = code.trim().parse().unwrap_or(0);
    let v: Value = serde_json::from_str(b).unwrap_or_else(|_| json!({"success": false, "raw": &b[..b.len().min(160)]}));
    Ok((code, v))
}

fn err_code(v: &Value) -> String {
    let msg: String = v["message"].as_str().unwrap_or("").chars().take(80).collect();
    for k in ["code", "errcode"] {
        if let Some(s) = v["data"][k].as_str() { return if msg.is_empty() || msg == s { s.to_string() } else { format!("{s}: {msg}") }; }
    }
    msg
}

fn data(tok: &str, dev: &str, action: &str, body: &Value) -> Result<Value> {
    let (code, v) = call(tok, dev, action, body)?;
    if code != 200 || v["success"] != json!(true) { bail!("{action} → HTTP {code} {}", err_code(&v)); }
    Ok(v["data"].clone())
}

fn resp<R: IncomingResponse>(v: Value) -> Result<R> {
    let body = serde_json::to_vec(&v)?;
    R::try_from_http_response(http::Response::builder().status(200).body(body)?).map_err(|e| anyhow!("{e:?}"))
}

fn new_dev_id(kind: char) -> OwnedDeviceId {
    // ^[PWTX][A-Z2-7]{12}$ (CONTRATO §1.3): X = testes; "RG" marca este harness.
    const B32: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let tail: String = (0..9).map(|_| B32[rand::random::<usize>() % 32] as char).collect();
    OwnedDeviceId::from(format!("{DEV_PREFIX}{kind}{tail}"))
}

// ───────────────────────── par (aparelho de teste) ─────────────────────────

struct Peer {
    name: &'static str,
    tok: String,
    m: OlmMachine,
    td: Value, // cursor to-device (string no contrato, int no PHP de 21/10)
    dc: Value,
    revoked: bool,
}

/// Último lote de to-device enviado: destinos por tipo (para conferir quem recebeu a chave).
#[derive(Default, Clone)]
struct Sent { encrypted_to: Vec<(String, String)>, withheld_to: Vec<(String, String)>, bytes: usize }

impl Peer {
    async fn new(name: &'static str, tok: &str, uid: &UserId, kind: char) -> Peer {
        Peer { name, tok: tok.into(), m: OlmMachine::new(uid, &new_dev_id(kind)).await, td: json!(""), dc: json!(""), revoked: false }
    }
    fn dev(&self) -> String { self.m.device_id().to_string() }

    async fn pump(&mut self, rep: &mut Report) -> Result<Sent> {
        let mut sent = Sent::default();
        for _ in 0..8 {
            let reqs = self.m.outgoing_requests().await?;
            if reqs.is_empty() { break; }
            for r in reqs { let s = self.handle(r.request_id(), r.request(), rep).await?; sent.merge(s); }
        }
        Ok(sent)
    }

    async fn handle(&mut self, id: &ruma::TransactionId, req: &AnyOutgoingRequest, rep: &mut Report) -> Result<Sent> {
        let (t, d) = (self.tok.clone(), self.dev());
        match req {
            AnyOutgoingRequest::KeysUpload(r) => {
                let mut b = json!({});
                if let Some(dk) = &r.device_keys { b["device_keys"] = serde_json::to_value(dk)?; b["platform"] = json!("qa"); b["label"] = json!("WP-18 QA"); }
                if !r.one_time_keys.is_empty() { b["one_time_keys"] = serde_json::to_value(&r.one_time_keys)?; }
                if !r.fallback_keys.is_empty() { b["fallback_keys"] = serde_json::to_value(&r.fallback_keys)?; }
                let x = data(&t, &d, "e2ee5_keys_upload", &b)?;
                if x["rejected"].as_i64().unwrap_or(0) > 0 { bail!("{}: servidor rejeitou {} chaves bem assinadas", self.name, x["rejected"]); }
                let rr: upload_keys::v3::Response = resp(json!({"one_time_key_counts": x["one_time_key_counts"]}))?;
                self.m.mark_request_as_sent(id, &rr).await?;
            }
            AnyOutgoingRequest::KeysQuery(r) => {
                let x = data(&t, &d, "e2ee5_keys_query", &json!({"device_keys": serde_json::to_value(&r.device_keys)?}))?;
                let rr: get_keys::v3::Response = resp(x)?;
                self.m.mark_request_as_sent(id, &rr).await?;
            }
            AnyOutgoingRequest::KeysClaim(r) => {
                let x = data(&t, &d, "e2ee5_keys_claim", &json!({"one_time_keys": serde_json::to_value(&r.one_time_keys)?}))?;
                let rr: claim_keys::v3::Response = resp(json!({"one_time_keys": x["one_time_keys"], "failures": {}}))?;
                self.m.mark_request_as_sent(id, &rr).await?;
            }
            AnyOutgoingRequest::ToDeviceRequest(r) => return self.to_device(id, r, rep).await,
            AnyOutgoingRequest::SignatureUpload(r) => {
                let x = data(&t, &d, "e2ee5_signatures_upload", &serde_json::to_value(&r.signed_keys)?)?;
                if x["failures"].as_object().map(|o| !o.is_empty()).unwrap_or(false) { bail!("signatures_upload: {}", x["failures"]); }
                let rr: upload_signatures::v3::Response = resp(json!({"failures": {}}))?;
                self.m.mark_request_as_sent(id, &rr).await?;
            }
            _ => {}
        }
        Ok(Sent::default())
    }

    async fn to_device(&mut self, id: &ruma::TransactionId, r: &ToDeviceRequest, rep: &mut Report) -> Result<Sent> {
        let mut msgs = serde_json::Map::new();
        let mut s = Sent::default();
        let et = r.event_type.to_string();
        for (u, devs) in &r.messages {
            let mut um = serde_json::Map::new();
            for (dv, c) in devs {
                let k = match dv { DeviceIdOrAllDevices::DeviceId(d) => d.to_string(), _ => "*".into() };
                s.bytes += c.json().get().len();
                if et == "m.room.encrypted" { s.encrypted_to.push((u.to_string(), k.clone())); } else { s.withheld_to.push((u.to_string(), k.clone())); }
                um.insert(k, serde_json::from_str(c.json().get())?);
            }
            msgs.insert(u.to_string(), Value::Object(um));
        }
        let body = json!({"event_type": et, "txn_id": r.txn_id.to_string(), "messages": msgs});
        let (code, v) = call(&self.tok, &self.dev(), "e2ee5_to_device_send", &body)?;
        if code != 200 || v["success"] != json!(true) {
            if et == "m.room.encrypted" { bail!("to_device_send m.room.encrypted → HTTP {code} {}", err_code(&v)); }
            // CONTRATO §4.2.7 aceita m.room_key.withheld; se o PHP recusar, registramos e seguimos.
            rep.diverge(format!("to_device_send recusou event_type={et} (HTTP {code} {})", err_code(&v)));
        }
        let rr: send_event_to_device::v3::Response = resp(json!({}))?;
        self.m.mark_request_as_sent(id, &rr).await?;
        Ok(s)
    }

    /// e2ee5_sync (formato do contrato OU do PHP de 21/10) → receive_sync_changes.
    async fn sync(&mut self, rep: &mut Report) -> Result<usize> {
        let body = json!({"td_since": self.td, "dc_since": self.dc, "limit": 200,
                          "to_device_since": self.td.as_i64().or_else(|| self.td.as_str().and_then(|s| s.parse().ok())).unwrap_or(0),
                          "device_changes_since": self.dc.as_i64().or_else(|| self.dc.as_str().and_then(|s| s.parse().ok())).unwrap_or(0)});
        let x = data(&self.tok, &self.dev(), "e2ee5_sync", &body)?;
        let pick = |a: &str, b: &str, rep: &mut Report| -> Value {
            if !x[a].is_null() { x[a].clone() } else { if !x[b].is_null() { rep.diverge(format!("sync: campo `{b}` no lugar de `{a}`")); } x[b].clone() }
        };
        let tdn = pick("td_next", "to_device_next", rep);
        let dcn = pick("dc_next", "device_changes_next", rep);
        if !tdn.is_null() { self.td = tdn; }
        if !dcn.is_null() { self.dc = dcn; }
        let evs_v = if x["to_device"].is_array() { x["to_device"].clone() } else {
            if x["to_device"]["events"].is_array() { rep.diverge("sync: `to_device.events` no lugar de `to_device` (array)".into()); }
            x["to_device"]["events"].clone()
        };
        let evs: Vec<Raw<AnyToDeviceEvent>> = evs_v.as_array().cloned().unwrap_or_default().into_iter()
            .filter_map(|v| serde_json::value::to_raw_value(&v).ok().map(Raw::from_json)).collect();
        let mut dl = DeviceLists::new();
        dl.changed = x["device_lists"]["changed"].as_array().cloned().unwrap_or_default().iter()
            .filter_map(|u| u.as_str().and_then(|s| UserId::parse(s).ok())).collect();
        dl.left = x["device_lists"]["left"].as_array().cloned().unwrap_or_default().iter()
            .filter_map(|u| u.as_str().and_then(|s| UserId::parse(s).ok())).collect();
        let otk = pick("one_time_key_counts", "device_one_time_keys_count", rep);
        let n = otk["signed_curve25519"].as_u64().unwrap_or(0);
        let counts = BTreeMap::from([(OneTimeKeyAlgorithm::SignedCurve25519, UInt::new(n).unwrap_or_default())]);
        let fbv = pick("unused_fallback_key_types", "device_unused_fallback_key_types", rep);
        let fb: Vec<OneTimeKeyAlgorithm> = fbv.as_array().cloned().unwrap_or_default().iter().filter_map(|a| a.as_str().map(OneTimeKeyAlgorithm::from)).collect();
        let k = evs.len();
        let ds = DecryptionSettings { sender_device_trust_requirement: TrustRequirement::Untrusted };
        self.m.receive_sync_changes(EncryptionSyncChanges { to_device_events: evs, changed_devices: &dl, one_time_keys_counts: &counts, unused_fallback_keys: Some(&fb), next_batch_token: None }, &ds).await?;
        self.pump(rep).await?;
        Ok(k)
    }

    async fn bootstrap_xsign(&mut self, rep: &mut Report) -> Result<()> {
        let reqs = self.m.bootstrap_cross_signing(false).await?;
        if let Some(r) = reqs.upload_keys_req { self.handle(r.request_id(), r.request(), rep).await?; }
        let up = &reqs.upload_signing_keys_req;
        data(&self.tok, &self.dev(), "e2ee5_signing_keys_upload", &json!({"master_key": up.master_key, "self_signing_key": up.self_signing_key, "user_signing_key": up.user_signing_key}))?;
        let x = data(&self.tok, &self.dev(), "e2ee5_signatures_upload", &serde_json::to_value(&reqs.upload_signatures_req.signed_keys)?)?;
        if x["failures"].as_object().map(|o| !o.is_empty()).unwrap_or(false) { bail!("{}: signatures_upload: {}", self.name, x["failures"]); }
        Ok(())
    }

    /// Encripta `body` na sala; devolve (envelope JSON do conteúdo, session_id, ms).
    async fn encrypt(&self, room: &RoomId, body: &str, mid: &str) -> Result<(String, String, f64)> {
        let content = json!({"msgtype": "m.text", "body": body, "chatyy": {"mid": mid}});
        let t = Instant::now();
        let enc = self.m.encrypt_room_event_raw(room, "m.room.message", &Raw::from_json(serde_json::value::to_raw_value(&content)?)).await?;
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let s = enc.content.json().get().to_string();
        let sid = serde_json::from_str::<Value>(&s)?["session_id"].as_str().unwrap_or("").to_string();
        Ok((s, sid, ms))
    }

    async fn share(&mut self, room: &RoomId, users: &[&UserId], rep: &mut Report) -> Result<Sent> {
        self.share_with(room, users, CollectStrategy::IdentityBasedStrategy, rep).await
    }

    /// `strategy` = IdentityBasedStrategy (política do Chatyy) ou AllDevices (cliente adulterado).
    async fn share_with(&mut self, room: &RoomId, users: &[&UserId], strategy: CollectStrategy, rep: &mut Report) -> Result<Sent> {
        if let Some((id, req)) = self.m.get_missing_sessions(users.iter().copied()).await? {
            self.handle(&id, &AnyOutgoingRequest::KeysClaim(req), rep).await?;
        }
        let settings = EncryptionSettings { sharing_strategy: strategy, ..Default::default() };
        let reqs = self.m.share_room_key(room, users.iter().copied(), settings).await?;
        let mut all = Sent::default();
        for r in reqs { let s = self.to_device(&r.txn_id.clone(), &r, rep).await?; all.merge(s); }
        Ok(all)
    }

    /// Decifra; Ok(body) ou Err(motivo curto).
    async fn decrypt(&self, room: &RoomId, sender: &UserId, env: &str, mid: &str, trust: TrustRequirement) -> std::result::Result<String, String> {
        let ev = json!({"type": "m.room.encrypted", "sender": sender.to_string(), "event_id": format!("$m{mid}"), "origin_server_ts": 1,
                        "room_id": room.to_string(), "content": serde_json::from_str::<Value>(env).map_err(|e| e.to_string())?});
        let raw = Raw::from_json(serde_json::value::to_raw_value(&ev).map_err(|e| e.to_string())?);
        let ds = DecryptionSettings { sender_device_trust_requirement: trust };
        match self.m.decrypt_room_event(&raw, room, &ds).await {
            Ok(d) => serde_json::from_str::<Value>(d.event.json().get()).ok().and_then(|v| v["content"]["body"].as_str().map(String::from)).ok_or_else(|| "sem body".into()),
            Err(e) => Err(format!("{e}").chars().take(90).collect()),
        }
    }
}

impl Sent {
    fn merge(&mut self, o: Sent) { self.encrypted_to.extend(o.encrypted_to); self.withheld_to.extend(o.withheld_to); self.bytes += o.bytes; }
    fn got_key(&self, u: &UserId, d: &str) -> bool { self.encrypted_to.iter().any(|(uu, dd)| uu == u.as_str() && (dd == d || dd == "*")) }
}

async fn sign_own_device(phone: &mut Peer, other: &DeviceId, rep: &mut Report) -> Result<()> {
    phone.m.update_tracked_users([phone.m.user_id()]).await?;
    phone.pump(rep).await?;
    phone.sync(rep).await?;
    let dev = phone.m.get_device(phone.m.user_id(), other, None).await?.ok_or(anyhow!("aparelho {other} não visto pelo celular"))?;
    let req = dev.verify().await?;
    let x = data(&phone.tok, &phone.dev(), "e2ee5_signatures_upload", &serde_json::to_value(&req.signed_keys)?)?;
    if x["failures"].as_object().map(|o| !o.is_empty()).unwrap_or(false) { bail!("assinar aparelho: {}", x["failures"]); }
    Ok(())
}

fn pct(v: &mut [f64], p: f64) -> f64 {
    if v.is_empty() { return 0.0; }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

fn device_ids(list: &Value) -> Vec<(String, bool)> {
    list["devices"].as_array().cloned().unwrap_or_default().iter()
        .filter_map(|d| d["device_id"].as_str().map(|s| (s.to_string(), d["revoked"].as_bool().unwrap_or(false) || !d["revoked_at"].is_null() && d.get("revoked_at").is_some())))
        .collect()
}

fn revoke(tok: &str, dev: &str, target: &str) -> Result<(u16, Value)> {
    // CONTRATO §4.2.9 = {"device_id"}; PHP de 21/10 = {"target_device_id"}. Mandamos os dois.
    call(tok, dev, "e2ee5_device_delete", &json!({"device_id": target, "target_device_id": target}))
}

/// Revoga aparelhos XRG* esquecidos por execuções anteriores (só deste harness).
fn cleanup_leftovers(tok: &str, who: &str) -> usize {
    let Ok(l) = data(tok, "", "e2ee5_devices_list", &json!({})) else { return 0 };
    let mut n = 0;
    for (d, revoked) in device_ids(&l) {
        if d.starts_with(DEV_PREFIX) && !revoked {
            if revoke(tok, &d, &d).map(|(c, _)| c == 200).unwrap_or(false) { n += 1; }
        }
    }
    if n > 0 { println!("  (limpeza prévia {who}: {n} aparelho(s) XRG de execuções anteriores revogados)"); }
    n
}

// ───────────────────────── cenários ─────────────────────────

async fn run(rep: &mut Report, ta: &str, tb: &str, peers: &mut Vec<Peer>) -> Result<()> {
    println!("S) status, allowlist e autenticação");
    let sa = data(ta, "", "e2ee5_status", &json!({}))?;
    let sb = data(tb, "", "e2ee5_status", &json!({}))?;
    let allowed = |s: &Value| s["allowed"] == json!(true) || (s["allowed"].is_null() && s["enabled"] == json!(true));
    rep.check("S1", allowed(&sa) && allowed(&sb), "contas QA na allowlist (e2ee5_status)", &format!("A={} B={}", sa["user_id"], sb["user_id"]));
    if sa["contract"].is_null() { rep.diverge("status: falta `contract` (CONTRATO §4.2.1)".into()); }
    let (code, v) = call("0000invalido0000", "", "e2ee5_keys_query", &json!({"device_keys": {}}))?;
    rep.check("S2", code == 401 || code == 403, "bearer inválido é recusado", &format!("HTTP {code} {}", err_code(&v)));
    if !(allowed(&sa) && allowed(&sb)) { bail!("contas QA fora da allowlist — nada mais a testar"); }
    let ua: OwnedUserId = UserId::parse(sa["user_id"].as_str().ok_or(anyhow!("user_id A"))?)?;
    let ub: OwnedUserId = UserId::parse(sb["user_id"].as_str().ok_or(anyhow!("user_id B"))?)?;
    cleanup_leftovers(ta, "A");
    cleanup_leftovers(tb, "B");

    // Sala de teste: a conversa QA cifrada (se houver) ou 971 (só como id de sala Megolm; o
    // servidor não guarda estado de sala no e2ee5 — nada muda na conversa 971).
    let conv = std::env::var("E2EE_TEST_CONV").ok().filter(|s| s.chars().all(|c| c.is_ascii_digit()) && !s.is_empty()).unwrap_or_else(|| "971".into());
    let room: OwnedRoomId = RoomId::parse(format!("!c{conv}:chatyy"))?;
    let users_ab = [ua.as_ref(), ub.as_ref()];

    println!("Setup) A1 celular principal, B1 celular principal, B2 web (assinado pelo B1)");
    let t0 = Instant::now();
    peers.push(Peer::new("A1/celular", ta, &ua, 'P').await);
    peers.push(Peer::new("B1/celular", tb, &ub, 'P').await);
    peers.push(Peer::new("B2/web", tb, &ub, 'W').await);
    {
        let (a1, rest) = peers.split_at_mut(1);
        let (b1, b2) = rest.split_at_mut(1);
        let (a1, b1, b2) = (&mut a1[0], &mut b1[0], &mut b2[0]);
        a1.bootstrap_xsign(rep).await?;
        b1.bootstrap_xsign(rep).await?;
        for p in [&mut *a1, &mut *b1, &mut *b2] { p.pump(rep).await?; p.sync(rep).await?; }
        let b2dev = b2.m.device_id().to_owned();
        sign_own_device(b1, &b2dev, rep).await?;
        for p in [&mut *a1, &mut *b1, &mut *b2] { p.m.update_tracked_users(users_ab).await?; p.pump(rep).await?; }
    }
    rep.timings.insert("setup_ms".into(), json!(t0.elapsed().as_millis()));

    // ── R1: 1:1 ──
    println!("R1) 1:1 A→B (celular + web assinado)");
    let (a1i, b1i, b2i) = (0usize, 1usize, 2usize);
    let b2dev = peers[b2i].dev();
    let web_signed = peers[a1i].m.get_device(&ub, &OwnedDeviceId::from(b2dev.clone()), None).await?.map(|d| d.is_cross_signed_by_owner()).unwrap_or(false);
    rep.check("R1a", web_signed, "web do B aparece ASSINADO pela SSK do B para A", "");
    let t1 = Instant::now();
    let sent1 = { let a1 = &mut peers[a1i]; a1.share(&room, &users_ab, rep).await? };
    let (env1, sid1, _) = peers[a1i].encrypt(&room, "wp18 msg 1", "qa18-1").await?;
    let first_ms = t1.elapsed().as_secs_f64() * 1000.0;
    rep.timings.insert("first_msg_ms".into(), json!(first_ms.round()));
    rep.timings.insert("first_msg_to_device_bytes".into(), json!(sent1.bytes));
    rep.timings.insert("envelope_bytes".into(), json!(env1.len()));
    rep.check("R1b", env1.len() < 96 * 1024 && !env1.contains("wp18 msg 1"), "envelope opaco e < 96 KiB", &format!("{} B", env1.len()));
    for i in [b1i, b2i] {
        peers[i].sync(rep).await?;
        let r = peers[i].decrypt(&room, &ua, &env1, "qa18-1", TrustRequirement::CrossSigned).await;
        let name = peers[i].name;
        rep.check("R1c", r.as_deref() == Ok("wp18 msg 1"), &format!("{name} decifra (exigindo remetente assinado)"), &r.err().unwrap_or_default());
    }
    let again = { let a1 = &mut peers[a1i]; a1.share(&room, &users_ab, rep).await? };
    rep.check("R1d", again.encrypted_to.is_empty(), "2ª mensagem sem nova troca de chave", &format!("{} destinos", again.encrypted_to.len()));

    // Tempos com sessão pronta
    let (mut enc_ms, mut dec_ms) = (vec![], vec![]);
    let mut envs = vec![];
    for k in 0..20 {
        let (e, _, ms) = peers[a1i].encrypt(&room, &format!("wp18 t{k}"), &format!("qa18-t{k}")).await?;
        enc_ms.push(ms); envs.push(e);
    }
    for (k, e) in envs.iter().enumerate() {
        let t = Instant::now();
        let _ = peers[b1i].decrypt(&room, &ua, e, &format!("qa18-t{k}"), TrustRequirement::CrossSigned).await;
        dec_ms.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    rep.timings.insert("encrypt_p50_ms".into(), json!((pct(&mut enc_ms, 0.5) * 100.0).round() / 100.0));
    rep.timings.insert("encrypt_p95_ms".into(), json!((pct(&mut enc_ms, 0.95) * 100.0).round() / 100.0));
    rep.timings.insert("decrypt_p50_ms".into(), json!((pct(&mut dec_ms, 0.5) * 100.0).round() / 100.0));

    // ── R2: aparelho não assinado ──
    println!("R2) aparelho NÃO assinado (A2 = 2º aparelho do A, sem assinatura da SSK)");
    peers.push(Peer::new("A2/nao-assinado", ta, &ua, 'T').await);
    let a2i = peers.len() - 1;
    { let a2 = &mut peers[a2i]; a2.pump(rep).await?; a2.sync(rep).await?; a2.m.update_tracked_users(users_ab).await?; a2.pump(rep).await?; }
    // B1 descobre o A2 (lista de aparelhos do A mudou)
    peers[b1i].sync(rep).await?;
    peers[b1i].m.update_tracked_users(users_ab).await?;
    peers[b1i].pump(rep).await?;
    let a2dev = peers[a2i].dev();
    let seen = peers[b1i].m.get_device(&ua, &OwnedDeviceId::from(a2dev.clone()), None).await?;
    rep.check("R2a", seen.as_ref().map(|d| !d.is_cross_signed_by_owner()).unwrap_or(false), "B vê o A2 como NÃO assinado pelo dono", if seen.is_none() { "A2 não apareceu no keys_query" } else { "" });
    // (a) A2 como destino: B1 manda na sala; o A2 não pode receber a chave.
    let s2 = { let b1 = &mut peers[b1i]; b1.share(&room, &users_ab, rep).await? };
    let (env2, _, _) = peers[b1i].encrypt(&room, "wp18 msg 2", "qa18-2").await?;
    rep.check("R2b", !s2.got_key(&ua, &a2dev), "chave Megolm NÃO foi para o aparelho não assinado", &format!("cifrado p/ {} aparelho(s), withheld p/ {}", s2.encrypted_to.len(), s2.withheld_to.len()));
    rep.check("R2c", s2.got_key(&ua, &peers[a1i].dev()), "chave Megolm foi para o aparelho assinado do A", "");
    peers[a2i].sync(rep).await?;
    let r = peers[a2i].decrypt(&room, &ub, &env2, "qa18-2", TrustRequirement::Untrusted).await;
    rep.check("R2d", r.is_err(), "aparelho não assinado NÃO decifra", &r.err().unwrap_or_else(|| "decifrou!".into()));
    peers[a1i].sync(rep).await?;
    let r = peers[a1i].decrypt(&room, &ub, &env2, "qa18-2", TrustRequirement::CrossSigned).await;
    rep.check("R2e", r.as_deref() == Ok("wp18 msg 2"), "A1 (assinado) decifra a resposta de B", &r.err().unwrap_or_default());
    // (b) A2 como remetente: quem exige CrossSigned recusa.
    let room2: OwnedRoomId = RoomId::parse(format!("!c{conv}9:chatyy"))?; // sala separada p/ A2 ter sessão própria
    let own = { let a2 = &mut peers[a2i]; a2.share(&room2, &users_ab, rep).await };
    rep.check("R2f0", own.is_err(), "aparelho não assinado nem consegue cifrar com a política do Chatyy (IdentityBased)",
              &own.err().map(|e| format!("{e}").chars().take(80).collect::<String>()).unwrap_or_else(|| "cifrou!".into()));
    // Simula um cliente adulterado no aparelho não assinado (AllDevices): quem recebe tem de recusar.
    { let a2 = &mut peers[a2i]; a2.share_with(&room2, &users_ab, CollectStrategy::AllDevices, rep).await?; }
    let (env3, _, _) = peers[a2i].encrypt(&room2, "wp18 msg 3 (nao assinado)", "qa18-3").await?;
    peers[b1i].sync(rep).await?;
    let strict = peers[b1i].decrypt(&room2, &ua, &env3, "qa18-3", TrustRequirement::CrossSigned).await;
    let lax = peers[b1i].decrypt(&room2, &ua, &env3, "qa18-3", TrustRequirement::Untrusted).await;
    rep.check("R2f", strict.is_err(), "mensagem de aparelho não assinado é RECUSADA (CrossSigned)", &strict.err().unwrap_or_else(|| "aceitou!".into()));
    rep.check("R2g", lax.is_ok(), "…e a recusa é por confiança, não por falta de chave", &lax.err().unwrap_or_default());
    // (c) servidor recusa device_keys adulterado e de outro usuário.
    {
        let x = Peer::new("X/adulterado", ta, &ua, 'X').await;
        let reqs = x.m.outgoing_requests().await?;
        let mut dk: Option<Value> = None;
        for r in reqs { if let AnyOutgoingRequest::KeysUpload(u) = r.request() { if let Some(d) = &u.device_keys { dk = Some(serde_json::to_value(d)?); } } }
        if let Some(mut dk) = dk {
            let mut forged = dk.clone();
            if let Some(keys) = forged["keys"].as_object_mut() {
                for (k, v) in keys.iter_mut() { if k.starts_with("curve25519:") { *v = json!("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"); } }
            }
            let (code, v) = call(ta, &x.dev(), "e2ee5_keys_upload", &json!({"device_keys": forged}))?;
            rep.check("R2h", code >= 400, "servidor recusa device_keys com assinatura inválida", &format!("HTTP {code} {}", err_code(&v)));
            if code == 200 { let _ = revoke(ta, &x.dev(), &x.dev()); }
            // mesmo device_keys válido do A, mas enviado com o bearer do B
            dk["unsigned"] = json!({});
            let (code, v) = call(tb, &x.dev(), "e2ee5_keys_upload", &json!({"device_keys": dk}))?;
            rep.check("R2i", code >= 400, "servidor recusa device_keys de outro usuário", &format!("HTTP {code} {}", err_code(&v)));
            if code == 200 { let _ = revoke(tb, &x.dev(), &x.dev()); }
        } else { rep.pending("R2h", "device_keys adulterado", "OlmMachine não gerou keys_upload"); }
    }

    // ── R3: perda de aparelho ──
    println!("R3) perda de aparelho: o celular do B revoga o web (B2)");
    let (code, v) = revoke(&peers[b1i].tok.clone(), &peers[b1i].dev(), &b2dev)?;
    rep.check("R3a", code == 200, "principal revoga o aparelho vinculado", &format!("HTTP {code} {}", err_code(&v)));
    peers[b2i].revoked = code == 200;
    let (code, v) = call(&peers[b2i].tok.clone(), &b2dev, "e2ee5_sync", &json!({"td_since": "", "dc_since": ""}))?;
    rep.check("R3b", code >= 400, "aparelho revogado não sincroniza mais", &format!("HTTP {code} {}", err_code(&v)));
    let (code, _) = call(ta, &peers[a1i].dev(), "e2ee5_keys_claim", &json!({"one_time_keys": {ub.as_str(): {&b2dev: "signed_curve25519"}}}))
        .map(|(c, v)| (c, v.clone())).unwrap_or((0, json!({})));
    let _ = code;
    peers[a1i].sync(rep).await?;
    peers[a1i].pump(rep).await?;
    let still = peers[a1i].m.get_device(&ub, &OwnedDeviceId::from(b2dev.clone()), None).await?;
    rep.check("R3c", still.map(|d| d.is_deleted()).unwrap_or(true), "A deixa de ver o aparelho revogado (device_lists)", "");
    let s4 = { let a1 = &mut peers[a1i]; a1.share(&room, &users_ab, rep).await? };
    let (env4, sid4, _) = peers[a1i].encrypt(&room, "wp18 msg 4 pos-perda", "qa18-4").await?;
    rep.check("R3d", sid4 != sid1, "sessão Megolm rotacionou após a saída do aparelho", &format!("{}… → {}…", &sid1[..sid1.len().min(8)], &sid4[..sid4.len().min(8)]));
    rep.check("R3e", !s4.got_key(&ub, &b2dev), "chave nova NÃO foi para o aparelho perdido", &format!("{} destinos", s4.encrypted_to.len()));
    peers[b1i].sync(rep).await?;
    let r = peers[b1i].decrypt(&room, &ua, &env4, "qa18-4", TrustRequirement::CrossSigned).await;
    rep.check("R3f", r.as_deref() == Ok("wp18 msg 4 pos-perda"), "aparelho que ficou decifra a mensagem nova", &r.err().unwrap_or_default());
    let r = peers[b1i].decrypt(&room, &ua, &env1, "qa18-1", TrustRequirement::CrossSigned).await;
    rep.check("R3g", r.as_deref() == Ok("wp18 msg 1"), "mensagem ANTIGA (sessão anterior) continua legível", &r.err().unwrap_or_default());
    let r = peers[b2i].decrypt(&room, &ua, &env4, "qa18-4", TrustRequirement::Untrusted).await;
    rep.check("R3h", r.is_err(), "aparelho perdido não decifra a mensagem nova", &r.err().unwrap_or_else(|| "decifrou!".into()));

    // ── R4: mensagens antigas em texto ──
    println!("R4) conversa QA 971: mensagens antigas em texto legíveis pela API atual");
    let (code, v) = call(ta, "", "chat_messages", &json!({"conversation_id": 971, "limit": 50}))?;
    let msgs = v["data"]["messages"].as_array().or_else(|| v["data"].as_array()).cloned().unwrap_or_default();
    let text = msgs.iter().filter(|m| m["content"].as_str().map(|s| !s.is_empty() && !s.starts_with("{\"e2e\"")).unwrap_or(false)).count();
    let env_rows = msgs.iter().filter(|m| m["content"].as_str().map(|s| s.starts_with("{\"e2e\"")).unwrap_or(false)).count();
    rep.check("R4a", code == 200 && text > 0, "chat_messages devolve as mensagens em texto (legado legível)", &format!("HTTP {code}, {text} em texto, {env_rows} envelope(s) de {}", msgs.len()));
    let st971 = data(ta, &peers[a1i].dev(), "e2ee5_conversation_state", &json!({"conv_id": "971", "conversation_id": 971}))?;
    let mode971 = st971["e2ee_mode"].as_i64().unwrap_or(0);
    rep.check("R4b", mode971 == 0, "conversa 971 (canário do rel-monitor, texto puro) segue e2ee_mode=0", &format!("e2ee_mode={mode971}"));

    // ── R5: rebaixamento ──
    println!("R5) rebaixamento bloqueado");
    let (code, v) = call(ta, &peers[a1i].dev(), "e2ee5_conversation_state", &json!({"conv_id": conv, "conversation_id": conv.parse::<i64>().unwrap_or(0), "set": 0}))?;
    let ec = err_code(&v);
    let refused = code >= 400 && (ec.contains("confirm") || ec.contains("e2ee5_not_e2ee"));
    let not_yet = code >= 400 && ec.contains("não existe");
    let ignored = code == 200 && v["data"]["e2ee_mode"].is_number() && v["data"].get("changed").is_none();
    if refused { rep.check("R5a", true, "set:0 sem confirm é recusado", &format!("HTTP {code} {ec}")); }
    else if not_yet { rep.pending("R5a", "set:0 sem confirm é recusado", &format!("servidor recusa todo `set` por ora: {ec}")); }
    else if ignored { rep.pending("R5a", "set:0 sem confirm é recusado", "servidor ainda não implementa `set` (WP-05/WP-07); respondeu só o estado"); }
    else { rep.check("R5a", false, "set:0 sem confirm é recusado", &format!("HTTP {code} {}", err_code(&v))); }
    let st = data(ta, &peers[a1i].dev(), "e2ee5_conversation_state", &json!({"conv_id": conv, "conversation_id": conv.parse::<i64>().unwrap_or(0)}))?;
    if st["e2ee_mode"].as_i64() == Some(1) && conv != "971" {
        let cmid = format!("qa18-plain-{}", rand::random::<u32>());
        let (code, v) = call(ta, "", "chat_send", &json!({"conversation_id": conv.parse::<i64>().unwrap_or(0), "content": "wp18 texto puro (deve ser recusado)", "type": "text", "client_message_id": cmid, "silent": 1}))?;
        rep.check("R5b", code >= 400 && err_code(&v).contains("plaintext"), "texto puro em conversa e2ee_mode=1 é recusado", &format!("HTTP {code} {}", err_code(&v)));
    } else {
        rep.pending("R5b", "texto puro em conversa e2ee_mode=1 é recusado", "sem conversa QA cifrada (E2EE_TEST_CONV) — depende do WP-07");
    }

    // ── R6: beacon de métricas ──
    println!("R6) beacon de métricas");
    let (code, v) = call(ta, &peers[a1i].dev(), "e2ee5_metrics", &json!({"platform": "qa", "app_version": "wp18", "encrypt": 21, "decrypt_ok": 21, "utd_json": "{}",
                       "counters": {"utd_60s": 0, "utd_resolved": 1, "enc_le50": 21, "missing_sessions": 1}}))?;
    rep.check("R6a", code == 200 && v["success"] == json!(true), "e2ee5_metrics aceita o snapshot do núcleo + counters do host (plataforma qa)", &format!("HTTP {code} {}", err_code(&v)));
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let ta = std::fs::read_to_string(std::env::var("TOK_A")?)?.trim().to_string();
    let tb = std::fs::read_to_string(std::env::var("TOK_B")?)?.trim().to_string();
    let mut rep = Report::default();
    let mut peers: Vec<Peer> = vec![];
    let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs();
    let res = run(&mut rep, &ta, &tb, &mut peers).await;
    if let Err(e) = &res { rep.put("ERRO", "FALHOU", "execução interrompida", &format!("{e}").chars().take(200).collect::<String>()); }

    println!("Limpeza) revoga os aparelhos de teste");
    let mut left = 0;
    for p in peers.iter().filter(|p| !p.revoked) {
        match revoke(&p.tok, &p.dev(), &p.dev()) { Ok((200, _)) => {}, _ => left += 1 }
    }
    cleanup_leftovers(&ta, "A");
    cleanup_leftovers(&tb, "B");
    rep.check("LIMPA", left == 0, "aparelhos de teste revogados", &format!("{left} restante(s)"));

    println!("Tempos: {}", Value::Object(rep.timings.clone()));
    let fails = rep.failed();
    let out = json!({"harness": "e2ee5-qa-harness/0.1", "started": started, "base": base(),
                     "result": if fails == 0 { "OK" } else { "FALHOU" }, "failed": fails,
                     "rows": rep.rows, "timings": rep.timings, "divergencias": rep.divergences});
    if let Ok(p) = std::env::var("OUT_JSON") { std::fs::write(p, serde_json::to_vec_pretty(&out)?)?; }
    println!("\nRESULTADO: {} ({} falha(s), {} pendente(s), {} divergência(s) do contrato)", out["result"].as_str().unwrap_or(""), fails,
             out["rows"].as_array().map(|r| r.iter().filter(|x| x["status"] == "PENDENTE").count()).unwrap_or(0), out["divergencias"].as_array().map(|d| d.len()).unwrap_or(0));
    if fails > 0 { std::process::exit(1); }
    Ok(())
}
