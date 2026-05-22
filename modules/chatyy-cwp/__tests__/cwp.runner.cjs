/**
 * Plain-node runner for CWP/1 client tests.
 *
 * The repo doesn't currently ship Jest or ts-node, so this CommonJS file
 * embeds a port of the encoder/decoder (lifted byte-for-byte from
 * ../index.ts) and runs the same scenarios that cwp.test.ts covers.
 *
 * Once Jest lands, delete this file and use cwp.test.ts directly.
 *
 * Run:  node modules/chatyy-cwp/__tests__/cwp.runner.cjs
 * Exit: 0 on all-green, 1 on failures.
 */

'use strict';

// ─── Inline port of the TS module (kept in lockstep with index.ts) ────
const MAGIC = 0xc7;
const VERSION = 0x01;
const HEADER_SIZE = 8;
const MAX_PAYLOAD_BYTES = 1 << 20;

const LENTYPE_MASK_TOP2 = 0xc0;
const LENTYPE_6BIT = 0x00;
const LENTYPE_14BIT = 0x40;
const LENTYPE_32BIT = 0x80;
const LENTYPE_SCALAR = 0xc0;

const SCALAR_U8 = 0xc0;
const SCALAR_U16 = 0xc1;
const SCALAR_U32 = 0xc2;
const SCALAR_U64 = 0xc3;
const SCALAR_BOOL = 0xc4;
const SCALAR_NULL = 0xc5;

const Op = {
  HELLO: 0x01, WELCOME: 0x02, AUTH: 0x03, AUTH_OK: 0x04, AUTH_FAIL: 0x05,
  PING: 0x06, PONG: 0x07, ACK: 0x08, ERROR: 0x09, PRESENCE: 0x10,
  CALL_INVITE: 0x21, CALL_ANSWER: 0x22, CALL_END: 0x23, CALL_RING: 0x24,
  CALL_DECLINE: 0x25, CALL_CANCEL: 0x26, CALL_BUSY: 0x27,
  RELAY_OFFER: 0x31, RELAY_ANSWER: 0x32, ICE_CANDIDATE: 0x33,
  MEDIA_DATA: 0x40, LIVE_COHOST_INVITE: 0x51, LIVE_COHOST_APPROVED: 0x52,
  KICK: 0xf0, GOODBYE: 0xff,
};

const Tag = {
  TOKEN: 0x01, DEVICE_ID: 0x02, CLIENT_BUILD: 0x03, PLATFORM: 0x04,
  CALL_ID: 0x01, CALLER_EMAIL: 0x02, CALLEE_EMAIL: 0x03,
  TARGET_EMAIL: 0x04, ROOM_ID: 0x05, IS_VIDEO: 0x06, TS_MS: 0x07,
  CALLER_NAME: 0x08, REASON: 0x09, CONV_ID: 0x0a, SDP: 0x0b, ICE: 0x0c,
  NONCE: 0x11,
};

const OP_TO_TYPE = {
  [Op.AUTH]: 'auth', [Op.AUTH_OK]: 'auth_success', [Op.AUTH_FAIL]: 'auth_error',
  [Op.PING]: 'ping', [Op.PONG]: 'pong', [Op.ACK]: 'ack', [Op.ERROR]: 'error',
  [Op.PRESENCE]: 'presence_update',
  [Op.CALL_INVITE]: 'call_invite', [Op.CALL_ANSWER]: 'call_accepted',
  [Op.CALL_END]: 'call_end', [Op.CALL_RING]: 'call_ring',
  [Op.CALL_DECLINE]: 'call_declined', [Op.CALL_CANCEL]: 'call_cancel',
  [Op.CALL_BUSY]: 'call_busy',
  [Op.RELAY_OFFER]: 'relay_offer', [Op.RELAY_ANSWER]: 'relay_answer',
  [Op.ICE_CANDIDATE]: 'ice_candidate', [Op.MEDIA_DATA]: 'media_data',
  [Op.LIVE_COHOST_INVITE]: 'live_cohost_invite',
  [Op.LIVE_COHOST_APPROVED]: 'live_cohost_approved',
  [Op.KICK]: 'session_replaced', [Op.GOODBYE]: 'goodbye',
};
const TYPE_TO_OP = (() => {
  const r = {};
  for (const op of Object.keys(OP_TO_TYPE)) r[OP_TO_TYPE[op]] = Number(op);
  r['call_answered'] = Op.CALL_ANSWER;
  return r;
})();

