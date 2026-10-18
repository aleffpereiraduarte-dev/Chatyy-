// [2026-10-18 me-merge] Topo da tela "Você" (Configurações + meu perfil numa
// tela SÓ — WhatsApp "Você" / Telegram Ajustes). Founder: "perfil e
// configurações não podem ter as mesmas opções".
//   • barra: Buscar (esq.) · QR + lápis (dir.)
//   • balão do recado ACIMA do avatar (nota do WhatsApp); vazio = "Recado"
//   • avatar grande (120): toque = ver foto; selo de câmera = mudar foto
//   • nome (toque = editar) + chevron p/ trocar de conta (só com 2+ contas)
//   • telefone · @usuário
// RN puro (SVG) → mesmo desenho na lista nativa (cabeçalho RN hospedado pela
// ChatyySettingsList, qualquer binário) e na lista JS / web. Sem emoji.
import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import AvatarCircle from '../AvatarCircle';
import PressableScale from '../PressableScale';
import { useGroupedColors } from './SettingsKit';
import { IconSearch, IconCamera, IconChevronDown } from '../Icons';

function QrGlyph({ size = 18, color }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round">
      <Rect x="3" y="3" width="7" height="7" rx="1.6" />
      <Rect x="14" y="3" width="7" height="7" rx="1.6" />
      <Rect x="3" y="14" width="7" height="7" rx="1.6" />
      <Path d="M14 14h3v3h-3zM18 18h3v3h-3z" fill={color} stroke="none" />
    </Svg>
  );
}

function PencilGlyph({ size = 18, color }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16v4Z" />
      <Path d="m13.5 6.5 4 4" />
    </Svg>
  );
}

const SLOP = { top: 6, bottom: 6, left: 6, right: 6 };

function BarButton({ onPress, label, testID, children }) {
  const g = useGroupedColors();
  return (
    <PressableScale
      onPress={onPress}
      haptic="light"
      scaleTo={0.92}
      hitSlop={SLOP}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      style={[st.barBtn, { backgroundColor: g.fill }]}
    >
      {children}
    </PressableScale>
  );
}

export function meDisplay(user, profile) {
  const name = (profile?.name || user?.name || user?.display_name || '').trim()
    || (user?.email ? user.email.split('@')[0] : '');
  const handle = (profile?.username || '').trim().replace(/^@/, '');
  const phone = (profile?.phone || user?.phone || '').trim();
  const about = (profile?.about || profile?.recado || '').trim();
  return { name, handle, phone, about };
}

/**
 * props: user, profile, avatarKey, multiAccount, t, onSearch, onQr, onEdit,
 *        onAvatar, onChangePhoto, onSwitch, onAbout
 */
