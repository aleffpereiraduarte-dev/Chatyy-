#!/usr/bin/env node
/* eslint-disable */
// [2026-10-10 storage-boot] Node tests (no jest) for services/mmkv.js
// (iOS lazy + SQLite KV backend + migration/rollback), the smartChatCache
// lazy hydrate, and services/nativeChatCacheGate.js.
//
//   cd /root/webmail-app && node scripts/tests/storage-boot.test.js
//
// Mocks: react-native (Platform/AppState), AsyncStorage (in-memory Map that
// survives "app restarts"), expo-sqlite (node:sqlite DatabaseSync on a temp
// file, sync API subset), modules/expo-chat-cache. Each "launch" re-requires
// the modules fresh. Long timers (KV migrate delay) are clamped to 0.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const assert = require('assert');
const babel = require('@babel/core');

const ROOT = path.resolve(__dirname, '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chatyy-storage-test-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

// ─── mocks ────────────────────────────────────────────────────────────────────
const MOCK = { os: 'ios', asStore: new Map(), asHooks: {}, sqliteFail: false, sqliteReadFailKey: null, sqliteWriteFail: false, sqliteBootFail: null, nativeChatCache: null, beacons: [], token: 'tok' };
globalThis.__DEV__ = false;
const mockDir = path.join(TMP, 'mocks'); fs.mkdirSync(mockDir);
fs.writeFileSync(path.join(mockDir, 'react-native.js'), `
module.exports = {
  Platform: { get OS() { return globalThis.__MOCK.os; }, select: (o) => o[globalThis.__MOCK.os] ?? o.default },
  AppState: { addEventListener() { return { remove() {} }; }, currentState: 'active' },
};`);
fs.writeFileSync(path.join(mockDir, 'async-storage.js'), `
const M = () => globalThis.__MOCK;
const tick = () => new Promise(r => setImmediate(r));
const api = {
  async getAllKeys() { await tick(); return Array.from(M().asStore.keys()); },
  async multiGet(keys) { await tick(); const out = keys.map(k => [k, M().asStore.has(k) ? M().asStore.get(k) : null]); if (M().asHooks.afterMultiGet) M().asHooks.afterMultiGet(keys); return out; },
  async getItem(k) { await tick(); return M().asStore.has(k) ? M().asStore.get(k) : null; },
  async setItem(k, v) { M().asStore.set(k, String(v)); },
  async removeItem(k) { M().asStore.delete(k); },
  async multiRemove(ks) { for (const k of ks) M().asStore.delete(k); },
};
module.exports = { __esModule: true, default: api };`);
fs.writeFileSync(path.join(mockDir, 'expo-sqlite.js'), `
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const M = () => globalThis.__MOCK;
const norm = (p) => p === undefined ? [] : (Array.isArray(p) ? p : [p]);
function wrap(db) {
  return {
    execSync(sql) { db.exec(sql); },
    runSync(sql, p) {
      if (M().sqliteWriteFail && /^(INSERT OR REPLACE INTO kv |DELETE FROM kv)/.test(sql)) throw new Error(M().sqliteWriteFail === true ? 'simulated: disk I/O error' : M().sqliteWriteFail);
      const r = db.prepare(sql).run(...norm(p)); return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }; },
    getFirstSync(sql, p) {
      if (M().sqliteReadFailKey && norm(p).includes(M().sqliteReadFailKey)) throw new Error('simulated read failure');
      const r = db.prepare(sql).get(...norm(p)); return r ? { ...r } : null;
    },
    getAllSync(sql, p) { if (M().sqliteBootFail && /FROM kv WHERE/.test(sql)) throw new Error(M().sqliteBootFail); return db.prepare(sql).all(...norm(p)).map(r => ({ ...r })); },
    withTransactionSync(fn) { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } },
    closeSync() { try { db.close(); } catch {} },
  };
}
module.exports = {
  openDatabaseSync(name) {
    if (M().sqliteFail) throw new Error('simulated: native module missing');
    return wrap(new DatabaseSync(path.join(M().sqliteDir, name)));
  },
  deleteDatabaseSync(name) {
    const fs = require('fs');
    for (const suf of ['', '-wal', '-shm']) { try { fs.rmSync(path.join(M().sqliteDir, name + suf)); } catch {} }
    M().deleted = (M().deleted || 0) + 1;
  },
};`);
fs.writeFileSync(path.join(mockDir, 'api.js'), `
module.exports = { getAuthToken() { return globalThis.__MOCK.token; } };`);
fs.writeFileSync(path.join(mockDir, 'nativeTelemetry.js'), `
module.exports = { nativeBeacon(p, s, i) { globalThis.__MOCK.beacons.push(p + ' ' + s + ' ' + (i || '')); } };`);
fs.writeFileSync(path.join(mockDir, 'expo-chat-cache.js'), `
module.exports = { __esModule: true, get default() { return globalThis.__MOCK.nativeChatCache; } };`);
// [2026-10-18] produção usa KV_SQLITE_ROLLOUT_PCT=100; os cenários abaixo
// testam a semântica do canário com o padrão antigo de 10 %.
fs.writeFileSync(path.join(mockDir, 'featureFlags.js'), `
module.exports = Object.assign({}, require(${JSON.stringify(path.join(ROOT, 'constants/featureFlags.js'))}), { KV_SQLITE_ROLLOUT_PCT: 10 });`);
globalThis.__MOCK = MOCK;
MOCK.sqliteDir = path.join(TMP, 'sqlite'); fs.mkdirSync(MOCK.sqliteDir);

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'react-native') return path.join(mockDir, 'react-native.js');
  if (req === '@react-native-async-storage/async-storage') return path.join(mockDir, 'async-storage.js');
  if (req === 'expo-sqlite') return path.join(mockDir, 'expo-sqlite.js');
  if (/modules\/expo-chat-cache$/.test(req)) return path.join(mockDir, 'expo-chat-cache.js');
  if (req === './api' && /services\/mmkv\.js$/.test(parent && parent.filename || '')) return path.join(mockDir, 'api.js');
  if (req === './nativeTelemetry') return path.join(mockDir, 'nativeTelemetry.js');
  if (req === '../constants/featureFlags' && /services\/mmkv\.js$/.test(parent && parent.filename || '')) return path.join(mockDir, 'featureFlags.js');
  if (req === './crashReporter' || req === './e2eeV4Shape' || req === './chatCache') return path.join(mockDir, 'empty.js');
  return origResolve.call(this, req, parent, ...rest);
};
fs.writeFileSync(path.join(mockDir, 'empty.js'), 'module.exports = {};');

