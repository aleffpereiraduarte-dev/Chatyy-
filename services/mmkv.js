// Chatyy Storage — AsyncStorage with in-memory sync cache
// Pre-loads during splash so reads are instant.
//
// [2026-10-06 android-storage-ceiling] Three Android failure modes fixed here:
//   1. CursorWindow is 2 MB per row on Android. The old boot did ONE multiGet of
//      every `mmkv_*` key inside a silent `catch {}` → a single oversized value
//      (1500-msg group thread, HTML email) made the WHOLE cache unreadable on
//      every launch (chat list / inbox empty after restart, forever).
//      Now: batches of HYDRATE_BATCH keys; a batch that throws is bisected down
//      to the offending key(s), which are dropped (removeItem) + beaconed
//      (`mmkv_oversized_key_dropped`) and the rest of the cache still loads.
//   2. Writes are capped at MAX_VALUE_BYTES (UTF-8) on Android so a value that
//      can never be read back is never written. `chat_msgs_*` arrays are
//      truncated to the newest messages that fit; anything else keeps its
//      previous on-disk value (memory still gets the new one for this session).
//   3. Boot hydrated EVERYTHING (every conversation's message blob ×2 copies,
//      email bodies) before first paint = 300–800 ms on heavy users. Keys under
//      LAZY_PREFIXES are now NOT loaded at boot: they are only listed, and load
//      on the first getString() (which returns null + kicks an async load, then
//      notifies `onKeysLoaded` listeners) or via `ensureLoaded()`. Everything
//      else (theme, auth/edge, conv list + index, settings, media/avatar index,
//      offline queue, …) is still hydrated before the cache-ready gate, so all
//      existing sync callers keep working unchanged. It is a DENY-list on
//      purpose: an unknown key defaults to eager (safe) rather than lazy.
//
// [2026-10-10 storage-boot]
//   4. LAZY_PREFIXES now apply on iOS too (flag MMKV_LAZY_IOS). Before, iOS
//      multiGet'd + smartChatCache JSON.parse'd EVERY conversation blob at boot
//      (up to 40 MB budget + chatCache's legacy copy). Same lazy contract that
//      Android has run since 10-06 — every lazy-sensitive caller already goes
//      through isKeyPending / ensureLoaded / onKeysLoaded.
//   5. Optional SQLite KV backend (flag KV_SQLITE_ENABLED, default OFF): one
//      `kv(k,v)` table in expo-sqlite (`chatyy_kv.db`) read SYNCHRONOUSLY — boot
//      is a single SELECT (no bridge round-trips) and a lazy key read is a sync
//      point lookup, so getString() of a cold conversation returns data on
//      frame 1 instead of null+kick. 1st launch with the flag: normal
//      AsyncStorage boot + background copy AsyncStorage→SQLite; marker
//      `__kv_migrated_v1` flips the next boot to SQLite. Writes go to BOTH
//      stores (dual-write) for this transition version → turning the flag off
//      is a safe rollback (that boot also wipes the KV table so a later re-enable
//      re-migrates instead of serving stale rows). Every SQLite failure falls
//      back to AsyncStorage.
//   6. [2026-10-16 wave10-B] Canário: KV_SQLITE_ROLLOUT_PCT (10 %) por balde do
//      aparelho, flag remota via bootstrap config (kv_sqlite=false kill,
//      kv_sqlite_pct, kv_sqlite_reset), trava de crash, migração do zero,
//      kill/falha apagam o marcador na hora, telemetria nativeBeacon('kv_store').
import { Platform, AppState } from 'react-native';
import { MMKV_LAZY_IOS, KV_SQLITE_ENABLED, KV_SQLITE_ROLLOUT_PCT, KV_SQLITE_KILL } from '../constants/featureFlags';

const PFX = 'mmkv_';
const HYDRATE_BATCH = 40;
// CursorWindow = 2 MB/row and also holds the key + row overhead. 1.5 MB leaves
// a comfortable margin. Only enforced on Android (iOS stores large values as
// files — no per-row ceiling).
export const MAX_VALUE_BYTES = Math.floor(1.5 * 1024 * 1024);
const ENFORCE_CAP = Platform.OS === 'android';

// Keys loaded on demand instead of at boot. Per-conversation message blobs
// (smartChatCache `chat_msgs_v2_*` + chatCache legacy `chat_msgs_*`) and cached
// email bodies (`omc_msg_<acct>_<id>`, NOT the `omc_msg_index_*` LRU index).
// [2026-10-08 offline-first] + api.js offline last-known bodies (`apiofl1_*`):
// only read on a network failure (async, ensureLoaded) → never on the boot path.
const LAZY_PREFIXES = [PFX + 'chat_msgs_', PFX + 'omc_msg_', PFX + 'apiofl1_'];
const LAZY_EXCEPT_PREFIXES = [PFX + 'omc_msg_index_'];
function _lazyOn() {
  // [2026-10-06] Android (CursorWindow/6 MB). [2026-10-10] iOS também (boot
  // parseava todos os blobs de mensagem) — flag MMKV_LAZY_IOS (false = antigo).
  if (Platform.OS === 'android') return true;
  return Platform.OS === 'ios' && MMKV_LAZY_IOS !== false;
}
export function isLazyKey(fullKey) {
  if (typeof fullKey !== 'string' || !_lazyOn()) return false;
  if (!LAZY_PREFIXES.some(p => fullKey.startsWith(p))) return false;
  return !LAZY_EXCEPT_PREFIXES.some(p => fullKey.startsWith(p));
}
// Same predicate as isLazyKey, as a SQL expression over column `k` (prefixes
// are compile-time constants without quotes → safe to inline).
function _lazySql() {
  if (!_lazyOn()) return '0';
  const inc = LAZY_PREFIXES.map(p => `substr(k,1,${p.length})='${p}'`).join(' OR ');
  const exc = LAZY_EXCEPT_PREFIXES.map(p => `substr(k,1,${p.length})='${p}'`).join(' OR ');
  return `((${inc}) AND NOT (${exc}))`;
}

