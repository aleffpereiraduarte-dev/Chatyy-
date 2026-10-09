/**
 * E2EE v4 — núcleo do protocolo (sem React Native). [2026-10-09]
 *
 * TODA a criptografia vem do vodozemac (matrix-org, Apache-2.0, auditado pela
 * Least Authority em 2022), compilado para wasm em /root/chatyy-e2ee-wasm e
 * vendorizado em vendor/chatyy-e2ee/. Este arquivo NÃO implementa primitivas:
 * só decide quem recebe o quê, guarda o estado (pickles cifrados pelo próprio
 * vodozemac) e monta/abre o envelope JSON.
 *
 *  - 1 conta Olm por aparelho (curve25519 = identidade DH, ed25519 = assinatura)
 *  - sessão Olm (3DH + Double Ratchet) por par de aparelhos
 *  - one-time keys assinadas no servidor + fallback key (último recurso)
 *  - envelope: {"e2e":4,"v":1,"mid","sd","sk","c":{"email|device":{"t","b"}}}
 *    (cada aparelho do destinatário E os meus outros aparelhos ganham uma cópia)
 *  - texto interno: {"v":1,"mid","cid","from","txt","ts"} — amarra a mensagem à
 *    conversa e ao remetente (servidor não consegue "mover" ciphertext)
 *
 * Dependências injetadas: { api(action, body) → json, store (kv async), V (wasm) }.
 */

const MAX_SESSIONS_PER_DEVICE = 5;
const OTK_TARGET = 50;
const OTK_LOW_WATER = 20;
const DIR_TTL_MS = 60 * 1000;
const SEND_DIR_MAX_AGE_MS = 5 * 1000;

export const ERR = {
  UNSUPPORTED: 'e2ee_unsupported',
  NOT_ALLOWED: 'e2ee_not_allowed',
  PEER_NO_KEYS: 'peer_no_keys',
  NOT_FOR_DEVICE: 'not_for_device',
  DECRYPT_FAILED: 'decrypt_failed',
  BAD_ENVELOPE: 'bad_envelope',
};

