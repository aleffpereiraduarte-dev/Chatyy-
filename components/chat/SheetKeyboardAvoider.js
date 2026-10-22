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
// p/ outro não dispara keyboardDidHide, então não pisca.
// [2026-10-22 kb-uniforme] O padding agora inclui a barra de navegação
// (useKeyboardInset) = mesma geometria do iOS. Para telas/folhas FORA deste
// componente use components/ui/KeyboardSafeView (troca 1:1 do
// KeyboardAvoidingView: iOS idêntico, Android padding pelo evento).
//
// iOS: por padrão NÃO muda nada (View com o mesmo style), p/ não alterar telas
// que já se comportam bem lá. Passe `ios` p/ usar KeyboardAvoidingView
// 'padding'. Web: View simples.
import React, { useContext, useEffect, useState } from 'react';
import { AppState, Keyboard, KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

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
    // [2026-10-22 kb-uniforme] Montou com o teclado JÁ aberto (folha aberta
    // por cima de um campo focado / foco passou p/ o campo da folha sem o
    // teclado descer): o RN Android só emite keyboardDidShow na TRANSIÇÃO de
    // visibilidade → sem isto a folha nascia atrás do teclado. Lê o último
    // estado conhecido agora e de novo depois do autofocus (~280 ms).
    const sync = () => {
      try {
        const vis = typeof Keyboard.isVisible === 'function' ? Keyboard.isVisible() : false;
        const h = vis ? Math.max(0, Math.round(Keyboard.metrics?.()?.height || 0)) : 0;
        if (vis && h > 0 && hasFocusedInput()) setKb(h);
      } catch {}
    };
    sync();
    const t1 = setTimeout(sync, 420);
    subs.push({ remove: () => clearTimeout(t1) });
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

// [2026-10-22 kb-uniforme] Quanto o teclado cobre do RODAPÉ da tela no
// Android (0 no iOS/web e sem campo focado). O evento do RN Android dá a altura
// SEM a barra de navegação (ime − systemBars); no edge-to-edge o teclado cobre
// também a barra → soma o inset de baixo. Mesma geometria do KeyboardAvoidingView
// 'padding' do iOS (borda de baixo do contêiner = topo do teclado).
export function useKeyboardInset(active = true) {
  const kb = useAndroidKeyboardInset(active);
  const ins = useContext(SafeAreaInsetsContext); // null fora do provider (não lança)
  const nav = (ins && ins.bottom) || 0;
  return kb > 0 ? Math.round(kb + nav) : 0;
}

export default function SheetKeyboardAvoider({ children, style, ios = false, ...rest }) {
  const isAndroid = Platform.OS === 'android';
  const kb = useKeyboardInset();

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
