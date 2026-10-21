/**
 * /advanced-privacy — Advanced privacy / network privacy screen.
 *
 * Surfaced from Settings → Privacidade → "Privacidade avançada".
 *
 * Groups:
 *   - Conexão via proxy (SOCKS5)
 *   - Usar Tor (rota tudo via Tor SOCKS local)
 *   - Bloquear capturas de tela no app (FLAG_SECURE Android / SC iOS)
 *   - Permitir que outros me encontrem pelo número (discoverable opt-out)
 *   - VPN suggestion banner (auto-hidden when on VPN)
 *   - [2026-10-21 adv-privacy-ui] hero "Privacidade avançada em todas as conversas"
 *     (adv_privacy_default) + capturas nas conversas (block_screenshots)
 */

import { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, withSequence, withSpring, cancelAnimation, Easing } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useRouter } from 'expo-router';
import { useLanguage } from '../context/LanguageContext';
import { IconAlertTriangle, IconEyeOff, IconSmartphone, IconSearch, IconGlobe, IconLock, IconKey, IconForward, IconSparkles } from '../components/Icons';
import NativeSwitch from '../components/NativeSwitch';
import { useReducedMotion } from '../components/reducedMotion';
import { detailColor } from '../constants/theme';
import { useChatPrivacy } from '../components/settings/categories/shared';
import { useAdvPrivacyDefault, setAdvPrivacyDefault, useCaptureBlockGlobal, setCaptureBlockGlobal } from '../services/captureBlock';
import * as proxyCfg from '../services/proxyConfig';
import * as screenGate from '../services/screenCaptureGate';
import * as vpnDetect from '../services/vpnDetect';
import * as api from '../services/api';
import * as settingsCache from '../services/settingsCache'; // [2026-10-13 settings-instant]
import FadeSlideIn from '../components/FadeSlideIn';
import {
  SettingsScreen, SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsIconTile, useGroupedColors, grafiteTileStyle,
} from '../components/settings/SettingsKit';

