// KeyboardSafeView — padrão ÚNICO do app p/ manter campos acima do teclado em
// folhas (bottom sheets), modais, diálogos, composers de rodapé e formulários.
//
// [2026-10-22 kb-uniforme] Ticket QA 20261022-054526 (Android): "Adicionar
// nota" no Perfil abria o teclado com a tela escurecida e a folha INTEIRA
// escondida atrás do teclado. Raiz (vale p/ ~70 telas): RN 0.83 com
// edgeToEdgeEnabled → nem a Activity (adjustResize) nem a janela do <Modal>
// redimensionam com o teclado, e quase todo KeyboardAvoidingView do app usava
// behavior={Platform.OS === 'ios' ? 'padding' : undefined} = NADA no Android.
//
// Troca 1:1 do <KeyboardAvoidingView>:
//   • iOS: o MESMO KeyboardAvoidingView (behavior padrão 'padding', mesmo
//     keyboardVerticalOffset/enabled/style) → zero mudança no iOS.
//   • Android: View + paddingBottom = quanto o teclado cobre do rodapé da tela
//     (useKeyboardInset: evento do RN + barra de navegação; só com campo focado;
//     auto-cura do teclado "fantasma"). Sem módulo nativo novo → funciona no
//     binário atual (OTA). `androidOffset` desconta algo que já fica entre o
//     contêiner e o rodapé da tela (ex.: barra de abas). `android={false}`
//     desliga só no Android (ex.: painel embutido que outro avoider já sobe).
//   • Web: KeyboardAvoidingView do RN-web (= View), como antes.
import React from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { useKeyboardInset } from '../chat/SheetKeyboardAvoider';

export { useKeyboardInset };

function AndroidKeyboardSafeView({ style, children, enabled = true, androidOffset = 0, ...rest }) {
  const kb = useKeyboardInset(enabled !== false);
  const pad = kb > 0 ? Math.max(0, kb - (Number(androidOffset) || 0)) : 0;
  return <View style={[style, pad > 0 ? { paddingBottom: pad } : null]} {...rest}>{children}</View>;
}

export default function KeyboardSafeView({
  behavior = 'padding', keyboardVerticalOffset, androidOffset, enabled, android = true, style, children, ...rest
}) {
  if (Platform.OS === 'android') {
    if (android === false) return <View style={style} {...rest}>{children}</View>;
    return (
      <AndroidKeyboardSafeView style={style} enabled={enabled} androidOffset={androidOffset} {...rest}>
        {children}
      </AndroidKeyboardSafeView>
    );
  }
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? behavior : undefined}
      keyboardVerticalOffset={keyboardVerticalOffset}
      enabled={enabled}
      style={style}
      {...rest}
    >
      {children}
    </KeyboardAvoidingView>
  );
}
