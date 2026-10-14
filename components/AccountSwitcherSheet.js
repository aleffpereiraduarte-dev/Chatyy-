/**
 * AccountSwitcherSheet — WhatsApp/browser-style multi-account switcher.
 *
 * The whole multi-account engine (roster, token-first switch, cross-account
 * cache wipe, Face ID rotation) already lives in AuthContext.switchAccount /
 * removeAccount + api.getStoredAccounts. This sheet is a reusable entry point
 * (Settings > Conta > Trocar conta; inbox menu has its own list).
 *
 * Behavior:
 *  - Lists the ACTIVE account first with a check.
 *  - Other stored accounts — tap to switch.
 *  - Switch failure (expired token) routes to /login?add_account=1 prefilled.
 *  - "Adicionar conta" (rodapé fixo) → /login?add_account=1 (mantém a sessão).
 *  - Toque longo / "..." numa linha → "Sair desta conta" (ativa = logout).
 *
 * [2026-10-13 account-sheet] BUG: no sheet NATIVO (formSheet iOS, detents
 * 'fitToContents') a linha da conta ativa aparecia POR CIMA do título
 * "Trocar conta". Causa: fitToContents mede o conteúdo e o ScrollView interno
 * (maxHeight, contentInsetAdjustmentBehavior automático do iOS) era deslocado
 * pelo inset do sheet — a 1ª linha (fundo translúcido primary+'12') subia
 * sobre o cabeçalho, que não tinha fundo sólido nem zIndex. Mesma classe do
 * bug corrigido em components/chat/ConversationSummarySheet.js. Agora:
 *  - detent NUMÉRICO calculado pela altura do conteúdo (sem fitToContents);
 *  - coluna fixa: cabeçalho (fundo sólido, zIndex) → lista (flex:1, sem
 *    ajuste automático de insets; rola só se não couber) → rodapé fixo.
 */
import React, { useCallback, useMemo } from 'react';
import {
  Modal, View, Text, StyleSheet, Platform, Alert, ScrollView, ActivityIndicator, Pressable, useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useMail } from '../context/MailContext';
import AvatarCircle from './AvatarCircle';
import { IconPlus, IconCheck, IconX, IconMoreHorizontal } from './Icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { USE_NATIVE_SHEETS, NativeSheet, nativeSheetBottomPad, runAfterNativeSheet } from './NativeSheet'; // [2026-10-09 native-sheets]
import { confirmAsync } from '../utils/confirm'; // [2026-10-12 overlays] diálogo estilizado no web
import { useOverlayColors, SheetHandle } from './ui/Sheet';
import PressableRow from './PressableRow';
import { Type, Space, Radius, Overlay } from '../constants/theme';

const ROW_H = 68;      // avatar 44 + 12/12
const HEADER_H = 56;
const FOOTER_H = 76;

function tr(t, k, fb) { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }

export default function AccountSwitcherSheet({ visible, onClose }) {
  const router = useRouter();
  const { t } = useLanguage();
  const oc = useOverlayColors();
  const insets = useSafeAreaInsets();
  const { height: winH, width: winW } = useWindowDimensions();
  const { user, accounts, switchAccount, removeAccount, switching } = useAuth();
  // MailContext is optional — this sheet can mount outside the mail provider.
  let resetMailState;
  try { ({ resetMailState } = useMail() || {}); } catch {}

  const activeEmail = (user?.email || '').toLowerCase();
  const others = useMemo(
    () => (accounts || []).filter(a => a && a.email && (a.email || '').toLowerCase() !== activeEmail),
    [accounts, activeEmail],
  );
  const rows = useMemo(() => {
    const list = [];
    if (user?.email) list.push({ email: user.email, name: user.name, active: true, unread: 0 });
    for (const a of others) list.push({ email: a.email, name: a.name, active: false, unread: Number(a.unread || a.unread_count || 0) || 0 });
    return list;
  }, [user?.email, user?.name, others]);

  const goReLogin = useCallback((email) => {
    onClose?.();
    const q = email ? `&email=${encodeURIComponent(email)}` : '';
    const go = () => { try { router.push(`/login?add_account=1${q}`); } catch {} };
    if (USE_NATIVE_SHEETS) runAfterNativeSheet(go); else go();
  }, [onClose, router]);

  const handleSwitch = useCallback(async (email) => {
    if (switching) return;
    try {
      const result = await switchAccount(email);
      if (result && result.success) {
        try { resetMailState?.(); } catch {}
        onClose?.();
      } else if (result && result.removed) {
        // [incidente-sessao 2026-10-14] bearer revogado: conta já saiu do aparelho (aviso global).
        onClose?.();
      } else {
        goReLogin(email);
      }
    } catch {
      goReLogin(email);
    }
  }, [switching, switchAccount, resetMailState, onClose, goReLogin]);

  const handleSignOut = useCallback((email, isActive) => {
    const title = tr(t, 'account.signOutThis', 'Sair desta conta');
    const msg = tr(t, 'account.signOutConfirm', 'Você vai sair de {email} neste aparelho.').replace('{email}', email);
    const okLabel = tr(t, 'account.signOutAction', 'Sair');
    const cancel = tr(t, 'account.cancel', 'Cancelar');
    const doIt = () => {
      if (isActive) onClose?.();
      removeAccount(email);
    };
    if (Platform.OS === 'web') {
      confirmAsync({ title, message: msg, confirmLabel: okLabel, cancelLabel: cancel, destructive: true })
        .then((ok) => { if (ok) doIt(); });
    } else {
      Alert.alert(title, msg, [
        { text: cancel, style: 'cancel' },
        { text: okLabel, style: 'destructive', onPress: doIt },
      ]);
    }
  }, [t, removeAccount, onClose]);

  const openRowMenu = useCallback((row) => {
    // Menu curto: hoje só "Sair desta conta" (confirmação já explica o efeito).
    handleSignOut(row.email, row.active);
  }, [handleSignOut]);

  const headerTitle = tr(t, 'account.switchTitle', 'Trocar conta');
  const closeLabel = tr(t, 'common.close', 'Fechar');

  const header = (
    <View style={[s.header, { backgroundColor: oc.sheetBg }]}>
      <Text style={[Type.title3, { color: oc.text, flex: 1 }]} numberOfLines={1} accessibilityRole="header">
        {headerTitle}
      </Text>
      <Pressable
        onPress={onClose}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={closeLabel}
        style={({ pressed }) => [s.closeBtn, { backgroundColor: oc.neutralButton, opacity: pressed ? 0.6 : 1 }]}
      >
        <IconX size={16} color={oc.text} />
      </Pressable>
    </View>
  );

  const list = rows.map((row, i) => {
    const display = row.name || (row.email || '').split('@')[0];
    const last = i === rows.length - 1;
    return (
      <PressableRow
        key={row.email}
        onPress={row.active ? undefined : () => handleSwitch(row.email)}
        onLongPress={() => openRowMenu(row)}
        disabled={switching}
        accessibilityRole="button"
        accessibilityState={{ selected: row.active }}
        accessibilityLabel={`${display}, ${row.email}`}
        style={s.row}
      >
        <AvatarCircle name={row.name || row.email || '?'} email={row.email} size={44} />
        <View style={[s.rowText, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: oc.separator }]}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[Type.headline, { color: oc.text }]} numberOfLines={1}>{display}</Text>
            <Text style={[Type.footnote, { color: oc.textSecondary, marginTop: 1 }]} numberOfLines={1}>{row.email}</Text>
          </View>
          {row.unread > 0 ? (
            <View style={[s.unread, { backgroundColor: oc.primaryButton }]}>
              <Text style={[Type.caption2, { color: oc.onPrimaryButton, fontWeight: '700' }]}>
                {row.unread > 99 ? '99+' : String(row.unread)}
              </Text>
            </View>
          ) : null}
          {row.active ? (
            <View style={[s.check, { backgroundColor: oc.primaryButton }]}>
              <IconCheck size={13} color={oc.onPrimaryButton} strokeWidth={3} />
            </View>
          ) : null}
          <Pressable
            onPress={() => openRowMenu(row)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={tr(t, 'account.options', 'Opções da conta')}
            style={({ pressed }) => [s.moreBtn, { opacity: pressed ? 0.5 : 1 }]}
          >
            <IconMoreHorizontal size={20} color={oc.icon} />
          </Pressable>
        </View>
      </PressableRow>
    );
  });

  const footer = (
    <View style={[s.footer, { borderTopColor: oc.separator, backgroundColor: oc.sheetBg }]}>
      <PressableRow onPress={() => goReLogin()} disabled={switching} accessibilityRole="button" style={s.addRow}>
        <View style={[s.addIcon, { borderColor: oc.text }]}>
          <IconPlus size={20} color={oc.text} />
        </View>
        <Text style={[Type.headline, { color: oc.text, marginLeft: Space.md }]}>{tr(t, 'account.add', 'Adicionar conta')}</Text>
      </PressableRow>
    </View>
  );

  const switchingOverlay = switching ? (
    <View style={[s.switchingOverlay, { backgroundColor: oc.sheetBg + 'E6' }]}>
      <ActivityIndicator size="large" color={oc.text} />
      <Text style={[Type.subhead, { color: oc.text, marginTop: Space.md, fontWeight: '600' }]}>
        {tr(t, 'account.switchingShort', 'Entrando...')}
      </Text>
    </View>
  ) : null;

  // Coluna fixa: cabeçalho sólido (zIndex) · lista (flex:1) · rodapé.
  const column = (
    <View style={{ flex: 1, backgroundColor: oc.sheetBg }}>
      <View style={{ zIndex: 2, backgroundColor: oc.sheetBg }}>{header}</View>
      {/* [2026-10-13] No formSheet nativo do iOS o react-native-screens trata o 1º
          ScrollView da folha como o "scroll da sheet" e o reposiciona (a conta ia
          para trás do título e a lista ficava vazia). Com poucas contas a lista é
          uma View comum; ScrollView só quando não cabe (raro). */}
      {rows.length <= 6 ? (
        <View style={{ paddingBottom: Space.xs }}>{list}</View>
      ) : (
        <ScrollView
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{ paddingBottom: Space.xs }}
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustContentInsets={false}
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          {list}
        </ScrollView>
      )}
      <View style={{ flex: 1 }} />
      {footer}
      {switchingOverlay}
    </View>
  );

  // Altura do conteúdo → detent numérico (fitToContents descolava a lista).
  const bottomPad = USE_NATIVE_SHEETS ? nativeSheetBottomPad(insets, Space.sm) : Math.max(Space.md, (insets.bottom || 0) + Space.sm);
  const contentH = 18 /* respiro da alça do sistema */ + HEADER_H + rows.length * ROW_H + FOOTER_H + bottomPad;

  if (USE_NATIVE_SHEETS) {
    const frac = Math.min(0.9, Math.max(0.3, (contentH + (Platform.OS === 'ios' ? (insets.bottom || 0) : 0)) / Math.max(1, winH)));
    const detents = frac >= 0.9 ? [0.9] : [Number(frac.toFixed(3))];
    return (
      <NativeSheet visible={!!visible} onClose={onClose} detents={detents} backgroundColor={oc.sheetBg}>
        <View style={{ flex: 1, paddingTop: 18, paddingBottom: bottomPad, backgroundColor: oc.sheetBg }}>
          {column}
        </View>
      </NativeSheet>
    );
  }

  const wide = Platform.OS === 'web' && winW >= 768;
  const panelH = Math.min(Math.round(winH * 0.86), contentH + 8);
  return (
    <Modal visible={!!visible} transparent animationType={wide ? 'fade' : 'slide'} onRequestClose={onClose} statusBarTranslucent>
      <View style={[s.backdrop, wide && { justifyContent: 'center', alignItems: 'center', paddingHorizontal: Space.xxl }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel={closeLabel} />
        <View
          style={[
            s.panel,
            wide ? s.panelWide : null,
            { backgroundColor: oc.sheetBg, height: panelH, paddingBottom: wide ? Space.sm : bottomPad },
          ]}
          accessibilityViewIsModal
        >
          {wide ? <View style={{ height: Space.md }} /> : <SheetHandle />}
          {column}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  panel: {
    width: '100%',
    borderTopLeftRadius: Radius.sheet, borderTopRightRadius: Radius.sheet,
    overflow: 'hidden',
    ...(Platform.OS === 'web' ? { maxWidth: Overlay.sheetMaxWidth || 460, alignSelf: 'center' } : null),
  },
  panelWide: {
    maxWidth: 440, borderRadius: Radius.sheet,
    ...(Platform.OS === 'web' ? { boxShadow: '0 12px 48px rgba(0,0,0,0.22)' } : null),
  },
  header: {
    height: HEADER_H, flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Space.xl, gap: Space.md,
  },
  closeBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: Space.xl, minHeight: ROW_H },
  rowText: {
    flex: 1, minWidth: 0, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center',
    marginLeft: Space.md, paddingRight: Space.md, gap: Space.sm,
  },
  unread: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  check: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  moreBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  footer: { height: FOOTER_H, borderTopWidth: StyleSheet.hairlineWidth, justifyContent: 'center' },
  addRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Space.xl, minHeight: 60 },
  addIcon: {
    width: 44, height: 44, borderRadius: Radius.control, borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  switchingOverlay: { ...StyleSheet.absoluteFillObject, zIndex: 5, alignItems: 'center', justifyContent: 'center' },
});