const origJs = Module._extensions['.js'];
Module._extensions['.js'] = function (mod, filename) {
  if (filename.startsWith(ROOT) && !filename.includes('node_modules') && !filename.startsWith(path.join(ROOT, 'scripts'))) {
    const out = babel.transformFileSync(filename, {
      babelrc: false, configFile: false,
      plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
    });
    return mod._compile(out.code, filename);
  }
  return origJs(mod, filename);
};

// Clamp long timers (KV migrate delay / invalidate delay) so tests run fast.
const _st = global.setTimeout;
global.setTimeout = (fn, ms, ...a) => _st(fn, ms > 200 ? 0 : ms, ...a);

function freshLaunch() {
  for (const k of Object.keys(require.cache)) if (k.startsWith(ROOT) && !k.includes('node_modules')) delete require.cache[k];
  return {
    mmkv: require(path.join(ROOT, 'services/mmkv.js')),
  };
}
const sleep = (ms) => new Promise(r => _st(r, ms));
async function settle(ms = 60) { await sleep(ms); }

function kvRows() {
  const { DatabaseSync } = require('node:sqlite');
  const f = path.join(MOCK.sqliteDir, 'chatyy_kv.db');
  if (!fs.existsSync(f)) return null;
  const db = new DatabaseSync(f);
  try { return new Map(db.prepare('SELECT k, v FROM kv').all().map(r => [r.k, r.v])); } finally { db.close(); }
}
function resetWorld() {
  MOCK.asStore = new Map(); MOCK.asHooks = {}; MOCK.sqliteFail = false; MOCK.sqliteReadFailKey = null; MOCK.os = 'ios';
  for (const f of fs.readdirSync(MOCK.sqliteDir)) fs.rmSync(path.join(MOCK.sqliteDir, f));
  delete globalThis.__chatyy_kv_sqlite; delete globalThis.__chatyy_native_chat_cache;
  MOCK.sqliteWriteFail = false; MOCK.sqliteBootFail = null; MOCK.beacons = []; MOCK.token = 'tok'; MOCK.deleted = 0;
  setMeta({ bucket: '99' });
}
function kvDb() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(MOCK.sqliteDir, 'chatyy_kv.db'));
  db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL); CREATE TABLE IF NOT EXISTS kv_meta (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);');
  return db;
}
function setMeta(obj) {
  const db = kvDb();
  try { for (const [k, v] of Object.entries(obj)) { if (v === null) db.prepare('DELETE FROM kv_meta WHERE k = ?').run(k); else db.prepare('INSERT OR REPLACE INTO kv_meta (k, v) VALUES (?, ?)').run(k, String(v)); } } finally { db.close(); }
}
function getMeta() {
  const db = kvDb();
  try { return Object.fromEntries(db.prepare('SELECT k, v FROM kv_meta').all().map(r => [r.k, r.v])); } finally { db.close(); }
}
function dataRows() { const r = kvRows(); return r ? Array.from(r.keys()).filter(k => k.startsWith('mmkv_')) : []; }
function seed() {
  const msgs = (cid, n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: cid * 1000 + i + 1, conversation_id: cid, content: `m${i}`, created_at: '2026-10-10T00:00:00Z' })));
  MOCK.asStore.set('mmkv_theme', 'dark');
  MOCK.asStore.set('mmkv_chat_convs_v2', JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]));
  MOCK.asStore.set('mmkv_chat_index_v2', JSON.stringify({ lru: { 1: 3, 2: 2, 3: 1 }, bytes: {}, totalBytes: 0 }));
  MOCK.asStore.set('mmkv_chat_msgs_v2_1', msgs(1, 5));
  MOCK.asStore.set('mmkv_chat_msgs_v2_2', msgs(2, 3));
  MOCK.asStore.set('mmkv_chat_msgs_v2_3', msgs(3, 2));
  MOCK.asStore.set('mmkv_omc_msg_index_a', '["x"]');
  MOCK.asStore.set('mmkv_omc_msg_a_1', '{"body":"hi"}');
  MOCK.asStore.set('mmkv_apiofl1_x', '{"r":{}}');
  MOCK.asStore.set('unrelated_key', 'keep');
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ─── 1. iOS lazy ─────────────────────────────────────────────────────────────
test('isLazyKey: lazy on ios+android, never on web; index keys stay eager', async () => {
  const { mmkv } = freshLaunch();
  for (const osName of ['ios', 'android']) {
    MOCK.os = osName;
    assert.strictEqual(mmkv.isLazyKey('mmkv_chat_msgs_v2_1'), true, osName);
    assert.strictEqual(mmkv.isLazyKey('mmkv_omc_msg_a_1'), true, osName);
    assert.strictEqual(mmkv.isLazyKey('mmkv_apiofl1_x'), true, osName);
    assert.strictEqual(mmkv.isLazyKey('mmkv_omc_msg_index_a'), false, osName);
    assert.strictEqual(mmkv.isLazyKey('mmkv_chat_convs_v2'), false, osName);
  }
  MOCK.os = 'web';
  assert.strictEqual(mmkv.isLazyKey('mmkv_chat_msgs_v2_1'), false);
});

