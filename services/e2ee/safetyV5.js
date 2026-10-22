// [e2ee5 QA 2026-10-22] Ponte da tela "Código de segurança" (components/e2ee/SafetyNumberScreen.js)
// para conversas E2EE v5 (e2ee_mode=1). Só leitura do e2ee5.js/crypto: descobre o uid e2ee5 do outro
// participante (direct) e adapta o retorno do núcleo (qrPayload camelCase → qr_payload da tela).
// v4 (SafetyNumberSheet) continua para conversas legadas.

function _e5() { return require('./e2ee5'); }
function _C() { return require('../crypto'); }

/** uid e2ee5 do outro participante de uma conversa direct (ou null). */
export async function peerUidFor(convId) {
  const e5 = _e5();
  if (!e5.isOn() || convId == null || convId === '') return null;
  let me = e5.myUidSync();
  let st = e5.convStateSync(convId);
  if (!me || !st || !Array.isArray(st.members) || st.members.length < 2) {
    const p = await e5.prepareConversation(convId).catch(() => null);
    if (p) { st = p; me = me || (p.uid ? String(p.uid) : ''); }
  }
  const members = (st && Array.isArray(st.members)) ? st.members.map(String) : [];
  if (!me) me = e5.myUidSync();
  const others = members.filter((u) => u && u !== String(me || ''));
  return others.length === 1 ? others[0] : null;
}

/** Props prontas para o SafetyNumberScreen: { load, onVerifyScanned, onMarkVerified }. */
export function screenProps(convId) {
  let uidP = null;
  const uid = () => { if (!uidP) uidP = peerUidFor(convId).then((u) => { if (!u) uidP = null; return u; }); return uidP; };
  return {
    load: async () => {
      const u = await uid();
      if (!u) return null;
      const C = _C();
      const [sn, id] = await Promise.all([C.safetyNumber(u), C.identityStatus(u).catch(() => null)]);
      if (!sn) return null;
      return { digits: sn.digits, qr_payload: sn.qr_payload || sn.qrPayload || '', verified: !!(id && id.verified) };
    },
    onVerifyScanned: async (txt) => {
      const u = await uid();
      if (!u) return false;
      return !!(await _C().verifySafetyQr(u, txt));
    },
    onMarkVerified: async () => {
      const u = await uid();
      if (!u) throw new Error('no_peer');
      await _C().markVerified(u);
    },
  };
}
