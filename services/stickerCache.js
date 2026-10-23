// services/stickerCache.js — [2026-10-19 sticker-cache] Figurinhas e GIFs
// "salvos para sempre" (founder: "meus stickers até gifs deveria tudo ficar
// salvo em cache para sempre carregar mais rápido").
//
// Três camadas, todas POR CONTA (namespace = hash do e-mail ativo):
//   1. Metadados no KV (services/mmkv, leitura síncrona): pacotes instalados,
//      itens de cada pacote, "minhas figurinhas", meus pacotes, favoritas,
//      recentes (figurinhas + GIFs), favoritos de GIF e o JSON das buscas de GIF
//      (tendências / buscas recentes, com TTL). O seletor pinta disso no 1º frame
//      (offline também) e o servidor revalida em 2º plano — só re-renderiza /
//      baixa o que MUDOU (diff por assinatura das URLs).
//   2. Arquivos no disco durável: documentDirectory/chatyy-stk/<conta>/<chave>,
//      chave = mesma normalização de URL do mediaCache (alias CDN/origem, sem
//      query de assinatura) → a figurinha (id/URL) tem UM arquivo. Teto 300 MB
//      com LRU; itens "fixados" (favoritas, recentes, minhas, pacotes
//      instalados, GIFs recentes/favoritos) só saem depois de todo o resto.
//      O índice guarda só o NOME do arquivo — o caminho é remontado com o
//      documentDirectory atual (o container do iOS muda de UUID em updates).
//   3. Pré-busca em 2º plano: pacotes instalados + minhas + favoritas +
//      recentes, só no Wi-Fi, depois do boot (bootIdle) e ao abrir o seletor.
//
// Quem usa: StickerPicker / GifPicker (JS), NativeEmojiPanelBridge (painel
// nativo recebe file:// — EPImageLoader no iOS e Glide no Android aceitam),
// ChatMedia (bolhas de figurinha/GIF na conversa JS, cacheKind="sticker") e
// nativeThreadList (lista nativa: figurinha / GIF externo → file:// quando já
// está no disco). Web: só a camada 1 (o navegador cuida do HTTP cache).
//
// Kill switch (OTA): globalThis.__chatyy_sticker_cache === false → sem disco,
// sem pré-busca, sem file:// (tudo volta a buscar a URL como antes). Recentes e
// favoritas continuam no KV por conta (correção de privacidade, não é cache).
import { Platform } from 'react-native';

const DIR = 'chatyy-stk';
const CAP_BYTES = 300 * 1024 * 1024;
const EVICT_TO = Math.floor(CAP_BYTES * 0.9);
const MAX_FILE_BYTES = 15 * 1024 * 1024; // figurinha/GIF de prévia; acima disso não guarda
const MAX_PARALLEL = 3;
const IDX_PREFIX = 'stkc_idx1_';   // + conta → [[chave, arquivo, bytes, últimoUso, kind]]
const META_PREFIX = 'stkc_m1_';    // + conta + '_' + nome
const GIF_Q_TTL_MS = 6 * 3600 * 1000;      // tendências
const GIF_SEARCH_TTL_MS = 24 * 3600 * 1000; // buscas
const GIF_Q_MAX = 12;
const RECENT_MAX = 30; // [2026-10-23 figurinhas-organizar] WhatsApp/Telegram ~30
const GIF_RECENT_MAX = 40;
const GIF_FAV_MAX = 100;
const PACK_ITEMS_TTL_MS = 10 * 60 * 1000;
const PREFETCH_EVERY_MS = 6 * 3600 * 1000;

const isWeb = Platform.OS === 'web';

export function stickerCacheOn() {
  if (isWeb) return false;
  try { if (globalThis.__chatyy_sticker_cache === false) return false; } catch {}
  return true;
}

// ── helpers ────────────────────────────────────────────────────────────────
function _kv() { try { return require('./mmkv'); } catch { return null; } }
function _api() { try { return require('./api'); } catch { return null; } }
let _FS;
function _fs() {
  if (isWeb) return null;
  if (_FS === undefined) {
    _FS = null;
    try { _FS = require('expo-file-system/legacy'); } catch { try { _FS = require('expo-file-system'); } catch { _FS = null; } }
  }
  return _FS;
}
function _h32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
function _acctEmail() {
  try { const a = _api(); return String((a && a.getActiveAccountEmail && a.getActiveAccountEmail()) || '').trim().toLowerCase(); } catch { return ''; }
}
let _acctMemoE = null; let _acctMemoId = '';
function _acctId(email) {
  const e = email != null ? String(email).trim().toLowerCase() : _acctEmail();
  if (!e) return '';
  if (e === _acctMemoE) return _acctMemoId;
  const id = _h32(e) + _h32(e + '#stk');
  if (email == null) { _acctMemoE = e; _acctMemoId = id; }
  return id;
}
function _arr(v) { return Array.isArray(v) ? v : []; }

/** URL absoluta (caminho /data/… → host de mídia). */
export function absStickerUrl(u) {
  if (typeof u !== 'string' || !u) return '';
  if (/^(file|data|content):/i.test(u)) return u;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('/data/') || u.startsWith('data/')) {
    const p = u.startsWith('/') ? u : '/' + u;
    try { const a = _api(); if (a && a.getMediaUrl) return a.getMediaUrl(p); } catch {}
    return 'https://chatyy.com.br' + p;
  }
  return '';
}
const _keyMemo = new Map();
function _keyOf(url) {
  if (typeof url !== 'string' || !url) return '';
  const m = _keyMemo.get(url);
  if (m !== undefined) return m;
  const k = _keyOfRaw(url);
  _keyMemo.set(url, k);
  if (_keyMemo.size > 3000) _keyMemo.delete(_keyMemo.keys().next().value);
  return k;
}
function _keyOfRaw(url) {
  const abs = absStickerUrl(url);
  if (!abs || !/^https?:/i.test(abs)) return '';
  try {
    const mc = require('./mediaCache');
    const k = mc.mediaUrlKey && mc.mediaUrlKey(abs);
    if (k) return k;
  } catch {}
  const base = abs.split('#')[0].split('?')[0];
  const ext = (base.match(/\.(webp|png|gif|jpe?g|json|mp4|tgs)$/i) || [])[1] || 'bin';
  return _h32(base) + _h32(base.split('').reverse().join('')) + '.' + ext.toLowerCase();
}

// ── metadados por conta (KV) ───────────────────────────────────────────────
function _metaKey(name, acct) {
  const a = acct != null ? acct : _acctId();
  return a ? META_PREFIX + a + '_' + name : '';
}
export function getStickerMeta(name) {
  const k = _metaKey(name);
  if (!k) return null;
  try { const kv = _kv(); return kv ? kv.getJSON(k) : null; } catch { return null; }
}
export function setStickerMeta(name, value) {
  const k = _metaKey(name);
  if (!k) return;
  try { const kv = _kv(); if (!kv) return; if (value == null) kv.remove(k); else kv.setJSON(k, value); } catch {}
  if (_PIN_META.has(name) || name.startsWith('pack_')) _pinsDirty = true;
}
/** Assinatura barata p/ diff (mudou algo na lista?). */
export function listSig(list) {
  try {
    const a = _arr(list).map((x) => (typeof x === 'string' ? x : (x && (x.url || x.image_url || x.id || x.sticker_url)) || '')).join('|');
    return a.length + ':' + _h32(a);
  } catch { return ''; }
}