function writeBE32(b, off, v) {
  b[off] = (v >>> 24) & 0xff; b[off + 1] = (v >>> 16) & 0xff;
  b[off + 2] = (v >>> 8) & 0xff; b[off + 3] = v & 0xff;
}
function readBE16(b, off) { return (b[off] << 8) | b[off + 1]; }
function readBE32(b, off) {
  return b[off] * 0x1000000 + ((b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]);
}
function readBE64(b, off) {
  return (BigInt(readBE32(b, off)) << 32n) | BigInt(readBE32(b, off + 4));
}
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

class FrameBuilder {
  constructor(opcode, flags = 0) {
    this.parts = []; this.opcode = opcode; this.flags = flags;
  }
  add(tag, value) {
    const bytes = typeof value === 'string' ? enc.encode(value) : value;
    const n = bytes.length;
    const hdr = new Uint8Array(1 + (n <= 0x3f ? 1 : n <= 0x3fff ? 2 : 5));
    hdr[0] = tag;
    if (n <= 0x3f) {
      hdr[1] = LENTYPE_6BIT | n;
    } else if (n <= 0x3fff) {
      hdr[1] = LENTYPE_14BIT | ((n >> 8) & 0x3f);
      hdr[2] = n & 0xff;
    } else {
      hdr[1] = LENTYPE_32BIT;
      writeBE32(hdr, 2, n);
    }
    this.parts.push(hdr, bytes);
  }
  addU8(tag, v)   { this.parts.push(new Uint8Array([tag, SCALAR_U8, v & 0xff])); }
  addU16(tag, v)  {
    const b = new Uint8Array(4); b[0] = tag; b[1] = SCALAR_U16;
    b[2] = (v >> 8) & 0xff; b[3] = v & 0xff; this.parts.push(b);
  }
  addU32(tag, v)  {
    const b = new Uint8Array(6); b[0] = tag; b[1] = SCALAR_U32;
    writeBE32(b, 2, v >>> 0); this.parts.push(b);
  }
  addU64(tag, v)  {
    const bv = typeof v === 'bigint' ? v : BigInt(v);
    const b = new Uint8Array(10); b[0] = tag; b[1] = SCALAR_U64;
    const hi = Number((bv >> 32n) & 0xffffffffn);
    const lo = Number(bv & 0xffffffffn);
    writeBE32(b, 2, hi); writeBE32(b, 6, lo); this.parts.push(b);
  }
  addBool(tag, v) { this.parts.push(new Uint8Array([tag, SCALAR_BOOL, v ? 1 : 0])); }
  addNull(tag)    { this.parts.push(new Uint8Array([tag, SCALAR_NULL])); }
  finish() {
    let bodyLen = 0; for (const p of this.parts) bodyLen += p.length;
    const out = new Uint8Array(HEADER_SIZE + bodyLen);
    out[0] = MAGIC; out[1] = VERSION; out[2] = this.flags; out[3] = this.opcode;
    writeBE32(out, 4, bodyLen);
    let off = HEADER_SIZE;
    for (const p of this.parts) { out.set(p, off); off += p.length; }
    return out;
  }
}

function decode(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u.length < HEADER_SIZE) return null;
  if (u[0] !== MAGIC) return null;
  const len = readBE32(u, 4);
  if (len > MAX_PAYLOAD_BYTES) return null;
  if (u.length < HEADER_SIZE + len) return null;
  return { version: u[1], flags: u[2], opcode: u[3],
           body: u.subarray(HEADER_SIZE, HEADER_SIZE + len) };
}

