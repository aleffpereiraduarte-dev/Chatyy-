// components/settings/SettingsFormSheet.js — [2026-10-18 settings-sub-native-2]
//
// Folha de edição das sub-páginas NATIVAS das Configurações: na lista nativa
// (ChatyySettingsList) não existe campo de texto dentro da linha, então no
// modo coleta (nativeCollect.js) cada campo vira uma linha com o valor atual e
// o toque abre ESTA folha com os MESMOS campos/handlers da tela JS (assinatura,
// resposta automática, encaminhamento, horário do Não perturbe, palavra
// silenciada, exclusão de conta).
//
// iOS/Android: sheet do sistema (NativeSheet, fitToContents — o sistema sobe a
// folha junto com o teclado). Kill switch das folhas nativas → Modal RN.
// Fechar (gesto, toque fora, "Concluído") chama onClose — quem abre decide se
// grava ao fechar (os campos já gravam a cada tecla, como na tela JS).
//
// Campos: prefira `defaultValue` + onChangeText (o conteúdo do sheet nativo é
// republicado a cada render do dono; `value` controlado pode pular o cursor).
import { Modal, View, Text, Pressable, Platform, StyleSheet } from 'react-native';
import KeyboardSafeView from '../ui/KeyboardSafeView'; // [2026-10-22 kb-uniforme]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguageOptional } from '../../context/LanguageContext';
import { USE_NATIVE_SHEETS, NativeSheet, nativeSheetBottomPad } from '../NativeSheet';
import { useGroupedColors } from './SettingsKit';

export default function SettingsFormSheet({ visible, onClose, title, doneLabel, children, testID }) {
  const g = useGroupedColors();
  const insets = useSafeAreaInsets();
  const lang = useLanguageOptional();
  const done = doneLabel || lang?.t?.('common.done') || 'OK';
  const head = (
    <View style={st.head}>
      <Text style={[st.title, { color: g.text }]} numberOfLines={2} accessibilityRole="header">{title || ''}</Text>
      <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={done} testID={testID ? `${testID}-done` : undefined}>
        <Text style={[st.done, { color: g.text }]}>{done}</Text>
      </Pressable>
    </View>
  );
  if (USE_NATIVE_SHEETS) {
    return (
      <NativeSheet visible={!!visible} onClose={onClose} detents="fitToContents" backgroundColor={g.pageBg}>
        <View style={{ backgroundColor: g.pageBg, paddingTop: 20, paddingHorizontal: 16, paddingBottom: nativeSheetBottomPad(insets, 16) }} testID={testID}>
          {head}
          {children}
        </View>
      </NativeSheet>
    );
  }
  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardSafeView style={st.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel={done} />
        <View style={[st.panel, { backgroundColor: g.pageBg, paddingBottom: Math.max(insets.bottom, 16) }]} testID={testID}>
          {head}
          {children}
        </View>
      </KeyboardSafeView>
    </Modal>
  );
}

// Cartão + campo no visual das Configurações (mesmo do SettingsKit).
export function FormCard({ children, style }) {
  const g = useGroupedColors();
  return <View style={[st.card, { backgroundColor: g.cardBg }, style]}>{children}</View>;
}

export function FormLabel({ children }) {
  const g = useGroupedColors();
  return <Text style={[st.label, { color: g.header }]}>{String(children || '').toUpperCase()}</Text>;
}

export function FormHint({ children, color }) {
  const g = useGroupedColors();
  return <Text style={[st.hint, { color: color || g.header }]}>{children}</Text>;
}

const st = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.38)' },
  panel: { borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 18, paddingHorizontal: 16 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, paddingHorizontal: 4 },
  title: { flex: 1, fontSize: 17, fontWeight: '600', letterSpacing: -0.41, marginRight: 12 },
  done: { fontSize: 17, fontWeight: '600' },
  card: { borderRadius: 14, overflow: 'hidden', marginBottom: 16, paddingHorizontal: 12, paddingVertical: 10 },
  label: { fontSize: 13, fontWeight: '400', paddingHorizontal: 4, marginBottom: 6 },
  hint: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4, marginTop: -8, marginBottom: 16 },
});
