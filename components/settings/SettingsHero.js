// [2026-10-15 settings-2026] Topo das Configurações "nível 2026" (iOS 26 /
// Telegram / Arc): perfil como HERO — avatar grande centralizado com anel
// sutil, nome em tipografia forte, @usuário · telefone, recado; ações rápidas
// em pílulas (Editar perfil, Trocar conta, QR). Ao rolar, o hero encolhe e
// some em direção ao título (scrollY = Animated.Value do ScrollView; driver
// nativo). Abaixo: cartões especiais (Chatyy One / Carteira) e a linha de
// Contas (avatares sobrepostos) + Dispositivos conectados.
// Só RN Animated + SVG (Icons) → OTA-safe, funciona no web. Reduzir
// Movimento: sem encolher/parallax.
import React from 'react';
import { View, Text, Animated, StyleSheet, Platform } from 'react-native';
import AvatarCircle from '../AvatarCircle';
import PressableScale from '../PressableScale';
import { useLanguage } from '../../context/LanguageContext';
import { useReducedMotion } from '../reducedMotion';
import { useGroupedColors, SettingsGroup, SettingsRow } from './SettingsKit';
import Svg, { Path } from 'react-native-svg';
import { IconEdit, IconRepeat, IconSparkles, IconMonitor, IconUsers, IconChevronRight } from '../Icons';

function QrGlyph({ size = 18, color }) {
  // Mesmo desenho do botão QR antigo (4 quadrados), em traço fino.
  const u = size / 18;
  const box = (x, y) => (
    <View key={`${x}-${y}`} style={{ position: 'absolute', left: x * u, top: y * u, width: 7 * u, height: 7 * u, borderRadius: 2 * u, borderWidth: 1.7 * u, borderColor: color }} />
  );
  return (
    <View style={{ width: size, height: size }}>
      {box(0, 0)}{box(11, 0)}{box(0, 11)}
      <View style={{ position: 'absolute', left: 11 * u, top: 11 * u, width: 3 * u, height: 3 * u, borderRadius: 1, backgroundColor: color }} />
      <View style={{ position: 'absolute', left: 15 * u, top: 15 * u, width: 3 * u, height: 3 * u, borderRadius: 1, backgroundColor: color }} />
    </View>
  );
}

// Diamante monocromático em traço fino (o IconDiamond do app é azul/colorido).
function DiamondLine({ size = 18, color }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round">
      <Path d="M6 3.5h12l3.5 5.5L12 20.5 2.5 9 6 3.5Z" />
      <Path d="M2.5 9h19M9 3.5 7.5 9 12 20.5 16.5 9 15 3.5" />
    </Svg>
  );
}

