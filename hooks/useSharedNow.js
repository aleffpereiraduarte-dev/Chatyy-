// [2026-10-15 ticker-unico] Relógio compartilhado para "re-renderizar a cada N s"
// (contagem de mensagem temporária, "há 20 s" no mapa…).
//
// Antes cada tela tinha o próprio setInterval rodando sempre — inclusive com a
// tela coberta por outra no stack ou o app em segundo plano. Agora:
//   • UM timer por período para todos os assinantes (setActiveInterval: para
//     em segundo plano / aba oculta);
//   • a tela só assina enquanto está FOCADA (fora de foco não re-renderiza);
//   • ao voltar o foco, se a última leitura passou de `ms`, atualiza uma vez.
import { useContext, useEffect, useState } from 'react';
import { NavigationContext } from '@react-navigation/native';
import { setActiveInterval } from '../utils/activeInterval';

const _tickers = new Map(); // ms -> { subs:Set<fn>, stop }

function _subscribe(ms, fn) {
  let t = _tickers.get(ms);
  if (!t) {
    t = { subs: new Set(), stop: null };
    _tickers.set(ms, t);
    const tt = t;
    tt.stop = setActiveInterval(() => {
      const now = Date.now();
      for (const f of Array.from(tt.subs)) { try { f(now); } catch {} }
    }, ms);
  }
  t.subs.add(fn);
  return () => {
    const cur = _tickers.get(ms);
    if (!cur) return;
    cur.subs.delete(fn);
    if (cur.subs.size === 0) {
      try { cur.stop && cur.stop(); } catch {}
      _tickers.delete(ms);
    }
  };
}

// Foco sem lançar fora de um navigator (useIsFocused lança sem contexto).
function useFocusedSafe() {
  const nav = useContext(NavigationContext);
  const [focused, setFocused] = useState(() => {
    try { return nav ? nav.isFocused() : true; } catch { return true; }
  });
  useEffect(() => {
    if (!nav) return undefined;
    try { setFocused(nav.isFocused()); } catch {}
    let a = null; let b = null;
    try { a = nav.addListener('focus', () => setFocused(true)); } catch {}
    try { b = nav.addListener('blur', () => setFocused(false)); } catch {}
    return () => { try { a && a(); } catch {} try { b && b(); } catch {} };
  }, [nav]);
  return focused;
}

/**
 * @param {number} ms período do tique
 * @param {boolean} [enabled=true] false → não assina (valor congela)
 * @returns {number} Date.now() do último tique entregue a esta tela
 */
export function useSharedNow(ms, enabled = true) {
  const focused = useFocusedSafe();
  const [now, setNow] = useState(() => Date.now());
  const on = !!enabled && focused;
  useEffect(() => {
    if (!on) return undefined;
    // Voltou o foco/ligou: alcança o relógio se ficou para trás.
    setNow((prev) => (Date.now() - prev >= ms ? Date.now() : prev));
    return _subscribe(ms, setNow);
  }, [ms, on]);
  return now;
}

export default useSharedNow;
