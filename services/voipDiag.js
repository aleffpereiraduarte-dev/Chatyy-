// VoIP cold-start diagnostic. Fire-and-forget POST to backend at each
// critical step so we can trace the call accept flow on iPhone without
// needing a Mac + Console.app to read native os_log. Drops silently if
// the network is dead — the goal is to see the LAST step that succeeded,
// which already isolates the failure point.
import { Platform } from 'react-native';
import { BASE_URL } from './api';

const ENDPOINT = (BASE_URL || 'https://api.chatyy.com.br') + '/api/voip_diag.php';
let _userEmail = '';

export function setVoipDiagUser(email) {
  _userEmail = String(email || '');
}

// [2026-10-18 calls-data] Lado da ligação em TODO evento (server só grava
// event/call/user/detail → o papel vai dentro do detail). Desliga via OTA:
// globalThis.__chatyy_call_res = { diag_identity: false } (ou enabled:false).
const _roles = new Map(); // callId → 'caller' | 'callee'
export function setVoipDiagRole(callId, role) {
  try {
    const c = String(callId || '');
    if (!c || (role !== 'caller' && role !== 'callee')) return;
    _roles.set(c, role);
    if (_roles.size > 32) _roles.delete(_roles.keys().next().value);
  } catch {}
}
function _diagIdentityOn() {
  try {
    const f = globalThis.__chatyy_call_res;
    if (f && typeof f === 'object' && (f.enabled === false || f.diag_identity === false)) return false;
  } catch {}
  return true;
}
function _roleFor(event, callId) {
  const c = String(callId || '');
  const m = c.match(/call_[A-Za-z0-9_]+/);
  const k = m ? m[0] : c;
  if (k && _roles.has(k)) return _roles.get(k);
  const e = String(event || '').toLowerCase();
  if (/outgoing|caller_|invite_sent|start_call|native_only/.test(e)) return 'caller';
  if (/incoming|invite_recei|ws_call_invite|answer|accept|decline|callkit|callkeep|push|ring|listener|navigate|poll|token|show_call|phantom/.test(e)) return 'callee';
  return 'unknown';
}
function _withRole(detail, role) {
  if (detail == null) return { role };
  if (typeof detail === 'object' && !Array.isArray(detail)) return { ...detail, role };
  return `${typeof detail === 'string' ? detail : JSON.stringify(detail)} role=${role}`;
}

export function voipDiag(event, callId, detail) {
  if (Platform.OS === 'web') return;
  try {
    const idOn = _diagIdentityOn();
    const role = idOn ? _roleFor(event, callId) : '';
    let user = _userEmail;
    if (!user && idOn) { try { user = String(globalThis.__chatyyMyEmail || ''); } catch {} }
    const body = JSON.stringify({
      event: String(event || ''),
      call_id: String(callId || ''),
      user,
      detail: idOn ? _withRole(detail, role) : (detail ?? null),
      role,
      ts: Date.now(),
      platform: Platform.OS,
    });
    const send = () => {
      try {
        fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          // Tight timeout so a stuck request never blocks the call flow
        }).catch(() => {});
      } catch {}
    };
    // [perf 2026-10-17 boot-fanout] eventos SEM chamada (listener_mounted, registro
    // de token…) no boot esperam o bootIdle (~25 s); com call_id = ligação real →
    // na hora (o fluxo de atender a frio precisa do rastro imediato).
    if (!callId) {
      try {
        const bi = require('./bootIdle');
        if (bi.inBootWindow()) { bi.runWhenBootIdle(send); return; }
      } catch {}
    }
    send();
  } catch {}
}

export default voipDiag;
