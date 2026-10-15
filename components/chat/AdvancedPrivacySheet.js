// components/chat/AdvancedPrivacySheet.js — [2026-10-14 adv-privacy]
// Info do contato/grupo › "Privacidade avançada da conversa": toggle +
// explicação + "Avisar quando alguém tirar print". P&B, ícones SVG (sem emoji).
// Em grupo/canal só admin altera (o servidor também barra).
import React from 'react';
import { View, Text, Modal, Pressable, Switch, ScrollView, Platform, ActivityIndicator, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconShield, IconLock, IconEye, IconDownload, IconForward, IconSparkles, IconX } from '../Icons';

function _tt(t, key, fb) {
  try {
    const v = typeof t === 'function' ? t(key) : '';
    return typeof v === 'string' && v && v !== key ? v : fb;
  } catch { return fb; }
}

function Bullet({ Icon, text, color, sub }) {
  return (
    <View style={s.bullet}>
      <View style={s.bulletIcon}>{Icon ? <Icon size={18} color={color} /> : null}</View>
      <Text style={[s.bulletText, { color: sub }]}>{text}</Text>
    </View>
  );
}

export default function AdvancedPrivacySheet({
  visible, onClose, enabled, screenshotNotice, canEdit, busy, onToggle, onToggleScreenshot, colors, isDark, t,
}) {
  const insets = useSafeAreaInsets();
  const c = colors || {};
  const fg = c.text || (isDark ? '#F1F3F5' : '#111111');
  const sub = c.textSecondary || (isDark ? '#A1A1AA' : '#555555');
  const bg = c.surface || (isDark ? '#141414' : '#FFFFFF');
  const line = c.border || (isDark ? '#262628' : 'rgba(0,0,0,0.10)');
  const track = { false: isDark ? '#3A3A3C' : '#D1D1D6', true: isDark ? '#F1F3F5' : '#111111' };
  // P&B em todas as plataformas (no web o RN-web pintava o polegar de verde-azulado).
  const onThumb = isDark ? '#111111' : '#FFFFFF';
  const thumbFor = (on) => (Platform.OS === 'ios' ? undefined : (on ? onThumb : '#F4F4F5'));
  const thumb = thumbFor(!!enabled);

  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={s.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel={_tt(t, 'common.close', 'Fechar')} />
      <View style={[s.panel, { backgroundColor: bg, paddingBottom: Math.max(insets.bottom, 12) + 8 }]}>
        <View style={s.headerRow}>
          <IconShield size={22} color={fg} />
          <Text style={[s.title, { color: fg }]} numberOfLines={2}>{_tt(t, 'advPriv.title', 'Privacidade avançada da conversa')}</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={_tt(t, 'common.close', 'Fechar')}>
            <IconX size={20} color={sub} />
          </Pressable>
        </View>
        <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ paddingBottom: 4 }}>
          <Text style={[s.intro, { color: sub }]}>{_tt(t, 'advPriv.sheetIntro', 'Quando ativada, vale para todos nesta conversa:')}</Text>
          <Bullet Icon={IconLock} color={fg} sub={fg} text={_tt(t, 'advPriv.bulletCapture', 'Bloqueia prints e gravação de tela no Android. No iPhone, a tela fica oculta durante gravação ou espelhamento.')} />
          <Bullet Icon={IconEye} color={fg} sub={fg} text={_tt(t, 'advPriv.bulletNotice', 'Avisa a conversa quando alguém tira um print.')} />
          <Bullet Icon={IconForward} color={fg} sub={fg} text={_tt(t, 'advPriv.bulletExport', 'Ninguém pode exportar a conversa nem encaminhar as mídias dela.')} />
          <Bullet Icon={IconDownload} color={fg} sub={fg} text={_tt(t, 'advPriv.bulletGallery', 'As mídias não são salvas automaticamente na galeria.')} />
          <Bullet Icon={IconSparkles} color={fg} sub={fg} text={_tt(t, 'advPriv.bulletAi', 'A Bia não lê as mensagens desta conversa.')} />
        </ScrollView>

        <View style={[s.row, { borderTopColor: line }]}>
          <Text style={[s.rowLabel, { color: fg }]}>{_tt(t, 'advPriv.toggle', 'Ativar privacidade avançada')}</Text>
          {busy ? <ActivityIndicator size="small" color={fg} style={{ marginRight: 8 }} /> : null}
          <Switch
            value={!!enabled}
            onValueChange={(v) => { if (canEdit && !busy) onToggle?.(v); }}
            disabled={!canEdit || !!busy}
            trackColor={track}
            thumbColor={thumb}
            activeThumbColor={onThumb}
            ios_backgroundColor={track.false}
            accessibilityLabel={_tt(t, 'advPriv.toggle', 'Ativar privacidade avançada')}
          />
        </View>
        {enabled ? (
          <View style={[s.row, { borderTopColor: line }]}>
            <Text style={[s.rowLabel, { color: fg }]}>{_tt(t, 'advPriv.screenshotToggle', 'Avisar quando alguém tirar print')}</Text>
            <Switch
              value={screenshotNotice !== false}
              onValueChange={(v) => { if (canEdit && !busy) onToggleScreenshot?.(v); }}
              disabled={!canEdit || !!busy}
              trackColor={track}
              thumbColor={thumbFor(screenshotNotice !== false)}
              activeThumbColor={onThumb}
              ios_backgroundColor={track.false}
              accessibilityLabel={_tt(t, 'advPriv.screenshotToggle', 'Avisar quando alguém tirar print')}
            />
          </View>
        ) : null}
        {!canEdit ? (
          <Text style={[s.note, { color: sub }]}>{_tt(t, 'advPriv.adminOnly', 'Só administradores do grupo podem alterar.')}</Text>
        ) : null}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  panel: { borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 18, paddingTop: 16 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  title: { flex: 1, fontSize: 17, fontWeight: '600' },
  intro: { fontSize: 14, lineHeight: 19, marginBottom: 10 },
  bullet: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 7 },
  bulletIcon: { width: 22, alignItems: 'center', paddingTop: 1 },
  bulletText: { flex: 1, fontSize: 14.5, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, marginTop: 6 },
  rowLabel: { flex: 1, fontSize: 15.5, fontWeight: '500', paddingRight: 8 },
  note: { fontSize: 13, lineHeight: 18, marginTop: 6 },
});