// ─── SQLite KV backend (canário KV_SQLITE_*) ─────────────────────────────────
// [2026-10-16 wave10-B] Revisão + canário remoto. Contrato:
//   • Decisão por boot (_kvDecide): override global → kill OTA → kill remoto →
//     trava de crash local → KV_SQLITE_ENABLED (100 %) → % remoto (bootstrap
//     config.kv_sqlite_pct) ou KV_SQLITE_ROLLOUT_PCT compilado, por BALDE do
//     aparelho (0..99, sorteado 1× e guardado em kv_meta).
//   • kv_meta (mesmo arquivo) guarda balde / flag remota / trava de crash e é
//     lido de forma SÍNCRONA antes de decidir — a flag remota recebida num boot
//     vale a partir do boot seguinte (ou na hora, se for kill).
//   • A tabela kv é um ESPELHO do AsyncStorage (dual-write). Toda vez que uma
//     sessão roda SEM espelhar (flag off, falha de boot/escrita), o marcador é
//     apagado na hora (síncrono) → o próximo boot com a flag NÃO lê dado velho;
//     ele refaz a migração, que começa APAGANDO todas as linhas mmkv_ (senão uma
//     chave removida no AsyncStorage — ex.: wipe de logout da conta A —
//     ressuscitaria do SQLite para a conta B).
//   • Arquivo corrompido → fecha + apaga o .db (recria/remigra no próximo boot).
//   • Telemetria: nativeBeacon('kv_store', …) — boot (backend/ms/motivo/balde),
//     migração, rollback, erros.
const KV_DB_NAME = 'chatyy_kv.db';
const KV_MIGRATED = '__kv_migrated_v1';      // row inside kv (not mmkv_-prefixed)
const AS_KV_MARKER = 'kvsql_migrated_v1';    // legado (só é limpo)
const KV_DUAL_WRITE = true;                  // keep AsyncStorage current (rollback)
const KV_MIGRATE_DELAY_MS = 8000;            // stay off the cold-start path
const KV_MIGRATE_BATCH = 12;                 // ≤ ~18 MB of strings per batch
const KV_FLUSH_MS = 30;
const KV_CRASH_LIMIT = 3;                    // boots seguidos sem chegar a +30 s
const KV_CRASH_CLEAR_MS = 30000;
const KV_WIPE_DELAY_MS = 3000;
let _db = null;           // expo-sqlite handle (sync API): kv_meta sempre, kv se modo ≠ off
let _kv = null;           // = _db enquanto um modo kv está ativo
let _kvMode = 'off';      // 'off' | 'migrating' (AsyncStorage primary) | 'primary'
let _kvTouched = null;    // keys written/removed while migrating → copy skips them
const _kvDirty = new Map(); // fullKey → string (upsert) | null (delete)
let _kvFlushTimer = null;
let _kvFlushMicro = false;
let _kvDecision = { on: false, why: 'init', bucket: -1, pct: 0, src: 'default' };
let _SQLite = null;

function _errMsg(e) { return String((e && e.message) || e).slice(0, 120); }
function _isCorrupt(e) { return /corrupt|malformed|not a database|SQLITE_NOTADB|file is encrypted|disk image/i.test(_errMsg(e)); }

function _kvOpenRaw() {
  if (!_SQLite) _SQLite = require('expo-sqlite');
  if (!_SQLite || typeof _SQLite.openDatabaseSync !== 'function') return null;
  const db = _SQLite.openDatabaseSync(KV_DB_NAME);
  try { db.execSync('PRAGMA journal_mode = WAL;'); } catch {}
  try { db.execSync('PRAGMA synchronous = NORMAL;'); } catch {}
  try { db.execSync('PRAGMA busy_timeout = 3000;'); } catch {}
  db.execSync('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);');
  db.execSync('CREATE TABLE IF NOT EXISTS kv_meta (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);');
  // sonda: um arquivo corrompido costuma abrir e só falhar na 1ª leitura
  db.getFirstSync('SELECT v FROM kv_meta LIMIT 1');
  return db;
}

// Fecha e apaga o arquivo (corrupção / handle inutilizável). Nunca lança.
function _kvDropFile(db, why) {
  try { db?.closeSync?.(); } catch {}
  let ok = false;
  try { if (_SQLite && typeof _SQLite.deleteDatabaseSync === 'function') { _SQLite.deleteDatabaseSync(KV_DB_NAME); ok = true; } } catch {}
  _kvTele('corrupt_reset', `why=${why} deleted=${ok ? 1 : 0}`);
  return ok;
}

function _kvOpen() {
  try { return _kvOpenRaw(); } catch (e) {
    if (_isCorrupt(e)) {
      _kvDropFile(null, 'open:' + _errMsg(e).slice(0, 60));
      try { return _kvOpenRaw(); } catch (e2) { _kvTele('open_failed', _errMsg(e2)); return null; }
    }
    _kvTele('open_failed', _errMsg(e));
    return null;
  }
}