test('iOS AsyncStorage boot: message/email blobs are NOT hydrated, load on demand', async () => {
  seed();
  const { mmkv } = freshLaunch();
  await mmkv.waitForCacheReady();
  const st = mmkv.getHydrateStats();
  assert.strictEqual(st.backend, 'async');
  assert.strictEqual(st.lazyKeys, 5);  // 3 chat blobs + omc_msg_a_1 + apiofl1_x
  assert.strictEqual(st.bootKeys, 4);  // theme, convs, index, omc_msg_index
  assert.strictEqual(mmkv.getString('theme'), 'dark');
  assert.strictEqual(mmkv.isKeyPending('chat_msgs_v2_1'), true);
  assert.strictEqual(mmkv.getString('chat_msgs_v2_1'), null); // miss → kick
  await settle();
  assert.ok(mmkv.getString('chat_msgs_v2_1').startsWith('[{'));
  assert.strictEqual(mmkv.isKeyPending('chat_msgs_v2_1'), false);
  await mmkv.ensureLoaded(['omc_msg_a_1']);
  assert.strictEqual(mmkv.getString('omc_msg_a_1'), '{"body":"hi"}');
  const keys = mmkv.getAllKeys();
  for (const k of ['chat_msgs_v2_2', 'chat_msgs_v2_3', 'apiofl1_x', 'theme']) assert.ok(keys.includes(k), k);
});

test('iOS smartChatCache: hydrate parses 0 blobs at boot, prefetch warms, flush never clobbers a lazy blob', async () => {
  seed();
  const { mmkv } = freshLaunch();
  const sc = require(path.join(ROOT, 'services/smartChatCache.js'));
  await mmkv.waitForCacheReady();
  await settle(5);
  const hs = sc.getSmartHydrateStats();
  assert.strictEqual(hs.parsed, 0, 'no message blob parsed on the boot path');
  assert.strictEqual(hs.prefetched, 3);
  await settle();
  assert.strictEqual(sc.getCachedMessagesSync(1, 50).length, 5, 'prefetched conv 1 warm');
  // Write to a conversation, then flush: persisted blob must keep old rows.
  sc.cacheSingleMessage(3, { id: 3999, conversation_id: 3, content: 'new', created_at: '2026-10-10T01:00:00Z' });
  sc.flushPendingWrites();
  await settle();
  const persisted = JSON.parse(MOCK.asStore.get('mmkv_chat_msgs_v2_3'));
  assert.deepStrictEqual(persisted.map(m => m.id), [3001, 3002, 3999]);
});

test('lazy read-modify-write: blob still pending → flush waits for load + merges', async () => {
  seed();
  // Make conv 2 NOT part of the prefetch (empty lru) so it stays pending.
  MOCK.asStore.set('mmkv_chat_index_v2', JSON.stringify({ lru: {}, bytes: {}, totalBytes: 0 }));
  const { mmkv } = freshLaunch();
  const sc = require(path.join(ROOT, 'services/smartChatCache.js'));
  await mmkv.waitForCacheReady();
  assert.strictEqual(mmkv.isKeyPending('chat_msgs_v2_2'), true);
  sc.cacheMessages(2, [{ id: 2999, conversation_id: 2, content: 'x' }]);
  sc.flushPendingWrites();
  await settle(100);
  const persisted = JSON.parse(MOCK.asStore.get('mmkv_chat_msgs_v2_2'));
  assert.deepStrictEqual(persisted.map(m => m.id), [2001, 2002, 2003, 2999]);
});

// ─── 2. SQLite KV backend ───────────────────────────────────────────────────
test('KV flag off (default): AsyncStorage only, no kv db created', async () => {
  seed();
  const { mmkv } = freshLaunch();
  await mmkv.waitForCacheReady();
  mmkv.setString('a', '1');
  await settle();
  assert.strictEqual(mmkv.getStorageBackend(), 'async');
  assert.strictEqual(kvRows().size, 0, 'kv data table empty (só kv_meta)');
  assert.strictEqual(mmkv.getKvDecision().why, 'out');
  assert.strictEqual(MOCK.asStore.get('mmkv_a'), '1');
});

