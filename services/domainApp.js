// [migracao .app 2026-10-24] Domínio PRIMÁRIO chatyy.app (API/WS) com volta automática a chatyy.com.br.
//
// Como funciona (sem mexer na lógica de região/edge, que continua vendo os hosts .com.br):
//  • a tradução acontece SÓ no transporte: fetch() e new WebSocket() trocam
//    https|wss://{chatyy.com.br, api., ws., ws2., api-<reg>.}chatyy.com.br → mesmo host em chatyy.app.
//    Mídia (media./cdn./upload.), LiveKit/TURN (livekit./lk-/turn-), suporte./mail. e qualquer outro host: intocados.
//  • o servidor atende os DOIS domínios para sempre (certificados em todas as origens desde 24/10/2026).
//  • portão: só liga depois que https://api.chatyy.app responder neste aparelho (sonda no boot,
//    lembrada por 24 h); até lá, e se a sonda falhar, tudo fica em .com.br.
//  • volta automática: erro de REDE num host .app (fetch TypeError / WS que fecha antes de abrir)
//    → .app desligado neste aparelho por 30 min e o pedido é refeito UMA vez em .com.br.
//  • web: só traduz quando a própria página está em chatyy.app (mesma origem); em chatyy.com.br nada muda.
//
// Kill switches: globalThis.__chatyy_domain_app = false (sessão) · servidor api/domain-flags.php
// `app:false` (arquivo data/.domain-app-off) → desliga no próximo boot/consulta (cache 6 h).
// Também publica as flags de exibição: __chatyy_app_alias (mostrar @chatyy.app) e
// __chatyy_signup_domain (domínio do cadastro novo) — lidas por utils/displayEmail.js.
import { Platform } from 'react-native';