function _metaGet(k) {
  try { const r = _db?.getFirstSync('SELECT v FROM kv_meta WHERE k = ?', [k]); return r && typeof r.v === 'string' ? r.v : null; } catch { return null; }
}
function _metaSet(k, v) {
  try {
    if (!_db) return;
    if (v === null || v === undefined) _db.runSync('DELETE FROM kv_meta WHERE k = ?', [k]);
    else _db.runSync('INSERT OR REPLACE INTO kv_meta (k, v) VALUES (?, ?)', [k, String(v)]);
  } catch {}
}

// Decisão pura (exportada p/ teste). meta = { bucket, remote_kill, remote_pct, local_off }.
export function _kvDecide(meta, opts) {
  const o = opts || {};
  const flags = o.flags || { KV_SQLITE_ENABLED, KV_SQLITE_ROLLOUT_PCT, KV_SQLITE_KILL };
  const m = meta || {};
  const bucket = Number.isInteger(m.bucket) ? m.bucket : -1;
  const base = { bucket, pct: 0, src: 'default' };
  if (o.override === true) return { ...base, on: true, why: 'override', pct: 100, src: 'global' };
  if (o.override === false) return { ...base, on: false, why: 'override', src: 'global' };
  if (flags.KV_SQLITE_KILL === true) return { ...base, on: false, why: 'ota_kill', src: 'ota' };
  if (m.remote_kill === '1') return { ...base, on: false, why: 'remote_kill', src: 'remote' };
  if (m.local_off) return { ...base, on: false, why: 'crash_guard', src: 'local' };
  if (flags.KV_SQLITE_ENABLED === true) return { ...base, on: true, why: 'ota_all', pct: 100, src: 'ota' };
  let pct = Number(flags.KV_SQLITE_ROLLOUT_PCT) || 0; let src = 'default';
  const rp = m.remote_pct === null || m.remote_pct === undefined || m.remote_pct === '' ? NaN : Number(m.remote_pct);
  if (Number.isFinite(rp)) { pct = rp; src = 'remote'; }
  pct = Math.max(0, Math.min(100, Math.floor(pct)));
  if (bucket < 0) return { ...base, on: false, why: 'no_bucket', pct, src };
  const on = bucket < pct;
  return { ...base, on, why: on ? 'cohort' : 'out', pct, src };
}

function _globalOverride() {
  try {
    const o = typeof globalThis !== 'undefined' ? globalThis.__chatyy_kv_sqlite : undefined;
    if (o === true || o === false) return o;
  } catch {}
  return undefined;
}

// Abre o .db (sempre, no nativo), lê kv_meta e decide. Off com resto de KV →
// apaga o marcador JÁ (síncrono) e agenda o wipe das linhas.
function _kvPrepare() {
  if (Platform.OS === 'web') return { on: false, why: 'web', bucket: -1, pct: 0, src: 'default' };
  const ov = _globalOverride();
  const db = _kvOpen();
  if (!db) { const d = _kvDecide({}, { override: ov }); return { ...d, on: false, why: 'no_sqlite' }; }
  _db = db;
  let bucket = parseInt(_metaGet('bucket') || '', 10);
  if (!(bucket >= 0 && bucket <= 99)) {
    bucket = Math.floor(Math.random() * 100);
    _metaSet('bucket', bucket);
  }
  // [2026-10-19 perf-android] Trava v2: a v1 contava boot em 2º plano (VoIP/
  // push acorda o app e o SO suspende antes dos 30 s) como "crash" → 17 boots
  // de 1 iPhone presos em AsyncStorage. Uma vez por aparelho, solta a trava v1
  // (crash de verdade volta a travar em 3 boots em 1º plano).
  if (_metaGet('guard_v') !== '2') {
    if (_metaGet('local_off')) { _metaSet('local_off', null); _kvTele('crash_guard_v2_reset', ''); }
    _metaSet('boot_inflight', null);
    _metaSet('guard_v', '2');
  }
  const meta = { bucket, remote_kill: _metaGet('remote_kill'), remote_pct: _metaGet('remote_pct'), local_off: _metaGet('local_off') };
  let d = _kvDecide(meta, { override: ov });
  if (d.on && ov === undefined) {
    // trava de crash: n boots seguidos EM 1º PLANO com KV sem sobreviver 30 s
    // (nem chegar ao 2º plano) → desliga local
    let fg = true;
    try { if (AppState.currentState === 'background') fg = false; } catch {}
    const n = parseInt(_metaGet('boot_inflight') || '0', 10) || 0;
    if (n >= KV_CRASH_LIMIT) {
      _metaSet('local_off', 'crash:' + n);
      _metaSet('boot_inflight', null);
      _kvTele('crash_guard', `boots=${n}`);
      d = { ...d, on: false, why: 'crash_guard', src: 'local' };
    } else if (fg) {
      _metaSet('boot_inflight', n + 1);
      // chegou ao 2º plano vivo = não foi crash de boot
      try {
        const sub = AppState.addEventListener('change', (st) => {
          if (st !== 'background') return;
          _metaSet('boot_inflight', null);
          try { sub?.remove?.(); } catch {}
        });
      } catch {}
    }
  }
  if (!d.on) {
    let hasRows = false;
    try { hasRows = !!db.getFirstSync('SELECT 1 AS x FROM kv LIMIT 1'); } catch {}
    if (hasRows) {
      let hadMarker = false;
      try { hadMarker = !!db.getFirstSync('SELECT 1 AS x FROM kv WHERE k = ?', [KV_MIGRATED]); } catch {}
      try { db.runSync('DELETE FROM kv WHERE k = ?', [KV_MIGRATED]); } catch (e) {
        _db = null; _kvDropFile(db, 'unmark:' + _errMsg(e).slice(0, 60));
        return d;
      }
      setTimeout(() => {
        try { if (_kvMode === 'off' && _db) _db.runSync('DELETE FROM kv'); } catch {}
        if (hadMarker) _kvTele('rollback_wipe', `why=${d.why}`);
      }, KV_WIPE_DELAY_MS);
    }
  }
  return d;
}

