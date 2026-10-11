// SheetKeyboardAvoider — KeyboardAvoidingView para conteúdo DENTRO de <Modal>
// (sheets de baixo e diálogos centrais com TextInput).
//
// [2026-10-11 android-kav] Por que existe:
//  • Android + edgeToEdgeEnabled (RN 0.83): todo <Modal> é edge-to-edge e a
//    janela do diálogo NÃO redimensiona com o teclado → o teclado cobria os
//    inputs de sheets (tópicos, criar tópico, diálogos de senha/2FA...).
//  • KeyboardAvoidingView behavior='height' dentro de Modal guarda altura de
//    teclado "fantasma" quando o keyboardDidHide se perde (voltar de câmera,
//    galeria, documento, diálogo de permissão, share sheet, ligação) e o sheet
//    fica encolhido sem teclado nenhum (bug da prévia da câmera, 0aad4a2d).
//
// Android: NÃO usa a KeyboardAvoidingView do RN (behavior='height' soma o
// state.bottom antigo na conta e herda o fantasma). Aqui o padding é calculado
// direto do evento: paddingBottom = altura do teclado (o RN Android já exclui a
// barra de navegação) SÓ enquanto existe um TextInput focado; ao fechar o
// teclado, ou ao voltar p/ o app sem input focado, zera. Trocar de um campo
// p/ outro não dispara keyboardDidHide, então não pisca. O sheet dentro deve
// somar o inset da barra de navegação no próprio paddingBottom.
//
// iOS: por padrão NÃO muda nada (View com o mesmo style), p/ não alterar telas
// que já se comportam bem lá. Passe `ios` p/ usar KeyboardAvoidingView
// 'padding'. Web: View simples.
import React, { useEffect, useState } from 'react';
import { AppState, Keyboard, KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';

function hasFocusedInput() {
  try { return !!TextInput.State?.currentlyFocusedInput?.(); } catch { return false; }
}

// Altura do teclado (Android) válida SÓ enquanto há TextInput focado; 0 no
// iOS/web. Auto-cura do fantasma ao voltar p/ o app sem input focado.
// `active=false` não escuta nada (evita re-render de telas montadas ocultas).
export function useAndroidKeyboardInset(active = true) {
  const isAndroid = Platform.OS === 'android';
  const [kb, setKb] = useState(0);

  useEffect(() => {
    if (!isAndroid || !active) { setKb(0); return undefined; }
    const subs = [];
    try {
      subs.push(Keyboard.addListener('keyboardDidShow', (e) => {
        const h = Math.max(0, Math.round(e?.endCoordinates?.height || 0));
        setKb(hasFocusedInput() ? h : 0);
      }));
    } catch {}
    try { subs.push(Keyboard.addListener('keyboardDidHide', () => setKb(0))); } catch {}
    try {
      subs.push(AppState.addEventListener('change', (s) => {
        if (s === 'active' && !hasFocusedInput()) setKb(0);
      }));
    } catch {}
    return () => { subs.forEach((s) => { try { s?.remove?.(); } catch {} }); };
  }, [isAndroid, active]);

  return isAndroid && active ? kb : 0;
}

export default function SheetKeyboardAvoider({ children, style, ios = false, ...rest }) {
  const isAndroid = Platform.OS === 'android';
  const kb = useAndroidKeyboardInset();

  if (isAndroid) {
    return <View style={[style, kb > 0 ? { paddingBottom: kb } : null]} {...rest}>{children}</View>;
  }
  if (Platform.OS === 'ios' && ios) {
    return (
      <KeyboardAvoidingView behavior="padding" style={style} {...rest}>
        {children}
      </KeyboardAvoidingView>
    );
  }
  return <View style={style} {...rest}>{children}</View>;
}