export default function AdvancedPrivacyScreen() {
  const { t } = useLanguage();
  const router = useRouter();
  const g = useGroupedColors();

  // [2026-10-13 settings-instant] Último estado salvo no aparelho (por conta)
  // → abre na hora; o load abaixo atualiza em 2º plano. Senha do proxy NÃO
  // vai para o snapshot (fica só no proxyConfig).
  const [_snap] = useState(() => settingsCache.peek('adv_privacy'));
  // Proxy config
  const [proxy, setProxy] = useState(() => ({
    enabled: false, type: 'socks5', host: '', port: 1080, username: '', password: '', useTor: false,
    ...(_snap && _snap.proxy && typeof _snap.proxy === 'object' ? _snap.proxy : {}),
  }));
  // Screen capture block
  const [screenBlock, setScreenBlock] = useState(() => !!(_snap && _snap.screenBlock));
  // Discoverable
  const [discoverable, setDiscoverable] = useState(() => settingsCache.peek('discoverable') !== false);
  // VPN suggestion
  const [vpnActive, setVpnActive] = useState(() => (_snap ? _snap.vpnActive !== false : true));
  // Loading state (só na 1ª vez na vida, sem snapshot)
  const [loading, setLoading] = useState(() => !_snap);

  useEffect(() => {
    (async () => {
      try {
        const [p, s, d, v] = await Promise.all([
          proxyCfg.getProxyConfig(),
          screenGate.isScreenCaptureBlocked(),
          settingsCache.revalidate('discoverable', { force: true }).then(x => (x === null || x === undefined ? true : x)).catch(() => true),
          vpnDetect.isVpnActive(),
        ]);
        setProxy(p);
        setScreenBlock(!!s);
        setDiscoverable(!!d);
        setVpnActive(!!v);
        try { settingsCache.put('adv_privacy', { proxy: { ...(p || {}), password: '' }, screenBlock: !!s, vpnActive: !!v }); } catch {}
      } catch (e) {
        console.warn('[advanced-privacy] load failed', e?.message);
      } finally { setLoading(false); }
    })();
  }, []);

  async function saveProxy(patch) {
    const before = proxy;
    const next = { ...proxy, ...patch };
    setProxy(next);
    try { settingsCache.patch('adv_privacy', (prev) => ({ ...(prev || {}), proxy: { ...next, password: '' } })); } catch {}
    try { await proxyCfg.setProxyConfig(patch); } catch {
      setProxy(before);
      try { settingsCache.patch('adv_privacy', (prev) => ({ ...(prev || {}), proxy: { ...before, password: '' } })); } catch {}
      try { settingsCache.notifySaveFailed(t); } catch {}
    }
  }
  // [2026-10-20 wa2] Host/porta/usuário/senha: aplicar o proxy a CADA tecla derrubava
  // a conexão no meio da digitação ("1", "12", "127."…). Agora espera 900 ms parado.
  const _proxyTxtRef = useRef({ timer: null, pending: {} });
  function saveProxyText(patch) {
    const next = { ...proxy, ...patch };
    setProxy(next);
    const st = _proxyTxtRef.current;
    st.pending = { ...st.pending, ...patch };
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      const p = st.pending; st.pending = {}; st.timer = null;
      try { settingsCache.patch('adv_privacy', (prev) => ({ ...(prev || {}), proxy: { ...((prev && prev.proxy) || {}), ...p, password: '' } })); } catch {}
      try { proxyCfg.setProxyConfig(p).catch?.(() => {}); } catch {}
    }, 900);
  }
  useEffect(() => () => {
    // sair da tela com digitação pendente: aplica já
    const st = _proxyTxtRef.current;
    if (st.timer) { clearTimeout(st.timer); st.timer = null; try { proxyCfg.setProxyConfig(st.pending)?.catch?.(() => {}); } catch {} }
  }, []);
  async function saveScreenBlock(v) {
    setScreenBlock(v);
    try { settingsCache.patch('adv_privacy', (prev) => ({ ...(prev || {}), screenBlock: !!v })); } catch {}
    try { await screenGate.setScreenCaptureBlocked(v); } catch {
      setScreenBlock(!v);
      try { settingsCache.patch('adv_privacy', (prev) => ({ ...(prev || {}), screenBlock: !v })); } catch {}
      try { settingsCache.notifySaveFailed(t); } catch {}
    }
  }
  async function saveDiscoverable(v) {
    setDiscoverable(v);
    settingsCache.put('discoverable', !!v);
    try {
      const r = await api.chatDiscoverableSet(v);
      if (r && r.success === false) { setDiscoverable(!v); settingsCache.put('discoverable', !v); settingsCache.notifySaveFailed(t); }
    } catch {
      // [2026-10-21] sem rede: não fica mostrando um valor que não foi salvo.
      setDiscoverable(!v); settingsCache.put('discoverable', !v);
      try { settingsCache.notifySaveFailed(t); } catch {}
    }
  }

  // [2026-10-21 adv-privacy-ui] "Privacidade avançada em todas as conversas"
  // + "Bloquear capturas de tela nas conversas": MESMA lógica/endpoint da
  // categoria Privacidade (espelho local na hora + chat_privacy_set).
  const { savePrivacy } = useChatPrivacy();
  const advDefault = !!useAdvPrivacyDefault();
  const captureBlock = !!useCaptureBlockGlobal();
  const saveAdvDefault = (v) => {
    setAdvPrivacyDefault(!!v);
    savePrivacy({ adv_privacy_default: !!v });
  };
  const saveCaptureBlock = (v) => {
    setCaptureBlockGlobal(!!v);
    savePrivacy({ block_screenshots: !!v });
  };
  const isWeb = Platform.OS === 'web';
  const tr = (k, fb) => t(k) || fb;

  // [2026-10-21 polish] switches nativos: se o módulo recusar, volta o switch.
  // [2026-10-08 settings-redesign2] Header nativo único + listas agrupadas
  // (SettingsKit). Mesmas APIs: proxyConfig / screenCaptureGate / vpnDetect /
  // chatDiscoverableSet. Aviso de VPN em preto&branco (era amarelo).
  // [2026-10-21 adv-privacy-ui] Visual iOS/WhatsApp no tema Grafite: cartão
  // hero (escudo + estado + switch grande), grupos raio 22 com ladrilhos e
  // "Como funciona". Só apresentação.
  return (
    <SettingsScreen title={tr('privacy.advanced', 'Privacidade avançada')}>
      <AdvHeroCard on={advDefault} onChange={saveAdvDefault} tr={tr} />

      {loading ? (
        <ActivityIndicator color={g.text} style={{ marginTop: 32 }} />
      ) : (
      <FadeSlideIn>
        {/* VPN suggestion (auto-hidden if user already on VPN) */}
        {!vpnActive && (
          <SettingsGroup cardStyle={st.card22}>
            <SettingsRow
              icon={IconAlertTriangle}
              title={tr('privacy.vpnSuggestTitle', 'Considere usar uma VPN')}
              subtitle={tr('privacy.vpnSuggestBody', 'Você tem conversas criptografadas mas não está em VPN. Uma VPN esconde seu IP do servidor e da rede local.')}
              subtitleLines={4}
              numberOfLines={2}
              right={(
                <TouchableOpacity
                  onPress={() => { try { vpnDetect.dismissVpnSuggestion(); } catch {} setVpnActive(true); }}
                  style={[st.okBtn, { backgroundColor: g.fill }]}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.ok')}
                >
                  <Text style={[st.okText, { color: g.text }]}>{t('common.ok')}</Text>
                </TouchableOpacity>
              )}
            />
          </SettingsGroup>
        )}

        {/* Conversas — capturas nas conversas (incluída na privacidade avançada) */}
        {!isWeb && (
          <SettingsGroup header={tr('settings.rd2.chats', 'Conversas')} cardStyle={st.card22}>
            <SettingsSwitchRow
              icon={IconEyeOff}
              title={tr('settings.blockScreenshots', 'Bloquear capturas de tela nas conversas')}
              subtitle={advDefault
                ? tr('advPrivScreen.includedHint', 'Incluído na privacidade avançada.')
                : tr('settings.blockScreenshotsDesc', 'Ninguém consegue tirar print ou gravar a tela das suas conversas — nem você, nem quem conversa com você.')}
              value={advDefault || captureBlock}
              disabled={advDefault}
              onValueChange={saveCaptureBlock}
              testID="adv-privacy-block-screenshots"
            />
          </SettingsGroup>
        )}

        {/* Proteção de tela */}
        <SettingsGroup header={tr('privacy.sectionScreen', 'Proteção de tela')} cardStyle={st.card22}>
          <SettingsSwitchRow
            icon={IconSmartphone}
            title={tr('privacy.screenBlockLabel', 'Bloquear capturas de tela no app')}
            subtitle={tr('privacy.screenBlockDesc', 'No Android, miniaturas em "Recentes" ficam pretas. No iOS, gravações de tela são pausadas. Não impede foto-do-celular.')}
            value={screenBlock}
            onValueChange={saveScreenBlock}
            disabled={isWeb}
          />
        </SettingsGroup>

        {/* Visibilidade */}
        <SettingsGroup header={tr('privacy.sectionVisibility', 'Visibilidade')} cardStyle={st.card22}>
          <SettingsSwitchRow
            icon={IconSearch}
            title={tr('privacy.discoverableLabel', 'Encontrar pelo número')}
            subtitle={tr('privacy.discoverableDesc', 'Quando desativado, ninguém te encontra pelo telefone ao sincronizar contatos. Você ainda pode iniciar conversas com qualquer pessoa.')}
            value={discoverable}
            onValueChange={saveDiscoverable}
          />
        </SettingsGroup>

        {/* Rede — Proxy / Tor */}
        <SettingsGroup header={tr('privacy.sectionNetwork', 'Rede')} cardStyle={st.card22}>
          <SettingsSwitchRow
            icon={IconGlobe}
            title={tr('privacy.proxyEnable', 'Conexão via proxy')}
            subtitle={tr('privacy.proxyDesc', 'Rota tudo via SOCKS5. Avançado — só ative se souber o que está fazendo.')}
            value={proxy.enabled}
            onValueChange={(v) => saveProxy({ enabled: v })}
            disabled={isWeb || proxy.useTor}
          />
          {proxy.enabled && !proxy.useTor && (
            <FieldRow label={tr('privacy.proxyHost', 'Host')} value={proxy.host} onChange={(v) => saveProxyText({ host: v })} placeholder="127.0.0.1" />
          )}
          {proxy.enabled && !proxy.useTor && (
            <FieldRow label={tr('privacy.proxyPort', 'Porta')} value={String(proxy.port || '')} onChange={(v) => saveProxyText({ port: v })} keyboardType="number-pad" placeholder="1080" />
          )}
          {proxy.enabled && !proxy.useTor && (
            <FieldRow label={tr('privacy.proxyUser', 'Usuário (opcional)')} value={proxy.username} onChange={(v) => saveProxyText({ username: v })} />
          )}
          {proxy.enabled && !proxy.useTor && (
            <FieldRow label={tr('privacy.proxyPass', 'Senha (opcional)')} value={proxy.password} onChange={(v) => saveProxyText({ password: v })} secureTextEntry />
          )}
          <SettingsSwitchRow
            icon={IconLock}
            title={tr('privacy.useTor', 'Usar Tor')}
            subtitle={tr('privacy.useTorDesc', 'Rota tudo por uma instância local do Tor. Pode deixar o app mais lento. Tem precedência sobre o proxy manual.')}
            value={proxy.useTor}
            onValueChange={(v) => saveProxy({ useTor: v })}
            disabled={isWeb}
          />
        </SettingsGroup>

        {/* Conta */}
        <SettingsGroup header={tr('privacy.sectionAccount', 'Conta')} cardStyle={st.card22}>
          <SettingsRow
            icon={IconKey}
            title={tr('privacy.migrateLabel', 'Migrar conta para novo telefone')}
            subtitle={tr('privacy.migrateDesc', 'Use o QR de pareamento pra transferir sessões e chaves de criptografia.')}
            onPress={() => router.push('/linked-devices')}
          />
        </SettingsGroup>

        {/* Como funciona */}
        <SettingsGroup
          header={tr('advPrivScreen.howTitle', 'Como funciona')}
          footer={tr('settings.advPrivacyDefaultDesc', 'Em todas as suas conversas, para você e para quem conversa com você: sem prints nem gravação de tela, sem exportar, sem encaminhar ou salvar mídias na galeria, e a Bia não lê as mensagens.')}
          cardStyle={st.card22}
          inset={62}
        >
          <HowItem Icon={IconEyeOff} title={tr('advPrivScreen.how1Title', 'Sem prints nem gravações')} body={tr('advPrivScreen.how1Body', 'Capturas e gravações de tela das conversas ficam bloqueadas para todos — e a conversa é avisada se alguém tentar.')} />
          <HowItem Icon={IconForward} title={tr('advPrivScreen.how2Title', 'As mídias ficam na conversa')} body={tr('advPrivScreen.how2Body', 'Ninguém exporta a conversa, encaminha ou salva fotos e vídeos dela na galeria.')} />
          <HowItem Icon={IconSparkles} title={tr('advPrivScreen.how3Title', 'A Bia não lê')} body={tr('advPrivScreen.how3Body', 'Com a proteção ligada, a Bia não acessa as mensagens dessas conversas.')} />
        </SettingsGroup>
      </FadeSlideIn>
      )}
    </SettingsScreen>
  );
}

