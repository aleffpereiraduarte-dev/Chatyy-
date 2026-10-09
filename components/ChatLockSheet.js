/**
 * ChatLockSheet — WhatsApp-style "Chat Lock" configuration sheet.
 *
 * Bottom-sheet modal that drives the lock / unlock flow for a single
 * conversation. Locking moves the chat into the hidden "Conversas bloqueadas"
 * folder (it disappears from the main list) and requires a biometric / device
 * passcode to reveal. The flag is PER-USER — locking never affects the other
 * member of the conversation.
 *
 * Props:
 *   visible      boolean           — show/hide the sheet
 *   conversation object            — the conversation ({ id, name, ... })
 *   locked       boolean           — current lock state (controlled by parent)
 *   onClose      () => void        — dismiss the sheet
 *   onChanged    (locked:boolean)  — fired after a successful lock/unlock
 *
 * Security:
 *   - Locking is a direct action (enabling protection needs no auth).
 *   - UNLOCKING (removing protection) demands a biometric / passcode confirm
 *     via services/biometricGate, so a shoulder-surfer can't strip the lock.
 *
 * No emoji — all glyphs are SVG (components/Icons). Themed via useTheme().
 */
import React, { useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconLock, IconUnlock, IconShield, IconX, IconEye } from './Icons';
import PressableScale from './PressableScale';
import * as api from '../services/api';
import { confirmWithBiometric } from '../services/biometricGate';
import { USE_NATIVE_SHEETS, NativeSheet, nativeSheetBottomPad } from './NativeSheet'; // [2026-10-09 native-sheets]

export default function ChatLockSheet({ visible, conversation, locked, onClose, onChanged }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);

  const convId = conversation?.id;
  const convName = conversation?.name || conversation?.display_name
    || conversation?.other_email || conversation?.contact_email
    || (t('chat.conversation') || 'Conversa');

  const doLock = async () => {
    if (!convId || busy) return;
    setBusy(true);
    try {
      const r = await api.chatLockConversation(convId);
      if (r && r.success !== false) {
        // [locked-chats 2026-10-08] tell the chat list (hide the row now).
        try { require('react-native').DeviceEventEmitter.emit('chatyy:lockChanged', { id: convId, locked: true }); } catch {}
        onChanged?.(true);
      }
    } catch {} finally {
      setBusy(false);
      onClose?.();
    }
  };

  const doUnlock = async () => {
    if (!convId || busy) return;
    // Removing protection is the sensitive op → require biometric/passcode.
    let ok = false;
    try {
      ok = await confirmWithBiometric({
        reason: t('chat.unlockChat') || 'Desbloquear conversa',
        fallback: t('chat.usePasscode') || 'Usar código do aparelho',
        cancel: t('common.cancel') || 'Cancelar',
      });
    } catch { ok = false; }
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.chatUnlockConversation(convId);
      if (r && r.success !== false) {
        // [locked-chats 2026-10-08] the main list was never told → the chat
        // stayed hidden until an app restart. Emit with the unmasked row so it
        // reappears instantly with its real last message.
        try { require('react-native').DeviceEventEmitter.emit('chatyy:lockChanged', { id: convId, locked: false, conv: conversation }); } catch {}
        onChanged?.(false);
      }
    } catch {} finally {
      setBusy(false);
      onClose?.();
    }
  };

  const panelBg = isDark ? '#1c1c1e' : '#ffffff';
  const subColor = colors.textSecondary || colors.textTertiary || (isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)');

  // [2026-10-09 native-sheets] Corpo compartilhado: sheet do sistema (iOS/Android)
  // ou o Modal + backdrop original (web).
  const body = (
            <>
            <View style={styles.headerRow}>
              <View style={[styles.iconBadge, { backgroundColor: locked ? '#52525b' : '#2563eb' }]}>
                <IconLock size={20} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
                  {locked ? (t('chat.chatLocked') || 'Conversa bloqueada') : (t('chat.lockChat') || 'Bloquear conversa')}
                </Text>
                <Text style={[styles.subtitle, { color: subColor }]} numberOfLines={1}>{convName}</Text>
              </View>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <IconX size={22} color={subColor} />
              </TouchableOpacity>
            </View>

            <View style={styles.bullets}>
              <Bullet Icon={IconEye} color={subColor} textColor={colors.text}
                text={t('chat.lockBulletHidden') || 'Some da lista principal e vai para a pasta de conversas bloqueadas.'} />
              <Bullet Icon={IconShield} color={subColor} textColor={colors.text}
                text={t('chat.lockBulletBiometric') || 'Exige Face ID, Touch ID ou código do aparelho para abrir.'} />
              <Bullet Icon={IconUnlock} color={subColor} textColor={colors.text}
                text={t('chat.lockBulletPerUser') || 'Vale só para você — a outra pessoa não é afetada.'} />
            </View>

            {locked ? (
              <PressableScale
                onPress={doUnlock}
                disabled={busy}
                style={[styles.primaryBtn, { backgroundColor: isDark ? '#2c2c2e' : '#ecedf2' }]}
              >
                {busy ? <ActivityIndicator color={colors.text} />
                  : <>
                      <IconUnlock size={18} color={colors.text} />
                      <Text style={[styles.primaryBtnText, { color: colors.text }]}>
                        {t('chat.unlockChat') || 'Remover bloqueio'}
                      </Text>
                    </>}
              </PressableScale>
            ) : (
              <PressableScale
                onPress={doLock}
                disabled={busy}
                style={[styles.primaryBtn, { backgroundColor: '#2563eb' }]}
              >
                {busy ? <ActivityIndicator color="#fff" />
                  : <>
                      <IconLock size={18} color="#fff" />
                      <Text style={[styles.primaryBtnText, { color: '#fff' }]}>
                        {t('chat.lockChat') || 'Bloquear conversa'}
                      </Text>
                    </>}
              </PressableScale>
            )}
            </>
  );

  if (USE_NATIVE_SHEETS) {
    return (
      <NativeSheet visible={!!visible} onClose={onClose} detents="fitToContents" backgroundColor={panelBg}>
        <View style={{ paddingHorizontal: 20, paddingTop: 22, paddingBottom: nativeSheetBottomPad(insets, 16), backgroundColor: panelBg }}>
          {body}
        </View>
      </NativeSheet>
    );
  }

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} style={styles.backdrop} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={{ width: '100%' }} onPress={() => {}}>
          <View style={[styles.panel, { backgroundColor: panelBg, paddingBottom: (insets.bottom || 12) + 12 }]}>
            <View style={styles.grabber} />
            {body}
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

function Bullet({ Icon, text, color, textColor }) {
  return (
    <View style={styles.bulletRow}>
      <Icon size={16} color={color} />
      <Text style={[styles.bulletText, { color: textColor }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  panel: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  grabber: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(128,128,128,0.4)',
    marginBottom: 14,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  iconBadge: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: 17, fontWeight: '700' },
  subtitle: { fontSize: 13, marginTop: 1 },
  bullets: { gap: 12, marginBottom: 20 },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  bulletText: { flex: 1, fontSize: 14, lineHeight: 19 },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: 14, marginTop: 2,
  },
  primaryBtnText: { fontSize: 15, fontWeight: '700' },
});