test('KV migration: launch 1 copies AsyncStorage→SQLite (writes during migration win), launch 2 boots sync from SQLite', async () => {
  seed();
  globalThis.__chatyy_kv_sqlite = true;
  let { mmkv } = freshLaunch();
  assert.strictEqual(mmkv.getStorageBackend(), 'async+migrating');
  await mmkv.waitForCacheReady();
  // Race: a write lands while the migration's multiGet is in flight.
  let raced = false;
  MOCK.asHooks.afterMultiGet = (keys) => {
    if (!raced && keys.includes('mmkv_theme')) { raced = true; mmkv.setString('theme', 'light'); }
  };
  mmkv.remove('apiofl1_x');
  mmkv.setString('new_key', 'v1');
  await settle(150);
  MOCK.asHooks = {};
  let rows = kvRows();
  assert.ok(rows.has('__kv_migrated_v1'), 'marker set');
  assert.strictEqual(rows.get('mmkv_theme'), 'light', 'write during migration not overwritten by stale copy');
  assert.strictEqual(rows.has('mmkv_apiofl1_x'), false, 'removed key not resurrected');
  assert.strictEqual(rows.get('mmkv_new_key'), 'v1');
  assert.strictEqual(rows.get('mmkv_chat_msgs_v2_1'), MOCK.asStore.get('mmkv_chat_msgs_v2_1'));
  assert.strictEqual(rows.has('unrelated_key'), false, 'only mmkv_* keys copied');

  // Launch 2: synchronous boot.
  ({ mmkv } = freshLaunch());
  assert.strictEqual(mmkv.getStorageBackend(), 'sqlite');
  assert.strictEqual(mmkv.isCacheReady(), true, 'ready synchronously at module load');
  assert.strictEqual(mmkv.getString('theme'), 'light');
  assert.strictEqual(mmkv.isKeyPending('chat_msgs_v2_1'), true);
  const v = mmkv.getString('chat_msgs_v2_1'); // sync lazy hit, no null+kick
  assert.ok(v && v.startsWith('[{'));
  assert.strictEqual(mmkv.getHydrateStats().lazySyncHits, 1);
  // ensureLoaded + onKeysLoaded in sqlite mode
  const seen = [];
  const off = mmkv.onKeysLoaded((ks) => seen.push(...ks));
  await mmkv.ensureLoaded(['chat_msgs_v2_2', 'omc_msg_a_1']);
  off();
  assert.deepStrictEqual(seen.sort(), ['chat_msgs_v2_2', 'omc_msg_a_1']);
  // writes go to kv AND AsyncStorage (dual-write)
  mmkv.setString('theme', 'auto');
  mmkv.remove('new_key');
  mmkv.flushStorageWrites();
  rows = kvRows();
  assert.strictEqual(rows.get('mmkv_theme'), 'auto');
  assert.strictEqual(rows.has('mmkv_new_key'), false);
  assert.strictEqual(MOCK.asStore.get('mmkv_theme'), 'auto');
  assert.strictEqual(MOCK.asStore.has('mmkv_new_key'), false);
  // getAllKeys sees lazy keys never loaded
  assert.ok(mmkv.getAllKeys().includes('chat_msgs_v2_3'));
});

test('KV sync read failure → falls back to AsyncStorage async load', async () => {
  seed();
  globalThis.__chatyy_kv_sqlite = true;
  let { mmkv } = freshLaunch(); await mmkv.waitForCacheReady(); await settle(150);
  ({ mmkv } = freshLaunch());
  assert.strictEqual(mmkv.getStorageBackend(), 'sqlite');
  MOCK.sqliteReadFailKey = 'mmkv_chat_msgs_v2_3';
  assert.strictEqual(mmkv.getString('chat_msgs_v2_3'), null);
  await settle();
  assert.ok(mmkv.getString('chat_msgs_v2_3').startsWith('[{'), 'loaded via AsyncStorage fallback');
});

test('KV rollback: flag OFF after migration → AsyncStorage is current, kv wiped, re-enable re-migrates', async () => {
  seed();
  globalThis.__chatyy_kv_sqlite = true;
  let { mmkv } = freshLaunch(); await mmkv.waitForCacheReady(); await settle(150);
  ({ mmkv } = freshLaunch());
  mmkv.setString('theme', 'from-sqlite-mode');
  mmkv.flushStorageWrites();
  await settle();
  // Flag off
  globalThis.__chatyy_kv_sqlite = false;
  ({ mmkv } = freshLaunch());
  await mmkv.waitForCacheReady();
  assert.strictEqual(mmkv.getStorageBackend(), 'async');
  assert.strictEqual(mmkv.getString('theme'), 'from-sqlite-mode', 'dual-write kept AsyncStorage current');
  mmkv.setString('theme', 'from-async-mode');
  await settle(100);
  assert.strictEqual(kvRows().size, 0, 'kv wiped');
  assert.strictEqual(MOCK.asStore.has('kvsql_migrated_v1'), false);
  // Re-enable → migrating (never serves the stale kv copy)
  globalThis.__chatyy_kv_sqlite = true;
  ({ mmkv } = freshLaunch());
  assert.strictEqual(mmkv.getStorageBackend(), 'async+migrating');
  await mmkv.waitForCacheReady();
  assert.strictEqual(mmkv.getString('theme'), 'from-async-mode');
  await settle(150);
  ({ mmkv } = freshLaunch());
  assert.strictEqual(mmkv.getStorageBackend(), 'sqlite');
  assert.strictEqual(mmkv.getString('theme'), 'from-async-mode');
});

test('KV: expo-sqlite unavailable (old binary) → plain AsyncStorage, no throw', async () => {
  seed();
  globalThis.__chatyy_kv_sqlite = true;
  MOCK.sqliteFail = true;
  const { mmkv } = freshLaunch();
  await mmkv.waitForCacheReady();
  assert.strictEqual(mmkv.getStorageBackend(), 'async');
  assert.strictEqual(mmkv.getString('theme'), 'dark');
  mmkv.setString('x', 'y');
  await settle();
  assert.strictEqual(MOCK.asStore.get('mmkv_x'), 'y');
});

test('KV clearAll in sqlite mode wipes mmkv_* rows from both stores, keeps marker', async () => {
  seed();
  globalThis.__chatyy_kv_sqlite = true;
  let { mmkv } = freshLaunch(); await mmkv.waitForCacheReady(); await settle(150);
  ({ mmkv } = freshLaunch());
  mmkv.clearAll();
  await settle();
  const rows = kvRows();
  assert.deepStrictEqual(Array.from(rows.keys()), ['__kv_migrated_v1']);
  assert.deepStrictEqual(Array.from(MOCK.asStore.keys()).filter(k => k.startsWith('mmkv_')), []);
  assert.strictEqual(mmkv.getString('theme'), null);
});

