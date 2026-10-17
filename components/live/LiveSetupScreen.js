/**
 * LiveSetupScreen — tela pré-live (host) no padrão TikTok/Instagram Live.
 *
 * [live-setup 2026-10-12] Redesenho pedido pelo founder ("deixa essa página de
 * live mais bonita e moderna"). Antes: card escuro centralizado sobre fundo
 * preto, sem prévia da câmera, categorias cortadas na borda do card, botão
 * "Ao vivo" sobreposto aos botões e o avatar de fallback do preview vazando
 * por trás do card translúcido (artefato "fantasma" atrás de "Amigos").
 *
 * Agora:
 *   • Prévia da câmera em tela cheia como fundo (a MESMA prévia/track que a
 *     live usa — renderPreview() vem do live-broadcast). Sem câmera: gradiente
 *     escuro + avatar + CTA "Permitir câmera" (nunca há avatar atrás do sheet).
 *   • Barra de topo: fechar (esq.) · virar câmera + filtro (dir.), 44pt vidro.
 *   • Sheet inferior sobre degradê: título (1 linha + contador), público em
 *     controle segmentado, categorias com scroll e bordas esfumadas, "Só
 *     assinantes", ações secundárias compactas e botão "Ao vivo" 56pt fixo
 *     acima da área segura. Com teclado aberto, só o título fica visível.
 *   • Contagem 3-2-1 em tela cheia (anim. vem do live-broadcast).
 *
 * Só apresentação: todo estado/handler (publish LiveKit, público, categoria,
 * multistream, agendar, só assinantes) continua no live-broadcast.js.
 */
import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, Animated,
  ScrollView, Keyboard, Pressable, ActivityIndicator,
} from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import AvatarCircle from '../AvatarCircle';
import {
  IconX, IconCameraFlip, IconSparkles, IconGlobe, IconUsers, IconLock,
  IconRepeat, IconCalendar, IconCamera, IconSettings,
} from '../Icons';

const LIVE_RED = '#dc2626'; // [2026-10-16 polish-lives] mesmo vermelho de AO VIVO do resto (era #FF3B30)
const TITLE_MAX = 100;

