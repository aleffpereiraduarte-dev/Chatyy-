// [quic-proto 2026-10-23] Apoio JS do fio QUIC+Noise (protótipo ESCURO) — sem efeito para quem
// não liga o interruptor escondido (Ajuda > Sobre > 7 toques na versão, só contas da allowlist).
//
//   - flag LOCAL do aparelho: iOS quicSetLocal/quicStatus, Android quicProtoSet/quicProtoInfo
//     (módulo nativo ChatyyTransport). Vale na próxima conexão física (kick no socket).
//   - registro da chave Noise do aparelho (PROTOCOLO §4.5): email.php?action=noise_device_register
//     {device_id, noise_pub, sig}, sig = Ed25519 do aparelho E2EE v5 sobre
//     "chatyy-noise-reg/1" 0x00 email_canônico 0x00 device_id 0x00 noise_pub(32 bytes crus).
//     1x por (conta, aparelho, chave) — memorizado no mmkv. Precisa de services/crypto exportar
//     signDeviceBytes(msgB64) → sigB64 (assinatura com a ed25519 do aparelho E2EE). Sem ela =
//     não registra (o leaf aceita como bound:"bearer"; o motivo fica em lastReg()).
//
// Logs/diag: só códigos. Nunca chave privada, assinatura, bearer ou e-mail.
import { Platform } from 'react-native';

const REG_KEY = 'quic_noise_reg_v1';
const CTX = 'chatyy-noise-reg/1';
let _lastReg = { state: 'idle', why: '' };
let _regBusy = null;

function _mod() {
  try {
    if (Platform.OS === 'web') return null;
    const { requireOptionalNativeModule } = require('expo');
    return requireOptionalNativeModule('ChatyyTransport') || null;
  } catch { return null; }
}

/** 'ios' | 'android' | null — o binário tem o fio QUIC? */
export function quicKind() {
  const m = _mod();
  if (!m) return null;
  try { if (typeof m.quicVersion === 'function' && m.quicVersion() >= 1 && typeof m.quicSetLocal === 'function') return 'ios'; } catch {}
  if (typeof m.quicProtoSet === 'function' && typeof m.quicProtoInfo === 'function') return 'android';
  return null;
}

/** Status cru do nativo (sem segredo). */
export function nativeStatus() {
  const m = _mod();
  const k = quicKind();
  try {
    if (k === 'ios') return m.quicStatus() || {};
    if (k === 'android') return m.quicProtoInfo() || {};
  } catch {}
  return {};
}

export function isLocalOn() {
  const s = nativeStatus();
  return quicKind() === 'ios' ? s.local === true : s.enabled === true;
}

/** Chave PÚBLICA Noise do aparelho (base64 padrão, 32 B) ou ''. */
export function devicePub() {
  const s = nativeStatus();
  const v = quicKind() === 'ios' ? s.devicePub : s.clientPub;
  return typeof v === 'string' ? v : '';
}

/** Fio físico atual do transporte nativo ('quic' | 'wss' | '?'). */
export function currentWire() {
  try {
    const st = require('./nativeTransport').getNativeTransportStats();
    const n = (st && st.native) || {};
    return String(n.wire || n.quicWire || (n.quic ? 'quic' : '') || 'wss');
  } catch { return '?'; }
}

export function setLocal(on, email) {
  const m = _mod();
  const k = quicKind();
  if (!k) return false;
  try {
    if (k === 'ios') m.quicSetLocal(!!on);
    else m.quicProtoSet(!!on);
  } catch { return false; }
  // Próxima conexão física já respeita a flag: reconecta agora (sem logout).
  try { const ws = require('./websocket').default?.ws; if (ws && ws.__native) ws.kick('quic_toggle', true); } catch {}
  if (on) { try { maybeRegisterNoiseKey(email, 'toggle'); } catch {} }
  return true;
}

export function lastReg() { return { ..._lastReg }; }

function _canon(e) {
  return String(e || '').trim().toLowerCase().replace(/@onemundo\.com\.br$/, '@chatyy.com.br');
}

