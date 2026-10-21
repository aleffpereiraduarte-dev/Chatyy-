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
//
// [2026-10-19 me-cover] FOTO DE CAPA como fundo do topo (perfil estilo
// Telegram/Instagram): capa em largura total (~240 pt, por baixo da status
// bar no modo imersivo), expo-image c/ cache em disco (vem do perfil em
// cache → aparece no 1º frame), degradê transparente→fundo da página em baixo
// (nome/telefone legíveis no claro e no escuro) + véu suave no topo (status
// bar/botões). Avatar sobrepõe a borda de baixo da capa com anel da cor do
// fundo. Botões sobre a capa = círculos de vidro (blur no iOS, translúcido nos
// demais). Sem capa = visual de antes.
// Modo imersivo (settings.js esconde o header nativo da raiz): voltar ·
// buscar · QR · Editar numa LINHA só (antes o voltar ocupava uma linha
// própria acima). Desligar por OTA: globalThis.__chatyy_me_hero_immersive = false.
import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, Platform, Pressable, Image as RNImage } from 'react-native';
import Svg, { Path, Rect, Defs, LinearGradient as SvgLinearGradient, Stop } from 'react-native-svg';
import AvatarCircle from '../AvatarCircle';
import PressableScale from '../PressableScale';
import SilverRing from '../ui/SilverRing';
import { THEME_V2 } from '../../constants/theme';
import { useGroupedColors } from './SettingsKit';
import { IconSearch, IconCamera, IconChevronDown, IconChevronLeft, IconArrowLeft, IconImage } from '../Icons';
import { CoverFallback, coverDefaultOn } from '../profile/ProfileMediaStudio'; // [2026-10-21 foto-capa-studio]
import { getNativeBlurView } from '../NativeBlur';
import { Spacing } from '../../constants/theme';

let _ExpoImage; // undefined = não resolvido; null = indisponível
function getExpoImage() {
  if (_ExpoImage !== undefined) return _ExpoImage;
  _ExpoImage = null;
  if (Platform.OS === 'web') return null;
  try { _ExpoImage = require('expo-image').Image || null; } catch { _ExpoImage = null; }
  return _ExpoImage;
}

// '#RGB' / '#RRGGBB' / 'rgb(a)(...)' → rgba com alfa `a`.
export function withAlpha(color, a) {
  const c = String(color || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(c);
  if (m) {
    const h = m[1];
    return `rgba(${parseInt(h[0] + h[0], 16)},${parseInt(h[1] + h[1], 16)},${parseInt(h[2] + h[2], 16)},${a})`;
  }
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(c);
  if (m) {
    const h = m[1];
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
  return a >= 0.5 ? c : 'transparent';
}

const AVATAR = 120;
const RING = 4;
// Quanto do avatar fica DENTRO da capa (o resto sobra para o fundo da página).
const AVATAR_IN_COVER = 78;
const COVER_MIN_H = 220;

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

// [2026-10-19 tg-settings] Kill switch da leva Telegram: globalThis.__chatyy_tg_list = false.
function _tgHeader() {
  try { return globalThis.__chatyy_tg_list !== false; } catch { return true; }
}

// Fundo do botão: sem capa = pílula cinza de sempre; sobre a capa = vidro
// (UIVisualEffectView no iOS; translúcido da cor da página nos demais).
function BtnBg({ glass, radius }) {
  const g = useGroupedColors();
  if (!glass) return null;
  const BlurView = getNativeBlurView();
  if (BlurView) {
    return (
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}>
        <BlurView tint={g.isDark ? 'dark' : 'light'} intensity={60} style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(g.pageBg, 0.28) }]} />
      </View>
    );
  }
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, backgroundColor: withAlpha(g.pageBg, 0.78) }]} />;
}

function BarButton({ onPress, label, testID, glass, children }) {
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
      style={[st.barBtn, { backgroundColor: glass ? 'transparent' : g.fill }]}
    >
      <BtnBg glass={glass} radius={19} />
      {children}
    </PressableScale>
  );
}

// Capa: expo-image (cache memória+disco → mesma URL do perfil em cache
// pinta no 1º frame, sem "pop") com fallback RN Image (web / sem módulo).
function CoverImage({ uri, onError }) {
  const ExpoImage = getExpoImage();
  if (ExpoImage) {
    return (
      <ExpoImage
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={120}
        recyclingKey={uri}
        priority="high"
        onError={onError}
        accessible={false}
      />
    );
  }
  return <RNImage source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={onError} accessible={false} />;
}

