// [2026-10-17 sem-pstn] Founder: "tirar a opção de ligar com número de telefone
// normal, só pelo Chatyy". Pontos que antes abriam tel:/discador PSTN passam por
// aqui: número que É de alguém no Chatyy → ligação Chatyy (voz/vídeo app-a-app);
// senão → "Convidar para o Chatyy". Kill switch: constants/featureFlags
// isPstnEnabled() (globalThis.__chatyy_pstn === true) — quem chama decide manter
// o caminho antigo quando ligado.
import { Platform } from 'react-native';

const _tr = (t, k, fb) => { try { const v = typeof t === 'function' ? t(k) : ''; return v && v !== k ? v : fb; } catch { return fb; } };

// Ligação Chatyy 1:1 por e-mail (mesmo caminho do rediscar do histórico).
export async function startChatyyCall({ email, name, video, conversationId, router } = {}) {
  const calleeEmail = String(email || '').trim();
  if (!calleeEmail) return false;
  const calleeName = name || calleeEmail.split('@')[0];
  const isVideo = video ? '1' : '0';
  const _jsRoute = (cid) => {
    try {
      router?.push?.(`/call?callId=${cid}&contactName=${encodeURIComponent(calleeName)}&contactEmail=${encodeURIComponent(calleeEmail)}&isVideo=${isVideo}&conversationId=${conversationId || ''}&isCaller=1`);
    } catch {}
  };
  try {
    const voipNative = require('./voipNative');
    await voipNative.startOutgoingCall({
      calleeEmail, calleeName, isVideo: !!video, conversationId: conversationId || '', onWebFallback: _jsRoute,
    });
    return true;
  } catch (e) {
    console.warn('[chatyyOnlyCalls] startOutgoingCall failed:', e?.message || e);
    if (Platform.OS === 'web') { _jsRoute(`call_${Date.now()}`); return true; }
    return false;
  }
}

// Folha simples "Fulano ainda não está no Chatyy" → Convidar.
export function promptInviteToChatyy(t, { phone, name } = {}) {
  const inv = require('./inviteContact');
  const who = name || phone || '';
  const title = _tr(t, 'calls.notOnChatyyTitle', 'Ainda não está no Chatyy');
  const body = _tr(t, 'calls.notOnChatyyBody', 'As ligações são só pelo Chatyy, grátis por voz e vídeo. Convide {name} para o Chatyy.').replace('{name}', who);
  const buttons = [
    { text: _tr(t, 'common.cancel', 'Cancelar'), style: 'cancel' },
    {
      text: _tr(t, 'invite.toChatyy', 'Convidar para o Chatyy'),
      onPress: () => {
        try {
          if (phone && Platform.OS !== 'web') inv.inviteBySms(t, phone, name);
          else inv.shareInvite(t, name);
        } catch {}
      },
    },
  ];
  try { require('./alerts').safeAlert(title, body, buttons); } catch {}
}

// Número de telefone → ligação Chatyy se a pessoa tem conta; senão convite.
// Nunca disca PSTN / tel:.
export async function callPhoneViaChatyy({ phone, email, name, video, router, t, onNotOnChatyy } = {}) {
  if (!phone && !email) return false;
  let r = null;
  try { r = await require('./api').chatCheckChatyy({ email: email || '', phone: phone || '' }); } catch {}
  const target = r?.data?.has_chatyy ? (r.data.email || email || '') : '';
  if (target) return startChatyyCall({ email: target, name, video, router });
  if (typeof onNotOnChatyy === 'function') onNotOnChatyy();
  else promptInviteToChatyy(t, { phone, name });
  return false;
}
