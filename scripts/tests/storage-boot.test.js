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
const MOCK = { os: 'ios', asStore: new Map(), asHooks: {}, sqliteFail: false, sqliteReadFailKey: null, nativeChatCache: null };
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
    runSync(sql, p) { const r = db.prepare(sql).run(...norm(p)); return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }; },
    getFirstSync(sql, p) {
      if (M().sqliteReadFailKey && norm(p).includes(M().sqliteReadFailKey)) throw new Error('simulated read failure');
      const r = db.prepare(sql).get(...norm(p)); return r ? { ...r } : null;
    },
    getAllSync(sql, p) { return db.prepare(sql).all(...norm(p)).map(r => ({ ...r })); },
    withTransactionSync(fn) { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } },
    closeSync() { try { db.close(); } catch {} },
  };
}
module.exports = {
  openDatabaseSync(name) {
    if (M().sqliteFail) throw new Error('simulated: native module missing');
    return wrap(new DatabaseSync(path.join(M().sqliteDir, name)));
  },
};`);
fs.writeFileSync(path.join(mockDir, 'expo-chat-cache.js'), `
module.exports = { __esModule: true, get default() { return globalThis.__MOCK.nativeChatCache; } };`);
globalThis.__MOCK = MOCK;
MOCK.sqliteDir = path.join(TMP, 'sqlite'); fs.mkdirSync(MOCK.sqliteDir);

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === 'react-native') return path.join(mockDir, 'react-native.js');
  if (req === '@react-native-async-storage/async-storage') return path.join(mockDir, 'async-storage.js');
  if (req === 'expo-sqlite') return path.join(mockDir, 'expo-sqlite.js');
  if (/modules\/expo-chat-cache$/.test(req)) return path.join(mockDir, 'expo-chat-cache.js');
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
}
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
  assert.strictEqual(kvRows(), null);
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
  assert.strictEqual(MOCK.asStore.get('kvsql_migrated_v1'), '1');
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
  assert.strictEqual(kvRows(), null);
  delete globalThis.localStorage;
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
    catch (e) { fail++; console.log('FAIL -', t.name, '\n      ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e); }
    await settle(20);
  }
  console.log(`\n${tests.length - fail}/${tests.length} passed`);
  process.exit(fail ? 1 : 0);
})();