const OLD = 'chatyy.com.br';
const NEW = 'chatyy.app';
const FLAGS_URL = 'https://chatyy.com.br/api/domain-flags.php';
const PROBE_URL = 'https://api.chatyy.app/api/domain-flags.php';
const K_STATE = 'domain_app_state_v1'; // {ok_ts, down_until, flags:{app,alias,signup,send}, flags_ts}
const OK_TTL = 24 * 3600 * 1000;
const DOWN_MS = 30 * 60 * 1000;
const FLAGS_TTL = 6 * 3600 * 1000;
// sub-hosts traduzidos ('' = apex)
const RE = /^(https|wss):\/\/((?:api|ws|ws2|api-[a-z0-9]{2,6})\.)?chatyy\.com\.br(?=[/:?#]|$)/i;

let _st = null;
let _installed = false;
let _probing = false;

function _store() { try { return require('./mmkv'); } catch { return null; } }
function _load() {
  if (_st) return _st;
  let raw = null;
  try {
    if (Platform.OS === 'web') raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(K_STATE) : null;
    else raw = _store()?.getString?.(K_STATE) ?? null;
  } catch {}
  try { _st = raw ? JSON.parse(raw) : {}; } catch { _st = {}; }
  if (!_st || typeof _st !== 'object') _st = {};
  return _st;
}
function _save() {
  try {
    const s = JSON.stringify(_st || {});
    if (Platform.OS === 'web') { if (typeof localStorage !== 'undefined') localStorage.setItem(K_STATE, s); }
    else _store()?.setString?.(K_STATE, s);
  } catch {}
}
function _publishFlags(f) {
  if (!f || typeof f !== 'object') return;
  try {
    if (typeof f.alias === 'boolean' && globalThis.__chatyy_app_alias !== false) globalThis.__chatyy_app_alias = f.alias;
    if (f.signup === NEW || f.signup === OLD) globalThis.__chatyy_signup_domain = f.signup;
  } catch {}
}

function _webOnApp() {
  try { const h = String(globalThis.location?.hostname || '').toLowerCase(); return h === NEW || h.endsWith('.' + NEW); } catch { return false; }
}

/** .app ativo AGORA neste aparelho? */
export function domainAppActive() {
  try { if (globalThis.__chatyy_domain_app === false) return false; } catch {}
  if (Platform.OS === 'web') return _webOnApp();
  const s = _load();
  const now = Date.now();
  if (s.down_until && now < s.down_until) return false;
  if (s.flags && s.flags.app === false) return false;
  return !!(s.ok_ts && now - s.ok_ts < OK_TTL);
}

/** Traduz a URL para chatyy.app quando ativo; senão devolve igual. */
export function toAppUrl(u) {
  if (typeof u !== 'string' || u.indexOf(OLD) < 0) return u;
  if (!domainAppActive()) return u;
  return u.replace(RE, (m, sch, sub) => `${sch}://${sub || ''}${NEW}`);
}
export function isAppUrl(u) { return typeof u === 'string' && /^(https|wss):\/\/([a-z0-9-]+\.)?chatyy\.app(?=[/:?#]|$)/i.test(u); }

export function markDomainAppDown(reason) {
  const s = _load();
  s.down_until = Date.now() + DOWN_MS; s.down_why = String(reason || '').slice(0, 60);
  _save();
  try { if (__DEV__) console.log('[domainApp] .app fora → .com.br por 30 min', reason); } catch {}
}

function _urlOf(input) {
  if (typeof input === 'string') return input;
  try { if (input && typeof input.url === 'string') return input.url; } catch {}
  return null;
}

/** Sonda .app + flags do servidor (boot e a cada 6 h). Nunca lança. */
export async function refreshDomainFlags(origFetch) {
  if (_probing) return; _probing = true;
  const f0 = origFetch || globalThis.fetch;
  const s = _load();
  try {
    // flags (canônico .com.br, sempre)
    if (!s.flags_ts || Date.now() - s.flags_ts > FLAGS_TTL || !s.flags) {
      const r = await Promise.race([f0(FLAGS_URL, { cache: 'no-store' }), new Promise((_, j) => setTimeout(() => j(new Error('t')), 8000))]);
      if (r && r.ok) { const j = await r.json(); if (j && typeof j === 'object') { s.flags = { app: j.app !== false, alias: j.alias === true, signup: j.signup, send: j.send }; s.flags_ts = Date.now(); } }
    }
    _publishFlags(s.flags);
    // sonda do .app (só nativo; web segue a origem da página)
    if (Platform.OS !== 'web' && s.flags?.app !== false && (!s.ok_ts || Date.now() - s.ok_ts > OK_TTL / 2) && !(s.down_until && Date.now() < s.down_until)) {
      const r = await Promise.race([f0(PROBE_URL, { cache: 'no-store' }), new Promise((_, j) => setTimeout(() => j(new Error('t')), 6000))]);
      if (r && r.ok) { const j = await r.json().catch(() => null); if (j && j.v) s.ok_ts = Date.now(); }
    }
  } catch {}
  _save();
  _probing = false;
}

/** Instala a tradução em fetch/WebSocket (1x por processo). */
export function installDomainApp() {
  if (_installed) return; _installed = true;
  try { _publishFlags(_load().flags); } catch {}
  const g = globalThis;
  const origFetch = typeof g.fetch === 'function' ? g.fetch.bind(g) : null;
  if (origFetch) {
    const wrapped = async function (input, init) {
      const url = _urlOf(input);
      if (!url || url.indexOf(OLD) < 0) return origFetch(input, init);
      const nu = toAppUrl(url);
      if (nu === url) return origFetch(input, init);
      const req = typeof input === 'string' ? nu : (() => { try { return new Request(nu, input); } catch { return nu; } })();
      try {
        return await origFetch(req, init);
      } catch (e) {
        // abort do chamador não é falha de domínio
        if (e && (e.name === 'AbortError' || init?.signal?.aborted)) throw e;
        markDomainAppDown('fetch:' + (e && e.message ? String(e.message).slice(0, 40) : 'erro'));
        return origFetch(input, init);
      }
    };
    try { g.fetch = wrapped; } catch {}
  }
  const OrigWS = g.WebSocket;
  if (typeof OrigWS === 'function') {
    try {
      class AppDomainWebSocket extends OrigWS {
        constructor(url, protocols) {
          const nu = toAppUrl(url);
          if (protocols === undefined) super(nu); else super(nu, protocols);
          if (nu !== url) {
            let opened = false;
            try { this.addEventListener('open', () => { opened = true; }); } catch {}
            try { this.addEventListener('close', () => { if (!opened) markDomainAppDown('ws'); }); } catch {}
          }
        }
      }
      g.WebSocket = AppDomainWebSocket;
    } catch {}
  }
  // sonda/flags em 2º plano (não atrasa o boot)
  setTimeout(() => { refreshDomainFlags(origFetch).catch?.(() => {}); }, 1500);
  try { setInterval(() => { refreshDomainFlags(origFetch); }, FLAGS_TTL); } catch {}
}

export default { installDomainApp, toAppUrl, domainAppActive, markDomainAppDown, refreshDomainFlags, isAppUrl };
