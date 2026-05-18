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
 */

import { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  Switch, Platform, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconArrowLeft, IconShield, IconGlobe, IconAlertTriangle } from '../components/Icons';
import * as proxyCfg from '../services/proxyConfig';
import * as screenGate from '../services/screenCaptureGate';
import * as vpnDetect from '../services/vpnDetect';
import * as api from '../services/api';

export default function AdvancedPrivacyScreen() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Proxy config
  const [proxy, setProxy] = useState({
    enabled: false, type: 'socks5', host: '', port: 1080, username: '', password: '', useTor: false,
  });
  // Screen capture block
  const [screenBlock, setScreenBlock] = useState(false);
  // Discoverable
  const [discoverable, setDiscoverable] = useState(true);
  // VPN suggestion
  const [vpnActive, setVpnActive] = useState(true);
  // Loading state
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [p, s, d, v] = await Promise.all([
          proxyCfg.getProxyConfig(),
          screenGate.isScreenCaptureBlocked(),
          api.chatDiscoverableGet().then(r => r?.data?.discoverable ?? r?.discoverable ?? true).catch(() => true),
          vpnDetect.isVpnActive(),
        ]);
        setProxy(p);
        setScreenBlock(!!s);
        setDiscoverable(!!d);
        setVpnActive(!!v);
      } catch (e) {
        console.warn('[advanced-privacy] load failed', e?.message);
      } finally { setLoading(false); }
    })();
  }, []);

  async function saveProxy(patch) {
    const next = { ...proxy, ...patch };
    setProxy(next);
    try { await proxyCfg.setProxyConfig(patch); } catch {}
  }
  async function saveScreenBlock(v) {
    setScreenBlock(v);
    try { await screenGate.setScreenCaptureBlocked(v); } catch {}
  }
  async function saveDiscoverable(v) {
    setDiscoverable(v);
    try { await api.chatDiscoverableSet(v); } catch {}
  }

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.borderLight }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text, marginLeft: Spacing.md }]}>
          {t('privacy.advanced') || 'Privacidade avançada'}
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: Spacing.md, paddingBottom: 32, gap: Spacing.md }}>

        {/* VPN suggestion (auto-hidden if user already on VPN) */}
        {!vpnActive && (
          <View style={[styles.banner, { backgroundColor: '#fef3c7', borderColor: '#f59e0b' }]}>
            <IconAlertTriangle size={18} color="#b45309" />
            <View style={{ flex: 1 }}>
              <Text style={[styles.bannerTitle, { color: '#78350f' }]}>
                {t('privacy.vpnSuggestTitle') || 'Considere usar uma VPN'}
              </Text>
              <Text style={[styles.bannerBody, { color: '#92400e' }]}>
                {t('privacy.vpnSuggestBody') || 'Você tem conversas criptografadas mas não está em VPN. Uma VPN esconde seu IP do servidor e da rede local.'}
              </Text>
            </View>
            <TouchableOpacity onPress={() => vpnDetect.dismissVpnSuggestion()}>
              <Text style={{ color: '#92400e', fontWeight: '600', fontSize: 13 }}>OK</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Discoverable toggle */}
        <Section title={t('privacy.discoverable') || 'Permitir que outros me encontrem pelo número'} colors={colors}>
          <Row
            colors={colors}
            label={t('privacy.discoverableLabel') || 'Encontrar pelo número'}
            desc={t('privacy.discoverableDesc') || 'Quando desativado, ninguém te encontra pelo telefone ao sincronizar contatos. Você ainda pode iniciar conversas com qualquer pessoa.'}
            value={discoverable}
            onChange={saveDiscoverable}
          />
        </Section>

        {/* Screen capture block */}
        <Section title={t('privacy.screenBlock') || 'Bloquear capturas de tela'} colors={colors}>
          <Row
            colors={colors}
            label={t('privacy.screenBlockLabel') || 'Bloquear capturas de tela no app'}
            desc={t('privacy.screenBlockDesc') || 'No Android, miniaturas em "Recentes" ficam pretas. No iOS, gravações de tela são pausadas. Não impede foto-do-celular.'}
            value={screenBlock}
            onChange={saveScreenBlock}
            disabled={Platform.OS === 'web'}
          />
        </Section>

        {/* Proxy / Tor */}
        <Section title={t('privacy.proxyTor') || 'Proxy / Tor'} colors={colors}>
          <Row
            colors={colors}
            label={t('privacy.proxyEnable') || 'Conexão via proxy'}
            desc={t('privacy.proxyDesc') || 'Rota tudo via SOCKS5. Avançado — só ative se souber o que está fazendo.'}
            value={proxy.enabled}
            onChange={(v) => saveProxy({ enabled: v })}
            disabled={Platform.OS === 'web' || proxy.useTor}
          />
          {proxy.enabled && !proxy.useTor && (
            <View style={{ gap: 8, marginTop: 8 }}>
              <Field label={t('privacy.proxyHost') || 'Host'} value={proxy.host} onChange={(v) => saveProxy({ host: v })} colors={colors} />
              <Field label={t('privacy.proxyPort') || 'Porta'} value={String(proxy.port || '')} onChange={(v) => saveProxy({ port: v })} colors={colors} keyboardType="number-pad" />
              <Field label={t('privacy.proxyUser') || 'Usuário (opcional)'} value={proxy.username} onChange={(v) => saveProxy({ username: v })} colors={colors} />
              <Field label={t('privacy.proxyPass') || 'Senha (opcional)'} value={proxy.password} onChange={(v) => saveProxy({ password: v })} colors={colors} secureTextEntry />
            </View>
          )}
          <View style={{ height: 1, backgroundColor: colors.borderLight, marginVertical: Spacing.sm }} />
          <Row
            colors={colors}
            label={t('privacy.useTor') || 'Usar Tor'}
            desc={t('privacy.useTorDesc') || 'Rota tudo por uma instância local do Tor. Pode deixar o app mais lento. Tem precedência sobre o proxy manual.'}
            value={proxy.useTor}
            onChange={(v) => saveProxy({ useTor: v })}
            disabled={Platform.OS === 'web'}
          />
        </Section>

        {/* Migrar conta — surfaced for visibility */}
        <Section title={t('privacy.migrateAccount') || 'Migrar conta'} colors={colors}>
          <TouchableOpacity
            style={[styles.linkRow, { borderBottomColor: colors.borderLight }]}
            onPress={() => router.push('/linked-devices')}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowLabel, { color: colors.text }]}>
                {t('privacy.migrateLabel') || 'Migrar conta para novo telefone'}
              </Text>
              <Text style={[styles.rowDesc, { color: colors.textTertiary }]}>
                {t('privacy.migrateDesc') || 'Use o QR de pareamento pra transferir sessões e chaves de criptografia.'}
              </Text>
            </View>
            <Text style={{ color: colors.textTertiary, fontSize: 20 }}>›</Text>
          </TouchableOpacity>
        </Section>

      </ScrollView>
    </View>
  );
}