function _kvTx(db, fn) {
  if (typeof db.withTransactionSync === 'function') db.withTransactionSync(fn); else fn();
}

// Sessão deixa de espelhar no KV (falha de escrita/leitura, kill remoto):
// marcador fora (próximo boot remigra do zero) e, se nem isso der, apaga o .db.
// AsyncStorage tem tudo (dual-write) → as chaves pendentes caem nele.
function _kvAbandon(why) {
  const db = _kv || _db;
  _kvMode = 'off';
  _kv = null;
  _kvTouched = null;
  _kvDirty.clear();
  _stats.backend = 'async';
  if (!db) return;
  try { db.runSync('DELETE FROM kv WHERE k = ?', [KV_MIGRATED]); } catch (e) {
    _db = null;
    _kvDropFile(db, 'abandon:' + _errMsg(e).slice(0, 60));
  }
  _kvTele('abandon', why);
}

// Persist queued kv writes in ONE sync transaction. Never throws.
export function flushStorageWrites() {
  if (_kvFlushTimer) { try { clearTimeout(_kvFlushTimer); } catch {} _kvFlushTimer = null; }
  if (!_kv || !_kvDirty.size) return;
  const items = Array.from(_kvDirty.entries());
  _kvDirty.clear();
  try {
    _kvTx(_kv, () => {
      for (const [k, v] of items) {
        if (v === null) _kv.runSync('DELETE FROM kv WHERE k = ?', [k]);
        else _kv.runSync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [k, v]);
      }
    });
  } catch (e) {
    _stats.kvErrors++;
    _beacon('kv_write_failed', `n=${items.length} err=${_errMsg(e).slice(0, 100)}`);
    // AsyncStorage still has everything (dual-write). Distrust the kv copy for
    // the rest of the session and the next boot (re-migrates from scratch).
    _kvAbandon(`write_failed n=${items.length} corrupt=${_isCorrupt(e) ? 1 : 0} err=${_errMsg(e).slice(0, 60)}`);
  }
}

function _kvQueue(fullKey, value) {
  if (!_kv || _kvMode === 'off') return;
  if (_kvTouched) _kvTouched.add(fullKey);
  _kvDirty.set(fullKey, value);
  if (value === null) {
    // [privacidade] remoção (wipe de logout/troca de conta) vai pro disco no fim
    // do tick — não fica 30 ms exposta a um kill do processo.
    if (!_kvFlushMicro) {
      _kvFlushMicro = true;
      Promise.resolve().then(() => { _kvFlushMicro = false; flushStorageWrites(); });
    }
    return;
  }
  if (!_kvFlushTimer) _kvFlushTimer = setTimeout(flushStorageWrites, KV_FLUSH_MS);
}

// Sync single-key read for the 'primary' mode. undefined = read failed.
function _kvReadSync(fullKey) {
  if (!_kv) return undefined;
  try {
    const row = _kv.getFirstSync('SELECT v FROM kv WHERE k = ?', [fullKey]);
    return row && typeof row.v === 'string' ? row.v : null;
  } catch (e) {
    _stats.kvErrors++;
    if (_isCorrupt(e)) _kvAbandon('read_corrupt ' + _errMsg(e).slice(0, 60));
    return undefined;
  }
}

// Synchronous boot from the KV table. true = fully booted from SQLite.
function _bootFromKv() {
  const db = _db;
  if (!db) return false;
  _kv = db;
  let migrated = false;
  try { migrated = !!db.getFirstSync('SELECT v FROM kv WHERE k = ?', [KV_MIGRATED]); } catch {}
  if (!migrated) {
    // Migração começa do ZERO: linha que sobrou de uma sessão sem espelho
    // (chave apagada no AsyncStorage depois) não pode ressuscitar.
    try { db.runSync(`DELETE FROM kv WHERE substr(k,1,${PFX.length})='${PFX}'`); } catch (e) {
      _kv = null; _db = null;
      _kvDropFile(db, 'premigrate:' + _errMsg(e).slice(0, 60));
      return false;
    }
    _kvMode = 'migrating'; _kvTouched = new Set();
    return false;
  }
  try {
    const rows = db.getAllSync(
      `SELECT k, CASE WHEN ${_lazySql()} THEN NULL ELSE v END AS v FROM kv WHERE substr(k,1,${PFX.length})='${PFX}'`
    ) || [];
    let n = 0;
    for (const r of rows) {
      if (!r || typeof r.k !== 'string') continue;
      if (r.v === null || r.v === undefined) _pending.add(r.k);
      else { _mem[r.k] = r.v; n++; }
    }
    _stats.bootKeys = n;
    _stats.lazyKeys = _pending.size;
    _kvMode = 'primary';
    _stats.backend = 'sqlite';
    return true;
  } catch (e) {
    _stats.kvErrors++;
    _beacon('kv_boot_failed', _errMsg(e));
    _mem = {}; _pending.clear();
    _kv = null; _kvMode = 'off';
    // Esta sessão vai rodar só no AsyncStorage → o espelho fica velho: tira o
    // marcador (ou apaga o arquivo se corrompido/inacessível).
    if (_isCorrupt(e)) { _db = null; _kvDropFile(db, 'boot:' + _errMsg(e).slice(0, 60)); }
    else { try { db.runSync('DELETE FROM kv WHERE k = ?', [KV_MIGRATED]); } catch { _db = null; _kvDropFile(db, 'boot_unmark'); } }
    _kvTele('boot_failed', `corrupt=${_isCorrupt(e) ? 1 : 0} err=${_errMsg(e).slice(0, 80)}`);
    return false;
  }
}

