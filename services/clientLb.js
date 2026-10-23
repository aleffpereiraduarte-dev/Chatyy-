// ─── [client-lb 2026-10-21] Balanceamento NO CLIENTE (nível WhatsApp) ───
// O app escolhe a região (HTTP + WS juntos) em vez de depender só do LB da Cloudflare
// (chatyy.com.br tem steering=off: o CF manda todo mundo p/ o US e só faz failover).
//
//  1. LISTA de regiões do servidor: GET https://chatyy.com.br/api/client-lb.php (pequena,
//     Cache-Control private 300 s; HTTPS do próprio domínio). Cada região: hosts (origens),
//     ws, active, health (do region-health.json do vigia do US, histerese 2/3) e `near`
//     (candidatas pelo país do Cloudflare). Fallback EMBUTIDO abaixo (as 4 novas desligadas).
//     Só hosts *.chatyy.com.br são aceitos.
//  2. MEDIÇÃO (feita em services/api.js): RTT do /health de 2-3 candidatas (near/fuso) + a
//     atual/última boa + US. Só em 1º plano; no boot, ao trocar de rede e no máx. a cada
//     cfg.min_gap_s (15 min). Economia (modo economia do SO/bateria <20 % ou economia de
//     dados) → sem remedição periódica e 1 amostra só.
//  3. DECISÃO (`decide`): só troca se a candidata for >25 % E >30 ms melhor em 2 medições
//     seguidas; fixação por sessão (rede): no máx. 2 trocas voluntárias por sessão e 30 min
//     entre elas. Failover (erro/timeout) é imediato p/ a próxima do ranking; US = última.
//     [lb-sticky 2026-10-23] SUBSTITUÍDO por regras sticky (ver STICKY abaixo): atual com RTT ≤
//     max(80 ms, 1,5× a melhor) não troca; troca só ≥40 % E ≥40 ms em 3 medições (~45 s) ou falha
//     real; nunca c/ envio/ligação; rede nova = 1 reavaliação. Kill: globalThis.__chatyy_lb_sticky=false.
//  4. Região active=false ou health=down NUNCA é escolhida (US sempre pode).
//  5. Telemetria: beacon POST /api/client-lb.php (pick/switch/failover + RTTs, incl. US →
//     dá p/ comparar com o que o Cloudflare faria: sempre US) + crashReporter step client_lb.
//  6. Kill: globalThis.__chatyy_client_lb = false (local/OTA) ou "lb":false no servidor →
//     services/api.js volta ao comportamento antigo (detectFastestServer v15).
import { Platform } from 'react-native';

const ORIGIN = 'https://chatyy.com.br';
const LIST_URL = ORIGIN + '/api/client-lb.php';
const LIST_KEY = 'client_lb_regions_v1';
const STATE_KEY = 'client_lb_state_v1';
const ID_KEY = 'client_lb_id';
const LIST_MIN_TTL_MS = 60 * 1000;
const LIST_MAX_TTL_MS = 6 * 60 * 60 * 1000;
const LIST_STALE_MS = 24 * 60 * 60 * 1000; // lista mais velha que isso: health ignorada

const HOST_RE = /^https:\/\/(chatyy\.com\.br|api-[a-z0-9]{2,8}\.chatyy\.com\.br)$/;
const WS_RE = /^wss:\/\/(ws\.chatyy\.com\.br|api-[a-z0-9]{2,8}\.chatyy\.com\.br)\/ws$/;
const ID_RE = /^[a-z0-9]{2,6}$/;

const R = (id, lat, lon, hosts, ws, active, master) => ({
  id, lat, lon, active, master: !!master, health: 'unknown',
  hosts: hosts.map(([o, url]) => ({ o, url, health: 'unknown' })), ws,
});
// Fallback embutido (igual ao servidor em 21/10). Novas regiões DESLIGADAS.
export const BUILTIN_REGIONS = [
  R('us', 40.7, -74.0, [['us', 'https://chatyy.com.br']], 'wss://ws.chatyy.com.br/ws', true, true),
  R('br', -23.5, -46.6, [['br', 'https://api-br.chatyy.com.br'], ['br2', 'https://api-br2.chatyy.com.br']], 'wss://api-br.chatyy.com.br/ws', true),
  R('eu', 53.5, -2.2, [['eu', 'https://api-eu.chatyy.com.br']], 'wss://api-eu.chatyy.com.br/ws', true),
  R('usw', 47.6, -122.3, [['usw', 'https://api-usw.chatyy.com.br']], 'wss://api-usw.chatyy.com.br/ws', true),
  R('sg', 3.1, 101.7, [['sg', 'https://api-sg.chatyy.com.br']], 'wss://api-sg.chatyy.com.br/ws', true),
  R('in', 19.1, 72.9, [['in', 'https://api-in.chatyy.com.br']], 'wss://api-in.chatyy.com.br/ws', true),
  R('mia', 25.8, -80.2, [['mia', 'https://api-mia.chatyy.com.br']], 'wss://api-mia.chatyy.com.br/ws', false),
  R('mex', 19.4, -99.1, [['mex', 'https://api-mex.chatyy.com.br']], 'wss://api-mex.chatyy.com.br/ws', false),
  R('mad', 40.4, -3.7, [['mad', 'https://api-mad.chatyy.com.br']], 'wss://api-mad.chatyy.com.br/ws', false),
  R('scl', -33.4, -70.7, [['scl', 'https://api-scl.chatyy.com.br']], 'wss://api-scl.chatyy.com.br/ws', false),
];