// ── índice de arquivos (memória + KV) ──────────────────────────────────────
let _idxAcct = null;
let _idx = new Map(); // chave → { f, s, a, k }
let _total = 0;
let _persistT = null;
let _verified = new Set();
const _subs = new Set();
let _notifyT = null;

function _loadIdx() {
  const acct = _acctId();
  if (acct === _idxAcct) return acct;
  // KV ainda hidratando (boot): índice viria vazio e a verificação apagaria tudo
  // como "órfão" → espera (lookups dão null até lá).
  const kv0 = _kv();
  if (!acct || !kv0 || (kv0.isCacheReady && !kv0.isCacheReady())) return '';
  // troca de conta: grava já o índice pendente da conta anterior.
  if (_persistT && _idxAcct) {
    clearTimeout(_persistT); _persistT = null;
    try { const rows = []; for (const [k, e] of _idx) rows.push([k, e.f, e.s, e.a, e.k]); kv0.setJSON(IDX_PREFIX + _idxAcct, rows); } catch {}
  }
  _idxAcct = acct;
  _idx = new Map();
  _total = 0;
  _pins = null;
  if (!acct) return acct;
  try {
    const kv = _kv();
    const rows = kv ? kv.getJSON(IDX_PREFIX + acct) : null;
    for (const r of _arr(rows)) {
      if (!Array.isArray(r) || !r[0] || !r[1]) continue;
      const e = { f: String(r[1]), s: Number(r[2]) || 0, a: Number(r[3]) || 0, k: String(r[4] || '') };
      _idx.set(String(r[0]), e);
      _total += e.s;
    }
  } catch {}
  _verifyDir(acct);
  return acct;
}
function _persistIdx() {
  if (_persistT) return;
  _persistT = setTimeout(() => {
    _persistT = null;
    const acct = _idxAcct;
    if (!acct) return;
    try {
      const rows = [];
      for (const [k, e] of _idx) rows.push([k, e.f, e.s, e.a, e.k]);
      const kv = _kv();
      if (kv) kv.setJSON(IDX_PREFIX + acct, rows);
    } catch {}
  }, 2500);
}
function _dirFor(acct) {
  const fs = _fs();
  if (!fs || !fs.documentDirectory || !acct) return '';
  return fs.documentDirectory + DIR + '/' + acct + '/';
}
// 1ª vez por conta na sessão: tira do índice o que sumiu do disco (restauração,
// limpeza do sistema) e apaga arquivo órfão (fora do índice).
function _verifyDir(acct) {
  if (_verified.has(acct)) return;
  _verified.add(acct);
  const fs = _fs();
  const dir = _dirFor(acct);
  if (!fs || !dir) return;
  setTimeout(async () => {
    try {
      const info = await fs.getInfoAsync(dir);
      if (!info || !info.exists) {
        if (_idxAcct === acct && _idx.size) { _idx.clear(); _total = 0; _persistIdx(); }
        return;
      }
      const names = new Set(await fs.readDirectoryAsync(dir));
      if (_idxAcct !== acct) return;
      let changed = false;
      const known = new Set();
      for (const [k, e] of _idx) {
        if (!names.has(e.f)) { _idx.delete(k); _total -= e.s; changed = true; } else known.add(e.f);
      }
      for (const n of names) {
        if (known.has(n) || n.startsWith('.dl-')) continue; // .dl- = download em andamento
        if (_idx.has(n)) continue; // entrou no índice durante a varredura
        try { await fs.deleteAsync(dir + n, { idempotent: true }); } catch {}
      }
      if (changed) { _persistIdx(); _notify(); }
    } catch {}
  }, 1500);
}

function _notify() {
  if (_notifyT) return;
  _notifyT = setTimeout(() => {
    _notifyT = null;
    for (const cb of Array.from(_subs)) { try { cb(); } catch {} }
  }, 120);
}
/** Avisa (agrupado) quando arquivos novos entram no disco. Retorna unsubscribe. */
export function subscribeStickerCache(cb) {
  if (typeof cb !== 'function') return () => {};
  _subs.add(cb);
  return () => { _subs.delete(cb); };
}

/** file:// do arquivo já no disco, ou null. Síncrono (render). */
export function getStickerLocalSync(url) {
  if (!url || !stickerCacheOn()) return null;
  if (typeof url === 'string' && url.startsWith('file://')) return url;
  const acct = _loadIdx();
  if (!acct) return null;
  const key = _keyOf(url);
  const e = key ? _idx.get(key) : null;
  if (!e) return null;
  const now = Date.now();
  if (now - e.a > 60000) { e.a = now; _persistIdx(); }
  const dir = _dirFor(acct);
  return dir ? dir + e.f : null;
}
/** URL p/ desenhar: file:// se já baixado; senão a absoluta (e agenda o download). */
export function stickerDisplayUri(url, opts) {
  const abs = absStickerUrl(url);
  if (!abs) return typeof url === 'string' ? url : '';
  const loc = getStickerLocalSync(abs);
  if (loc) return loc;
  if (!(opts && opts.kick === false) && stickerCacheOn()) ensureStickerCached(abs, opts).catch(() => {});
  return abs;
}

// ── fixados (não saem antes do resto) ──────────────────────────────────────
const _PIN_META = new Set(['st_recent', 'st_fav', 'st_mine', 'gif_recent', 'gif_fav', 'mkt_packs']);
let _pins = null;
let _pinsDirty = true;
function _pinSet() {
  if (_pins && !_pinsDirty) return _pins;
  const s = new Set();
  const add = (u) => { const k = _keyOf(u); if (k) s.add(k); };
  try {
    _arr(getStickerMeta('st_recent')).forEach(add);
    _arr(getStickerMeta('st_fav')).forEach(add);
    _arr(getStickerMeta('st_mine')).forEach((x) => add(x && x.url));
    for (const g of [..._arr(getStickerMeta('gif_recent')), ..._arr(getStickerMeta('gif_fav'))]) { add(g && g.preview); add(g && g.medium); }
    for (const p of _arr(getStickerMeta('mkt_packs'))) {
      add(p && p.cover_url);
      _arr(getStickerMeta('pack_' + (p && p.id))).forEach((it) => add(it && (it.url || it.image_url)));
    }
  } catch {}
  _pins = s;
  _pinsDirty = false;
  return s;
}

// ── download ───────────────────────────────────────────────────────────────
const _inflight = new Map(); // chave → Promise
const _queue = []; // { run, pri }
let _running = 0;
const _failAt = new Map(); // chave → ts (não insiste por 10 min)

