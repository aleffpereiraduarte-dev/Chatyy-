// [2026-10-21 privacidade-unica] UMA página de Privacidade (founder: "Privacidade"
// e "Privacidade avançada" viram uma só). Topo = cartão hero da Privacidade
// avançada (redesign 5c557beb, antes em app/advanced-privacy.js); abaixo,
// cartões agrupados com ícones e explicações: Quem pode ver · Mensagens ·
// Status · Contatos e ligações · Conversas · Mídia · Proteção de tela ·
// Visibilidade · Rede (proxy/Tor) · Dados e conta · Como funciona.
// Rotas: /settings-section?section=privacy (Ajustes → Privacidade) e
// /advanced-privacy (redireciona p/ cá; Você/Conta → Privacidade avançada).
// Lógica/endpoints INALTERADOS: settingsCache 'privacy'/'defaults' (commit
// otimista, chat_privacy_set), captureBlock, proxyConfig, screenCaptureGate,
// vpnDetect, chatDiscoverableSet. Tela JS (fora da lista nativa: o hero não é
// linha do kit — nativeCollect.DEFAULT_NATIVE_CATS sem 'privacy').
//
// [2026-10-15 settings-split] Categoria "Privacidade": quem pode ver (valor
// à direita + sheet com checkmark), recibos, status, arquivadas, desconhecidos,
// bloqueados, extras, personalização e temporárias por padrão.
import { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, withSequence, withSpring, cancelAnimation, Easing } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useRouter } from 'expo-router';
import { useLanguage } from '../../../context/LanguageContext';
import {
  SettingsGroup, SettingsRow, SettingsSwitchRow, SettingsPickerRow, OptionSheet, SettingsIconTile, useGroupedColors, grafiteTileStyle,
} from '../SettingsKit';
import { PrivacyExtrasGroup } from '../SettingsPanels';
import { useSafeNav, useSettingsHost, useChatPrivacy, useChatDefaults, privacyValueLabel } from './shared';
import { useSilenceUnknownCallers } from '../../calls/silenceUnknownCallers'; // [2026-10-16 wave12-D]
import { useFollowRequestState, setProfilePrivate } from '../../../services/followRequests'; // [privado 2026-10-22]
import { useCaptureBlockGlobal, setCaptureBlockGlobal, useAdvPrivacyDefault, setAdvPrivacyDefault } from '../../../services/captureBlock'; // [2026-10-19 secure-view] [2026-10-19 capmember]
import {
  IconAlertTriangle, IconEyeOff, IconSmartphone, IconSearch, IconGlobe, IconLock, IconKey, IconForward, IconSparkles,
  IconClock, IconZap, IconUser, IconQuote, IconPhone, IconImage, IconUsers, IconCheckCircle, IconRotateCcw, IconStar, IconFilter,
  IconArchive, IconShield, IconAlertCircle, IconPhoneOff, IconSliders, IconMapPin, IconCloud, IconMail,
} from '../../Icons';
import NativeSwitch from '../../NativeSwitch';
import E2eeBackupSection from '../../e2ee/BackupSection'; // [e2ee5 WP-14]
import { useReducedMotion } from '../../reducedMotion';
import { detailColor } from '../../../constants/theme';
import * as proxyCfg from '../../../services/proxyConfig';
import * as screenGate from '../../../services/screenCaptureGate';
import * as vpnDetect from '../../../services/vpnDetect';
import * as api from '../../../services/api';
import * as settingsCache from '../../../services/settingsCache';

const FIELDS = ['last_seen', 'online', 'profile_photo', 'about', 'phone_visibility', 'story_privacy', 'group_add'];
const FIELD_ICONS = {
  last_seen: IconClock, online: IconZap, profile_photo: IconUser, about: IconQuote,
  phone_visibility: IconPhone, story_privacy: IconImage, group_add: IconUsers,
};
const EXTRA_ICONS = { exif: IconMapPin, sealed: IconMail, cloud: IconCloud };

