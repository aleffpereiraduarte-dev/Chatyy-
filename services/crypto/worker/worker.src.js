/* eslint-disable no-restricted-globals */
// [e2ee5 WP-04] Lógica do Web Worker do núcleo chatyy-crypto (wasm).
//
// Este arquivo NÃO é importado pelo bundler: o build (vendor/chatyy-crypto-wasm/build.sh)
// concatena "glue do wasm-bindgen (--target no-modules)" + este arquivo e grava o resultado
// como string em workerBundle.generated.js. O cliente (client.web.js) cria o worker a partir
// de um Blob, então este código roda com a origem da página, sem imports.
//
// Regras (CONTRATO §0):
// - Nenhuma primitiva de cripto aqui. O que o host web faz com WebCrypto é só:
//   (1) gerar a chave HMAC NÃO-exportável do store e (2) derivar dela a senha do store
//   IndexedDB (CONTRATO §6.10: "senha derivada de chave WebCrypto não-exportável — WP-04");
//   (3) SHA-256 do .wasm para conferir integridade antes de instanciar (equivalente a SRI).
// - Nunca logar conteúdo, chave, senha do store, bearer, QR ou chave de recuperação.
//   Nenhum console.* neste arquivo.
// - Web Locks: toda operação que toca o store roda sob o lock exclusivo
//   `chatyy-e2ee5-core-<uid>`; assim, com várias abas abertas, só uma processa to-device /
//   cifra por vez. O núcleo ainda tem a trava própria (CrossProcessLock no IndexedDB, holder
//   = "web-<id da aba>") e recarrega a OlmMachine quando outra aba escreveu.
(function () {
  'use strict';
  var W = self;
  // `let wasm_bindgen` do glue no-modules (concatenado antes) não vira propriedade de self.
  var wb = typeof wasm_bindgen !== "undefined" ? wasm_bindgen : W.wasm_bindgen;
  var STORE_PREFIX = 'chatyy-e2ee5-';
  var META_DB = 'chatyy-e2ee5-meta';
  var META_STORE = 'kv';
  var PASS_INFO = 'chatyy-e2ee5-store-v1';
  var TIMEOUT_MS = 15000;

  var ready = null; // Promise do init do wasm
  var core = null; // WasmCore
  var coreUid = '';
  var poisoned = false; // wasm abortou (panic/trap): o cliente recria o worker
  var holder = randId();
  var auth = { base: '', bearer: '', mode: 'fetch' };
  var links = {}; // link_id -> WasmLinkWeb
  var pendingT = {}; // transporte via página (modo "main", só testes)
  var tseq = 0;

  function randId() {
    var a = new Uint8Array(6);
    W.crypto.getRandomValues(a);
    var s = '';
    for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
    return s;
  }

  function E(code, extra) {
    var e = { code: code };
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }

  // Erro do wasm = string JSON {"code":...}; trap/panic = RuntimeError.
  function normErr(e) {
    if (e && typeof e === 'object' && typeof e.code === 'string' && !(e instanceof Error)) return e;
    if (typeof e === 'string') {
      try {
        var j = JSON.parse(e);
        if (j && typeof j.code === 'string') return j;
      } catch (_) {}
      return E('internal', { msg: 'string_error' });
    }
    if (e && (e instanceof WebAssembly.RuntimeError || /unreachable|RuntimeError/.test(String(e && e.name)))) {
      poisoned = true;
      return E('wasm_trap');
    }
    return E('internal', { msg: (e && e.name) || 'error' });
  }

  function J(s) {
    return typeof s === 'string' ? JSON.parse(s) : s;
  }

  // ---------------------------------------------------------------- integridade + init
  function hex(buf) {
    var b = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return s;
  }

  function init(a) {
    if (ready) return ready;
    ready = (async function () {
      if (!wb) throw E('unsupported', { what: 'glue' });
      var res = await fetch(a.wasmUrl, { credentials: 'same-origin' });
      if (!res.ok) throw E('wasm_fetch', { status: res.status });
      var bytes = await res.arrayBuffer();
      var got = hex(await W.crypto.subtle.digest('SHA-256', bytes));
      if (!a.wasmSha256 || got !== String(a.wasmSha256).toLowerCase()) throw E('wasm_integrity');
      await wb({ module_or_path: bytes });
      return { coreVersion: wb.coreVersion(), bytes: bytes.byteLength };
    })();
    ready.catch(function () {
      ready = null;
    });
    return ready;
  }

  // ---------------------------------------------------------------- IndexedDB (meta)
  function idbReq(r) {
    return new Promise(function (ok, ko) {
      r.onsuccess = function () {
        ok(r.result);
      };
      r.onerror = function () {
        ko(E('store', { msg: 'idb_' + ((r.error && r.error.name) || 'error') }));
      };
    });
  }

  function metaDb() {
    return new Promise(function (ok, ko) {
      var r;
      try {
        r = W.indexedDB.open(META_DB, 1);
      } catch (e) {
        return ko(E('unsupported', { what: 'indexeddb' }));
      }
      r.onupgradeneeded = function () {
        if (!r.result.objectStoreNames.contains(META_STORE)) r.result.createObjectStore(META_STORE);
      };
      r.onsuccess = function () {
        ok(r.result);
      };
      r.onerror = function () {
        ko(E('unsupported', { what: 'indexeddb', msg: (r.error && r.error.name) || '' }));
      };
      r.onblocked = function () {
        ko(E('store', { msg: 'idb_blocked' }));
      };
    });
  }

  async function metaGet(k) {
    var db = await metaDb();
    try {
      return await idbReq(db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(k));
    } finally {
      db.close();
    }
  }

  async function metaPut(k, v) {
    var db = await metaDb();
    try {
      var tx = db.transaction(META_STORE, 'readwrite');
      tx.objectStore(META_STORE).put(v, k);
      await new Promise(function (ok, ko) {
        tx.oncomplete = ok;
        tx.onerror = tx.onabort = function () {
          ko(E('store', { msg: 'idb_write' }));
        };
      });
    } finally {
      db.close();
    }
  }

  async function metaDel(k) {
    var db = await metaDb();
    try {
      var tx = db.transaction(META_STORE, 'readwrite');
      tx.objectStore(META_STORE).delete(k);
      await new Promise(function (ok) {
        tx.oncomplete = tx.onerror = tx.onabort = ok;
      });
    } finally {
      db.close();
    }
  }

  function deleteDb(name) {
    return new Promise(function (ok) {
      try {
        var r = W.indexedDB.deleteDatabase(name);
        r.onsuccess = r.onerror = r.onblocked = function () {
          ok();
        };
      } catch (_) {
        ok();
      }
    });
  }

  async function storeDbNames(uid) {
    var pre = STORE_PREFIX + uid;
    var out = [];
    if (W.indexedDB.databases) {
      try {
        var all = await W.indexedDB.databases();
        for (var i = 0; i < all.length; i++) {
          var n = all[i] && all[i].name;
          if (n && n !== META_DB && (n === pre || n.indexOf(pre + ':') === 0 || n.indexOf(pre + '::') === 0)) out.push(n);
        }
      } catch (_) {}
    }
    // matrix-sdk-indexeddb usa "<nome>::matrix-sdk-crypto" (+ "-meta"); garante os conhecidos.
    [pre, pre + '::matrix-sdk-crypto', pre + '::matrix-sdk-crypto-meta'].forEach(function (n) {
      if (out.indexOf(n) < 0) out.push(n);
    });
    return out;
  }

  // ---------------------------------------------------------------- Web Locks
  function withLock(name, fn) {
    var L = W.navigator && W.navigator.locks;
    if (!L || !L.request) return fn();
    return L.request(name, { mode: 'exclusive' }, function () {
      return fn();
    });
  }

  function coreLock(fn) {
    return withLock(STORE_PREFIX + 'core-' + coreUid, fn);
  }

  // ---------------------------------------------------------------- senha do store
  function b64(buf) {
    var b = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return W.btoa(s);
  }

  async function storePassphrase(key, uid, deviceId) {
    var msg = new TextEncoder().encode(PASS_INFO + '|' + uid + '|' + deviceId);
    return b64(await W.crypto.subtle.sign('HMAC', key, msg));
  }

  // Aparelho deste navegador para o uid: {deviceId, key(CryptoKey HMAC não-exportável)}.
  // Ausente/corrompido ⇒ aparelho NOVO (CONTRATO §1.3: "limpar dados = aparelho novo").
  async function deviceFor(uid, prefix) {
    return withLock(STORE_PREFIX + 'meta-' + uid, async function () {
      var rec = await metaGet('dev:' + uid);
      if (rec && rec.deviceId && rec.key && rec.key.type === 'secret' && rec.key.extractable === false) {
        return { deviceId: rec.deviceId, key: rec.key, created: false };
      }
      // Sem registro válido: apaga qualquer store órfão deste uid e cria aparelho novo.
      var names = await storeDbNames(uid);
      for (var i = 0; i < names.length; i++) await deleteDb(names[i]);
      var key = await W.crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
      var deviceId = wb.newDeviceId(prefix === 'X' ? 'X' : 'W');
      await metaPut('dev:' + uid, { deviceId: deviceId, key: key, createdAt: Date.now(), v: 1 });
      return { deviceId: deviceId, key: key, created: true };
    });
  }

  // ---------------------------------------------------------------- transporte (CONTRATO §6.2)
  function transportFn(getDevice) {
    return function (action, body) {
      if (auth.mode === 'main') {
        var tid = ++tseq;
        return new Promise(function (ok, ko) {
          pendingT[tid] = { ok: ok, ko: ko };
          W.postMessage({ t: 'transport', tid: tid, action: action, body: body, device: getDevice() });
        });
      }
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () {
        ctl.abort();
      }, TIMEOUT_MS) : null;
      var headers = { 'Content-Type': 'application/json' };
      if (auth.bearer) headers.Authorization = 'Bearer ' + auth.bearer;
      var dev = getDevice();
      if (dev) headers['X-E2EE-Device'] = dev;
      var url = auth.base.replace(/\/+$/, '') + '/api/email.php?action=e2ee5_' + encodeURIComponent(action);
      return fetch(url, { method: 'POST', headers: headers, body: body, credentials: 'same-origin', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
        .then(function (r) {
          return r.text().then(function (t) {
            return { status: r.status, body: t };
          });
        })
        .catch(function () {
          throw 'network';
        })
        .finally(function () {
          if (timer) clearTimeout(timer);
        });
    };
  }

  function needCore() {
    if (poisoned) throw E('wasm_trap');
    if (!core) throw E('not_open');
    return core;
  }

  // Chamada no núcleo sob lock; resultado JSON (string) → objeto.
  function call(fn) {
    var c = needCore();
    return coreLock(function () {
      return Promise.resolve(fn(c)).then(J);
    });
  }

  function S(v) {
    return v == null ? '' : String(v);
  }
  function A(v) {
    return JSON.stringify((v || []).map(String));
  }

  // ---------------------------------------------------------------- operações
  var OPS = {
    init: function (a) {
      return init(a);
    },
    probe: async function () {
      var r = { worker: true, wasm: typeof WebAssembly === 'object', subtle: !!(W.crypto && W.crypto.subtle), locks: !!(W.navigator && W.navigator.locks), indexedDB: false };
      try {
        var db = await metaDb();
        db.close();
        r.indexedDB = true;
      } catch (_) {}
      return r;
    },
    setAuth: function (a) {
      if (a.base != null) auth.base = S(a.base);
      if (a.bearer != null) auth.bearer = S(a.bearer);
      if (a.mode === 'main' || a.mode === 'fetch') auth.mode = a.mode;
      return {};
    },
    // Abre o store deste navegador para o uid. Sem rede.
    open: async function (a) {
      await needReady();
      var uid = S(a.uid);
      if (!/^[1-9][0-9]{0,17}$/.test(uid)) throw E('invalid_input', { field: 'uid' });
      if (core && coreUid === uid) return { uid: uid, deviceId: core.deviceId(), created: false };
      if (core) closeCore();
      coreUid = uid;
      var d = await deviceFor(uid, a.prefix);
      var pass = await storePassphrase(d.key, uid, d.deviceId);
      var devId = d.deviceId;
      core = await coreLock(function () {
        return wb.openCore(STORE_PREFIX + uid, pass, uid, devId, holder, transportFn(function () {
          return devId;
        }));
      });
      pass = null;
      return { uid: uid, deviceId: devId, created: d.created };
    },
    close: function () {
      closeCore();
      return {};
    },
    // Logout / "limpar": apaga o store e o registro do aparelho (próximo open = aparelho novo).
    wipe: async function (a) {
      var uid = S(a.uid || coreUid);
      if (!uid) return { deleted: 0 };
      if (coreUid === uid) closeCore();
      return withLock(STORE_PREFIX + 'core-' + uid, async function () {
        var names = await storeDbNames(uid);
        for (var i = 0; i < names.length; i++) await deleteDb(names[i]);
        await metaDel('dev:' + uid);
        return { deleted: names.length };
      });
    },
    status: async function () {
      var r = await transportFn(function () {
        return core ? core.deviceId() : '';
      })('status', '{}');
      var j;
      try {
        j = JSON.parse(r.body);
      } catch (_) {
        throw E('server', { status: r.status, server_code: 'bad_response' });
      }
      if (!j || !j.success) throw E('server', { status: r.status, server_code: (j && j.data && j.data.code) || 'error' });
      return j.data;
    },
    coreVersion: async function () {
      await needReady();
      return wb.coreVersion();
    },
    newDeviceId: async function (a) {
      await needReady();
      return wb.newDeviceId(S(a.prefix));
    },
    envelopeVersion: async function (a) {
      await needReady();
      var v = wb.envelopeVersion(S(a.content));
      return v < 0 ? null : v;
    },
    encryptBytes: async function (a) {
      await needReady();
      var r = wb.encryptBytes(a.data);
      return { data: r[0], infoJson: r[1], __transfer: [r[0].buffer] };
    },
    decryptBytes: async function (a) {
      await needReady();
      var out = wb.decryptBytes(a.data, S(a.infoJson));
      return { data: out, __transfer: [out.buffer] };
    },
    safetyNumberFor: async function (a) {
      await needReady();
      return J(wb.safetyNumberFor(S(a.uidA), a.mskA, S(a.uidB), a.mskB));
    },
    thisDevice: function () {
      return call(function (c) {
        return c.thisDevice();
      });
    },
    sync: function () {
      return call(function (c) {
        return c.sync();
      });
    },
    syncWith: function (a) {
      return call(function (c) {
        return c.syncWith(typeof a.syncData === 'string' ? a.syncData : JSON.stringify(a.syncData));
      });
    },
    trackUsers: function (a) {
      return call(function (c) {
        return c.trackUsers(A(a.uids));
      });
    },
    encrypt: function (a) {
      return call(function (c) {
        return c.encrypt(S(a.convId), A(a.memberUids), typeof a.payload === 'string' ? a.payload : JSON.stringify(a.payload));
      });
    },
    decrypt: function (a) {
      return call(function (c) {
        return c.decrypt(JSON.stringify({ convId: S(a.convId), envelopeJson: S(a.envelopeJson), senderUid: S(a.senderUid), serverMid: S(a.serverMid), cmid: S(a.cmid), tsMs: Number(a.tsMs) || 0 }));
      });
    },
    sendToDevice: function (a) {
      return call(function (c) {
        return c.sendToDevice(S(a.eventType), JSON.stringify(a.targets || []), typeof a.content === 'string' ? a.content : JSON.stringify(a.content || {}));
      });
    },
    rotateConversation: function (a) {
      return call(function (c) {
        return c.rotateConversation(S(a.convId));
      });
    },
    // [e2ee5 1.7 keyreq] núcleo antigo (wasm sem os métodos) → 'unsupported' (o e2ee5.js ignora)
    requestRoomKey: function (a) {
      return call(function (c) {
        if (typeof c.requestRoomKey !== 'function') throw E('unsupported', { what: 'requestRoomKey' });
        return c.requestRoomKey(S(a.convId), S(a.sessionId), S(a.senderUid), S(a.serverMid));
      });
    },
    shareRoomKey: function (a) {
      return call(function (c) {
        if (typeof c.shareRoomKey !== 'function') throw E('unsupported', { what: 'shareRoomKey' });
        return c.shareRoomKey(S(a.convId), S(a.sessionId), S(a.targetUid), A(a.targetDevices));
      });
    },
    onMembersChanged: function (a) {
      return call(function (c) {
        return c.onMembersChanged(S(a.convId), A(a.memberUids), A(a.removedUids));
      });
    },
    forgetDevice: function (a) {
      return call(function (c) {
        return c.forgetDevice(S(a.deviceId));
      });
    },
    listDevices: function (a) {
      return call(function (c) {
        return c.listDevices(S(a.uid));
      });
    },
    bootstrapIdentity: function () {
      return call(function (c) {
        return c.bootstrapIdentity();
      });
    },
    signDevice: function (a) {
      return call(function (c) {
        return c.signDevice(S(a.deviceId), S(a.expectedEd25519));
      });
    },
    identityStatus: function (a) {
      return call(function (c) {
        return c.identityStatus(S(a.uid));
      });
    },
    pinIdentity: function (a) {
      return call(function (c) {
        return c.pinIdentity(S(a.uid));
      });
    },
    safetyNumber: function (a) {
      return call(function (c) {
        return c.safetyNumber(S(a.uid));
      });
    },
    verifySafetyQr: function (a) {
      return call(function (c) {
        return c.verifySafetyQr(S(a.uid), S(a.scanned));
      });
    },
    markVerified: function (a) {
      return call(function (c) {
        return c.markVerified(S(a.uid));
      });
    },
    exportRoomKeys: function (a) {
      var c = needCore();
      return coreLock(function () {
        return c.exportRoomKeys(JSON.stringify({ convIds: (a.filter && a.filter.convIds) || [], sinceMs: (a.filter && a.filter.sinceMs) || 0 }));
      }).then(function (u8) {
        return { data: u8, __transfer: [u8.buffer] };
      });
    },
    importRoomKeys: function (a) {
      return call(function (c) {
        return c.importRoomKeys(a.data);
      });
    },
    exportRoomKeysWithPassphrase: function (a) {
      var c = needCore();
      return coreLock(function () {
        return c.exportRoomKeysWithPassphrase(S(a.passphrase));
      });
    },
    importRoomKeysWithPassphrase: function (a) {
      return call(function (c) {
        return c.importRoomKeysWithPassphrase(S(a.data), S(a.passphrase));
      });
    },
    backupEnable: function (a) {
      return call(function (c) {
        return c.backupEnable(S(a.passphrase));
      });
    },
    backupStep: function (a) {
      return call(function (c) {
        return c.backupStep(Number(a.maxBatches) || 1);
      });
    },
    backupStatus: function () {
      return call(function (c) {
        return c.backupStatus();
      });
    },
    backupDisable: function () {
      return call(function (c) {
        return c.backupDisable();
      });
    },
    backupRestore: function (a) {
      return call(function (c) {
        return c.backupRestore(S(a.keyOrPassphrase));
      });
    },
    metricsSnapshot: function () {
      return J(needCore().metricsSnapshot());
    },
    flushMetrics: function () {
      return call(function (c) {
        return c.flushMetrics();
      });
    },
    // ----- vínculo por QR, lado web (F4, flag e2ee5_link) -----
    linkBegin: async function () {
      await needReady();
      var l = await wb.linkWebBegin(transportFn(function () {
        return core ? core.deviceId() : '';
      }));
      var id = l.linkId();
      links[id] = l;
      return { linkId: id, qrPayload: l.qrPayload() };
    },
    linkPoll: async function (a) {
      var l = links[S(a.linkId)];
      if (!l) throw E('link', { msg: 'unknown_link' });
      var st = J(core ? await coreLock(function () {
        return core.linkPoll(l);
      }) : await l.pollNoCore());
      if (st.state === 'granted' && st.bearer) auth.bearer = st.bearer; // instala no transporte
      return st;
    },
    linkSendDevice: function (a) {
      var l = links[S(a.linkId)];
      if (!l) throw E('link', { msg: 'unknown_link' });
      return call(function (c) {
        return c.linkSendDevice(l);
      });
    },
    linkCompleteUpload: function (a) {
      var l = links[S(a.linkId)];
      if (!l) throw E('link', { msg: 'unknown_link' });
      return call(function (c) {
        return c.linkCompleteUpload(l);
      });
    },
    linkCancel: function (a) {
      var id = S(a.linkId);
      var l = links[id];
      if (l) {
        try {
          l.free();
        } catch (_) {}
        delete links[id];
      }
      return {};
    },
  };

  function needReady() {
    if (!ready) throw E('not_ready');
    return ready;
  }

  function closeCore() {
    if (core) {
      try {
        core.free();
      } catch (_) {}
    }
    core = null;
    coreUid = '';
  }

  W.onmessage = function (ev) {
    var m = ev.data || {};
    if (m.t === 'transport_reply') {
      var p = pendingT[m.tid];
      if (p) {
        delete pendingT[m.tid];
        if (m.ok) p.ok({ status: m.status, body: m.body });
        else p.ko('network');
      }
      return;
    }
    var id = m.id;
    var fn = OPS[m.op];
    Promise.resolve()
      .then(function () {
        if (!fn) throw E('unknown_op');
        if (poisoned && m.op !== 'probe') throw E('wasm_trap');
        return fn(m.args || {});
      })
      .then(
        function (r) {
          var tr = [];
          if (r && typeof r === 'object' && r.__transfer) {
            tr = r.__transfer;
            delete r.__transfer;
          }
          W.postMessage({ t: 'reply', id: id, ok: true, r: r === undefined ? null : r }, tr);
        },
        function (e) {
          W.postMessage({ t: 'reply', id: id, ok: false, e: normErr(e) });
        }
      );
  };
  W.postMessage({ t: 'boot' });
})();