// Background one-time copy AsyncStorage → kv (runs in 'migrating' mode only).
const _yield = () => new Promise(r => setTimeout(r, 0));
async function _kvMigrate() {
  if (_kvMode !== 'migrating' || !_kv || !_asyncStorage) return;
  const t0 = Date.now();
  let copied = 0; let bytes = 0;
  try {
    const all = (await _asyncStorage.getAllKeys()) || [];
    const keys = all.filter(k => typeof k === 'string' && k.startsWith(PFX));
    for (let i = 0; i < keys.length; i += KV_MIGRATE_BATCH) {
      if (_kvMode !== 'migrating' || !_kv) { _kvTele('migrate_aborted', `copied=${copied} mode=${_kvMode}`); return; }
      const chunk = keys.slice(i, i + KV_MIGRATE_BATCH).filter(k => !_kvTouched?.has(k));
      if (!chunk.length) continue;
      const pairs = await _multiGetSafe(chunk);
      if (_kvMode !== 'migrating' || !_kv) { _kvTele('migrate_aborted', `copied=${copied} mode=${_kvMode}`); return; }
      const rows = [];
      for (const p of pairs) {
        // Re-check AFTER the await: a write/remove during the read wins.
        if (p && typeof p[1] === 'string' && !_kvTouched?.has(p[0])) rows.push(p);
      }
      if (rows.length) {
        _kvTx(_kv, () => {
          for (const [k, v] of rows) _kv.runSync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [k, v]);
        });
        copied += rows.length;
        for (const r of rows) bytes += r[1].length;
      }
      await _yield();
    }
    flushStorageWrites();
    if (_kvMode !== 'migrating' || !_kv) { _kvTele('migrate_aborted', `copied=${copied} mode=${_kvMode}`); return; }
    _kv.runSync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [KV_MIGRATED, String(Date.now())]);
    _stats.kvMigrated = copied;
    _stats.kvMigrateMs = Date.now() - t0;
    _beacon('kv_migrated', `keys=${copied} ms=${_stats.kvMigrateMs}`);
    _kvTele('migrated', `keys=${copied} mb=${(bytes / 1048576).toFixed(1)} ms=${_stats.kvMigrateMs}`);
  } catch (e) {
    _stats.kvErrors++;
    _beacon('kv_migrate_failed', `copied=${copied} err=${_errMsg(e).slice(0, 100)}`);
    _kvTele('migrate_failed', `copied=${copied} corrupt=${_isCorrupt(e) ? 1 : 0} err=${_errMsg(e).slice(0, 80)}`);
    // sem marcador → próximo boot tenta de novo do zero; sessão segue no AsyncStorage
    _kvAbandon('migrate_failed');
  }
}

// ─── Flag remota (bootstrap → data.config) ──────────────────────────────────
// config.kv_sqlite === false → kill (desliga já nesta sessão + próximos boots);
// config.kv_sqlite_pct = 0..100 → % de aparelhos (vale no próximo boot).
// Chaves ausentes → volta ao padrão compilado. Nunca lança.
export function noteKvRemoteConfig(cfg) {
  if (Platform.OS === 'web' || !cfg || typeof cfg !== 'object' || !_db) return;
  try {
    const prevKill = _metaGet('remote_kill'); const prevPct = _metaGet('remote_pct');
    const kill = cfg.kv_sqlite === false ? '1' : null;
    const p = Number(cfg.kv_sqlite_pct);
    const pct = cfg.kv_sqlite_pct !== undefined && cfg.kv_sqlite_pct !== null && Number.isFinite(p)
      ? String(Math.max(0, Math.min(100, Math.floor(p)))) : null;
    if (kill !== prevKill) _metaSet('remote_kill', kill);
    if (pct !== prevPct) _metaSet('remote_pct', pct);
    // reset remoto da trava de crash (config.kv_sqlite_reset = número que muda)
    if (cfg.kv_sqlite_reset !== undefined && cfg.kv_sqlite_reset !== null) {
      const ep = String(cfg.kv_sqlite_reset);
      if (ep !== _metaGet('reset_epoch')) { _metaSet('reset_epoch', ep); _metaSet('local_off', null); _metaSet('boot_inflight', null); }
    }
    if (kill !== prevKill || pct !== prevPct) _kvTele('remote', `kill=${kill || 0} pct=${pct === null ? '-' : pct} mode=${_kvMode}`);
    if (kill === '1' && _kvMode !== 'off' && _globalOverride() !== true) _kvAbandon('remote_kill');
  } catch {}
}

// ─── Telemetria (nativeBeacon 'kv_store'; espera o login, sem PII) ──────────
const _teleQ = [];
let _teleTimer = null;
let _teleTries = 0;
function _kvTele(step, info) {
  if (Platform.OS === 'web') return;
  try {
    if (_teleQ.length < 12) _teleQ.push([String(step), String(info || '')]);
    if (!_teleTimer) _teleTimer = setTimeout(_teleDrain, 1500);
  } catch {}
}
function _teleDrain() {
  _teleTimer = null;
  try {
    const m = require('./api');
    const api = m.default || m;
    const tok = (api.getAuthToken && api.getAuthToken()) || (api.getToken && api.getToken());
    if (!tok) {
      if (++_teleTries < 40) _teleTimer = setTimeout(_teleDrain, 3000); // até ~2 min
      else _teleQ.length = 0;
      return;
    }
    const { nativeBeacon } = require('./nativeTelemetry');
    while (_teleQ.length) { const [s, i] = _teleQ.shift(); nativeBeacon('kv_store', s, i); }
  } catch { _teleQ.length = 0; }
}

