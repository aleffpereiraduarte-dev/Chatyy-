/**
 * chatyy-cwp - Chatyy Wire Protocol v1 (CWP/1) encoder + decoder for JS/TS.
 *
 * Mirrors the C++ impl in /opt/chatyy-ws-cpp/src/cwp.h. See
 * /root/webmail-app/docs/whatsapp-migration/03-signaling-protocol.md for the
 * full design.
 *
 * Goals:
 *   - Pure Uint8Array (no Buffer dep, so it works in React Native and the web).
 *   - Zero external deps.
 *   - Symmetric with the C++ encoder so a frame produced here decodes byte-
 *     identically on the server and vice versa.
 *
 * Frame: [MAGIC=0xC7][VER=0x01][FLAGS][OPCODE][LEN u32 BE][TLV body]
 * TLV  : [TAG u8][LENTYPE varies][VALUE]
 *   LENTYPE top 2 bits:
 *     0b00xxxxxx           - 6-bit inline length
 *     0b01xxxxxx xxxxxxxx  - 14-bit length
 *     0b10000000 + u32 BE  - 32-bit length
 *     0b11ttttttt          - typed scalar (u8/u16/u32/u64/bool/null)
 */

export const MAGIC = 0xc7;
export const VERSION = 0x01;
export const HEADER_SIZE = 8;
export const MAX_PAYLOAD_BYTES = 1 << 20; // 1 MiB

export const FLAG_COMPRESSED = 0x01;
export const FLAG_ENCRYPTED = 0x02;
export const FLAG_REQ_ACK = 0x04;
export const FLAG_FRAGMENT = 0x08;

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

// ─── Opcode catalog (keep in sync with cwp.h) ─────────────────────────
export const Op = {
  HELLO: 0x01,
  WELCOME: 0x02,
  AUTH: 0x03,
  AUTH_OK: 0x04,
  AUTH_FAIL: 0x05,
  PING: 0x06,
  PONG: 0x07,
  ACK: 0x08,
  ERROR: 0x09,
  PRESENCE: 0x10,
  CALL_INVITE: 0x21,
  CALL_ANSWER: 0x22,
  CALL_END: 0x23,
  CALL_RING: 0x24,
  CALL_DECLINE: 0x25,
  CALL_CANCEL: 0x26,
  CALL_BUSY: 0x27,
  RELAY_OFFER: 0x31,
  RELAY_ANSWER: 0x32,
  ICE_CANDIDATE: 0x33,
  MEDIA_DATA: 0x40,
  LIVE_COHOST_INVITE: 0x51,
  LIVE_COHOST_APPROVED: 0x52,
  KICK: 0xf0,
  GOODBYE: 0xff,
} as const;
export type Opcode = (typeof Op)[keyof typeof Op];

// Tag conventions (per-opcode namespace, matches cwp_dispatch.h).
export const Tag = {
  // Auth
  TOKEN: 0x01,
  DEVICE_ID: 0x02,
  CLIENT_BUILD: 0x03,
  PLATFORM: 0x04,
  // Call signaling (overlap with auth, OK because tag namespace is per-opcode)
  CALL_ID: 0x01,
  CALLER_EMAIL: 0x02,
  CALLEE_EMAIL: 0x03,
  TARGET_EMAIL: 0x04,
  ROOM_ID: 0x05,
  IS_VIDEO: 0x06,
  TS_MS: 0x07,
  CALLER_NAME: 0x08,
  REASON: 0x09,
  CONV_ID: 0x0a,
  SDP: 0x0b,
  ICE: 0x0c,
  // Common
  CHANNEL: 0x10,
  NONCE: 0x11,
  STATUS: 0x12,
  EMAIL: 0x13,
  ERR_CODE: 0x20,
  ERR_MESSAGE: 0x21,
} as const;

