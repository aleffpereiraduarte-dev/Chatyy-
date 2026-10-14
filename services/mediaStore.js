// [2026-10-08 media-local-store] Armazenamento LOCAL e PERMANENTE de mídia do
// chat, estilo WhatsApp ("para de deletar as fotos, salva no celular").
//
// Por quê: o cacheMedia gravava a maior parte das mídias no cacheDirectory, que o
// iOS purga quando quer + o LRU do app apagava por cima. Quando o arquivo some do
// aparelho e o servidor/edge falha (ex.: edge BR devolvendo o SPA p/ /data/*), a
// foto vira "Arquivo indisponível". Agora toda mídia de conversa baixada (auto-
// download ou ao abrir) e toda mídia ENVIADA (original local) fica em:
//
//   documentDirectory/media/<conta>/<conversa>/<messageId>.<ext>
//
// (<conta> = hash curto do e-mail ativo — isola contas no mesmo aparelho; sem
// conversa conhecida → pasta "_"; sem messageId → "u_<hash-da-url>.<ext>").
// documentDirectory NÃO é purgado pelo SO e o LRU (evictIfNeeded) nunca toca
// aqui — só o usuário apaga (Ajustes → Armazenamento → "Limpar mídia").
//
// Índice: POR CONTA (nunca global — vide bug de vazamento entre contas
// fluidez_wave_and_crossaccount_cache_leak_2026_10_05), em MMKV, uma chave por
// conversa (cada valor pequeno, sem o teto de 1.5MB do Android):
//   media_store_v1_<conta>_convs      → ["<conv>", ...]
//   media_store_v1_<conta>_c_<conv>   → { "<entryKey>": entry }
//   entry = { r: caminho relativo a media/, u: urlKey, m: messageId|null,
//             s: bytes, t: ts, o: 1 se enviada por mim }
// Caminhos guardados RELATIVOS → sobrevivem à troca do UUID do sandbox iOS.
//
// Este módulo é puro (só índice + caminhos + I/O de diretório); o download e o
// syncIndex continuam no mediaCache, que chama planPath()/record() aqui.

let _deps = null; // injeção p/ testes: { fs, mmkv, getAccount, platform }

function _platform() {
  if (_deps && _deps.platform) return _deps.platform;
  try { return require('react-native').Platform.OS; } catch { return 'web'; }
}
let _fsMod; // memo (hot path: getLocalUriSyncJs em todo render de bolha)
function _fs() {
  if (_deps && 'fs' in _deps) return _deps.fs;
  if (_fsMod !== undefined) return _fsMod;
  if (_platform() === 'web') { _fsMod = null; return null; }
  try { _fsMod = require('expo-file-system/legacy'); return _fsMod; } catch {}
  try { _fsMod = require('expo-file-system'); return _fsMod; } catch {}
  _fsMod = null;
  return null;
}
function _mmkv() {
  if (_deps && _deps.mmkv) return _deps.mmkv;
  try { return require('./mmkv'); } catch { return null; }
}
function _currentAccountEmail() {
  if (_deps && typeof _deps.getAccount === 'function') {
    try { return String(_deps.getAccount() || '').trim().toLowerCase(); } catch { return ''; }
  }
  try {
    const api = require('./api');
    const e = (api.getActiveAccountEmail && api.getActiveAccountEmail())
      || (api.getSavedEmail && api.getSavedEmail()) || '';
    if (e) return String(e).trim().toLowerCase();
  } catch {}
  try {
    const sc = require('./smartChatCache');
    const a = sc.getActiveAccount && sc.getActiveAccount();
    if (a) return String(a).trim().toLowerCase();
  } catch {}
  return '';
}

export function __setDepsForTest(d) { _deps = d || null; _reset(); }

const IDX_PREFIX = 'media_store_v1_';
const ROOT = 'media/';