function walkTlv(body, cb) {
  let i = 0;
  while (i < body.length) {
    const tag = body[i++];
    if (i >= body.length) return false;
    const lt = body[i];
    const top2 = lt & LENTYPE_MASK_TOP2;
    let t;
    if (top2 === LENTYPE_SCALAR) {
      i++;
      if (lt === SCALAR_U8) {
        if (i + 1 > body.length) return false;
        t = { tag, isScalar: true, scalarKind: lt, scalarNum: body[i], scalarU64: BigInt(body[i]) };
        i += 1;
      } else if (lt === SCALAR_U16) {
        if (i + 2 > body.length) return false;
        const v = readBE16(body, i);
        t = { tag, isScalar: true, scalarKind: lt, scalarNum: v, scalarU64: BigInt(v) };
        i += 2;
      } else if (lt === SCALAR_U32) {
        if (i + 4 > body.length) return false;
        const v = readBE32(body, i);
        t = { tag, isScalar: true, scalarKind: lt, scalarNum: v, scalarU64: BigInt(v) };
        i += 4;
      } else if (lt === SCALAR_U64) {
        if (i + 8 > body.length) return false;
        const v = readBE64(body, i);
        t = { tag, isScalar: true, scalarKind: lt, scalarU64: v,
              scalarNum: v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : undefined };
        i += 8;
      } else if (lt === SCALAR_BOOL) {
        if (i + 1 > body.length) return false;
        t = { tag, isScalar: true, scalarKind: lt, scalarNum: body[i] ? 1 : 0,
              scalarU64: body[i] ? 1n : 0n };
        i += 1;
      } else if (lt === SCALAR_NULL) {
        t = { tag, isScalar: true, scalarKind: lt };
      } else {
        return false;
      }
    } else if (top2 === LENTYPE_6BIT) {
      const len = lt & 0x3f; i++;
      if (i + len > body.length) return false;
      t = { tag, isScalar: false, value: body.subarray(i, i + len) };
      i += len;
    } else if (top2 === LENTYPE_14BIT) {
      if (i + 2 > body.length) return false;
      const len = ((lt & 0x3f) << 8) | body[i + 1];
      i += 2;
      if (i + len > body.length) return false;
      t = { tag, isScalar: false, value: body.subarray(i, i + len) };
      i += len;
    } else {
      if (lt !== LENTYPE_32BIT) return false;
      i++;
      if (i + 4 > body.length) return false;
      const len = readBE32(body, i); i += 4;
      if (len > MAX_PAYLOAD_BYTES) return false;
      if (i + len > body.length) return false;
      t = { tag, isScalar: false, value: body.subarray(i, i + len) };
      i += len;
    }
    if (cb(t) === false) return true;
  }
  return true;
}

function findTag(body, tag) {
  let hit = null;
  walkTlv(body, (t) => { if (t.tag === tag) { hit = t; return false; } });
  return hit;
}

function looksLikeCwp(buf) {
  if (!buf) return false;
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return u.length > 0 && u[0] === MAGIC;
}

function jsonToCwp(j) {
  const type = typeof j.type === 'string' ? j.type : null;
  if (!type) return null;
  const op = TYPE_TO_OP[type];
  if (!op) return null;
  const fb = new FrameBuilder(op);
  const data = (j.data && typeof j.data === 'object') ? j.data : j;
  const put = (tag, k) => {
    const v = data[k];
    if (typeof v === 'string' && v.length > 0) fb.add(tag, v);
  };
  put(Tag.CALL_ID, 'call_id');
  put(Tag.CALLER_EMAIL, 'caller_email');
  put(Tag.CALLEE_EMAIL, 'callee_email');
  put(Tag.TARGET_EMAIL, 'target_email');
  put(Tag.ROOM_ID, 'room_id');
  put(Tag.CALLER_NAME, 'caller_name');
  put(Tag.REASON, 'reason');
  put(Tag.CONV_ID, 'conversation_id');
  put(Tag.SDP, 'sdp');
  put(Tag.ICE, 'ice');
  if (typeof data.video === 'boolean') fb.addBool(Tag.IS_VIDEO, data.video);
  if (typeof data.ts_ms === 'number') fb.addU64(Tag.TS_MS, BigInt(Math.floor(data.ts_ms)));
  return fb.finish();
}