// [2026-10-16 polish] pílulas de 36 → alvo de toque ≥44 sem mudar o desenho.
const PILL_SLOP = { top: 4, bottom: 4, left: 4, right: 4 };
function Pill({ icon: Icon, label, onPress, primary, testID, a11y, square }) {
  const g = useGroupedColors();
  const fg = primary ? g.onInk : g.text;
  return (
    <PressableScale
      onPress={onPress}
      haptic="light"
      scaleTo={0.95}
      hitSlop={PILL_SLOP}
      accessibilityRole="button"
      accessibilityLabel={a11y || label}
      testID={testID}
      style={[
        st.pill,
        square && st.pillSquare,
        { backgroundColor: primary ? g.ink : g.cardBg, borderColor: primary ? g.ink : g.separator },
      ]}
    >
      {Icon ? <Icon size={16} color={fg} /> : null}
      {!!label && <Text style={[st.pillText, { color: fg }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>{label}</Text>}
    </PressableScale>
  );
}

export function SettingsHero({ user, profile, avatarKey, scrollY, onEdit, onQr, onSwitch }) {
  const g = useGroupedColors();
  const { t } = useLanguage();
  const reduce = useReducedMotion();
  const name = (profile?.name || user?.name || user?.display_name || '').trim()
    || (user?.email ? user.email.split('@')[0] : '');
  const handle = (profile?.username || '').trim();
  const phone = (profile?.phone || user?.phone || '').trim();
  const about = (profile?.about || profile?.recado || profile?.bio || '').trim();
  const idLine = [handle ? '@' + handle : '', phone].filter(Boolean).join('  ·  ') || (user?.email || '');

  const animated = !!scrollY && !reduce;
  const avatarStyle = animated ? {
    transform: [
      { scale: scrollY.interpolate({ inputRange: [0, 150], outputRange: [1, 0.55], extrapolate: 'clamp' }) },
      { translateY: scrollY.interpolate({ inputRange: [0, 150], outputRange: [0, 46], extrapolate: 'clamp' }) },
    ],
    opacity: scrollY.interpolate({ inputRange: [0, 110, 170], outputRange: [1, 0.6, 0], extrapolate: 'clamp' }),
  } : null;
  const textStyle = animated ? {
    opacity: scrollY.interpolate({ inputRange: [0, 90, 150], outputRange: [1, 0.5, 0], extrapolate: 'clamp' }),
    transform: [{ translateY: scrollY.interpolate({ inputRange: [0, 150], outputRange: [0, 20], extrapolate: 'clamp' }) }],
  } : null;

  return (
    <View style={st.hero}>
      <Animated.View style={avatarStyle}>
        <PressableScale
          onPress={onEdit}
          haptic="light"
          scaleTo={0.96}
          accessibilityRole="button"
          accessibilityLabel={`${t('settings.editProfile')}: ${name}`}
          testID="settings-profile-card"
          style={[st.ring, { borderColor: g.ring }]}
        >
          <AvatarCircle key={avatarKey} email={user?.email} name={name || user?.email} size={96} />
        </PressableScale>
      </Animated.View>
      <Animated.View style={[{ alignItems: 'center', width: '100%' }, textStyle]}>
        <Text style={[st.name, { color: g.text }]} numberOfLines={1} accessibilityRole="header" maxFontSizeMultiplier={1.6}>{name}</Text>
        {!!idLine && <Text style={[st.idLine, { color: g.secondary }]} numberOfLines={1} maxFontSizeMultiplier={1.6}>{idLine}</Text>}
        {!!about && <Text style={[st.about, { color: g.secondary }]} numberOfLines={2} maxFontSizeMultiplier={1.6}>{about}</Text>}
        <View style={st.pills}>
          <Pill icon={IconEdit} label={t('common.edit') || 'Editar'} a11y={t('settings.editProfile')} onPress={onEdit} primary testID="settings-hero-edit" />
          {onSwitch ? <Pill icon={IconRepeat} label={t('account.switch') || 'Trocar conta'} onPress={onSwitch} testID="settings-hero-switch" /> : null}
          {onQr ? (
            <PressableScale
              onPress={onQr}
              haptic="light"
              scaleTo={0.92}
              hitSlop={PILL_SLOP}
              accessibilityRole="button"
              accessibilityLabel={t('profile.qrCode')}
              testID="settings-profile-qr"
              style={[st.pill, st.pillSquare, { backgroundColor: g.cardBg, borderColor: g.separator }]}
            >
              <QrGlyph size={16} color={g.text} />
            </PressableScale>
          ) : null}
        </View>
      </Animated.View>
    </View>
  );
}

// Avatares sobrepostos (até 3) das contas salvas no aparelho.
function StackedAvatars({ list }) {
  const g = useGroupedColors();
  const shown = list.slice(0, 3);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {shown.map((a, i) => (
        <View key={a.email} style={{ marginLeft: i === 0 ? 0 : -9, borderRadius: 15, borderWidth: 2, borderColor: g.cardBg, zIndex: 10 - i }}>
          <AvatarCircle email={a.email} name={a.name || a.email} size={26} />
        </View>
      ))}
    </View>
  );
}

// Cartão compacto (2 por linha) — Chatyy One / Carteira.
function FeatureTile({ icon: Icon, title, subtitle, onPress, testID }) {
  const g = useGroupedColors();
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
    <PressableScale onPress={onPress} haptic="light" scaleTo={0.97} accessibilityRole="button" accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title} testID={testID} containerStyle={st.tileFill} style={[st.tile, st.tileFill, { backgroundColor: g.cardBg }]}>
      <View style={st.tileTop}>
        <View style={[st.tileIcon, { backgroundColor: g.chipBg }]}><Icon size={17} color={g.chipFg} /></View>
        <IconChevronRight size={15} color={g.tertiary} />
      </View>
      <Text style={[st.tileTitle, { color: g.text }]} numberOfLines={1}>{title}</Text>
      {!!subtitle && <Text style={[st.tileSub, { color: g.secondary }]} numberOfLines={2}>{subtitle}</Text>}
    </PressableScale>
    </View>
  );
}

