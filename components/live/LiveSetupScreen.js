/**
 * LiveSetupScreen — tela pré-live (host) no padrão TikTok/Instagram Live.
 *
 * [live-setup 2026-10-12] Primeiro redesenho: prévia da câmera em tela cheia,
 * sheet inferior sobre degradê, contagem 3-2-1.
 *
 * [live-setup 2026-10-17] Segundo polimento ("deixa essa parte de live mais
 * bonita, esses ícones não são modernos"):
 *   • Ícones novos em traço único (Lucide): virar câmera = câmera + setas
 *     girando (o antigo virava um glifo "Fo"), efeitos = brilho em contorno.
 *   • Ferramentas num TRILHO VERTICAL à direita (círculos de vidro 44pt com
 *     rótulo pequeno embaixo), estilo TikTok; fechar fica sozinho à esquerda.
 *   • Controles de baixo num PAINEL DE VIDRO único (iOS: blur nativo via
 *     NativeBlur, com guarda de binário; Android: fumê sólido; web:
 *     backdrop-filter). Raios consistentes: painel 28 · campos 16 · pílulas.
 *   • Categorias em scroll horizontal com bordas esfumadas.
 *   • Botão "Ao vivo" com ponto vermelho + halo pulsante; com Reduzir
 *     Movimento o ponto fica estático (useReducedMotion de constants/motion).
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
import { getNativeBlurView } from '../NativeBlur';
import { useReducedMotion } from '../../constants/motion';
import {
  IconX, IconSwitchCamera, IconSparklesOutline, IconGlobe, IconUsers, IconLock,
  IconBroadcast, IconCalendar, IconCamera, IconSettings,
} from '../Icons';

const LIVE_RED = '#dc2626'; // [2026-10-16 polish-lives] mesmo vermelho de AO VIVO do resto (era #FF3B30)
const TITLE_MAX = 100;
const STROKE = 1.9; // traço único p/ todos os ícones desta tela
const IS_WEB = Platform.OS === 'web';

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
            <Stop offset="1" stopColor="#000" stopOpacity={0.55} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

// Superfície de vidro: iOS = UIVisualEffectView (se o binário tiver ExpoBlur),
// web = backdrop-filter, Android/sem módulo = fumê sólido. O pai define o raio;
// overflow hidden recorta o blur.
function Glass({ style, children, intensity = 40, tintOpacity = 0.28, solid = 'rgba(22,22,22,0.62)', plain = false }) {
  // `plain` = estado ativo (fundo branco sólido): sem blur por cima.
  const BlurView = plain ? null : getNativeBlurView();
  return (
    <View style={[styles.glassBase, !BlurView && !IS_WEB ? { backgroundColor: solid } : null, style]}>
      {BlurView ? (
        <BlurView intensity={intensity} tint="systemUltraThinMaterialDark" style={StyleSheet.absoluteFillObject} pointerEvents="none">
          <View style={[StyleSheet.absoluteFillObject, { backgroundColor: `rgba(0,0,0,${tintOpacity})` }]} />
        </BlurView>
      ) : null}
      {children}
    </View>
  );
}

function GlassCircle({ onPress, label, children, active, size = 44 }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={active != null ? { selected: !!active } : undefined}
    >
      <Glass
        style={[styles.glassCircle, { width: size, height: size, borderRadius: size / 2 }, active && styles.glassCircleActive]}
        solid={active ? '#fff' : 'rgba(22,22,22,0.55)'}
        plain={!!active}
      >
        {children}
      </Glass>
    </TouchableOpacity>
  );
}

// Botão do trilho lateral: círculo de vidro + rótulo pequeno embaixo.
function RailButton({ onPress, label, active, children }) {
  return (
    <View style={styles.railItem}>
      <GlassCircle onPress={onPress} label={label} active={active}>
        {children}
      </GlassCircle>
      <Text style={styles.railLabel} numberOfLines={1}>{label}</Text>
    </View>
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
  const reduceMotion = useReducedMotion();
  // Telas baixas (iPhone SE/8): avatar menor p/ o CTA não encostar no topo.
  const [midH, setMidH] = useState(0);
  const compactMid = midH > 0 && midH < 340;
  const tr = (k, fb) => { const v = t(k); return v && v !== k ? v : fb; };
  const name = user?.name || (user?.email ? String(user.email).split('@')[0] : '');
  const kbOpen = kbHeight > 0 && titleFocused;
  const counting = countdown !== null && countdown !== undefined;
  const isWeb = IS_WEB;
  const pulse = dotPulse && !reduceMotion ? dotPulse : null;

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
  // [2026-10-22 kb-uniforme] Android: o evento do RN dá a altura SEM a barra de navegação
  // (edge-to-edge: o teclado cobre a barra também) → soma o inset de baixo. iOS igual.
  const bottomPad = kbOpen ? kbHeight + (Platform.OS === 'android' ? (insets?.bottom || 0) : 0) + 10 : Math.max(insets.bottom, 12) + 8;
  const flipLabel = tr('live.flipCamera', 'Virar câmera');
  const fxLabel = tr('live.effects', 'Efeitos');

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

      <Scrim id="lsu-top" from={0.5} to={0} style={[styles.scrimTop, { height: insets.top + 140 }]} />
      <Scrim id="lsu-bot" from={0} mid={0.4} to={0.85} style={styles.scrimBottom} />

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
          {/* Topo: fechar (esq.) · trilho vertical de ferramentas (dir.) */}
          <View style={styles.topBar}>
            <GlassCircle onPress={onClose} label={tr('common.close', 'Fechar')} size={40}>
              <IconX size={20} color="#fff" strokeWidth={2} />
            </GlassCircle>
            {!kbOpen ? (
              <View style={styles.rail}>
                <RailButton onPress={onFlip} label={flipLabel}>
                  <IconSwitchCamera size={21} color="#fff" strokeWidth={STROKE} />
                </RailButton>
                <RailButton onPress={onFilters} label={fxLabel} active={filterActive}>
                  <IconSparklesOutline size={21} color={filterActive ? '#000' : '#fff'} strokeWidth={STROKE} />
                </RailButton>
              </View>
            ) : null}
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

          {/* Bloco inferior: painel de vidro + botão "Ao vivo" */}
          <View style={styles.sheet}>
            <Glass style={styles.panel} intensity={45}>
              <View style={styles.hostRow}>
                <View style={styles.avatarRing}>
                  <AvatarCircle name={user?.name || user?.email} email={user?.email} size={34} />
                </View>
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
                  placeholderTextColor="rgba(255,255,255,0.45)"
                  selectionColor="#fff"
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
                          <Icon size={15} color={active ? '#000' : 'rgba(255,255,255,0.75)'} strokeWidth={STROKE} />
                          <Text style={[styles.segmentText, active && styles.segmentTextActive]} numberOfLines={1}>{opt.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {/* Categoria — scroll horizontal sangrando até a borda do painel */}
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

                  <View style={styles.divider} />

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

                  {/* Ações secundárias — duas metades iguais */}
                  <View style={styles.actionsRow}>
                    <TouchableOpacity
                      onPress={onMultistream}
                      style={styles.actionBtn}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityLabel={tr('live.multistream', 'Multistream')}
                    >
                      <IconBroadcast size={16} color="#fff" strokeWidth={STROKE} />
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
                      <IconCalendar size={16} color="#fff" strokeWidth={STROKE} />
                      <Text style={styles.actionText} numberOfLines={1}>{tr('live.scheduleLive', 'Agendar')}</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : null}
            </Glass>

            {/* Ir ao vivo */}
            {!kbOpen ? (
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
                    <View style={styles.goDotWrap}>
                      {pulse ? (
                        <Animated.View style={[styles.goHalo, {
                          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
                          transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.3] }) }],
                        }]} />
                      ) : null}
                      <Animated.View style={[styles.goDot, pulse ? {
                        transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.08] }) }],
                      } : null]} />
                    </View>
                    <Text style={styles.goText}>{tr('live.goLive', 'Ao vivo')}</Text>
                  </>
                )}
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      )}

      {children}
    </View>
  );
}

