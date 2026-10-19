// [2026-10-19 kb-native] Teclado de TextInput RN nunca "sobra" numa troca de tela.
//
// Founder: o teclado pisca "quando muda de tela". Para os campos RN (busca da
// lista, e-mail/compose, Bia, ajustes…) o iOS só tira o first responder quando
// a view SAI da janela — no FIM do pop/troca de aba. Resultado: o teclado fica
// por cima da tela nova durante a transição inteira e cai de uma vez no final.
// WhatsApp/Telegram: o teclado começa a descer no mesmo frame em que a
// transição começa.
//
// Aqui: no despacho da ação de navegação (antes do novo estado renderizar) as
// ações de VOLTAR e de TROCA DE ABA soltam o TextInput RN focado (Keyboard.
// dismiss = blur animado). Push para outra tela não entra (a tela nova pode ter
// autoFocus, ex. etapas do cadastro — derrubar e reabrir = pisca); a conversa
// trata o push pela lista em services/openConversation.js. O composer NATIVO da
// conversa não é TextInput RN e não é tocado (ele mesmo solta no
// viewWillDisappear).
//
// Kill switch: globalThis.__chatyy_kb_native_transitions = false.
import { useEffect } from 'react';
import { Keyboard, Platform } from 'react-native';
import { kbNativeTransitionsOn } from './kbNativeTransitions';

const LEAVE_ACTIONS = new Set(['GO_BACK', 'POP', 'POP_TO', 'POP_TO_TOP', 'JUMP_TO']);

export function useKbNavGuard(navRef) {
  useEffect(() => {
    if (Platform.OS === 'web' || !navRef || typeof navRef.addListener !== 'function') return undefined;
    let unsub = null;
    try {
      unsub = navRef.addListener('__unsafe_action__', (e) => {
        if (!kbNativeTransitionsOn()) return;
        const type = e && e.data && e.data.action && e.data.action.type;
        if (!type || !LEAVE_ACTIONS.has(type)) return;
        try {
          if (!Keyboard.isVisible()) return;
        } catch {}
        try { Keyboard.dismiss(); } catch {}
      });
    } catch { unsub = null; }
    return () => { try { if (typeof unsub === 'function') unsub(); } catch {} };
  }, [navRef]);
}
