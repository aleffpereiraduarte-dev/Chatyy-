/**
 * CWP/1 client-side unit tests.
 *
 * Written to be Jest-compatible (describe/it/expect) AND runnable as a
 * plain Node script via `npx ts-node` since the repo doesn't currently
 * ship a Jest config. See cwp.runner.cjs sibling for the script entry.
 */

import {
  Op,
  Tag,
  MAGIC,
  VERSION,
  FrameBuilder,
  decode,
  findTag,
  walkTlv,
  jsonToCwp,
  cwpToJson,
  buildCallInvite,
  looksLikeCwp,
  decodeString,
  OP_TO_TYPE,
  TYPE_TO_OP,
} from '../index';

// ─── Tiny Jest shim — works under node too ────────────────────────────
type Fn = () => void | Promise<void>;
declare const global: any;

if (typeof global.describe !== 'function') {
  // Plain-node fallback. Tracks pass/fail and exits non-zero on any failure.
  let pass = 0, fail = 0;
  const failures: string[] = [];
  global.describe = (_name: string, body: Fn) => { body(); };
  global.it = (name: string, body: Fn) => {
    try {
      const ret = body();
      if (ret && typeof (ret as any).then === 'function') {
        // We don't have async test support in the fallback; reject async.
        throw new Error('async tests need Jest');
      }
      pass++;
      // eslint-disable-next-line no-console
      console.log(`  ok  ${name}`);
    } catch (e: any) {
      fail++;
      failures.push(`${name}: ${e.message || e}`);
      // eslint-disable-next-line no-console
      console.error(`  FAIL  ${name}: ${e.message || e}`);
    }
  };
  global.expect = (actual: any) => ({
    toBe: (expected: any) => {
      if (!Object.is(actual, expected))
        throw new Error(`expected ${JSON.stringify(actual)} === ${JSON.stringify(expected)}`);
    },
    toEqual: (expected: any) => {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) throw new Error(`expected ${a} == ${b}`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`expected truthy, got ${actual}`); },
    toBeFalsy:  () => { if ( actual) throw new Error(`expected falsy, got ${actual}`); },
    toBeNull:   () => { if (actual !== null) throw new Error(`expected null, got ${actual}`); },
  });
  process.on('beforeExit', () => {
    // eslint-disable-next-line no-console
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) {
      // eslint-disable-next-line no-console
      console.error('failures:\n' + failures.map((f) => '  - ' + f).join('\n'));
      process.exit(1);
    }
  });
}

// ─── Tests ────────────────────────────────────────────────────────────
describe('CWP/1 header', () => {
  it('roundtrips magic/version/flags/opcode/length', () => {
    const fb = new FrameBuilder(Op.CALL_INVITE, 0x04);
    fb.add(0x01, 'hello');
    const out = fb.finish();
    expect(out[0]).toBe(MAGIC);
    expect(out[1]).toBe(VERSION);
    expect(out[2]).toBe(0x04);
    expect(out[3]).toBe(Op.CALL_INVITE);
    // Length = 7 (tag + 6bit-lentype + 'hello' = 1 + 1 + 5)
    expect(out[4]).toBe(0);
    expect(out[5]).toBe(0);
    expect(out[6]).toBe(0);
    expect(out[7]).toBe(7);
    expect(out.length).toBe(8 + 7);

    const fr = decode(out);
    expect(fr).toBeTruthy();
    expect(fr!.opcode).toBe(Op.CALL_INVITE);
    expect(fr!.body.length).toBe(7);
    const tlv = findTag(fr!.body, 0x01);
    expect(tlv).toBeTruthy();
    expect(tlv!.isScalar).toBe(false);
    expect(decodeString(tlv!.value!)).toBe('hello');
  });
});

describe('CWP/1 lentype', () => {
  it('encodes/decodes 6-bit (n=63)', () => {
    const fb = new FrameBuilder(Op.PING);
    fb.add(0x10, 'x'.repeat(63));
    const fr = decode(fb.finish());
    expect(fr).toBeTruthy();
    const t = findTag(fr!.body, 0x10);
    expect(t!.value!.length).toBe(63);
  });
  it('encodes/decodes 14-bit (n=500)', () => {
    const fb = new FrameBuilder(Op.PING);
    fb.add(0x11, 'y'.repeat(500));
    const fr = decode(fb.finish());
    expect(fr).toBeTruthy();
    const t = findTag(fr!.body, 0x11);
    expect(t!.value!.length).toBe(500);
  });
  it('encodes/decodes 32-bit (n=20000)', () => {
    const fb = new FrameBuilder(Op.PING);
    fb.add(0x12, 'z'.repeat(20000));
    const fr = decode(fb.finish());
    expect(fr).toBeTruthy();
    const t = findTag(fr!.body, 0x12);
    expect(t!.value!.length).toBe(20000);
  });
});