// [2026-10-21 foto-capa-studio] sem capa = degradê grafite padrão; dono (onPress) toca
// na capa ou no selo "Alterar capa" para trocar.
function CoverLayer({ uri, height, pageBg, onError, isDark, onPress, label, fg }) {
  return (
    <View pointerEvents={onPress ? 'box-none' : 'none'} style={[st.cover, { height }]} testID="settings-me-cover">
      {onPress ? (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={StyleSheet.absoluteFill} testID="settings-me-cover-tap" />
      ) : null}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {uri ? <CoverImage uri={uri} onError={onError} /> : <CoverFallback isDark={isDark} />}
      {/* Véu no topo (status bar + botões) e degradê até o fundo da página em
          baixo (nome/telefone sempre legíveis, claro e escuro). */}
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill} preserveAspectRatio="none">
        <Defs>
          <SvgLinearGradient id="meCoverTop" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={pageBg} stopOpacity={0.55} />
            <Stop offset="1" stopColor={pageBg} stopOpacity={0} />
          </SvgLinearGradient>
          <SvgLinearGradient id="meCoverBottom" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={pageBg} stopOpacity={0} />
            <Stop offset="0.55" stopColor={pageBg} stopOpacity={0.45} />
            <Stop offset="1" stopColor={pageBg} stopOpacity={1} />
          </SvgLinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="28%" fill="url(#meCoverTop)" />
        <Rect x="0" y="45%" width="100%" height="55%" fill="url(#meCoverBottom)" />
      </Svg>
      </View>
      {onPress ? (
        <PressableScale
          onPress={onPress}
          haptic="light"
          scaleTo={0.92}
          hitSlop={SLOP}
          accessibilityRole="button"
          accessibilityLabel={label}
          testID="settings-me-cover-edit"
          style={[st.coverChip, { bottom: AVATAR_IN_COVER - 34 }]}
        >
          <BtnBg glass radius={16} />
          <IconImage size={16} color={fg} />
        </PressableScale>
      ) : null}
    </View>
  );
}

