//! PROTOCOLO §9.2 — os 11 vetores do leaf (raiz de TESTE `vr1`) contra `verify_region_cert`.
//! Fonte: /root/quic-noise-2026-10-23/leaf/vectors/regcert_vectors.json (cópia em tests/).

use base64::Engine;
use chatyy_net::regcert::{self, verify_region_cert};

fn std_b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

#[test]
fn regcert_vectors() {
    let j: serde_json::Value = serde_json::from_str(include_str!("regcert_vectors.json")).unwrap();
    let roots: Vec<(String, [u8; 32])> = j["roots"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), std_b64(v.as_str().unwrap()).try_into().unwrap()))
        .collect();
    let exp = &j["expect_ok"];
    let want_pub: [u8; 32] = std_b64(exp["noise_pub"].as_str().unwrap()).try_into().unwrap();
    let want_pins: Vec<[u8; 32]> =
        exp["pins"].as_array().unwrap().iter().map(|p| std_b64(p.as_str().unwrap()).try_into().unwrap()).collect();
    let vs = j["vectors"].as_array().unwrap();
    assert_eq!(vs.len(), 11, "o contrato tem 11 casos");
    for v in vs {
        let name = v["name"].as_str().unwrap();
        let r = verify_region_cert(
            v["nc"].as_str().unwrap(),
            &roots,
            v["region"].as_str().unwrap(),
            v["kid"].as_str().unwrap(),
            v["now"].as_i64().unwrap(),
        );
        if v["ok"].as_bool().unwrap() {
            let (pk, pins) = r.unwrap_or_else(|e| panic!("{name}: esperava ok, deu {e}"));
            assert_eq!(pk, want_pub, "{name}");
            assert_eq!(pins, want_pins, "{name}");
        } else {
            assert!(r.is_err(), "{name}: esperava recusa");
        }
    }
    // cert_hex = os bytes do caso ok: o parser bate com expect_ok.
    let hex = j["cert_hex"].as_str().unwrap();
    let cb: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
    let c = regcert::parse(&cb).unwrap();
    assert_eq!((c.root_id.as_str(), c.region.as_str(), c.kid.as_str()), ("vr1", "scl", "p1"));
    assert_eq!(c.not_before, exp["not_before"].as_i64().unwrap());
    assert_eq!(c.not_after, exp["not_after"].as_i64().unwrap());
    // Sem raízes no binário (lista vazia = produção desligada) → sempre recusa.
    assert!(verify_region_cert(vs[0]["nc"].as_str().unwrap(), &[], "scl", "p1", 1761350400).is_err());
    // Truncado / lixo / longo demais → erro, nunca pânico.
    let ok_nc = vs[0]["nc"].as_str().unwrap();
    for cut in 0..ok_nc.len() {
        assert!(verify_region_cert(&ok_nc[..cut], &roots, "scl", "p1", 1761350400).is_err());
    }
    assert!(verify_region_cert(&"A".repeat(2000), &roots, "scl", "p1", 0).is_err());
    assert!(verify_region_cert(&format!("{ok_nc}.x"), &roots, "scl", "p1", 1761350400).is_err());
}