export const DEFAULT_CFG = { switch_ratio: 0.25, switch_ms: 30, confirm: 2, min_gap_s: 900, beacon: true, ws_weight: 0.3 };
export const PIN_MIN_GAP_MS = 30 * 60 * 1000;   // entre 2 trocas voluntárias na mesma sessão
export const PIN_MAX_VOLUNTARY = 2;             // trocas voluntárias por sessão (rede)

function _mm() { try { return require('./mmkv'); } catch { return null; } }
const _clamp = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

// ── Validação da lista (exportada p/ teste) ────────────────────────────────
export function validateList(j) {
  if (!j || j.success !== true || !Array.isArray(j.regions)) return null;
  const regions = [];
  for (const r of j.regions.slice(0, 24)) {
    if (!r || typeof r.id !== 'string' || !ID_RE.test(r.id)) continue;
    const hosts = (Array.isArray(r.hosts) ? r.hosts : []).slice(0, 4)
      .filter((h) => h && typeof h.url === 'string' && HOST_RE.test(h.url) && typeof h.o === 'string' && ID_RE.test(h.o))
      .map((h) => ({ o: h.o, url: h.url, health: h.health === 'down' ? 'down' : (h.health === 'up' ? 'up' : 'unknown') }));
    if (!hosts.length) continue;
    regions.push({
      id: r.id, lat: Number(r.lat) || 0, lon: Number(r.lon) || 0,
      active: r.id === 'us' ? true : r.active === true,
      master: r.id === 'us',
      health: r.id === 'us' ? 'up' : (r.health === 'down' ? 'down' : (r.health === 'up' ? 'up' : 'unknown')),
      hosts,
      ws: typeof r.ws === 'string' && WS_RE.test(r.ws) ? r.ws : null,
      // [quic-proto 2026-10-23] QUIC chatyy/1 anunciado na região (PROTOCOLO §1: q, qp, nk).
      q: r.id !== 'us' && (r.q === 1 || r.q === true),
      qp: (Number.isInteger(r.qp) && r.qp > 0 && r.qp < 65536) ? r.qp : 443,
      nk: typeof r.nk === 'string' && /^[a-z0-9]{1,16}$/.test(r.nk) ? r.nk : null,
    });
  }
  const us = regions.find((r) => r.id === 'us');
  if (!us || us.hosts[0].url !== ORIGIN) return null; // sem o master = lista inválida
  const c = j.cfg || {};
  return {
    v: Number(j.v) || 1,
    lb: j.lb !== false,
    regions,
    near: (Array.isArray(j.near) ? j.near : []).filter((x) => typeof x === 'string' && ID_RE.test(x)).slice(0, 5),
    // [mapa-latencia 2026-10-22] hubs p/ medir quando o país do IP ≠ fuso/GPS (roaming c/ home routing)
    roam: (Array.isArray(j.roam) ? j.roam : ROAM_HUBS).filter((x) => typeof x === 'string' && ID_RE.test(x)).slice(0, 4),
    country: typeof j.country === 'string' && /^[A-Z]{2}$/.test(j.country) ? j.country : null,
    ttlMs: _clamp(Number(j.ttl) * 1000, LIST_MIN_TTL_MS, LIST_MAX_TTL_MS, 300000),
    cfg: {
      switch_ratio: _clamp(Number(c.switch_ratio), 0.1, 0.6, DEFAULT_CFG.switch_ratio),
      switch_ms: _clamp(Number(c.switch_ms), 10, 200, DEFAULT_CFG.switch_ms),
      confirm: Math.round(_clamp(Number(c.confirm), 1, 4, DEFAULT_CFG.confirm)),
      min_gap_s: _clamp(Number(c.min_gap_s), 300, 7200, DEFAULT_CFG.min_gap_s),
      beacon: c.beacon !== false,
      // [client-lb 2026-10-22] peso do RTT do WS (ping/pong) no placar da região (0 = só /health).
      ws_weight: _clamp(Number(c.ws_weight), 0, 1, DEFAULT_CFG.ws_weight),
    },
    // [client-lb 2026-10-22] rede vista pelo servidor: hash do IP /24 (v6 /48) e /16 (v6 /32) + ASN
    // (quando o servidor souber). Só hashes — o app usa como chave de "melhor edge POR rede".
    net: _validNet(j.net),
    // [client-lb 2026-10-22] posição estimada do IP (CF) → candidatas num raio.
    geo: (j.geo && typeof j.geo.lat === 'number' && typeof j.geo.lon === 'number' && Math.abs(j.geo.lat) <= 90 && Math.abs(j.geo.lon) <= 180)
      ? { lat: j.geo.lat, lon: j.geo.lon } : null,
    // [client-lb 2026-10-22] WS no leaf (hub regional) p/ contas da lista (hash FNV-1a do e-mail)
    // mesmo em binário cujo nativo só conhece br/eu. Kill remoto: tirar do JSON / "ws_leaf":false.
    wsLeaf: _validWsLeaf(j.ws_leaf),
    // [quic-proto 2026-10-23] transporte por CONTA (só vem p/ a allowlist do servidor).
    transport: _validTransport(j.transport),
  };
}
function _validTransport(t) {
  if (!t || typeof t !== 'object') return null;
  const on = (v) => v === 1 || v === true;
  const acc = Array.isArray(t.acc) ? t.acc.filter((x) => typeof x === 'string' && /^[0-9a-f]{8}$/.test(x)).slice(0, 64) : null;
  return { quic: on(t.quic), noise: on(t.noise), noise0rtt: on(t.noise0rtt), ntcp: on(t.ntcp), noise_test: on(t.noise_test), acc };
}
const HEX_RE = /^[0-9a-f]{8,16}$/;
function _validNet(n) {
  if (!n || typeof n !== 'object') return null;
  const p = typeof n.p === 'string' && HEX_RE.test(n.p) ? n.p : null;
  if (!p) return null;
  return {
    p,
    p16: typeof n.p16 === 'string' && HEX_RE.test(n.p16) ? n.p16 : null,
    asn: (typeof n.asn === 'number' && n.asn > 0 && n.asn < 4294967296) ? Math.floor(n.asn) : null,
  };
}
function _validWsLeaf(w) {
  if (!w || typeof w !== 'object') return null;
  const acc = (Array.isArray(w.acc) ? w.acc : []).filter((x) => typeof x === 'string' && /^[0-9a-f]{8}$/.test(x)).slice(0, 64);
  if (!acc.length && w.all !== true) return null;
  return { all: w.all === true, acc };
}

