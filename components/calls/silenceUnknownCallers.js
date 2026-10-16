// components/calls/silenceUnknownCallers.js — [2026-10-16 wave12-D]
// Estado ÚNICO de "Silenciar chamadas desconhecidas" (AsyncStorage
// `silence_unknown_callers`, lido por IncomingCallListener). Usado pelo cartão
// da aba Ligações e por Configurações > Privacidade — os dois ficam em sincronia.
import { useEffect, useState } from 'react';

const KEY = 'silence_unknown_callers';
const _listeners = new Set();
let _value = null; // null = ainda não lido

function _AS() { return require('@react-native-async-storage/async-storage').default; }

export async function loadSilenceUnknownCallers() {
  try { _value = (await _AS().getItem(KEY)) === 'true'; } catch { if (_value == null) _value = false; }
  _listeners.forEach((fn) => { try { fn(_value); } catch {} });
  return _value;
}

export async function setSilenceUnknownCallers(on) {
  _value = !!on;
  _listeners.forEach((fn) => { try { fn(_value); } catch {} });
  try { await _AS().setItem(KEY, on ? 'true' : 'false'); } catch {}
}

export function useSilenceUnknownCallers() {
  const [on, setOn] = useState(() => !!_value);
  useEffect(() => {
    _listeners.add(setOn);
    if (_value == null) loadSilenceUnknownCallers(); else setOn(_value);
    return () => { _listeners.delete(setOn); };
  }, []);
  return [on, setSilenceUnknownCallers];
}
