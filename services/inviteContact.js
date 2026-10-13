// [2026-10-13 contacts-invite] Convite de contato SEM conta Chatyy (padrão
// WhatsApp "Convidar para o WhatsApp"): link + texto i18n, canais nativos
// (compartilhar / SMS / WhatsApp / e-mail) e ações do número (ligar, SMS,
// copiar).
//
// Link: https://chatyy.com.br/baixar (página que já redireciona p/ a loja certa)
// + ?ref=<código de indicação> quando o código já está em cache. O código vem do
// get_referral_code existente (o mesmo de Configurações → Convidar amigos; a
// chamada também registra código→e-mail em chat_referral_codes). Busca 1x e
// guarda 30 dias — nunca bloqueia o convite (sem código = link sem ref).
import { Platform, Share, Linking } from 'react-native';
import { getCachedSync, setCache } from './cache';

export const INVITE_BASE_URL = 'https://chatyy.com.br/baixar';
const REF_CACHE_KEY = 'invite_ref_code_v1';
const REF_TTL_MS = 30 * 24 * 3600 * 1000;
let _refInflight = null;

function _cachedRef() {
  try { const c = getCachedSync(REF_CACHE_KEY); return typeof c === 'string' && /^[A-Z0-9]{4,16}$/.test(c) ? c : ''; } catch { return ''; }
}

/** Busca (1x) o código de indicação em 2º plano. Seguro chamar várias vezes. */
export function prefetchInviteRef() {
  if (_cachedRef() || _refInflight) return _refInflight || Promise.resolve(_cachedRef());
  _refInflight = (async () => {
    try {
      const api = require('./api');
      const r = await api.getReferralCode?.();
      const code = String(r?.data?.code || '').toUpperCase();
      if (code && /^[A-Z0-9]{4,16}$/.test(code)) { try { await setCache(REF_CACHE_KEY, code, REF_TTL_MS); } catch {} return code; }
    } catch {}
    return '';
  })().finally(() => { _refInflight = null; });
  return _refInflight;
}

export function getInviteLink() {
  const ref = _cachedRef();
  return ref ? `${INVITE_BASE_URL}?ref=${encodeURIComponent(ref)}` : INVITE_BASE_URL;
}

export function buildInviteMessage(t, name) {
  const link = getInviteLink();
  let msg = '';
  try { msg = t ? t('invite.message', { link }) : ''; } catch {}
  if (!msg || msg === 'invite.message') msg = `Vem conversar comigo no Chatyy! É grátis e seguro. Baixe aqui: ${link}`;
  if (!msg.includes(link)) msg = `${msg} ${link}`;
  const first = String(name || '').trim().split(/\s+/)[0];
  return first && !first.includes('@') && !/^\+?\d/.test(first) ? `${first}, ${msg}` : msg;
}

// ── número ──────────────────────────────────────────────────────────────
function _regionCC() {
  try {
    const loc = require('expo-localization').getLocales?.()?.[0];
    const rc = String(loc?.regionCode || '').toUpperCase();
    return { BR: '55', US: '1', CA: '1', PT: '351' }[rc] || '';
  } catch { return ''; }
}

/** Número em formato internacional (só dígitos, com DDI) — p/ wa.me. */
export function toIntlDigits(phone) {
  const raw = String(phone || '').trim();
  let d = raw.replace(/\D/g, '');
  if (!d) return '';
  if (raw.startsWith('+')) return d;
  if (d.startsWith('00')) return d.slice(2);
  const cc = _regionCC();
  if (cc === '55' && (d.length === 10 || d.length === 11)) return '55' + d.replace(/^0+/, '');
  if (cc === '1' && d.length === 10) return '1' + d;
  if (cc === '351' && d.length === 9) return '351' + d;
  return d;
}

function _dialable(phone) {
  const raw = String(phone || '').trim();
  const d = raw.replace(/[^\d+]/g, '');
  return d;
}

function _open(url) { try { Linking.openURL(url).catch(() => {}); } catch {} }

// ── ações ───────────────────────────────────────────────────────────────
export async function shareInvite(t, name) {
  const message = buildInviteMessage(t, name);
  if (Platform.OS === 'web') {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share({ title: 'Chatyy', text: message });
        return true;
      }
    } catch (e) { if (e && e.name === 'AbortError') return false; }
    return copyText(message, t, t?.('invite.linkCopied') || 'Convite copiado');
  }
  try { await Share.share({ message, title: 'Chatyy' }); return true; } catch { return false; }
}

export function inviteBySms(t, phone, name) {
  const num = _dialable(phone);
  if (!num) return;
  const body = encodeURIComponent(buildInviteMessage(t, name));
  _open(Platform.OS === 'ios' ? `sms:${num}&body=${body}` : `sms:${num}?body=${body}`);
}

export function inviteByWhatsApp(t, phone, name) {
  const d = toIntlDigits(phone);
  const text = encodeURIComponent(buildInviteMessage(t, name));
  _open(d ? `https://wa.me/${d}?text=${text}` : `https://wa.me/?text=${text}`);
}

export async function inviteByEmail(t, email, name) {
  const alert = (title, msg) => { try { require('./alerts').safeAlert(title, msg); } catch {} };
  try {
    const r = await require('./api').sendInvite(email, name || '');
    if (r?.success) alert('', t?.('chat.inviteSentTo', { email }) || `Convite enviado para ${email}`);
    else alert(t?.('common.error') || 'Erro', r?.message || t?.('common.genericError') || '');
  } catch {
    alert(t?.('common.error') || 'Erro', t?.('common.networkError') || '');
  }
}

export function callNumber(phone) {
  const num = _dialable(phone);
  if (num) _open(`tel:${num}`);
}

export function smsNumber(phone) {
  const num = _dialable(phone);
  if (num) _open(`sms:${num}`);
}

export async function copyText(text, t, okMsg) {
  let ok = false;
  try {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(String(text)); ok = true;
    } else {
      const Clipboard = require('expo-clipboard');
      await Clipboard.setStringAsync(String(text)); ok = true;
    }
  } catch {}
  if (ok) {
    try {
      if (Platform.OS === 'android') require('react-native').ToastAndroid.show(okMsg || 'OK', 0);
      else require('./alerts').safeAlert('', okMsg || 'OK');
    } catch {}
  }
  return ok;
}
