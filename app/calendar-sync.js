/**
 * /calendar-sync — Sincronizar Calendário + Tarefas com o celular (2026-10-13).
 *
 * "Jeito de verdade": o servidor fala CalDAV (https://chatyy.com.br/dav/, Sabre
 * apontando p/ os MESMOS dados do app). O usuário adiciona a conta uma vez e
 * os eventos aparecem no app Calendário e as tarefas no Lembretes do iPhone
 * (VTODO) — bidirecional, sem o Chatyy aberto.
 *  • iPhone/iPad/Mac: 1 toque → perfil .mobileconfig (link de uso único, 10 min,
 *    cria uma senha de app só p/ esse aparelho). Na web: QR p/ ler no iPhone.
 *  • Android: DAVx⁵ (Play/F-Droid) com URL + usuário + senha de app.
 *  • Google Agenda: assinatura .ics (só leitura).
 * Senhas de app: listadas e revogáveis (revogar = aparelho para de sincronizar).
 * Servidor sem o script calendario-sync-servidor.sh → mostra só o .ics.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, Platform, Linking, Alert } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useGroupedColors } from '../components/settings/SettingsKit';
import { USE_NATIVE_HEADER, nativeHeaderOptions, nativeScrollInsetProps, IOS_NATIVE_INSET } from '../components/nativeHeader';
import { IconArrowLeft, IconSmartphone, IconCopy, IconKey, IconTrash, IconCalendar, IconCheck, IconGlobe, IconMonitor } from '../components/Icons';
import * as pim from '../services/pim';
import * as api from '../services/api';
import { haptic } from '../constants/theme';

let QRCode = null;
try { QRCode = require('react-native-qrcode-svg').default; } catch {}

function Card({ g, children, style }) {
  return <View style={[s.card, { backgroundColor: g.cardBg }, style]}>{children}</View>;
}
function Step({ n, text, g }) {
  return (
    <View style={s.step}>
      <View style={[s.stepNum, { backgroundColor: g.fill }]}><Text style={[s.stepNumText, { color: g.text }]}>{n}</Text></View>
      <Text style={[s.stepText, { color: g.text }]}>{text}</Text>
    </View>
  );
}
function CopyField({ label, value, g, t, secret }) {
  const [ok, setOk] = useState(false);
  return (
    <View style={s.field}>
      <Text style={[s.fieldLabel, { color: g.secondary }]}>{label}</Text>
      <View style={[s.fieldBox, { backgroundColor: g.fill }]}>
        <Text style={[s.fieldValue, { color: g.text, fontFamily: secret ? Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) : undefined }]} selectable numberOfLines={2}>{value}</Text>
        <TouchableOpacity
          onPress={async () => { try { await Clipboard.setStringAsync(String(value)); setOk(true); haptic.light(); setTimeout(() => setOk(false), 1500); } catch {} }}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={(t('common.copy') || 'Copiar') + ' ' + label}
        >
          {ok ? <IconCheck size={18} color={g.text} /> : <IconCopy size={18} color={g.text} />}
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function CalendarSyncScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const g = useGroupedColors();
  const tt = (k, fb) => t(k) || fb;
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [newPass, setNewPass] = useState(null);
  const [profileUrl, setProfileUrl] = useState('');

  const load = useCallback(async () => {
    try { setInfo(await pim.davInfo()); } catch { setInfo({ available: false, error: true }); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); pim.reportTimezone(); }, [load]);

  const available = !!info?.available;
  const server = info?.server || 'https://chatyy.com.br/dav/';
  const host = info?.host || 'chatyy.com.br';
  const username = info?.username || api.getActiveAccountEmail?.() || '';

  const installProfile = async () => {
    setBusy('profile');
    try {
      const r = await pim.davProfileLink(Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'web' ? 'iPhone (QR)' : 'Apple');
      if (!r?.url) throw new Error('no_url');
      if (Platform.OS === 'ios') {
        await Linking.openURL(r.url); // Safari baixa o perfil → Ajustes > Perfil baixado
      } else {
        setProfileUrl(r.url);
      }
      load();
    } catch {
      Alert.alert(tt('common.error', 'Erro'), tt('calSync.linkFailed', 'Não foi possível gerar o link. Tente de novo.'));
    } finally { setBusy(''); }
  };

  const createPassword = async () => {
    setBusy('pass');
    try {
      const label = Platform.OS === 'android' ? 'Android' : Platform.OS === 'ios' ? 'iPhone' : tt('calSync.otherDevice', 'Outro aparelho');
      const r = await pim.davCreatePassword(label);
      setNewPass(r);
      load();
    } catch {
      Alert.alert(tt('common.error', 'Erro'), tt('calSync.passFailed', 'Não foi possível criar a senha. Tente de novo.'));
    } finally { setBusy(''); }
  };

  const revoke = (p) => {
    const go = async () => { try { await pim.davRevokePassword(p.id); load(); } catch {} };
    if (Platform.OS === 'web') { go(); return; }
    Alert.alert(tt('calSync.revokeTitle', 'Desconectar aparelho?'), tt('calSync.revokeMsg', 'Ele para de sincronizar até você configurar de novo.'), [
      { text: tt('common.cancel', 'Cancelar'), style: 'cancel' },
      { text: tt('calSync.revoke', 'Desconectar'), style: 'destructive', onPress: go },
    ]);
  };

  const icsUrl = (() => { try { const tk = api.getAuthToken(); return tk ? api.calExportICSUrl(tk) : ''; } catch { return ''; } })();
  const fmtDate = (v) => { try { return v ? new Date(v).toLocaleDateString(t('_locale') || undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; } catch { return ''; } };

  return (
    <View style={[s.root, { backgroundColor: g.pageBg, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title: tt('calSync.title', 'Sincronizar com o celular'), contentStyle: { backgroundColor: g.pageBg } })} />
      ) : (
        <View style={s.webHeader}>
          <TouchableOpacity onPress={() => router.back()} style={s.webBack} hitSlop={10} accessibilityRole="button" accessibilityLabel={tt('common.back', 'Voltar')}>
            <IconArrowLeft size={24} color={g.text} />
          </TouchableOpacity>
          <Text style={[s.webTitle, { color: g.text }]} accessibilityRole="header">{tt('calSync.title', 'Sincronizar com o celular')}</Text>
        </View>
      )}
      <ScrollView contentContainerStyle={[s.content, { paddingBottom: 40 + (IOS_NATIVE_INSET ? 0 : insets.bottom) }]} {...nativeScrollInsetProps()}>
        <View style={s.hero}>
          <View style={[s.heroIcon, { backgroundColor: g.tileBg }]}><IconCalendar size={30} color={g.tileFg} /></View>
          <Text style={[s.heroTitle, { color: g.text }]}>{tt('calSync.heroTitle', 'Seu Chatyy no calendário do celular')}</Text>
          <Text style={[s.heroSub, { color: g.secondary }]}>{tt('calSync.heroSub', 'Eventos aparecem no app Calendário e tarefas no Lembretes. O que você muda lá volta para cá — e vice-versa.')}</Text>
        </View>

        {loading ? <ActivityIndicator color={g.text} style={{ marginTop: 24 }} /> : (
          <>
            {available ? (
              <>
                <Text style={[s.sectionTitle, { color: g.header }]}>{tt('calSync.appleTitle', 'iPhone, iPad e Mac')}</Text>
                <Card g={g}>
                  <Text style={[s.cardText, { color: g.text }]}>{tt('calSync.appleDesc', 'Instale o perfil do Chatyy: a conta entra em Ajustes e sincroniza sozinha, com o app fechado.')}</Text>
                  <TouchableOpacity onPress={installProfile} disabled={busy === 'profile'} style={[s.primaryBtn, { backgroundColor: g.ink }]} accessibilityRole="button">
                    {busy === 'profile' ? <ActivityIndicator color={g.onInk} /> : <IconSmartphone size={18} color={g.onInk} />}
                    <Text style={[s.primaryBtnText, { color: g.onInk }]}>{Platform.OS === 'ios' ? tt('calSync.installProfile', 'Instalar no iPhone') : tt('calSync.profileQr', 'Gerar link para o iPhone')}</Text>
                  </TouchableOpacity>
                  {Platform.OS === 'ios' && (
                    <View style={{ marginTop: 12 }}>
                      <Step n="1" g={g} text={tt('calSync.iosStep1', 'Toque em Permitir para baixar o perfil.')} />
                      <Step n="2" g={g} text={tt('calSync.iosStep2', 'Abra Ajustes > Perfil Baixado > Instalar.')} />
                      <Step n="3" g={g} text={tt('calSync.iosStep3', 'Pronto: abra Calendário e Lembretes — a conta Chatyy aparece lá.')} />
                    </View>
                  )}
                  {!!profileUrl && Platform.OS !== 'ios' && (
                    <View style={s.qrWrap}>
                      {QRCode ? (
                        <View style={[s.qrBox, { backgroundColor: '#fff' }]}><QRCode value={profileUrl} size={180} color="#000" backgroundColor="#fff" /></View>
                      ) : null}
                      <Text style={[s.qrHint, { color: g.secondary }]}>{tt('calSync.qrHint', 'Aponte a câmera do iPhone para o código (vale 10 minutos, uso único).')}</Text>
                      <CopyField g={g} t={t} label={tt('calSync.link', 'Link')} value={profileUrl} />
                    </View>
                  )}
                </Card>

                <Text style={[s.sectionTitle, { color: g.header }]}>{tt('calSync.androidTitle', 'Android')}</Text>
                <Card g={g}>
                  <Step n="1" g={g} text={tt('calSync.androidStep1', 'Instale o DAVx5 (Play Store ou F-Droid).')} />
                  <Step n="2" g={g} text={tt('calSync.androidStep2', 'Escolha "Entrar com URL e usuário" e use os dados abaixo.')} />
                  <Step n="3" g={g} text={tt('calSync.androidStep3', 'Marque os calendários e listas do Chatyy. Para tarefas, use o app Tasks.org ou jtx Board.')} />
                  {Platform.OS === 'android' && (
                    <TouchableOpacity
                      onPress={() => Linking.openURL('market://details?id=at.bitfire.davdroid').catch(() => Linking.openURL('https://play.google.com/store/apps/details?id=at.bitfire.davdroid'))}
                      style={[s.secondaryBtn, { borderColor: g.separator }]}
                      accessibilityRole="button"
                    >
                      <Text style={[s.secondaryBtnText, { color: g.text }]}>{tt('calSync.getDavx', 'Abrir DAVx5 na Play Store')}</Text>
                    </TouchableOpacity>
                  )}
                </Card>

                <Text style={[s.sectionTitle, { color: g.header }]}>{tt('calSync.manualTitle', 'Dados da conta (CalDAV)')}</Text>
                <Card g={g}>
                  <CopyField g={g} t={t} label={tt('calSync.server', 'Servidor')} value={Platform.OS === 'android' ? server : host} />
                  <CopyField g={g} t={t} label={tt('calSync.username', 'Usuário')} value={username} />
                  {newPass?.password ? (
                    <>
                      <CopyField g={g} t={t} secret label={tt('calSync.appPassword', 'Senha de app')} value={newPass.password} />
                      <Text style={[s.warn, { color: g.secondary }]}>{tt('calSync.passOnce', 'Copie agora: por segurança ela não aparece de novo. Use uma senha por aparelho.')}</Text>
                    </>
                  ) : (
                    <TouchableOpacity onPress={createPassword} disabled={busy === 'pass'} style={[s.secondaryBtn, { borderColor: g.separator }]} accessibilityRole="button">
                      {busy === 'pass' ? <ActivityIndicator color={g.text} /> : <IconKey size={16} color={g.text} />}
                      <Text style={[s.secondaryBtnText, { color: g.text }]}>{tt('calSync.createPass', 'Gerar senha de app')}</Text>
                    </TouchableOpacity>
                  )}
                  <Text style={[s.small, { color: g.secondary }]}>{tt('calSync.manualIos', 'No iPhone sem perfil: Ajustes > Calendário > Contas > Adicionar Conta > Outra > Conta CalDAV.')}</Text>
                </Card>

                {(info?.passwords || []).length > 0 && (
                  <>
                    <Text style={[s.sectionTitle, { color: g.header }]}>{tt('calSync.devices', 'Aparelhos conectados')}</Text>
                    <Card g={g} style={{ paddingVertical: 4 }}>
                      {info.passwords.map((p, i) => (
                        <View key={p.id} style={[s.devRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: g.separator }]}>
                          <IconMonitor size={18} color={g.text} />
                          <View style={{ flex: 1, marginLeft: 12 }}>
                            <Text style={[s.devName, { color: g.text }]} numberOfLines={1}>{p.label || tt('calSync.device', 'Aparelho')}</Text>
                            <Text style={[s.devMeta, { color: g.secondary }]} numberOfLines={1}>
                              {p.last_used_at ? `${tt('calSync.lastSync', 'Última sincronização')}: ${fmtDate(p.last_used_at)}` : `${tt('calSync.created', 'Criada em')} ${fmtDate(p.created_at)}`}
                            </Text>
                          </View>
                          <TouchableOpacity onPress={() => revoke(p)} hitSlop={10} accessibilityRole="button" accessibilityLabel={tt('calSync.revoke', 'Desconectar')}>
                            <IconTrash size={17} color={g.destructive} />
                          </TouchableOpacity>
                        </View>
                      ))}
                    </Card>
                  </>
                )}
              </>
            ) : (
              <Card g={g}>
                <Text style={[s.cardText, { color: g.text }]}>{tt('calSync.unavailable', 'A sincronização nativa ainda está sendo ativada no servidor. Enquanto isso, assine o calendário (somente leitura) pelo link abaixo.')}</Text>
              </Card>
            )}

            {!!icsUrl && (
              <>
                <Text style={[s.sectionTitle, { color: g.header }]}>{tt('calSync.googleTitle', 'Google Agenda e outros (somente leitura)')}</Text>
                <Card g={g}>
                  <Text style={[s.cardText, { color: g.text }]}>{tt('calSync.googleDesc', 'No Google Agenda (computador): Outras agendas > Do URL, e cole o link. Atualiza a cada poucas horas.')}</Text>
                  <CopyField g={g} t={t} label="URL .ics" value={icsUrl} />
                  <View style={s.inline}><IconGlobe size={14} color={g.secondary} /><Text style={[s.small, { color: g.secondary, marginTop: 0, marginLeft: 6 }]}>{tt('calSync.icsPrivate', 'Este link é pessoal: não compartilhe.')}</Text></View>
                </Card>
              </>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  webHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 6, paddingBottom: 2 },
  webBack: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  webTitle: { flex: 1, fontSize: 24, fontWeight: '700', letterSpacing: -0.4, marginLeft: 6 },
  content: { width: '100%', maxWidth: 640, alignSelf: 'center', paddingHorizontal: 16 },
  hero: { alignItems: 'center', paddingTop: 18, paddingBottom: 8, paddingHorizontal: 12 },
  heroIcon: { width: 60, height: 60, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  heroTitle: { fontSize: 22, fontWeight: '700', textAlign: 'center', letterSpacing: -0.4 },
  heroSub: { fontSize: 15, textAlign: 'center', marginTop: 8, lineHeight: 21 },
  sectionTitle: { fontSize: 13, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.2, marginTop: 24, marginBottom: 7, paddingHorizontal: 16 },
  card: { borderRadius: 12, padding: 16 },
  cardText: { fontSize: 15, lineHeight: 21 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, height: 48, borderRadius: 12, marginTop: 14 },
  primaryBtnText: { fontSize: 16, fontWeight: '700' },
  secondaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, borderRadius: 10, borderWidth: 1, marginTop: 12 },
  secondaryBtnText: { fontSize: 15, fontWeight: '600' },
  step: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 10 },
  stepNum: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginRight: 10, marginTop: 1 },
  stepNumText: { fontSize: 12, fontWeight: '700' },
  stepText: { flex: 1, fontSize: 15, lineHeight: 21 },
  field: { marginTop: 10, alignSelf: 'stretch' },
  fieldLabel: { fontSize: 12, fontWeight: '600', marginBottom: 4 },
  fieldBox: { flexDirection: 'row', alignItems: 'center', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 10, gap: 10 },
  fieldValue: { flex: 1, fontSize: 15 },
  warn: { fontSize: 13, marginTop: 8, lineHeight: 18 },
  small: { fontSize: 13, marginTop: 12, lineHeight: 18 },
  inline: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  qrWrap: { alignItems: 'center', marginTop: 16 },
  qrBox: { padding: 12, borderRadius: 12 },
  qrHint: { fontSize: 13, textAlign: 'center', marginTop: 10 },
  devRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  devName: { fontSize: 15, fontWeight: '600' },
  devMeta: { fontSize: 12.5, marginTop: 2 },
});
