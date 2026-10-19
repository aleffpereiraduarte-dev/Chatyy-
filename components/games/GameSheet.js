// components/games/GameSheet.js — [jogos 2026-10-19] folha NATIVA dos jogos (seletor, quem joga, regras, placar,
// confirmações). iOS: UISheetPresentationController (detents + grabber do sistema); Android: BottomSheet do
// react-native-screens — os dois via components/NativeSheet (rota /native-sheet). Web (ou kill switch
// __chatyy_native_sheets === false): folha de baixo com alça desenhada, deslizando (Modal RN).
//
//   <GameSheet visible onClose bg detents="fitToContents" | [0.6, 0.95]>…</GameSheet>
//   <ConfirmSheet visible onClose title body icon actions=[{ label, kind: 'destructive'|'primary'|'default', onPress }] pal />
//
// Regras do conteúdo (iguais ao NativeSheet): sem backdrop/alça/raio de topo; detents 'fitToContents' → sem
// flex:1 (ScrollView interno com maxHeight); detents numéricos → pode usar flex:1.
import React, { createContext, useContext } from 'react';
import { View, Text, Pressable, Modal, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { USE_NATIVE_SHEETS, NativeSheet, nativeSheetBottomPad } from '../NativeSheet';
import { hTap } from './fx';
import { PressScale, useRM } from './motion';

/** Estilo da área rolável: flex:1 dentro do sheet nativo com detents numéricos; no fallback (Modal) cresce pelo conteúdo. */
export const sheetScrollFill = USE_NATIVE_SHEETS ? { flex: 1 } : { flexGrow: 0 };

// [jogos 2026-10-19 inline] Dentro da folha do jogo (GamePlay embedded) as folhas filhas (regras, mais,
// confirmações) viram um PAINEL desenhado dentro da própria folha: no iOS nunca folha/Modal sobre folha.
const InlineCtx = createContext(false);
export function GameSheetInlineProvider({ on, children }) {
  return <InlineCtx.Provider value={!!on}>{children}</InlineCtx.Provider>;
}

export default function GameSheet({ visible, onClose, children, bg, detents = 'fitToContents', webMaxW = 560 }) {
  const ins = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const inline = useContext(InlineCtx);
  if (!visible) return null;
  if (inline) {
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Pressable style={st.inScrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="close" />
        <View style={[st.inPanel, { backgroundColor: bg, maxHeight: Math.round(height * 0.8), paddingBottom: Platform.OS === 'ios' ? 14 : Math.max(ins.bottom, 12) + 6 }]}>
          <View style={st.grab} />
          {children}
        </View>
      </View>
    );
  }
  if (USE_NATIVE_SHEETS) {
    const numeric = Array.isArray(detents);
    return (
      <NativeSheet visible onClose={onClose} detents={detents} backgroundColor={bg}>
        <View style={[{ backgroundColor: bg, paddingTop: 20, paddingBottom: nativeSheetBottomPad(ins, 12) }, numeric && { flex: 1 }]}>{children}</View>
      </NativeSheet>
    );
  }
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={st.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="close" />
      <View style={[st.sheet, { backgroundColor: bg, paddingBottom: Math.max(ins.bottom, 14), maxHeight: Math.round(height * 0.9), maxWidth: webMaxW }]}>
        <View style={st.grab} />
        {children}
      </View>
    </Modal>
  );
}

/** Folha de confirmação (sair/desistir, cancelar convite, recusar, proposta de empate). */
export function ConfirmSheet({ visible, onClose, title, body, icon, actions, pal }) {
  const rm = useRM();
  if (!visible) return null;
  const list = Array.isArray(actions) ? actions : [];
  return (
    <GameSheet visible onClose={onClose} bg={pal.bg} webMaxW={460}>
      <View style={st.confirm}>
        {icon ? <View style={[st.cIcon, { backgroundColor: pal.card }]}>{icon}</View> : null}
        <Text style={[st.cTitle, { color: pal.ink }]}>{title}</Text>
        {body ? <Text style={[st.cBody, { color: pal.sub }]}>{body}</Text> : null}
        <View style={{ alignSelf: 'stretch', gap: 10, marginTop: 18 }}>
          {list.map((a, i) => {
            const destructive = a.kind === 'destructive';
            const primary = a.kind === 'primary' || destructive;
            const bgc = destructive ? pal.bad : (primary ? pal.strong : 'transparent');
            const fg = primary ? (destructive ? '#FFFFFF' : pal.onStrong) : pal.ink;
            return (
              <PressScale key={a.label + i} rm={rm} scaleTo={0.97} disabled={!!a.disabled}
                onPress={() => { hTap(); try { a.onPress && a.onPress(); } catch {} }}
                style={[st.cBtn, { backgroundColor: bgc, borderWidth: primary ? 0 : 1, borderColor: pal.line, opacity: a.disabled ? 0.5 : 1 }]}
                accessibilityRole="button" accessibilityLabel={a.label}>
                <Text style={{ color: fg, fontWeight: '800', fontSize: 15.5 }}>{a.label}</Text>
              </PressScale>
            );
          })}
        </View>
      </View>
    </GameSheet>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.42)' },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 8, width: '100%', alignSelf: 'center',
    ...(Platform.OS === 'web' ? { boxShadow: '0 -8px 30px rgba(0,0,0,0.18)' } : null) },
  inScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.38)' },
  inPanel: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 8,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 18, shadowOffset: { width: 0, height: -6 }, elevation: 12 },
  grab: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: 'rgba(127,127,127,0.4)', marginBottom: 6 },
  confirm: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 6, alignItems: 'center' },
  cIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  cTitle: { fontSize: 19, fontWeight: '800', textAlign: 'center' },
  cBody: { fontSize: 14.5, lineHeight: 20, textAlign: 'center', marginTop: 6, paddingHorizontal: 6 },
  cBtn: { borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
});
