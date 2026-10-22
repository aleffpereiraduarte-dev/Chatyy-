// services/watchSync.js — [assistir-junto sync 2026-10-22] núcleo da sincronia do "Assistir/Ouvir junto".
//
// Puro (sem React Native): usado pelo services/watchTogether (relógio) e pelo components/watch/WatchPlayer
// (correção contínua), e também pelo script de medição de deriva (node, /root/assistir-2026-10-22).
//
// Relógio (NTP-like): cada amostra = {t0, t3} locais + carimbo(s) do servidor.
//   • com t1/t2 (HTTP watch_time novo): offset = ((t1 - t0) + (t2 - t3)) / 2 · atraso = (t3 - t0) - (t2 - t1)
//   • só server_ts (watch_pong do hub, PHP antigo): offset = ts - (t0 + t3) / 2 · atraso = t3 - t0
//   Guarda as últimas 16 amostras (10 min); estimativa = MEDIANA dos offsets da metade com menor atraso
//   (amostra com fila/retransmissão no caminho fica de fora).
//
// Correção (por tique, 250 ms): diferença = posição esperada (pos + (agoraServidor - server_ts) * rate) − posição do player,
//   suavizada (média móvel exponencial, reinicia em salto).
//   |dif| < 80 ms → nada · 80 ms–1 s → playbackRate 0,95–1,05 proporcional (sai com < 30 ms) · > 1 s → seek
//   p/ frente com folga aprendida (tempo de carregar) + partida alinhada (fica pausado até a sala alcançar).
//   Pausado/esperando: posição fixa; |dif| > 150 ms → seek exato.

export const SYNC = {
  IGNORE: 0.08,     // s — abaixo disso não mexe
  EXIT: 0.03,       // s — saiu da correção por velocidade
  SEEK: 1.0,        // s — acima disso salta
  RATE_SPAN: 0.05,  // ±5 % (0,95–1,05)
  RATE_MIN_STEP: 0.01,
  TAU: 3,           // s — dif / TAU = quanto acelera (dif 0,15 s → 5 %)
  PAUSED_SEEK: 0.06,
  REALIGN: 0.15,    // s — parado e atrás mais que isso → salta de novo antes de começar
};

// ─── relógio ────────────────────────────────────────────────────────────────
export function makeClock(opts) {
  const max = (opts && opts.max) || 16;
  const ttl = (opts && opts.ttl) || 10 * 60 * 1000;
  let samples = [];
  let est = null; // {offset, rtt, n}
  const recompute = (nowLocal) => {
    samples = samples.filter((s) => nowLocal - s.at <= ttl).slice(-max);
    if (!samples.length) { est = null; return; }
    const byRtt = samples.slice().sort((a, b) => a.rtt - b.rtt);
    const best = byRtt.slice(0, Math.max(1, Math.ceil(byRtt.length / 2)));
    const offs = best.map((s) => s.offset).sort((a, b) => a - b);
    const m = offs.length;
    const med = m % 2 ? offs[(m - 1) / 2] : (offs[m / 2 - 1] + offs[m / 2]) / 2;
    est = { offset: med, rtt: best[0].rtt, n: samples.length };
  };
  return {
    /** {t0, t3, ts} ou {t0, t3, t1, t2} (ms). Devolve a amostra aceita ou null. */
    add(x) {
      if (!x) return null;
      const t0 = Number(x.t0); const t3 = Number(x.t3);
      if (!Number.isFinite(t0) || !Number.isFinite(t3) || t3 < t0) return null;
      let offset; let rtt;
      const t1 = Number(x.t1); const t2 = Number(x.t2);
      if (Number.isFinite(t1) && t1 > 0 && Number.isFinite(t2) && t2 >= t1) {
        offset = ((t1 - t0) + (t2 - t3)) / 2;
        rtt = Math.max(0, (t3 - t0) - (t2 - t1));
      } else {
        const ts = Number(x.ts);
        if (!Number.isFinite(ts) || ts <= 0) return null;
        offset = ts - (t0 + t3) / 2;
        rtt = t3 - t0;
      }
      if (!Number.isFinite(offset) || Math.abs(offset) > 365 * 86400000 || rtt > 15000) return null;
      const s = { offset, rtt, at: t3 };
      samples.push(s);
      recompute(t3);
      return s;
    },
    offset() { return est ? est.offset : null; },
    rtt() { return est ? est.rtt : null; },
    count() { return samples.length; },
    estimate() { return est ? { ...est } : null; },
    reset() { samples = []; est = null; },
  };
}