describe('CWP/1 typed scalars', () => {
  it('u8/u16/u32/u64/bool/null roundtrip', () => {
    const fb = new FrameBuilder(Op.CALL_INVITE);
    fb.addU8(0x01, 0xab);
    fb.addU16(0x02, 0xcafe);
    fb.addU32(0x03, 0xdeadbeef);
    fb.addU64(0x04, 0x0123456789abcdefn);
    fb.addBool(0x05, true);
    fb.addNull(0x06);

    const fr = decode(fb.finish())!;
    expect(findTag(fr.body, 0x01)!.scalarNum).toBe(0xab);
    expect(findTag(fr.body, 0x02)!.scalarNum).toBe(0xcafe);
    expect(findTag(fr.body, 0x03)!.scalarNum).toBe(0xdeadbeef);
    expect(findTag(fr.body, 0x04)!.scalarU64).toBe(0x0123456789abcdefn);
    expect(findTag(fr.body, 0x05)!.scalarNum).toBe(1);
    expect(findTag(fr.body, 0x06)!.isScalar).toBe(true);
  });
});

describe('CWP/1 high-level', () => {
  it('jsonToCwp + cwpToJson roundtrip for CALL_INVITE', () => {
    const original = {
      type: 'call_invite',
      data: {
        call_id: 'abc',
        caller_email: 'alice@chatyy.com.br',
        target_email: 'bob@chatyy.com.br',
        room_id: 'room_xyz',
        video: true,
        ts_ms: 1716330000000,
        caller_name: 'Alice',
      },
    };
    const wire = jsonToCwp(original)!;
    expect(wire).toBeTruthy();
    expect(wire[0]).toBe(MAGIC);
    expect(wire[3]).toBe(Op.CALL_INVITE);

    const back = cwpToJson(wire)!;
    expect(back.type).toBe('call_invite');
    const d: any = back.data;
    expect(d.call_id).toBe('abc');
    expect(d.caller_email).toBe('alice@chatyy.com.br');
    expect(d.target_email).toBe('bob@chatyy.com.br');
    expect(d.video).toBe(true);
    expect(d.ts_ms).toBe(1716330000000);
    // top-level mirror
    expect(back.target_email).toBe('bob@chatyy.com.br');
  });

  it('call_answered (Android) -> call_accepted (canonical)', () => {
    const j = { type: 'call_answered', data: { call_id: 'a', target_email: 'x@y' } };
    const wire = jsonToCwp(j)!;
    expect(wire[3]).toBe(Op.CALL_ANSWER);
    const back = cwpToJson(wire)!;
    expect(back.type).toBe('call_accepted');
  });

  it('buildCallInvite is a header + 4 fields', () => {
    const buf = buildCallInvite({
      callId: 'call1',
      callerEmail: 'a@b',
      targetEmail: 'c@d',
      roomId: 'r1',
      isVideo: false,
      tsMs: 1000,
    });
    const fr = decode(buf)!;
    expect(fr.opcode).toBe(Op.CALL_INVITE);
    expect(findTag(fr.body, Tag.CALL_ID)!.value).toBeTruthy();
    expect(decodeString(findTag(fr.body, Tag.CALL_ID)!.value!)).toBe('call1');
  });
});

describe('CWP/1 detection + bad frames', () => {
  it('looksLikeCwp', () => {
    expect(looksLikeCwp(new Uint8Array([0xc7, 0, 0, 0]))).toBe(true);
    expect(looksLikeCwp(new Uint8Array([0x7b, 0x7d]))).toBe(false);
    expect(looksLikeCwp(new Uint8Array(0))).toBe(false);
  });
  it('rejects too-short and wrong-magic frames', () => {
    expect(decode(new Uint8Array(4))).toBeNull();
    const bad = new Uint8Array([0x7b, 0x01, 0, 0, 0, 0, 0, 0]);
    expect(decode(bad)).toBeNull();
    // Truncated body (declared 20, only 2)
    const trunc = new Uint8Array([0xc7, 0x01, 0, 0x21, 0, 0, 0, 20, 0x61, 0x62]);
    expect(decode(trunc)).toBeNull();
  });
});

describe('CWP/1 opcode map completeness', () => {
  it('every opcode has a string + reverse mapping', () => {
    for (const opStr of Object.keys(OP_TO_TYPE)) {
      const op = Number(opStr);
      const t = OP_TO_TYPE[op];
      expect(typeof t).toBe('string');
      expect(t.length > 0).toBe(true);
      expect(TYPE_TO_OP[t]).toBe(op);
    }
  });
});

describe('CWP/1 walkTlv', () => {
  it('stops early when cb returns false', () => {
    const fb = new FrameBuilder(Op.CALL_INVITE);
    fb.add(0x01, 'a');
    fb.add(0x02, 'b');
    fb.add(0x03, 'c');
    const fr = decode(fb.finish())!;
    let count = 0;
    walkTlv(fr.body, (t) => {
      count++;
      if (t.tag === 0x02) return false;
    });
    expect(count).toBe(2);
  });
});