test('web: localStorage path untouched by the KV flag', async () => {
  MOCK.os = 'web';
  globalThis.__chatyy_kv_sqlite = true;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k), key: (i) => Array.from(store.keys())[i], get length() { return store.size; },
  };
  const { mmkv } = freshLaunch();
  await mmkv.waitForCacheReady();
  mmkv.setString('chat_msgs_v2_9', '[1]');
  assert.strictEqual(store.get('mmkv_chat_msgs_v2_9'), '[1]');
  assert.strictEqual(mmkv.getString('chat_msgs_v2_9'), '[1]');
  assert.strictEqual(mmkv.isKeyPending('chat_msgs_v2_9'), false);
  assert.strictEqual(mmkv.getStorageBackend(), 'async');
  assert.strictEqual(dataRows().length, 0);
  delete globalThis.localStorage;
});

// ─── 2b. [2026-10-16 wave10-B] canário / flag remota / isolamento / corrupção ──
async function migrateAndReopen(osName) {
  if (osName) MOCK.os = osName;
  let { mmkv } = freshLaunch(); await mmkv.waitForCacheReady(); await settle(150);
  ({ mmkv } = freshLaunch());
  assert.strictEqual(mmkv.getStorageBackend(), 'sqlite');
  return mmkv;
}

test('_kvDecide: precedência override > kill OTA > kill remoto > trava > 100% > % remoto/padrão', async () => {
  const { mmkv } = freshLaunch();
  const F = (o) => ({ KV_SQLITE_ENABLED: false, KV_SQLITE_ROLLOUT_PCT: 10, KV_SQLITE_KILL: false, ...o });
  const d = (meta, o) => mmkv._kvDecide(meta, { flags: F(o && o.flags), override: o && o.override });
  assert.strictEqual(d({ bucket: 9 }).on, true);
  assert.strictEqual(d({ bucket: 9 }).why, 'cohort');
  assert.strictEqual(d({ bucket: 10 }).on, false, 'balde 10 fora de 10%');
  assert.strictEqual(d({ bucket: 0 }, { flags: { KV_SQLITE_ROLLOUT_PCT: 0 } }).on, false);
  assert.strictEqual(d({ bucket: 99 }, { flags: { KV_SQLITE_ROLLOUT_PCT: 100 } }).on, true);
  assert.deepStrictEqual([d({ bucket: 50, remote_pct: '60' }).on, d({ bucket: 50, remote_pct: '60' }).src], [true, 'remote']);
  assert.strictEqual(d({ bucket: 5, remote_pct: '0' }).on, false, 'remoto 0% desliga o canário');
  assert.strictEqual(d({ bucket: 5, remote_kill: '1' }).why, 'remote_kill');
  assert.strictEqual(d({ bucket: 5 }, { flags: { KV_SQLITE_KILL: true } }).why, 'ota_kill');
  assert.strictEqual(d({ bucket: 5, local_off: 'crash:3' }).why, 'crash_guard');
  assert.strictEqual(d({ bucket: 99 }, { flags: { KV_SQLITE_ENABLED: true } }).why, 'ota_all');
  assert.strictEqual(d({ bucket: 99, remote_kill: '1' }, { flags: { KV_SQLITE_ENABLED: true } }).on, false, 'kill vence 100%');
  assert.strictEqual(d({ bucket: 99, remote_kill: '1' }, { override: true }).on, true, 'override de dev vence tudo');
  assert.strictEqual(d({ bucket: 1 }, { override: false }).on, false);
  assert.strictEqual(d({}).why, 'no_bucket');
});

test('canário padrão 10%: balde 3 migra → 2º boot SQLite; balde novo é sorteado e persistido', async () => {
  seed();
  setMeta({ bucket: '3' });
  let { mmkv } = freshLaunch();
  assert.strictEqual(mmkv.getStorageBackend(), 'async+migrating');
  assert.strictEqual(mmkv.getKvDecision().why, 'cohort');
  await mmkv.waitForCacheReady(); await settle(150);
  ({ mmkv } = freshLaunch());
  assert.strictEqual(mmkv.getStorageBackend(), 'sqlite');
  assert.strictEqual(mmkv.getString('theme'), 'dark');
  await settle(30);
  assert.ok(MOCK.beacons.some(b => /^kv_store migrated keys=9 /.test(b)), MOCK.beacons.join('|'));
  assert.ok(MOCK.beacons.some(b => /^kv_store boot be=sqlite ms=\d+ t=\d+ keys=4 lazy=5 to=0 why=cohort b=3 pct=10 src=default err=0/.test(b)), MOCK.beacons.join('|'));
  // sem balde → sorteia e guarda (estável entre boots)
  resetWorld(); setMeta({ bucket: null });
  freshLaunch();
  const b1 = getMeta().bucket;
  assert.ok(/^\d+$/.test(b1) && +b1 < 100);
  freshLaunch();
  assert.strictEqual(getMeta().bucket, b1);
});

test('telemetria espera login: sem token não envia; com token drena a fila', async () => {
  seed(); MOCK.token = null;
  const { mmkv } = freshLaunch(); await mmkv.waitForCacheReady(); await settle(40);
  assert.strictEqual(MOCK.beacons.length, 0);
  MOCK.token = 'tok'; await settle(40);
  assert.ok(MOCK.beacons.some(b => /^kv_store boot be=async .* why=out b=99 pct=10/.test(b)), MOCK.beacons.join('|'));
});