// [2026-10-19 me-cover] Modo imersivo (sem header nativo): faixa fixa sob a
// status bar, degradê da cor da página → transparente. Sobre a capa é só um
// véu leve; com a lista rolada esconde as linhas atrás do relógio/bateria.
export function MeStatusScrim({ height }) {
  const g = useGroupedColors();
  if (!(height > 0)) return null;
  return (
    <View pointerEvents="none" style={[st.statusScrim, { height: height + 10 }]}>
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <SvgLinearGradient id="meStatusScrim" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={g.pageBg} stopOpacity={0.85} />
            <Stop offset="0.7" stopColor={g.pageBg} stopOpacity={0.55} />
            <Stop offset="1" stopColor={g.pageBg} stopOpacity={0} />
          </SvgLinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#meStatusScrim)" />
      </Svg>
    </View>
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
 *        onAvatar, onChangePhoto, onSwitch, onAbout,
 *        coverUrl (já normalizada; '' = sem capa),
 *        topInset (status bar — só no modo imersivo, header nativo escondido),
 *        onBack (modo imersivo: voltar na MESMA linha de buscar/QR/Editar)
 * O pai (lista nativa / ScrollView) aplica paddingHorizontal 16 + paddingTop
 * Spacing.md; a capa "sangra" essas margens (largura total).
 */
export default function MeHeader({
  user, profile, avatarKey, multiAccount, t,
  onSearch, onQr, onEdit, onAvatar, onChangePhoto, onSwitch, onAbout,
  coverUrl, topInset = 0, onBack, note, onNote, onCover,
}) {
  const g = useGroupedColors();
  const tr = (k, fb) => { try { const v = t(k); return v && v !== k ? v : fb; } catch { return fb; } };
  const { name, handle, phone, about: _about } = meDisplay(user, profile);
  // [2026-10-20 nota-perfil] Com onNote (pai liga), o balão = NOTA (Instagram
  // Notes, 24 h) e o toque abre a folha da nota; sem onNote = recado de antes.
  const noteMode = typeof onNote === 'function';
  const about = noteMode ? String(note?.text || '').trim() : _about;
  const idLine = [phone, handle ? '@' + handle : ''].filter(Boolean).join('  •  ') || (user?.email || '');

  // Capa que falhou (404/rede) some até a URL mudar → volta ao visual sem capa.
  const [failedCover, setFailedCover] = useState('');
  const realCover = coverUrl && coverUrl !== failedCover ? coverUrl : '';
  const onCoverError = useCallback(() => { setFailedCover(coverUrl || ''); }, [coverUrl]);
  // [2026-10-21 foto-capa-studio] sem capa → faixa com degradê padrão (mesmo layout da capa).
  const cover = realCover || (coverDefaultOn() ? 'default' : '');
  const glass = !!cover;
  const bleed = !!cover || topInset > 0;
  const padTop = Spacing.md;
  // Altura da capa = topo do avatar (medido) + parte do avatar dentro dela.
  // Estimativa inicial ≈ medida típica (sem salto no 1º frame).
  const [avatarTop, setAvatarTop] = useState(0);
  const estTop = padTop + topInset + 6 + 38 + 6 + 34 + 21;
  const coverH = Math.max(COVER_MIN_H + Math.min(topInset, 24), (avatarTop || estTop) + AVATAR_IN_COVER);
  const onTopLayout = useCallback((e) => {
    const h = Math.round(e?.nativeEvent?.layout?.height || 0);
    if (h > 0) setAvatarTop((prev) => (prev === h + padTop + topInset ? prev : h + padTop + topInset));
  }, [padTop, topInset]);
  const BackIcon = Platform.OS === 'ios' ? IconChevronLeft : IconArrowLeft;

  return (
    <View
      style={[st.wrap, bleed ? { marginHorizontal: -16, paddingHorizontal: 16, marginTop: -padTop, paddingTop: padTop + topInset } : null]}
      testID="settings-me-header"
    >
      {cover ? (
        <CoverLayer
          uri={realCover}
          height={coverH}
          pageBg={g.pageBg}
          isDark={g.isDark}
          onError={onCoverError}
          onPress={onCover}
          fg={g.text}
          label={realCover ? tr('photoStudio.changeCover', 'Alterar capa') : tr('photoStudio.addCover', 'Adicionar capa')}
        />
      ) : null}
      <View onLayout={onTopLayout} pointerEvents="box-none">
      <View style={st.bar} pointerEvents="box-none">
        {onBack ? (
          <>
            <BarButton onPress={onBack} label={tr('common.back', 'Voltar')} testID="settings-me-back" glass={glass}>
              <BackIcon size={Platform.OS === 'ios' ? 22 : 20} color={g.text} />
            </BarButton>
            <View style={{ flex: 1 }} pointerEvents="none" />
            <BarButton onPress={onSearch} label={tr('me.search', 'Buscar nas configurações')} testID="settings-me-search" glass={glass}>
              <IconSearch size={18} color={g.text} />
            </BarButton>
            <View style={{ width: 10 }} pointerEvents="none" />
          </>
        ) : (
          <>
            <BarButton onPress={onSearch} label={tr('me.search', 'Buscar nas configurações')} testID="settings-me-search" glass={glass}>
              <IconSearch size={18} color={g.text} />
            </BarButton>
            <View style={{ flex: 1 }} pointerEvents="none" />
          </>
        )}
        <BarButton onPress={onQr} label={tr('profile.qrCode', 'QR code')} testID="settings-me-qr" glass={glass}>
          <QrGlyph size={18} color={g.text} />
        </BarButton>
        <View style={{ width: 10 }} pointerEvents="none" />
        {_tgHeader() ? (
          // [2026-10-19 tg-settings] Telegram: botão de TEXTO "Editar" (pílula) no lugar do lápis.
          <PressableScale
            onPress={onEdit}
            haptic="light"
            scaleTo={0.94}
            hitSlop={SLOP}
            accessibilityRole="button"
            accessibilityLabel={tr('settings.editProfile', 'Editar perfil')}
            testID="settings-me-edit"
            style={[st.editPill, { backgroundColor: glass ? 'transparent' : g.fill }]}
          >
            <BtnBg glass={glass} radius={17} />
            <Text style={[st.editPillText, { color: g.text }]} maxFontSizeMultiplier={1.3}>{tr('common.edit', 'Editar')}</Text>
          </PressableScale>
        ) : (
          <BarButton onPress={onEdit} label={tr('settings.editProfile', 'Editar perfil')} testID="settings-me-edit" glass={glass}>
            <PencilGlyph size={18} color={g.text} />
          </BarButton>
        )}
      </View>

      <View style={st.center} pointerEvents="box-none">
        {/* Balão do recado (nota) — acima do avatar, com "rabinho" de bolinhas. */}
        <PressableScale
          onPress={noteMode ? onNote : (onAbout || onEdit)}
          haptic="light"
          scaleTo={0.96}
          accessibilityRole="button"
          accessibilityLabel={about ? `${noteMode ? tr('me.note.label', 'Nota') : tr('profile.about', 'Recado')}: ${about}` : tr('me.addNote', 'Adicionar nota')}
          testID="settings-me-note"
          style={[st.note, { backgroundColor: g.cardBg, borderColor: g.separator }]}
        >
          <Text style={[st.noteText, { color: about ? g.text : g.secondary }]} numberOfLines={2} maxFontSizeMultiplier={1.4}>
            {about || tr('me.addNote', 'Adicionar nota')}
          </Text>
        </PressableScale>
        <View pointerEvents="none" style={[st.dot1, { backgroundColor: g.cardBg, borderColor: g.separator }]} />
        <View pointerEvents="none" style={[st.dot2, { backgroundColor: g.cardBg, borderColor: g.separator }]} />
      </View>
      </View>

      <View style={st.center} pointerEvents="box-none">
        <View pointerEvents="box-none" style={[st.avatarBox, cover ? st.avatarBoxRing : null]}>
          <PressableScale
            onPress={onAvatar}
            haptic="light"
            scaleTo={0.97}
            accessibilityRole="imagebutton"
            accessibilityLabel={tr('profile.avatarView', 'Ver foto')}
            testID="settings-profile-card"
            style={cover ? [st.ring, { backgroundColor: g.pageBg }] : null}
          >
            {THEME_V2 && !cover ? (
              <SilverRing size={AVATAR} isDark={g.isDark} width={2} gap={3} style={{ margin: -5 }}>
                <AvatarCircle key={avatarKey} email={user?.email} uri={profile?.avatar_url || undefined} name={name || user?.email} size={AVATAR} />
              </SilverRing>
            ) : (
              <AvatarCircle key={avatarKey} email={user?.email} uri={profile?.avatar_url || undefined} name={name || user?.email} size={AVATAR} />
            )}
          </PressableScale>
          <PressableScale
            onPress={onChangePhoto || onEdit}
            haptic="light"
            scaleTo={0.9}
            hitSlop={SLOP}
            accessibilityRole="button"
            accessibilityLabel={tr('profile.avatarEditPhoto', 'Mudar foto de perfil')}
            testID="settings-me-photo"
            style={[st.camBadge, cover ? st.camBadgeRing : null, { backgroundColor: g.ink, borderColor: g.pageBg }]}
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
  statusScrim: { position: 'absolute', top: 0, left: 0, right: 0 },
  cover: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden' },
  barBtn: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  center: { alignItems: 'center' },
  editPill: {
    height: 34, paddingHorizontal: 16, borderRadius: 17, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  editPillText: { fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  note: {
    maxWidth: 220, minHeight: 34, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center',
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  noteText: { fontSize: 13.5, lineHeight: 18, textAlign: 'center', letterSpacing: -0.1 },
  dot1: { width: 9, height: 9, borderRadius: 5, borderWidth: StyleSheet.hairlineWidth, marginTop: 3, marginLeft: -18 },
  dot2: { width: 5, height: 5, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth, marginTop: 2, marginLeft: -6, marginBottom: 4 },
  avatarBox: { width: AVATAR, height: AVATAR, marginBottom: 14 },
  // Com capa: anel da cor da página (avatar "recortado" sobre a capa); a caixa
  // cresce RING p/ cada lado sem mexer no centro do avatar.
  avatarBoxRing: { width: AVATAR + RING * 2, height: AVATAR + RING * 2, marginTop: -RING, marginBottom: 14 - RING },
  ring: { width: AVATAR + RING * 2, height: AVATAR + RING * 2, borderRadius: (AVATAR + RING * 2) / 2, padding: RING },
  camBadgeRing: { right: RING, bottom: 2 + RING },
  camBadge: {
    position: 'absolute', right: 0, bottom: 2, width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', borderWidth: 3,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 12, maxWidth: '100%' },
  name: { fontSize: 26, fontWeight: '700', letterSpacing: -0.6, textAlign: 'center' },
  switchBtn: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  coverChip: {
    position: 'absolute', right: 16, width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  idLine: { fontSize: 15, marginTop: 4, letterSpacing: -0.1, textAlign: 'center' },
});