export default function PrivacyCategory() {
  const { t } = useLanguage();
  const tr = (k, fb) => t(k) || fb;
  const router = useRouter();
  const safeNav = useSafeNav();
  const g = useGroupedColors();
  const { registerAnchor } = useSettingsHost();
  const { privacy, savePrivacy } = useChatPrivacy();
  const { defaults, updateDefault } = useChatDefaults();
  const [picker, setPicker] = useState(null);
  const [silenceUnknown, setSilenceUnknown] = useSilenceUnknownCallers();
  const isWeb = Platform.OS === 'web';

  // [2026-10-19 secure-view] "Bloquear capturas de tela nas conversas" (opt-in):
  // espelho local = efeito na hora; servidor = outros aparelhos.
  const captureBlock = !!useCaptureBlockGlobal();
  const saveCaptureBlock = (v) => {
    setCaptureBlockGlobal(!!v);
    savePrivacy({ block_screenshots: !!v });
  };
  // [2026-10-19 capmember] "Privacidade avançada em todas as conversas" (principal):
  // vale p/ TODOS os membros das minhas conversas. Inclui o bloqueio de captura.
  const advDefault = !!useAdvPrivacyDefault();
  const saveAdvDefault = (v) => {
    setAdvPrivacyDefault(!!v);
    savePrivacy({ adv_privacy_default: !!v });
  };

  // ── Avançado (ex-/advanced-privacy): proxy/Tor, captura no app, descoberta, VPN ──
  // [2026-10-13 settings-instant] último estado salvo no aparelho → abre na hora.
  // Senha do proxy NÃO vai para o snapshot (fica só no proxyConfig).
  const [_snap] = useState(() => settingsCache.peek('adv_privacy'));
  const [proxy, setProxy] = useState(() => ({
    enabled: false, type: 'socks5', host: '', port: 1080, username: '', password: '', useTor: false,
    ...(_snap && _snap.proxy && typeof _snap.proxy === 'object' ? _snap.proxy : {}),
  }));
  const [screenBlock, setScreenBlock] = useState(() => !!(_snap && _snap.screenBlock));
  const [discoverable, setDiscoverable] = useState(() => settingsCache.peek('discoverable') !== false);
  const [vpnActive, setVpnActive] = useState(() => (_snap ? _snap.vpnActive !== false : true));
  const [advLoading, setAdvLoading] = useState(() => !_snap);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [p, s, d, v] = await Promise.all([
          proxyCfg.getProxyConfig(),
          screenGate.isScreenCaptureBlocked(),
          settingsCache.revalidate('discoverable', { force: true }).then(x => (x === null || x === undefined ? true : x)).catch(() => true),
          vpnDetect.isVpnActive(),
        ]);
        if (!alive) return;
        setProxy(p);
        setScreenBlock(!!s);
        setDiscoverable(!!d);
        setVpnActive(!!v);
        try { settingsCache.put('adv_privacy', { proxy: { ...(p || {}), password: '' }, screenBlock: !!s, vpnActive: !!v }); } catch {}
      } catch (e) {
        console.warn('[privacy] advanced load failed', e?.message);
      } finally { if (alive) setAdvLoading(false); }
    })();
    return () => { alive = false; };
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
  // [2026-10-20 wa2] Host/porta/usuário/senha: aplica só 900 ms depois de parar de digitar.
  const _proxyTxtRef = useRef({ timer: null, pending: {} });
  function saveProxyText(patch) {
    const next = { ...proxy, ...patch };
    setProxy(next);
    const stt = _proxyTxtRef.current;
    stt.pending = { ...stt.pending, ...patch };
    if (stt.timer) clearTimeout(stt.timer);
    stt.timer = setTimeout(() => {
      const p = stt.pending; stt.pending = {}; stt.timer = null;
      try { settingsCache.patch('adv_privacy', (prev) => ({ ...(prev || {}), proxy: { ...((prev && prev.proxy) || {}), ...p, password: '' } })); } catch {}
      try { proxyCfg.setProxyConfig(p).catch?.(() => {}); } catch {}
    }, 900);
  }
  useEffect(() => {
    const ref = _proxyTxtRef;
    return () => {
      // sair da tela com digitação pendente: aplica já
      const stt = ref.current;
      if (stt.timer) { clearTimeout(stt.timer); stt.timer = null; try { proxyCfg.setProxyConfig(stt.pending)?.catch?.(() => {}); } catch {} }
    };
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

  // [privado 2026-10-22] Perfil privado (services/followRequests: otimista + cópia no aparelho).
  const privProfile = useFollowRequestState();
  const onPrivateProfile = (v) => {
    if (v) { setProfilePrivate(true).then((d) => { if (!d) { try { settingsCache.notifySaveFailed(t); } catch {} } }); return; }
    const n = privProfile.pending || 0;
    const title = tr('privateProfile.offTitle', 'Tornar a conta pública?');
    const msg = n > 0
      ? tr('privateProfile.offBodyPending', 'Qualquer pessoa poderá ver suas publicações, o Mural e o Status. Os {n} pedidos pendentes serão aprovados e essas pessoas passarão a seguir você.').split('{n}').join(String(n))
      : tr('privateProfile.offBody', 'Qualquer pessoa poderá ver suas publicações, o Mural e o Status.');
    const go = () => { setProfilePrivate(false).then((d) => { if (!d) { try { settingsCache.notifySaveFailed(t); } catch {} } }); };
    try {
      require('../../../services/alerts').safeAlert(title, msg, [
        { text: tr('common.cancel', 'Cancelar'), style: 'cancel' },
        { text: tr('privateProfile.offConfirm', 'Tornar pública'), onPress: go },
      ]);
    } catch { go(); }
  };

  const fieldTitle = (field) => (
    field === 'last_seen' ? t('settings.privacyLastSeen')
      : field === 'profile_photo' ? t('settings.privacyProfilePhoto')
      : field === 'online' ? t('settings.privacyOnline')
      : field === 'story_privacy' ? t('settings.privacyStatus')
      : field === 'group_add' ? t('settings.privacyGroups')
      : field === 'phone_visibility' ? t('privacy.phoneNumber')
      : field === 'about' ? t('settings.privacyAbout')
      : ''
  );
  const optionsFor = (field) => (
    field === 'online' ? [
      { value: 'everyone', label: t('settings.privacyEveryone') },
      { value: 'contacts', label: t('settings.privacyContacts') },
      { value: 'nobody', label: t('settings.privacyInvisible') },
    ] : field === 'story_privacy' ? [
      { value: 'all', label: t('settings.privacyEveryone') },
      { value: 'contacts', label: t('settings.privacyContacts') },
      { value: 'close_friends', label: t('settings.privacyCloseFriends') },
      { value: 'except', label: t('settings.privacyStatusExcept') },
    ] : field === 'phone_visibility' ? [
      // [2026-10-20 wa2] servidor só aceita all|contacts|nobody p/ o número.
      { value: 'all', label: t('settings.privacyEveryone') },
      { value: 'contacts', label: t('settings.privacyContacts') },
      { value: 'nobody', label: t('settings.privacyNobody') },
    ] : [
      { value: 'everyone', label: t('settings.privacyEveryone') },
      { value: 'contacts', label: t('settings.privacyContacts') },
      { value: 'nobody', label: t('settings.privacyNobody') },
    ]
  );
  const exceptN = privacy.status_except?.length || 0;

  return (
    <View>
      {/* Topo: Privacidade avançada em todas as conversas (hero). */}
      <View ref={registerAnchor('adv_privacy_default')}>
        <AdvHeroCard on={advDefault} onChange={saveAdvDefault} tr={tr} />
      </View>

      {/* Sugestão de VPN (some se já estiver em VPN ou se dispensada). */}
      {!advLoading && !vpnActive && (
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

      {/* Quem pode ver */}
      <View ref={registerAnchor('privacy_granular')}>
        <SettingsGroup
          header={tr('settings.rd2.whoCanSee', 'Quem pode ver')}
          footer={tr('settings.rd2.whoCanSeeFooter', 'Escolha quem vê suas informações no Chatyy.')}
          cardStyle={st.card22}
        >
          {/* [privado 2026-10-22] Perfil privado nível Instagram: toque na linha = pedidos/seguidores; chave = liga/desliga */}
          <SettingsRow
            icon={IconLock}
            title={tr('privateProfile.title', 'Perfil privado')}
            subtitle={privProfile.private
              ? (privProfile.pending > 0
                ? tr('privateProfile.subPending', '{n} pedidos para seguir · toque para ver').split('{n}').join(String(privProfile.pending))
                : tr('privateProfile.subOn', 'Só seguidores que você aprovar veem suas publicações, o Mural e o Status.'))
              : tr('privateProfile.subOff', 'Qualquer pessoa pode ver suas publicações. Ative para aprovar quem segue você.')}
            subtitleLines={3}
            numberOfLines={1}
            onPress={() => safeNav('/follow-requests')}
            right={<NativeSwitch value={!!privProfile.private} onValueChange={onPrivateProfile} accessibilityLabel={tr('privateProfile.title', 'Perfil privado')} />}
            testID="settings-row-private-profile"
          />
          {FIELDS.map(field => (
            <SettingsRow key={field} icon={FIELD_ICONS[field]} title={fieldTitle(field)} value={privacyValueLabel(t, privacy, field)} onPress={() => setPicker(field)} />
          ))}
        </SettingsGroup>
      </View>

      {/* Mensagens */}
      <View ref={registerAnchor('defaultDisappearing')}>
        <SettingsGroup header={tr('privacyHub.messages', 'Mensagens')} cardStyle={st.card22}>
          <SettingsSwitchRow
            icon={IconCheckCircle}
            title={t('settings.privacyReadReceipts')}
            subtitle={t('settings.privacyReadReceiptsDesc')}
            value={!!privacy.read_receipts}
            onValueChange={(v) => savePrivacy({ read_receipts: !!v })}
          />
          <SettingsPickerRow
            icon={IconRotateCcw}
            title={t('settings.defaultDisappearing')}
            subtitle={t('settings.defaultDisappearingDesc')}
            sheetTitle={tr('settings.rd2.defaultTimer', 'Temporizador padrão')}
            value={Number(defaults.default_disappearing) || 0}
            cancelLabel={tr('common.cancel', 'Cancelar')}
            options={[
              { value: 0, label: t('settings.disappearingOff') },
              { value: 86400, label: t('settings.disappearing24h') },
              { value: 604800, label: t('settings.disappearing7d') },
              { value: 7776000, label: t('settings.disappearing90d') },
            ]}
            onChange={(v) => updateDefault({ default_disappearing: v })}
          />
          {!isWeb && (
            <SettingsSwitchRow
              icon={IconEyeOff}
              title={tr('settings.blockScreenshots', 'Bloquear capturas de tela nas conversas')}
              subtitle={advDefault
                ? tr('advPrivScreen.includedHint', 'Incluído na privacidade avançada.')
                : tr('settings.blockScreenshotsDesc', 'Ninguém consegue tirar print ou gravar a tela das suas conversas — nem você, nem quem conversa com você.')}
              value={advDefault || captureBlock}
              disabled={advDefault}
              onValueChange={saveCaptureBlock}
              testID="settings-row-block-screenshots"
            />
          )}
        </SettingsGroup>
      </View>

      {/* Status */}
      <SettingsGroup header={tr('settings.rd2.status', 'Status')} cardStyle={st.card22}>
        <SettingsRow icon={IconStar} title={t('settings.privacyCloseFriends')} subtitle={t('settings.privacyCloseFriendsDesc')} onPress={() => { try { router.push('/close-friends'); } catch {} }} />
        <SettingsRow
          icon={IconFilter}
          title={t('settings.privacyStatusExcept')}
          value={exceptN > 0 ? String(exceptN) : undefined}
          subtitle={exceptN > 0 ? undefined : t('settings.privacyStatusExceptDesc')}
          onPress={() => { try { router.push('/status-except'); } catch {} }}
        />
      </SettingsGroup>

      {/* Contatos e ligações */}
      <View ref={registerAnchor('blocked')}>
        <SettingsGroup header={tr('privacyHub.contactsCalls', 'Contatos e ligações')} cardStyle={st.card22}>
          <SettingsRow icon={IconAlertCircle} title={t('settings.blockedContacts')} subtitle={tr('privacyHub.blockedSub', 'Quem você bloqueou não te liga nem manda mensagens.')} onPress={() => safeNav('/settings-blocked')} testID="settings-row-blocked" />
          <SettingsSwitchRow icon={IconShield} title={t('settings.blockUnknown')} subtitle={t('settings.blockUnknownDesc')} value={!!privacy.block_unknown} onValueChange={(v) => savePrivacy({ block_unknown: !!v })} />
          {/* [2026-10-16 wave12-D] mesmo ajuste do cartão da aba Ligações (estado compartilhado). */}
          <SettingsSwitchRow icon={IconPhoneOff} title={t('calls.silenceUnknown')} subtitle={t('calls.silenceUnknownDesc')} value={silenceUnknown} onValueChange={setSilenceUnknown} testID="settings-row-silence-unknown" />
        </SettingsGroup>
      </View>

      {/* Conversas */}
      <SettingsGroup header={tr('settings.rd2.chats', 'Conversas')} cardStyle={st.card22}>
        <SettingsSwitchRow icon={IconArchive} title={t('settings.privacyKeepArchived')} subtitle={t('settings.privacyKeepArchivedDesc')} value={privacy.keep_archived !== false} onValueChange={(v) => savePrivacy({ keep_archived: !!v })} />
      </SettingsGroup>

      {/* [e2ee5 WP-14] Backup das conversas protegidas (some sem __chatyy_e2ee5 + e2ee5_backup) */}
      <E2eeBackupSection cardStyle={st.card22} />

      {/* Mídia (EXIF, remetente selado, conversas na nuvem) */}
      <PrivacyExtrasGroup icons={EXTRA_ICONS} cardStyle={st.card22} cloudChats={privacy.cloud_chats_default} onCloudChatsChange={(v) => savePrivacy({ cloud_chats_default: !!v })} />

      {advLoading ? (
        <ActivityIndicator color={g.secondary} style={{ marginVertical: 24 }} />
      ) : (
        <>
          {/* Proteção de tela (o app inteiro) */}
          {!isWeb && (
            <SettingsGroup header={tr('privacy.sectionScreen', 'Proteção de tela')} cardStyle={st.card22}>
              <SettingsSwitchRow
                icon={IconSmartphone}
                title={tr('privacy.screenBlockLabel', 'Bloquear capturas de tela no app')}
                subtitle={tr('privacy.screenBlockDesc', 'No Android, miniaturas em "Recentes" ficam pretas. No iOS, gravações de tela são pausadas. Não impede foto-do-celular.')}
                value={screenBlock}
                onValueChange={saveScreenBlock}
              />
            </SettingsGroup>
          )}

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

          {/* Rede — Proxy / Tor (só no app) */}
          {!isWeb && (
            <SettingsGroup header={tr('privacy.sectionNetwork', 'Rede')} cardStyle={st.card22}>
              <SettingsSwitchRow
                icon={IconGlobe}
                title={tr('privacy.proxyEnable', 'Conexão via proxy')}
                subtitle={tr('privacy.proxyDesc', 'Rota tudo via SOCKS5. Avançado — só ative se souber o que está fazendo.')}
                value={proxy.enabled}
                onValueChange={(v) => saveProxy({ enabled: v })}
                disabled={proxy.useTor}
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
              />
            </SettingsGroup>
          )}
        </>
      )}

      {/* Dados e conta */}
      <SettingsGroup header={tr('privacyHub.dataAccount', 'Dados e conta')} cardStyle={st.card22}>
        <SettingsRow
          icon={IconSliders}
          title={t('settings.personalizationOffers')}
          subtitle={t('settings.personalizationOffersDesc')}
          subtitleLines={2}
          onPress={() => safeNav('/privacy-personalization')}
        />
        {!isWeb && (
          <SettingsRow
            icon={IconKey}
            title={tr('privacy.migrateLabel', 'Migrar conta para novo telefone')}
            subtitle={tr('privacy.migrateDesc', 'Use o QR de pareamento pra transferir sessões e chaves de criptografia.')}
            onPress={() => safeNav('/linked-devices')}
          />
        )}
      </SettingsGroup>

      {/* Como funciona a Privacidade avançada */}
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

      {!!picker && (
        <OptionSheet
          visible={!!picker}
          title={fieldTitle(picker)}
          options={optionsFor(picker)}
          value={picker === 'story_privacy'
            ? ((privacy.story_privacy === 'everyone' || privacy.story_privacy === 'all' || privacy.story_privacy === 'except')
              ? (exceptN > 0 ? 'except' : 'all') : privacy.story_privacy)
            : (picker === 'phone_visibility' && privacy.phone_visibility === 'everyone' ? 'all' : privacy[picker])}
          cancelLabel={t('common.cancel') || 'Cancelar'}
          onSelect={(v) => {
            const field = picker;
            // [2026-10-20 wa2] "Exceto…" = Todos + lista (o servidor não tem 'except'): só abre a lista.
            if (field === 'story_privacy' && v === 'except') savePrivacy({ story_privacy: 'everyone' });
            else if (field === 'story_privacy' && v === 'all' && exceptN > 0) savePrivacy({ story_privacy: 'everyone', status_except: [] });
            else if (field) savePrivacy({ [field]: v });
            if (field === 'story_privacy' && v === 'close_friends') { try { router.push('/close-friends'); } catch {} }
            else if (field === 'story_privacy' && v === 'except') { try { router.push('/status-except'); } catch {} }
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </View>
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
            testID="settings-row-adv-privacy-default"
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