function e2eErr(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
const norm = (s) => String(s || '').trim().toLowerCase();

function randId(bytes) {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isV4Blob(raw) {
  if (typeof raw !== 'string' || raw.length < 20) return false;
  if (!raw.startsWith('{"e2e":4')) return false;
  return true;
}

export function parseBlob(raw) {
  try {
    const j = JSON.parse(raw);
    if (!j || j.e2e !== 4 || typeof j.c !== 'object' || !j.mid || !j.sd || !j.sk) return null;
    return j;
  } catch { return null; }
}

// Número de segurança estilo Signal (NumericFingerprint v0: 5200 iterações de
// SHA-512, 30 bytes → 6 blocos de 5 dígitos por lado; os dois lados ordenados).
// Só HASH para exibição — usa WebCrypto (SHA-512 padrão), nada caseiro.
async function fingerprintHalf(identifier, keyBytes) {
  const enc = new TextEncoder();
  const id = enc.encode(identifier);
  let buf = new Uint8Array(2 + keyBytes.length + id.length);
  buf.set([0, 0], 0); buf.set(keyBytes, 2); buf.set(id, 2 + keyBytes.length);
  let hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-512', buf));
  for (let i = 0; i < 5200; i++) {
    const n = new Uint8Array(hash.length + keyBytes.length);
    n.set(hash, 0); n.set(keyBytes, hash.length);
    hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-512', n));
  }
  let out = '';
  for (let i = 0; i < 30; i += 5) {
    const chunk = hash[i] * 2 ** 32 + hash[i + 1] * 2 ** 24 + hash[i + 2] * 2 ** 16 + hash[i + 3] * 2 ** 8 + hash[i + 4];
    out += String(chunk % 100000).padStart(5, '0');
  }
  return out;
}

function b64ToBytes(b64) {
  let s = String(b64).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class E2EEv4 {
  constructor({ api, store, V, platform = 'web', label = '' }) {
    this.api = api; this.store = store; this.V = V;
    this.platform = platform; this.label = label;
    this.me = null; this.deviceId = null; this.account = null; this.pickleKey = null;
    this.dir = new Map();        // email → { at, devices: [...] }
    this.plain = new Map();      // mid → texto (espelho em memória do cache cifrado)
    this.registered = false;
    this._chain = Promise.resolve();
  }

  // Serializa TODA operação de estado (ratchet não pode bifurcar). O store pode
  // oferecer um lock entre abas (Web Locks) via store.withLock.
  _locked(fn) {
    const run = () => (this.store.withLock ? this.store.withLock(fn) : fn());
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }

  async init(meEmail) {
    return this._locked(async () => {
      const me = norm(meEmail);
      if (this.me === me && this.account) return;
      this.me = me; this.account = null; this.registered = false;
      this.dir.clear(); this.plain.clear();
      let pk = await this.store.get('picklekey');
      if (!pk) {
        const b = new Uint8Array(32); globalThis.crypto.getRandomValues(b);
        pk = Array.from(b).join(',');
        await this.store.set('picklekey', pk);
      }
      this.pickleKey = new Uint8Array(pk.split(',').map(Number));
      this.deviceId = await this.store.get('device_id');
      const pickled = await this.store.get('account');
      if (pickled && this.deviceId) {
        this.account = this.V.OlmAccount.fromPickle(pickled, this.pickleKey);
        this._acctPickle = pickled;
      } else {
        this.account = new this.V.OlmAccount();
        this.deviceId = 'w' + randId(16);
        this.account.generateFallbackKey();
        await this._saveAccount({ device_id: this.deviceId });
      }
    });
  }

  _sign(msg) { return this.account.sign(msg); }

  // Outra aba/janela da mesma conta pode ter mudado a conta (OTK consumida,
  // OTKs novas). Dentro do lock, sempre parte do pickle salvo mais recente.
  async _reloadAccount() {
    const pickled = await this.store.get('account');
    if (pickled && pickled !== this._acctPickle) {
      const fresh = this.V.OlmAccount.fromPickle(pickled, this.pickleKey);
      try { this.account?.free?.(); } catch {}
      this.account = fresh;
      this._acctPickle = pickled;
    }
  }

  async _saveAccount(extra) {
    const p = this.account.pickle(this.pickleKey);
    await this.store.setMany({ ...(extra || {}), account: p });
    this._acctPickle = p;
  }

  /** Publica aparelho + fallback + OTKs que faltam. Idempotente. */
  async ensureRegistered(force = false) {
    return this._locked(async () => {
      if (this.registered && !force) return true;
      await this._reloadAccount();
      const me = this.me, dev = this.deviceId, acct = this.account;
      const curve = acct.curve25519, ed = acct.ed25519;
      let remaining = 0;
      try {
        const c = await this.api('e2ee_v4_otk_count', { device_id: dev });
        if (c?.data?.allowed === false) throw e2eErr(ERR.NOT_ALLOWED);
        remaining = c?.data?.count || 0;
      } catch (e) { if (e.code === ERR.NOT_ALLOWED) throw e; }
      const otks = [];
      if (remaining < OTK_LOW_WATER) {
        acct.generateOneTimeKeys(OTK_TARGET - remaining);
        const keys = JSON.parse(acct.oneTimeKeys());
        for (const [id, key] of Object.entries(keys)) {
          otks.push({ id, key, sig: this._sign(`chatyy-e2ee-v4:otk:${me}:${dev}:${id}:${key}`) });
        }
      }
      const fbMap = JSON.parse(acct.fallbackKey());
      const [fbId, fbKey] = Object.entries(fbMap)[0] || [];
      const body = {
        device_id: dev, curve25519: curve, ed25519: ed,
        device_sig: this._sign(`chatyy-e2ee-v4:device:${me}:${dev}:${curve}`),
        platform: this.platform, label: this.label, otks,
        ...(fbId ? { fallback: { id: fbId, key: fbKey, sig: this._sign(`chatyy-e2ee-v4:fallback:${me}:${dev}:${fbId}:${fbKey}`) } } : {}),
      };
      const r = await this.api('e2ee_v4_register', body);
      if (!r?.success) {
        const code = r?.data?.code || 'register_failed';
        throw e2eErr(code === 'e2ee_not_allowed' ? ERR.NOT_ALLOWED : code, r?.message);
      }
      // Só marca como publicadas depois do servidor aceitar (senão reenviamos).
      acct.markKeysAsPublished();
      await this._saveAccount();
      this.registered = true;
      return true;
    });
  }

  // ---------- diretório de aparelhos ----------
  async _devicesOf(emails, { fresh = false, maxAge = DIR_TTL_MS } = {}) {
    const want = Array.from(new Set(emails.map(norm))).filter(Boolean);
    const now = Date.now();
    const miss = want.filter((e) => fresh || !this.dir.has(e) || now - this.dir.get(e).at > maxAge);
    if (miss.length) {
      const r = await this.api('e2ee_v4_devices', { emails: miss });
      const users = r?.data?.users || {};
      for (const e of miss) {
        const u = users[e] || { allowed: false, devices: [] };
        const devices = [];
        for (const d of u.devices || []) {
          // Aparelho só vale se a assinatura do próprio aparelho bater.
          if (this.V.ed25519Verify(d.ed25519, `chatyy-e2ee-v4:device:${e}:${d.device_id}:${d.curve25519}`, d.device_sig)) devices.push(d);
        }
        this.dir.set(e, { at: now, allowed: !!u.allowed, devices });
        await this._pinCheck(e, devices);
      }
    }
    const out = {};
    for (const e of want) out[e] = this.dir.get(e);
    return out;
  }

  // TOFU: guarda o conjunto de chaves ed25519 vistas por usuário. Mudança =
  // "código de segurança mudou" (não bloqueia, igual WhatsApp) + zera verificado.
  async _pinCheck(email, devices) {
    const keys = devices.map((d) => d.ed25519).sort();
    const raw = await this.store.get(`pin:${email}`);
    const prev = raw ? JSON.parse(raw) : null;
    const same = prev && prev.keys.length === keys.length && prev.keys.every((k, i) => k === keys[i]);
    if (!prev || !same) {
      const changed = !!prev && prev.keys.length > 0;
      await this.store.set(`pin:${email}`, JSON.stringify({ keys, verified: same ? !!prev?.verified : false, changed_at: changed ? Date.now() : (prev?.changed_at || 0) }));
      if (changed && this.onKeysChanged) { try { this.onKeysChanged(email); } catch {} }
    }
  }

  async setVerified(email, verified) {
    const raw = await this.store.get(`pin:${norm(email)}`);
    const prev = raw ? JSON.parse(raw) : { keys: [] };
    prev.verified = !!verified;
    await this.store.set(`pin:${norm(email)}`, JSON.stringify(prev));
  }

  async pinInfo(email) {
    const raw = await this.store.get(`pin:${norm(email)}`);
    return raw ? JSON.parse(raw) : null;
  }

  async safetyNumber(peerEmail) {
    const peer = norm(peerEmail);
    const d = await this._devicesOf([this.me, peer], { fresh: true });
    const keysOf = (e) => (d[e]?.devices || []).map((x) => x.ed25519).sort();
    const mine = keysOf(this.me), theirs = keysOf(peer);
    if (!mine.length || !theirs.length) return null;
    const cat = (arr) => { const parts = arr.map(b64ToBytes); const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
    const a = await fingerprintHalf(this.me, cat(mine));
    const b = await fingerprintHalf(peer, cat(theirs));
    const digits = a < b ? a + b : b + a;
    const pin = await this.pinInfo(peer);
    return { digits, groups: digits.match(/.{5}/g), myDevices: mine.length, peerDevices: theirs.length, verified: !!pin?.verified, changedAt: pin?.changed_at || 0 };
  }

  // ---------- sessões ----------
  async _loadSessions(email, dev) {
    const raw = await this.store.get(`sess:${email}|${dev}`);
    return raw ? JSON.parse(raw) : []; // [{p: pickle, at}]
  }
  async _saveSessions(email, dev, list) {
    list.sort((a, b) => b.at - a.at);
    await this.store.set(`sess:${email}|${dev}`, JSON.stringify(list.slice(0, MAX_SESSIONS_PER_DEVICE)));
  }

  async _claim(targets) {
    if (!targets.length) return {};
    const r = await this.api('e2ee_v4_claim', { targets });
    if (!r?.success) throw e2eErr(r?.data?.code || 'claim_failed', r?.message);
    return r.data?.keys || {};
  }

  /** Cifra texto para a conversa 1:1. Retorna a string do envelope. */
  async encryptText(convId, peerEmail, text) {
    await this.ensureRegistered();
    return this._locked(async () => {
      await this._reloadAccount();
      const me = this.me, peer = norm(peerEmail);
      // Envio: lista de aparelhos quase fresca (aparelho novo do contato ou meu
      // precisa entrar já na próxima mensagem).
      let dir = await this._devicesOf([peer, me], { maxAge: SEND_DIR_MAX_AGE_MS });
      if (!dir[peer]?.devices?.length) dir = await this._devicesOf([peer], { fresh: true });
      const peerDevs = dir[peer]?.devices || [];
      if (!peerDevs.length) throw e2eErr(ERR.PEER_NO_KEYS);
      const targets = [
        ...peerDevs.map((d) => ({ email: peer, d })),
        ...((dir[me]?.devices) || []).filter((d) => d.device_id !== this.deviceId).map((d) => ({ email: me, d })),
      ];
      const mid = randId(12);
      const inner = JSON.stringify({ v: 1, mid, cid: String(convId), from: me, txt: String(text), ts: Date.now() });
      // Quem ainda não tem sessão → pede uma one-time key (ou a fallback).
      const sessions = {};
      const need = [];
      for (const t of targets) {
        const list = await this._loadSessions(t.email, t.d.device_id);
        sessions[`${t.email}|${t.d.device_id}`] = list;
        if (!list.length) need.push({ email: t.email, device_id: t.d.device_id });
      }
      const claimed = await this._claim(need);
      const c = {};
      for (const t of targets) {
        const key = `${t.email}|${t.d.device_id}`;
        const list = sessions[key];
        let sess = null;
        if (list.length) {
          sess = this.V.OlmSession.fromPickle(list[0].p, this.pickleKey);
        } else {
          const k = claimed[key];
          if (!k) continue; // aparelho sem chave disponível agora — pula
          const kind = k.kind === 'fallback' ? 'fallback' : 'otk';
          if (!this.V.ed25519Verify(t.d.ed25519, `chatyy-e2ee-v4:${kind}:${t.email}:${t.d.device_id}:${k.id}:${k.key}`, k.sig)) continue;
          sess = this.account.createOutboundSession(t.d.curve25519, k.key);
          list.unshift({ p: null, at: 0 });
        }
        c[key] = JSON.parse(sess.encrypt(inner));
        list[0] = { p: sess.pickle(this.pickleKey), at: Date.now() };
        await this._saveSessions(t.email, t.d.device_id, list);
        try { sess.free?.(); } catch {}
      }
      if (!Object.keys(c).some((k) => k.startsWith(peer + '|'))) throw e2eErr(ERR.PEER_NO_KEYS);
      const blob = JSON.stringify({ e2e: 4, v: 1, mid, sd: this.deviceId, sk: this.account.curve25519, c });
      await this._rememberPlain(mid, String(text));
      return blob;
    });
  }

  async _rememberPlain(mid, text) {
    this.plain.set(mid, text);
    await this.store.setSecret(`pt:${mid}`, text);
  }

  peekPlaintext(raw) {
    const j = typeof raw === 'string' ? parseBlob(raw) : raw;
    return j ? (this.plain.get(j.mid) ?? null) : null;
  }

  /**
   * Abre um envelope. ctx = { convId, senderEmail } (do registro do servidor).
   * Retorna { ok:true, text } | { ok:false, code }.
   */
  async decryptBlob(raw, ctx = {}) {
    const j = parseBlob(raw);
    if (!j) return { ok: false, code: ERR.BAD_ENVELOPE };
    if (this.plain.has(j.mid)) return { ok: true, text: this.plain.get(j.mid) };
    const cached = await this.store.getSecret(`pt:${j.mid}`);
    if (cached != null) { this.plain.set(j.mid, cached); return { ok: true, text: cached }; }
    return this._locked(async () => {
      if (this.plain.has(j.mid)) return { ok: true, text: this.plain.get(j.mid) };
      const again = await this.store.getSecret(`pt:${j.mid}`);
      if (again != null) { this.plain.set(j.mid, again); return { ok: true, text: again }; }
      await this._reloadAccount();
      const me = this.me;
      const mine = j.c[`${me}|${this.deviceId}`];
      if (!mine) return { ok: false, code: ERR.NOT_FOR_DEVICE };
      const sender = norm(ctx.senderEmail || '');
      // Remetente: o aparelho (sd) precisa existir no diretório com a mesma
      // curve25519 (sk) e assinatura válida.
      const candidates = sender ? [sender] : (Array.isArray(ctx.candidates) ? ctx.candidates.map(norm).filter(Boolean) : []);
      let senderEmail = null, senderDev = null;
      for (const pass of [false, true]) {
        const d = await this._devicesOf(candidates.length ? candidates : [me], { fresh: pass });
        for (const [em, u] of Object.entries(d)) {
          const hit = (u?.devices || []).find((x) => x.device_id === j.sd && x.curve25519 === j.sk);
          if (hit) { senderEmail = em; senderDev = hit; break; }
        }
        if (senderDev) break;
      }
      if (!senderDev) return { ok: false, code: ERR.DECRYPT_FAILED, why: 'unknown_sender_device' };
      const list = await this._loadSessions(senderEmail, j.sd);
      let plaintext = null, used = -1, newSess = null;
      // 1) sessões existentes (inclui pré-chave repetida da mesma sessão)
      const preSid = mine.t === 0 ? this.V.preKeySessionId(0, mine.b) : '';
      for (let i = 0; i < list.length && plaintext == null; i++) {
        const s = this.V.OlmSession.fromPickle(list[i].p, this.pickleKey);
        if (mine.t === 0 && s.sessionId !== preSid) { try { s.free?.(); } catch {} continue; }
        try { plaintext = s.decrypt(mine.t, mine.b); used = i; list[i] = { p: s.pickle(this.pickleKey), at: Date.now() }; } catch {}
        try { s.free?.(); } catch {}
      }
      // 2) pré-chave nova → sessão de entrada (consome a OTK na conta)
      if (plaintext == null && mine.t === 0) {
        try {
          const r = this.account.createInboundSession(j.sk, 0, mine.b);
          plaintext = r.plaintext;
          newSess = r.takeSession();
        } catch (e) {
          return { ok: false, code: ERR.DECRYPT_FAILED, why: String(e?.message || e).slice(0, 80) };
        }
      }
      if (plaintext == null) return { ok: false, code: ERR.DECRYPT_FAILED, why: 'no_session' };
      let inner;
      try { inner = JSON.parse(plaintext); } catch { if (newSess) this._acctPickle = null; return { ok: false, code: ERR.BAD_ENVELOPE }; }
      if (!inner || inner.mid !== j.mid || norm(inner.from) !== senderEmail
        || (ctx.convId != null && String(inner.cid) !== String(ctx.convId))) {
        if (newSess) { try { newSess.free?.(); } catch {} this._acctPickle = null; } // descarta OTK consumida só em memória
        return { ok: false, code: ERR.BAD_ENVELOPE, why: 'binding_mismatch' };
      }
      if (newSess) {
        list.unshift({ p: newSess.pickle(this.pickleKey), at: Date.now() });
        try { newSess.free?.(); } catch {}
      }
      // Ordem segura contra queda no meio: sessão → texto → conta. Se cair antes
      // de salvar a conta, a OTK só sobra (a pré-chave repetida casa pela sessão).
      await this._saveSessions(senderEmail, j.sd, list);
      const text = typeof inner.txt === 'string' ? inner.txt : '';
      await this._rememberPlain(j.mid, text);
      if (newSess) await this._saveAccount();
      if (newSess) this._maybeTopUp();
      return { ok: true, text, used };
    });
  }

  _maybeTopUp() {
    // Fora do lock atual; ensureRegistered(true) reabastece OTKs se baixou.
    setTimeout(() => { this.ensureRegistered(true).catch(() => {}); }, 2000);
  }
}