// [2026-10-21 adv-privacy-ui] Cartão hero: escudo grafite (o "check" acende na
// cor dos detalhes quando ligada), título, frase curta, estado Ativada/Desativada
// e switch grande. Ligar = halo + leve "pop" (Reanimated, UI thread); Reduzir
// Movimento = estado final direto.
function AdvHeroCard({ on, onChange, tr }) {
  const g = useGroupedColors();
  const isDark = !!g.isDark;
  const reduce = useReducedMotion();
  const accent = detailColor(isDark) || g.ink;
  const p = useSharedValue(on ? 1 : 0);
  const pop = useSharedValue(1);
  const prevOn = useRef(on);
  useEffect(() => {
    const changed = prevOn.current !== on;
    prevOn.current = on;
    if (reduce) { cancelAnimation(p); cancelAnimation(pop); p.value = on ? 1 : 0; pop.value = 1; return; }
    p.value = withTiming(on ? 1 : 0, { duration: 380, easing: Easing.out(Easing.cubic) });
    if (changed && on) {
      pop.value = withSequence(
        withTiming(1.08, { duration: 160, easing: Easing.out(Easing.quad) }),
        withSpring(1, { damping: 12, stiffness: 180 }),
      );
    }
  }, [on, reduce, p, pop]);
  const tileAnim = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));
  const haloAnim = useAnimatedStyle(() => ({ opacity: p.value * 0.9, transform: [{ scale: 0.86 + p.value * 0.14 }] }));
  const glowAnim = useAnimatedStyle(() => ({ opacity: p.value * 0.14 }));
  const checkAnim = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ scale: 0.6 + p.value * 0.4 }] }));
  const washAnim = useAnimatedStyle(() => ({ opacity: p.value * (isDark ? 0.10 : 0.06) }));
  const title = tr('privacy.advanced', 'Privacidade avançada');
  const stateLabel = on ? tr('advPriv.on', 'Ativada') : tr('advPriv.off', 'Desativada');
  return (
    <View style={[st.hero, { backgroundColor: g.cardBg }, g.cardShadow]} testID="adv-privacy-hero">
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: accent }, washAnim]} />
      <View style={st.heroIconWrap}>
        <Animated.View pointerEvents="none" style={[st.heroGlow, { backgroundColor: accent }, glowAnim]} />
        <Animated.View pointerEvents="none" style={[st.heroHalo, { borderColor: accent }, haloAnim]} />
        <Animated.View style={[st.heroTile, grafiteTileStyle(isDark, 76), { borderRadius: 24 }, tileAnim]}>
          <ShieldGlyph size={42} color="#FFFFFF" />
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, st.center, checkAnim]}>
            <CheckGlyph size={42} color={accent === g.ink ? '#FFFFFF' : accent} />
          </Animated.View>
        </Animated.View>
      </View>
      <Text style={[st.heroTitle, { color: g.text }]} accessibilityRole="header">{title}</Text>
      <Text style={[st.heroLead, { color: g.secondary }]}>
        {tr('advPrivScreen.lead', 'Uma camada extra de proteção em todas as suas conversas — para você e para quem conversa com você.')}
      </Text>
      <View style={[st.heroSep, { backgroundColor: g.separator }]} />
      <View style={st.heroStateRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={st.pillRow}>
            <View style={[st.pill, { backgroundColor: on ? 'transparent' : g.fill, borderColor: on ? accent : 'transparent' }]}>
              <View style={[st.pillDot, { backgroundColor: on ? accent : g.tertiary }]} />
              <Text style={[st.pillText, { color: on ? g.text : g.secondary }]}>{stateLabel}</Text>
            </View>
          </View>
          <Text style={[st.heroHint, { color: g.secondary }]} numberOfLines={2}>
            {on
              ? tr('advPrivScreen.onHint', 'Suas conversas estão protegidas.')
              : tr('advPrivScreen.offHint', 'Ative para proteger todas as suas conversas.')}
          </Text>
        </View>
        <View style={st.bigSwitch}>
          <NativeSwitch
            value={!!on}
            onValueChange={onChange}
            accessibilityLabel={tr('settings.advPrivacyDefault', 'Privacidade avançada em todas as conversas')}
            testID="adv-privacy-hero-switch"
          />
        </View>
      </View>
    </View>
  );
}