// Degradê vertical preto (react-native-svg funciona em nativo e web; o app não
// tem expo-linear-gradient). `id` precisa ser único por instância no web.
function Scrim({ id, from, to, mid = null, style }) {
  return (
    <View pointerEvents="none" style={style}>
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          {/* [2026-10-12] Nunca passar filho null ao LinearGradient: o react-native-svg
              nativo faz cloneElement em cada filho e quebra a tela no iPhone. */}
          {mid != null ? (
            <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#000" stopOpacity={from} />
              <Stop offset="0.45" stopColor="#000" stopOpacity={mid} />
              <Stop offset="1" stopColor="#000" stopOpacity={to} />
            </LinearGradient>
          ) : (
            <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#000" stopOpacity={from} />
              <Stop offset="1" stopColor="#000" stopOpacity={to} />
            </LinearGradient>
          )}
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

// Borda esfumada horizontal (nativo) — o web usa mask-image no próprio scroll.
function EdgeFade({ id, side }) {
  return (
    <View pointerEvents="none" style={[styles.edgeFade, side === 'left' ? { left: 0 } : { right: 0 }]}>
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={id} x1={side === 'left' ? '1' : '0'} y1="0" x2={side === 'left' ? '0' : '1'} y2="0">
            <Stop offset="0" stopColor="#000" stopOpacity={0} />
            <Stop offset="1" stopColor="#000" stopOpacity={0.85} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

function GlassCircle({ onPress, label, children, active }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.glassCircle, active && styles.glassCircleActive]}
      activeOpacity={0.75}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {children}
    </TouchableOpacity>
  );
}

export default function LiveSetupScreen({
  t, insets, user, kbHeight = 0,
  // Prévia
  cameraState = 'checking', // checking | on | needs | denied
  renderPreview, filterTint = null,
  onAllowCamera, onOpenSettings,
  // Topo
  onClose, onFlip, onFilters, filterActive = false,
  // Formulário
  title, onChangeTitle,
  audience, onChangeAudience,
  category, onChangeCategory,
  subscribersOnly, onToggleSubscribers,
  multistreamCount = 0, onMultistream, onSchedule,
  // Ir ao vivo
  onGoLive, going = false,
  countdown = null, countdownScale, countdownOpacity, dotPulse,
  // Sheets (multistream/agendar/filtro) desenhados por cima de tudo.
  children,
}) {
  const [titleFocused, setTitleFocused] = useState(false);
  // Telas baixas (iPhone SE/8): avatar menor p/ o CTA não encostar no topo.
  const [midH, setMidH] = useState(0);
  const compactMid = midH > 0 && midH < 340;
  const tr = (k, fb) => { const v = t(k); return v && v !== k ? v : fb; };
  const name = user?.name || (user?.email ? String(user.email).split('@')[0] : '');
  const kbOpen = kbHeight > 0 && titleFocused;
  const counting = countdown !== null && countdown !== undefined;
  const isWeb = Platform.OS === 'web';

  const audOptions = [
    { key: 'public', Icon: IconGlobe, label: tr('live.audPublic', 'Público') },
    { key: 'friends', Icon: IconUsers, label: tr('live.audFriends', 'Amigos') },
    { key: 'private', Icon: IconLock, label: tr('live.audPrivate', 'Privado') },
  ];
  // Mesmas 8 chaves do backend + "Geral" (vazio = sem categoria).
  const categories = [
    { key: '', label: tr('live.catGeneral', 'Geral') },
    { key: 'gaming', label: tr('live.catGaming', 'Gaming') },
    { key: 'music', label: tr('live.catMusic', 'Música') },
    { key: 'chat', label: tr('live.catChat', 'Bate-papo') },
    { key: 'food', label: tr('live.catFood', 'Comida') },
    { key: 'travel', label: tr('live.catTravel', 'Viagens') },
    { key: 'tech', label: tr('live.catTech', 'Tecnologia') },
    { key: 'sports', label: tr('live.catSports', 'Esportes') },
    { key: 'learning', label: tr('live.catLearning', 'Aprendizado') },
  ];

  const camOn = cameraState === 'on';
  const bottomPad = kbOpen ? kbHeight + 10 : Math.max(insets.bottom, 12) + 10;

  return (
    <View style={styles.root}>
      {/* Fundo: prévia real da câmera OU gradiente escuro (sem avatar aqui —
          o avatar do estado "sem câmera" vive na área livre acima do sheet). */}
      {camOn && renderPreview ? renderPreview() : (
        <View style={[StyleSheet.absoluteFill, styles.offBg]}>
          {!isWeb ? <View pointerEvents="none" style={styles.offGlow} /> : null}
        </View>
      )}
      {camOn && filterTint ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: filterTint }]} /> : null}

      <Scrim id="lsu-top" from={0.55} to={0} style={[styles.scrimTop, { height: insets.top + 110 }]} />
      <Scrim id="lsu-bot" from={0} mid={0.55} to={0.92} style={styles.scrimBottom} />

      {counting ? (
        <View style={styles.countdownWrap} pointerEvents="none">
          <Animated.Text style={[styles.countdownNum, {
            transform: [{ scale: countdownScale || 1 }],
            opacity: countdownOpacity || 1,
          }]}>
            {countdown}
          </Animated.Text>
          <Text style={styles.countdownHint}>{tr('liveSetup.countdownHint', 'Você vai entrar ao vivo')}</Text>
        </View>
      ) : (
        <View style={[styles.column, { paddingTop: insets.top + 8, paddingBottom: bottomPad }]}>
          {/* Barra de topo */}
          <View style={styles.topBar}>
            <GlassCircle onPress={onClose} label={tr('common.close', 'Fechar')}>
              <IconX size={20} color="#fff" />
            </GlassCircle>
            <View style={styles.topRight}>
              <GlassCircle onPress={onFlip} label={tr('live.flipCamera', 'Virar câmera')}>
                <IconCameraFlip size={20} color="#fff" />
              </GlassCircle>
              <GlassCircle onPress={onFilters} label={tr('live.filter', 'Filtro')} active={filterActive}>
                <IconSparkles size={19} color={filterActive ? '#000' : '#fff'} />
              </GlassCircle>
            </View>
          </View>

          {/* Área livre: toque fecha o teclado; sem câmera mostra o CTA. */}
          <Pressable style={styles.middle} onLayout={(e) => setMidH(Math.round(e?.nativeEvent?.layout?.height || 0))} onPress={() => { try { Keyboard.dismiss(); } catch {} }} accessible={false}>
            {!camOn && !kbOpen ? (
              <View style={styles.offCenter}>
                <AvatarCircle name={user?.name || user?.email} email={user?.email} size={compactMid ? 56 : 88} style={styles.offAvatar} />
                {cameraState === 'checking' ? (
                  <ActivityIndicator color="rgba(255,255,255,0.7)" style={{ marginTop: 18 }} />
                ) : (
                  <>
                    <Text style={styles.offText}>
                      {cameraState === 'denied'
                        ? (isWeb
                          ? tr('liveSetup.cameraDeniedWeb', 'Acesso à câmera bloqueado. Libere nas configurações do navegador.')
                          : tr('liveSetup.cameraDenied', 'Acesso à câmera bloqueado. Libere nos Ajustes do aparelho.'))
                        : tr('liveSetup.cameraOffHint', 'Ative a câmera para ver sua prévia')}
                    </Text>
                    {cameraState === 'denied' ? (
                      !isWeb && onOpenSettings ? (
                        <TouchableOpacity onPress={onOpenSettings} style={styles.offCta} activeOpacity={0.85} accessibilityRole="button">
                          <IconSettings size={16} color="#000" />
                          <Text style={styles.offCtaText}>{tr('liveSetup.openSettings', 'Abrir Ajustes')}</Text>
                        </TouchableOpacity>
                      ) : (
                        // Web: o usuário libera no cadeado do navegador e tenta de novo.
                        <TouchableOpacity onPress={onAllowCamera} style={styles.offCtaGhost} activeOpacity={0.85} accessibilityRole="button">
                          <IconCamera size={16} color="#fff" />
                          <Text style={styles.offCtaGhostText}>{tr('common.retry', 'Tentar novamente')}</Text>
                        </TouchableOpacity>
                      )
                    ) : (
                      <TouchableOpacity onPress={onAllowCamera} style={styles.offCta} activeOpacity={0.85} accessibilityRole="button">
                        <IconCamera size={16} color="#000" />
                        <Text style={styles.offCtaText}>{tr('liveSetup.allowCamera', 'Permitir câmera')}</Text>
                      </TouchableOpacity>
                    )}
                  </>
                )}
              </View>
            ) : null}
          </Pressable>

          {/* Sheet inferior */}
          <View style={styles.sheet}>
            <View style={styles.hostRow}>
              <AvatarCircle name={user?.name || user?.email} email={user?.email} size={36} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.hostName} numberOfLines={1}>{name}</Text>
                <Text style={styles.hostHint} numberOfLines={1}>{tr('live.preHint', 'Tudo pronto pra ir ao vivo')}</Text>
              </View>
            </View>

            <View style={[styles.titleBox, titleFocused && styles.titleBoxFocused]}>
              <TextInput
                style={[styles.titleInput, isWeb ? { outlineStyle: 'none' } : null]}
                value={title}
                onChangeText={onChangeTitle}
                placeholder={tr('liveSetup.titlePlaceholder', 'Adicione um título…')}
                placeholderTextColor="rgba(255,255,255,0.5)"
                returnKeyType="done"
                blurOnSubmit
                maxLength={TITLE_MAX}
                numberOfLines={1}
                onFocus={() => setTitleFocused(true)}
                onBlur={() => setTitleFocused(false)}
                accessibilityLabel={tr('liveSetup.titlePlaceholder', 'Adicione um título…')}
              />
              {(titleFocused || (title || '').length > 0) ? (
                <Text style={styles.titleCounter}>{`${(title || '').length}/${TITLE_MAX}`}</Text>
              ) : null}
            </View>

            {!kbOpen ? (
              <>
                {/* Público — controle segmentado */}
                <View style={styles.segment} accessibilityRole="radiogroup" accessibilityLabel={tr('live.whoCanSee', 'Quem pode ver')}>
                  {audOptions.map((opt) => {
                    const Icon = opt.Icon;
                    const active = audience === opt.key;
                    return (
                      <TouchableOpacity
                        key={opt.key}
                        onPress={() => onChangeAudience(opt.key)}
                        style={[styles.segmentItem, active && styles.segmentItemActive]}
                        activeOpacity={0.85}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: active, checked: active }}
                        accessibilityLabel={`${tr('live.whoCanSee', 'Quem pode ver')}: ${opt.label}`}
                      >
                        <Icon size={14} color={active ? '#000' : 'rgba(255,255,255,0.8)'} />
                        <Text style={[styles.segmentText, active && styles.segmentTextActive]} numberOfLines={1}>{opt.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* Categoria — scroll horizontal sangrando até a borda */}
                <View style={styles.catWrap}>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.catContent}
                    style={isWeb ? styles.catMaskWeb : null}
                    accessibilityLabel={tr('live.category', 'Categoria')}
                  >
                    {categories.map((c) => {
                      const active = (category || '') === c.key;
                      return (
                        <TouchableOpacity
                          key={c.key || 'general'}
                          onPress={() => onChangeCategory(c.key)}
                          style={[styles.chip, active && styles.chipActive]}
                          activeOpacity={0.85}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                          accessibilityLabel={`${tr('live.category', 'Categoria')}: ${c.label}`}
                        >
                          <Text style={[styles.chipText, active && styles.chipTextActive]}>{c.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                  {!isWeb ? <EdgeFade id="lsu-fl" side="left" /> : null}
                  {!isWeb ? <EdgeFade id="lsu-fr" side="right" /> : null}
                </View>

                {/* Só assinantes */}
                <TouchableOpacity
                  onPress={onToggleSubscribers}
                  style={styles.toggleRow}
                  activeOpacity={0.85}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: !!subscribersOnly }}
                  accessibilityLabel={tr('live.subscribersOnly', 'Só assinantes')}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.toggleLabel} numberOfLines={1}>{tr('live.subscribersOnly', 'Só assinantes')}</Text>
                    <Text style={styles.toggleHint} numberOfLines={1}>{tr('live.subscribersOnlyHint', 'Bloqueia entrada de quem não te assina')}</Text>
                  </View>
                  <View style={[styles.switch, subscribersOnly && styles.switchOn]}>
                    <View style={[styles.knob, subscribersOnly && styles.knobOn]} />
                  </View>
                </TouchableOpacity>

                {/* Ações secundárias */}
                <View style={styles.actionsRow}>
                  <TouchableOpacity
                    onPress={onMultistream}
                    style={styles.actionBtn}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel={tr('live.multistream', 'Multistream')}
                  >
                    <IconRepeat size={15} color="#fff" />
                    <Text style={styles.actionText} numberOfLines={1}>{tr('live.multistream', 'Multistream')}</Text>
                    {multistreamCount > 0 ? (
                      <View style={styles.actionBadge}><Text style={styles.actionBadgeText}>{multistreamCount}</Text></View>
                    ) : null}
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={onSchedule}
                    style={styles.actionBtn}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel={tr('live.scheduleTitle', 'Agendar live')}
                  >
                    <IconCalendar size={15} color="#fff" />
                    <Text style={styles.actionText} numberOfLines={1}>{tr('live.scheduleLive', 'Agendar')}</Text>
                  </TouchableOpacity>
                </View>

                {/* Ir ao vivo */}
                <TouchableOpacity
                  onPress={onGoLive}
                  disabled={going}
                  style={[styles.goBtn, going && { opacity: 0.85 }]}
                  activeOpacity={0.9}
                  accessibilityRole="button"
                  accessibilityState={{ busy: going, disabled: going }}
                  accessibilityLabel={tr('live.goLive', 'Ao vivo')}
                >
                  {going ? (
                    <ActivityIndicator color="#000" />
                  ) : (
                    <>
                      <Animated.View style={[styles.goDot, dotPulse ? {
                        transform: [{ scale: dotPulse.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.15] }) }],
                      } : null]} />
                      <Text style={styles.goText}>{tr('live.goLive', 'Ao vivo')}</Text>
                    </>
                  )}
                </TouchableOpacity>
              </>
            ) : null}
          </View>
        </View>
      )}

      {children}
    </View>
  );
}