export function SettingsSpecialCards({ user, accounts, walletDiamonds, onOne, onWallet, onAccounts, onDevices }) {
  const { t } = useLanguage();
  const active = (user?.email || '').toLowerCase();
  const list = [];
  const seen = new Set();
  const push = (a) => { const e = (a?.email || '').toLowerCase(); if (!e || seen.has(e)) return; seen.add(e); list.push({ email: a.email, name: a.name || '' }); };
  if (user?.email) push({ email: user.email, name: user.name || user.display_name });
  (accounts || []).forEach(push);
  const others = list.filter(a => a.email.toLowerCase() !== active);
  const accountsSub = others.length
    ? others.map(a => (a.name || a.email.split('@')[0])).slice(0, 2).join(', ')
    : (user?.email || '');
  const fmt = (n) => { try { return Number(n).toLocaleString(); } catch { return String(n); } };
  return (
    <View>
      <View style={st.tilesRow}>
        <FeatureTile icon={IconSparkles} title="Chatyy One" subtitle={t('chatyyOne.rowDesc')} onPress={onOne} testID="settings-tile-one" />
        {walletDiamonds !== null && walletDiamonds !== undefined ? (
          <FeatureTile icon={DiamondLine} title={t('wallet.title') || 'Carteira'} subtitle={`${fmt(walletDiamonds)} ${t('wallet.diamondsLabel') || ''}`.trim()} onPress={onWallet} testID="settings-tile-wallet" />
        ) : null}
      </View>
      <SettingsGroup inset={62}>
        <SettingsRow
          icon={IconUsers}
          title={t('settings.accounts') || 'Contas'}
          subtitle={accountsSub}
          right={list.length > 1 ? <StackedAvatars list={list} /> : undefined}
          chevron
          onPress={onAccounts}
          testID="settings-row-accounts"
        />
        <SettingsRow icon={IconMonitor} title={t('settings.linkedDevices')} onPress={onDevices} testID="settings-row-devices" />
      </SettingsGroup>
    </View>
  );
}

const st = StyleSheet.create({
  hero: { alignItems: 'center', paddingTop: 8, paddingBottom: 22 },
  ring: { padding: 4, borderRadius: 60, borderWidth: 1.5, marginBottom: 14 },
  name: { fontSize: 27, fontWeight: '700', letterSpacing: -0.7, textAlign: 'center', paddingHorizontal: 12 },
  idLine: { fontSize: 15, marginTop: 4, letterSpacing: -0.1, textAlign: 'center' },
  about: { fontSize: 14, lineHeight: 19, marginTop: 6, textAlign: 'center', paddingHorizontal: 28 },
  pills: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 15, borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  pillSquare: { width: 36, paddingHorizontal: 0, justifyContent: 'center' },
  pillText: { fontSize: 14, fontWeight: '600', letterSpacing: -0.15 },
  tilesRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  tileFill: { flex: 1 }, // [polish3] os 2 cartões com a mesma altura quando a legenda quebra em 2 linhas
  tile: { borderRadius: 18, padding: 14, minHeight: 92, ...Platform.select({ web: { cursor: 'pointer' }, default: {} }) },
  tileTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  tileIcon: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  tileTitle: { fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  tileSub: { fontSize: 12.5, marginTop: 2 },
});
