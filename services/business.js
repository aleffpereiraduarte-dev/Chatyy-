// [conta-empresarial 2026-10-24] Conta empresarial + Bia atendente + "Bia responde por mim".
// Servidor: /root/conta-empresarial-2026-10-24 (ações biz_* em email.php → business.php), tudo atrás de
// allowlist no servidor (biz_status.enabled=false fora dela → o app esconde as telas e as linhas).
// Kill OTA: globalThis.__chatyy_business = false.
import * as api from './api';
import * as settingsCache from './settingsCache';

export const BIZ_BOT_EMAIL = 'bia@bots.chatyy';
export const BIZ_CATEGORIES = ['restaurant', 'food_delivery', 'bakery', 'market', 'fashion', 'beauty', 'health', 'fitness', 'education',
  'services', 'retail', 'tech', 'auto', 'home', 'events', 'travel', 'pets', 'creator', 'ngo', 'other'];
export const BIZ_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const ORDER_STATUSES = ['new', 'confirmed', 'ready', 'delivered', 'cancelled'];

function _killed() { try { return globalThis.__chatyy_business === false; } catch { return false; } }

async function call(action, params, method) {
  try {
    const r = await api.apiCall(action, params || {}, method || (params ? 'POST' : 'GET'));
    if (r && r.success) return { ok: true, data: r.data || {} };
    const err = (r && r.data && r.data.error) || (r && r.message) || 'error';
    return { ok: false, error: String(err), data: (r && r.data) || {} };
  } catch (e) {
    return { ok: false, error: 'network' };
  }
}

// ─── flag / estado ──────────────────────────────────────────────────────────
const STATUS_KEY = 'biz_status_v1';
/** síncrono (cache do último biz_status): a conta tem as telas novas? */
export function bizEnabledSync() {
  if (_killed()) return false;
  try { const s = settingsCache.peek(STATUS_KEY); return !!(s && s.enabled); } catch { return false; }
}
export function bizStatusCached() { try { return settingsCache.peek(STATUS_KEY) || null; } catch { return null; } }
export async function bizStatus() {
  if (_killed()) return { ok: true, data: { enabled: false } };
  const r = await call('biz_status');
  if (r.ok) { try { settingsCache.put(STATUS_KEY, r.data); } catch {} }
  return r;
}

// ─── conta ──────────────────────────────────────────────────────────────────
export function normalizeCnpj(s) { return String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 14); }
/** máscara 00.000.000/0000-00 (também alfanumérico 2026: AA.AAA.AAA/AAAA-00) */
export function maskCnpj(s) {
  const c = normalizeCnpj(s);
  let out = '';
  for (let i = 0; i < c.length; i++) {
    if (i === 2 || i === 5) out += '.';
    if (i === 8) out += '/';
    if (i === 12) out += '-';
    out += c[i];
  }
  return out;
}
/** dígitos verificadores (IN RFB 2.229/2024: valor = código ASCII − 48) — o servidor confere de novo */
export function cnpjValid(s) {
  const c = normalizeCnpj(s);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c) || /^(.)\1{13}$/.test(c)) return false;
  for (const len of [12, 13]) {
    let sum = 0; let w = 2;
    for (let i = len - 1; i >= 0; i--) { sum += (c.charCodeAt(i) - 48) * w; w = w === 9 ? 2 : w + 1; }
    const r = sum % 11;
    if (Number(c[len]) !== (r < 2 ? 0 : 11 - r)) return false;
  }
  return true;
}
export const cnpjLookup = (cnpj) => call('biz_cnpj_lookup', { cnpj: normalizeCnpj(cnpj) });
export const bizCreate = (p) => call('biz_create', p);
export const bizDispute = (cnpj) => call('biz_dispute', { cnpj: normalizeCnpj(cnpj) });
export const bizRemove = () => call('biz_remove', {});

// ─── perfil / público ───────────────────────────────────────────────────────
export const profileGet = () => call('biz_profile_get');
export const profileSave = (p) => call('biz_profile_save', p);
export const publicGet = (email, catalog = true) => call('biz_public', { email, catalog: catalog ? 1 : 0 });