const GLASS_BG = 'rgba(255,255,255,0.12)';
const GLASS_BORDER = 'rgba(255,255,255,0.16)';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  offBg: {
    backgroundColor: '#070707',
    ...(Platform.OS === 'web' ? {
      backgroundImage: 'radial-gradient(120% 70% at 50% 28%, #262626 0%, #0d0d0d 55%, #000 100%)',
    } : {}),
  },
  offGlow: {
    position: 'absolute', alignSelf: 'center', top: '12%',
    width: 420, height: 420, borderRadius: 210, backgroundColor: 'rgba(255,255,255,0.05)',
  },
  scrimTop: { position: 'absolute', top: 0, left: 0, right: 0 },
  scrimBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '68%' },
  column: { ...StyleSheet.absoluteFillObject, flexDirection: 'column' },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  glassCircle: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.32)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.22)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', cursor: 'pointer' } : {}),
  },
  glassCircleActive: { backgroundColor: '#fff', borderColor: '#fff' },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  offCenter: { alignItems: 'center', maxWidth: 320 },
  offAvatar: { borderWidth: 2, borderColor: 'rgba(255,255,255,0.2)' },
  offText: {
    color: 'rgba(255,255,255,0.78)', fontSize: 15, lineHeight: 21, fontWeight: '500',
    textAlign: 'center', marginTop: 16,
  },
  offCta: {
    marginTop: 16, height: 44, paddingHorizontal: 20, borderRadius: 22,
    backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  offCtaText: { color: '#000', fontSize: 15, fontWeight: '700' },
  offCtaGhost: {
    marginTop: 16, height: 44, paddingHorizontal: 20, borderRadius: 22,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)', backgroundColor: 'rgba(255,255,255,0.06)',
  },
  offCtaGhostText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  sheet: {
    width: '100%', maxWidth: 520, alignSelf: 'center',
    paddingHorizontal: 16, gap: 12,
  },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  hostName: { color: '#fff', fontSize: 15, fontWeight: '700' },
  hostHint: { color: 'rgba(255,255,255,0.7)', fontSize: 12.5, marginTop: 1 },
  titleBox: {
    height: 48, borderRadius: 14, paddingLeft: 14, paddingRight: 12,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: GLASS_BG, borderWidth: 1, borderColor: GLASS_BORDER,
  },
  titleBoxFocused: { borderColor: 'rgba(255,255,255,0.45)' },
  titleInput: {
    flex: 1, minWidth: 0, color: '#fff', fontSize: 16, fontWeight: '600',
    paddingVertical: 0, height: '100%',
  },
  titleCounter: { color: 'rgba(255,255,255,0.55)', fontSize: 12, fontVariant: ['tabular-nums'] },
  segment: {
    flexDirection: 'row', height: 40, borderRadius: 20, padding: 3,
    backgroundColor: GLASS_BG, borderWidth: 1, borderColor: GLASS_BORDER,
  },
  segmentItem: {
    flex: 1, borderRadius: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  segmentItemActive: { backgroundColor: '#fff' },
  segmentText: { color: 'rgba(255,255,255,0.85)', fontSize: 13.5, fontWeight: '600' },
  segmentTextActive: { color: '#000', fontWeight: '800' },
  catWrap: { marginHorizontal: -16, position: 'relative' },
  catContent: { paddingHorizontal: 16, gap: 8 },
  catMaskWeb: Platform.OS === 'web' ? {
    maskImage: 'linear-gradient(to right, transparent 0, #000 14px, #000 calc(100% - 28px), transparent 100%)',
    WebkitMaskImage: 'linear-gradient(to right, transparent 0, #000 14px, #000 calc(100% - 28px), transparent 100%)',
  } : {},
  edgeFade: { position: 'absolute', top: 0, bottom: 0, width: 22 },
  chip: {
    height: 34, paddingHorizontal: 14, borderRadius: 17, justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: GLASS_BORDER,
  },
  chipActive: { backgroundColor: '#fff', borderColor: '#fff' },
  chipText: { color: 'rgba(255,255,255,0.88)', fontSize: 13.5, fontWeight: '600' },
  chipTextActive: { color: '#000', fontWeight: '800' },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 10, paddingHorizontal: 14, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  toggleLabel: { color: '#fff', fontSize: 14.5, fontWeight: '700' },
  toggleHint: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 1 },
  switch: { width: 46, height: 28, borderRadius: 14, padding: 3, backgroundColor: 'rgba(255,255,255,0.22)' },
  switchOn: { backgroundColor: '#fff' },
  knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff' },
  knobOn: { backgroundColor: '#000', transform: [{ translateX: 18 }] },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actionBtn: {
    height: 36, paddingHorizontal: 12, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: GLASS_BORDER,
  },
  actionText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  actionBadge: {
    minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5,
    backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center',
  },
  actionBadgeText: { color: '#000', fontSize: 11, fontWeight: '800' },
  goBtn: {
    height: 56, borderRadius: 28, backgroundColor: '#fff',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    marginTop: 2,
    ...(Platform.OS === 'web' ? { boxShadow: '0 8px 28px rgba(0,0,0,0.45)', cursor: 'pointer' } : {
      shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 6,
    }),
  },
  goDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: LIVE_RED },
  goText: { color: '#000', fontSize: 17, fontWeight: '800', letterSpacing: 0.2 },
  countdownWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  countdownNum: {
    color: '#fff', fontSize: 132, fontWeight: '800', lineHeight: 150,
    textShadowColor: 'rgba(0,0,0,0.45)', textShadowRadius: 18, textShadowOffset: { width: 0, height: 4 },
  },
  countdownHint: { color: 'rgba(255,255,255,0.85)', fontSize: 15, fontWeight: '600', marginTop: 4 },
});