function _perfNow() { try { return Math.round(globalThis.performance?.now?.() || 0); } catch { return 0; } }

let _asyncStorage = null;
let _clearKeep = null; // chaves escritas enquanto o multiRemove do clearAll está em voo
let _mem = {};
const _pending = new Set();   // full keys present on disk but not yet loaded
const _listeners = new Set(); // (logicalKeys: string[]) => void
let _ready = false;
let _readyResolve = null;
const _readyPromise = new Promise(r => { _readyResolve = r; });
const _stats = { bootMs: 0, bootKeys: 0, lazyKeys: 0, dropped: 0, truncated: 0, refused: 0, backend: 'async', lazyLoads: 0, lazySyncHits: 0, kvMigrated: 0, kvMigrateMs: 0, kvErrors: 0, kvWhy: '', kvBucket: -1 };

// ─── Beacons (lazy require; deferred so boot never waits on the reporter) ───
function _beacon(context, message) {
  try {
    setTimeout(() => {
      try { require('./crashReporter').reportCrash?.({ type: 'mmkv', context, message }); } catch {}
    }, 0);
  } catch {}
}

// UTF-8 byte length. Only walks the string when it could exceed the cap.
export function utf8Bytes(s) {
  if (typeof s !== 'string') return 0;
  const n = s.length;
  if (n * 3 <= MAX_VALUE_BYTES) return n; // cheap lower bound is enough here
  let b = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) b += 1;
    else if (c < 0x800) b += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { b += 4; i++; }
    else b += 3;
  }
  return b;
}

// ─── Batched, CursorWindow-safe multiGet ─────────────────────────────────────
// Resolves to [key, value][] for every readable key. A batch that throws is
// split in half until the failing single key is isolated; that key is removed
// from disk (it can never be read again on this device) and beaconed.
async function _multiGetSafe(keys) {
  if (!keys.length) return [];
  try {
    const pairs = await _asyncStorage.multiGet(keys);
    return Array.isArray(pairs) ? pairs : [];
  } catch (e) {
    if (keys.length === 1) {
      const k = keys[0];
      _stats.dropped++;
      try { _asyncStorage.removeItem(k).catch(() => {}); } catch {}
      _pending.delete(k);
      _beacon('oversized_key_dropped', `key=${k} size=unreadable(>CursorWindow) err=${String(e?.message || e).slice(0, 80)}`);
      return [];
    }
    const mid = keys.length >> 1;
    const a = await _multiGetSafe(keys.slice(0, mid));
    const b = await _multiGetSafe(keys.slice(mid));
    return a.concat(b);
  }
}

// Loads `fullKeys` into _mem in batches. `onlyIfPending` = lazy path: never
// overwrite a value that was written (or removed) while the read was in flight.
async function _loadKeys(fullKeys, onlyIfPending) {
  const loaded = [];
  for (let i = 0; i < fullKeys.length; i += HYDRATE_BATCH) {
    const chunk = fullKeys.slice(i, i + HYDRATE_BATCH);
    let pairs = [];
    try { pairs = await _multiGetSafe(chunk); } catch {}
    for (const pair of pairs) {
      try {
        const k = pair[0]; const v = pair[1];
        if (onlyIfPending && !_pending.has(k)) continue;
        _pending.delete(k);
        if (v !== null && v !== undefined) { _mem[k] = v; loaded.push(k); }
      } catch {}
    }
    // Keys the native side silently skipped are no longer "pending" either.
    if (onlyIfPending) for (const k of chunk) _pending.delete(k);
  }
  return loaded;
}

function _bootTele(t0) {
  try {
    const d = _kvDecision;
    const ms = _stats.bootMs;
    _kvTele('boot', `be=${_stats.backend} ms=${ms} t=${_perfNow()} keys=${_stats.bootKeys} lazy=${_stats.lazyKeys} to=${ms > 1500 ? 1 : 0} why=${d.why} b=${d.bucket} pct=${d.pct} src=${d.src} err=${_stats.kvErrors}`);
  } catch {}
}

async function _init() {
  if (Platform.OS === 'web') { _ready = true; _readyResolve(); return; }
  const t0 = Date.now();
  try { _asyncStorage = require('@react-native-async-storage/async-storage').default; } catch { _asyncStorage = null; }
  // [2026-10-10] SQLite KV primary: fully synchronous boot (ready before the
  // first await → smartChatCache's sync hydrate pass already sees the data).
  // [2026-10-16] decisão por canário/flag remota (_kvPrepare, síncrono).
  try { _kvDecision = _kvPrepare(); } catch (e) { _kvDecision = { on: false, why: 'prepare_err', bucket: -1, pct: 0, src: 'default' }; }
  _stats.kvWhy = _kvDecision.why;
  _stats.kvBucket = _kvDecision.bucket;
  if (_kvDecision.on) {
    let ok = false;
    try { ok = _bootFromKv(); } catch { ok = false; _kv = null; _kvMode = 'off'; }
    if (ok) {
      _stats.bootMs = Date.now() - t0;
      _ready = true;
      _readyResolve();
      _bootTele(t0);
      try { setTimeout(() => _metaSet('boot_inflight', null), KV_CRASH_CLEAR_MS); } catch {}
      return;
    }
  }
  let keys = null;
  try {
    keys = await _asyncStorage.getAllKeys();
    const boot = [];
    for (const k of keys || []) {
      if (typeof k !== 'string' || !k.startsWith(PFX)) continue;
      if (isLazyKey(k)) _pending.add(k); else boot.push(k);
    }
    _stats.lazyKeys = _pending.size;
    _stats.bootKeys = (await _loadKeys(boot, false)).length;
  } catch {}
  _stats.bootMs = Date.now() - t0;
  if (_kvMode === 'migrating') _stats.backend = 'async+migrating';
  _ready = true;
  _readyResolve();
  _bootTele(t0);
  try {
    if (_kvMode === 'migrating') {
      setTimeout(() => { _kvMigrate().catch(() => {}); }, KV_MIGRATE_DELAY_MS);
      setTimeout(() => _metaSet('boot_inflight', null), KV_CRASH_CLEAR_MS);
    }
    // legado: marcador do AsyncStorage da versão 10-10 (a decisão hoje é pelo marcador do .db)
    if (Array.isArray(keys) && keys.includes(AS_KV_MARKER)) setTimeout(() => { _asyncStorage.removeItem(AS_KV_MARKER).catch(() => {}); }, KV_WIPE_DELAY_MS);
  } catch {}
}
_init();

