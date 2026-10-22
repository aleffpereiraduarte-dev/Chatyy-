// [e2ee5 WP-10c 2026-10-22] Métricas do push E2EE com o app FECHADO → e2ee5_metrics.
// A NSE (iOS, App Group) e o serviço FCM (Android, SharedPreferences) contam por código o que
// aconteceu com cada push e2e=5 (ok / ok_after_sync / utd_* / skip_<motivo> / tempos). Ninguém
// subia isso. Aqui: no boot (depois da 1ª pintura) e ao voltar ao 1º plano (no máx. 1x/10 min) o
// app LÊ E ZERA (expo-callkit e2ee5PushMetricsTake, BUILD do WP-10c) e manda
// {platform, counters:{nse_<código>: n, nse_ms_le500…}}. Só códigos e contagens, nunca conteúdo.
// Binário sem a função nativa = no-op. Kill: globalThis.__chatyy_e2ee5_push_metrics = false.
import { AppState, Platform } from 'react-native';

const MIN_GAP_MS = 10 * 60 * 1000;
const ORIGIN = 'https://chatyy.com.br';
let _lastAt = 0;
let _pending = null; // counters que falharam no envio (tenta de novo na próxima)
let _installed = false;

function _key(code) {
  const k = String(code || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return k ? 'nse_' + k : '';
}

function _bucket(ms) {
  const v = Number(ms) || 0;
  if (v <= 500) return 'nse_ms_le500';
  if (v <= 1000) return 'nse_ms_le1000';
  if (v <= 2000) return 'nse_ms_le2000';
  if (v <= 4500) return 'nse_ms_le4500';
  return 'nse_ms_gt4500';
}

function _take() {
  try {
    const m = require('../../modules/expo-callkit');
    return typeof m.e2ee5PushMetricsTake === 'function' ? m.e2ee5PushMetricsTake() : null;
  } catch { return null; }
}

function _bearer() {
  try { const a = require('../api'); return String((a.getAuthToken && a.getAuthToken()) || (a.getToken && a.getToken()) || ''); } catch { return ''; }
}

export async function flushPushMetrics(force = false) {
  try {
    if (Platform.OS === 'web' || globalThis.__chatyy_e2ee5_push_metrics === false) return;
    if (!force && Date.now() - _lastAt < MIN_GAP_MS) return;
    const bearer = _bearer();
    if (!bearer) return;
    _lastAt = Date.now();
    const counters = _pending || {};
    _pending = null;
    const t = _take();
    if (t) {
      for (const [code, n] of Object.entries(t.counts || {})) {
        const k = _key(code); const v = Math.floor(Number(n) || 0);
        if (k && v > 0) counters[k] = (counters[k] || 0) + v;
      }
      for (const ms of t.ms || []) { const b = _bucket(ms); counters[b] = (counters[b] || 0) + 1; }
    }
    const keys = Object.keys(counters);
    if (!keys.length) return;
    // o servidor aceita até 32 chaves nse_* por envio; o resto fica para a próxima
    const send = {}; const rest = {};
    keys.forEach((k, i) => { if (i < 32) send[k] = counters[k]; else rest[k] = counters[k]; });
    let ok = false;
    try {
      const r = await fetch(ORIGIN + '/api/email.php?action=e2ee5_metrics', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: Platform.OS, counters: send }),
      });
      ok = !!r && r.ok;
    } catch { ok = false; }
    const left = ok ? rest : counters;
    if (Object.keys(left).length) _pending = left;
  } catch {}
}

export function installPushMetrics() {
  if (_installed || Platform.OS === 'web') return;
  _installed = true;
  flushPushMetrics(true);
  try {
    AppState.addEventListener('change', (s) => { if (s === 'active') setTimeout(() => { flushPushMetrics(false); }, 3000); });
  } catch {}
}