function cwpToJson(buf) {
  const fr = decode(buf);
  if (!fr) return null;
  const type = OP_TO_TYPE[fr.opcode];
  if (!type) return null;
  const out = { type };
  const data = {};
  walkTlv(fr.body, (t) => {
    if (t.isScalar) {
      if (t.tag === Tag.IS_VIDEO) data.video = !!t.scalarNum;
      else if (t.tag === Tag.TS_MS) data.ts_ms = t.scalarNum || Number(t.scalarU64 || 0n);
    } else {
      const s = dec.decode(t.value);
      const m = {
        [Tag.CALL_ID]: 'call_id', [Tag.CALLER_EMAIL]: 'caller_email',
        [Tag.CALLEE_EMAIL]: 'callee_email', [Tag.TARGET_EMAIL]: 'target_email',
        [Tag.ROOM_ID]: 'room_id', [Tag.CALLER_NAME]: 'caller_name',
        [Tag.REASON]: 'reason', [Tag.CONV_ID]: 'conversation_id',
        [Tag.SDP]: 'sdp', [Tag.ICE]: 'ice',
      };
      const k = m[t.tag];
      if (k) data[k] = s;
    }
  });
  out.data = data;
  for (const k of ['call_id','target_email','caller_email','callee_email',
                   'room_id','caller_name','reason','conversation_id']) {
    if (k in data) out[k] = data[k];
  }
  if ('video' in data) out.video = data.video;
  return out;
}

// ─── Test harness ─────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function check(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); console.error('  FAIL ' + msg); }
}
function eq(a, b, msg) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  check(ok, msg + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}

// 1. Header roundtrip
{
  const fb = new FrameBuilder(Op.CALL_INVITE, 0x04);
  fb.add(0x01, 'hello');
  const out = fb.finish();
  check(out[0] === MAGIC, 'magic byte');
  check(out[1] === VERSION, 'version byte');
  check(out[2] === 0x04, 'flags byte');
  check(out[3] === Op.CALL_INVITE, 'opcode byte');
  check(out.length === 15, 'frame length 8+7=15');
  const fr = decode(out);
  check(!!fr, 'decode ok');
  check(fr.opcode === Op.CALL_INVITE, 'decoded opcode');
  const t = findTag(fr.body, 0x01);
  check(!!t, 'tag 0x01 present');
  check(dec.decode(t.value) === 'hello', 'value roundtrip');
}

// 2. lentype variants
{
  // 6-bit
  const fb1 = new FrameBuilder(Op.PING); fb1.add(0x10, 'x'.repeat(63));
  const fr1 = decode(fb1.finish()); check(!!fr1, '6bit decode');
  check(findTag(fr1.body, 0x10).value.length === 63, '6bit len 63');
  // 14-bit
  const fb2 = new FrameBuilder(Op.PING); fb2.add(0x11, 'y'.repeat(500));
  const fr2 = decode(fb2.finish()); check(!!fr2, '14bit decode');
  check(findTag(fr2.body, 0x11).value.length === 500, '14bit len 500');
  // 32-bit
  const fb3 = new FrameBuilder(Op.PING); fb3.add(0x12, 'z'.repeat(20000));
  const fr3 = decode(fb3.finish()); check(!!fr3, '32bit decode');
  check(findTag(fr3.body, 0x12).value.length === 20000, '32bit len 20000');
}

