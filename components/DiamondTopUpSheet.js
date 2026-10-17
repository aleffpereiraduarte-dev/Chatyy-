/**
 * DiamondTopUpSheet — recarga rápida de diamantes (sheet) sobre a mesma loja
 * da tela /diamond-shop (components/diamonds/DiamondStorePanel): iOS só IAP,
 * Android só Play Billing, web Stripe; preço local da loja; "Em breve";
 * restaurar pendentes; menor de idade bloqueado.
 * [2026-10-13 diamantes-religados] — antes era no-op (return null).
 */
import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconX } from './Icons';
import DiamondStorePanel from './diamonds/DiamondStorePanel';
import useSurface from './ui/useSurface';
import { DIAMONDS_ENABLED } from '../constants/featureFlags';
import useDragToDismiss, { DragSheetRoot, DragPanel, DragScroll, DragBackdrop } from './ui/useDragToDismiss';

function tr(t, k, fb) { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }

export default function DiamondTopUpSheet({ visible, onClose, onBalanceChange }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const s = useSurface();
  const drag = useDragToDismiss({ visible: !!visible, onDismiss: onClose }); // [2026-10-17 drag-dismiss]
  if (!visible || !DIAMONDS_ENABLED) return null;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <DragSheetRoot>
      <DragBackdrop inline drag={drag} color="rgba(0,0,0,0.4)" onPress={onClose} accessibilityLabel={tr(t, 'common.close', 'Fechar')} />
      <DragPanel drag={drag} style={[styles.sheet, { backgroundColor: s.isDark ? s.surfaceRaised : s.bgGrouped, paddingBottom: Math.max(insets.bottom, 12) + 8 }]}>
        <View style={[styles.handle, { backgroundColor: s.separator }]} />
        <View style={styles.head}>
          <Text style={[styles.title, { color: colors.text }]}>{tr(t, 'wallet.topup', 'Comprar diamantes')}</Text>
          <TouchableOpacity onPress={onClose} style={styles.x} accessibilityRole="button" accessibilityLabel={tr(t, 'common.close', 'Fechar')}>
            <IconX size={20} color={colors.text} />
          </TouchableOpacity>
        </View>
        <DragScroll drag={drag}><ScrollView style={{ maxHeight: 560 }} contentContainerStyle={{ paddingBottom: 8 }} showsVerticalScrollIndicator={false}>
          <DiamondStorePanel compact onBalanceChange={onBalanceChange} />
        </ScrollView></DragScroll>
      </DragPanel>
      </DragSheetRoot>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 16, paddingTop: 8,
    ...(Platform.OS === 'web' ? { maxWidth: 560, width: '100%', alignSelf: 'center' } : null),
  },
  handle: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, marginBottom: 8 },
  head: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  title: { flex: 1, fontSize: 19, fontWeight: '700', letterSpacing: -0.3 },
  x: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
