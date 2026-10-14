// [2026-10-11 fluidez-2] Frame batcher p/ eventos de tempo real.
//
// Cada frame WS/TCP chega numa task própria do event loop. Uma mensagem
// recebida dispara vários eventos em rajada (chat_message + chat_summary +
// stopped_typing + presence + recibos…) e cada um fazia o seu setState numa
// task separada ⇒ 3-4 renders da TELA INTEIRA por mensagem. O batcher enfileira
// os handlers e roda todos juntos no próximo frame (requestAnimationFrame,
// com teto de `maxDelay` ms p/ quando o rAF está pausado — aba oculta / app em
// 2º plano), dentro de unstable_batchedUpdates ⇒ 1 commit por frame.
//
// Ordem FIFO preservada entre todos os handlers do mesmo batcher. Um handler
// que lança não derruba os outros do lote.
import { unstable_batchedUpdates } from 'react-native';

// `frames`: quantos frames esperar antes de aplicar (2 = junta também eventos
// que chegam no frame seguinte — ex.: chat_message + chat_read do mesmo envio
// vêm por POSTs separados ao hub e chegam com ~5-20 ms de diferença).
// [2026-10-14 grupo-rajada] Opcional (padrão desligado = comportamento antigo):
//   • lowDelay: handlers marcados `wrap(fn, { low: true })` (recibos ✓✓/azul,
//     presença) NÃO agendam commit próprio — esperam até `lowDelay` ms ou vão
//     junto no próximo lote de eventos visíveis (FIFO preservado).
//   • busyRate/busyDelay: com ≥ busyRate eventos visíveis no último 1 s (grupo
//     com várias pessoas falando ao mesmo tempo), o lote espera `busyDelay` ms em
//     vez de 1-2 frames → 3-5 commits/s em vez de 1 por mensagem (medido: 200
//     msgs/30 s num grupo = 150 long tasks / 16 s de thread principal, CPU 4x).
export function createFrameBatcher({ maxDelay = 64, frames = 1, label = 'frameBatch', lowDelay = 0, busyRate = 0, busyDelay = 0 } = {}) {
  let queue = [];
  let raf = null;
  let timer = null;
  let disposed = false;
  let lowTimer = null;
  let hasHigh = false;
  const recent = []; // timestamps (ms) dos eventos visíveis no último 1 s
  const _now = () => Date.now();
  const isBusy = () => {
    if (!(busyRate > 0 && busyDelay > 0)) return false;
    const t = _now();
    while (recent.length && t - recent[0] > 1000) recent.shift();
    return recent.length >= busyRate;
  };

  const runAll = (items) => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      try { it.fn.apply(null, it.args); } catch (e) {
        try { console.warn(`[${label}] handler threw`, e && e.message); } catch {}
      }
    }
  };

  const flush = () => {
    if (raf != null) {
      try { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf); } catch {}
      raf = null;
    }
    if (timer != null) { clearTimeout(timer); timer = null; }
    if (lowTimer != null) { clearTimeout(lowTimer); lowTimer = null; }
    hasHigh = false;
    if (disposed || queue.length === 0) return;
    const items = queue;
    queue = [];
    if (typeof unstable_batchedUpdates === 'function') {
      try { unstable_batchedUpdates(runAll, items); return; } catch {}
    }
    runAll(items);
  };

  const scheduleLow = () => {
    if (hasHigh || lowTimer != null) return;
    lowTimer = setTimeout(flush, lowDelay);
  };
  const schedule = () => {
    hasHigh = true;
    if (busyRate > 0 && busyDelay > 0) {
      recent.push(_now());
      if (recent.length > busyRate * 4) recent.splice(0, recent.length - busyRate * 4);
      if (isBusy()) {
        // rajada: um timer só (o 1º evento do lote decide), sem rAF
        if (raf != null) { try { cancelAnimationFrame(raf); } catch {} raf = null; }
        if (timer == null) timer = setTimeout(flush, busyDelay);
        return;
      }
    }
    if (raf == null && typeof requestAnimationFrame === 'function') {
      let left = Math.max(1, frames | 0);
      const tick = () => {
        left -= 1;
        if (left <= 0) { flush(); return; }
        try { raf = requestAnimationFrame(tick); } catch { flush(); }
      };
      try { raf = requestAnimationFrame(tick); } catch { raf = null; }
    }
    if (timer == null) timer = setTimeout(flush, maxDelay);
  };

  return {
    // Devolve um handler que enfileira a chamada (mesmos argumentos).
    wrap(fn, opts) {
      if (typeof fn !== 'function') return fn;
      const low = !!(opts && opts.low) && lowDelay > 0;
      return function batchedHandler(...args) {
        if (disposed) return;
        queue.push({ fn, args });
        if (low) scheduleLow(); else schedule();
      };
    },
    flush,
    dispose() {
      disposed = true;
      queue = [];
      if (raf != null) { try { cancelAnimationFrame(raf); } catch {} raf = null; }
      if (timer != null) { clearTimeout(timer); timer = null; }
      if (lowTimer != null) { clearTimeout(lowTimer); lowTimer = null; }
    },
  };
}

export default createFrameBatcher;