// 3. Typed scalars
{
  const fb = new FrameBuilder(Op.CALL_INVITE);
  fb.addU8(0x01, 0xab);
  fb.addU16(0x02, 0xcafe);
  fb.addU32(0x03, 0xdeadbeef);
  fb.addU64(0x04, 0x0123456789abcdefn);
  fb.addBool(0x05, true);
  fb.addNull(0x06);
  const fr = decode(fb.finish());
  check(findTag(fr.body, 0x01).scalarNum === 0xab, 'u8');
  check(findTag(fr.body, 0x02).scalarNum === 0xcafe, 'u16');
  check(findTag(fr.body, 0x03).scalarNum === 0xdeadbeef, 'u32');
  check(findTag(fr.body, 0x04).scalarU64 === 0x0123456789abcdefn, 'u64');
  check(findTag(fr.body, 0x05).scalarNum === 1, 'bool true');
  check(findTag(fr.body, 0x06).isScalar === true, 'null isScalar');
}

// 4. jsonToCwp + cwpToJson roundtrip
{
  const original = {
    type: 'call_invite',
    data: {
      call_id: 'abc', caller_email: 'alice@chatyy.com.br',
      target_email: 'bob@chatyy.com.br', room_id: 'room_xyz',
      video: true, ts_ms: 1716330000000, caller_name: 'Alice',
    },
  };
  const wire = jsonToCwp(original);
  check(!!wire, 'jsonToCwp non-null');
  check(wire[0] === MAGIC, 'wire magic');
  check(wire[3] === Op.CALL_INVITE, 'wire opcode CALL_INVITE');
  const back = cwpToJson(wire);
  check(back.type === 'call_invite', 'back type');
  eq(back.data.call_id, 'abc', 'data.call_id');
  eq(back.data.caller_email, 'alice@chatyy.com.br', 'data.caller_email');
  eq(back.data.target_email, 'bob@chatyy.com.br', 'data.target_email');
  eq(back.data.video, true, 'data.video');
  eq(back.data.ts_ms, 1716330000000, 'data.ts_ms');
  eq(back.target_email, 'bob@chatyy.com.br', 'top-level target_email mirror');
}

// 5. call_answered alias
{
  const j = { type: 'call_answered', data: { call_id: 'a', target_email: 'x@y' } };
  const wire = jsonToCwp(j);
  check(!!wire, 'alias wire non-null');
  check(wire[3] === Op.CALL_ANSWER, 'alias opcode is CALL_ANSWER');
  const back = cwpToJson(wire);
  check(back.type === 'call_accepted', 'canonical type call_accepted');
}

// 6. Detection + bad frames
{
  check(looksLikeCwp(new Uint8Array([0xc7, 0, 0, 0])) === true, 'looksLikeCwp true');
  check(looksLikeCwp(new Uint8Array([0x7b, 0x7d])) === false, 'looksLikeCwp json false');
  check(looksLikeCwp(new Uint8Array(0)) === false, 'looksLikeCwp empty false');
  check(decode(new Uint8Array(4)) === null, 'short frame -> null');
  check(decode(new Uint8Array([0x7b,0x01,0,0,0,0,0,0])) === null, 'wrong magic -> null');
  check(decode(new Uint8Array([0xc7,0x01,0,0x21,0,0,0,20,0x61,0x62])) === null,
        'truncated body -> null');
}

// 7. opcode map completeness
{
  for (const opStr of Object.keys(OP_TO_TYPE)) {
    const op = Number(opStr);
    const t = OP_TO_TYPE[op];
    check(typeof t === 'string' && t.length > 0, `OP_TO_TYPE[${op}] non-empty`);
    check(TYPE_TO_OP[t] === op, `TYPE_TO_OP[${t}] roundtrip`);
  }
}

// 8. walkTlv early exit
{
  const fb = new FrameBuilder(Op.CALL_INVITE);
  fb.add(0x01, 'a'); fb.add(0x02, 'b'); fb.add(0x03, 'c');
  const fr = decode(fb.finish());
  let n = 0;
  walkTlv(fr.body, (t) => { n++; if (t.tag === 0x02) return false; });
  check(n === 2, 'walkTlv early exit count');
}

// ─── Summary ───────────────────────────────────────────────────────────
console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  console.error('\nfailures:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
process.exit(0);
