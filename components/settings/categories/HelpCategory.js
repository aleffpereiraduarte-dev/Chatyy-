// [2026-10-15 settings-split] Categoria "Ajuda e sobre": suporte, sobre
// (versão + atualizar agora), diagnóstico (dev) e legal.
import { useState } from 'react';
import { View, Text, TouchableOpacity, Linking, Platform, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useTheme } from '../../../context/ThemeContext';
import { useLanguage } from '../../../context/LanguageContext';
import { IconChevronRight } from '../../Icons';
import NativeSheetDialog from '../../NativeSheetDialog';
import ChatyyMascot from '../../mascot/ChatyyMascot'; // [2026-10-16 polish-r2]
import { USE_NATIVE_SHEETS } from '../../NativeSheet';
import { PrivacyModal, TermsModal } from '../../LoginModals';
import { SettingsGroup, SettingsRow } from '../SettingsKit';
import { useSettingsHost, useSection } from './shared';
import { useAuth } from '../../../context/AuthContext';
// [quic-proto 2026-10-23] interruptor escondido (7 toques na versão, só allowlist)
import QuicExperimentalPanel, { quicPanelAllowed } from '../QuicExperimentalPanel';

export function appVersionLabel() {
  const ver = Constants?.expoConfig?.version || Constants?.manifest?.version || '?';
  const build = Constants?.expoConfig?.ios?.buildNumber || Constants?.expoConfig?.android?.versionCode || '';
  return build ? `${ver} (${build})` : String(ver);
}

