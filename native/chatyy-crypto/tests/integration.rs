//! Testes de integração do núcleo contra o servidor falso (CONTRATO §11).
//! Rodar: `cargo test --features testing -- --nocapture --test-threads=4`
mod common;

use chatyy_crypto::*;
use common::fake_server::*;
use common::*;
use serde_json::{json, Value};
use std::sync::Arc;

fn is_utd(r: &Result<Decrypted, CoreError>) -> Option<UtdReason> {
    match r {
        Err(CoreError::Utd { reason, .. }) => Some(*reason),
        _ => None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn um_para_um_nos_dois_sentidos() {
    let s = FakeServer::new();
    let a = Client::phone(&s, "7").await;
    let b = Client::phone(&s, "42").await;
    s.set_conv("971", &["7", "42"]);
    let (env, cmid, r) = a.send("971", &[&a, &b], "Olá, isto é E2EE de verdade").await;
    assert!(env.starts_with("{\"e2e\":5,\"c\":{"));
    assert!(r.key_share_requests >= 1);
    println!("[1:1] envelope = {} B; troca de chave = {} B em {} pedido(s)", env.len(), r.key_share_bytes, r.key_share_requests);
    let d = b.recv("971", &a, &env, &cmid, "1001").await.unwrap();
    assert_eq!(body_of(&d), "Olá, isto é E2EE de verdade");
    assert_eq!(d.trust, Trust::Tofu);
    assert_eq!(d.sender_device_id, a.device_id);
    // 2ª mensagem: sem nova troca de chave
    let (env2, cmid2, r2) = a.send("971", &[&a, &b], "segunda").await;
    assert_eq!(r2.key_share_requests, 0, "Megolm reaproveita a sessão");
    assert_eq!(body_of(&b.recv("971", &a, &env2, &cmid2, "1002").await.unwrap()), "segunda");
    // resposta
    let (env3, cmid3, _) = b.send("971", &[&a, &b], "oi de volta").await;
    assert_eq!(body_of(&a.recv("971", &b, &env3, &cmid3, "1003").await.unwrap()), "oi de volta");
    // servidor tentando mover a mensagem: outra conversa / outro cmid
    s.set_conv("972", &["7", "42"]);
    assert!(is_utd(&b.recv("972", &a, &env, &cmid, "1001").await).is_some());
    assert_eq!(is_utd(&b.recv("971", &a, &env, "cm-outro-id", "1001").await), Some(UtdReason::ContextMismatch));
    // remetente falso (servidor diz que foi o 42)
    assert!(is_utd(&b.recv("971", &b, &env, &cmid, "1001").await).is_some());
    // envelope de versão desconhecida
    assert_eq!(envelope_version(r#"{"e2e":6,"c":{}}"#), Some(6));
    assert_eq!(is_utd(&b.recv("971", &a, r#"{"e2e":6,"c":{}}"#, &cmid, "1").await), Some(UtdReason::BadEnvelope));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tres_aparelhos_e_meus_outros_aparelhos() {
    let s = FakeServer::new();
    let a = Client::phone(&s, "7").await;
    let b = Client::phone(&s, "42").await;
    let bw = Client::secondary(&s, &b, "W").await;
    let at = Client::secondary(&s, &a, "T").await;
    s.set_conv("10", &["7", "42"]);
    let (env, cmid, _) = a.send("10", &[&a, &b], "para todos os aparelhos").await;
    for (n, c) in [("bob/celular", &b), ("bob/web", &bw), ("alice/tablet", &at)] {
        let d = c.recv("10", &a, &env, &cmid, "5").await.unwrap_or_else(|e| panic!("{n}: {e:?}"));
        assert_eq!(body_of(&d), "para todos os aparelhos");
    }
    // a web do bob envia; todos leem
    let (env2, cmid2, _) = bw.send("10", &[&a, &b], "da web").await;
    assert_eq!(body_of(&a.recv("10", &bw, &env2, &cmid2, "6").await.unwrap()), "da web");
    assert_eq!(body_of(&b.recv("10", &bw, &env2, &cmid2, "6").await.unwrap()), "da web");
    assert_eq!(body_of(&at.recv("10", &bw, &env2, &cmid2, "6").await.unwrap()), "da web");
    let devs = a.core.list_devices("42".into()).await.unwrap();
    assert_eq!(devs.len(), 2);
    assert!(devs.iter().all(|d| d.signed_by_owner));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grupo_entrada_e_saida() {
    let s = FakeServer::new();
    let a = Client::phone(&s, "1").await;
    let b = Client::phone(&s, "2").await;
    let c = Client::phone(&s, "3").await;
    s.set_conv("50", &["1", "2", "3"]);
    let (e1, m1, _) = a.send("50", &[&a, &b, &c], "m1 para os três").await;
    for x in [&b, &c] {
        assert_eq!(body_of(&x.recv("50", &a, &e1, &m1, "1").await.unwrap()), "m1 para os três");
    }
    // c sai
    s.set_conv("50", &["1", "2"]);
    a.core.on_members_changed("50".into(), vec!["1".into(), "2".into()], vec!["3".into()]).await.unwrap();
    let (e2, m2, r2) = a.send("50", &[&a, &b], "m2 depois que o c saiu").await;
    assert!(r2.key_share_requests >= 1, "rotacionou");
    assert_eq!(body_of(&b.recv("50", &a, &e2, &m2, "2").await.unwrap()), "m2 depois que o c saiu");
    let rc = c.recv("50", &a, &e2, &m2, "2").await;
    assert!(is_utd(&rc).is_some(), "quem saiu NÃO lê a próxima: {rc:?}");
    // d entra
    let d = Client::phone(&s, "4").await;
    s.set_conv("50", &["1", "2", "4"]);
    a.core.on_members_changed("50".into(), vec!["1".into(), "2".into(), "4".into()], vec![]).await.unwrap();
    let (e3, m3, _) = a.send("50", &[&a, &b, &d], "m3 com o d").await;
    assert_eq!(body_of(&d.recv("50", &a, &e3, &m3, "3").await.unwrap()), "m3 com o d");
    let old = d.recv("50", &a, &e2, &m2, "2").await;
    assert!(matches!(is_utd(&old), Some(UtdReason::UnknownIndex) | Some(UtdReason::MissingSession)), "quem entra não lê o passado: {old:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn otk_esgotada_usa_fallback_e_anti_dreno() {
    let s = FakeServer::new();
    let a = Client::phone(&s, "7").await;
    let b = Client::phone(&s, "42").await;
    let eve = Client::phone(&s, "666").await;
    s.set_conv("1", &["7", "42"]);
    s.set_conv("2", &["666", "42"]);
    let before = s.otk_count("42", &b.device_id);
    assert!(before >= 10, "OTKs publicadas: {before}");
    // eve tenta drenar as OTKs do bob: depois de 5, só recebe a fallback
    for _ in 0..20 {
        let r = s.handle(
            "keys_claim",
            &json!({"one_time_keys": {uid_user("42"): {b.device_id.clone(): "signed_curve25519"}}}),
            Some((&uid_user("666"), &eve.device_id)),
        );
        assert_eq!(r.status, 200);
    }
    let after = s.otk_count("42", &b.device_id);
    assert_eq!(before - after, OTK_PER_HOUR_PER_PAIR as usize, "anti-dreno: no máx 5 por par/hora");
    // estranho (não divide conversa) não consulta nem reivindica
    let r = s.handle("keys_query", &json!({"device_keys": {uid_user("7"): []}}), Some((&uid_user("666"), &eve.device_id)));
    let v: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(v["data"]["failures"][uid_user("7")]["code"], "forbidden");
    // OTKs do bob acabam de vez: a alice ainda abre sessão (fallback)
    s.drain_otks("42", &b.device_id);
    let (env, cmid, _) = a.send("1", &[&a, &b], "via fallback").await;
    assert_eq!(body_of(&b.recv("1", &a, &env, &cmid, "9").await.unwrap()), "via fallback");
    // e o bob repõe as OTKs no sync seguinte
    b.core.sync().await.unwrap();
    assert!(s.otk_count("42", &b.device_id) > 0, "repôs OTKs");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reinstalacao_e_aparelho_novo() {
    let s = FakeServer::new();
    let a = Client::phone(&s, "7").await;
    let b = Client::phone(&s, "42").await;
    s.set_conv("3", &["7", "42"]);
    let (e1, m1, _) = a.send("3", &[&a, &b], "antes de reinstalar").await;
    assert!(b.recv("3", &a, &e1, &m1, "1").await.is_ok());
    // abrir o MESMO store com outro device_id é recusado (store pertence ao aparelho antigo)
    let bad = CryptoCore::open(
        OpenOptions {
            store_dir: b.dir.path().join("store").to_string_lossy().to_string(),
            store_passphrase: PASS.into(),
            uid: "42".into(),
            device_id: new_device_id("P").unwrap(),
            role: ProcessRole::App,
            holder_suffix: "x".into(),
        },
        b.t.clone(),
    )
    .await;
    assert!(matches!(bad, Err(CoreError::InvalidInput { .. })));
    // senha do store errada também
    let bad2 = CryptoCore::open(
        OpenOptions {
            store_dir: b.dir.path().join("store").to_string_lossy().to_string(),
            store_passphrase: "senha-errada-123456".into(),
            uid: "42".into(),
            device_id: b.device_id.clone(),
            role: ProcessRole::App,
            holder_suffix: "y".into(),
        },
        b.t.clone(),
    )
    .await;
    assert!(bad2.is_err(), "senha errada não abre o store");
    // reinstalação sem backup = aparelho novo + identidade nova
    let b2 = Client::phone(&s, "42").await;
    assert_ne!(b2.device_id, b.device_id);
    let sr = a.core.sync().await.unwrap();
    let st = a.core.identity_status("42".into()).await.unwrap();
    println!("[reinstalação] identity_changed_uids={:?} needs_approval={}", sr.identity_changed_uids, st.needs_approval);
    assert!(sr.identity_changed_uids.contains(&"42".to_string()), "sync avisa 'código de segurança mudou'");
    assert!(st.needs_approval);
    a.core.pin_identity("42".into()).await.unwrap();
    assert!(!a.core.identity_status("42".into()).await.unwrap().needs_approval);
    let (e2, m2, _) = a.send("3", &[&a, &b2], "depois de reinstalar").await;
    assert_eq!(body_of(&b2.recv("3", &a, &e2, &m2, "2").await.unwrap()), "depois de reinstalar");
    // o aparelho novo NÃO lê o histórico sem backup/vínculo
    assert!(is_utd(&b2.recv("3", &a, &e1, &m1, "1").await).is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aparelho_injetado_pelo_servidor_nao_recebe_chave() {
    let s = FakeServer::new();
    let a = Client::phone(&s, "7").await;
    let b = Client::phone(&s, "42").await;
    s.set_conv("4", &["7", "42"]);
    // o servidor cria um aparelho "do bob" que o bob nunca assinou
    let evil = Client::open_at(&s, "42", &new_device_id("W").unwrap(), Arc::new(tempfile::tempdir().unwrap()), ProcessRole::Web, "").await;
    evil.core.sync().await.unwrap();
    a.core.track_users(vec!["42".into()]).await.unwrap();
    a.core.sync().await.unwrap();
    let devs = a.core.list_devices("42".into()).await.unwrap();
    assert!(devs.iter().any(|d| d.device_id == evil.device_id && !d.signed_by_owner), "alice vê o aparelho não assinado");
    let (env, cmid, _) = a.send("4", &[&a, &b], "segredo").await;
    assert!(b.recv("4", &a, &env, &cmid, "1").await.is_ok());
    let r = evil.recv("4", &a, &env, &cmid, "1").await;
    assert!(matches!(is_utd(&r), Some(UtdReason::MissingSession) | Some(UtdReason::Withheld)), "injetado não decifra: {r:?}");
    // to-device chatyy.* também não vai para o injetado
    let st = a.core.send_to_device("chatyy.call_key".into(), vec![DeviceTarget { uid: "42".into(), device_id: String::new() }], json!({"v":1,"call_id":"c1","key":"AAAA","index":0}).to_string()).await.unwrap();
    assert_eq!(st.sent_devices, 1);
    assert!(st.withheld.iter().any(|w| w.ends_with(&evil.device_id)), "{:?}", st.withheld);
    // o injetado não consegue nem cifrar (sua própria identidade não é confiável)
    let p = json!({"v":1,"t":"text","conv":"4","cmid":"cm-evil-0001","body":"x"}).to_string();
    assert!(evil.core.encrypt("4".into(), vec!["7".into()], p).await.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chave_trocada_pelo_servidor_no_vinculo_e_recusada() {
    let s = FakeServer::new();
    let b = Client::phone(&s, "42").await;
    let web = Client::open_at(&s, "42", &new_device_id("W").unwrap(), Arc::new(tempfile::tempdir().unwrap()), ProcessRole::Web, "").await;
    web.core.sync().await.unwrap();
    let real = web.core.this_device().await.unwrap();
    // servidor devolve outras chaves para o mesmo device_id
    let other = Client::open_at(&s, "42", &new_device_id("W").unwrap(), Arc::new(tempfile::tempdir().unwrap()), ProcessRole::Web, "").await;
    other.core.sync().await.unwrap();
    let mut fake = s.device_keys("42", &other.device_id).unwrap();
    fake["device_id"] = json!(web.device_id);
    s.st.lock().unwrap().evil.swap_device_keys = Some((uid_user("42"), web.device_id.clone(), fake));
    let r = b.core.sign_device(web.device_id.clone(), real.ed25519.clone()).await;
    assert!(r.is_err(), "não assina chave divergente: {r:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn midia_cifrada_dentro_da_mensagem_e_adulteracao() {
    let s = FakeServer::new();
    let a = Client::phone(&s, "7").await;
    let b = Client::phone(&s, "42").await;
    s.set_conv("8", &["7", "42"]);
    let dir = tempfile::tempdir().unwrap();
    let p = |n: &str| dir.path().join(n).to_string_lossy().to_string();
    let foto: Vec<u8> = (0..300_000u32).map(|i| (i % 253) as u8).collect();
    std::fs::write(p("foto.jpg"), &foto).unwrap();
    let ef = encrypt_file(p("foto.jpg"), p("blob")).unwrap();
    let thumb = encrypt_bytes(foto[..9000].to_vec()).unwrap();
    let payload = json!({"v":1,"t":"image","conv":"8","cmid":"cm-midia-0001","ts":1,
        "media":[{"kind":"image","url":"https://media.chatyy.com.br/e2e/xyz","file":serde_json::from_str::<Value>(&ef.info_json).unwrap(),
          "mime":"image/jpeg","size":ef.size,"w":1280,"h":960,"blurhash":"LEHV6nWB2yk8",
          "thumbs":[{"kind":"t320","url":"https://media.chatyy.com.br/e2e/abc","file":serde_json::from_str::<Value>(&thumb.info_json).unwrap(),"w":320,"h":240,"size":9000}]}]});
    let r = a.core.encrypt("8".into(), vec!["42".into()], payload.to_string()).await.unwrap();
    let d = b.recv("8", &a, &r.envelope_json, "cm-midia-0001", "77").await.unwrap();
    let pv: Value = serde_json::from_str(&d.payload_json).unwrap();
    let info = pv["media"][0]["file"].to_string();
    decrypt_file(p("blob"), p("out.jpg"), info.clone()).unwrap();
    assert_eq!(std::fs::read(p("out.jpg")).unwrap(), foto);
    let tinfo = pv["media"][0]["thumbs"][0]["file"].to_string();
    assert_eq!(decrypt_bytes(thumb.data.clone(), tinfo).unwrap(), &foto[..9000]);
    let mut bad = std::fs::read(p("blob")).unwrap();
    bad[150_000] ^= 1;
    std::fs::write(p("blob.bad"), &bad).unwrap();
    assert!(matches!(decrypt_file(p("blob.bad"), p("bad.jpg"), info.clone()), Err(CoreError::Media { .. })));
    assert!(!std::path::Path::new(&p("bad.jpg")).exists());
    // nada do claro no envelope
    assert!(!r.envelope_json.contains("blurhash") && !r.envelope_json.contains("e2e/xyz"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_import_para_aparelho_novo() {
    let s = FakeServer::new();
    let a = Client::phone(&s, "7").await;
    let b = Client::phone(&s, "42").await;
    s.set_conv("11", &["7", "42"]);
    let mut msgs = vec![];
    for i in 0..5 {
        msgs.push(a.send("11", &[&a, &b], &format!("histórico {i}")).await);
    }
    for (i, (e, c, _)) in msgs.iter().enumerate() {
        b.recv("11", &a, e, c, &format!("{i}")).await.unwrap();
    }
    let blob = b.core.export_room_keys(ExportFilter { conv_ids: vec![], since_ms: 0 }).await.unwrap();
    assert!(!blob.is_empty());
    let empty = b.core.export_room_keys(ExportFilter { conv_ids: vec!["999".into()], since_ms: 0 }).await.unwrap();
    assert_eq!(serde_json::from_slice::<Vec<Value>>(&empty).unwrap().len(), 0);
    let future = b.core.export_room_keys(ExportFilter { conv_ids: vec![], since_ms: u64::MAX / 2 }).await.unwrap();
    assert_eq!(serde_json::from_slice::<Vec<Value>>(&future).unwrap().len(), 0, "filtro de janela (D5)");
    let bt = Client::secondary(&s, &b, "T").await;
    for (i, (e, c, _)) in msgs.iter().enumerate() {
        assert!(bt.recv("11", &a, e, c, &format!("{i}")).await.is_err(), "sem import não lê");
    }
    let r = bt.core.import_room_keys(blob).await.unwrap();
    assert!(r.imported >= 1 && r.convs == vec!["11".to_string()]);
    for (i, (e, c, _)) in msgs.iter().enumerate() {
        assert_eq!(body_of(&bt.recv("11", &a, e, c, &format!("{i}")).await.unwrap()), format!("histórico {i}"));
    }
    // export por senha
    let file = b.core.export_room_keys_with_passphrase("senha-bem-longa-123".into()).await.unwrap();
    assert!(bt.core.import_room_keys_with_passphrase(file.clone(), "errada-errada-123".into()).await.is_err());
    assert!(bt.core.import_room_keys_with_passphrase(file, "senha-bem-longa-123".into()).await.is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backup_e_restauracao_em_celular_novo() {
    let s = FakeServer::new();
    let a = Client::phone(&s, "7").await;
    let b = Client::phone(&s, "42").await;
    s.set_conv("12", &["7", "42"]);
    let en = b.core.backup_enable(String::new()).await.unwrap();
    let rk = en.recovery_key.replace(' ', "");
    assert_eq!(rk.len(), 48, "chave de recuperação de 48 caracteres");
    let mut msgs = vec![];
    for i in 0..3 {
        let m = a.send("12", &[&a, &b], &format!("guardada {i}")).await;
        b.recv("12", &a, &m.0, &m.1, &format!("{i}")).await.unwrap();
        msgs.push(m);
    }
    b.core.backup_step(0).await.unwrap();
    let stt = b.core.backup_status().await.unwrap();
    assert!(stt.enabled && stt.backed_up_keys >= 1 && stt.backed_up_keys == stt.total_keys, "{stt:?}");
    let msk_before = a.core.identity_status("42".into()).await.unwrap().master_key;
    // celular perdido: aparelho novo, mesma conta, SEM bootstrap
    let d = new_device_id("P").unwrap();
    let nb = Client::open_at(&s, "42", &d, Arc::new(tempfile::tempdir().unwrap()), ProcessRole::App, "").await;
    nb.core.sync().await.unwrap();
    assert!(nb.core.backup_restore("EsT0 errada errada errada errada errada errada xx".into()).await.is_err(), "chave errada não abre");
    let rr = nb.core.backup_restore(en.recovery_key.clone()).await.unwrap();
    assert!(rr.identity_restored && rr.imported >= 1, "{rr:?}");
    for (i, (e, c, _)) in msgs.iter().enumerate() {
        assert_eq!(body_of(&nb.recv("12", &a, e, c, &format!("{i}")).await.unwrap()), format!("guardada {i}"));
    }
    // a MSK não mudou: a alice não vê "código mudou"; e o aparelho novo é assinado
    a.core.sync().await.unwrap();
    let st = a.core.identity_status("42".into()).await.unwrap();
    assert_eq!(st.master_key, msk_before);
    assert!(!st.needs_approval);
    let devs = a.core.list_devices("42".into()).await.unwrap();
    assert!(devs.iter().any(|x| x.device_id == d && x.signed_by_owner));
    let (e, c, _) = a.send("12", &[&a, &nb], "pós-restauração").await;
    assert_eq!(body_of(&nb.recv("12", &a, &e, &c, "99").await.unwrap()), "pós-restauração");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn backup_com_senha_argon2id() {
    let s = FakeServer::new();
    let b = Client::phone(&s, "42").await;
    b.core.backup_enable("minha senha forte de backup".into()).await.unwrap();
    let nb = Client::open_at(&s, "42", &new_device_id("P").unwrap(), Arc::new(tempfile::tempdir().unwrap()), ProcessRole::App, "").await;
    nb.core.sync().await.unwrap();
    assert!(nb.core.backup_restore("senha errada de backup".into()).await.is_err());
    assert!(nb.core.backup_restore("minha senha forte de backup".into()).await.unwrap().identity_restored);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn vinculo_web_por_qr_ida_e_volta() {
    let s = FakeServer::new();
    let a = Client::phone(&s, "7").await;
    let b = Client::phone(&s, "42").await;
    s.set_conv("13", &["7", "42"]);
    let (e_old, c_old, _) = a.send("13", &[&a, &b], "histórico antes do vínculo").await;
    b.recv("13", &a, &e_old, &c_old, "1").await.unwrap();

    // WEB: sem conta ainda
    let wt = ClientTransport::new(&s, None, "");
    let lw = LinkWeb::begin(wt.clone()).await.unwrap();
    let qr = lw.qr_payload();
    assert!(qr.starts_with("chatyy-link:1:"));
    assert_eq!(lw.poll(None).await.unwrap(), LinkWebState::Waiting);
    // QR adulterado (segredo trocado): canal não abre
    let mut parts: Vec<String> = qr.split(':').map(String::from).collect();
    parts[4] = "A".repeat(43);
    // CELULAR lê o QR verdadeiro
    let lp = LinkPhone::accept(b.core.clone(), qr.clone(), ExportFilter { conv_ids: vec![], since_ms: 0 }).await.unwrap();
    let st = lw.poll(None).await.unwrap();
    let LinkWebState::Hello { uid, check_code } = st.clone() else { panic!("{st:?}") };
    assert_eq!(uid, "42");
    assert_eq!(check_code, lp.check_code(), "código de 2 dígitos igual nos dois lados");
    // host da web abre o core com o uid recebido e um device W novo
    let wd = new_device_id("W").unwrap();
    *wt.device.lock().unwrap() = wd.clone();
    let wdir = Arc::new(tempfile::tempdir().unwrap());
    let wcore = CryptoCore::open(
        OpenOptions { store_dir: wdir.path().join("s").to_string_lossy().to_string(), store_passphrase: PASS.into(), uid: uid.clone(), device_id: wd.clone(), role: ProcessRole::Web, holder_suffix: String::new() },
        wt.clone(),
    )
    .await
    .unwrap();
    lw.send_device(wcore.clone()).await.unwrap();
    assert!(matches!(lp.poll().await.unwrap(), LinkPhoneState::WaitingUpload { .. }));
    let LinkWebState::Granted { bearer } = lw.poll(Some(wcore.clone())).await.unwrap() else { panic!("sem grant") };
    wt.install_bearer(&bearer);
    lw.complete_upload(wcore.clone()).await.unwrap();
    let ps = lp.poll().await.unwrap();
    assert!(matches!(ps, LinkPhoneState::Sent { .. }), "{ps:?}");
    let ws = lw.poll(Some(wcore.clone())).await.unwrap();
    let LinkWebState::Done { imported } = ws else { panic!("{ws:?}") };
    assert!(imported >= 1);
    assert!(matches!(lp.poll().await.unwrap(), LinkPhoneState::Done { .. }));
    let web = Client { uid: "42".into(), core: wcore, t: wt, dir: wdir, device_id: wd.clone() };
    // web lê o histórico, recebe as novas e envia
    assert_eq!(body_of(&web.recv("13", &a, &e_old, &c_old, "1").await.unwrap()), "histórico antes do vínculo");
    let (e_new, c_new, _) = a.send("13", &[&a, &b], "depois do vínculo").await;
    assert_eq!(body_of(&web.recv("13", &a, &e_new, &c_new, "2").await.unwrap()), "depois do vínculo");
    let (e_w, c_w, _) = web.send("13", &[&a, &b], "enviada da web").await;
    let d = a.recv("13", &web, &e_w, &c_w, "3").await.unwrap();
    assert_eq!(body_of(&d), "enviada da web");
    assert_eq!(d.sender_device_id, wd);
    assert!(web.core.identity_status("42".into()).await.unwrap().verified, "web confia na MSK do canal");

    // um "celular" falso (servidor) com o QR mas segredo errado não abre o canal da web
    let wt2 = ClientTransport::new(&s, None, "");
    let lw2 = LinkWeb::begin(wt2).await.unwrap();
    let mut p2: Vec<String> = lw2.qr_payload().split(':').map(String::from).collect();
    p2[4] = parts[4].clone();
    let lp2 = LinkPhone::accept(b.core.clone(), p2.join(":"), ExportFilter { conv_ids: vec![], since_ms: 0 }).await.unwrap();
    let _ = lp2;
    assert!(matches!(lw2.poll(None).await, Err(CoreError::Link { .. })), "segredo do QR não confere");

    // revogar a web no celular: próxima mensagem (de qualquer um) não chega à web
    let (e_b, c_b, _) = b.send("13", &[&a, &b], "bob antes de revogar").await;
    assert!(web.recv("13", &b, &e_b, &c_b, "35").await.is_ok());
    let n = b.core.forget_device(wd.clone()).await.unwrap();
    assert!(n >= 1);
    a.core.sync().await.unwrap();
    let (e_r, c_r, _) = a.send("13", &[&a, &b], "depois de revogar").await;
    assert!(b.recv("13", &a, &e_r, &c_r, "4").await.is_ok());
    let rw = web.core.decrypt(DecryptInput { conv_id: "13".into(), envelope_json: e_r, sender_uid: "7".into(), server_mid: "4".into(), cmid: c_r, ts_ms: 1 }).await;
    assert!(is_utd(&rw).is_some(), "web revogada não lê: {rw:?}");
    let (e_b2, c_b2, r_b2) = b.send("13", &[&a, &b], "bob depois de revogar").await;
    assert!(r_b2.key_share_requests >= 1, "bob rotacionou");
    let rw2 = web.core.decrypt(DecryptInput { conv_id: "13".into(), envelope_json: e_b2, sender_uid: "42".into(), server_mid: "5".into(), cmid: c_b2, ts_ms: 1 }).await;
    assert!(is_utd(&rw2).is_some(), "web revogada não lê o bob: {rw2:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dois_processos_no_mesmo_store_app_e_nse() {
    let s = FakeServer::new();
    let a = Client::phone(&s, "7").await;
    let b = Client::phone(&s, "42").await;
    s.set_conv("14", &["7", "42"]);
    // NSE abre o MESMO store (outro "processo" = outra instância com holder diferente)
    let nse = Client::open_at(&s, "42", &b.device_id, b.dir.clone(), ProcessRole::Push, "nse").await;
    let mut all = vec![];
    for round in 0..4 {
        let (e, c, _) = a.send("14", &[&a, &b], &format!("push {round}")).await;
        // a NSE recebe o push primeiro: sync + decifra
        let d = nse.recv("14", &a, &e, &c, &format!("{round}")).await.unwrap();
        assert_eq!(body_of(&d), format!("push {round}"));
        // o app abre depois (caches velhos → recarrega do disco)
        let d2 = b.recv("14", &a, &e, &c, &format!("{round}")).await.unwrap();
        assert_eq!(body_of(&d2), format!("push {round}"));
        // o app responde (avança Olm/Megolm de saída) e a NSE não estraga nada
        let (er, cr, _) = b.send("14", &[&a, &b], &format!("resp {round}")).await;
        assert_eq!(body_of(&a.recv("14", &b, &er, &cr, &format!("r{round}")).await.unwrap()), format!("resp {round}"));
        all.push((e, c));
    }
    let reloads = b.core.metrics_snapshot().store_reloads + nse.core.metrics_snapshot().store_reloads;
    println!("[NSE+app] recargas do store por troca de processo = {reloads}");
    assert!(reloads >= 2);
    // concorrência real: os dois ao mesmo tempo
    let (e, c, _) = a.send("14", &[&a, &b], "corrida").await;
    let (r1, r2) = tokio::join!(nse.recv("14", &a, &e, &c, "z"), b.recv("14", &a, &e, &c, "z"));
    assert!(r1.is_ok() && r2.is_ok(), "{r1:?} {r2:?}");
    // a NSE consome um chatyy.call_key (o cursor do servidor avança) → o app recebe no próximo sync, uma vez só
    a.core.track_users(vec!["42".into()]).await.unwrap();
    let st = a.core.send_to_device("chatyy.call_key".into(), vec![DeviceTarget { uid: "42".into(), device_id: b.device_id.clone() }], json!({"v":1,"call_id":"nse-1","key":"AAAA","index":0}).to_string()).await.unwrap();
    assert_eq!(st.sent_devices, 1);
    let ns = nse.core.sync().await.unwrap();
    assert!(ns.chatyy_events.iter().any(|e| e.event_type == "chatyy.call_key"), "NSE viu o evento");
    let (e5, c5, _) = a.send("14", &[&a, &b], "chave nova consumida pela NSE").await;
    let _ = e5; let _ = c5;
    let rot = a.core.rotate_conversation("14".into()).await.unwrap();
    let (e6, c6, _) = a.send("14", &[&a, &b], "depois da rotação").await;
    let ns2 = nse.core.sync().await.unwrap();
    println!("[NSE→app] rotacionou={rot} convs NSE={:?}", ns2.convs_with_new_keys);
    let app1 = b.core.sync().await.unwrap();
    assert_eq!(app1.chatyy_events.iter().filter(|e| e.event_type == "chatyy.call_key").count(), 1, "app recebe o evento que a NSE consumiu");
    assert!(app1.convs_with_new_keys.contains(&"14".to_string()), "app sabe que chegou chave nova: {:?}", app1.convs_with_new_keys);
    let app2 = b.core.sync().await.unwrap();
    assert!(app2.chatyy_events.is_empty() && app2.convs_with_new_keys.is_empty(), "entregue uma vez só");
    assert_eq!(body_of(&b.recv("14", &a, &e6, &c6, "z6").await.unwrap()), "depois da rotação");
    // reabrir do zero (como após matar o app): tudo íntegro
    drop(nse);
    let fresh = Client::open_at(&s, "42", &b.device_id, b.dir.clone(), ProcessRole::App, "reaberto").await;
    for (i, (e, c)) in all.iter().enumerate() {
        assert_eq!(body_of(&fresh.recv("14", &a, e, c, &format!("{i}")).await.unwrap()), format!("push {i}"));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn to_device_chatyy_e_numero_de_seguranca() {
    let s = FakeServer::new();
    let a = Client::phone(&s, "7").await;
    let b = Client::phone(&s, "42").await;
    s.set_conv("15", &["7", "42"]);
    a.core.track_users(vec!["42".into()]).await.unwrap();
    b.core.track_users(vec!["7".into()]).await.unwrap();
    let r = a
        .core
        .send_to_device("chatyy.call_key".into(), vec![DeviceTarget { uid: "42".into(), device_id: String::new() }], json!({"v":1,"call_id":"call-1","conv_id":"15","key":"a2V5LWRhLWxpZ2FjYW8","index":0}).to_string())
        .await
        .unwrap();
    assert_eq!(r.sent_devices, 1);
    let sr = b.core.sync().await.unwrap();
    let ev = sr.chatyy_events.iter().find(|e| e.event_type == "chatyy.call_key").expect("recebeu chatyy.call_key");
    assert_eq!(ev.sender_uid, "7");
    assert_eq!(ev.sender_device_id, a.device_id);
    let c: Value = serde_json::from_str(&ev.content_json).unwrap();
    assert_eq!(c["call_id"], "call-1");
    assert!(a.core.send_to_device("m.room_key".into(), vec![], "{}".into()).await.is_err(), "só chatyy.*");
    // número de segurança igual nos dois lados; QR verifica
    let sa = a.core.safety_number("42".into()).await.unwrap();
    let sb = b.core.safety_number("7".into()).await.unwrap();
    assert_eq!(sa.digits, sb.digits);
    assert_eq!(sa.digits.len(), 60);
    assert!(!a.core.verify_safety_qr("42".into(), "chatyy-sn:1:lixo".into()).await.unwrap());
    assert!(a.core.verify_safety_qr("42".into(), sb.qr_payload.clone()).await.unwrap());
    assert!(a.core.identity_status("42".into()).await.unwrap().verified);
    let (e, cm, _) = b.send("15", &[&a, &b], "agora verificado").await;
    assert_eq!(a.recv("15", &b, &e, &cm, "1").await.unwrap().trust, Trust::Verified);
    let m = a.core.metrics_snapshot();
    assert!(m.decrypt_ok >= 1);
    a.core.flush_metrics().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn decrypt_nao_entra_em_panico_com_lixo() {
    let s = FakeServer::new();
    let a = Client::phone(&s, "7").await;
    let b = Client::phone(&s, "42").await;
    s.set_conv("16", &["7", "42"]);
    let (env, cmid, _) = a.send("16", &[&a, &b], "alvo do fuzz").await;
    b.recv("16", &a, &env, &cmid, "1").await.unwrap();
    let bytes = env.as_bytes().to_vec();
    let mut rnd = [0u8; 4096];
    getrandom::getrandom(&mut rnd).unwrap();
    let mut ok = 0;
    for i in 0..1500 {
        let mut m = bytes.clone();
        let pos = (rnd[i % 4096] as usize * 7 + i * 13) % m.len();
        m[pos] = rnd[(i * 3) % 4096];
        if i % 5 == 0 {
            m.truncate(pos.max(1));
        }
        let s = String::from_utf8_lossy(&m).to_string();
        let r = b.core.decrypt(DecryptInput { conv_id: "16".into(), envelope_json: s, sender_uid: "7".into(), server_mid: "1".into(), cmid: cmid.clone(), ts_ms: 1 }).await;
        if r.is_ok() {
            ok += 1;
        }
    }
    for junk in ["", "{}", "null", "{\"e2e\":5}", "{\"e2e\":5,\"c\":{\"algorithm\":\"m.megolm.v1.aes-sha2\",\"ciphertext\":\"!!\",\"session_id\":\"x\"}}"] {
        assert!(b.core.decrypt(DecryptInput { conv_id: "16".into(), envelope_json: junk.into(), sender_uid: "7".into(), server_mid: "1".into(), cmid: cmid.clone(), ts_ms: 1 }).await.is_err());
    }
    for junk in [&b""[..], b"\x00\x01", &[0u8; 100][..]] {
        assert!(decrypt_bytes(junk.to_vec(), "{}".into()).is_err());
    }
    println!("[fuzz-lite] 1500 mutações sem pânico ({ok} ainda decifraram — mutação em campo ignorado)");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grava_exemplos_do_contrato() {
    // Gera docs/e2ee/exemplos/*.json a partir de um fluxo completo (referência para o WP-05).
    let Ok(out) = std::env::var("CHATYY_WRITE_EXAMPLES") else { return };
    let s = FakeServer::new();
    let a = Client::phone(&s, "7").await;
    let b = Client::phone(&s, "42").await;
    s.set_conv("971", &["7", "42"]);
    let (env, cmid, _) = a.send("971", &[&a, &b], "exemplo").await;
    b.recv("971", &a, &env, &cmid, "1").await.unwrap();
    b.core.backup_enable(String::new()).await.unwrap();
    a.core.send_to_device("chatyy.call_key".into(), vec![DeviceTarget { uid: "42".into(), device_id: String::new() }], json!({"v":1,"call_id":"c","conv_id":"971","key":"AAAA","index":0}).to_string()).await.unwrap();
    std::fs::create_dir_all(&out).unwrap();
    for (action, (req, resp)) in s.examples() {
        std::fs::write(format!("{out}/e2ee5_{action}.json"), serde_json::to_string_pretty(&json!({"action": format!("e2ee5_{action}"), "request": req, "response_data": resp})).unwrap()).unwrap();
    }
    std::fs::write(format!("{out}/envelope.json"), serde_json::to_string_pretty(&serde_json::from_str::<Value>(&env).unwrap()).unwrap()).unwrap();
}
