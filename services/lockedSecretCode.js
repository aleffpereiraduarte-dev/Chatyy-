// [2026-10-18 wa-parity lock-code] "Código secreto" das conversas trancadas (WhatsApp).
// Mesmo armazenamento do ChatListTab (SecureStore, chave por conta) — antes o
// botão "Definir" só aparecia com filter==='locked', que nada mais ativa desde
// que a pasta virou a tela /locked-chats → ninguém conseguia definir o código.
// Agora a tela /locked-chats define/edita/remove e avisa a lista via evento.
export const SECRET_CODE_EVENT = 'chatyy:lockedSecretCodeChanged';

export function secretCodeKey(email) {
  return `chat_secret_code_${String(email || 'anon').replace(/[^a-zA-Z0-9]/g, '_')}`;
}

export async function getSecretCode(email) {
  try {
    const SecureStore = require('expo-secure-store');
    return (await SecureStore.getItemAsync(secretCodeKey(email))) || '';
  } catch { return ''; }
}

export async function setSecretCode(email, code) {
  const c = String(code || '').trim();
  try {
    const SecureStore = require('expo-secure-store');
    if (c) await SecureStore.setItemAsync(secretCodeKey(email), c);
    else await SecureStore.deleteItemAsync(secretCodeKey(email));
  } catch {}
  try { require('react-native').DeviceEventEmitter.emit(SECRET_CODE_EVENT, { email: String(email || ''), code: c }); } catch {}
  return c;
}