export function waitForCacheReady() { return _readyPromise; }
export function isCacheReady() { return _ready; }
export function getHydrateStats() { return { ..._stats, pending: _pending.size }; }

// ─── Lazy loading ────────────────────────────────────────────────────────────
// True when the key exists on disk but its value has not been read yet — a
// getString() would return null even though data exists. Callers that do a
// read-modify-write MUST `await ensureLoaded(key)` first (see smartChatCache
// _flushOne, chatCache _kvSet) or they'd clobber the stored value.
export function isKeyPending(key) {
  if (Platform.OS === 'web') return false;
  return _pending.has(PFX + key);
}

function _emit(fullKeys) {
  if (!fullKeys.length || !_listeners.size) return;
  const logical = fullKeys.map(k => k.substring(PFX.length));
  for (const fn of Array.from(_listeners)) { try { fn(logical); } catch {} }
}

// Coalesces the sync-miss kicks of one frame into a single batched read.
let _kickQueue = new Set();
let _kickTimer = null;
const _inflight = new Map(); // fullKey → Promise
function _kick(fullKey) {
  if (_inflight.has(fullKey) || _kickQueue.has(fullKey)) return;
  _kickQueue.add(fullKey);
  if (_kickTimer) return;
  _kickTimer = setTimeout(() => {
    _kickTimer = null;
    const batch = Array.from(_kickQueue);
    _kickQueue = new Set();
    _startLoad(batch);
  }, 0);
}
function _startLoad(fullKeys) {
  const todo = fullKeys.filter(k => _pending.has(k) && !_inflight.has(k));
  if (!todo.length) return;
  const p = (async () => {
    if (_kvMode === 'primary' && _kv) {
      // [2026-10-10] KV: sync point reads, a few per task so a 20-conversation
      // prefetch never blocks a frame. A failed read falls back to AsyncStorage.
      const loaded = []; const fallback = [];
      for (let i = 0; i < todo.length; i++) {
        if (i % 4 === 0) await _yield();
        const k = todo[i];
        if (!_pending.has(k)) continue; // written/removed meanwhile → memory wins
        const v = _kvReadSync(k);
        if (v === undefined) { fallback.push(k); continue; }
        _pending.delete(k);
        if (v !== null) { _mem[k] = v; loaded.push(k); _stats.lazyLoads++; }
      }
      if (fallback.length && _asyncStorage) loaded.push(...(await _loadKeys(fallback, true)));
      _emit(loaded);
      return;
    }
    if (!_asyncStorage) return;
    const loaded = await _loadKeys(todo, true);
    _stats.lazyLoads += loaded.length;
    _emit(loaded);
  })().catch(() => {}).finally(() => { for (const k of todo) _inflight.delete(k); });
  for (const k of todo) _inflight.set(k, p);
}

// Resolves once every given (logical) key is in memory (or known absent).
export async function ensureLoaded(keys) {
  if (Platform.OS === 'web') return;
  if (!_ready) await _readyPromise;
  const list = (Array.isArray(keys) ? keys : [keys]).filter(k => typeof k === 'string').map(k => PFX + k);
  _startLoad(list);
  const waits = [];
  for (const k of list) { const p = _inflight.get(k); if (p) waits.push(p); }
  if (waits.length) await Promise.all(waits);
}