function _pump() {
  while (_running < MAX_PARALLEL && _queue.length) {
    _queue.sort((a, b) => b.pri - a.pri);
    const job = _queue.shift();
    _running++;
    Promise.resolve().then(job.run).catch(() => {}).then(() => { _running--; _pump(); });
  }
}

/**
 * Baixa p/ o disco (1× por chave). opts.priority 'high'|'normal'|'low';
 * opts.kind 'sticker'|'gif'|'lottie'. Resolve com file:// ou null.
 */
export function ensureStickerCached(url, opts) {
  if (!stickerCacheOn()) return Promise.resolve(null);
  const abs = absStickerUrl(url);
  if (!abs || !/^https?:/i.test(abs)) return Promise.resolve(null);
  const acct = _loadIdx();
  if (!acct) return Promise.resolve(null);
  const key = _keyOf(abs);
  if (!key) return Promise.resolve(null);
  const hit = _idx.get(key);
  if (hit) { const d = _dirFor(acct); return Promise.resolve(d ? d + hit.f : null); }
  if (_inflight.has(key)) return _inflight.get(key);
  const fa = _failAt.get(key);
  if (fa && Date.now() - fa < 10 * 60 * 1000) return Promise.resolve(null);
  const pri = opts && opts.priority === 'high' ? 2 : (opts && opts.priority === 'low' ? 0 : 1);
  const kind = (opts && opts.kind) || (/\.json(\?|#|$)/i.test(abs) ? 'lottie' : (/\.(gif|mp4)(\?|#|$)/i.test(abs) || /giphy|tenor/i.test(abs) ? 'gif' : 'sticker'));
  const p = new Promise((resolve) => {
    _queue.push({ pri, resolve, run: async () => { resolve(await _download(abs, key, acct, kind)); } });
    if (_queue.length > 600) {
      // fila cheia: descarta os de menor prioridade (resolvem null; baixam depois).
      _queue.sort((a, b) => b.pri - a.pri);
      _queue.splice(600).forEach((j) => { try { j.resolve(null); } catch {} });
    }
    _pump();
  }).finally(() => { _inflight.delete(key); });
  _inflight.set(key, p);
  return p;
}

async function _download(abs, key, acct, kind) {
  const fs = _fs();
  const dir = _dirFor(acct);
  if (!fs || !dir) return null;
  if (_idxAcct !== acct) return null; // conta trocou no meio
  const tmp = dir + '.dl-' + key;
  try {
    try { await fs.makeDirectoryAsync(dir, { intermediates: true }); } catch {}
    const r = await fs.downloadAsync(abs, tmp);
    const st = Number(r && r.status) || 0;
    let ct = '';
    try { const h = (r && r.headers) || {}; for (const k of Object.keys(h)) if (k.toLowerCase() === 'content-type') ct = String(h[k]).toLowerCase(); } catch {}
    // Edge que não tem /data/* devolve o index.html do SPA com 200 → não é figurinha.
    const bad = st !== 200 || /text\/html/.test(ct) || (kind !== 'lottie' && /^text\//.test(ct));
    let size = 0;
    if (!bad) { try { const info = await fs.getInfoAsync(tmp, { size: true }); size = Number(info && info.size) || 0; } catch {} }
    if (bad || size <= 0 || size > MAX_FILE_BYTES || _idxAcct !== acct) {
      try { await fs.deleteAsync(tmp, { idempotent: true }); } catch {}
      _failAt.set(key, Date.now());
      return null;
    }
    const dest = dir + key;
    try { await fs.deleteAsync(dest, { idempotent: true }); } catch {}
    await fs.moveAsync({ from: tmp, to: dest });
    const prev = _idx.get(key);
    if (prev) _total -= prev.s;
    _idx.set(key, { f: key, s: size, a: Date.now(), k: kind });
    _total += size;
    _persistIdx();
    _notify();
    if (_total > CAP_BYTES) _evict().catch(() => {});
    return dest;
  } catch {
    try { await fs.deleteAsync(tmp, { idempotent: true }); } catch {}
    _failAt.set(key, Date.now());
    return null;
  }
}

let _evicting = false;
async function _evict() {
  if (_evicting) return;
  _evicting = true;
  try {
    const fs = _fs();
    const acct = _idxAcct;
    const dir = _dirFor(acct);
    if (!fs || !dir) return;
    const pins = _pinSet();
    const all = Array.from(_idx.entries());
    // LRU: primeiro o que não é fixado (mais velho antes); depois os fixados.
    all.sort((x, y) => {
      const px = pins.has(x[0]) ? 1 : 0;
      const py = pins.has(y[0]) ? 1 : 0;
      if (px !== py) return px - py;
      return x[1].a - y[1].a;
    });
    for (const [k, e] of all) {
      if (_total <= EVICT_TO) break;
      try { await fs.deleteAsync(dir + e.f, { idempotent: true }); } catch {}
      _idx.delete(k);
      _total -= e.s;
    }
    _persistIdx();
  } finally { _evicting = false; }
}

/** Pré-busca em lote (baixa prioridade). wifiOnly=true → só no Wi-Fi. */
export function prefetchStickers(urls, opts) {
  if (!stickerCacheOn() || !urls || !urls.length) return;
  if (opts && opts.wifiOnly && !_onWifi()) return;
  const seen = new Set();
  for (const u of urls) {
    const abs = absStickerUrl(u);
    if (!abs || seen.has(abs) || !/^https?:/i.test(abs)) continue;
    seen.add(abs);
    if (seen.size > 400) break;
    ensureStickerCached(abs, { priority: 'low', kind: opts && opts.kind }).catch(() => {});
  }
}
function _onWifi() {
  try {
    const ni = require('./networkInfo');
    const t = ni.getNetworkType && ni.getNetworkType();
    if (t === 'wifi') return true;
    if (t && t !== 'unknown') return false;
    return !!(ni.isWifi && ni.isWifi());
  } catch { return false; }
}

// ── Lottie (.json) → objeto p/ <LottieView source={obj}> ───────────────────
const _lottieMem = new Map();
export function getLottieJsonSync(url) {
  const abs = absStickerUrl(url);
  return (abs && _lottieMem.get(abs)) || null;
}
/** Lê (ou baixa e lê) o JSON do Lottie do disco. Resolve com objeto ou null. */
export async function loadLottieJson(url) {
  const abs = absStickerUrl(url);
  if (!abs) return null;
  if (_lottieMem.has(abs)) return _lottieMem.get(abs);
  const fs = _fs();
  const local = getStickerLocalSync(abs) || await ensureStickerCached(abs, { priority: 'high', kind: 'lottie' });
  if (!local || !fs) return null;
  try {
    const txt = await fs.readAsStringAsync(local);
    const obj = JSON.parse(txt);
    if (!obj || typeof obj !== 'object') return null;
    _lottieMem.set(abs, obj);
    if (_lottieMem.size > 24) _lottieMem.delete(_lottieMem.keys().next().value);
    return obj;
  } catch { return null; }
}

// ── recentes / favoritas ───────────────────────────────────────────────────
const LEGACY = { st_recent: '@chatyy_recent_stickers', st_fav: '@chatyy_fav_stickers', st_mine_urls: '@chatyy_my_stickers', st_recent_lottie: '@chatyy_recent_stickers_lottie' };
let _migrated = new Set();
/**
 * Uma vez por conta: as chaves antigas (AsyncStorage/localStorage SEM conta,
 * compartilhadas entre contas) viram metadados desta conta e são apagadas.
 */
export async function migrateLegacyStickerLists() {
  const acct = _acctId();
  if (!acct || _migrated.has(acct)) return;
  _migrated.add(acct);
  const doneKey = 'legacy_done';
  if (getStickerMeta(doneKey)) return;
  const read = async (k) => {
    try {
      if (isWeb) { const v = typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null; return v ? JSON.parse(v) : null; }
      const AS = require('@react-native-async-storage/async-storage').default;
      const v = await AS.getItem(k);
      return v ? JSON.parse(v) : null;
    } catch { return null; }
  };
  const drop = async (k) => {
    try {
      if (isWeb) { if (typeof localStorage !== 'undefined') localStorage.removeItem(k); return; }
      const AS = require('@react-native-async-storage/async-storage').default;
      await AS.removeItem(k);
    } catch {}
  };
  for (const [name, legacyKey] of Object.entries(LEGACY)) {
    const v = await read(legacyKey);
    if (Array.isArray(v) && v.length && !getStickerMeta(name)) setStickerMeta(name, v.slice(0, name === 'st_fav' ? 200 : RECENT_MAX));
    await drop(legacyKey);
  }
  setStickerMeta(doneKey, 1);
}
// ── [2026-10-23 figurinhas-organizar] recentes / favoritas / minhas ─────────
// UMA lista de recentes (imagem + Lottie, mais nova primeiro, ≤ RECENT_MAX,
// sem duplicar: /data/… e a URL absoluta do mesmo arquivo = 1 item). Tudo que
// é ENVIADO, CRIADO (StickerMaker / "Fazer figurinha") ou ADICIONADO (salvar
// figurinha recebida / favoritar) entra no topo NA HORA (KV) e vai para o
// servidor numa fila (sticker_recents_sync) → aparece nos outros aparelhos.
// Servidor sem o kit = a fila fica guardada e a lista segue só local.
// Quem desenha (StickerPicker JS / painel nativo) assina subscribeStickerLists.
const _isLottieU = (u) => typeof u === 'string' && /\.json(?:[?#].*)?$/i.test(u);
function _rKey(u) { return _keyOf(u) || String(u || ''); }
const _listSubs = new Set();
function _listsChanged(name) {
  for (const cb of Array.from(_listSubs)) { try { cb(name); } catch {} }
}
/** cb(nome) quando recentes/favoritas/minhas mudam (nesta sessão). Retorna unsubscribe. */
export function subscribeStickerLists(cb) {
  if (typeof cb !== 'function') return () => {};
  _listSubs.add(cb);
  return () => { _listSubs.delete(cb); };
}
function _dedupeUrls(list) {
  const seen = new Set();
  const out = [];
  for (const u of list) {
    if (typeof u !== 'string' || !u) continue;
    const k = _rKey(u);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}
// recentes Lottie antigos (lista à parte do painel nativo) → entram na lista única.
function _recentAll() {
  const base = _arr(getStickerMeta('st_recent')).filter((u) => typeof u === 'string' && u);
  const lot = _arr(getStickerMeta('st_recent_lottie')).filter((r) => r && typeof r.u === 'string');
  if (!lot.length) return base;
  const ts = Object.assign({}, getStickerMeta('st_recent_ts') || {});
  const now = Date.now();
  base.forEach((u, i) => { if (!ts[u]) ts[u] = now - 60000 * (i + 1); });
  lot.forEach((r) => { ts[r.u] = Math.min(Number(r.ts) || now, now); });
  const next = _dedupeUrls([...lot.map((r) => r.u), ...base]).sort((a, b) => (ts[b] || 0) - (ts[a] || 0)).slice(0, RECENT_MAX);
  setStickerMeta('st_recent', next);
  setStickerMeta('st_recent_ts', ts);
  setStickerMeta('st_recent_lottie', null);
  return next;
}
function _pruneTs(ts, list) {
  const out = {};
  for (const u of list) if (ts[u]) out[u] = ts[u];
  return out;
}
export function getStickerRecents() { return _recentAll(); }
/** Topo dos recentes na hora. opts: { at, lottie, sync:false (não manda ao servidor) }. */
export function pushStickerRecent(item, opts) {
  if (!item || typeof item !== 'string') return getStickerRecents();
  const o = opts || {};
  const at = Number(o.at) || Date.now();
  const k = _rKey(item);
  const next = [item, ..._recentAll().filter((r) => r !== item && _rKey(r) !== k)].slice(0, RECENT_MAX);
  const ts = Object.assign({}, getStickerMeta('st_recent_ts') || {});
  ts[item] = at;
  setStickerMeta('st_recent', next);
  setStickerMeta('st_recent_ts', _pruneTs(ts, next));
  if (/^(https?:|\/data\/)/.test(item) && !_isLottieU(item)) ensureStickerCached(item, { priority: 'high' }).catch(() => {});
  if (o.sync !== false) _queueRecentOp({ op: 'push', url: item, lottie: _isLottieU(item) || !!o.lottie, at });
  _listsChanged('st_recent');
  return next;
}
export function removeStickerRecent(item) {
  if (!item || typeof item !== 'string') return getStickerRecents();
  const k = _rKey(item);
  const cur = _recentAll();
  const gone = cur.filter((r) => r === item || _rKey(r) === k);
  const next = cur.filter((r) => r !== item && _rKey(r) !== k);
  setStickerMeta('st_recent', next);
  setStickerMeta('st_recent_ts', _pruneTs(getStickerMeta('st_recent_ts') || {}, next));
  for (const u of (gone.length ? gone : [item])) _queueRecentOp({ op: 'remove', url: u, at: Date.now() });
  _listsChanged('st_recent');
  return next;
}

// fila → servidor (agrupa 1,2 s; a última operação por URL vale)
const RECENT_OPS_MAX = 60;
let _rFlushT = null;
let _rInflight = null;
function _queueRecentOp(op) {
  if (!_acctId() || !op || typeof op.url !== 'string' || !/^(https?:\/\/|\/data\/)/.test(op.url)) return; // emoji-texto: só local
  const ops = _arr(getStickerMeta('st_recent_ops')).filter((x) => x && x.url !== op.url);
  ops.push(op);
  setStickerMeta('st_recent_ops', ops.slice(-RECENT_OPS_MAX));
  if (_rFlushT) clearTimeout(_rFlushT);
  _rFlushT = setTimeout(() => { _rFlushT = null; syncStickerRecents().catch(() => {}); }, 1200);
}
const _opId = (o) => (o && (o.op + '|' + o.url + '|' + (o.at || 0))) || '';
/** Manda a fila e traz a lista da conta (outros aparelhos). true = servidor respondeu. */
export function syncStickerRecents() {
  if (_rInflight) return _rInflight;
  const api = _api();
  const acct = _acctId();
  if (!api || !api.apiCall || !acct) return Promise.resolve(false);
  try { if (globalThis.__chatyy_sticker_recents_sync === false) return Promise.resolve(false); } catch {}
  let ops = _arr(getStickerMeta('st_recent_ops'));
  // 1ª vez nesta conta: o histórico local (de antes da sincronia) sobe junto.
  const seeded = !!getStickerMeta('recent_seeded');
  if (!seeded) {
    const ts = getStickerMeta('st_recent_ts') || {};
    const now = Date.now();
    const seed = _recentAll().slice().reverse().map((u, i, a) => ({ op: 'push', url: u, lottie: _isLottieU(u), at: Number(ts[u]) || (now - 60000 * (a.length - i)) }));
    const have = new Set(ops.map((o) => o.url));
    ops = [...seed.filter((o) => !have.has(o.url)), ...ops].slice(-RECENT_OPS_MAX);
  }
  _rInflight = (async () => {
    let r = null;
    try { r = await api.apiCall('sticker_recents_sync', { ops }, 'POST'); } catch { return false; }
    if (_acctId() !== acct) return false;
    const items = r && r.success !== false ? (r.items || (r.data && r.data.items)) : null;
    if (!Array.isArray(items)) return false;
    if (r.off || (r.data && r.data.off)) return false;
    if (!seeded) setStickerMeta('recent_seeded', 1);
    const sent = new Set(ops.map(_opId));
    const rest = _arr(getStickerMeta('st_recent_ops')).filter((o) => !sent.has(_opId(o)));
    setStickerMeta('st_recent_ops', rest);
    const ts = {};
    let next = [];
    for (const it of items) {
      const u = it && it.url;
      if (typeof u !== 'string' || !u) continue;
      next.push(u);
      ts[u] = Number(it.at) || 0;
    }
    // o que entrou na fila durante a ida vale por cima do servidor
    for (const o of rest) {
      const k = _rKey(o.url);
      next = next.filter((u) => u !== o.url && _rKey(u) !== k);
      if (o.op === 'push') { next.unshift(o.url); ts[o.url] = o.at || Date.now(); }
    }
    next = _dedupeUrls(next).slice(0, RECENT_MAX);
    const prev = _recentAll();
    if (listSig(prev) !== listSig(next)) {
      setStickerMeta('st_recent', next);
      setStickerMeta('st_recent_ts', _pruneTs(ts, next));
      _listsChanged('st_recent');
      prefetchStickers(next.filter((u) => !_isLottieU(u)), { wifiOnly: false });
    }
    if (rest.length) _queueRecentOp(rest[rest.length - 1]);
    return true;
  })().finally(() => { _rInflight = null; });
  return _rInflight;
}

export function getStickerFavorites() { return _arr(getStickerMeta('st_fav')); }
export function setStickerFavorites(list) {
  const next = _arr(list).slice(0, 200);
  setStickerMeta('st_fav', next);
  prefetchStickers(next.filter((u) => typeof u === 'string'), { wifiOnly: false });
  _listsChanged('st_fav');
  return next;
}
export function isStickerFavorite(url) {
  if (!url) return false;
  const k = _rKey(url);
  return getStickerFavorites().some((u) => u === url || _rKey(u) === k);
}
/**
 * Favoritar / desfavoritar na hora (KV) + servidor (toggle). Favoritar também
 * põe no topo dos recentes. want: true/false força o estado; omitido = inverte.
 */
export function toggleStickerFavorite(url, want) {
  if (!url || typeof url !== 'string') return false;
  const k = _rKey(url);
  const cur = getStickerFavorites();
  const was = cur.some((u) => u === url || _rKey(u) === k);
  const on = want == null ? !was : !!want;
  if (on === was) return on;
  setStickerFavorites(on ? [url, ...cur.filter((u) => _rKey(u) !== k)] : cur.filter((u) => u !== url && _rKey(u) !== k));
  if (on) pushStickerRecent(url);
  try { const a = _api(); if (a && a.chatStickerFavoriteToggle) a.chatStickerFavoriteToggle(url).catch(() => {}); } catch {}
  return on;
}
/** Só o espelho local (o servidor já foi avisado por quem chamou). */
export function setStickerFavoriteLocal(url, on) {
  if (!url || typeof url !== 'string') return;
  const k = _rKey(url);
  const cur = getStickerFavorites().filter((u) => u !== url && _rKey(u) !== k);
  setStickerFavorites(on ? [url, ...cur] : cur);
  if (on) pushStickerRecent(url);
}

/** Minhas figurinhas (linhas completas) — KV. */
export function getMyStickers() { return _arr(getStickerMeta('st_mine')); }
/**
 * Figurinha CRIADA ou SALVA agora (StickerMaker, "Fazer figurinha", salvar a
 * recebida): entra em Minhas e no topo dos Recentes na hora.
 * row: { id, pack_id, url, emoji, emoji_tags, is_animated }.
 */
export function noteStickerAdded(row, opts) {
  const url = row && (row.url || row.image_url);
  if (!url || typeof url !== 'string') return;
  const k = _rKey(url);
  const slim = { id: row.id || null, pack_id: row.pack_id || null, url, emoji: row.emoji || '', emoji_tags: row.emoji_tags || '', is_animated: !!row.is_animated };
  const mine = getMyStickers().filter((x) => x && (slim.id ? x.id !== slim.id : true) && x.url !== url && _rKey(x.url) !== k);
  setStickerMeta('st_mine', [slim, ...mine]);
  const urls = _arr(getStickerMeta('st_mine_urls')).filter((u) => u !== url && _rKey(u) !== k);
  setStickerMeta('st_mine_urls', [url, ...urls].slice(0, 500));
  _listsChanged('st_mine');
  if (!(opts && opts.recent === false)) pushStickerRecent(url);
}
/** Tira das Minhas (depois de excluir no servidor). */
export function noteStickerRemoved(url, id) {
  const k = url ? _rKey(url) : '';
  setStickerMeta('st_mine', getMyStickers().filter((x) => x && !(id && x.id === id) && !(url && (x.url === url || _rKey(x.url) === k))));
  if (url) setStickerMeta('st_mine_urls', _arr(getStickerMeta('st_mine_urls')).filter((u) => u !== url && _rKey(u) !== k));
  _listsChanged('st_mine');
  if (url) {
    if (_recentAll().some((u) => u === url || _rKey(u) === k)) removeStickerRecent(url);
    if (isStickerFavorite(url)) setStickerFavorites(getStickerFavorites().filter((u) => u !== url && _rKey(u) !== k));
  }
}
/** Emojis de busca de uma figurinha MINHA (local na hora + servidor). */
export async function setMyStickerTags(id, tags) {
  const list = _arr(tags).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3);
  const joined = list.join(',');
  setStickerMeta('st_mine', getMyStickers().map((x) => (x && x.id === id ? { ...x, emoji: list[0] || '', emoji_tags: joined } : x)));
  _listsChanged('st_mine');
  try {
    const a = _api();
    const r = a && a.apiCall ? await a.apiCall('sticker_tags_set', { sticker_id: id, emoji_tags: joined, emoji: list[0] || '' }, 'POST') : null;
    return !!(r && r.success !== false && (r.id || (r.data && r.data.id)));
  } catch { return false; }
}

/** E-mail da conta ativa (minúsculo) — separar "meus" pacotes. */
export function stickerAccountEmail() { return _acctEmail(); }
/**
 * Pacotes instalados em grupos, na ordem do usuário (sticker_pack_my):
 *   added  = adicionados (loja / link / importados por mim)
 *   chatyy = oficiais do Chatyy (vão por último, como no WhatsApp)
 * O pacote padrão "My Stickers" (meu, pessoal) sai: já é a seção Minhas.
 */
export function groupStickerPacks(packs) {
  const me = _acctEmail();
  const added = [];
  const chatyy = [];
  const truthy = (v) => v === true || v === 't' || v === 1 || v === '1' || v === 'true';
  for (const p of _arr(packs)) {
    if (!p || (p.id ?? p.pack_id) == null) continue;
    const mine = !!me && String(p.author_email || '').toLowerCase() === me;
    if (mine && truthy(p.is_personal) && (p.name === 'My Stickers' || p.name === 'Minhas figurinhas')) continue;
    if (!mine && (truthy(p.is_official) || truthy(p.is_default))) chatyy.push(p);
    else added.push(p);
  }
  return { added, chatyy };
}
/** Depois de reordenar / remover pacotes nas configurações: o painel já abre na ordem nova. */
export function setInstalledPacksOrder(packs) {
  const prev = _arr(getStickerMeta('mkt_packs'));
  const byId = new Map(prev.map((p) => [String(p && (p.id ?? p.pack_id)), p]));
  const next = [];
  for (const p of _arr(packs)) {
    const id = String(p && (p.id ?? p.pack_id));
    next.push(byId.get(id) || p);
  }
  setStickerMeta('mkt_packs', next);
  _listsChanged('mkt_packs');
}

// ── busca local (emoji / palavra) ───────────────────────────────────────────
const _stripVS = (s) => String(s || '').replace(/[︎️]/g, '');
function _tokens(row) {
  const raw = [row && row.emoji, ...String((row && row.emoji_tags) || '').split(/[,\s]+/)];
  return raw.map((x) => _stripVS(x).trim().toLowerCase()).filter(Boolean);
}
/**
 * Busca nas minhas figurinhas e nos pacotes instalados (KV, instantânea e
 * offline). q = emoji ("😂") ou palavra ("feliz"). opts.emojis = emojis
 * ligados à palavra (índice do seletor) → acha figurinhas marcadas com eles.
 * Retorna [{ url, score, packId }] (melhor primeiro).
 */
export function searchStickersLocal(q, opts) {
  const query = _stripVS(q).trim().toLowerCase();
  if (!query) return [];
  const isEmojiQ = !/[a-z0-9À-ɏ]/i.test(query);
  const extra = new Set(_arr(opts && opts.emojis).map((e) => _stripVS(e)));
  const hits = new Map();
  const add = (url, score, packId) => {
    if (typeof url !== 'string' || !url) return;
    const k = _rKey(url);
    const h = hits.get(k);
    if (!h || h.score < score) hits.set(k, { url, score, packId: packId ?? (h && h.packId) ?? null });
  };
  const scoreRow = (row) => {
    const toks = _tokens(row);
    let best = 0;
    for (const t of toks) {
      if (isEmojiQ) {
        if (t === query) best = Math.max(best, 5);
        else if (t.includes(query)) best = Math.max(best, 3);
      } else if (query.length >= 2) {
        if (t === query) best = Math.max(best, 5);
        else if (t.startsWith(query)) best = Math.max(best, 4);
        else if (query.length >= 3 && t.includes(query)) best = Math.max(best, 2);
      }
      if (extra.size && extra.has(t)) best = Math.max(best, 3);
    }
    return best;
  };
  for (const s of getMyStickers()) { const sc = scoreRow(s); if (sc) add(s.url, sc + 1, s.pack_id); }
  for (const p of _arr(getStickerMeta('mkt_packs'))) {
    const id = p && (p.id ?? p.pack_id);
    if (id == null) continue;
    const nameHit = !isEmojiQ && query.length >= 2 && String(p.name || '').toLowerCase().includes(query);
    for (const it of _arr(getStickerMeta('pack_' + id))) {
      const u = it && (it.url || it.image_url);
      const sc = scoreRow(it);
      if (sc) add(u, sc, id);
      else if (nameHit) add(u, 1, id);
    }
  }
  return Array.from(hits.values()).sort((a, b) => b.score - a.score).slice(0, 150);
}
/** De qual pacote instalado (ou meu) é esta figurinha? → { packId, mine, row } | null */
export function stickerOrigin(url) {
  if (!url) return null;
  const k = _rKey(url);
  for (const s of getMyStickers()) if (s && (s.url === url || _rKey(s.url) === k)) return { packId: s.pack_id || null, mine: true, row: s };
  for (const p of _arr(getStickerMeta('mkt_packs'))) {
    const id = p && (p.id ?? p.pack_id);
    if (id == null) continue;
    for (const it of _arr(getStickerMeta('pack_' + id))) {
      const u = it && (it.url || it.image_url);
      if (u && (u === url || _rKey(u) === k)) return { packId: id, mine: false, row: it, pack: p };
    }
  }
  return null;
}

// GIF: objeto enxuto (sem o original gigante na lista de mídia a guardar).
function _gifSlim(g) {
  if (!g || typeof g !== 'object') return null;
  const o = {
    id: String(g.id || ''), preview: g.preview || '', medium: g.medium || '', tiny: g.tiny || '', url: g.url || '',
    width: Number(g.width) || undefined, height: Number(g.height) || undefined, size: Number(g.size) || undefined,
  };
  if (!o.preview && !o.medium && !o.url) return null;
  return o;
}
function _gifId(g) { return String((g && (g.id || g.medium || g.preview || g.url)) || ''); }
export function getGifRecents() { return _arr(getStickerMeta('gif_recent')); }
export function getGifFavorites() { return _arr(getStickerMeta('gif_fav')); }
export function isGifFavorite(g) { const id = _gifId(g); return !!id && getGifFavorites().some((x) => _gifId(x) === id); }
/** GIF enviado → topo dos recentes + prévia e o arquivo enviado (medium) no disco. */
export function pushGifRecent(g) {
  const s = _gifSlim(g);
  if (!s) return getGifRecents();
  const id = _gifId(s);
  const next = [s, ...getGifRecents().filter((x) => _gifId(x) !== id)].slice(0, GIF_RECENT_MAX);
  setStickerMeta('gif_recent', next);
  _cacheGifMedia(s, 'high');
  return next;
}
export function toggleGifFavorite(g) {
  const s = _gifSlim(g);
  if (!s) return false;
  const id = _gifId(s);
  const cur = getGifFavorites();
  const on = cur.some((x) => _gifId(x) === id);
  const next = on ? cur.filter((x) => _gifId(x) !== id) : [s, ...cur].slice(0, GIF_FAV_MAX);
  setStickerMeta('gif_fav', next);
  if (!on) _cacheGifMedia(s, 'normal');
  return !on;
}
function _cacheGifMedia(s, priority) {
  if (!stickerCacheOn() || !s) return;
  if (s.preview) ensureStickerCached(s.preview, { priority, kind: 'gif' }).catch(() => {});
  // medium = o que a conversa mostra (handleSendGif envia medium||tiny||url).
  const sent = s.medium || s.tiny;
  if (sent && sent !== s.preview) ensureStickerCached(sent, { priority, kind: 'gif' }).catch(() => {});
}
/** Lista "Recentes + Favoritos" p/ o topo do seletor (favoritos primeiro, sem repetir). */
export function getGifPinnedList() {
  const out = [];
  const seen = new Set();
  for (const g of [...getGifFavorites(), ...getGifRecents()]) {
    const id = _gifId(g);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(g);
  }
  return out;
}

// JSON das buscas de GIF (tendências = ''), TTL; devolve também o vencido
// (stale-while-revalidate: mostra na hora e atualiza em 2º plano).
export function getGifQueryCache(q) {
  const all = getStickerMeta('gif_q') || {};
  const k = String(q || '').trim().toLowerCase() || '__trending__';
  const v = all && all[k];
  if (!v || !Array.isArray(v.g)) return null;
  const ttl = k === '__trending__' ? GIF_Q_TTL_MS : GIF_SEARCH_TTL_MS;
  return { gifs: v.g, fresh: Date.now() - (Number(v.ts) || 0) < ttl };
}
export function setGifQueryCache(q, gifs) {
  const k = String(q || '').trim().toLowerCase() || '__trending__';
  const all = Object.assign({}, getStickerMeta('gif_q') || {});
  all[k] = { ts: Date.now(), g: _arr(gifs).slice(0, 50).map(_gifSlim).filter(Boolean) };
  const keys = Object.keys(all);
  if (keys.length > GIF_Q_MAX) {
    keys.filter((x) => x !== '__trending__').sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0))
      .slice(0, keys.length - GIF_Q_MAX).forEach((x) => { delete all[x]; });
  }
  setStickerMeta('gif_q', all);
}
/** Prévia de GIF da grade p/ o disco (tendências no Wi-Fi; visíveis sempre). */
export function prefetchGifPreviews(gifs, opts) {
  const urls = _arr(gifs).map((g) => g && g.preview).filter(Boolean);
  prefetchStickers(urls, { wifiOnly: !!(opts && opts.wifiOnly), kind: 'gif' });
}

// ── biblioteca (servidor → KV → disco), com diff ───────────────────────────
function _items(r) { const v = r && (r.items || (r.data && r.data.items) || r.stickers); return Array.isArray(v) ? v : null; }
let _libInflight = null;
let _libAt = 0;
/**
 * Revalida favoritas, minhas, meus pacotes e pacotes instalados (+ itens dos
 * pacotes vencidos). onChange(nome) só é chamado p/ o que mudou. Pré-busca os
 * arquivos (opts.wifiOnly decide se a pré-busca exige Wi-Fi).
 */
export function syncStickerLibrary(opts) {
  const o = opts || {};
  if (_libInflight) return _libInflight.then(() => { if (o.onChange) o.onChange('*'); });
  const api = _api();
  if (!api || !_acctId()) return Promise.resolve();
  _libInflight = (async () => {
    // [2026-10-23 figurinhas-organizar] recentes da conta (outros aparelhos) + fila local
    syncStickerRecents().catch(() => {});
    const changed = (name, next, sigOf) => {
      const prev = getStickerMeta(name);
      const a = (sigOf || listSig)(prev);
      const b = (sigOf || listSig)(next);
      if (prev && a === b) return false;
      setStickerMeta(name, next);
      try { o.onChange && o.onChange(name); } catch {}
      return true;
    };
    const urls = [];
    try {
      const r = await api.chatStickerFavoritesList();
      const rows = _items(r);
      if (rows) {
        const server = rows.map((x) => x && (x.sticker_url || x.url)).filter(Boolean);
        // servidor é a fonte; preserva favorita local ainda não sincronizada (topo).
        const local = getStickerFavorites();
        const seen = new Set();
        const merged = [];
        for (const u of [...server, ...local]) { if (!seen.has(u)) { seen.add(u); merged.push(u); } }
        changed('st_fav', merged.slice(0, 200));
      }
    } catch {}
    try {
      const r = await api.chatStickerMyStickers();
      const rows = r && r.success ? _items(r) : null;
      if (rows) changed('st_mine', rows.map((s) => ({ id: s.id, pack_id: s.pack_id, url: s.url, emoji: s.emoji || '', emoji_tags: s.emoji_tags || '', is_animated: !!s.is_animated })));
    } catch {}
    try {
      const r = await api.chatStickerMyPacks();
      const rows = r && r.success ? _items(r) : null;
      if (rows) changed('my_packs', rows, (l) => listSig(_arr(l).map((p) => String(p && p.id) + ':' + (p && p.sticker_count) + ':' + (p && p.name) + ':' + (p && p.cover_url))));
    } catch {}
    let packs = null;
    try {
      const r = await api.stickerPackMy();
      packs = r && r.success ? _items(r) : null;
      if (packs) changed('mkt_packs', packs, (l) => listSig(_arr(l).map((p) => String(p && p.id) + ':' + (p && p.name) + ':' + (p && p.cover_url) + ':' + (p && p.sort_order))));
    } catch {}
    // itens dos pacotes instalados (vencidos > 10 min ou nunca baixados)
    const at = getStickerMeta('pack_at') || {};
    const ids = _arr(packs || getStickerMeta('mkt_packs')).map((p) => p && (p.id ?? p.pack_id)).filter((x) => x != null);
    for (const id of ids) {
      if (!o.force && getStickerMeta('pack_' + id) && Date.now() - (Number(at[id]) || 0) < PACK_ITEMS_TTL_MS) continue;
      await revalidatePackItems(id, o.onChange ? () => o.onChange('pack_' + id) : null);
    }
    // pacotes desinstalados: tira os itens do KV (os arquivos saem pelo LRU).
    try {
      if (packs) {
        const keep = new Set(ids.map(String));
        for (const k of Object.keys(at)) if (!keep.has(String(k))) { setStickerMeta('pack_' + k, null); delete at[k]; }
        setStickerMeta('pack_at', at);
      }
    } catch {}
    // pré-busca dos arquivos
    if (stickerCacheOn()) {
      const okU = (u) => typeof u === 'string' && /^(https?:|\/?data\/)/.test(u);
      // pessoais (recentes, favoritas, minhas): pequenas e do próprio usuário →
      // qualquer rede; pacotes instalados + capas + GIFs: só Wi-Fi (padrão).
      const mineU = [...getStickerRecents(), ...getStickerFavorites()];
      for (const s of _arr(getStickerMeta('st_mine'))) if (s && s.url) mineU.push(s.url);
      prefetchStickers(mineU.filter(okU), { wifiOnly: false });
      for (const id of ids) for (const it of _arr(getStickerMeta('pack_' + id))) { const u = it && (it.url || it.image_url); if (u) urls.push(u); }
      for (const p of _arr(getStickerMeta('mkt_packs'))) if (p && p.cover_url) urls.push(p.cover_url);
      prefetchStickers(urls.filter(okU), { wifiOnly: o.wifiOnly !== false });
      const gl = getGifPinnedList();
      if (gl.length && (o.wifiOnly === false || _onWifi())) gl.slice(0, 60).forEach((g) => _cacheGifMedia(g, 'low'));
    }
    _libAt = Date.now();
  })().finally(() => { _libInflight = null; });
  return _libInflight;
}
export function stickerLibrarySyncedAgoMs() { return _libAt ? Date.now() - _libAt : Infinity; }

/** Itens de um pacote: KV na hora, servidor em 2º plano (onChange se mudou). */
export async function revalidatePackItems(id, onChange) {
  const api = _api();
  if (!api || id == null) return null;
  try {
    const r = await api.chatStickerPackStickers(id);
    const rows = _items(r);
    if (!rows) return null;
    const slim = rows.map((it) => ({ id: it.id, url: it.url || it.image_url || it.sticker_id || '', emoji: it.emoji || '', emoji_tags: it.emoji_tags || '', is_animated: !!it.is_animated }));
    const prev = getStickerMeta('pack_' + id);
    const at = Object.assign({}, getStickerMeta('pack_at') || {});
    at[id] = Date.now();
    setStickerMeta('pack_at', at);
    if (!prev || listSig(prev) !== listSig(slim)) {
      setStickerMeta('pack_' + id, slim);
      try { onChange && onChange(); } catch {}
    }
    return slim;
  } catch { return null; }
}
export function packItemsFresh(id) {
  const at = getStickerMeta('pack_at') || {};
  return !!getStickerMeta('pack_' + id) && Date.now() - (Number(at[id]) || 0) < PACK_ITEMS_TTL_MS;
}

/** Depois do boot (bootIdle), no Wi-Fi, no máx. a cada 6 h por conta. */
export function scheduleStickerPrefetch(email) {
  if (!stickerCacheOn()) return;
  const run = () => {
    try {
      const acct = _acctId();
      if (!acct || (email && acct !== _acctId(email))) return;
      if (!_onWifi()) return;
      const last = Number(getStickerMeta('prefetch_at')) || 0;
      if (Date.now() - last < PREFETCH_EVERY_MS) return;
      setStickerMeta('prefetch_at', Date.now());
      migrateLegacyStickerLists().catch(() => {}).then(() => syncStickerLibrary({ wifiOnly: true })).catch(() => {});
    } catch {}
  };
  try { require('./bootIdle').runWhenBootIdle(run, { minMs: 30000, key: 'sticker_prefetch' }); }
  catch { setTimeout(run, 30000); }
}

/** Invalida o que a loja mexeu (instalar/remover pacote, criar/apagar figurinha). */
export function invalidateStickerLibrary() {
  const at = getStickerMeta('pack_at');
  if (at) setStickerMeta('pack_at', {});
  _libAt = 0;
  // pacote recém-instalado já fica no disco (Wi-Fi) antes de abrir o seletor.
  setTimeout(() => { syncStickerLibrary({ wifiOnly: true }).catch(() => {}); }, 1500);
}

// ── tamanho / limpar ───────────────────────────────────────────────────────
/** Bytes no disco desta conta (rápido: índice). */
export function getStickerCacheSizeSync() { _loadIdx(); return Math.max(0, _total); }
export async function getStickerCacheSize() {
  const fs = _fs();
  const acct = _loadIdx();
  const dir = _dirFor(acct);
  if (!fs || !dir) return { bytes: 0, files: 0 };
  return { bytes: Math.max(0, _total), files: _idx.size };
}
async function _wipeAcct(acct, { keepLists } = {}) {
  const fs = _fs();
  const dir = _dirFor(acct);
  if (fs && dir) { try { await fs.deleteAsync(dir, { idempotent: true }); } catch {} }
  try {
    const kv = _kv();
    if (kv) {
      kv.remove(IDX_PREFIX + acct);
      const pfx = META_PREFIX + acct + '_';
      const keepNames = keepLists ? new Set(['st_recent', 'st_recent_ts', 'st_recent_ops', 'recent_seeded', 'st_fav', 'gif_recent', 'gif_fav', 'legacy_done']) : new Set();
      for (const k of kv.getAllKeys()) {
        if (!k.startsWith(pfx)) continue;
        if (keepNames.has(k.slice(pfx.length))) continue;
        kv.remove(k);
      }
    }
  } catch {}
  if (_idxAcct === acct) { _idx = new Map(); _total = 0; _pins = null; _pinsDirty = true; }
  _queue.splice(0).forEach((j) => { try { j.resolve(null); } catch {} });
  _failAt.clear();
  _lottieMem.clear();
  _notify();
}
/**
 * "Limpar cache de figurinhas e GIFs" (Configurações › Armazenamento): apaga
 * os arquivos e os metadados em cache da conta ativa. Recentes e favoritas
 * (escolhas do usuário) ficam — as imagens voltam a baixar quando aparecerem.
 */
export async function clearStickerCache() {
  const acct = _acctId();
  if (!acct) return;
  await _wipeAcct(acct, { keepLists: true });
}
/** Logout / remover conta: tudo da conta (arquivos + listas). */
export async function purgeStickerCacheForAccount(email) {
  const acct = _acctId(email);
  if (!acct) return;
  await _wipeAcct(acct, { keepLists: false });
  _verified.delete(acct);
  _migrated.delete(acct);
}
/** Wipe total (logout com limpeza geral): todas as contas. */
export async function purgeAllStickerCaches() {
  const fs = _fs();
  if (fs && fs.documentDirectory) { try { await fs.deleteAsync(fs.documentDirectory + DIR + '/', { idempotent: true }); } catch {} }
  try {
    const kv = _kv();
    if (kv) for (const k of kv.getAllKeys()) if (k.startsWith(IDX_PREFIX) || k.startsWith(META_PREFIX)) kv.remove(k);
  } catch {}
  _idx = new Map(); _total = 0; _idxAcct = null; _pins = null; _pinsDirty = true;
  _queue.splice(0).forEach((j) => { try { j.resolve(null); } catch {} }); _failAt.clear(); _lottieMem.clear(); _verified = new Set(); _migrated = new Set();
  _notify();
}