function ShieldGlyph({ size, color }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 21.5s7.5-3.6 7.5-9.4V5.6L12 2.75 4.5 5.6v6.5c0 5.8 7.5 9.4 7.5 9.4z" stroke={color} strokeWidth={1.6} strokeLinejoin="round" fill={color} fillOpacity={0.12} />
    </Svg>
  );
}
function CheckGlyph({ size, color }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M8.7 11.9l2.3 2.3 4.4-4.6" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

// Item ilustrado da seção "Como funciona" (ladrilho + título + explicação).
function HowItem({ Icon, title, body }) {
  const g = useGroupedColors();
  return (
    <View style={st.howRow} accessible accessibilityLabel={`${title}. ${body}`}>
      <SettingsIconTile Icon={Icon} size={32} />
      <View style={{ flex: 1, minWidth: 0, marginLeft: 14 }}>
        <Text style={[st.howTitle, { color: g.text }]}>{title}</Text>
        <Text style={[st.howBody, { color: g.secondary }]}>{body}</Text>
      </View>
    </View>
  );
}

// Linha "rótulo  [campo]" dentro do card (estilo formulário do iOS).
function FieldRow({ label, value, onChange, keyboardType, secureTextEntry, placeholder }) {
  const g = useGroupedColors();
  return (
    <View style={st.fieldRow}>
      <Text style={[st.fieldLabel, { color: g.text }]} numberOfLines={1}>{label}</Text>
      <TextInput
        style={[st.fieldInput, { color: g.text }]}
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType || 'default'}
        secureTextEntry={!!secureTextEntry}
        placeholder={placeholder}
        placeholderTextColor={g.tertiary}
        accessibilityLabel={label}
      />
    </View>
  );
}