test('flag remota: pct liga no próximo boot; kill desliga NA HORA (marcador fora) e o boot seguinte limpa o espelho', async () => {
  seed();
  setMeta({ bucket: '50' });
  let { mmkv } = freshLaunch(); await mmkv.waitForCacheReady();
  assert.strictEqual(mmkv.getStorageBackend(), 'async');
  mmkv.noteKvRemoteConfig({ kv_sqlite_pct: 60 });
  assert.strictEqual(getMeta().remote_pct, '60');
  mmkv = await migrateAndReopen();
  assert.strictEqual(mmkv.getKvDecision().src, 'remote');
  // kill remoto em plena sessão primary
  mmkv.noteKvRemoteConfig({ kv_sqlite: false, kv_sqlite_pct: 60 });
  assert.strictEqual(mmkv.getStorageBackend(), 'async');
  assert.strictEqual(kvRows().has('__kv_migrated_v1'), false, 'marcador apagado síncrono');
  mmkv.setString('theme', 'after-kill');           // só AsyncStorage agora
  assert.ok(mmkv.getString('chat_msgs_v2_2') === null); // pendente → cai no AsyncStorage
  await settle();
  assert.ok(mmkv.getString('chat_msgs_v2_2').startsWith('[{'));
  ({ mmkv } = freshLaunch()); await mmkv.waitForCacheReady();
  assert.strictEqual(mmkv.getKvDecision().why, 'remote_kill');
  assert.strictEqual(mmkv.getString('theme'), 'after-kill');
  await settle(60);
  assert.strictEqual(dataRows().length, 0, 'espelho apagado');
  // servidor tira a flag ({}): volta ao padrão (balde 50 fora de 10%)
  mmkv.noteKvRemoteConfig({});
  assert.strictEqual(getMeta().remote_kill, undefined);
  assert.strictEqual(getMeta().remote_pct, undefined);
  ({ mmkv } = freshLaunch());
  assert.strictEqual(mmkv.getKvDecision().why, 'out');
  await settle(30);
  assert.ok(MOCK.beacons.some(b => /^kv_store remote kill=1 pct=60 mode=primary/.test(b)), MOCK.beacons.join('|'));
  assert.ok(MOCK.beacons.some(b => /^kv_store abandon remote_kill/.test(b)));
});

test('isolamento: wipe de logout da conta A chega ao SQLite antes de um kill (sem esperar 30 ms)', async () => {
  seed();
  MOCK.asStore.set('mmkv_chat_convs_v2__hA', '[{"id":"A-secret"}]');
  MOCK.asStore.set('mmkv_chat_msgs_v2__hA_1', '[{"id":1,"content":"A-secret"}]');
  globalThis.__chatyy_kv_sqlite = true;
  let mmkv = await migrateAndReopen();
  assert.ok(kvRows().has('mmkv_chat_msgs_v2__hA_1'));
  // logout A: remoções (como clearAllPerAccountCaches/smartChatCache), processo morre no mesmo tick
  for (const k of mmkv.getAllKeys()) if (k.includes('__hA')) mmkv.remove(k);
  await Promise.resolve();
  const rows = kvRows();
  assert.strictEqual(rows.has('mmkv_chat_convs_v2__hA'), false);
  assert.strictEqual(rows.has('mmkv_chat_msgs_v2__hA_1'), false);
  ({ mmkv } = freshLaunch());
  assert.strictEqual(mmkv.getString('chat_convs_v2__hA'), null);
  assert.strictEqual(mmkv.getString('chat_msgs_v2__hA_1'), null);
  assert.ok(!mmkv.getAllKeys().some(k => k.includes('__hA')));
});

test('isolamento: logout de A numa sessão SEM espelho (flag off) não ressuscita A quando a flag volta', async () => {
  seed();
  MOCK.asStore.set('mmkv_chat_msgs_v2__hA_1', '[{"id":1,"content":"A-secret"}]');
  globalThis.__chatyy_kv_sqlite = true;
  await migrateAndReopen();
  // sessão com flag off: o processo morre ANTES do wipe agendado (3 s) rodar
  globalThis.__chatyy_kv_sqlite = false;
  const realST = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => (ms >= 3000 ? 0 : realST(fn, ms, ...a)); // wipe nunca roda
  let { mmkv } = freshLaunch(); await mmkv.waitForCacheReady();
  mmkv.remove('chat_msgs_v2__hA_1');   // logout A só no AsyncStorage
  mmkv.setString('chat_convs_v2__hB', '[{"id":"B"}]');
  global.setTimeout = realST;
  assert.ok(kvRows().has('mmkv_chat_msgs_v2__hA_1'), 'linha velha ainda no arquivo');
  assert.strictEqual(kvRows().has('__kv_migrated_v1'), false, 'mas sem marcador');
  // flag volta: tem que migrar do zero (apaga órfãs) — nunca servir o espelho velho
  globalThis.__chatyy_kv_sqlite = true;
  ({ mmkv } = freshLaunch());
  assert.strictEqual(mmkv.getStorageBackend(), 'async+migrating');
  assert.strictEqual(kvRows().has('mmkv_chat_msgs_v2__hA_1'), false, 'órfã apagada antes de copiar');
  await mmkv.waitForCacheReady(); await settle(150);
  ({ mmkv } = freshLaunch());
  assert.strictEqual(mmkv.getStorageBackend(), 'sqlite');
  assert.strictEqual(mmkv.getString('chat_msgs_v2__hA_1'), null);
  assert.strictEqual(mmkv.getString('chat_convs_v2__hB'), '[{"id":"B"}]');
});

test('isolamento: troca de conta com clearAll no meio da migração → aborta, próximo boot remigra sem dados de A', async () => {
  seed();
  MOCK.asStore.set('mmkv_chat_msgs_v2__hA_1', '[{"id":"A"}]');
  globalThis.__chatyy_kv_sqlite = true;
  let { mmkv } = freshLaunch(); await mmkv.waitForCacheReady();
  let cleared = false;
  MOCK.asHooks.afterMultiGet = () => { if (!cleared) { cleared = true; mmkv.clearAll(); mmkv.setString('chat_convs_v2__hB', '[{"id":"B"}]'); } };
  await settle(150);
  MOCK.asHooks = {};
  assert.strictEqual(kvRows().has('__kv_migrated_v1'), false);
  assert.strictEqual(kvRows().has('mmkv_chat_msgs_v2__hA_1'), false);
  ({ mmkv } = freshLaunch()); await mmkv.waitForCacheReady(); await settle(150);
  ({ mmkv } = freshLaunch());
  assert.strictEqual(mmkv.getStorageBackend(), 'sqlite');
  assert.deepStrictEqual(mmkv.getAllKeys().sort(), ["chat_convs_v2__hB"], JSON.stringify([mmkv.getAllKeys(), [...MOCK.asStore.keys()]]));
  await settle(30);
  assert.ok(MOCK.beacons.some(b => /kv_store (migrate_aborted|abandon clearall_migrating)/.test(b)), MOCK.beacons.join('|'));
});