// ─── posição esperada ───────────────────────────────────────────────────────
/** Posição (s) do estado autoritativo no instante de servidor `at` (ms). Igual a wtPosAt (PHP) e posAt (hub). */
export function expectedPosition(s, at) {
  if (!s) return 0;
  const pos = Number(s.pos) || 0;
  if (!s.playing) return pos;
  let from = Number(s.server_ts) || at;
  const hold = s.hold && Number(s.hold.until);
  if (hold) { if (at <= hold) return pos; from = Math.max(from, hold); }
  const p = pos + Math.max(0, at - from) / 1000 * (Number(s.rate) || 1);
  const dur = Number(s.item && s.item.dur) || 0;
  return dur > 0 ? Math.min(p, dur) : p;
}

// ─── controlador de deriva ──────────────────────────────────────────────────
/**
 * Controlador por player. step() recebe a medida do tique e devolve o que fazer:
 *   in: {now (ms locais), target (s), cur (s), want (deve tocar), ready (player pronto), playing (player tocando),
 *        noPause (não segurar pausado: 2º plano)}
 *   out: {rate (multiplicador sobre o rate da sala), seek (s|null), wait (true = segura o player pausado neste tique),
 *         diff (s, suavizada|null), mode}
 * Partida alinhada (igual SharePlay): sempre que o player vai COMEÇAR a tocar (play, depois de seek, fim da espera,
 * entrada) e está adiantado em relação à posição esperada, fica pausado até a sala "alcançar" e só então toca
 * (descontando o tempo que o player leva p/ começar, aprendido). Atrasado > 1 s → salta p/ frente com folga
 * (folga aprendida = quanto o seek demora p/ carregar) e espera alinhar.
 */
