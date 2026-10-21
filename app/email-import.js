/**
 * /email-import — Importar e-mails de outras contas.  [2026-10-16 email-import-imap]
 *
 * Caminho principal (funciona sem OAuth): IMAP com SENHA DE APP.
 *   1. escolhe o provedor (Gmail, Outlook, Yahoo, iCloud ou outro);
 *   2. passo a passo "como criar a senha de app" com link p/ a página oficial;
 *   3. e-mail + senha de app (+ servidor só p/ "outro"), período 30/90/365 dias;
 *   4. "Testar conexão" (só leitura) → mostra quantos e-mails vai trazer;
 *   5. importação roda NO SERVIDOR em 2º plano p/ "Importados/<Provedor> - <conta>";
 *      progresso real (email_import_status), dá p/ sair da tela e voltar.
 * Nada é apagado/alterado na conta original (IMAP somente leitura, sem marcar lido).
 * A senha não é guardada no aparelho; no servidor fica cifrada só enquanto roda.
 *
 * OAuth (Google/Microsoft) fica ESCONDIDO até existir client_id + backend —
 * ver /root/email-import-oauth-LEIAME.md (feature flag extra.emailImportOAuth).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput,
  ActivityIndicator, Platform, Linking,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader'; // [2026-10-09 native-sheets-headers]
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Spacing, BorderRadius, FontSize } from '../constants/theme';
import {
  IconMail, IconCheck, IconAlertTriangle, IconRefresh, IconChevronRight, IconChevronLeft, IconLock,
  IconEye, IconEyeOff, IconGlobe, IconFolder, IconClock, IconShield, IconX, IconSettings,
} from '../components/Icons';
import {
  emailImportDetect, emailImportTest, emailImportStart, emailImportStatus,
  emailImportList, emailImportCancel, emailImportForget, emailOauthImportStart,
} from '../services/api';
import ModalHeader from '../components/ModalHeader';
import PressableScale from '../components/PressableScale';

import { a11yLabel } from '../utils/a11yLabel'; // [2026-10-20 a11y] rótulos dos botões só-ícone
const PROVIDERS = [
  { id: 'gmail', label: 'Gmail', desc: 'emailImport.gmailDesc', domain: 'gmail.com', help: 'https://myaccount.google.com/apppasswords',
    steps: ['emailImport.gmailStep1', 'emailImport.gmailStep2', 'emailImport.stepPaste'] },
  { id: 'outlook', label: 'Outlook / Hotmail', desc: 'emailImport.outlookDesc', domain: 'outlook.com', help: 'https://account.live.com/proofs/AppPassword',
    steps: ['emailImport.outlookStep1', 'emailImport.outlookStep2', 'emailImport.stepPaste'], note: 'emailImport.outlookNote' },
  { id: 'yahoo', label: 'Yahoo', desc: 'emailImport.yahooDesc', domain: 'yahoo.com', help: 'https://login.yahoo.com/account/security',
    steps: ['emailImport.yahooStep1', 'emailImport.stepPaste'] },
  { id: 'icloud', label: 'iCloud', desc: 'emailImport.icloudDesc', domain: 'icloud.com', help: 'https://account.apple.com/account/manage',
    steps: ['emailImport.icloudStep1', 'emailImport.icloudStep2', 'emailImport.stepPaste'] },
  { id: 'other', label: null, desc: 'emailImport.otherDesc', domain: '', help: '',
    steps: ['emailImport.otherStep'] },
];
const PERIODS = [30, 90, 365];
const ERR_KEYS = {
  auth_failed: 'emailImport.errAuth', app_password_required: 'emailImport.errAppPassword', basic_auth_blocked: 'emailImport.errBasicAuth',
  imap_disabled: 'emailImport.errImapDisabled', server_unreachable: 'emailImport.errServer', server_unknown: 'emailImport.errServerUnknown',
  connect_failed: 'emailImport.errServer', tls_failed: 'emailImport.errServer', rate_limited: 'emailImport.errRateLimited',
  same_account: 'emailImport.errSameAccount', already_running: 'emailImport.errAlreadyRunning', invalid_email: 'emailImport.errInvalidEmail',
  no_mailbox: 'emailImport.errGeneric', credentials_expired: 'emailImport.errGeneric', append_failed: 'emailImport.errGeneric', internal: 'emailImport.errGeneric',
};
// ── OAuth (escondido) ──────────────────────────────────────────────────────
// Só aparece com expo.extra.emailImportOAuth === true E o client_id do provedor
// configurado (ver /root/email-import-oauth-LEIAME.md). Sem isso o usuário NUNCA
// vê botão de OAuth nem erro técnico de configuração.
const OAUTH = {
  gmail: { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', scope: 'https://mail.google.com/', key: 'oauthGoogleClientIdWeb', ios: 'oauthGoogleClientIdIos', android: 'oauthGoogleClientIdAndroid', label: 'Google' },
  outlook: { authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access', key: 'oauthMicrosoftClientId', label: 'Microsoft' },
};
function oauthClientId(provId) {
  const cfg = OAUTH[provId];
  const extra = (Constants?.expoConfig?.extra) || (Constants?.manifest?.extra) || {};
  if (!cfg || extra.emailImportOAuth !== true) return '';
  if (Platform.OS === 'ios' && cfg.ios && extra[cfg.ios]) return extra[cfg.ios];
  if (Platform.OS === 'android' && cfg.android && extra[cfg.android]) return extra[cfg.android];
  return extra[cfg.key] || '';
}
async function oauthToken(provId) {
  const cfg = OAUTH[provId];
  const clientId = oauthClientId(provId);
  if (!clientId) throw new Error('oauth_off');
  const redirectUri = Platform.OS === 'web' ? window.location.origin + '/email-import' : 'com.onemundo.mail://oauth-redirect';
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'token', scope: cfg.scope, prompt: 'consent' });
  const res = await WebBrowser.openAuthSessionAsync(cfg.authUrl + '?' + q.toString(), redirectUri);
  if (res.type !== 'success') throw new Error('cancelled');
  const frag = (res.url || '').split('#')[1] || (res.url || '').split('?')[1] || '';
  const tok = new URLSearchParams(frag).get('access_token');
  if (!tok) throw new Error('oauth_failed');
  return tok;
}

const isActive = (j) => j && (j.status === 'queued' || j.status === 'running');

export default function EmailImportScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const [step, setStep] = useState('choose'); // choose | form | job
  const [prov, setProv] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('993');
  const [advanced, setAdvanced] = useState(false);
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [tested, setTested] = useState(null); // { estimate, capped }
  const [job, setJob] = useState(null);
  const [history, setHistory] = useState([]);
  const pollRef = useRef(null);
  const aliveRef = useRef(true);

  const errText = useCallback((code) => t(ERR_KEYS[code] || 'emailImport.errGeneric'), [t]);

  const loadHistory = useCallback(async () => {
    try {
      const r = await emailImportList();
      if (r?.success) {
        const list = r.data?.imports || [];
        setHistory(list);
        return list;
      }
    } catch {}
    return [];
  }, []);

  const poll = useCallback((id) => {
    if (pollRef.current) clearTimeout(pollRef.current);
    const tick = async () => {
      if (!aliveRef.current) return;
      try {
        const r = await emailImportStatus(id);
        if (r?.success && r.data) {
          setJob(r.data);
          if (!isActive(r.data)) { loadHistory(); return; }
        }
      } catch {}
      pollRef.current = setTimeout(tick, 1500);
    };
    tick();
  }, [loadHistory]);

  useEffect(() => {
    aliveRef.current = true;
    (async () => {
      const list = await loadHistory();
      const running = list.find(isActive);
      if (running) { setJob(running); setStep('job'); poll(running.id); }
    })();
    return () => { aliveRef.current = false; if (pollRef.current) clearTimeout(pollRef.current); };
  }, [loadHistory, poll]);

  const pick = useCallback((p) => {
    setProv(p); setErr(''); setTested(null); setPassword(''); setShowPass(false);
    setEmail(''); setHost(''); setPort('993'); setAdvanced(false);
    setStep('form');
  }, []);

  const openHelp = useCallback(async (url) => {
    if (!url) return;
    try {
      if (Platform.OS === 'web') { window.open(url, '_blank', 'noopener'); return; }
      await WebBrowser.openBrowserAsync(url);
    } catch { try { await Linking.openURL(url); } catch {} }
  }, []);

  // "outro": ao sair do campo de e-mail, o servidor sugere o IMAP (MX/heurística).
  const detect = useCallback(async () => {
    const e = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(e)) return;
    try {
      const r = await emailImportDetect(e);
      if (r?.success && r.data) {
        if (r.data.host && !host) setHost(r.data.host);
        if (r.data.needs_server) setAdvanced(true);
      }
    } catch {}
  }, [email, host]);

  const payload = () => ({
    email: email.trim().toLowerCase(), password,
    host: advanced ? host.trim() : '', port: advanced ? (parseInt(port, 10) || 993) : 993, days,
  });

  const test = useCallback(async () => {
    setErr(''); setTested(null);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setErr('invalid_email'); return; }
    if (!password) return;
    setBusy('test');
    try {
      const r = await emailImportTest(payload());
      if (r?.success) setTested({ estimate: r.data?.estimate || 0, capped: !!r.data?.capped });
      else setErr(r?.data?.error || 'internal');
    } catch { setErr('internal'); }
    finally { setBusy(''); }
  }, [email, password, host, port, advanced, days]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = useCallback(async () => {
    setErr(''); setBusy('start');
    try {
      const r = await emailImportStart(payload());
      if (r?.success && r.data?.id) {
        setPassword(''); // nunca fica no aparelho
        setJob({ id: r.data.id, status: 'queued', total: r.data.estimate || 0, processed: 0, imported: 0, skipped: 0, failed: 0, percent: 0, folder: r.data.folder, src_email: email.trim().toLowerCase() });
        setStep('job');
        poll(r.data.id);
      } else setErr(r?.data?.error || 'internal');
    } catch { setErr('internal'); }
    finally { setBusy(''); }
  }, [email, password, host, port, advanced, days, poll]); // eslint-disable-line react-hooks/exhaustive-deps

  const startOAuth = useCallback(async () => {
    setErr(''); setBusy('oauth');
    try {
      const tok = await oauthToken(prov.id);
      const r = await emailOauthImportStart(prov.id, tok, 5000);
      if (r?.success && (r.data?.id || r.data?.import_id)) {
        const id = r.data.id || r.data.import_id;
        setJob({ id, status: 'queued', total: 0, processed: 0, imported: 0, percent: 0, folder: r.data.folder, src_email: prov.label });
        setStep('job'); poll(id);
      } else setErr('internal');
    } catch (e) { if (String(e?.message) !== 'cancelled') setErr('internal'); }
    finally { setBusy(''); }
  }, [prov, poll]);

  const cancel = useCallback(async () => {
    if (!job) return;
    setBusy('cancel');
    try { const r = await emailImportCancel(job.id); if (r?.success) setJob(r.data); } catch {}
    setBusy(''); loadHistory();
  }, [job, loadHistory]);

  const openFolder = useCallback((folder) => {
    if (!folder) return;
    router.push('/inbox?folder=' + encodeURIComponent(folder));
  }, [router]);

  const forget = useCallback(async (id) => {
    try { await emailImportForget(id); } catch {}
    loadHistory();
  }, [loadHistory]);

  const c = colors;
  const card = [s.card, { backgroundColor: c.surface, borderColor: c.borderLight }];
  const chipBg = c.surfaceVariant || (isDark ? '#1c1c1e' : '#F2F2F7');
  const statusLabel = (st) => t(st === 'done' ? 'emailImport.statusDone' : st === 'error' ? 'emailImport.statusError' : st === 'cancelled' ? 'emailImport.statusCancelled' : 'emailImport.statusRunning');

  const ErrorBox = ({ code }) => (!code ? null : (
    <View style={[s.errBox, { borderColor: c.error || '#d11' }]}>
      <IconAlertTriangle size={16} color={c.error || '#d11'} />
      <Text style={[s.errText, { color: c.error || '#d11' }]}>{errText(code)}</Text>
    </View>
  ));

  const renderChoose = () => (
    <>
      <Text style={[s.intro, { color: c.textSecondary }]}>{t('emailImport.intro')}</Text>
      <View style={[card, { paddingVertical: 4 }]}>
        {PROVIDERS.map((p, i) => (
          <TouchableOpacity key={p.id} onPress={() => pick(p)} activeOpacity={0.7} testID={'import-' + p.id}
            style={[s.provRow, i < PROVIDERS.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderLight }]}>
            <View style={[s.provIcon, { backgroundColor: chipBg }]}>
              {p.id === 'other' ? <IconGlobe size={19} color={c.text} /> : <IconMail size={19} color={c.text} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[s.provLabel, { color: c.text }]}>{p.label || t('emailImport.otherAccount')}</Text>
              <Text style={[s.provDesc, { color: c.textTertiary }]}>{t(p.desc)}</Text>
            </View>
            <IconChevronRight size={16} color={c.textTertiary} />
          </TouchableOpacity>
        ))}
      </View>
      <View style={s.trustRow}>
        <IconShield size={14} color={c.textSecondary} />
        <Text style={[s.trustText, { color: c.textSecondary }]}>{t('emailImport.privacy')}</Text>
      </View>
    </>
  );

  const renderForm = () => (
    <>
      <TouchableOpacity onPress={() => setStep('choose')} style={s.back} hitSlop={8}>
        <IconChevronLeft size={16} color={c.textSecondary} />
        <Text style={[s.backText, { color: c.textSecondary }]}>{t('emailImport.otherProviders')}</Text>
      </TouchableOpacity>

      <View style={card}>
        <Text style={[s.cardTitle, { color: c.text }]}>{prov.id === 'other' ? t('emailImport.otherAccount') : t('emailImport.stepsTitle')}</Text>
        {prov.steps.map((k, i) => (
          <View key={k} style={s.stepRow}>
            <View style={[s.stepNum, { backgroundColor: c.text }]}><Text style={[s.stepNumText, { color: c.background }]}>{i + 1}</Text></View>
            <Text style={[s.stepText, { color: c.text }]}>{t(k)}</Text>
          </View>
        ))}
        {!!prov.help && (
          <TouchableOpacity onPress={() => openHelp(prov.help)} activeOpacity={0.8} style={[s.outlineBtn, { borderColor: c.border }]}>
            <IconGlobe size={16} color={c.text} />
            <Text style={[s.outlineBtnText, { color: c.text }]}>{t('emailImport.openOfficial')}</Text>
          </TouchableOpacity>
        )}
        {!!prov.note && <Text style={[s.note, { color: c.textSecondary }]}>{t(prov.note)}</Text>}
      </View>

      {!!oauthClientId(prov.id) && (
        <PressableScale onPress={startOAuth} disabled={!!busy} style={[s.primaryBtn, { backgroundColor: c.text, marginTop: 0, marginBottom: Spacing.md }]}>
          {busy === 'oauth' ? <ActivityIndicator color={c.background} /> : <Text style={[s.primaryBtnText, { color: c.background }]}>{t('emailImport.signInWith', { provider: OAUTH[prov.id].label })}</Text>}
        </PressableScale>
      )}
      <View style={card}>
        <Text style={[s.label, { color: c.textTertiary }]}>{t('emailImport.emailLabel')}</Text>
        <TextInput value={email} onChangeText={(v) => { setEmail(v); setTested(null); }} onBlur={prov.id === 'other' ? detect : undefined}
          placeholder={prov.domain ? 'nome@' + prov.domain : 'nome@empresa.com.br'} placeholderTextColor={c.textTertiary}
          autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="off" textContentType="none"
          style={[s.input, { color: c.text, borderColor: c.border, backgroundColor: c.background }]} testID="import-email" />

        <Text style={[s.label, { color: c.textTertiary }]}>{prov.id === 'other' ? t('emailImport.passwordOrApp') : t('emailImport.appPassword')}</Text>
        <View style={[s.inputWrap, { borderColor: c.border, backgroundColor: c.background }]}>
          <TextInput value={password} onChangeText={(v) => { setPassword(v); setTested(null); }} secureTextEntry={!showPass}
            placeholder={prov.id === 'gmail' ? 'xxxx xxxx xxxx xxxx' : '••••••••'} placeholderTextColor={c.textTertiary}
            autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none"
            style={[s.inputInner, { color: c.text }]} testID="import-password" />
          <TouchableOpacity onPress={() => setShowPass(v => !v)} hitSlop={10} style={{ paddingHorizontal: 12 }}>
            {showPass ? <IconEyeOff size={18} color={c.textSecondary} /> : <IconEye size={18} color={c.textSecondary} />}
          </TouchableOpacity>
        </View>

        <TouchableOpacity onPress={() => setAdvanced(v => !v)} style={s.advToggle} hitSlop={6}>
          <IconSettings size={14} color={c.textSecondary} />
          <Text style={[s.advText, { color: c.textSecondary }]}>{t('emailImport.advanced')}</Text>
        </TouchableOpacity>
        {advanced && (
          <View style={s.advRow}>
            <TextInput value={host} onChangeText={(v) => { setHost(v); setTested(null); }} placeholder={t('emailImport.server')}
              placeholderTextColor={c.textTertiary} autoCapitalize="none" autoCorrect={false}
              style={[s.input, { flex: 1, marginBottom: 0, color: c.text, borderColor: c.border, backgroundColor: c.background }]} />
            <TextInput value={port} onChangeText={(v) => { setPort(v.replace(/\D/g, '')); setTested(null); }} placeholder="993" keyboardType="number-pad"
              placeholderTextColor={c.textTertiary}
              style={[s.input, { width: 76, marginBottom: 0, marginLeft: 8, color: c.text, borderColor: c.border, backgroundColor: c.background }]} />
          </View>
        )}

        <Text style={[s.label, { color: c.textTertiary, marginTop: 14 }]}>{t('emailImport.period')}</Text>
        <View style={s.chips}>
          {PERIODS.map(d => {
            const on = d === days;
            return (
              <TouchableOpacity key={d} onPress={() => { setDays(d); setTested(null); }} activeOpacity={0.8}
                style={[s.chip, { borderColor: on ? c.text : c.border, backgroundColor: on ? c.text : 'transparent' }]}>
                <Text style={[s.chipText, { color: on ? c.background : c.text }]}>{t(d === 365 ? 'emailImport.days365' : 'emailImport.daysN', { n: d })}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <ErrorBox code={err} />

        {tested ? (
          <>
            <View style={[s.okBox, { borderColor: c.text }]}>
              <IconCheck size={16} color={c.text} />
              <Text style={[s.okText, { color: c.text }]}>{t('emailImport.testOk', { count: tested.estimate })}</Text>
            </View>
            {tested.capped && <Text style={[s.note, { color: c.textSecondary }]}>{t('emailImport.capped')}</Text>}
            <PressableScale onPress={start} disabled={!!busy || tested.estimate === 0}
              style={[s.primaryBtn, { backgroundColor: c.text, opacity: busy || tested.estimate === 0 ? 0.5 : 1 }]} testID="import-start">
              {busy === 'start' ? <ActivityIndicator color={c.background} /> : (
                <><IconFolder size={17} color={c.background} /><Text style={[s.primaryBtnText, { color: c.background }]}>{tested.estimate === 0 ? t('emailImport.nothing') : t('emailImport.start', { count: tested.estimate })}</Text></>
              )}
            </PressableScale>
          </>
        ) : (
          <PressableScale onPress={test} disabled={!!busy || !email.trim() || !password}
            style={[s.primaryBtn, { backgroundColor: c.text, opacity: busy || !email.trim() || !password ? 0.45 : 1 }]} testID="import-test">
            {busy === 'test' ? (
              <><ActivityIndicator color={c.background} /><Text style={[s.primaryBtnText, { color: c.background }]}>{t('emailImport.testing')}</Text></>
            ) : (
              <><IconLock size={17} color={c.background} /><Text style={[s.primaryBtnText, { color: c.background }]}>{t('emailImport.test')}</Text></>
            )}
          </PressableScale>
        )}
      </View>

      <View style={s.trustRow}>
        <IconShield size={14} color={c.textSecondary} />
        <Text style={[s.trustText, { color: c.textSecondary }]}>{t('emailImport.privacy')}</Text>
      </View>
    </>
  );

  const renderJob = () => {
    const j = job || {};
    const running = isActive(j);
    const pct = Math.max(0, Math.min(100, j.percent || 0));
    return (
      <>
        <View style={[card, { alignItems: 'center', paddingTop: 26 }]}>
          <View style={[s.hero, { backgroundColor: c.text }]}>
            {running ? <ActivityIndicator color={c.background} /> : j.status === 'done' ? <IconCheck size={28} color={c.background} /> : j.status === 'cancelled' ? <IconX size={26} color={c.background} /> : <IconAlertTriangle size={26} color={c.background} />}
          </View>
          <Text style={[s.heroTitle, { color: c.text }]}>
            {running ? t('emailImport.runningTitle') : j.status === 'done' ? t('emailImport.doneTitle') : statusLabel(j.status)}
          </Text>
          <Text style={[s.heroSub, { color: c.textSecondary }]} numberOfLines={1}>{j.src_email}</Text>

          {(running || j.status === 'done') && (
            <View style={{ alignSelf: 'stretch', marginTop: 18 }}>
              <View style={[s.bar, { backgroundColor: c.borderLight }]}>
                <View style={[s.barFill, { width: `${running ? Math.max(3, pct) : 100}%`, backgroundColor: c.text }]} />
              </View>
              <View style={s.barMeta}>
                <Text style={[s.barText, { color: c.textSecondary }]}>
                  {j.total > 0 ? t('emailImport.progress', { fetched: j.processed || 0, max: j.total }) : t('emailImport.preparing')}
                </Text>
                <Text style={[s.barText, { color: c.text, fontWeight: '800' }]}>{running ? pct : 100}%</Text>
              </View>
            </View>
          )}

          {j.status === 'done' && (
            <Text style={[s.summary, { color: c.text }]}>
              {t('emailImport.doneSummary', { count: j.imported || 0 })}
              {j.skipped > 0 ? '  ' + t('emailImport.skippedNote', { n: j.skipped }) : ''}
            </Text>
          )}
          {j.status === 'error' && <ErrorBox code={j.error_code || 'internal'} />}
          {running && (
            <View style={[s.infoBox, { backgroundColor: chipBg }]}>
              <IconClock size={15} color={c.text} />
              <Text style={[s.infoText, { color: c.text }]}>{t('emailImport.background')}</Text>
            </View>
          )}
        </View>

        {!!j.folder && (j.imported > 0 || running) && (
          <PressableScale onPress={() => openFolder(j.folder)} style={[s.primaryBtn, { backgroundColor: c.text }]}>
            <IconFolder size={17} color={c.background} />
            <Text style={[s.primaryBtnText, { color: c.background }]}>{t('emailImport.openFolder')}</Text>
          </PressableScale>
        )}
        {running ? (
          <TouchableOpacity onPress={cancel} disabled={!!busy} style={[s.outlineBtn, { borderColor: c.border, marginTop: 10 }]}>
            {busy === 'cancel' ? <ActivityIndicator color={c.text} /> : <Text style={[s.outlineBtnText, { color: c.text }]}>{t('emailImport.cancel')}</Text>}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={() => { setJob(null); setStep('choose'); }} style={[s.outlineBtn, { borderColor: c.border, marginTop: 10 }]}>
            <Text style={[s.outlineBtnText, { color: c.text }]}>{t('emailImport.another')}</Text>
          </TouchableOpacity>
        )}
      </>
    );
  };

  const past = history.filter(h => !job || h.id !== job.id);

  return (
    <View style={[s.root, { backgroundColor: c.background }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title: t('emailImport.title') })} />
      ) : (
        <ModalHeader title={t('emailImport.title')} onClose={() => router.back()} />
      )}
      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 96 }} keyboardShouldPersistTaps="handled">
        {step === 'choose' && renderChoose()}
        {step === 'form' && prov && renderForm()}
        {step === 'job' && renderJob()}

        {step !== 'form' && past.length > 0 && (
          <>
            <View style={s.histHead}>
              <Text style={[s.section, { color: c.textSecondary }]}>{t('emailImport.history')}</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.refresh', 'Atualizar')} onPress={loadHistory} hitSlop={10}><IconRefresh size={14} color={c.textSecondary} /></TouchableOpacity>
            </View>
            <View style={[card, { paddingVertical: 2 }]}>
              {past.slice(0, 8).map((h, i) => (
                <TouchableOpacity key={h.id} activeOpacity={0.7}
                  onPress={() => (isActive(h) ? (setJob(h), setStep('job'), poll(h.id)) : (h.imported > 0 ? openFolder(h.folder) : null))}
                  onLongPress={() => !isActive(h) && forget(h.id)}
                  style={[s.histRow, i < Math.min(past.length, 8) - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderLight }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.histTitle, { color: c.text }]} numberOfLines={1}>{h.src_email}</Text>
                    <Text style={[s.histMeta, { color: c.textTertiary }]}>
                      {statusLabel(h.status)} · {t('emailImport.importedN', { n: h.imported || 0 })} · {h.created_at ? new Date(String(h.created_at).replace(' ', 'T').replace(/\+00$/, 'Z')).toLocaleDateString() : ''}
                    </Text>
                  </View>
                  {h.imported > 0 && <IconChevronRight size={15} color={c.textTertiary} />}
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  intro: { fontSize: FontSize.sm, lineHeight: 20, marginBottom: Spacing.lg },
  card: { padding: Spacing.lg, borderRadius: BorderRadius.xl, borderWidth: 1, marginBottom: Spacing.md },
  cardTitle: { fontSize: FontSize.lg, fontWeight: '800', letterSpacing: -0.2, marginBottom: 12 },
  provRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, gap: 12 },
  provIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  provLabel: { fontSize: FontSize.base, fontWeight: '700' },
  provDesc: { fontSize: FontSize.xs, marginTop: 2 },
  trustRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingHorizontal: 6, marginTop: 2 },
  trustText: { flex: 1, fontSize: FontSize.xs, lineHeight: 18 },
  back: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 2 },
  backText: { fontSize: FontSize.sm, fontWeight: '600' },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10, gap: 10 },
  stepNum: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepNumText: { fontSize: 12, fontWeight: '800' },
  stepText: { flex: 1, fontSize: FontSize.sm, lineHeight: 20 },
  note: { fontSize: FontSize.xs, lineHeight: 18, marginTop: 10 },
  outlineBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: BorderRadius.lg, paddingVertical: 12, gap: 8, marginTop: 4 },
  outlineBtnText: { fontSize: FontSize.sm, fontWeight: '700' },
  label: { fontSize: FontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: BorderRadius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: FontSize.base, marginBottom: 12 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: BorderRadius.md },
  inputInner: { flex: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: FontSize.base },
  advToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, marginBottom: 8 },
  advText: { fontSize: FontSize.xs, fontWeight: '600' },
  advRow: { flexDirection: 'row', alignItems: 'center' },
  chips: { flexDirection: 'row', gap: 8 },
  chip: { flex: 1, alignItems: 'center', borderWidth: 1, borderRadius: 999, paddingVertical: 9 },
  chipText: { fontSize: FontSize.sm, fontWeight: '700' },
  errBox: { flexDirection: 'row', alignItems: 'flex-start', borderWidth: 1, borderRadius: BorderRadius.md, padding: 12, gap: 8, marginTop: 14, alignSelf: 'stretch' },
  errText: { flex: 1, fontSize: FontSize.sm, lineHeight: 19 },
  okBox: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: BorderRadius.md, padding: 12, gap: 8, marginTop: 14 },
  okText: { flex: 1, fontSize: FontSize.sm, fontWeight: '700' },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 15, borderRadius: BorderRadius.lg, marginTop: 14, gap: 8 },
  primaryBtnText: { fontSize: FontSize.base, fontWeight: '800' },
  hero: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  heroTitle: { fontSize: 19, fontWeight: '800', letterSpacing: -0.3, textAlign: 'center' },
  heroSub: { fontSize: FontSize.sm, marginTop: 4 },
  bar: { height: 8, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  barMeta: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  barText: { fontSize: FontSize.xs },
  summary: { fontSize: FontSize.sm, fontWeight: '600', textAlign: 'center', marginTop: 14, lineHeight: 20 },
  infoBox: { flexDirection: 'row', alignItems: 'flex-start', borderRadius: BorderRadius.md, padding: 12, gap: 8, marginTop: 16, alignSelf: 'stretch' },
  infoText: { flex: 1, fontSize: FontSize.xs, lineHeight: 18, fontWeight: '600' },
  histHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.lg, marginBottom: Spacing.sm, paddingHorizontal: 4 },
  section: { fontSize: FontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  histRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  histTitle: { fontSize: FontSize.sm, fontWeight: '700' },
  histMeta: { fontSize: FontSize.xs, marginTop: 2 },
});