test('falha de escrita no SQLite → sessão abandona o KV (AsyncStorage íntegro), próximo boot remigra', async () => {
  seed();
  globalThis.__chatyy_kv_sqlite = true;
  let mmkv = await migrateAndReopen();
  MOCK.sqliteWriteFail = true;
  mmkv.setString('theme', 'during-failure');
  mmkv.flushStorageWrites();
  MOCK.sqliteWriteFail = false;
  assert.strictEqual(mmkv.getStorageBackend(), 'async');
  const r0 = kvRows();
  assert.ok(!r0 || !r0.has('__kv_migrated_v1'), 'sem marcador (ou .db apagado se nem o DELETE passou)');
  mmkv.setString('theme', 'after-failure');
  await settle();
  assert.strictEqual(MOCK.asStore.get('mmkv_theme'), 'after-failure');
  ({ mmkv } = freshLaunch());
  assert.strictEqual(mmkv.getStorageBackend(), 'async+migrating');
  await mmkv.waitForCacheReady();
  assert.strictEqual(mmkv.getString('theme'), 'after-failure');
  await settle(150);
  ({ mmkv } = freshLaunch());
  assert.strictEqual(mmkv.getString('theme'), 'after-failure');
  await settle(30);
  assert.ok(MOCK.beacons.some(b => /^kv_store abandon write_failed/.test(b)), MOCK.beacons.join('|'));
});

test('corrupção: arquivo lixo → apaga, cai no AsyncStorage sem lançar, recria e migra', async () => {
  seed();
  globalThis.__chatyy_kv_sqlite = true;
  await migrateAndReopen();
  fs.writeFileSync(path.join(MOCK.sqliteDir, 'chatyy_kv.db'), Buffer.alloc(8192, 0x5a));
  for (const suf of ['-wal', '-shm']) { try { fs.rmSync(path.join(MOCK.sqliteDir, 'chatyy_kv.db' + suf)); } catch {} }
  let { mmkv } = freshLaunch();
  await mmkv.waitForCacheReady();
  assert.ok(MOCK.deleted >= 1, 'arquivo apagado');
  assert.strictEqual(mmkv.getString('theme'), 'dark');
  assert.notStrictEqual(mmkv.getStorageBackend(), 'sqlite');
  await settle(150);
  ({ mmkv } = freshLaunch());
  assert.strictEqual(mmkv.getStorageBackend(), 'sqlite');
  assert.strictEqual(mmkv.getString('theme'), 'dark');
  await settle(30);
  assert.ok(MOCK.beacons.some(b => /^kv_store corrupt_reset/.test(b)), MOCK.beacons.join('|'));
});

test('corrupção na leitura do boot (malformed) → apaga .db, boot pelo AsyncStorage com os dados certos', async () => {
  seed();
  globalThis.__chatyy_kv_sqlite = true;
  await migrateAndReopen();
  MOCK.sqliteBootFail = 'database disk image is malformed';
  let { mmkv } = freshLaunch();
  MOCK.sqliteBootFail = null;
  assert.strictEqual(mmkv.getStorageBackend(), 'async');
  await mmkv.waitForCacheReady();
  assert.strictEqual(mmkv.getString('theme'), 'dark');
  assert.strictEqual(MOCK.deleted, 1, "deleted=" + MOCK.deleted + " " + mmkv.getStorageBackend());
  // falha NÃO-corrupção (transitória): só tira o marcador (espelho não é confiável nesta sessão)
  await settle(150); ({ mmkv } = freshLaunch()); assert.strictEqual(mmkv.getStorageBackend(), 'async+migrating', '.db novo remigra');
  await mmkv.waitForCacheReady(); await settle(150);
  ({ mmkv } = freshLaunch()); assert.strictEqual(mmkv.getStorageBackend(), 'sqlite');
  MOCK.sqliteBootFail = 'database is locked';
  ({ mmkv } = freshLaunch());
  MOCK.sqliteBootFail = null;
  assert.strictEqual(mmkv.getStorageBackend(), 'async');
  assert.strictEqual(kvRows().has('__kv_migrated_v1'), false);
  await settle(30);
  assert.ok(MOCK.beacons.some(b => /^kv_store boot_failed corrupt=1/.test(b)), MOCK.beacons.join('|'));
});

test('trava de crash: 3 boots seguidos sem sobreviver 30 s → desliga local; kv_sqlite_reset remoto religa', async () => {
  seed();
  setMeta({ bucket: '1', boot_inflight: '3', guard_v: '2' });
  let { mmkv } = freshLaunch(); await mmkv.waitForCacheReady();
  assert.strictEqual(mmkv.getKvDecision().why, 'crash_guard');
  assert.strictEqual(getMeta().local_off, 'crash:3');
  ({ mmkv } = freshLaunch()); await mmkv.waitForCacheReady();
  assert.strictEqual(mmkv.getKvDecision().why, 'crash_guard', 'persistente');
  mmkv.noteKvRemoteConfig({ kv_sqlite_reset: 7 });
  assert.strictEqual(getMeta().local_off, undefined);
  ({ mmkv } = freshLaunch());
  assert.strictEqual(mmkv.getKvDecision().why, 'cohort');
  // boot que sobrevive limpa o contador
  await mmkv.waitForCacheReady(); await settle(50);
  assert.strictEqual(getMeta().boot_inflight, undefined);
});

