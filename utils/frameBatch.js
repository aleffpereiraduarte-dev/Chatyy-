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
export function createFrameBatcher({ maxDelay = 64, frames = 1, label = 'frameBatch' } = {}) {
  let queue = [];
  let raf = null;
  let timer = null;
  let disposed = false;

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
    if (disposed || queue.length === 0) return;
    const items = queue;
    queue = [];
    if (typeof unstable_batchedUpdates === 'function') {
      try { unstable_batchedUpdates(runAll, items); return; } catch {}
    }
    runAll(items);
  };

  const schedule = () => {
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
    wrap(fn) {
      if (typeof fn !== 'function') return fn;
      return function batchedHandler(...args) {
        if (disposed) return;
        queue.push({ fn, args });
        schedule();
      };
    },
    flush,
    dispose() {
      disposed = true;
      queue = [];
      if (raf != null) { try { cancelAnimationFrame(raf); } catch {} raf = null; }
      if (timer != null) { clearTimeout(timer); timer = null; }
    },
  };
}

export default createFrameBatcher;