export function createDriftController(cfg) {
  const C = { ...SYNC, ...(cfg || {}) };
  const st = { mode: 'idle', rate: 1, ema: null, lead: 0.5, startLead: 0.12, seekAt: 0, startedAt: 0, measured: true, tries: 0 };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const out = (o) => ({ rate: 1, seek: null, wait: false, diff: null, mode: st.mode, ...o });
  const ctl = {
    state: st,
    noteSeek(now) { st.seekAt = now; st.ema = null; st.mode = 'align'; },
    reset() { st.mode = 'idle'; st.rate = 1; st.ema = null; st.seekAt = 0; st.measured = true; },
    step(m) {
      const now = Number(m.now) || 0;
      const target = Number(m.target) || 0;
      const cur = Number(m.cur) || 0;
      const diff = target - cur; // > 0 = atrás
      if (!m.ready) return out({ rate: 1, wait: st.mode === 'align', diff: null });
      if (!m.want) {
        st.rate = 1; st.ema = null; st.tries = 0;
        // salto de alinhamento em curso (com folga p/ frente) não segura a correção da pausa por muito tempo
        const guard = st.mode === 'align' ? 300 : 800;
        st.mode = 'idle';
        if (Math.abs(diff) > C.PAUSED_SEEK && now - st.seekAt > guard) {
          st.seekAt = now; st.mode = 'idle';
          return out({ seek: Math.max(0, target), diff });
        }
        return out({ diff });
      }
      // ── player parado (vai começar) ou alinhando depois de um seek ──
      // noPause (música em 2º plano): não segura o player pausado (o iOS pode suspender o app sem áudio) → só velocidade
      if (m.noPause && m.playing && st.mode === 'align') { st.mode = 'idle'; st.seekAt = 0; st.tries = 0; }
      if (!m.playing || st.mode === 'align') {
        const ahead = -diff;
        if (st.mode === 'align' && st.seekAt) {
          // o seek terminou (pronto): aprende a folga — ficou atrás = carregou mais devagar que a folga
          if (ahead < 0) st.lead = clamp(st.lead + (-ahead) + 0.1, 0.2, 2);
          else if (ahead > 0.9) st.lead = clamp(st.lead - 0.5 * (ahead - 0.4), 0.2, 2);
          st.seekAt = 0;
        }
        // atrasado demais p/ só acelerar → salta c/ folga e espera alinhar. Parado (nada visível muda) refaz o
        // salto já com 150 ms de atraso, até 3 vezes seguidas — a partida sai alinhada em vez de "correr atrás".
        if (diff > C.SEEK || (diff > C.REALIGN && st.tries < 3)) {
          st.tries += 1;
          st.seekAt = now; st.mode = 'align'; st.ema = null;
          return out({ seek: target + st.lead, wait: true, diff, mode: 'align' });
        }
        if (ahead > 2.5) { st.seekAt = now; st.mode = 'align'; return out({ seek: Math.max(0, target), wait: true, diff }); }
        if (ahead > st.startLead) { st.mode = 'align'; return out({ wait: true, diff, mode: 'align' }); }
        // alinhado: toca agora (o player leva ~startLead p/ andar)
        st.mode = 'idle'; st.ema = null; st.startedAt = now; st.measured = false; st.tries = 0;
        return out({ diff, mode: 'start' });
      }
      // ── tocando: mede, aprende o atraso de partida, corrige ──
      if (!st.measured && now - st.startedAt > 700) {
        st.measured = true;
        if (Math.abs(diff) < 0.6) st.startLead = clamp(st.startLead + 0.5 * diff, 0, 0.5);
      }
      if (st.ema === null || Math.abs(diff - st.ema) > 0.5) st.ema = diff;
      else st.ema += 0.35 * (diff - st.ema);
      const e = st.ema;
      const ae = Math.abs(e);
      if (ae > C.SEEK || Math.abs(diff) > C.SEEK * 2.5) {
        st.seekAt = now; st.mode = 'align'; st.ema = null; st.rate = 1;
        return out({ seek: e > 0 ? target + st.lead : Math.max(0, target), wait: true, diff: e, mode: 'align' });
      }
      if (st.mode === 'rate' && ae < C.EXIT) st.mode = 'idle';
      else if (st.mode === 'idle' && ae > C.IGNORE) st.mode = 'rate';
      if (st.mode === 'rate') {
        let d = clamp(e / C.TAU, -C.RATE_SPAN, C.RATE_SPAN);
        if (Math.abs(d) < C.RATE_MIN_STEP) d = d < 0 ? -C.RATE_MIN_STEP : C.RATE_MIN_STEP;
        st.rate = Math.round((1 + d) * 200) / 200; // passos de 0,5 %
      } else st.rate = 1;
      return out({ rate: st.rate, diff: e });
    },
  };
  return ctl;
}

/** Folga do "play" (s): quem dá play manda a posição um pouco ANTES de onde parou → todos (inclusive quem
 *  apertou) esperam esse tempo pausados e começam juntos, mesmo com latências diferentes (partida agendada). */
export const PLAY_LEAD = 0.35;

/**
 * Detector de travada: player "tocando" mas o tempo não anda (Android/iOS nem sempre trocam o status p/ loading).
 * feed({now, cur, playing}) → true enquanto travado há > stallMs.
 */
export function createStallDetector(stallMs = 700) {
  let lastCur = -1; let lastMoveAt = 0;
  return {
    reset(now) { lastCur = -1; lastMoveAt = now || 0; },
    feed(now, cur, playing) {
      if (!playing) { lastCur = cur; lastMoveAt = now; return false; }
      if (lastCur < 0 || Math.abs(cur - lastCur) > 0.02) { lastCur = cur; lastMoveAt = now; return false; }
      return now - lastMoveAt > stallMs;
    },
  };
}