const st = StyleSheet.create({
  card22: { borderRadius: 22 },
  center: { alignItems: 'center', justifyContent: 'center' },
  hero: { borderRadius: 22, overflow: 'hidden', paddingTop: 28, paddingBottom: 18, paddingHorizontal: 20, marginBottom: 28, alignItems: 'center' },
  heroIconWrap: { width: 112, height: 112, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  heroGlow: { position: 'absolute', width: 112, height: 112, borderRadius: 56 },
  heroHalo: { position: 'absolute', width: 98, height: 98, borderRadius: 32, borderWidth: 1.5 },
  heroTile: { width: 76, height: 76, alignItems: 'center', justifyContent: 'center' },
  heroTitle: { fontSize: 24, fontWeight: '700', letterSpacing: -0.6, textAlign: 'center' },
  heroLead: { fontSize: 15, lineHeight: 21, textAlign: 'center', marginTop: 6, maxWidth: 420, letterSpacing: -0.1 },
  heroSep: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch', marginTop: 20, marginBottom: 14 },
  heroStateRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch' },
  pillRow: { flexDirection: 'row' },
  pill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999, borderWidth: 1 },
  pillDot: { width: 8, height: 8, borderRadius: 4, marginRight: 7 },
  pillText: { fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  heroHint: { fontSize: 13, lineHeight: 18, marginTop: 6 },
  bigSwitch: { marginLeft: 12, transform: [{ scale: 1.18 }], paddingHorizontal: 4 },
  howRow: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 16, paddingVertical: 13 },
  howTitle: { fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  howBody: { fontSize: 13.5, lineHeight: 19, marginTop: 2 },
  okBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16 },
  okText: { fontWeight: '600', fontSize: 14 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: 16 },
  fieldLabel: { fontSize: 16, width: 150, letterSpacing: -0.2 },
  fieldInput: {
    flex: 1, fontSize: 16, textAlign: 'right', paddingVertical: 10,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
});