// opcode -> legacy JSON "type" string mapping (must match cwp_dispatch.h)
export const OP_TO_TYPE: Record<number, string> = {
  [Op.AUTH]: 'auth',
  [Op.AUTH_OK]: 'auth_success',
  [Op.AUTH_FAIL]: 'auth_error',
  [Op.PING]: 'ping',
  [Op.PONG]: 'pong',
  [Op.ACK]: 'ack',
  [Op.ERROR]: 'error',
  [Op.PRESENCE]: 'presence_update',
  [Op.CALL_INVITE]: 'call_invite',
  [Op.CALL_ANSWER]: 'call_accepted',
  [Op.CALL_END]: 'call_end',
  [Op.CALL_RING]: 'call_ring',
  [Op.CALL_DECLINE]: 'call_declined',
  [Op.CALL_CANCEL]: 'call_cancel',
  [Op.CALL_BUSY]: 'call_busy',
  [Op.RELAY_OFFER]: 'relay_offer',
  [Op.RELAY_ANSWER]: 'relay_answer',
  [Op.ICE_CANDIDATE]: 'ice_candidate',
  [Op.MEDIA_DATA]: 'media_data',
  [Op.LIVE_COHOST_INVITE]: 'live_cohost_invite',
  [Op.LIVE_COHOST_APPROVED]: 'live_cohost_approved',
  [Op.KICK]: 'session_replaced',
  [Op.GOODBYE]: 'goodbye',
};

export const TYPE_TO_OP: Record<string, number> = (() => {
  const r: Record<string, number> = {};
  for (const [op, t] of Object.entries(OP_TO_TYPE)) r[t] = Number(op);
  // Android alias - kept here so the server's canonicalisation (CALL_ANSWER
  // -> "call_accepted") is honoured end-to-end.
  r['call_answered'] = Op.CALL_ANSWER;
  return r;
})();

// ─── Decoded structures ───────────────────────────────────────────────
export interface Frame {
  version: number;
  flags: number;
  opcode: number;
  body: Uint8Array;
}

export interface Tlv {
  tag: number;
  isScalar: boolean;
  scalarKind?: number;
  value?: Uint8Array;
  scalarU64?: bigint;
  scalarNum?: number; // best-effort Number cast for u<=53 bits
}

// ─── Low-level helpers ────────────────────────────────────────────────
function writeBE32(buf: Uint8Array, off: number, v: number) {
  buf[off + 0] = (v >>> 24) & 0xff;
  buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>> 8) & 0xff;
  buf[off + 3] = v & 0xff;
}
function readBE16(buf: Uint8Array, off: number) {
  return (buf[off] << 8) | buf[off + 1];
}
function readBE32(buf: Uint8Array, off: number) {
  return (
    buf[off] * 0x1000000 +
    ((buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3])
  );
}
function readBE64(buf: Uint8Array, off: number): bigint {
  const hi = BigInt(readBE32(buf, off));
  const lo = BigInt(readBE32(buf, off + 4));
  return (hi << 32n) | lo;
}

// UTF-8 codec that doesn't rely on Buffer (RN compatibility).
const utf8Encoder: TextEncoder = new TextEncoder();
const utf8Decoder: TextDecoder = new TextDecoder('utf-8');

export function encodeString(s: string): Uint8Array {
  return utf8Encoder.encode(s);
}
export function decodeString(u: Uint8Array): string {
  return utf8Decoder.decode(u);
}

export function looksLikeCwp(buf: Uint8Array | ArrayBuffer): boolean {
  if (!buf) return false;
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return u.length > 0 && u[0] === MAGIC;
}

// ─── Encoder ──────────────────────────────────────────────────────────
export class FrameBuilder {
  private parts: Uint8Array[] = [];
  private opcode: number;
  private flags: number;

  constructor(opcode: number, flags = 0) {
    this.opcode = opcode;
    this.flags = flags;
  }

