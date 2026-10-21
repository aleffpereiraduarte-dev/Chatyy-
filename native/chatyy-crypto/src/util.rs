use crate::error::{internal, CoreResult};
use base64::Engine;

pub(crate) fn fill_random(buf: &mut [u8]) -> CoreResult<()> {
    getrandom::getrandom(buf).map_err(internal)
}
pub(crate) fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD_NO_PAD.encode(data)
}
pub(crate) fn unb64(s: &str) -> Option<Vec<u8>> {
    let t = s.trim_end_matches('=');
    base64::engine::general_purpose::STANDARD_NO_PAD.decode(t).ok()
}
pub(crate) fn b64url(data: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}
pub(crate) fn unb64url(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).ok()
}
pub(crate) fn now_ms() -> u64 {
    ruma::MilliSecondsSinceUnixEpoch::now().get().into()
}
