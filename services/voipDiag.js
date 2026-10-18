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

export function voipDiag(event, callId, detail) {
  if (Platform.OS === 'web') return;
  try {
    const body = JSON.stringify({
      event: String(event || ''),
      call_id: String(callId || ''),
      user: _userEmail,
      detail: detail ?? null,
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
