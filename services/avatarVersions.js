// [2026-10-12 avatar-realtime] Fonte ÚNICA da versão (cache-buster `v=`) da foto
// de perfil por e-mail. Antes havia 2 mapas que divergiam: services/api.js
// (`_avatarCacheBust`, AsyncStorage hidratado async) e components/AvatarCircle.js
// (`_avatarVersions`, MMKV lido no load do módulo — antes do cache-ready, então
// muitas vezes vazio). Resultado: "quando alguém troca a foto não atualiza na
// hora" — a URL `get_avatar&email=X` só muda quando `v=` muda (servidor responde
// max-age=86400 e o Cloudflare guarda), e quase nada alimentava a versão.
//
// Quem alimenta agora:
//   - WS `avatar_updated` (hub manda em chat_user_<contato> — services/websocket.js)
//   - resposta do upload_avatar (a própria foto, otimista)
//   - QUALQUER payload de API com `{email, avatar_version}` ou URL
//     `get_avatar&email=X&v=N` (chat_list members, perfil, seguidores, status…)
//     via ingestAvatarVersions() chamado pelo apiCall.
//
// Regra: só AVANÇA (monotônico, comparando em segundos — valores em ms vindos de
// bumps locais `Date.now()` são normalizados), pra um payload velho do cache
// (SWR/offline) nunca voltar a URL pra foto antiga.
const STORE_KEY = 'avatar_versions_v1'; // mesma chave que o AvatarCircle já usava
const _map = new Map(); // email(lower) → versão crua (s ou ms)
const _subs = new Map(); // email → Set<fn>
const _anySubs = new Set();
let _mmkv = null;
try { _mmkv = require('./mmkv'); } catch {}

export function normAvatarVersion(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

function _key(email) {
  if (!email || typeof email !== 'string') return '';
  let e = email.trim().toLowerCase();
  const m = e.match(/<([^>]+@[^>]+)>/);
  if (m) e = m[1].trim();
  return e.includes('@') ? e : '';
}

// Aceita `next` sobre `cur`? Avança só se for mais novo. Exceção: o valor atual
// veio de um bump local em ms (relógio do aparelho) e o servidor manda a versão
// oficial em segundos praticamente igual (±5 min de relógio) → adota a oficial
// (assim a URL bate com a dos outros aparelhos/CDN).
function _accepts(cur, next) {
  const c = normAvatarVersion(cur);
  const n = normAvatarVersion(next);
  if (!n) return false;
  if (!c) return true;
  if (n > c) return true;
  if (Number(cur) > 1e11 && Number(next) <= 1e11 && n >= c - 300 && Number(next) !== Number(cur)) return true;
  return false;
}

let _writeTimer = null;
function _persist() {
  if (_writeTimer) return;
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    try {
      const obj = {};
      for (const [k, v] of _map) obj[k] = v;
      _mmkv?.setString?.(STORE_KEY, JSON.stringify(obj));
    } catch {}
  }, 300);
}

function _notify(changed) {
  if (!changed || changed.size === 0) return;
  for (const e of changed) {
    const set = _subs.get(e);
    if (set) set.forEach((fn) => { try { fn(e); } catch {} });
  }
  _anySubs.forEach((fn) => { try { fn(changed); } catch {} });
}

function _mergeObj(obj, changed) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const e = _key(k);
    const v = Number(obj[k]);
    if (!e || !(v > 0)) continue;
    if (_accepts(_map.get(e), v)) { _map.set(e, v); changed?.add(e); }
  }
}

// Hidratação: MMKV (sync, se já pronto) + de novo quando o cache ficar pronto +
// o mapa legado do api.js (AsyncStorage `avatar_v_map`). Sempre mescla com a
// regra monotônica e avisa quem já renderizou.
function _hydrateFromMmkv() {
  const changed = new Set();
  try {
    const raw = _mmkv?.getString?.(STORE_KEY);
    if (raw) _mergeObj(JSON.parse(raw), changed);
  } catch {}
  return changed;
}
try { _hydrateFromMmkv(); } catch {}
try {
  const p = _mmkv?.waitForCacheReady?.();
  if (p && typeof p.then === 'function') {
    p.then(() => {
      const ch = _hydrateFromMmkv();
      if (_map.size) _persist();
      _notify(ch);
    }).catch(() => {});
  }
} catch {}
(async () => {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const raw = await AsyncStorage.getItem('avatar_v_map');
    if (!raw) return;
    const ch = new Set();
    _mergeObj(JSON.parse(raw), ch);
    if (ch.size) { _persist(); _notify(ch); }
  } catch {}
})();

export function getAvatarVersion(email) {
  const e = _key(email);
  return e ? (_map.get(e) || 0) : 0;
}

/**
 * Grava a versão da foto de `email`.
 *  - `version` > 0 → versão do servidor (só avança).
 *  - sem versão + force → bump local Date.now() (ex.: acabou de enviar e o
 *    servidor não devolveu avatar_version).
 * Retorna true se mudou (e já avisou os assinantes).
 */