function Section({ title, colors, children }) {
  return (
    <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
      <View style={styles.sectionHeader}>
        <IconShield size={18} color={colors.primary} />
        <Text style={[styles.sectionTitle, { color: colors.text }]}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function Row({ colors, label, desc, value, onChange, disabled }) {
  return (
    <View style={[styles.row, { opacity: disabled ? 0.5 : 1 }]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
        {desc ? <Text style={[styles.rowDesc, { color: colors.textTertiary }]}>{desc}</Text> : null}
      </View>
      <Switch value={!!value} onValueChange={onChange} disabled={disabled}
              trackColor={{ false: colors.divider, true: colors.primaryLight }}
              thumbColor={value ? colors.primary : '#fff'} />
    </View>
  );
}

function Field({ label, value, onChange, colors, keyboardType, secureTextEntry }) {
  return (
    <View>
      <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{label}</Text>
      <TextInput
        style={[styles.input, { borderColor: colors.borderLight, color: colors.text, backgroundColor: colors.background }]}
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType || 'default'}
        secureTextEntry={!!secureTextEntry}
        placeholderTextColor={colors.textTertiary}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: FontSize.lg, fontWeight: '700' },
  section: { borderRadius: BorderRadius.lg, borderWidth: 1, padding: Spacing.md, gap: 4 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: Spacing.xs },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm, gap: 12 },
  linkRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: { fontSize: FontSize.md, fontWeight: '600' },
  rowDesc: { fontSize: FontSize.sm, marginTop: 2 },
  fieldLabel: { fontSize: FontSize.sm, fontWeight: '600' },
  input: {
    borderWidth: 1, borderRadius: BorderRadius.md, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: FontSize.md, marginTop: 4,
  },
  banner: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start',
    padding: 12, borderRadius: BorderRadius.md, borderWidth: 1,
  },
  bannerTitle: { fontWeight: '700', fontSize: FontSize.md },
  bannerBody: { fontSize: FontSize.sm, marginTop: 2 },
});