  add(tag: number, value: string | Uint8Array): void {
    const bytes =
      typeof value === 'string' ? encodeString(value) : value;
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

  addU8(tag: number, v: number): void {
    this.parts.push(new Uint8Array([tag, SCALAR_U8, v & 0xff]));
  }
  addU16(tag: number, v: number): void {
    const buf = new Uint8Array(4);
    buf[0] = tag;
    buf[1] = SCALAR_U16;
    buf[2] = (v >> 8) & 0xff;
    buf[3] = v & 0xff;
    this.parts.push(buf);
  }
  addU32(tag: number, v: number): void {
    const buf = new Uint8Array(6);
    buf[0] = tag;
    buf[1] = SCALAR_U32;
    writeBE32(buf, 2, v >>> 0);
    this.parts.push(buf);
  }
  addU64(tag: number, v: bigint | number): void {
    const bv = typeof v === 'bigint' ? v : BigInt(v);
    const buf = new Uint8Array(10);
    buf[0] = tag;
    buf[1] = SCALAR_U64;
    const hi = Number((bv >> 32n) & 0xffffffffn);
    const lo = Number(bv & 0xffffffffn);
    writeBE32(buf, 2, hi);
    writeBE32(buf, 6, lo);
    this.parts.push(buf);
  }
  addBool(tag: number, v: boolean): void {
    this.parts.push(new Uint8Array([tag, SCALAR_BOOL, v ? 1 : 0]));
  }
  addNull(tag: number): void {
    this.parts.push(new Uint8Array([tag, SCALAR_NULL]));
  }

  finish(): Uint8Array {
    let bodyLen = 0;
    for (const p of this.parts) bodyLen += p.length;
    const out = new Uint8Array(HEADER_SIZE + bodyLen);
    out[0] = MAGIC;
    out[1] = VERSION;
    out[2] = this.flags;
    out[3] = this.opcode;
    writeBE32(out, 4, bodyLen);
    let off = HEADER_SIZE;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

// ─── Decoder ──────────────────────────────────────────────────────────
export function decode(buf: Uint8Array | ArrayBuffer): Frame | null {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u.length < HEADER_SIZE) return null;
  if (u[0] !== MAGIC) return null;
  const len = readBE32(u, 4);
  if (len > MAX_PAYLOAD_BYTES) return null;
  if (u.length < HEADER_SIZE + len) return null;
  return {
    version: u[1],
    flags: u[2],
    opcode: u[3],
    body: u.subarray(HEADER_SIZE, HEADER_SIZE + len),
  };
}

export function walkTlv(
  body: Uint8Array,
  cb: (t: Tlv) => boolean | void,
): boolean {
  let i = 0;
  while (i < body.length) {
    const tag = body[i++];
    if (i >= body.length) return false;
    const lt = body[i];
    const top2 = lt & LENTYPE_MASK_TOP2;

    let t: Tlv;
    if (top2 === LENTYPE_SCALAR) {
      i++;
      switch (lt) {
        case SCALAR_U8: {
          if (i + 1 > body.length) return false;
          t = { tag, isScalar: true, scalarKind: lt, scalarNum: body[i], scalarU64: BigInt(body[i]) };
          i += 1;
          break;
        }
        case SCALAR_U16: {
          if (i + 2 > body.length) return false;
          const v = readBE16(body, i);
          t = { tag, isScalar: true, scalarKind: lt, scalarNum: v, scalarU64: BigInt(v) };
          i += 2;
          break;
        }
        case SCALAR_U32: {
          if (i + 4 > body.length) return false;
          const v = readBE32(body, i);
          t = { tag, isScalar: true, scalarKind: lt, scalarNum: v, scalarU64: BigInt(v) };
          i += 4;
          break;
        }
        case SCALAR_U64: {
          if (i + 8 > body.length) return false;
          const v = readBE64(body, i);
          t = {
            tag,
            isScalar: true,
            scalarKind: lt,
            scalarU64: v,
            scalarNum: v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : undefined,
          };
          i += 8;
          break;
        }
        case SCALAR_BOOL: {
          if (i + 1 > body.length) return false;
          t = { tag, isScalar: true, scalarKind: lt, scalarNum: body[i] ? 1 : 0, scalarU64: body[i] ? 1n : 0n };
          i += 1;
          break;
        }
        case SCALAR_NULL: {
          t = { tag, isScalar: true, scalarKind: lt };
          break;
        }
        default:
          return false;
      }
    } else if (top2 === LENTYPE_6BIT) {
      const len = lt & 0x3f;
      i++;
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
      const len = readBE32(body, i);
      i += 4;
      if (len > MAX_PAYLOAD_BYTES) return false;
      if (i + len > body.length) return false;
      t = { tag, isScalar: false, value: body.subarray(i, i + len) };
      i += len;
    }
    if (cb(t) === false) return true;
  }
  return true;
}

export function parseTlv(body: Uint8Array): Tlv[] | null {
  const out: Tlv[] = [];
  const ok = walkTlv(body, (t) => {
    out.push(t);
  });
  return ok ? out : null;
}

export function findTag(body: Uint8Array, tag: number): Tlv | null {
  let hit: Tlv | null = null;
  walkTlv(body, (t) => {
    if (t.tag === tag) {
      hit = t;
      return false;
    }
  });
  return hit;
}

// ─── High-level helpers: legacy-JSON <-> CWP ──────────────────────────
type AnyData = Record<string, unknown>;

function getStr(d: AnyData, k: string): string | null {
  const v = d[k];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function encodeCallPayload(fb: FrameBuilder, data: AnyData): void {
  const put = (tag: number, k: string) => {
    const v = getStr(data, k);
    if (v != null) fb.add(tag, v);
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
}

function decodeCallPayload(body: Uint8Array): AnyData {
  const data: AnyData = {};
  walkTlv(body, (t) => {
    switch (t.tag) {
      case Tag.CALL_ID:
        if (!t.isScalar && t.value) data.call_id = decodeString(t.value);
        break;
      case Tag.CALLER_EMAIL:
        if (!t.isScalar && t.value) data.caller_email = decodeString(t.value);
        break;
      case Tag.CALLEE_EMAIL:
        if (!t.isScalar && t.value) data.callee_email = decodeString(t.value);
        break;
      case Tag.TARGET_EMAIL:
        if (!t.isScalar && t.value) data.target_email = decodeString(t.value);
        break;
      case Tag.ROOM_ID:
        if (!t.isScalar && t.value) data.room_id = decodeString(t.value);
        break;
      case Tag.CALLER_NAME:
        if (!t.isScalar && t.value) data.caller_name = decodeString(t.value);
        break;
      case Tag.REASON:
        if (!t.isScalar && t.value) data.reason = decodeString(t.value);
        break;
      case Tag.CONV_ID:
        if (!t.isScalar && t.value) data.conversation_id = decodeString(t.value);
        break;
      case Tag.SDP:
        if (!t.isScalar && t.value) data.sdp = decodeString(t.value);
        break;
      case Tag.ICE:
        if (!t.isScalar && t.value) data.ice = decodeString(t.value);
        break;
      case Tag.IS_VIDEO:
        if (t.isScalar) data.video = !!t.scalarNum;
        break;
      case Tag.TS_MS:
        if (t.isScalar) data.ts_ms = t.scalarNum ?? Number(t.scalarU64 ?? 0n);
        break;
      // unknown tags -> MUST_IGNORE
    }
  });
  return data;
}

/**
 * Convert a legacy JSON envelope ({type:'...', data:{...}}) into a CWP
 * binary frame. Returns null when the type has no opcode mapping (caller
 * should fall back to sending as JSON text).
 */
export function jsonToCwp(j: AnyData): Uint8Array | null {
  const type = typeof j.type === 'string' ? (j.type as string) : null;
  if (!type) return null;
  const op = TYPE_TO_OP[type];
  if (!op) return null;
  const fb = new FrameBuilder(op);

  if (op === Op.AUTH) {
    if (typeof j.token === 'string') fb.add(Tag.TOKEN, j.token);
    if (typeof j.device_id === 'string') fb.add(Tag.DEVICE_ID, j.device_id);
    if (typeof j.client_build === 'number') fb.addU32(Tag.CLIENT_BUILD, j.client_build);
    if (typeof j.platform === 'number') fb.addU8(Tag.PLATFORM, j.platform);
    return fb.finish();
  }
  if (op === Op.AUTH_OK || op === Op.AUTH_FAIL || op === Op.ERROR) {
    if (typeof j.message === 'string') fb.add(Tag.ERR_MESSAGE, j.message);
    if (typeof j.code === 'number') fb.addU32(Tag.ERR_CODE, j.code);
    return fb.finish();
  }
  if (op === Op.PING || op === Op.PONG) {
    if (typeof j.nonce === 'number') fb.addU64(Tag.NONCE, BigInt(j.nonce));
    return fb.finish();
  }
  // Call-shaped payloads
  const data = (j.data && typeof j.data === 'object') ? (j.data as AnyData) : j;
  encodeCallPayload(fb, data);
  return fb.finish();
}

/**
 * Convert a CWP binary frame back into a legacy JSON envelope. Returns
 * null when the opcode has no mapping (caller should treat as unknown).
 */
export function cwpToJson(buf: Uint8Array | ArrayBuffer): AnyData | null {
  const fr = decode(buf);
  if (!fr) return null;
  const type = OP_TO_TYPE[fr.opcode];
  if (!type) return null;
  const out: AnyData = { type };

  switch (fr.opcode) {
    case Op.AUTH: {
      const tok = findTag(fr.body, Tag.TOKEN);
      if (tok && !tok.isScalar && tok.value) out.token = decodeString(tok.value);
      const dev = findTag(fr.body, Tag.DEVICE_ID);
      if (dev && !dev.isScalar && dev.value) out.device_id = decodeString(dev.value);
      const cb = findTag(fr.body, Tag.CLIENT_BUILD);
      if (cb && cb.isScalar) out.client_build = cb.scalarNum;
      const pf = findTag(fr.body, Tag.PLATFORM);
      if (pf && pf.isScalar) out.platform = pf.scalarNum;
      return out;
    }
    case Op.PING:
    case Op.PONG: {
      const n = findTag(fr.body, Tag.NONCE);
      if (n && n.isScalar) out.nonce = n.scalarNum ?? Number(n.scalarU64 ?? 0n);
      return out;
    }
    case Op.PRESENCE: {
      const em = findTag(fr.body, Tag.EMAIL);
      const st = findTag(fr.body, Tag.STATUS);
      const data: AnyData = {};
      if (em && !em.isScalar && em.value) data.email = decodeString(em.value);
      if (st && !st.isScalar && st.value) data.status = decodeString(st.value);
      out.data = data;
      return out;
    }
    case Op.CALL_INVITE:
    case Op.CALL_ANSWER:
    case Op.CALL_END:
    case Op.CALL_RING:
    case Op.CALL_DECLINE:
    case Op.CALL_CANCEL:
    case Op.CALL_BUSY:
    case Op.RELAY_OFFER:
    case Op.RELAY_ANSWER:
    case Op.ICE_CANDIDATE: {
      const data = decodeCallPayload(fr.body);
      out.data = data;
      // Mirror to top-level for legacy reducers.
      for (const k of [
        'call_id', 'target_email', 'caller_email', 'callee_email',
        'room_id', 'caller_name', 'reason', 'conversation_id',
      ]) {
        if (k in data) out[k] = data[k];
      }
      if ('video' in data) out.video = data.video;
      return out;
    }
    default:
      return out;
  }
}

/**
 * Convenience: encode a CALL_INVITE in one call. Used by services/callkeep.js.
 */
export function buildCallInvite(args: {
  callId: string;
  callerEmail: string;
  targetEmail: string;
  roomId: string;
  isVideo?: boolean;
  callerName?: string;
  tsMs?: number;
  sdp?: string;
}): Uint8Array {
  const fb = new FrameBuilder(Op.CALL_INVITE);
  fb.add(Tag.CALL_ID, args.callId);
  fb.add(Tag.CALLER_EMAIL, args.callerEmail);
  fb.add(Tag.TARGET_EMAIL, args.targetEmail);
  fb.add(Tag.ROOM_ID, args.roomId);
  fb.addBool(Tag.IS_VIDEO, args.isVideo ?? false);
  fb.addU64(Tag.TS_MS, BigInt(args.tsMs ?? Date.now()));
  if (args.callerName) fb.add(Tag.CALLER_NAME, args.callerName);
  if (args.sdp) fb.add(Tag.SDP, args.sdp);
  return fb.finish();
}