export function setAvatarVersion(email, version, opts = {}) {
  const e = _key(email);
  if (!e) return false;
  const hasVer = typeof version === 'number' ? version > 0 : Number(version) > 0;
  let next;
  if (hasVer) {
    next = Number(version);
    if (!_accepts(_map.get(e), next)) return false;
  } else {
    if (!opts.force) return false;
    next = Date.now();
  }
  _map.set(e, next);
  _persist();
  _notify(new Set([e]));
  return true;
}

export function subscribeAvatarVersion(email, fn) {
  const e = _key(email);
  if (!e || typeof fn !== 'function') return () => {};
  let set = _subs.get(e);
  if (!set) { set = new Set(); _subs.set(e, set); }
  set.add(fn);
  return () => {
    const s = _subs.get(e);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) _subs.delete(e);
  };
}

// Assinatura global (recebe o Set de e-mails que mudaram num lote).
export function subscribeAnyAvatarVersion(fn) {
  if (typeof fn !== 'function') return () => {};
  _anySubs.add(fn);
  return () => { _anySubs.delete(fn); };
}

// e-mail do parâmetro `email=` de uma URL get_avatar (ou '').
export function emailFromAvatarUrl(url) {
  if (!url || typeof url !== 'string' || url.indexOf('get_avatar') === -1) return '';
  const m = url.match(/[?&]email=([^&#]+)/);
  if (!m) return '';
  try { return _key(decodeURIComponent(m[1].replace(/\+/g, ' '))); } catch { return ''; }
}
function _vFromUrl(url) {
  const m = url.match(/[?&]v=(\d+)/);
  return m ? Number(m[1]) : 0;
}

// Sobrepõe a versão conhecida numa URL get_avatar montada pelo servidor
// (`conv.avatar_url`, `sender_avatar`…): se o mapa tem versão mais nova que o
// `v=` da URL (ou a URL não tem `v=`), troca/insere `v=`. Outras URLs passam.
export function withLatestAvatarVersion(url) {
  if (!url || typeof url !== 'string' || url.indexOf('get_avatar') === -1) return url;
  const e = emailFromAvatarUrl(url);
  if (!e) return url;
  const known = _map.get(e) || 0;
  if (!known) return url;
  const inUrl = _vFromUrl(url);
  if (inUrl && !_accepts(inUrl, known)) return url;
  let out = url.replace(/([?&])v=[^&#]*/g, '$1').replace(/\?&/g, '?').replace(/&&+/g, '&').replace(/[?&]$/, '');
  // sem `v=` a URL carregava `av=` (versão do desenho das iniciais) — com foto real não precisa
  out = out.replace(/([?&])av=\d+/g, '$1').replace(/\?&/g, '?').replace(/&&+/g, '&').replace(/[?&]$/, '');
  return `${out}${out.indexOf('?') === -1 ? '?' : '&'}v=${known}`;
}

// ── Ingestão de payloads ──────────────────────────────────────────────
// Varre (limitado) a resposta procurando `{email, avatar_version}` e URLs
// `get_avatar&email=X&v=N`. O mesmo objeto (SWR devolve a mesma referência)
// só é varrido uma vez.
const _seen = typeof WeakSet === 'function' ? new WeakSet() : null;
const MAX_NODES = 20000;
export function ingestAvatarVersions(payload) {
  if (!payload || typeof payload !== 'object') return 0;
  if (_seen) { if (_seen.has(payload)) return 0; try { _seen.add(payload); } catch {} }
  const changed = new Set();
  let nodes = 0;
  const offer = (email, v) => {
    const e = _key(email);
    const n = Number(v);
    if (!e || !(n > 0)) return;
    if (_accepts(_map.get(e), n)) { _map.set(e, n); changed.add(e); }
  };
  const visitStr = (s) => {
    if (s.length > 2048 || s.indexOf('get_avatar') === -1) return;
    const v = _vFromUrl(s);
    if (v > 0) offer(emailFromAvatarUrl(s), v);
  };
  const walk = (node, depth) => {
    if (nodes++ > MAX_NODES || depth > 8 || !node) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const x = node[i];
        if (x && typeof x === 'object') walk(x, depth + 1);
        else if (typeof x === 'string') visitStr(x);
      }
      return;
    }
    if (typeof node !== 'object') return;
    const av = node.avatar_version;
    if (av != null && typeof node.email === 'string') offer(node.email, av);
    for (const k in node) {
      const x = node[k];
      if (!x) continue;
      if (typeof x === 'string') visitStr(x);
      else if (typeof x === 'object') walk(x, depth + 1);
    }
  };
  try { walk(payload, 0); } catch {}
  if (changed.size) { _persist(); _notify(changed); }
  return changed.size;
}

// Hook React: versão atual + re-render quando mudar.
let _React = null;
try { _React = require('react'); } catch {}
export function useAvatarVersion(email) {
  const e = _key(email);
  const [v, setV] = _React.useState(() => (e ? (_map.get(e) || 0) : 0));
  _React.useEffect(() => {
    setV(e ? (_map.get(e) || 0) : 0);
    if (!e) return undefined;
    return subscribeAvatarVersion(e, () => setV(_map.get(e) || 0));
  }, [e]);
  return v;
}
