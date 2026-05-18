/**
 * /email-import — Importar emails de Gmail / Outlook / Microsoft.
 *
 * Flow:
 *   1. User picks a provider tile (Gmail / Outlook).
 *   2. We open the provider's OAuth consent screen via expo-auth-session
 *      (implicit flow on native, redirect flow on web).
 *   3. The returned access_token is POSTed to email_oauth_import_start
 *      → backend creates an import session in PG.
 *   4. Frontend polls email_oauth_import_step (25 emails/batch) and
 *      renders a smooth progress bar until status='done'.
 *
 * Scopes:
 *   Gmail   → https://www.googleapis.com/auth/gmail.readonly
 *   Outlook → Mail.Read (Microsoft Graph)
 *
 * Client IDs live in app.json `extra.oauthGoogleClientIdWeb` /
 * `extra.oauthMicrosoftClientId`. See OAUTH_SETUP.md for the
 * Google Cloud + Azure portal steps.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  ActivityIndicator, Alert, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Spacing, BorderRadius, FontSize } from '../constants/theme';
import { IconMail, IconCheck, IconAlertTriangle, IconRefresh } from '../components/Icons';
import {
  emailOauthImportStart, emailOauthImportStep, emailOauthImportList,
} from '../services/api';
import ModalHeader from '../components/ModalHeader';

// Try to use expo-auth-session when available, otherwise fall back to
// WebBrowser.openAuthSessionAsync which ships with every Expo build.
// `expo-auth-session` is the cleaner API (PKCE on iOS, refresh flow) but
// requires a build to add. The WebBrowser fallback is good enough to
// validate the loop end-to-end.
let AuthSession = null;
try { AuthSession = require('expo-auth-session'); } catch {}

WebBrowser.maybeCompleteAuthSession?.();

const PROVIDERS = [
  {
    id: 'gmail',
    label: 'Gmail',
    description: 'Google Workspace e contas Gmail',
    color: '#ea4335',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    clientIdKey: 'oauthGoogleClientIdWeb',
    iosClientIdKey: 'oauthGoogleClientIdIos',
    androidClientIdKey: 'oauthGoogleClientIdAndroid',
  },
  {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    description: 'outlook.com, hotmail, live, M365',
    color: '#0078d4',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    scope: 'https://graph.microsoft.com/Mail.Read offline_access',
    clientIdKey: 'oauthMicrosoftClientId',
  },
];

function extraConfig() {
  // Read from app.json -> expo.extra. EAS injects these at build time.
  return (Constants?.expoConfig?.extra) || (Constants?.manifest?.extra) || {};
}

function platformClientId(provider) {
  const extra = extraConfig();
  if (Platform.OS === 'ios' && provider.iosClientIdKey && extra[provider.iosClientIdKey]) {
    return extra[provider.iosClientIdKey];
  }
  if (Platform.OS === 'android' && provider.androidClientIdKey && extra[provider.androidClientIdKey]) {
    return extra[provider.androidClientIdKey];
  }
  return extra[provider.clientIdKey] || '';
}

function buildRedirectUri() {
  // expo-auth-session would pick this up automatically. With the WebBrowser
  // fallback we hand-build a URI scheme that lands back in the app.
  if (Platform.OS === 'web') {
    return (typeof window !== 'undefined' && window.location?.origin)
      ? window.location.origin + '/email-import'
      : 'https://chatyy.com.br/email-import';
  }
  return 'com.onemundo.mail://oauth-redirect';
}

async function obtainAccessToken(provider) {
  const clientId = platformClientId(provider);
  if (!clientId) {
    throw new Error('OAuth client_id ausente para ' + provider.label + '. Configure expo.extra.' + provider.clientIdKey + ' em app.json.');
  }
  const redirectUri = buildRedirectUri();
  // Use Implicit flow for both providers — simpler than auth-code +
  // backend secret. Token is short-lived but the backend pages through
  // everything before it expires (~1h).
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: provider.scope,
    prompt: 'consent',
  });
  const authUrl = provider.authUrl + '?' + params.toString();
  // Prefer expo-auth-session when present.
  if (AuthSession?.startAsync) {
    const result = await AuthSession.startAsync({ authUrl, returnUrl: redirectUri });
    if (result.type !== 'success') throw new Error('Cancelado');
    const tok = result.params?.access_token || result.params?.['#access_token'];
    if (!tok) throw new Error('access_token ausente na resposta');
    return tok;
  }
  // Fallback path.
  const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri);
  if (result.type !== 'success') throw new Error('Cancelado');
  // Parse fragment "#access_token=…"
  const url = result.url || '';
  const frag = url.split('#')[1] || url.split('?')[1] || '';
  const usp = new URLSearchParams(frag);
  const tok = usp.get('access_token');
  if (!tok) throw new Error('access_token ausente na resposta');
  return tok;
}

export default function EmailImportScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [activeProvider, setActiveProvider] = useState(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState({ fetched: 0, imported: 0, max: 1000 });
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);

  const loadHistory = useCallback(async () => {
    try {
      const r = await emailOauthImportList();
      if (r?.success) setHistory(r.data?.imports || []);
    } catch {}
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const runImport = useCallback(async (provider) => {
    setError('');
    setDone(false);
    setActiveProvider(provider);
    setImporting(true);
    setProgress({ fetched: 0, imported: 0, max: 1000 });
    try {
      const token = await obtainAccessToken(provider);
      const startR = await emailOauthImportStart(provider.id, token, 1000);
      if (!startR?.success) throw new Error(startR?.message || 'Falha ao iniciar import');
      const importId = startR.data.import_id;
      // Poll until done. Cap to ~120 iterations (1000 / 25 = 40 normally;
      // 3× margin for transient errors).
      let isDone = false;
      for (let i = 0; i < 120 && !isDone; i++) {
        const stepR = await emailOauthImportStep(importId);
        if (!stepR?.success) throw new Error(stepR?.message || 'Falha no batch');
        const d = stepR.data || {};
        setProgress({ fetched: d.fetched || 0, imported: d.imported || 0, max: d.max || 1000 });
        if (d.done) isDone = true;
        // Tiny pause so the UI can repaint and the backend can breathe.
        await new Promise(r => setTimeout(r, 300));
      }
      setDone(true);
      loadHistory();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setImporting(false);
    }
  }, [loadHistory]);

  const pct = progress.max > 0 ? Math.min(100, Math.round((progress.fetched / progress.max) * 100)) : 0;

  return (
    <View style={[s.root, { backgroundColor: colors.background }]}>
      <ModalHeader title={t('emailImport.title') || 'Importar de outras contas'} onClose={() => router.back()} />
      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 80 }}>
        <Text style={[s.subtitle, { color: colors.textSecondary }]}>
          {t('emailImport.subtitle') || 'Trazemos seus emails recentes do Gmail ou Outlook pra dentro do Chatyy. Os emails ficam numa pasta separada e nada é removido da conta original.'}
        </Text>

        {PROVIDERS.map((p) => {
          const isActive = activeProvider?.id === p.id;
          return (
            <TouchableOpacity
              key={p.id}
              disabled={importing}
              onPress={() => runImport(p)}
              style={[s.tile, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
              activeOpacity={0.85}
            >
              <View style={[s.tileIcon, { backgroundColor: p.color + '22' }]}>
                <IconMail size={20} color={p.color} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[s.tileLabel, { color: colors.text }]}>{p.label}</Text>
                <Text style={[s.tileDesc, { color: colors.textTertiary }]}>{p.description}</Text>
              </View>
              {isActive && importing && <ActivityIndicator color={p.color} />}
            </TouchableOpacity>
          );
        })}

        {importing && activeProvider && (
          <View style={[s.progressCard, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
            <Text style={[s.progressLabel, { color: colors.text }]}>
              {t('emailImport.progress', { fetched: progress.fetched, max: progress.max })
                || `Importando: ${progress.fetched} de ${progress.max} emails`}
            </Text>
            <View style={[s.progressBar, { backgroundColor: colors.borderLight }]}>
              <View style={[s.progressFill, { width: `${pct}%`, backgroundColor: activeProvider.color }]} />
            </View>
            <Text style={[s.progressMeta, { color: colors.textTertiary }]}>
              {progress.imported} entregues · {pct}%
            </Text>
          </View>
        )}

        {done && (
          <View style={[s.doneCard, { backgroundColor: '#10b98122', borderColor: '#10b981' }]}>
            <IconCheck size={20} color="#10b981" />
            <Text style={{ color: '#10b981', fontWeight: '700', marginLeft: 8 }}>
              {t('emailImport.done') || 'Import concluído'} — {progress.imported} emails na sua caixa.
            </Text>
          </View>
        )}

        {!!error && (
          <View style={[s.errCard, { backgroundColor: '#ef444422', borderColor: '#ef4444' }]}>
            <IconAlertTriangle size={20} color="#ef4444" />
            <Text style={{ color: '#ef4444', marginLeft: 8, flex: 1 }}>{error}</Text>
          </View>
        )}

        {history.length > 0 && (
          <>
            <Text style={[s.sectionTitle, { color: colors.textSecondary }]}>
              {t('emailImport.history') || 'Imports recentes'}
            </Text>
            {history.map(h => (
              <View key={h.id} style={[s.histRow, { borderBottomColor: colors.borderLight }]}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontWeight: '600' }}>{h.provider === 'gmail' ? 'Gmail' : 'Outlook'}</Text>
                  <Text style={{ color: colors.textTertiary, fontSize: FontSize.xs }}>
                    {h.imported} / {h.max_emails} · {h.status}
                  </Text>
                </View>
                <Text style={{ color: colors.textTertiary, fontSize: FontSize.xs }}>
                  {new Date(h.created_at).toLocaleDateString()}
                </Text>
              </View>
            ))}
            <TouchableOpacity onPress={loadHistory} style={s.refreshBtn}>
              <IconRefresh size={14} color={colors.textSecondary} />
              <Text style={{ color: colors.textSecondary, marginLeft: 6, fontSize: FontSize.sm }}>
                {t('common.refresh') || 'Atualizar'}
              </Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  subtitle: { fontSize: FontSize.sm, lineHeight: 20, marginBottom: Spacing.lg },
  tile: {
    flexDirection: 'row', alignItems: 'center',
    padding: Spacing.md, borderRadius: BorderRadius.lg,
    borderWidth: 1, marginBottom: Spacing.sm,
  },
  tileIcon: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: 'center', justifyContent: 'center',
    marginRight: Spacing.md,
  },
  tileLabel: { fontSize: FontSize.md, fontWeight: '700' },
  tileDesc: { fontSize: FontSize.xs, marginTop: 2 },
  progressCard: {
    padding: Spacing.md, borderRadius: BorderRadius.lg,
    borderWidth: 1, marginTop: Spacing.md,
  },
  progressLabel: { fontWeight: '700', fontSize: FontSize.sm, marginBottom: 8 },
  progressBar: { height: 8, borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 4 },
  progressMeta: { fontSize: FontSize.xs, marginTop: 8 },
  doneCard: {
    flexDirection: 'row', alignItems: 'center',
    padding: Spacing.md, borderRadius: BorderRadius.lg,
    borderWidth: 1, marginTop: Spacing.md,
  },
  errCard: {
    flexDirection: 'row', alignItems: 'center',
    padding: Spacing.md, borderRadius: BorderRadius.lg,
    borderWidth: 1, marginTop: Spacing.md,
  },
  sectionTitle: {
    marginTop: Spacing.xl, marginBottom: Spacing.sm,
    fontSize: FontSize.xs, fontWeight: '700', textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  histRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1,
  },
  refreshBtn: {
    flexDirection: 'row', alignItems: 'center',
    alignSelf: 'flex-start', paddingVertical: 8, marginTop: 8,
  },
});