// ── Estado da lista ────────────────────────────────────────────────────────
let _list = null;      // { ...validateList, fetchedAt, src }
let _listLoaded = false;
let _fetching = null;

function _loadList() {
  if (_listLoaded && _list) return _list;
  try {
    const raw = _mm()?.getString(LIST_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      const v = p && p.data ? validateList({ success: true, ...p.data, ws_leaf: p.data.ws_leaf || p.data.wsLeaf }) : null;
      if (v) { _list = { ...v, ttlMs: p.ttlMs || v.ttlMs, fetchedAt: Number(p.fetchedAt) || 0, src: 'cache', sig: typeof p.sig === 'string' ? p.sig : null }; _listLoaded = true; }
    }
  } catch {}
  return _list;
}

export function getList() {
  const l = _loadList();
  if (l) {
    if (Date.now() - (l.fetchedAt || 0) > LIST_STALE_MS) {
      // Velha: mantém hosts/active, mas saúde desconhecida (não confia em "down" antigo).
      return { ...l, regions: l.regions.map((r) => ({ ...r, health: r.id === 'us' ? 'up' : 'unknown' })) };
    }
    return l;
  }
  return { v: 0, lb: true, regions: BUILTIN_REGIONS, near: [], country: null, ttlMs: 0, cfg: { ...DEFAULT_CFG }, fetchedAt: 0, src: 'builtin' };
}

export function listAgeMs() { const l = _loadList(); return l ? Date.now() - (l.fetchedAt || 0) : Infinity; }

