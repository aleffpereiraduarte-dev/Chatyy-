// [2026-10-18 kb-resume] Teclado nível WhatsApp/Telegram ao minimizar e voltar.
//
// Founder: "minimizo o app, volto e o teclado abre e fecha (pisca)". No iOS o
// SISTEMA devolve sozinho o first responder (teclado aberto volta aberto,
// fechado continua fechado). Qualquer focus()/blur()/Keyboard.dismiss() do JS
// nesse meio — re-foco atrasado do envio, restauração de menu/voltar, ouvintes
// de keyboardWillShow que derrubam o teclado, "assentar" o composer por um
// keyboardDidHide que o iOS postou ao ir pro fundo — vira abre-fecha.
//
// Este módulo só responde "estamos na janela de ida/volta do fundo?":
//   • app 'inactive'/'background'  → true
//   • até RESUME_MS depois de 'active' → true
// Quem programa foco/blur consulta isAppResuming() e não age nessa janela.
// O compositor NATIVO tem o mesmo guarda no Swift/Kotlin (prop focusGuard).
//
// Kill switch OTA: globalThis.__chatyy_kb_resume_guard = false.
import { AppState, Platform } from 'react-native';

const RESUME_MS = 700;

let _state = 'active';
let _activeAt = 0;
let _sub = null;

export function kbResumeGuardOn() {
  try { if (globalThis.__chatyy_kb_resume_guard === false) return false; } catch {}
  return true;
}

function _ensure() {
  if (_sub || Platform.OS === 'web') return;
  try { _state = AppState.currentState || 'active'; } catch {}
  try {
    _sub = AppState.addEventListener('change', (s) => {
      const prev = _state;
      _state = s;
      if (s === 'active' && prev !== 'active') _activeAt = Date.now();
    });
  } catch { _sub = null; }
}
_ensure();

/** true = app indo/voltando do fundo (não mexer em foco/teclado agora). */
export function isAppResuming() {
  if (Platform.OS === 'web' || !kbResumeGuardOn()) return false;
  _ensure();
  let cur = _state;
  try { cur = AppState.currentState || cur; } catch {}
  if (cur !== 'active') return true;
  if (_state !== 'active') return true; // 'active' chegou mas o ouvinte ainda não rodou
  return _activeAt > 0 && (Date.now() - _activeAt) < RESUME_MS;
}