// Subscribe to lazy loads (logical keys, without the `mmkv_` prefix).
export function onKeysLoaded(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

// ─── Write cap ───────────────────────────────────────────────────────────────
// Keep the newest messages of a chat array that fit under the cap. Returns the
// re-serialized string, or null if the value isn't a JSON array.
function _truncateArrayTail(fullKey, value, bytes) {
  let arr;
  try { arr = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const target = Math.floor(MAX_VALUE_BYTES * 0.9);
  let n = Math.max(1, Math.floor(arr.length * (target / bytes)));
  let out = JSON.stringify(arr.slice(-n));
  while (n > 1 && utf8Bytes(out) > MAX_VALUE_BYTES) {
    n = Math.max(1, Math.floor(n * 0.85));
    out = JSON.stringify(arr.slice(-n));
  }
  if (utf8Bytes(out) > MAX_VALUE_BYTES) return null;
  _stats.truncated++;
  _beacon('value_truncated', `key=${fullKey} bytes=${bytes} kept=${n}/${arr.length}`);
  return out;
}

export function getString(key) {
  if (Platform.OS === 'web') {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(`mmkv_${key}`) : null; } catch { return null; }
  }
  const fk = PFX + key;
  const v = _mem[fk];
  if (v !== undefined && v !== null) return v;
  if (_pending.has(fk)) {
    // [2026-10-10] KV primary: the lazy key is one sync lookup away → return
    // it NOW (frame-1 paint of a cold conversation) instead of null + kick.
    if (_kvMode === 'primary' && _kv && !_inflight.has(fk)) {
      const r = _kvReadSync(fk);
      if (r !== undefined) {
        _pending.delete(fk);
        _stats.lazySyncHits++;
        if (r !== null) { _mem[fk] = r; return r; }
        return null;
      }
    }
    _kick(fk);
  }
  return null;
}

export function setString(key, value) {
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(`mmkv_${key}`, value); } catch {}
    return;
  }
  const fk = PFX + key;
  _pending.delete(fk);
  _mem[fk] = value;
  if (_clearKeep) _clearKeep.add(fk);
  if (!_asyncStorage) {
    if (_kvMode === 'primary') _kvQueue(fk, typeof value === 'string' ? value : String(value));
    return;
  }
  let toWrite = value;
  if (ENFORCE_CAP && typeof value === 'string') {
    const bytes = utf8Bytes(value);
    if (bytes > MAX_VALUE_BYTES) {
      const isChatArray = fk.startsWith(PFX + 'chat_msgs_') && value.charCodeAt(0) === 91 /* [ */;
      toWrite = isChatArray ? _truncateArrayTail(fk, value, bytes) : null;
      if (toWrite === null) {
        // Unreadable-on-Android value: keep the previous on-disk copy instead.
        _stats.refused++;
        _beacon('oversized_write_refused', `key=${fk} bytes=${bytes}`);
        return;
      }
      _mem[fk] = toWrite;
    }
  }
  if (_kvMode !== 'off') {
    _kvQueue(fk, typeof toWrite === 'string' ? toWrite : String(toWrite));
    if (_kvMode === 'primary' && !KV_DUAL_WRITE) return;
  }
  _asyncStorage.setItem(fk, toWrite).catch(() => {});
}

export function getNumber(key) {
  const v = getString(key); return v !== null ? Number(v) : null;
}
export function setNumber(key, value) { setString(key, String(value)); }

export function getBoolean(key) {
  const v = getString(key);
  if (v === 'true') return true; if (v === 'false') return false; return null;
}
export function setBoolean(key, value) { setString(key, value ? 'true' : 'false'); }

export function getJSON(key) {
  const v = getString(key);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
export function setJSON(key, value) {
  // JSON.stringify(undefined) === undefined → grava "undefined" no web e
  // quebra no native. Tratar undefined como deleção.
  if (value === undefined) return remove(key);
  setString(key, JSON.stringify(value));
}

export function remove(key) {
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(`mmkv_${key}`); } catch {}
    return;
  }
  const fk = PFX + key;
  _pending.delete(fk);
  delete _mem[fk];
  if (_kvMode !== 'off') _kvQueue(fk, null);
  if (_asyncStorage) _asyncStorage.removeItem(fk).catch(() => {});
}

// Includes lazy keys that exist on disk but aren't loaded yet, so prefix
// sweeps (clearChatCache, logout wipes, migrations) still see them.
export function getAllKeys() {
  if (Platform.OS === 'web') {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith('mmkv_')) keys.push(k.substring(5));
      }
      return keys;
    } catch { return []; }
  }
  const out = Object.keys(_mem).filter(k => k.startsWith(PFX));
  for (const k of _pending) if (!(k in _mem)) out.push(k);
  return out.map(k => k.substring(PFX.length));
}

export function clearAll() {
  if (Platform.OS === 'web') {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith('mmkv_')) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
    } catch {}
    return;
  }
  _mem = {};
  _pending.clear();
  if (_kv && _kvMode !== 'off') {
    _kvDirty.clear();
    let ok = true;
    try { _kv.runSync(`DELETE FROM kv WHERE substr(k,1,${PFX.length})='${PFX}'`); } catch { ok = false; }
    if (!ok) _kvAbandon('clearall_failed');
    else if (_kvMode === 'migrating') {
      // Mid-migration: anything the copy would still read is being removed
      // from AsyncStorage too → stop it; the next launch re-migrates.
      _kvAbandon('clearall_migrating');
    }
  } else if (_db) {
    // off: espelho velho não pode guardar dado da conta que saiu
    try { _db.runSync('DELETE FROM kv'); } catch {}
  }
  if (_asyncStorage) {
    // [2026-10-16] o multiRemove é assíncrono: chave gravada DEPOIS do clearAll
    // (ex.: 1ª escrita da conta nova na troca) não pode ser apagada junto.
    const keep = (_clearKeep = new Set());
    _asyncStorage.getAllKeys().then(keys => {
      if (_clearKeep === keep) _clearKeep = null;
      const mk = (keys || []).filter(k => k.startsWith('mmkv_') && !keep.has(k));
      if (mk.length) _asyncStorage.multiRemove(mk).catch(() => {});
    }).catch(() => {});
  }
}


export function getStorageBackend() { return _kvMode === 'primary' ? 'sqlite' : (_kvMode === 'migrating' ? 'async+migrating' : 'async'); }
export function getKvDecision() { return { ..._kvDecision, mode: _kvMode }; }

// Flush queued KV writes when the app leaves the foreground (iOS may suspend
// before the 30 ms timer fires).
try {
  if (Platform.OS !== 'web') {
    const { AppState } = require('react-native');
    AppState?.addEventListener?.('change', (next) => {
      if (next === 'background' || next === 'inactive') flushStorageWrites();
    });
  }
} catch {}