function _utf8(s) {
  const out = [];
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** Bytes assinados (§4.5). Exportada p/ teste. */
export function regMessage(canonEmail, deviceId, pub32) {
  const parts = [..._utf8(CTX), 0, ..._utf8(canonEmail), 0, ..._utf8(deviceId), 0];
  const out = new Uint8Array(parts.length + pub32.length);
  out.set(parts, 0);
  out.set(pub32, parts.length);
  return out;
}

function _fp(s) {
  try { return require('./clientLb').fnv1a(s); } catch { return String(s).length.toString(16); }
}

/**
 * Registra a chave Noise do aparelho 1x por (conta, aparelho E2EE, chave). Só com o QUIC ligado
 * neste aparelho e a conta na allowlist. Nunca lança; resultado em lastReg().
 */
export function maybeRegisterNoiseKey(email, why = 'auto') {
  if (_regBusy) return _regBusy;
  _regBusy = (async () => {
    try {
      // [quic-noise §9.3] flag local OU o servidor ligou a conta (auto)
      let em0 = email; if (!em0) { try { em0 = require('./websocket').default?.email || ''; } catch {} }
      if (!quicKind() || !(isLocalOn() || require('./clientLb').quicAutoFor(em0))) { _lastReg = { state: 'skip', why: 'off' }; return _lastReg; }
      const api = require('./api');
      let em = email;
      if (!em) { try { em = require('./websocket').default?.email || ''; } catch {} }
      const canon = _canon(em || '');
      if (!canon || !require('./clientLb').quicTransportFor(canon)) { _lastReg = { state: 'skip', why: 'not_allowed' }; return _lastReg; }
      const pubB64 = devicePub();
      const C = require('./crypto');
      const pub = pubB64 && C._b64ToU8 ? C._b64ToU8(pubB64) : null;
      if (!pub || pub.length !== 32) { _lastReg = { state: 'skip', why: 'no_noise_pub' }; return _lastReg; }
      let dev = '';
      try { dev = require('./e2ee/e2ee5').deviceIdSync() || ''; } catch {}
      if (!dev) { _lastReg = { state: 'skip', why: 'no_e2ee_device' }; return _lastReg; }
      const fp = _fp(canon + '|' + dev + '|' + pubB64);
      let mm = null;
      try { mm = require('./mmkv'); } catch {}
      try { if (mm && mm.getString(REG_KEY) === fp) { _lastReg = { state: 'done', why: 'cached' }; return _lastReg; } } catch {}
      if (typeof C.signDeviceBytes !== 'function') { _lastReg = { state: 'blocked', why: 'no_sign_api' }; return _lastReg; }
      let sig = '';
      try { sig = await C.signDeviceBytes(C._u8ToB64(regMessage(canon, dev, pub))); } catch (e) {
        _lastReg = { state: 'error', why: 'sign_' + String((e && e.code) || 'fail').slice(0, 24) }; return _lastReg;
      }
      if (typeof sig !== 'string' || !sig) { _lastReg = { state: 'error', why: 'sign_empty' }; return _lastReg; }
      const r = await api.apiCall('noise_device_register', { device_id: dev, noise_pub: pubB64, sig }, 'POST');
      const d = (r && r.data) || {};
      if (r && r.success && d.registered !== false) {
        try { mm && mm.setString(REG_KEY, fp); } catch {}
        _lastReg = { state: 'done', why: d.already ? 'already' : (d.rotated ? 'rotated' : 'registered') };
      } else {
        _lastReg = { state: 'error', why: String(d.code || (r && r.status) || 'http').slice(0, 32) };
      }
      try { require('./nativeTelemetry').nativeBeacon('quic', 'noise_reg', 'why=' + why + ' st=' + _lastReg.state + ' r=' + _lastReg.why); } catch {}
      return _lastReg;
    } catch (e) {
      _lastReg = { state: 'error', why: 'exc' };
      return _lastReg;
    } finally {
      setTimeout(() => { _regBusy = null; }, 0);
    }
  })();
  return _regBusy;
}

export default { quicKind, nativeStatus, isLocalOn, devicePub, currentWire, setLocal, lastReg, maybeRegisterNoiseKey, regMessage };
