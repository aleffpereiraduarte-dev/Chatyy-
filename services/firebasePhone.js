// firebasePhone.js — STUB (2026-06-24): @react-native-firebase REMOVIDO do app.
//
// O Firebase Phone Auth já estava DESLIGADO (FIREBASE_PHONE_DISABLED) desde
// 2026-06-19 — login.js / signup-phone.js SEMPRE caem pro backend OTP (Vonage
// SMS + voz), que funciona. Os pacotes @react-native-firebase/app + /auth
// quebravam o build iOS (FirebaseAuth é um pod Swift que precisa de
// use_frameworks! — que cascateia e quebra RN 0.83/Skia/VisionCamera/LiveKit) e
// NÃO eram usados em produção. Removidos.
//
// Este módulo virou um stub puro (sem nenhum import nativo) que reporta
// "indisponível" — os callers já tratam isso caindo pro backend OTP. As
// assinaturas exportadas são preservadas pra não quebrar quem importa.
//
// Push continua 100%: vai por expo-notifications (FCM no Android via
// google-services.json / APNs no iOS) — nunca dependeu de @react-native-firebase.
//
// Web já resolvia pra firebasePhone.web.js (stub). Agora native == web.

export function firebasePhoneAvailable() {
  return false;
}

export async function fbSendCode() {
  return { ok: false, error: 'unavailable' };
}

export async function fbConfirm() {
  return { ok: false, error: 'unavailable' };
}

export async function fbSignOut() {
  /* no-op — não há sessão Firebase */
}
