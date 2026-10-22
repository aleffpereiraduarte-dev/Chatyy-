// [e2ee5 WP-03] Fallback de services/crypto fora de iOS/Android/web (Node, testes, SSR).
// O Metro resolve index.native.js (iOS/Android, WP-03) e index.web.js (web, WP-04) antes deste.
// Mesma superfície do CONTRATO §6.11; nada funciona aqui: isEnabled() = false e toda chamada
// rejeita com code 'disabled' (flag desligada) ou 'unsupported'.
function flag() {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : global;
    return g.__chatyy_e2ee5 === true;
  } catch (_) {
    return false;
  }
}

function no() {
  const code = flag() ? 'unsupported' : 'disabled';
  const e = new Error(`e2ee5:${code}`);
  e.code = code;
  e.details = { what: 'platform' };
  return Promise.reject(e);
}

export const isEnabled = () => false;
export const isSupported = async () => ({ ok: false, reason: flag() ? 'platform' : 'disabled' });
export const setAuth = no;
export const status = no;
export const open = no;
export const close = no;
export const wipe = no;
export const terminate = async () => {};
export const coreVersion = no;
export const newDeviceId = no;
export const envelopeVersion = no;
export const encryptBytes = no;
export const decryptBytes = no;
export const safetyNumberFor = no;
export const encryptFile = no;
export const decryptFile = no;
export const thisDevice = no;
export const sync = no;
export const syncWith = no;
export const trackUsers = no;
export const encrypt = no;
export const decrypt = no;
export const sendToDevice = no;
export const rotateConversation = no;
export const requestRoomKey = no;
export const shareRoomKey = no;
export const onMembersChanged = no;
export const forgetDevice = no;
export const listDevices = no;
export const bootstrapIdentity = no;
export const signDevice = no;
export const identityStatus = no;
export const pinIdentity = no;
export const safetyNumber = no;
export const verifySafetyQr = no;
export const markVerified = no;
export const exportRoomKeys = no;
export const importRoomKeys = no;
export const exportRoomKeysWithPassphrase = no;
export const importRoomKeysWithPassphrase = no;
export const backupEnable = no;
export const backupStep = no;
export const backupStatus = no;
export const backupDisable = no;
export const backupRestore = no;
export const metricsSnapshot = no;
export const flushMetrics = no;
export const linkAccept = no;
export const linkPhonePoll = no;
export const linkBegin = no;
export const linkPoll = no;
export const linkSendDevice = no;
export const linkCompleteUpload = no;
export const linkCancel = no;
export const addListener = () => ({ remove() {} });
export const platform = 'none';