export default function MeHeader({
  user, profile, avatarKey, multiAccount, t,
  onSearch, onQr, onEdit, onAvatar, onChangePhoto, onSwitch, onAbout,
}) {
  const g = useGroupedColors();
  const tr = (k, fb) => { try { const v = t(k); return v && v !== k ? v : fb; } catch { return fb; } };
  const { name, handle, phone, about } = meDisplay(user, profile);
  const idLine = [phone, handle ? '@' + handle : ''].filter(Boolean).join('  •  ') || (user?.email || '');

  return (
    <View style={st.wrap} testID="settings-me-header">
      <View style={st.bar}>
        <BarButton onPress={onSearch} label={tr('me.search', 'Buscar nas configurações')} testID="settings-me-search">
          <IconSearch size={18} color={g.text} />
        </BarButton>
        <View style={{ flex: 1 }} />
        <BarButton onPress={onQr} label={tr('profile.qrCode', 'QR code')} testID="settings-me-qr">
          <QrGlyph size={18} color={g.text} />
        </BarButton>
        <View style={{ width: 10 }} />
        <BarButton onPress={onEdit} label={tr('settings.editProfile', 'Editar perfil')} testID="settings-me-edit">
          <PencilGlyph size={18} color={g.text} />
        </BarButton>
      </View>

      <View style={st.center}>
        {/* Balão do recado (nota) — acima do avatar, com "rabinho" de bolinhas. */}
        <PressableScale
          onPress={onAbout || onEdit}
          haptic="light"
          scaleTo={0.96}
          accessibilityRole="button"
          accessibilityLabel={about ? `${tr('profile.about', 'Recado')}: ${about}` : tr('me.addNote', 'Adicionar recado')}
          testID="settings-me-note"
          style={[st.note, { backgroundColor: g.cardBg, borderColor: g.separator }]}
        >
          <Text style={[st.noteText, { color: about ? g.text : g.secondary }]} numberOfLines={2} maxFontSizeMultiplier={1.4}>
            {about || tr('me.addNote', 'Adicionar recado')}
          </Text>
        </PressableScale>
        <View style={[st.dot1, { backgroundColor: g.cardBg, borderColor: g.separator }]} />
        <View style={[st.dot2, { backgroundColor: g.cardBg, borderColor: g.separator }]} />

        <View style={st.avatarBox}>
          <PressableScale
            onPress={onAvatar}
            haptic="light"
            scaleTo={0.97}
            accessibilityRole="imagebutton"
            accessibilityLabel={tr('profile.avatarView', 'Ver foto')}
            testID="settings-profile-card"
          >
            <AvatarCircle key={avatarKey} email={user?.email} name={name || user?.email} size={120} />
          </PressableScale>
          <PressableScale
            onPress={onChangePhoto || onEdit}
            haptic="light"
            scaleTo={0.9}
            hitSlop={SLOP}
            accessibilityRole="button"
            accessibilityLabel={tr('profile.avatarEditPhoto', 'Mudar foto de perfil')}
            testID="settings-me-photo"
            style={[st.camBadge, { backgroundColor: g.ink, borderColor: g.pageBg }]}
          >
            <IconCamera size={15} color={g.onInk} />
          </PressableScale>
        </View>

        <View style={st.nameRow}>
          <PressableScale onPress={onEdit} haptic="light" scaleTo={0.98} accessibilityRole="button" accessibilityLabel={`${tr('settings.editProfile', 'Editar perfil')}: ${name}`} testID="settings-me-name" style={{ flexShrink: 1 }}>
            <Text style={[st.name, { color: g.text }]} numberOfLines={1} accessibilityRole="header" maxFontSizeMultiplier={1.5}>{name}</Text>
          </PressableScale>
          {multiAccount && onSwitch ? (
            <PressableScale onPress={onSwitch} haptic="light" scaleTo={0.9} hitSlop={SLOP} accessibilityRole="button" accessibilityLabel={tr('account.switch', 'Trocar conta')} testID="settings-me-switch" style={[st.switchBtn, { backgroundColor: g.fill }]}>
              <IconChevronDown size={14} color={g.text} />
            </PressableScale>
          ) : null}
        </View>
        {!!idLine && <Text style={[st.idLine, { color: g.secondary }]} numberOfLines={1} maxFontSizeMultiplier={1.5}>{idLine}</Text>}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { paddingBottom: 22 },
  bar: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  barBtn: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  center: { alignItems: 'center' },
  note: {
    maxWidth: 220, minHeight: 34, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center',
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  noteText: { fontSize: 13.5, lineHeight: 18, textAlign: 'center', letterSpacing: -0.1 },
  dot1: { width: 9, height: 9, borderRadius: 5, borderWidth: StyleSheet.hairlineWidth, marginTop: 3, marginLeft: -18 },
  dot2: { width: 5, height: 5, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth, marginTop: 2, marginLeft: -6, marginBottom: 4 },
  avatarBox: { width: 120, height: 120, marginBottom: 14 },
  camBadge: {
    position: 'absolute', right: 0, bottom: 2, width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', borderWidth: 3,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 12, maxWidth: '100%' },
  name: { fontSize: 26, fontWeight: '700', letterSpacing: -0.6, textAlign: 'center' },
  switchBtn: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  idLine: { fontSize: 15, marginTop: 4, letterSpacing: -0.1, textAlign: 'center' },
});
