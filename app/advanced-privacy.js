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
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useLanguage } from '../context/LanguageContext';
import { IconAlertTriangle } from '../components/Icons';
import * as proxyCfg from '../services/proxyConfig';
import * as screenGate from '../services/screenCaptureGate';
import * as vpnDetect from '../services/vpnDetect';
import * as api from '../services/api';
import FadeSlideIn from '../components/FadeSlideIn';
import {
  SettingsScreen, SettingsGroup, SettingsRow, SettingsSwitchRow, useGroupedColors,
} from '../components/settings/SettingsKit';

export default function AdvancedPrivacyScreen() {
  const { t } = useLanguage();
  const router = useRouter();
  const g = useGroupedColors();

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

  // [2026-10-08 settings-redesign2] Header nativo único + listas agrupadas
  // (SettingsKit). Mesmas APIs: proxyConfig / screenCaptureGate / vpnDetect /
  // chatDiscoverableSet. Aviso de VPN em preto&branco (era amarelo).
  return (
    <SettingsScreen title={t('privacy.advanced') || 'Privacidade avançada'}>
      {loading ? (
        <ActivityIndicator color={g.text} style={{ marginTop: 48 }} />
      ) : (
      <FadeSlideIn>
        {/* VPN suggestion (auto-hidden if user already on VPN) */}
        {!vpnActive && (
          <SettingsGroup>
            <SettingsRow
              icon={IconAlertTriangle}
              title={t('privacy.vpnSuggestTitle') || 'Considere usar uma VPN'}
              subtitle={t('privacy.vpnSuggestBody') || 'Você tem conversas criptografadas mas não está em VPN. Uma VPN esconde seu IP do servidor e da rede local.'}
              subtitleLines={4}
              numberOfLines={2}
              right={(
                <TouchableOpacity
                  onPress={() => { try { vpnDetect.dismissVpnSuggestion(); } catch {} setVpnActive(true); }}
                  style={[st.okBtn, { backgroundColor: g.fill }]}
                  accessibilityRole="button"
                  accessibilityLabel="OK"
                >
                  <Text style={[st.okText, { color: g.text }]}>OK</Text>
                </TouchableOpacity>
              )}
            />
          </SettingsGroup>
        )}

        {/* Visibilidade */}
        <SettingsGroup header={t('privacy.sectionVisibility') || 'Visibilidade'} footer={t('privacy.discoverableDesc') || 'Quando desativado, ninguém te encontra pelo telefone ao sincronizar contatos. Você ainda pode iniciar conversas com qualquer pessoa.'}>
          <SettingsSwitchRow
            title={t('privacy.discoverableLabel') || 'Encontrar pelo número'}
            value={discoverable}
            onValueChange={saveDiscoverable}
          />
        </SettingsGroup>

        {/* Proteção de tela */}
        <SettingsGroup header={t('privacy.sectionScreen') || 'Proteção de tela'} footer={t('privacy.screenBlockDesc') || 'No Android, miniaturas em "Recentes" ficam pretas. No iOS, gravações de tela são pausadas. Não impede foto-do-celular.'}>
          <SettingsSwitchRow
            title={t('privacy.screenBlockLabel') || 'Bloquear capturas de tela no app'}
            value={screenBlock}
            onValueChange={saveScreenBlock}
            disabled={Platform.OS === 'web'}
          />
        </SettingsGroup>

        {/* Rede — Proxy / Tor */}
        <SettingsGroup header={t('privacy.sectionNetwork') || 'Rede'} footer={t('privacy.proxyDesc') || 'Rota tudo via SOCKS5. Avançado — só ative se souber o que está fazendo.'}>
          <SettingsSwitchRow
            title={t('privacy.proxyEnable') || 'Conexão via proxy'}
            value={proxy.enabled}
            onValueChange={(v) => saveProxy({ enabled: v })}
            disabled={Platform.OS === 'web' || proxy.useTor}
          />
          {proxy.enabled && !proxy.useTor && (
            <FieldRow label={t('privacy.proxyHost') || 'Host'} value={proxy.host} onChange={(v) => saveProxy({ host: v })} placeholder="127.0.0.1" />
          )}
          {proxy.enabled && !proxy.useTor && (
            <FieldRow label={t('privacy.proxyPort') || 'Porta'} value={String(proxy.port || '')} onChange={(v) => saveProxy({ port: v })} keyboardType="number-pad" placeholder="1080" />
          )}
          {proxy.enabled && !proxy.useTor && (
            <FieldRow label={t('privacy.proxyUser') || 'Usuário (opcional)'} value={proxy.username} onChange={(v) => saveProxy({ username: v })} />
          )}
          {proxy.enabled && !proxy.useTor && (
            <FieldRow label={t('privacy.proxyPass') || 'Senha (opcional)'} value={proxy.password} onChange={(v) => saveProxy({ password: v })} secureTextEntry />
          )}
        </SettingsGroup>
        <SettingsGroup footer={t('privacy.useTorDesc') || 'Rota tudo por uma instância local do Tor. Pode deixar o app mais lento. Tem precedência sobre o proxy manual.'}>
          <SettingsSwitchRow
            title={t('privacy.useTor') || 'Usar Tor'}
            value={proxy.useTor}
            onValueChange={(v) => saveProxy({ useTor: v })}
            disabled={Platform.OS === 'web'}
          />
        </SettingsGroup>

        {/* Conta */}
        <SettingsGroup header={t('privacy.sectionAccount') || 'Conta'}>
          <SettingsRow
            title={t('privacy.migrateLabel') || 'Migrar conta para novo telefone'}
            subtitle={t('privacy.migrateDesc') || 'Use o QR de pareamento pra transferir sessões e chaves de criptografia.'}
            onPress={() => router.push('/linked-devices')}
          />
        </SettingsGroup>
      </FadeSlideIn>
      )}
    </SettingsScreen>
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
  okBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16 },
  okText: { fontWeight: '600', fontSize: 14 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: 16 },
  fieldLabel: { fontSize: 16, width: 150, letterSpacing: -0.2 },
  fieldInput: {
    flex: 1, fontSize: 16, textAlign: 'right', paddingVertical: 10,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
});
