// [guest-reels 2026-10-22] Reels SEM LOGIN (modo convidado, como o TikTok).
//
// Fala direto com /api/reels.php?action=reels_public_* (servidor: reels-public.php) — sem
// bearer, sem cookie (credentials: 'omit'). Só leitura; a sessão anônima do "Para você" é um
// id ALEATÓRIO deste aparelho/navegador (sem vínculo com conta), guardado localmente e no
// Redis do servidor por 24 h. Sinais (tempo assistido, compartilhar, "não tenho interesse")
// vão para reels_public_events e só ajustam essa sessão.
//
// Kill no app: globalThis.__chatyy_guest_reels = false (o botão "Assistir Reels" some e a
// tela mostra "indisponível"). Kill no servidor: data/.guest-reels-off (→ guest_reels_off).
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from './api';

const SID_KEY = '@chatyy:guest_reels_sid_v1';
const ORIGIN = 'https://chatyy.com.br';
export const GUEST_REELS_WEB = ORIGIN;

export function isGuestReelsEnabled() {
  try { return globalThis.__chatyy_guest_reels !== false; } catch { return true; }
}

function _bases() {
  const out = [];
  try {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && /(^|\.)chatyy\.com\.br$/i.test(window.location.hostname || '')) {
      out.push(window.location.origin);
    }
  } catch {}
  try { const b = api.BASE_URL; if (typeof b === 'string' && /^https:\/\//.test(b)) out.push(b.replace(/\/+$/, '')); } catch {}
  out.push(ORIGIN);
  return [...new Set(out)];
}

async function _call(action, { query = {}, body = null, timeoutMs = 12000 } = {}) {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  let last = null;
  for (const base of _bases()) {
    const url = `${base}/api/reels.php?action=${action}${qs ? '&' + qs : ''}`;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const tm = ctl ? setTimeout(() => { try { ctl.abort(); } catch {} }, timeoutMs) : null;
    try {
      const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        credentials: 'omit',
        headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl ? ctl.signal : undefined,
      });
      let j = null;
      try { j = await res.json(); } catch {}
      if (j && typeof j === 'object') {
        // edge sem o arquivo ainda (sync ≤ 15 min) → 404 sem o cabeçalho JSON nosso: tenta a origem
        if (res.status === 404 && !j.error) { last = j; continue; }
        return { ...j, status: res.status };
      }
      last = { success: false, error: `http_${res.status}`, status: res.status };
      if (res.status >= 500 || res.status === 404) continue;
      return last;
    } catch (e) {
      last = { success: false, error: 'network', message: String(e?.message || e) };
    } finally {
      if (tm) clearTimeout(tm);
    }
  }
  return last || { success: false, error: 'network' };
}

let _sidMem = null;
function _newSid() {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let s = '';
  try {
    const c = globalThis.crypto;
    if (c && typeof c.getRandomValues === 'function') {
      const a = new Uint8Array(24); c.getRandomValues(a);
      for (let i = 0; i < a.length; i++) s += abc[a[i] % 64];
      return s;
    }
  } catch {}
  for (let i = 0; i < 24; i++) s += abc[Math.floor(Math.random() * 64)];
  return s;
}
/** Id anônimo da sessão de Reels deste aparelho (não identifica a pessoa). */
export async function getGuestSid() {
  if (_sidMem) return _sidMem;
  try {
    const v = await AsyncStorage.getItem(SID_KEY);
    if (v && /^[A-Za-z0-9_-]{16,64}$/.test(v)) { _sidMem = v; return v; }
  } catch {}
  _sidMem = _newSid();
  try { await AsyncStorage.setItem(SID_KEY, _sidMem); } catch {}
  return _sidMem;
}
export async function resetGuestSid() {
  _sidMem = null;
  try { await AsyncStorage.removeItem(SID_KEY); } catch {}
}

/** "Para você" anônimo (POST, nunca em cache). Falhou → "Populares" genérico (GET, cache do CDN). */
export async function guestReelsFeed({ cursor = null, limit = 10, excludeIds = [], popularCursor = null } = {}) {
  if (!isGuestReelsEnabled()) return { success: false, error: 'guest_reels_off' };
  const sid = await getGuestSid();
  const r = await _call('reels_public_feed', { body: { sid, limit, cursor: cursor || '', exclude_ids: (excludeIds || []).slice(-300) } });
  if (r && r.success) return r;
  if (r && r.error === 'guest_reels_off') return r;
  return _call('reels_public_feed', { query: { limit, cursor: popularCursor || '' } });
}

export async function guestReelsPopular({ cursor = null, limit = 10 } = {}) {
  return _call('reels_public_feed', { query: { limit, cursor: cursor || '' } });
}

export async function guestReelGet(id) {
  const n = Number(id);
  if (!n || n <= 0) return { success: false, error: 'not_found' };
  return _call('reels_public_get', { query: { id: n } });
}

export async function guestReelComments(id, cursor = null) {
  return _call('reels_public_comments', { query: { id: Number(id) || 0, cursor: cursor || '' } });
}

// type: view | share | not_interested
export async function guestReelsEvents(events) {
  const sid = await getGuestSid();
  return _call('reels_public_events', { body: { sid, events } });
}

/** Link público do reel (abre sem login: /r/<id>). */
export function guestReelUrl(id) {
  return `${ORIGIN}/r/${encodeURIComponent(String(id))}`;
}

