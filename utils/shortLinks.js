// [dominios-novos 2026-10-24] Links curtos ctyy.me (estilo t.me / wa.me) no "Compartilhar".
//
//   ctyy.me/<usuario>   perfil          ctyy.me/g/<código>  convite de grupo
//   ctyy.me/r/<id>      Reels           ctyy.me/c/<código>  link de chamada
//   ctyy.me/+<telefone> conversa direta (o app abre "Nova conversa" buscando o número; quem decide
//                       se a pessoa aparece é o find_by_phone autenticado — privacidade dela vale)
//
// FLAG (padrão DESLIGADA → links longos de sempre, byte a byte):
//   globalThis.__chatyy_short_links === true  → liga (QA / OTA)
//   globalThis.__chatyy_short_links === false → desliga (vence o servidor)
//   indefinida → segue o servidor: GET <origem>/api/short-links.php {on} (cache 6 h em memória),
//   que o /root/dominios-novos-2026-10-24/ativar.sh liga só depois que ctyy.me responde certo.
// O redirecionador (Worker ctyy-me) e o app (utils/universalLinks.js _resolveShort) usam o MESMO mapa.

const SHORT = 'https://ctyy.me';
const HANDLE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{4,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OWN_HOSTS = new Set(['chatyy.com.br', 'www.chatyy.com.br', 'chatyy.app', 'www.chatyy.app']);
const LOCAL_DOMAINS = ['@chatyy.com.br', '@chatyy.app'];
const SRV_TTL_MS = 6 * 60 * 60 * 1000;

let _srvOn = null;
let _srvAt = 0;
let _inflight = false;

function _primeFromServer() {
  if (_inflight || (Date.now() - _srvAt) < SRV_TTL_MS) return;
  _inflight = true;
  try {
    let base = 'https://chatyy.com.br';
    try { base = require('../services/api').ORIGIN_BASE || base; } catch {}
    fetch(base + '/api/short-links.php', { method: 'GET' })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((j) => { if (j && typeof j.on === 'boolean') { _srvOn = j.on; _srvAt = Date.now(); } })
      .catch(() => {})
      .finally(() => { _inflight = false; });
  } catch { _inflight = false; }
}

/** Links curtos ligados? Síncrono (usa o último valor do servidor; 1ª chamada da sessão = desligado). */
export function shortLinksOn() {
  try {
    const g = globalThis.__chatyy_short_links;
    if (g === true) return true;
    if (g === false) return false;
  } catch {}
  _primeFromServer();
  return _srvOn === true;
}

/** Aquece a flag do servidor (ex.: ao abrir o perfil) para o 1º "Compartilhar" já sair curto. */
export function primeShortLinks() { try { if (globalThis.__chatyy_short_links === undefined) _primeFromServer(); } catch {} }

function _localPart(handleOrEmail) {
  let h = String(handleOrEmail || '').trim().replace(/^@/, '');
  const low = h.toLowerCase();
  for (const d of LOCAL_DOMAINS) if (low.endsWith(d)) { h = h.slice(0, -d.length); break; }
  return h;
}

/**
 * Link do perfil. Ligado: ctyy.me/<usuario> (só quando dá p/ reduzir a @usuario sem perder
 * informação: e-mail de outro domínio continua no formato longo). Desligado: `fallback` ou
 * https://chatyy.com.br/u/<handleOrEmail> (exatamente o que os botões já geravam).
 */
export function profileShareUrl(handleOrEmail, fallback) {
  const longUrl = fallback || `https://chatyy.com.br/u/${encodeURIComponent(handleOrEmail || '')}`;
  if (!shortLinksOn()) return longUrl;
  const raw = String(handleOrEmail || '').trim().replace(/^@/, '');
  const local = _localPart(raw);
  if (raw.includes('@') && local === raw) return longUrl; // e-mail externo → mantém longo
  return HANDLE_RE.test(local) ? `${SHORT}/${local}` : longUrl;
}

/** Converte um link longo do Chatyy (perfil/convite/reel/chamada) para ctyy.me; senão devolve igual. */
export function shortenUrl(url) {
  if (!url || typeof url !== 'string' || !shortLinksOn()) return url;
  const m = url.match(/^https?:\/\/([^/?#]+)(\/[^?#]*)?/i);
  if (!m || !OWN_HOSTS.has(m[1].toLowerCase())) return url;
  const seg = String(m[2] || '/').split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const a = seg[0] || '';
  const b = seg[1] || '';
  if (seg.length === 2 && (a === 'g' || a === 'j') && TOKEN_RE.test(b)) return `${SHORT}/g/${b}`;
  if (seg.length === 2 && a === 'r' && ID_RE.test(b)) return `${SHORT}/r/${b}`;
  if (seg.length === 2 && (a === 'c' || a === 'call') && ID_RE.test(b)) return `${SHORT}/c/${b}`;
  if (seg.length === 2 && a === 'u') return profileShareUrl(b, url);
  if (seg.length === 1 && a.startsWith('@')) return profileShareUrl(a, url);
  return url;
}

/** Link curto do Reels (ligado) ou o longo recebido. */
export function reelShareUrl(reelId, longUrl) {
  if (!shortLinksOn()) return longUrl;
  const id = String(reelId || '');
  return ID_RE.test(id) ? `${SHORT}/r/${id}` : longUrl;
}

/** ctyy.me/+<telefone> (ligado e número E.164 plausível) ou null. */
export function directPhoneUrl(phone) {
  if (!shortLinksOn()) return null;
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  return digits.length >= 8 && digits.length <= 15 ? `${SHORT}/+${digits}` : null;
}
