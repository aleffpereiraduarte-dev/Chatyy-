// [2026-10-15 native-onboarding] Troca de idioma na tela de boas-vindas
// (WhatsApp: globo no topo). Lista os idiomas do app pelo nome nativo, sem
// bandeiras-emoji. changeLanguage é o mesmo do LanguageContext.
import React, { useCallback } from 'react';
import { Modal, View, Text, FlatList, Pressable, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LANGUAGES } from '../../i18n';
import { IconX, IconCheck } from '../Icons';

export default function LanguageSheet({ visible, onClose, language, onPick, colors, t }) {
  const insets = useSafeAreaInsets();
  const renderItem = useCallback(({ item }) => {
    const on = item.code === language;
    return (
      <Pressable
        onPress={() => onPick?.(item.code)}
        style={({ pressed }) => [st.row, { backgroundColor: pressed ? colors.surfaceVariant : 'transparent' }]}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        accessibilityLabel={item.label}
        testID={`nob-lang-${item.code}`}
      >
        <Text style={[st.label, { color: colors.text, fontWeight: on ? '700' : '400' }]} maxFontSizeMultiplier={1.4}>{item.label}</Text>
        {on ? <IconCheck size={18} color={colors.text} strokeWidth={2.6} /> : null}
      </Pressable>
    );
  }, [language, onPick, colors]);
  return (
    <Modal
      visible={!!visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined}
      onRequestClose={onClose}
      statusBarTranslucent={Platform.OS === 'android'}
    >
      <View style={[st.root, { backgroundColor: colors.background, paddingTop: Platform.OS === 'ios' ? 8 : insets.top + 4 }]}>
        <View style={st.topBar}>
          <Pressable onPress={onClose} hitSlop={10} style={st.close} accessibilityRole="button" accessibilityLabel={t('common.close') || 'Fechar'}>
            <IconX size={22} color={colors.text} />
          </Pressable>
          <Text style={[st.title, { color: colors.text }]} accessibilityRole="header" maxFontSizeMultiplier={1.3}>
            {t('nob.language') || 'Idioma do app'}
          </Text>
          <View style={st.close} />
        </View>
        <FlatList
          data={LANGUAGES}
          keyExtractor={(i) => i.code}
          renderItem={renderItem}
          initialNumToRender={20}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        />
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 52 },
  close: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 20 },
  label: { flex: 1, fontSize: 16 },
});