async function _fetchJson(url, ms) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = setTimeout(() => { try { ctl && ctl.abort(); } catch {} }, ms);
  try {
    const res = await fetch(url, { method: 'GET', cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

/** Busca a lista se venceu (ou force). `altBase` = edge atual (reserva se o US/CF falhar). */
export function refreshList({ force = false, altBase = null } = {}) {
  const l = _loadList();
  if (!force && l && Date.now() - (l.fetchedAt || 0) < (l.ttlMs || 300000)) return Promise.resolve(l);
  if (_fetching) return _fetching;
  _fetching = (async () => {
    try {
      let j = await _fetchJson(LIST_URL, 3500);
      let src = 'origin';
      if (!validateList(j) && altBase && HOST_RE.test(altBase) && altBase !== ORIGIN) {
        j = await _fetchJson(altBase + '/api/client-lb.php', 3500);
        src = 'edge';
      }
      const v = validateList(j);
      if (!v) return _list;
      // Lista vinda de edge não tem saúde (só o US tem o vigia): preserva "down" recente do cache.
      if (src === 'edge' && _list && Date.now() - (_list.fetchedAt || 0) < 10 * 60 * 1000) {
        for (const r of v.regions) {
          const o = _list.regions.find((x) => x.id === r.id);
          if (o && r.health === 'unknown' && o.health === 'down') r.health = 'down';
        }
      }
      // net (hash do IP) só vale p/ a rede em que a lista foi buscada: carimba a assinatura local.
      _list = { ...v, fetchedAt: Date.now(), src, sig: netSignature() };
      _listLoaded = true;
      try {
        const { ttlMs, fetchedAt, src: _s, sig, ...data } = _list;
        _mm()?.setString(LIST_KEY, JSON.stringify({ data: { ...data, ttl: Math.round(ttlMs / 1000) }, ttlMs, fetchedAt, sig }));
      } catch {}
      return _list;
    } catch { return _list; } finally { _fetching = null; }
  })();
  return _fetching;
}

// ── Liga/desliga ───────────────────────────────────────────────────────────
export function isClientLbOn() {
  try { if (globalThis.__chatyy_client_lb === false) return false; } catch {}
  try { if (Platform.OS === 'web') return false; } catch {} // web: CSP/CORS por host → segue o US/legado
  const l = _loadList();
  return !(l && l.lb === false);
}

/** Região utilizável = ativa e não marcada fora (US sempre). */
export function isUsable(reg) {
  if (!reg) return false;
  if (reg.id === 'us') return true;
  return reg.active === true && reg.health !== 'down';
}
export function usableRegions(list) { return (list || getList()).regions.filter(isUsable); }
export function regionById(id, list) { return (list || getList()).regions.find((r) => r.id === id) || null; }

// ── Candidatas pelo fuso (sem permissão de localização) ────────────────────
const TZ_MAP = [
  [/^America\/(Sao_Paulo|Bahia|Fortaleza|Recife|Maceio|Belem|Araguaina|Santarem|Cuiaba|Campo_Grande|Porto_Velho|Boa_Vista|Manaus|Rio_Branco|Eirunepe|Noronha|Asuncion|Montevideo|Paramaribo|Cayenne)$/, ['br', 'scl', 'us']],
  [/^America\/(Santiago|Punta_Arenas|Argentina\/.*|Buenos_Aires|La_Paz|Lima)$/, ['scl', 'br', 'us']],
  [/^America\/(Mexico_City|Monterrey|Merida|Matamoros|Chihuahua|Ciudad_Juarez|Hermosillo|Mazatlan|Bahia_Banderas|Tijuana|Cancun|Guatemala|El_Salvador|Belize|Tegucigalpa)$/, ['mex', 'mia', 'us']],
  [/^America\/(Bogota|Caracas|Guayaquil|Panama|Costa_Rica|Managua|Havana|Jamaica|Santo_Domingo|Port-au-Prince|Puerto_Rico|Nassau|Port_of_Spain|Barbados|Curacao|Aruba)$/, ['mia', 'us', 'br']],
  [/^America\/(Los_Angeles|Vancouver|Denver|Phoenix|Boise|Edmonton|Anchorage|Juneau|Whitehorse|Yellowknife|Sitka)$|^Pacific\/Honolulu$/, ['usw', 'us', 'mex']],
  [/^America\/(Chicago|Winnipeg|Regina|Indiana\/.*|Kentucky\/.*|Menominee|North_Dakota\/.*)$/, ['us', 'usw', 'mex']],
  [/^America\//, ['us', 'mia', 'usw']],
  [/^(Europe\/(Madrid|Lisbon)|Atlantic\/(Canary|Madeira|Azores)|Africa\/(Casablanca|Ceuta|Algiers|Tunis))$/, ['mad', 'eu', 'us']],
  [/^Europe\//, ['eu', 'mad', 'us']],
  [/^Africa\//, ['eu', 'mad', 'br']],
  [/^Asia\/(Kolkata|Calcutta|Dhaka|Karachi|Colombo|Kathmandu|Thimphu)$|^Indian\/Maldives$/, ['in', 'sg', 'eu']],
  [/^Asia\/(Dubai|Riyadh|Qatar|Bahrain|Kuwait|Muscat|Tehran|Baghdad|Jerusalem|Tel_Aviv|Amman|Beirut|Damascus|Baku|Tbilisi|Yerevan|Kabul)$|^Europe\/Istanbul$/, ['eu', 'in', 'mad']],
  [/^Asia\/(Tokyo|Seoul|Shanghai|Hong_Kong|Taipei|Macau|Chongqing)$/, ['sg', 'usw', 'in']],
  [/^(Asia|Australia|Pacific)\//, ['sg', 'in', 'usw']],
];
export function tzGuess(tz) {
  const s = String(tz || '');
  for (const [re, regs] of TZ_MAP) if (re.test(s)) return regs;
  return [];
}
export function deviceTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

/**
 * Candidatas a medir (exportada p/ teste): 2 mais prováveis (near do servidor, senão fuso)
 * + a atual + a última boa + US. Só utilizáveis; no máx. `max` (US conta).
 */
export const GEO_RADIUS_KM = 2500;
// [mapa-latencia 2026-10-22] mapa medido (Globalping, ~150 locais x 11 servidores): a 3ª do `near`
// ganha da 1ª/2ª em vários estados/países (ex. GA/SC: mia < mex ≈ usw ≈ us) e no roaming
// (IP de operadora dos EUA/home routing) o melhor é o hub perto da SAÍDA da operadora (mia/usw/mex),
// não o do país do aparelho → +1 sonda fora do modo economia (max ≥ 4) p/ caber near[2] / hub.
// Kill OTA: globalThis.__chatyy_lb_map_off = true (volta à seleção anterior).
export const ROAM_HUBS = ['mia', 'usw', 'mex'];
export const MAP_EXTRA_PROBES = 1;
export function distKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** Regiões utilizáveis (exceto US) a até `km` da posição, da mais perto p/ a mais longe. */
export function regionsNear(geo, list, km = GEO_RADIUS_KM) {
  if (!geo) return [];
  return usableRegions(list || getList()).filter((r) => r.id !== 'us')
    .map((r) => ({ id: r.id, d: distKm(geo, r) })).filter((x) => x.d <= km)
    .sort((a, b) => a.d - b.d).map((x) => x.id);
}
export function pickCandidates({ list, near, tz, current, lastGood, max = 4, remembered = null, geoBad = false, geo = null, netChange = false, phys = null } = {}) {
  const L = list || getList();
  const ok = (id) => isUsable(regionById(id, L));
  const mapOn = globalThis.__chatyy_lb_map_off !== true;
  if (mapOn && max >= 4) max += MAP_EXTRA_PROBES;
  const out = [];
  const add = (id) => { if (id && !out.includes(id) && ok(id) && out.length < max) out.push(id); };
  // [geo-fisica 2026-10-22] posição FÍSICA (GPS do SO, só c/ permissão já dada — services/physGeo.js)
  // vence o IP: a região mais perto do aparelho é medida SEMPRE e primeiro (Chile c/ IP de roaming
  // dos EUA → scl entra). A medição continua decidindo (home routing pode tornar o US melhor).
  const physNear = phys ? regionsNear(phys, L) : [];
  add(physNear[0]);
  // [client-lb 2026-10-22] melhor edge JÁ medido nesta rede vem primeiro; na troca de rede a
  // última boa e a atual entram SEMPRE (antes de qualquer palpite) e depois as regiões a até
  // GEO_RADIUS_KM da posição do IP (CF) — o país do CF pode mentir (roaming), a medição decide.
  add(remembered);
  if (netChange) {
    add(lastGood);
    add(current);
    for (const id of physNear) add(id);
    for (const id of regionsNear(geo || L.geo, L)) add(id);
  }
  // País (CF) e fuso intercalados: VPN/roaming fazem um dos dois mentir — medir resolve.
  // Rede onde a medição já contradisse o geo do CF (roaming c/ home routing): o geo não
  // ocupa vaga na frente — entra a vizinha mais próxima da que ganhou (explorar ao redor).
  const n = (near || []).filter(ok);
  const z = tzGuess(tz).filter(ok);
  const guess = geoBad
    ? [nearestTo(remembered, L, out), z[0], n[0]].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i)
    : [n[0], z[0], n[1], z[1]].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
  add(guess[0]);
  add(guess[1]);
  add(current);
  add(lastGood);
  if (mapOn) {
    // Roaming/VPN: fuso ou GPS apontam p/ região fora do `near` do IP → mede os hubs (a medição decide).
    const pz = physNear[0] || z[0];
    const roaming = !!(pz && n.length && !n.includes(pz));
    if (roaming) for (const id of (L.roam && L.roam.length ? L.roam : ROAM_HUBS)) { if (out.length >= max - 1) break; add(id); }
    for (const id of n.slice(1)) { if (out.length >= max - 1) break; add(id); }
  }
  if (!out.includes('us')) { if (out.length >= max) out.pop(); out.push('us'); }
  return out;
}

/** [geo-fisica 2026-10-22] Região utilizável (exceto US) mais perto da posição física, ou null. */
export function physNearest(phys, list) {
  if (!phys) return null;
  return regionsNear(phys, list || getList())[0] || null;
}

/** Região utilizável mais próxima (lat/lon do servidor) de `id`, fora de `skip`. */
export function nearestTo(id, list, skip) {
  const L = list || getList();
  const r0 = id ? regionById(id, L) : null;
  if (!r0) return null;
  let best = null, bd = Infinity;
  for (const r of usableRegions(L)) {
    if (r.id === id || r.id === 'us' || (skip && skip.includes(r.id))) continue;
    const dl = r.lat - r0.lat, dn = (r.lon - r0.lon) * Math.cos(((r.lat + r0.lat) / 2) * Math.PI / 180);
    const d = dl * dl + dn * dn;
    if (d < bd) { bd = d; best = r.id; }
  }
  return best;
}

export const _beats = (cand, cur, cfg) =>
  cand < cur * (1 - cfg.switch_ratio) && (cur - cand) > cfg.switch_ms;

// ── [lb-sticky 2026-10-23] SEGURAR o edge atual enquanto o RTT dele for bom ─────
// Visto 22-23/10 (founder em Santiago, scl 16 ms): o socket pulava scl→br/mex sem o scl
// piorar — boot restaurava região velha (br), memória do celular (mex) aplicada sem medir,
// e o placar com o pong do WS (passa pelo hub US: scl 397 ms) derrubava o scl. Regras:
//  (a) atual responde ao /health com RTT ≤ max(80 ms, 1,5× a melhor) → NÃO troca;
//  (b) troca voluntária só com vantagem GRANDE (≥40 % E ≥40 ms) em 3 medições espaçadas
//      (~45 s) da MESMA candidata — ou falha real (atual mudo/fora/inativa);
//  (c) nunca troca voluntariamente com envio pendente ou ligação (`busy`);
//  (d) troca de rede/boot = 1 reavaliação (1 medição basta, ainda c/ (a) e a margem grande).
// Decisão só pelo /health (sem o RTT do WS). Kill a quente: globalThis.__chatyy_lb_sticky = false.
export const STICKY = { abs_ms: 80, factor: 1.5, ratio: 0.40, ms: 40, confirm: 3, gap_ms: 45 * 1000 };
export function stickyOn() { try { return globalThis.__chatyy_lb_sticky !== false; } catch { return true; } }
/** (a) RTT do atual é "bom": ≤ max(80 ms, 1,5× o melhor medido). */
export function stickyHolds(curRtt, bestRtt) {
  if (!(typeof curRtt === 'number' && curRtt > 0)) return false;
  const b = typeof bestRtt === 'number' && bestRtt > 0 ? bestRtt : curRtt;
  return curRtt <= Math.max(STICKY.abs_ms, STICKY.factor * b);
}
/** (b) vantagem grande: ≥40 % E ≥40 ms. */
export function beatsBig(cand, cur) {
  return typeof cand === 'number' && typeof cur === 'number' && cand > 0
    && cand <= cur * (1 - STICKY.ratio) && (cur - cand) >= STICKY.ms;
}
/** Vale trocar de `cur` p/ `cand` (só RTTs): nem (a) segura, e (b) a margem é grande. */
export function stickyWouldSwitch(cand, cur) {
  if (!(typeof cand === 'number' && cand > 0)) return false;
  if (!(typeof cur === 'number' && cur > 0)) return true;
  return !stickyHolds(cur, cand) && beatsBig(cand, cur);
}

function _decideSticky({ ok, results, current, pending, session, now, L, base, busy, oneShot }) {
  const best = ok[0];
  if (!current) {
    // 1ª escolha (sem atual): fica no palpite (memória da rede/geo) se ele é "bom" pela regra (a).
    if (base && base !== best && typeof results[base] === 'number' && isUsable(regionById(base, L)) && !stickyWouldSwitch(results[best], results[base])) {
      return { pick: base, pending: null, kind: 'initial', why: 'first_base' };
    }
    return { pick: best, pending: null, kind: 'initial', why: 'first' };
  }
  if (!isUsable(regionById(current, L))) return { pick: best, pending: null, kind: 'failover', why: 'current_unusable' };
  const curRtt = results[current];
  if (typeof curRtt !== 'number') return { pick: best, pending: null, kind: 'failover', why: 'current_no_reply' };
  if (best === current) return { pick: current, pending: null, kind: 'keep', why: 'best' };
  if (stickyHolds(curRtt, results[best])) return { pick: current, pending: null, kind: 'keep', why: 'sticky' };
  if (!beatsBig(results[best], curRtt)) return { pick: current, pending: null, kind: 'keep', why: 'hysteresis' };
  // Vantagem grande nesta medição. Envio pendente/ligação → adia (não conta, não perde).
  if (busy) return { pick: current, pending: pending && pending.id === best ? pending : null, kind: 'keep', why: 'busy' };
  if (oneShot) return { pick: best, pending: null, kind: 'switch', why: 'net_' + Math.round(curRtt - results[best]) + 'ms' };
  const n = pending && pending.id === best ? (pending.n || 0) + 1 : 1;
  if (n < STICKY.confirm) return { pick: current, pending: { id: best, n }, kind: 'pending', why: 'confirm_' + n + '/' + STICKY.confirm };
  const s = session || {};
  if ((s.voluntary || 0) >= PIN_MAX_VOLUNTARY) return { pick: current, pending: null, kind: 'keep', why: 'pinned_max' };
  if (s.lastSwitchAt && now - s.lastSwitchAt < PIN_MIN_GAP_MS) return { pick: current, pending: { id: best, n }, kind: 'keep', why: 'pinned_gap' };
  return { pick: best, pending: null, kind: 'switch', why: 'faster_' + Math.round(curRtt - results[best]) + 'ms' };
}

/**
 * Decisão com histerese (exportada p/ teste).
 *   results: { [regionId]: rttMs | null }   (null = falhou/timeout)
 *   current: região atual (ou null)  ·  pending: { id, n } da medição anterior
 *   session: { voluntary, lastSwitchAt }   ·  cfg: { switch_ratio, switch_ms, confirm }
 * → { pick, pending, kind: 'keep'|'initial'|'switch'|'failover'|'pending', why }
 */
export function decide({ results, current, pending, session, cfg, now = Date.now(), list, base, sticky, busy = false, oneShot = false } = {}) {
  const C = { ...DEFAULT_CFG, ...(cfg || {}) };
  const L = list || getList();
  const ok = Object.keys(results || {})
    .filter((id) => typeof results[id] === 'number' && results[id] > 0 && isUsable(regionById(id, L)))
    .sort((a, b) => results[a] - results[b]);
  if (!ok.length) return { pick: current && isUsable(regionById(current, L)) ? current : 'us', pending: null, kind: 'keep', why: 'no_results' };
  if (sticky === undefined ? stickyOn() : sticky) return _decideSticky({ ok, results, current, pending, session, now, L, base, busy, oneShot });
  const best = ok[0];
  const curUsable = current && isUsable(regionById(current, L));
  if (!current) {
    // 1ª escolha: parte do palpite geo (near/fuso) e só sai dele se a melhor ganhar pela margem
    // (1 medição basta — ainda não há "troca"). Evita cair em região longe por 1 pico de ruído.
    if (base && base !== best && typeof results[base] === 'number' && isUsable(regionById(base, L)) && !_beats(results[best], results[base], C)) {
      return { pick: base, pending: null, kind: 'initial', why: 'first_base' };
    }
    return { pick: best, pending: null, kind: 'initial', why: 'first' };
  }
  if (!curUsable) return { pick: best, pending: null, kind: 'failover', why: 'current_unusable' };
  const curRtt = results[current];
  if (typeof curRtt !== 'number') {
    // Atual não respondeu ao /health nesta rodada → próxima (failover), não espera confirmar.
    return { pick: best, pending: null, kind: 'failover', why: 'current_no_reply' };
  }
  if (best === current || !_beats(results[best], curRtt, C)) return { pick: current, pending: null, kind: 'keep', why: 'hysteresis' };
  const n = pending && pending.id === best ? (pending.n || 0) + 1 : 1;
  if (n < C.confirm) return { pick: current, pending: { id: best, n }, kind: 'pending', why: 'confirm_' + n + '/' + C.confirm };
  const s = session || {};
  if ((s.voluntary || 0) >= PIN_MAX_VOLUNTARY) return { pick: current, pending: null, kind: 'keep', why: 'pinned_max' };
  if (s.lastSwitchAt && now - s.lastSwitchAt < PIN_MIN_GAP_MS) return { pick: current, pending: { id: best, n }, kind: 'keep', why: 'pinned_gap' };
  return { pick: best, pending: null, kind: 'switch', why: 'faster_' + Math.round(curRtt - results[best]) + 'ms' };
}

/** Ranking p/ failover: medidas (RTT crescente), depois não medidas na ordem da lista; US por último. */
export function rankRegions(results, list) {
  const L = list || getList();
  const us = usableRegions(L).filter((r) => r.id !== 'us').map((r) => r.id);
  const m = us.filter((id) => results && typeof results[id] === 'number').sort((a, b) => results[a] - results[b]);
  const rest = us.filter((id) => !m.includes(id));
  return [...m, ...rest, 'us'];
}

// ── Estado persistido (última boa / RTTs) ──────────────────────────────────
export function loadState() {
  try { const raw = _mm()?.getString(STATE_KEY); if (raw) { const p = JSON.parse(raw); if (p && typeof p === 'object') return p; } } catch {}
  return null;
}
export function saveState(st) { try { _mm()?.setString(STATE_KEY, JSON.stringify(st)); } catch {} }

// ── [client-lb 2026-10-22] Rede: assinatura local, chave e memória por rede ─
// Assinatura LOCAL (sem servidor, sem permissão extra): tipo + SSID/BSSID (só se o SO já
// entregar — iOS só com localização, Android idem → normalmente ausente) + IP local/sub-rede
// + operadora. Serve p/ DETECTAR troca de rede (Wi-Fi↔Wi-Fi, celular com IP novo).
// Chave da MEMÓRIA (estável entre sessões): tipo + hash SSID/BSSID; sem isso, tipo + hash do
// IP público /24 (servidor) [+ ASN]; chave grossa = tipo + /16 (ou ASN) p/ CGNAT que gira o /24.
export function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}
function _netState() { try { return require('./networkInfo').getNetworkState() || null; } catch { return null; } }
const _BAD_SSID = /^(<unknown ssid>|unknown|0x|)$/i;
const _BAD_BSSID = /^(02:00:00:00:00:00|00:00:00:00:00:00|)$/;
function _wifiId(st) {
  if (!st) return null;
  const ss = typeof st.ssid === 'string' && !_BAD_SSID.test(st.ssid.trim()) ? st.ssid.trim() : '';
  const bs = typeof st.bssid === 'string' && !_BAD_BSSID.test(st.bssid.trim()) ? st.bssid.trim().toLowerCase() : '';
  return (ss || bs) ? fnv1a(ss + '|' + bs) : null;
}
export function netSignature(stIn) {
  const st = stIn || _netState();
  if (!st || st.isConnected === false) return null;
  const t = st.type && st.type !== 'unknown' && st.type !== 'none' ? String(st.type) : null;
  if (!t) return null;
  return [t, _wifiId(st) || '', st.ipAddress || '', st.subnet || '', st.carrier || ''].join('|');
}
/** → { key, coarse, src } | null. key null = rede conhecida só pelo tipo (lista ainda de outra rede). */
export function netKeys(stIn, listIn) {
  const st = stIn || _netState();
  const sig = netSignature(st);
  if (!sig) return null;
  const t = sig.split('|')[0];
  const w = _wifiId(st);
  if (w) return { key: t + ':w' + w, coarse: null, src: 'wifi', type: t };
  const L = listIn || _loadList();
  const n = L && L.net && L.sig === sig ? L.net : null;
  if (!n) return { key: null, coarse: null, src: 'type', type: t };
  return {
    key: t + ':p' + n.p + (n.asn ? ':a' + n.asn : ''),
    coarse: n.asn ? t + ':a' + n.asn : (n.p16 ? t + ':q' + n.p16 : null),
    src: 'ip', type: t,
  };
}
/** Lista buscada em OUTRA rede (hash do IP não vale aqui) → o api.js força o refresh. */
export function listNetStale() {
  const L = _loadList();
  if (!L) return true;
  const sig = netSignature();
  return !!sig && L.sig !== sig;
}

const NETMEM_KEY = 'client_lb_netmem_v1';
const NETMEM_MAX = 32;
const NETMEM_TTL_MS = 14 * 24 * 60 * 60 * 1000;
let _netMem = null;
function _nm() {
  if (_netMem) return _netMem;
  try { const raw = _mm()?.getString(NETMEM_KEY); const p = raw ? JSON.parse(raw) : null; _netMem = p && typeof p === 'object' ? p : {}; } catch { _netMem = {}; }
  return _netMem;
}
/** Melhor edge lembrado p/ esta rede (chave exata, senão a grossa). → { reg, rtt, at, geoBad, ws, hit } | null */
export function netMemGet(keys) {
  if (!keys) return null;
  const m = _nm();
  const now = Date.now();
  for (const [k, hit] of [[keys.key, 'key'], [keys.coarse, 'coarse']]) {
    const e = k && m[k];
    if (e && typeof e.reg === 'string' && ID_RE.test(e.reg) && now - (Number(e.at) || 0) < NETMEM_TTL_MS) return { ...e, hit };
  }
  return null;
}
export function netMemPut(keys, rec) {
  if (!keys || !rec || !rec.reg) return;
  const m = _nm();
  const e = { reg: rec.reg, at: Date.now(), geoBad: !!rec.geoBad, rtt: rec.rtt || null, ws: rec.ws || null };
  if (keys.key) m[keys.key] = e;
  if (keys.coarse) m[keys.coarse] = { ...e, coarse: 1 };
  const ks = Object.keys(m);
  if (ks.length > NETMEM_MAX) ks.sort((a, b) => (m[a].at || 0) - (m[b].at || 0)).slice(0, ks.length - NETMEM_MAX).forEach((k) => { delete m[k]; });
  try { _mm()?.setString(NETMEM_KEY, JSON.stringify(m)); } catch {}
}

// ── [client-lb 2026-10-22] RTT do WS (ping/pong) por região, por rede ──────
// Alimentado pelo websocket.js (pong limpo, app visível). Guarda as últimas amostras da
// região em que o socket está DE FATO (o nativo antigo pode ir ao US mesmo com HTTP regional).
const _wsRtt = {}; // `${netKey}|${region}` → { s: [ms…], at }
const WS_RTT_FRESH_MS = 10 * 60 * 1000;
export function noteWsRtt(netKey, region, ms) {
  if (!region || !ID_RE.test(region) || !(ms > 0) || ms > 5000) return;
  const k = (netKey || '-') + '|' + region;
  const e = _wsRtt[k] || (_wsRtt[k] = { s: [], at: 0 });
  e.s.push(Math.round(ms));
  if (e.s.length > 7) e.s.shift();
  e.at = Date.now();
}
/** Mediana das amostras frescas (≥3) da região nesta rede, ou null. */
export function wsRttFor(netKey, region) {
  const e = _wsRtt[(netKey || '-') + '|' + region];
  if (!e || e.s.length < 3 || Date.now() - e.at > WS_RTT_FRESH_MS) return null;
  const a = [...e.s].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}
/** Placar = /health misturado com o RTT do WS (peso cfg.ws_weight) onde houver amostra. */
export function blendScores(results, netKey, weight) {
  const w = _clamp(Number(weight), 0, 1, DEFAULT_CFG.ws_weight);
  const out = {}; const ws = {};
  for (const id of Object.keys(results || {})) {
    const h = results[id];
    const r = wsRttFor(netKey, id);
    if (r != null) ws[id] = r;
    out[id] = (typeof h === 'number' && r != null && w > 0) ? Math.max(1, Math.round((1 - w) * h + w * r)) : h;
  }
  return { scores: out, ws };
}

/** Conta liberada p/ WS no leaf mesmo com nativo antigo (lista do servidor). */
export function wsLeafFor(email) {
  try {
    if (globalThis.__chatyy_ws_leaf_first === false) return false;
    if (globalThis.__chatyy_ws_leaf_first === true) return true;
  } catch {}
  const w = getList().wsLeaf;
  if (!w) return false;
  if (w.all) return true;
  const e = String(email || '').trim().toLowerCase();
  return !!e && w.acc.includes(fnv1a(e));
}

/**
 * [quic-proto 2026-10-23] cfg.quic p/ o transporte nativo (iOS quicVersion ≥ 1 / Android quicProtoInfo) ou null.
 * Só quando o SERVIDOR liberou a conta: lista com transport.quic=1 + noise=1 (e, se vier
 * transport.acc, o FNV-1a do e-mail — normal ou canônico @chatyy.com.br — está nela).
 * O nativo ainda exige a flag LOCAL (App Group) e sem kill. Kill JS: __chatyy_quic = false.
 */
export function quicTransportFor(email) {
  try { if (globalThis.__chatyy_quic === false) return null; } catch {}
  try { if (Platform.OS === 'web') return null; } catch { return null; }
  const l = getList();
  const t = l && l.transport;
  if (!t || !t.quic || !t.noise) return null;
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  if (t.acc) {
    const canon = e.replace(/@onemundo\.com\.br$/, '@chatyy.com.br');
    if (!t.acc.includes(fnv1a(e)) && !t.acc.includes(fnv1a(canon))) return null;
  }
  const regions = {};
  for (const r of l.regions || []) {
    if (r && r.q && r.nk && r.id !== 'us') regions[r.id] = { kid: r.nk, port: r.qp || 443 };
  }
  if (!Object.keys(regions).length) return null;
  return { on: true, noise: true, noiseTest: !!t.noise_test, regions, hsMs: 1500, migrate: true };
}

// ── Economia de bateria/dados ──────────────────────────────────────────────
export function isEconomy() {
  try { if (require('./liveLocTickGate').isLowBatteryNow?.()) return true; } catch {}
  try { if (require('./mediaCache').isDataSaverOn?.()) return true; } catch {}
  return false;
}

// ── Telemetria ─────────────────────────────────────────────────────────────
let _beaconTimes = {};
let _beaconDay = '';
let _beaconCount = 0;
function _installId() {
  try {
    const mm = _mm();
    let v = mm?.getString(ID_KEY);
    if (!v || !/^[a-z0-9]{10,16}$/.test(v)) {
      v = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
      try { mm?.setString(ID_KEY, v); } catch {}
    }
    return v;
  } catch { return ''; }
}
function _appVer() {
  try { const C = require('expo-constants').default; return String(C?.expoConfig?.version || ''); } catch { return ''; }
}
/** ev: pick | switch | failover | measure. Limites: 1 por tipo/10 min (failover 1/min), 40/dia. */
export function beacon(ev, data = {}) {
  try {
    const l = getList();
    if (l.cfg && l.cfg.beacon === false) return;
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== _beaconDay) { _beaconDay = day; _beaconCount = 0; _beaconTimes = {}; }
    const gap = ev === 'failover' ? 60 * 1000 : 10 * 60 * 1000;
    if (ev !== 'switch' && _beaconTimes[ev] && now - _beaconTimes[ev] < gap) return;
    if (_beaconCount >= 40) return;
    _beaconTimes[ev] = now; _beaconCount++;
    const body = { ev, ...data, tz: deviceTz(), os: Platform.OS, av: _appVer(), d: _installId(), eco: isEconomy() ? 1 : 0 };
    try {
      const rt = data.rtt ? Object.keys(data.rtt).map((k) => k + '=' + data.rtt[k]).join(',') : '-';
      require('./crashReporter').reportStep?.('client_lb', `ev=${ev} reg=${data.reg || '-'} org=${data.org || '-'} prev=${data.prev || '-'} why=${data.why || '-'} rtt=${rt} net=${data.net || '-'}`);
    } catch {}
    fetch(LIST_URL + '?b=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  } catch {}
}

export default {
  getList, refreshList, isClientLbOn, isUsable, usableRegions, regionById, pickCandidates, decide,
  rankRegions, loadState, saveState, isEconomy, beacon, tzGuess, deviceTz, validateList, regionsNear, distKm,
  netSignature, netKeys, listNetStale, netMemGet, netMemPut, noteWsRtt, wsRttFor, blendScores, wsLeafFor, fnv1a, nearestTo, quicTransportFor,
  physNearest, stickyOn, stickyHolds, beatsBig, stickyWouldSwitch, STICKY,
};