test('trava v2: trava v1 (boots em 2º plano) é solta 1× por aparelho; boot em 2º plano não conta', async () => {
  seed();
  setMeta({ bucket: '1', local_off: 'crash:3' });
  let { mmkv } = freshLaunch(); await mmkv.waitForCacheReady();
  assert.strictEqual(mmkv.getKvDecision().why, 'cohort');
  assert.strictEqual(getMeta().guard_v, '2');
  setMeta({ bucket: '1', guard_v: '2' });
  const rn = require(path.join(mockDir, 'react-native.js'));
  rn.AppState.currentState = 'background';
  try {
    for (let i = 0; i < 4; i++) { ({ mmkv } = freshLaunch()); await mmkv.waitForCacheReady(); }
    assert.notStrictEqual(mmkv.getKvDecision().why, 'crash_guard');
    assert.strictEqual(getMeta().boot_inflight, undefined);
  } finally { rn.AppState.currentState = 'active'; }
});

test('dados grandes (Android): 400 conversas + blobs de 1.4 MB migram íntegros; boot SQLite só hidrata o ansioso', async () => {
  MOCK.os = 'android';
  const big = (n, pad) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i, content: 'x'.repeat(pad), sender: 'é✓😀' })));
  MOCK.asStore.set('mmkv_theme', 'dark');
  MOCK.asStore.set('mmkv_chat_convs_v2__hB', big(400, 100));
  let total = 0;
  for (let c = 0; c < 400; c++) { const v = big(c < 8 ? 1900 : 60, c < 8 ? 700 : 300); total += v.length; MOCK.asStore.set('mmkv_chat_msgs_v2__hB_' + c, v); }
  for (let e = 0; e < 150; e++) MOCK.asStore.set('mmkv_omc_msg__hB_INBOX|' + e, JSON.stringify({ html: '<p>' + 'y'.repeat(30000) + '</p>' }));
  globalThis.__chatyy_kv_sqlite = true;
  let { mmkv } = freshLaunch(); await mmkv.waitForCacheReady(); await settle(800);
  assert.ok(kvRows().has('__kv_migrated_v1'), 'migrou');
  const t0 = Date.now();
  ({ mmkv } = freshLaunch());
  const bootMs = Date.now() - t0;
  const st = mmkv.getHydrateStats();
  assert.strictEqual(st.backend, 'sqlite');
  assert.strictEqual(st.bootKeys, 2);
  assert.strictEqual(st.lazyKeys, 550);
  for (const c of [0, 7, 8, 399]) assert.strictEqual(mmkv.getString('chat_msgs_v2__hB_' + c), MOCK.asStore.get('mmkv_chat_msgs_v2__hB_' + c), 'conv ' + c);
  assert.strictEqual(mmkv.getString('omc_msg__hB_INBOX|149'), MOCK.asStore.get('mmkv_omc_msg__hB_INBOX|149'));
  console.log(`      (${(total / 1048576).toFixed(1)} MB em msgs; boot SQLite ${bootMs} ms incl. require)`);
});

test('clearAll com flag off apaga o espelho velho na hora', async () => {
  seed();
  globalThis.__chatyy_kv_sqlite = true;
  await migrateAndReopen();
  globalThis.__chatyy_kv_sqlite = false;
  const realST = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => (ms >= 3000 ? 0 : realST(fn, ms, ...a));
  const { mmkv } = freshLaunch();
  global.setTimeout = realST;
  await mmkv.waitForCacheReady();
  assert.ok(dataRows().length > 0);
  mmkv.clearAll();
  assert.strictEqual(dataRows().length, 0);
});

// ─── 3. native chat cache gate ──────────────────────────────────────────────
test('nativeChatCacheGate: null unless iOS + flag + schema>=2', async () => {
  const load = () => { freshLaunch(); return require(path.join(ROOT, 'services/nativeChatCacheGate.js')); };
  const good = { getSchemaVersionSync: () => 2, saveMessages: async () => {} };
  const old = { saveMessages: async () => {} }; // old binary: no schema fn (FTS triggers)
  MOCK.nativeChatCache = good;
  let g = load();
  assert.strictEqual(g.getNativeChatCache(), null, 'default flag OFF');
  assert.strictEqual(g.isNativeChatCacheBinarySafe(), true);
  globalThis.__chatyy_native_chat_cache = true;
  assert.strictEqual(g.getNativeChatCache(), good);
  MOCK.os = 'android'; g = load();
  assert.strictEqual(g.getNativeChatCache(), null, 'android never');
  MOCK.os = 'ios'; MOCK.nativeChatCache = old; g = load();
  assert.strictEqual(g.getNativeChatCache(), null, 'old binary never');
  MOCK.nativeChatCache = { getSchemaVersionSync: () => 1 }; g = load();
  assert.strictEqual(g.getNativeChatCache(), null, 'schema 1 never');
  MOCK.nativeChatCache = { getSchemaVersionSync: () => { throw new Error('boom'); } }; g = load();
  assert.strictEqual(g.getNativeChatCache(), null, 'throwing binary never');
  MOCK.nativeChatCache = null; g = load();
  assert.strictEqual(g.getNativeChatCache(), null, 'module missing');
});

(async () => {
  let fail = 0;
  for (const t of tests) {
    resetWorld();
    try { await t.fn(); console.log('ok   -', t.name); }
    catch (e) { fail++; console.log("FAIL -", t.name, "\n      ", e && e.stack ? e.stack.split("\n").slice(0, 8).join("\n       ") : e); }
    await settle(20);
  }
  console.log(`\n${tests.length - fail}/${tests.length} passed`);
  process.exit(fail ? 1 : 0);
})();