const _pubCache = new Map(); // email → { at, v }
const _pubWait = new Map();
/** cartão curto (rótulo "Conta comercial") com cache 10 min; null = conta pessoal */
export async function publicCardShort(email) {
  const e = String(email || '').toLowerCase();
  if (!e || _killed() || e.endsWith('@bots.chatyy')) return null;
  const hit = _pubCache.get(e);
  if (hit && Date.now() - hit.at < 600000) return hit.v;
  if (_pubWait.has(e)) return _pubWait.get(e);
  const p = (async () => {
    const r = await call('biz_public_batch', { emails: [e] });
    const v = r.ok && r.data && r.data.businesses ? (r.data.businesses[e] || null) : (hit ? hit.v : null);
    _pubCache.set(e, { at: Date.now(), v });
    _pubWait.delete(e);
    return v;
  })();
  _pubWait.set(e, p);
  return p;
}
export function publicCardPeek(email) { const h = _pubCache.get(String(email || '').toLowerCase()); return h ? h.v : undefined; }

// ─── catálogo ───────────────────────────────────────────────────────────────
export const catalogList = (email) => call('biz_catalog_list', email ? { email } : {}, email ? 'POST' : 'GET');
export const itemSave = (it) => call('biz_item_save', it);
export const itemDelete = (id) => call('biz_item_delete', { id });

// ─── mensagens / etiquetas ──────────────────────────────────────────────────
export const messagesGet = () => call('biz_messages_get');
export const messagesSave = (p) => call('biz_messages_save', p);
export const labelsList = () => call('biz_labels_list');
export const labelSave = (p) => call('biz_label_save', p);
export const labelDelete = (id) => call('biz_label_delete', { id });
export const labelAssign = (customer_email, label_ids) => call('biz_label_assign', { customer_email, label_ids });
export const customerLabels = (customer_email) => call('biz_customer_labels', { customer_email });

// ─── Bia ────────────────────────────────────────────────────────────────────
export const biaGet = () => call('biz_bia_get');
export const biaSave = (p) => call('biz_bia_save', p);
/** abre (cria) a conversa "Configurar Bia" → { conversation_id } */
export const biaOpen = (menu = false) => call('biz_bia_open', menu ? { menu: 1 } : {});
export const replyGet = () => call('biz_reply_get');
export const replySave = (p) => call('biz_reply_save', p);
export const notesList = () => call('biz_notes_list');

// ─── pedidos ────────────────────────────────────────────────────────────────
export const ordersList = (status, before_id) => call('biz_orders_list', { status: status || '', before_id: before_id || 0 });
export const orderStatus = (id, status) => call('biz_order_status', { id, status });

// ─── botões das mensagens da Bia ────────────────────────────────────────────
export const pressButton = (conversation_id, message_id, data) => call('biz_button', { conversation_id, message_id, data });

// ─── formatação ─────────────────────────────────────────────────────────────
export function money(cents, currency = 'BRL') {
  const v = (Number(cents) || 0) / 100;
  try {
    const loc = currency === 'USD' ? 'en-US' : (currency === 'EUR' ? 'de-DE' : 'pt-BR');
    return new Intl.NumberFormat(loc, { style: 'currency', currency }).format(v);
  } catch {
    return (currency === 'BRL' ? 'R$ ' : currency + ' ') + v.toFixed(2).replace('.', ',');
  }
}
/** "12,50" | "12.50" → centavos (ou null) */
export function parseMoney(s) {
  let x = String(s == null ? '' : s).replace(/[^0-9,.]/g, '');
  if (!x) return null;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(x)) x = x.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(x)) x = x.replace(/,/g, '');
  else x = x.replace(',', '.');
  const n = Number(x);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}
export function centsToInput(c) { const n = (Number(c) || 0) / 100; return n ? n.toFixed(2).replace('.', ',') : ''; }
export function emptyHours() { const d = {}; BIZ_DAYS.forEach((k) => { d[k] = []; }); return { tz: _tz(), days: d }; }
function _tz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo'; } catch { return 'America/Sao_Paulo'; } }
export function normalizeHours(h) {
  const base = emptyHours();
  if (!h || typeof h !== 'object') return base;
  const days = {};
  BIZ_DAYS.forEach((k) => { days[k] = Array.isArray(h.days && h.days[k]) ? h.days[k].filter((iv) => Array.isArray(iv) && iv.length >= 2) : []; });
  return { tz: h.tz || base.tz, days };
}
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
export function fixTime(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return String(s || '').trim();
  const hh = Math.min(24, Number(m[1])); const mm = m[2] ? Math.min(59, Number(m[2])) : 0;
  return `${String(hh).padStart(2, '0')}:${String(hh === 24 ? 0 : mm).padStart(2, '0')}`;
}
