// firebasePhone.web.js — WEB stub. The website keeps the legacy backend OTP
// flow (it has no native Firebase SDK), so every function reports "unavailable"
// and the caller falls back automatically. Keeping this file means Metro never
// tries to bundle @react-native-firebase for web.

export function firebasePhoneAvailable() { return false; }
export async function fbSendCode() { return { ok: false, error: 'unavailable' }; }
export async function fbConfirm() { return { ok: false, error: 'unavailable' }; }
export async function fbSignOut() { /* no-op */ }
