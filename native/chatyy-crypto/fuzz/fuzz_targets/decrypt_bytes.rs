#![no_main]
use libfuzzer_sys::fuzz_target;
// info fixa válida + dados arbitrários; e info arbitrária + dados fixos: nunca pode entrar em pânico.
fuzz_target!(|data: &[u8]| {
    let e = chatyy_crypto::encrypt_bytes(b"chatyy fuzz seed".to_vec()).unwrap();
    let _ = chatyy_crypto::decrypt_bytes(data.to_vec(), e.info_json.clone());
    if let Ok(s) = std::str::from_utf8(data) {
        let _ = chatyy_crypto::decrypt_bytes(e.data.clone(), s.to_string());
    }
});