export default function HelpCategory() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const { registerAnchor } = useSettingsHost();
  const blob = useSection('settings');
  const [aboutOpen, setAboutOpenState] = useState(false);
  const [aboutMounted, setAboutMounted] = useState(false);
  const setAboutOpen = (v) => { if (v) setAboutMounted(true); setAboutOpenState(v); };
  // [quic-proto] 7 toques na versão (em até 4 s) → mostra o transporte experimental (allowlist).
  const { user } = useAuth() || {};
  const [quicTaps, setQuicTaps] = useState({ n: 0, at: 0 });
  const [quicShown, setQuicShown] = useState(false);
  const onVersionTap = () => {
    const now = Date.now();
    const n = now - quicTaps.at < 4000 ? quicTaps.n + 1 : 1;
    setQuicTaps({ n, at: now });
    if (n >= 7 && !quicShown && quicPanelAllowed(user?.email)) setQuicShown(true);
  };
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  // Procura e aplica a atualização (OTA) na hora — sem fechar/abrir 2x.
  const [upd, setUpd] = useState('idle'); // idle|checking|downloading|ready|latest|error
  const updInfo = (() => {
    try {
      const U = require('expo-updates');
      const id = U?.updateId ? String(U.updateId).slice(0, 8) : null;
      const at = U?.createdAt ? new Date(U.createdAt) : null;
      return { id, at };
    } catch { return { id: null, at: null }; }
  })();
  const checkUpdate = async () => {
    if (upd === 'checking' || upd === 'downloading') return;
    if (Platform.OS === 'web') {
      try { setUpd('downloading'); window.location.reload(); } catch { setUpd('error'); }
      return;
    }
    let U = null;
    try { U = require('expo-updates'); } catch {}
    if (!U || !U.isEnabled) { setUpd('error'); return; }
    try {
      setUpd('checking');
      const r = await U.checkForUpdateAsync();
      if (!r?.isAvailable) { setUpd('latest'); return; }
      setUpd('downloading');
      await U.fetchUpdateAsync();
      setUpd('ready');
      setTimeout(() => {
        // [2026-10-16 bootgap] reload com motivo (boot_reload why=help)
        let p = null;
        try { p = require('../../../services/crashReporter').reloadWithReason('help'); } catch { p = null; }
        (p || U.reloadAsync()).catch(() => setUpd('error'));
      }, 900);
    } catch { setUpd('error'); }
  };
  const updSubtitle = (() => {
    switch (upd) {
      case 'checking': return t('settings.update.checking');
      case 'downloading': return t('settings.update.downloading');
      case 'ready': return t('settings.update.ready');
      case 'latest': return t('settings.update.latest');
      case 'error': return t('settings.update.error');
      default: {
        const parts = [];
        if (updInfo.id) parts.push(updInfo.id);
        if (updInfo.at && !isNaN(updInfo.at)) parts.push(updInfo.at.toLocaleDateString());
        return parts.length ? `${t('settings.update.current')}: ${parts.join(' · ')}` : t('settings.update.tap');
      }
    }
  })();
  const ver = Constants?.expoConfig?.version || Constants?.manifest?.version || '?';
  const build = Constants?.expoConfig?.ios?.buildNumber || Constants?.expoConfig?.android?.versionCode || '';
  const verLabel = (t('settings.about.version') || 'Versão {ver}').replace('{ver}', ver);
  // Modal irmão só depois do sheet nativo descer.
  const after = (fn) => { setAboutOpen(false); setTimeout(fn, USE_NATIVE_SHEETS ? 520 : 200); };

  return (
    <View ref={registerAnchor('help')}>
      <SettingsGroup header={t('settings.rd2.help') || 'Ajuda'}>
        <SettingsRow
          title={t('settings.help.contactSupport') || 'Falar com o suporte'}
          subtitle="support@chatyy.app"
          onPress={() => { Linking.openURL('mailto:support@chatyy.app').catch(() => {}); }}
        />
      </SettingsGroup>
      <SettingsGroup header={t('settings.about.title') || 'Sobre'}>
        <SettingsRow title={t('settings.rd2.aboutApp') || 'Sobre o Chatyy'} value={appVersionLabel()} onPress={() => setAboutOpen(true)} />
        <SettingsRow
          title={t('settings.update.title')}
          subtitle={updSubtitle}
          // [2026-10-17 settings-wa] spinner do sistema no lugar do "…" solto + seta.
          right={(upd === 'checking' || upd === 'downloading') ? <ActivityIndicator size="small" color={colors.textSecondary} /> : undefined}
          onPress={checkUpdate}
        />
        {(__DEV__ || blob?.developer_mode) && (
          <SettingsRow
            title={t('settings.rd2.callDiag') || 'Diagnóstico de chamadas'}
            subtitle={t('settings.rd2.callDiagDesc') || 'Últimos 100 eventos do ciclo de vida das chamadas'}
            onPress={() => router.push('/call-diagnose')}
          />
        )}
      </SettingsGroup>
      <SettingsGroup header={t('settings.legal')}>
        <SettingsRow title={t('settings.privacyPolicy')} onPress={() => setShowPrivacy(true)} />
        <SettingsRow title={t('settings.termsOfService')} onPress={() => setShowTerms(true)} />
      </SettingsGroup>

      {aboutMounted && (
        <NativeSheetDialog
          visible={aboutOpen}
          onClose={() => setAboutOpen(false)}
          animationType="slide"
          overlayStyle={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 }}
          panelStyle={{ backgroundColor: colors.surface, borderRadius: 22, borderCurve: 'continuous', padding: 22 }}
        >
          {/* [2026-10-16 polish-r2] Cabeçalho com o mascote acenando + nome do
              app centrado (era só "Sobre" + versão soltos no canto). */}
          <View style={{ alignItems: 'center', marginBottom: 14 }}>
            <ChatyyMascot pose="wave" size={96} dark={isDark} />
            <Text accessibilityRole="header" style={{ color: colors.text, fontWeight: '800', fontSize: 22, letterSpacing: -0.4, marginTop: 6 }}>Chatyy</Text>
            <Text onPress={onVersionTap} suppressHighlighting style={{ color: colors.textSecondary, fontSize: 13, marginTop: 2, fontVariant: ['tabular-nums'] }}>{build ? `${verLabel} • build ${build}` : verLabel}</Text>
          </View>
          {quicShown && <QuicExperimentalPanel email={user?.email} />}
          <TouchableOpacity onPress={() => after(() => setShowTerms(true))} style={[st.link, { borderBottomColor: colors.borderLight }]}>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{t('settings.about.terms') || 'Termos de uso'}</Text>
            <IconChevronRight size={16} color={colors.textTertiary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => after(() => setShowPrivacy(true))} style={[st.link, { borderBottomColor: colors.borderLight }]}>
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{t('settings.about.privacy') || 'Política de privacidade'}</Text>
            <IconChevronRight size={16} color={colors.textTertiary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setAboutOpen(false)} style={{ marginTop: 18, paddingVertical: 14, borderRadius: 26, borderCurve: 'continuous', backgroundColor: colors.primary, alignItems: 'center' }}>
            <Text style={{ color: colors.onPrimary || '#fff', fontWeight: '700' }}>{t('common.close') || 'Fechar'}</Text>
          </TouchableOpacity>
        </NativeSheetDialog>
      )}
      <PrivacyModal visible={showPrivacy} onClose={() => setShowPrivacy(false)} />
      <TermsModal visible={showTerms} onClose={() => setShowTerms(false)} />
    </View>
  );
}

const st = StyleSheet.create({
  link: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
