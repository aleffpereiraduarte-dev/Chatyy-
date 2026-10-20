// [bia-frase 2026-10-19] Linha da Bia na lista de conversas: "Bom dia, Aleff" + frase de ânimo
// que muda a cada 12 h (slot am 05–17 h / pm 17–05 h no fuso do aparelho). O servidor
// (action bia_daily_line) gera/escolhe a frase e guarda por usuário+slot; aqui ela fica no
// MMKV por conta para pintar na hora e só é buscada de novo quando o slot vence (abrir o app,
// voltar do 2º plano ou no próprio horário de virada com o app aberto).
// Kill switch: globalThis.__chatyy_bia_daily = false → volta o subtítulo antigo.
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { apiCall, getActiveAccountEmail } from './api';
import { getJSON, setJSON } from './mmkv';

const KEY_PFX = 'bia_daily_v1_';

export function biaDailyEnabled() {
  try { return globalThis.__chatyy_bia_daily !== false; } catch { return true; }
}

function _acct() {
  try { return String(getActiveAccountEmail() || '').toLowerCase(); } catch { return ''; }
}

function _key(acct) { return KEY_PFX + (acct || 'anon'); }

function _lang2(lang) {
  return String(lang || 'pt').slice(0, 2).toLowerCase();
}

function _valid(c, lang) {
  if (!c || !c.line || !c.expires_at) return false;
  const exp = Date.parse(c.expires_at);
  if (!Number.isFinite(exp) || Date.now() >= exp) return false;
  if (c.req_lang && c.req_lang !== _lang2(lang)) return false;
  // [2026-10-20 curta] frase antiga longa (cortava com "…" no balão) → busca a nova, curta.
  if (String(c.line).length > 34) return false;
  return true;
}

export function readBiaDailyCache(lang) {
  try {
    const c = getJSON(_key(_acct()));
    return _valid(c, lang) ? c : null;
  } catch { return null; }
}

// Fetch dedupe por conta+idioma (o card pode montar/desmontar com a busca).
const _inflight = new Map();

export function fetchBiaDaily(lang) {
  const acct = _acct();
  const l = _lang2(lang);
  const k = acct + '|' + l;
  if (_inflight.has(k)) return _inflight.get(k);
  const p = (async () => {
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
    let off = 0;
    try { off = -new Date().getTimezoneOffset(); } catch {}
    const res = await apiCall('bia_daily_line', { tz, tz_offset_min: off, lang: lang || 'pt-BR' });
    const d = res && res.success ? res.data : null;
    if (!d || !d.line || !d.expires_at) return null;
    const c = {
      name: String(d.name || ''),
      line: String(d.line || ''),
      slot: String(d.slot || ''),
      expires_at: String(d.expires_at),
      req_lang: l,
      _acct: acct,
    };
    if (_acct() === acct) { try { setJSON(_key(acct), c); } catch {} }
    return c;
  })().catch(() => null).finally(() => { _inflight.delete(k); });
  _inflight.set(k, p);
  return p;
}

// Hook: { name, line } do slot atual (null até a 1ª resposta; depois pinta do MMKV na hora).
export function useBiaDaily(lang) {
  const on = biaDailyEnabled();
  // [2026-10-19 audit] conta ativa nas deps: trocar de conta não pode deixar
  // "Bom dia, <nome da outra conta>" até o slot vencer.
  const acct = _acct();
  const [data, setData] = useState(() => (on ? readBiaDailyCache(lang) : null));

  useEffect(() => {
    if (!on) return undefined;
    setData((prev) => {
      const c = readBiaDailyCache(lang);
      return c || (prev && prev._acct === acct ? prev : null);
    });
    let alive = true;
    let timer = null;
    const arm = (c) => {
      if (timer) { clearTimeout(timer); timer = null; }
      const exp = c ? Date.parse(c.expires_at) : NaN;
      if (!Number.isFinite(exp)) return;
      // vira o slot com o app aberto (+5 s de folga); setTimeout tem teto de ~24,8 dias
      const ms = Math.min(Math.max(exp - Date.now() + 5000, 5000), 13 * 3600 * 1000);
      timer = setTimeout(() => { check(); }, ms);
    };
    const check = () => {
      const c = readBiaDailyCache(lang);
      if (c) { if (alive) { setData(c); arm(c); } return; }
      fetchBiaDaily(lang).then((n) => {
        if (!alive || !n) return;
        setData(n);
        arm(n);
      });
    };
    check();
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') check(); });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      try { sub?.remove?.(); } catch {}
    };
  }, [on, lang, acct]);

  return on ? data : null;
}

// Saudação pela hora LOCAL: Bom dia 5–12, Boa tarde 12–18, Boa noite 18–5.
export function biaGreetingKey(d = new Date()) {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'one.goodMorning';
  if (h >= 12 && h < 18) return 'one.goodAfternoon';
  return 'one.goodEvening';
}