// FNV-1a 64-bit-ish (dois lanes 32) → 16 hex. Só p/ não pôr o e-mail no caminho.
function _slugFor(email) {
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < email.length; i++) {
    const c = email.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b); h2 ^= h2 >>> 13;
  }
  h1 ^= h1 >>> 15; h2 ^= h2 >>> 16;
  return 'a' + (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
function _safeSeg(v) {
  const s = String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return s || '_';
}

// ── estado (só da conta ATIVA) ────────────────────────────────────────────
let _acct = '';          // e-mail lower
let _slug = '';
let _convs = new Map();  // conv(seg) → Map(entryKey → entry)
let _byUrl = new Map();  // urlKey → { c, k }
let _byMsg = new Map();  // String(messageId) → { c, k }
let _dirty = new Set();
let _persistTimer = null;
let _readyHooked = false;
const _listeners = new Set(); // (evt: { type:'account', slug, prevSlug }) => void

function _reset() {
  _acct = ''; _slug = '';
  _convs = new Map(); _byUrl = new Map(); _byMsg = new Map();
  _dirty = new Set();
  if (_persistTimer) { try { clearTimeout(_persistTimer); } catch {} }
  _persistTimer = null; _readyHooked = false;
}

export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function _keyConvs(slug) { return IDX_PREFIX + slug + '_convs'; }
function _keyConv(slug, c) { return IDX_PREFIX + slug + '_c_' + c; }

function _indexEntry(c, k, e) {
  if (e.u) _byUrl.set(e.u, { c, k });
  if (e.m != null && e.m !== '') _byMsg.set(String(e.m), { c, k });
}

function _loadAccountIndex() {
  const mm = _mmkv();
  if (!mm || !_slug) return;
  let list = [];
  try { list = JSON.parse(mm.getString?.(_keyConvs(_slug)) || '[]') || []; } catch { list = []; }
  for (const c of list) {
    if (typeof c !== 'string') continue;
    let obj = null;
    try { obj = JSON.parse(mm.getString?.(_keyConv(_slug, c)) || 'null'); } catch { obj = null; }
    if (!obj || typeof obj !== 'object') continue;
    let m = _convs.get(c);
    if (!m) { m = new Map(); _convs.set(c, m); }
    for (const [k, e] of Object.entries(obj)) {
      if (!e || typeof e !== 'object' || typeof e.r !== 'string') continue;
      // Caminho TEM que estar dentro da pasta da conta ativa (defesa contra
      // índice adulterado/legado apontando p/ outra conta).
      if (!e.r.startsWith(_slug + '/')) continue;
      if (!m.has(k)) { m.set(k, e); _indexEntry(c, k, e); }
    }
  }
}

// Garante que o estado em memória é da conta ATIVA. Barato quando nada mudou.
// Retorna o slug ou '' (sem conta / web).
const LAST_SLUG_KEY = IDX_PREFIX + 'last_slug';
export function ensureAccount() {
  if (_platform() === 'web') return '';
  const email = _currentAccountEmail();
  let slug;
  if (email) {
    if (email === _acct && _slug) return _slug;
    slug = _slugFor(email);
  } else {
    // Cold boot antes do SecureStore/credenciais responderem: usa a ÚLTIMA
    // conta ativa (só hash) p/ o 1º paint offline achar os arquivos. Assim
    // que o e-mail real chega, troca (se for outra conta) e re-semeia.
    let last = null;
    try { last = _mmkv()?.getString?.(LAST_SLUG_KEY) || null; } catch {}
    if (!last || typeof last !== 'string') return '';
    slug = last;
  }
  if (slug === _slug) {
    if (email && _acct !== email) { _acct = email; try { _mmkv()?.setString?.(LAST_SLUG_KEY, slug); } catch {} }
    return _slug;
  }
  const prevSlug = _slug;
  // Troca de conta: flush do que estava sujo da conta anterior ANTES de trocar.
  if (_slug && _dirty.size) { try { _flushNow(); } catch {} }
  _convs = new Map(); _byUrl = new Map(); _byMsg = new Map(); _dirty = new Set();
  _acct = email || ''; _slug = slug;
  if (email) { try { _mmkv()?.setString?.(LAST_SLUG_KEY, slug); } catch {} }
  _loadAccountIndex();
  // O MMKV do app hidrata assíncrono no splash: se ainda não estava pronto,
  // recarrega (merge) quando ficar.
  const mm = _mmkv();
  if (mm && typeof mm.isCacheReady === 'function' && !mm.isCacheReady() && typeof mm.waitForCacheReady === 'function' && !_readyHooked) {
    _readyHooked = true;
    const slugAtHook = _slug;
    mm.waitForCacheReady().then(() => {
      _readyHooked = false;
      if (_slug === slugAtHook) { _loadAccountIndex(); _emit({ type: 'reload', slug: _slug, prevSlug: _slug }); }
    }).catch(() => { _readyHooked = false; });
  }
  _emit({ type: 'account', slug: _slug, prevSlug });
  return _slug;
}

function _emit(evt) { for (const fn of Array.from(_listeners)) { try { fn(evt); } catch {} } }

export function isEnabled() { return !!ensureAccount() && !!_fs(); }

export function rootDir() {
  const fs = _fs();
  if (!fs || !fs.documentDirectory) return null;
  return fs.documentDirectory + ROOT;
}
export function accountDir() {
  const r = rootDir();
  const slug = ensureAccount();
  return (r && slug) ? r + slug + '/' : null;
}
function _abs(rel) { const r = rootDir(); return r ? r + rel : null; }

// True se `path` é um arquivo do store de OUTRA conta (não deve ser servido
// à conta ativa). Arquivos fora de media/ → false (não é deste módulo).
export function isForeignPath(path) {
  if (!path || typeof path !== 'string') return false;
  const r = rootDir();
  if (!r || !path.startsWith(r)) return false;
  const slug = ensureAccount();
  if (!slug) return true;
  return !path.startsWith(r + slug + '/');
}
export function isStorePath(path) {
  const r = rootDir();
  return !!(r && typeof path === 'string' && path.startsWith(r));
}

// Decide o caminho de destino. Retorna { abs, rel, dir, convSeg, entryKey } ou null.
//   urlKey: chave do mediaCache (hash.ext)  ext: extensão sem ponto
export function planPath({ urlKey, conversationId, messageId, ext: extHint } = {}) {
  if (!urlKey) return null;
  const slug = ensureAccount();
  const r = rootDir();
  if (!slug || !r) return null;
  // Já existe entrada p/ esta URL → reaproveita (idempotente / sem duplicar).
  const hit = _byUrl.get(urlKey);
  if (hit) {
    const e = _convs.get(hit.c)?.get(hit.k);
    if (e) {
      const dirRel = e.r.slice(0, e.r.lastIndexOf('/') + 1);
      return { abs: r + e.r, rel: e.r, dir: r + dirRel, convSeg: hit.c, entryKey: hit.k, existing: true };
    }
  }
  const convSeg = conversationId != null && conversationId !== '' ? _safeSeg(conversationId) : '_';
  const dot = urlKey.lastIndexOf('.');
  let ext = dot > 0 ? urlKey.slice(dot + 1) : 'bin';
  // [2026-10-14 offline-media] URL sem extensão (ex.: wa_import_file&m=ID) → a
  // chave termina em .bin; o ARQUIVO no disco ganha a extensão real (iOS
  // AVPlayer/QuickLook decidem o formato pela extensão — .bin não abre).
  if (ext === 'bin' && typeof extHint === 'string' && /^[a-z0-9]{2,5}$/i.test(extHint)) ext = extHint.toLowerCase();
  let fileName;
  let entryKey;
  if (messageId != null && messageId !== '' && !String(messageId).startsWith('temp')) {
    const mid = _safeSeg(messageId);
    const prev = _byMsg.get(String(messageId));
    const prevE = prev ? _convs.get(prev.c)?.get(prev.k) : null;
    // Mesma mensagem já tem OUTRO arquivo (ex.: URL nova pós-"Baixar de novo",
    // ou miniatura) → sufixo p/ nunca sobrescrever o original.
    if (prevE && prevE.u !== urlKey) {
      fileName = mid + '_' + urlKey.slice(0, 8) + '.' + ext;
      entryKey = 'm' + mid + '_' + urlKey.slice(0, 8);
    } else {
      fileName = mid + '.' + ext;
      entryKey = 'm' + mid;
    }
  } else {
    fileName = 'u_' + (ext !== 'bin' && urlKey.endsWith('.bin') ? urlKey.slice(0, -3) + ext : urlKey);
    entryKey = 'u' + urlKey;
  }
  const dirRel = slug + '/' + convSeg + '/';
  return { abs: r + dirRel + fileName, rel: dirRel + fileName, dir: r + dirRel, convSeg, entryKey, existing: false };
}

// Registra um arquivo já gravado em plan.abs.
export function record(plan, { urlKey, messageId, size, own } = {}) {
  if (!plan || !plan.rel || !urlKey) return;
  const slug = ensureAccount();
  if (!slug || !plan.rel.startsWith(slug + '/')) return; // conta trocou no meio
  const c = plan.convSeg || '_';
  let m = _convs.get(c);
  if (!m) { m = new Map(); _convs.set(c, m); _dirty.add('__convs'); }
  const prev = m.get(plan.entryKey);
  const e = {
    r: plan.rel,
    u: urlKey,
    m: messageId != null && messageId !== '' ? String(messageId) : (prev ? prev.m : null),
    s: Number(size) > 0 ? Number(size) : (prev ? prev.s : 0),
    t: Date.now(),
    o: own ? 1 : (prev ? prev.o : 0),
  };
  m.set(plan.entryKey, e);
  _indexEntry(c, plan.entryKey, e);
  _dirty.add(c);
  _schedulePersist();
}

// [2026-10-14 offline-media] Arquivo baixado com extensão errada (.bin) →
// devolve o plano com a extensão real (o chamador renomeia ANTES do record).
export function withExt(plan, ext) {
  if (!plan || !plan.abs || typeof ext !== 'string' || !/^[a-z0-9]{2,5}$/i.test(ext)) return plan;
  if (!/\.bin$/i.test(plan.abs)) return plan;
  const e = ext.toLowerCase();
  return { ...plan, abs: plan.abs.replace(/\.bin$/i, '.' + e), rel: plan.rel.replace(/\.bin$/i, '.' + e) };
}

// [2026-10-14 offline-media] Entradas gravadas como ".bin" (antes da correção
// de extensão) e renomeação in-place (o mediaCache detecta o tipo pelos bytes).
export function listBinEntries(max = 500) {
  const out = [];
  if (!ensureAccount()) return out;
  for (const [c, m] of _convs.entries()) {
    for (const [k, e] of m.entries()) {
      if (e && typeof e.r === 'string' && /\.bin$/i.test(e.r)) { out.push({ c, k, abs: _abs(e.r), urlKey: e.u || null }); if (out.length >= max) return out; }
    }
  }
  return out;
}
export function setEntryExt(c, k, ext) {
  const e = _convs.get(c)?.get(k);
  if (!e || !/\.bin$/i.test(e.r) || !/^[a-z0-9]{2,5}$/i.test(String(ext))) return null;
  e.r = e.r.replace(/\.bin$/i, '.' + String(ext).toLowerCase());
  _dirty.add(c);
  _schedulePersist();
  return _abs(e.r);
}

// [2026-10-14 offline-media] "Abriu/tocou agora" → atualiza o t da entrada (LRU).
// Barato: só grava se o t tem mais de 6 h (não martela o MMKV a cada render).
const TOUCH_MIN_MS = 6 * 3600 * 1000;
export function touch(urlKey) {
  if (!urlKey || !ensureAccount()) return;
  const hit = _byUrl.get(urlKey);
  if (!hit) return;
  const e = _convs.get(hit.c)?.get(hit.k);
  if (!e) return;
  const now = Date.now();
  if (now - (Number(e.t) || 0) < TOUCH_MIN_MS) return;
  e.t = now;
  _dirty.add(hit.c);
  _schedulePersist();
}

// [2026-10-14 offline-media] Evicção do store SÓ por limite (LRU pelo t = último
// download/abertura). Nunca apaga o que foi aberto nos últimos `protectMs`
// (padrão 14 dias) nem conversas em `protectConvs` (Manter sempre). Devolve
// { freedBytes, removed: [{ abs, urlKey, m }] } — o mediaCache limpa índices.
export async function evictLRU({ limitBytes, protectMs = 14 * 24 * 3600 * 1000, protectConvs = null } = {}) {
  const res = { freedBytes: 0, removed: [] };
  const lim = Number(limitBytes);
  if (!(lim > 0) || !ensureAccount()) return res;
  const all = [];
  let total = 0;
  for (const [c, m] of _convs.entries()) {
    for (const [k, e] of m.entries()) {
      const sz = Number(e.s) || 0;
      total += sz;
      all.push({ c, k, e, sz });
    }
  }
  if (total <= lim) return res;
  const cutoff = Date.now() - protectMs;
  all.sort((a, b) => (Number(a.e.t) || 0) - (Number(b.e.t) || 0));
  const fs = _fs();
  for (const it of all) {
    if (total - res.freedBytes <= lim) break;
    if ((Number(it.e.t) || 0) >= cutoff) break; // daqui p/ frente tudo é recente
    if (protectConvs && protectConvs.has(String(it.c))) continue;
    const abs = _abs(it.e.r);
    try { if (fs && abs) await fs.deleteAsync(abs, { idempotent: true }); } catch { continue; }
    const m = _convs.get(it.c);
    if (m) m.delete(it.k);
    if (it.e.u) { const bu = _byUrl.get(it.e.u); if (bu && bu.c === it.c && bu.k === it.k) _byUrl.delete(it.e.u); }
    if (it.e.m != null) { const bm = _byMsg.get(String(it.e.m)); if (bm && bm.k === it.k) _byMsg.delete(String(it.e.m)); }
    _dirty.add(it.c);
    res.freedBytes += it.sz;
    res.removed.push({ abs, urlKey: it.e.u || null, m: it.e.m != null ? String(it.e.m) : null });
  }
  if (res.removed.length) { _dirty.add('__convs'); _schedulePersist(); }
  return res;
}

export function lookupByUrlKey(urlKey) {
  if (!urlKey) return null;
  if (!ensureAccount()) return null;
  const hit = _byUrl.get(urlKey);
  if (!hit) return null;
  const e = _convs.get(hit.c)?.get(hit.k);
  return e ? _abs(e.r) : null;
}
export function lookupByMessage(messageId) {
  if (messageId == null || messageId === '') return null;
  if (!ensureAccount()) return null;
  const hit = _byMsg.get(String(messageId));
  if (!hit) return null;
  const e = _convs.get(hit.c)?.get(hit.k);
  return e ? _abs(e.r) : null;
}
export function conversationOfUrlKey(urlKey) {
  const hit = urlKey ? _byUrl.get(urlKey) : null;
  return hit ? hit.c : null;
}

// Remove do índice (arquivo sumiu / foi apagado individualmente).
export function forgetUrlKey(urlKey) {
  if (!urlKey || !ensureAccount()) return;
  const hit = _byUrl.get(urlKey);
  if (!hit) return;
  const m = _convs.get(hit.c);
  const e = m?.get(hit.k);
  if (m) m.delete(hit.k);
  _byUrl.delete(urlKey);
  if (e && e.m != null) {
    const bm = _byMsg.get(String(e.m));
    if (bm && bm.k === hit.k) _byMsg.delete(String(e.m));
  }
  _dirty.add(hit.c);
  _schedulePersist();
}

// [2026-10-13 delete-for-all] Tira do índice TODAS as entradas de uma mensagem
// (original `<mid>.<ext>` + variantes `<mid>_<hash>.<ext>`, ex.: miniatura) e
// devolve [{ abs, urlKey }] p/ o mediaCache apagar os arquivos.
// [2026-10-13 P1-1] keepUrlKeys (Set): entradas cuja URL ainda é usada por
// OUTRA mensagem (encaminhada / figurinha repetida) ficam no índice e no
// disco — só perdem o vínculo com este id.
export function forgetMessage(messageId, keepUrlKeys) {
  const out = [];
  if (messageId == null || messageId === '' || !ensureAccount()) return out;
  const mid = String(messageId);
  const ek = 'm' + _safeSeg(mid);
  for (const [c, m] of _convs.entries()) {
    for (const [k, e] of [...m.entries()]) {
      if (!e) continue;
      const hit = (e.m != null && String(e.m) === mid) || k === ek || k.startsWith(ek + '_');
      if (!hit) continue;
      if (e.u && keepUrlKeys && keepUrlKeys.has(e.u)) {
        if (e.m != null && String(e.m) === mid) { e.m = null; _dirty.add(c); }
        continue;
      }
      out.push({ abs: _abs(e.r), urlKey: e.u || null });
      m.delete(k);
      if (e.u) { const bu = _byUrl.get(e.u); if (bu && bu.c === c && bu.k === k) _byUrl.delete(e.u); }
      _dirty.add(c);
    }
  }
  _byMsg.delete(mid);
  if (out.length || _dirty.size) _schedulePersist();
  return out;
}

// [[urlKey, absPath]] da conta ativa (p/ semear o syncIndex do mediaCache).
export function entriesForSyncIndex() {
  if (!ensureAccount()) return [];
  const out = [];
  for (const m of _convs.values()) {
    for (const e of m.values()) { const a = _abs(e.r); if (a && e.u) out.push([e.u, a]); }
  }
  return out;
}

// [{ conversationId, bytes, count }] ordenado por bytes desc (conta ativa).
export function listConversations() {
  if (!ensureAccount()) return [];
  const out = [];
  for (const [c, m] of _convs.entries()) {
    let bytes = 0; let count = 0;
    for (const e of m.values()) { bytes += Number(e.s) || 0; count++; }
    if (count > 0) out.push({ conversationId: c, bytes, count });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return out;
}

export function getAccountBytes() {
  return listConversations().reduce((a, x) => a + x.bytes, 0);
}

// Apaga a mídia local de UMA conversa (conta ativa). Retorna
// { freedBytes, urlKeys, relNames } p/ o mediaCache limpar syncIndex/local_path.
export async function clearConversation(conversationId) {
  const res = { freedBytes: 0, urlKeys: [], relNames: [] };
  const slug = ensureAccount();
  const r = rootDir();
  if (!slug || !r) return res;
  const c = conversationId != null && conversationId !== '' ? _safeSeg(conversationId) : '_';
  const m = _convs.get(c);
  if (m) {
    for (const [k, e] of m.entries()) {
      res.freedBytes += Number(e.s) || 0;
      if (e.u) { res.urlKeys.push(e.u); _byUrl.delete(e.u); }
      if (e.m != null) { const bm = _byMsg.get(String(e.m)); if (bm && bm.k === k) _byMsg.delete(String(e.m)); }
      const parts = e.r.split('/');
      res.relNames.push(parts.slice(-2).join('/'));
    }
    _convs.delete(c);
  }
  const fs = _fs();
  if (fs) { try { await fs.deleteAsync(r + slug + '/' + c + '/', { idempotent: true }); } catch {} }
  const mm = _mmkv();
  try { mm?.remove?.(_keyConv(slug, c)); } catch {}
  _dirty.delete(c);
  _dirty.add('__convs');
  _schedulePersist();
  return res;
}

// Apaga TODA a mídia local da conta ativa (nunca de outras contas).
export async function clearAccount() {
  const res = { freedBytes: 0, urlKeys: [], relNames: [] };
  const slug = ensureAccount();
  if (!slug) return res;
  for (const c of Array.from(_convs.keys())) {
    const r1 = await clearConversation(c);
    res.freedBytes += r1.freedBytes; res.urlKeys.push(...r1.urlKeys); res.relNames.push(...r1.relNames);
  }
  const fs = _fs(); const r = rootDir();
  if (fs && r) { try { await fs.deleteAsync(r + slug + '/', { idempotent: true }); } catch {} }
  return res;
}

// Tamanho real em disco da pasta da conta ativa, por tipo de extensão.
// Também corrige o `s` de entradas sem tamanho. Nunca entra em outras contas.
export async function scanAccountDisk(bucketForName) {
  const out = { bytes: 0, files: [] };
  const fs = _fs(); const dir = accountDir();
  if (!fs || !dir) return out;
  try {
    const info = await fs.getInfoAsync(dir);
    if (!info.exists) return out;
    const convDirs = await fs.readDirectoryAsync(dir);
    for (const c of convDirs) {
      let names = [];
      try { names = await fs.readDirectoryAsync(dir + c + '/'); } catch { continue; }
      for (const n of names) {
        try {
          const st = await fs.getInfoAsync(dir + c + '/' + n);
          if (!st.exists || st.isDirectory) continue;
          const size = st.size || 0;
          out.bytes += size;
          out.files.push({ conv: c, name: n, size, bucket: bucketForName ? bucketForName(n) : null });
          const m = _convs.get(c);
          if (m) {
            for (const e of m.values()) {
              if (e.r === _slug + '/' + c + '/' + n && !(Number(e.s) > 0) && size > 0) { e.s = size; _dirty.add(c); }
            }
          }
        } catch {}
      }
    }
  } catch {}
  if (_dirty.size) _schedulePersist();
  return out;
}

function _schedulePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => { _persistTimer = null; try { _flushNow(); } catch {} }, 1500);
}
export function flush() { if (_persistTimer) { try { clearTimeout(_persistTimer); } catch {} _persistTimer = null; } _flushNow(); }
function _flushNow() {
  const mm = _mmkv();
  if (!mm || !_slug || !_dirty.size) return;
  const dirty = Array.from(_dirty); _dirty = new Set();
  for (const c of dirty) {
    if (c === '__convs') continue;
    const m = _convs.get(c);
    try {
      if (!m || m.size === 0) mm.remove?.(_keyConv(_slug, c));
      else mm.setString?.(_keyConv(_slug, c), JSON.stringify(Object.fromEntries(m)));
    } catch {}
  }
  try {
    const list = Array.from(_convs.entries()).filter(([, m]) => m && m.size > 0).map(([c]) => c);
    mm.setString?.(_keyConvs(_slug), JSON.stringify(list));
  } catch {}
}

export const __test = { _slugFor, _safeSeg, _reset, state: () => ({ _acct, _slug, convs: _convs, byUrl: _byUrl, byMsg: _byMsg }) };
