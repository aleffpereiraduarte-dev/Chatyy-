#![no_main]
use libfuzzer_sys::fuzz_target;
// Caminho de parse do envelope (antes de tocar o store): nunca pode entrar em pânico.
fuzz_target!(|data: &[u8]| {
    if let Ok(s) = std::str::from_utf8(data) {
        let _ = chatyy_crypto::envelope_version(s);
    }
});
