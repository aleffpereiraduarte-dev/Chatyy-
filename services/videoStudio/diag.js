// [2026-10-23 reels-sumiu] Telemetria do Video Studio (só metadados: etapa, ms, nº de trechos,
// código de erro). Canal = callkit_diag → /var/mail/_native_diag (kind 'vstudio').
// Kill: globalThis.__chatyy_vstudio_diag = false.
let _last = 0;
let _n = 0;
export function vsDiag(step, fields) {
  try {
    if (globalThis.__chatyy_vstudio_diag === false) return; // eslint-disable-line no-undef
    const now = Date.now();
    if (now - _last > 60000) { _last = now; _n = 0; }
    if (++_n > 25) return; // o servidor também limita (30/min por aparelho)
    const parts = [String(step || '?')];
    if (fields && typeof fields === 'object') {
      Object.keys(fields).forEach((k) => {
        const v = fields[k];
        if (v === undefined || v === null || v === '') return;
        parts.push(`${k}=${String(v).replace(/\s+/g, '_').slice(0, 60)}`);
      });
    }
    require('../nativeTelemetry').telemetrySend('vstudio', parts.join(' '));
  } catch {}
}
export default vsDiag;