const FIELD_BG = 'rgba(255,255,255,0.08)';
const HAIRLINE = 'rgba(255,255,255,0.14)';
const R_PANEL = 28;
const R_FIELD = 16;
const PANEL_PAD = 14;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  offBg: {
    backgroundColor: '#070707',
    ...(IS_WEB ? {
      backgroundImage: 'radial-gradient(120% 70% at 50% 28%, #262626 0%, #0d0d0d 55%, #000 100%)',
    } : {}),
  },
  offGlow: {
    position: 'absolute', alignSelf: 'center', top: '12%',
    width: 420, height: 420, borderRadius: 210, backgroundColor: 'rgba(255,255,255,0.05)',
  },
  scrimTop: { position: 'absolute', top: 0, left: 0, right: 0 },
  scrimBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '60%' },
  column: { ...StyleSheet.absoluteFillObject, flexDirection: 'column' },
  topBar: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  rail: { alignItems: 'center', gap: 14, marginTop: -2 },
  railItem: { alignItems: 'center', width: 64, gap: 5 },
  railLabel: {
    color: '#fff', fontSize: 11, fontWeight: '600', letterSpacing: 0.1, textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4, textShadowOffset: { width: 0, height: 1 },
  },
  glassBase: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.18)',
    ...(IS_WEB ? {
      backgroundColor: 'rgba(20,20,20,0.42)',
      backdropFilter: 'blur(20px) saturate(140%)', WebkitBackdropFilter: 'blur(20px) saturate(140%)',
    } : {}),
  },
  glassCircle: {
    alignItems: 'center', justifyContent: 'center',
    ...(IS_WEB ? { cursor: 'pointer' } : {}),
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
    paddingHorizontal: 12, gap: 10,
  },
  panel: { borderRadius: R_PANEL, padding: PANEL_PAD, gap: 12 },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatarRing: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.85)',
  },
  hostName: { color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: -0.1 },
  hostHint: { color: 'rgba(255,255,255,0.62)', fontSize: 12.5, marginTop: 1 },
  titleBox: {
    height: 46, borderRadius: R_FIELD, paddingLeft: 14, paddingRight: 12,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: FIELD_BG, borderWidth: 1, borderColor: 'transparent',
  },
  titleBoxFocused: { borderColor: 'rgba(255,255,255,0.5)', backgroundColor: 'rgba(255,255,255,0.1)' },
  titleInput: {
    flex: 1, minWidth: 0, color: '#fff', fontSize: 16, fontWeight: '600',
    paddingVertical: 0, height: '100%',
  },
  titleCounter: { color: 'rgba(255,255,255,0.5)', fontSize: 12, fontVariant: ['tabular-nums'] },
  segment: {
    flexDirection: 'row', height: 40, borderRadius: R_FIELD, padding: 3,
    backgroundColor: FIELD_BG,
  },
  segmentItem: {
    flex: 1, borderRadius: R_FIELD - 3, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  segmentItemActive: {
    backgroundColor: '#fff',
    ...(IS_WEB ? { boxShadow: '0 2px 8px rgba(0,0,0,0.25)' } : {
      shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2,
    }),
  },
  segmentText: { color: 'rgba(255,255,255,0.78)', fontSize: 13.5, fontWeight: '600' },
  segmentTextActive: { color: '#000', fontWeight: '700' },
  catWrap: { marginHorizontal: -PANEL_PAD, position: 'relative' },
  catContent: { paddingHorizontal: PANEL_PAD, gap: 8 },
  catMaskWeb: IS_WEB ? {
    maskImage: 'linear-gradient(to right, transparent 0, #000 14px, #000 calc(100% - 28px), transparent 100%)',
    WebkitMaskImage: 'linear-gradient(to right, transparent 0, #000 14px, #000 calc(100% - 28px), transparent 100%)',
  } : {},
  edgeFade: { position: 'absolute', top: 0, bottom: 0, width: 24 },
  chip: {
    height: 32, paddingHorizontal: 14, borderRadius: 16, justifyContent: 'center',
    backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  chipActive: { backgroundColor: '#fff', borderColor: '#fff' },
  chipText: { color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: '#000', fontWeight: '700' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: HAIRLINE, marginHorizontal: 2 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 2 },
  toggleLabel: { color: '#fff', fontSize: 14.5, fontWeight: '600' },
  toggleHint: { color: 'rgba(255,255,255,0.55)', fontSize: 12, marginTop: 1 },
  switch: { width: 44, height: 26, borderRadius: 13, padding: 3, backgroundColor: 'rgba(255,255,255,0.2)' },
  switchOn: { backgroundColor: '#fff' },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
  knobOn: { backgroundColor: '#000', transform: [{ translateX: 18 }] },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actionBtn: {
    flex: 1, height: 40, paddingHorizontal: 12, borderRadius: R_FIELD,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: FIELD_BG,
    ...(IS_WEB ? { cursor: 'pointer' } : {}),
  },
  actionText: { color: '#fff', fontSize: 13.5, fontWeight: '600', flexShrink: 1 },
  actionBadge: {
    minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5,
    backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center',
  },
  actionBadgeText: { color: '#000', fontSize: 11, fontWeight: '800' },
  goBtn: {
    height: 56, borderRadius: 28, backgroundColor: '#fff',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    ...(IS_WEB ? { boxShadow: '0 10px 30px rgba(0,0,0,0.5)', cursor: 'pointer' } : {
      shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 8,
    }),
  },
  goDotWrap: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  goHalo: { position: 'absolute', width: 12, height: 12, borderRadius: 6, backgroundColor: LIVE_RED },
  goDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: LIVE_RED },
  goText: { color: '#000', fontSize: 17, fontWeight: '800', letterSpacing: 0.1 },
  countdownWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  countdownNum: {
    color: '#fff', fontSize: 132, fontWeight: '800', lineHeight: 150,
    textShadowColor: 'rgba(0,0,0,0.45)', textShadowRadius: 18, textShadowOffset: { width: 0, height: 4 },
  },
  countdownHint: { color: 'rgba(255,255,255,0.85)', fontSize: 15, fontWeight: '600', marginTop: 4 },
});
