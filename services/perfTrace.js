// services/perfTrace.js — [2026-10-20 perf-js] "o que o JS estava fazendo" quando travou.
//
// js_stall (freezeWatch) dizia só a rota: 29–37 s em /chat-conversation no iOS sem
// pista de origem. Aqui fica um anel MINÚSCULO das últimas ações (tag curta, sem
// conteúdo/ids) + o custo dos trechos medidos (traceSpan). O freezeWatch anexa as
// ações anteriores ao início da trava (la=) e os trechos mais lentos (sp=) ao
// js_stall/perf/prev_end — a última ação registrada ANTES do início da trava é a
// suspeita (com o JS bloqueado ninguém mais registra nada).
//
// Custo: 1 Date.now() + 1 escrita em array por ação. Sem I/O, sem alocação de
// objeto por ação. Kill switch (OTA): globalThis.__chatyy_perf_trace = false.

const RING = 16;
const _t = new Array(RING).fill(0);
const _a = new Array(RING).fill('');
let _i = 0;
// tag → [n, soma ms, máx ms] dos trechos ≥ SPAN_MIN_MS
const SPAN_MIN_MS = 30;
const SPAN_MAX_TAGS = 24;
let _spans = Object.create(null);
let _spanTags = 0;

function _off() {
  try { return globalThis.__chatyy_perf_trace === false; } catch { return false; }
}

/** Marca uma ação (tag curta e estável, ex.: 'ws:new_message', 'conv:load_more'). */
export function traceAction(tag) {
  if (_off()) return;
  const k = _i % RING;
  _t[k] = Date.now();
  _a[k] = String(tag || '?').slice(0, 32);
  _i = (_i + 1) % (RING * 1000000);
}

/** Registra a duração de um trecho já medido (ms). Só guarda ≥ 30 ms. */
export function traceSpan(tag, ms) {
  if (!(ms >= SPAN_MIN_MS) || _off()) return;
  const k = String(tag || '?').slice(0, 32);
  let e = _spans[k];
  if (!e) {
    if (_spanTags >= SPAN_MAX_TAGS) return;
    _spanTags += 1;
    e = _spans[k] = [0, 0, 0];
  }
  e[0] += 1; e[1] += ms; if (ms > e[2]) e[2] = ms;
}

/**
 * Mede fn() e devolve o resultado (exceções propagam). Marca a ação ANTES de
 * rodar — se fn travar o JS, ela é a última do anel.
 */
export function traced(tag, fn) {
  traceAction(tag);
  const t0 = Date.now();
  try { return fn(); } finally { traceSpan(tag, Date.now() - t0); }
}

/**
 * Últimas n ações até `atMs` (início da trava), mais recentes primeiro:
 * "ws:typing@-40,conv:render@-310" (ms antes do início).
 */
export function lastActions(atMs, n = 4) {
  try {
    const at = Number(atMs) || Date.now();
    const out = [];
    for (let j = 1; j <= RING && out.length < n; j++) {
      const k = (((_i - j) % RING) + RING) % RING;
      const t = _t[k];
      if (!t) break;
      if (t > at + 5) continue; // depois do início = já é a recuperação
      out.push(`${_a[k]}@-${Math.max(0, at - t)}`);
    }
    return out.join(',') || '-';
  } catch { return '-'; }
}

/** Top n trechos por máximo: "ws:new_message:3/412,conv:rows:9/88" (n/máx ms). */
export function topSpans(n = 4) {
  try {
    return Object.keys(_spans)
      .sort((x, y) => _spans[y][2] - _spans[x][2])
      .slice(0, n)
      .map((k) => `${k}:${_spans[k][0]}/${Math.round(_spans[k][2])}`)
      .join(',') || '-';
  } catch { return '-'; }
}

/** Zera os trechos (depois de enviados no beacon perf). */
export function resetSpans() { _spans = Object.create(null); _spanTags = 0; }
