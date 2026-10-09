// OwnBackupCard — "Backup no Chatyy": backup E2E das conversas no servidor do
// Chatyy (services/ownBackup.js). Primeiro bloco da tela /chat-backup.
// [2026-10-09 own-backup] Preto e branco, ícones SVG, textos via t().
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Switch, ActivityIndicator, StyleSheet, Platform, Alert } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing } from '../constants/theme';
import { IconCloudUpload, IconKey, IconLock, IconTrash, IconCopy, IconEyeOff, IconAlertTriangle, IconCheck } from './Icons';
import * as ownBackup from '../services/ownBackup';

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T').replace(/\+00$/, 'Z'));
  if (Number.isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function errorText(t, e) {
  const c = e?.code || e;
  const map = {
    ERR_NETWORK: 'ownBackup.errNetwork', ERR_QUOTA: 'ownBackup.errQuota', ERR_AUTH: 'ownBackup.errAuth',
    ERR_BAD_PASSWORD: 'ownBackup.errBadPassword', ERR_BAD_KEY: 'ownBackup.errBadKey', ERR_LOCKED: 'ownBackup.errLocked',
    ERR_PASSWORD_SHORT: 'ownBackup.errPasswordShort', ERR_BUSY: 'ownBackup.errBusy', ERR_NOT_SETUP: 'ownBackup.errNotSetup',
  };
  return t(map[c] || 'ownBackup.errGeneric');
}

async function confirmAsync(title, msg, okLabel, cancelLabel) {
  if (Platform.OS === 'web') {
    try { return !!globalThis.confirm?.(`${title}\n\n${msg}`); } catch { return false; }
  }
  return new Promise((resolve) => {
    Alert.alert(title, msg, [
      { text: cancelLabel, style: 'cancel', onPress: () => resolve(false) },
      { text: okLabel, style: 'destructive', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

export function ProgressBar({ progress, colors, t }) {
  if (!progress || progress.phase === 'done' || progress.phase === 'error') return null;
  const pct = progress.total ? Math.max(0.03, Math.min(1, (progress.done || 0) / progress.total)) : 0.05;
  const label = {
    scan: t('ownBackup.phaseScan'), upload: t('ownBackup.phaseUpload'), commit: t('ownBackup.phaseCommit'),
    restore: t('ownBackup.phaseRestore'),
  }[progress.phase] || t('ownBackup.phaseScan');
  return (
    <View style={{ marginTop: Spacing.md }} testID="ownbk-progress">
      <View style={[st.barTrack, { backgroundColor: colors.border }]}>
        <View style={[st.barFill, { backgroundColor: colors.text, width: `${Math.round(pct * 100)}%` }]} />
      </View>
      <Text style={[st.small, { color: colors.textSecondary }]}>
        {label}{progress.total ? ` · ${progress.done || 0}/${progress.total}` : ''}
      </Text>
    </View>
  );
}

function Btn({ label, onPress, colors, primary, disabled, icon, testID }) {
  const fg = primary ? colors.background : colors.text;
  return (
    <TouchableOpacity
      testID={testID}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[st.btn, primary ? { backgroundColor: colors.text } : { borderColor: colors.text, borderWidth: 1 }, disabled && { opacity: 0.45 }]}
    >
      {icon ? React.createElement(icon, { size: 16, color: fg }) : null}
      <Text style={[st.btnText, { color: fg }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Toggle({ label, desc, value, onChange, colors, testID }) {
  return (
    <View style={st.toggleRow}>
      <View style={{ flex: 1, paddingRight: Spacing.md }}>
        <Text style={[st.body, { color: colors.text }]}>{label}</Text>
        {desc ? <Text style={[st.small, { color: colors.textSecondary }]}>{desc}</Text> : null}
      </View>
      <Switch
        testID={testID}
        value={!!value}
        onValueChange={onChange}
        trackColor={{ true: colors.text, false: colors.border }}
        thumbColor={colors.background}
      />
    </View>
  );
}

export default function OwnBackupCard() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [setUp, setSetUp] = useState(false);
  const [prefs, setPrefsState] = useState(null);
  const [info, setInfo] = useState({ sets: [], hasPassword: false, quota: null });
  const [progress, setProgress] = useState(ownBackup.getProgress());
  const [busy, setBusy] = useState(null); // 'backup' | 'setup' | 'unlock' | 'delete' | 'password'
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [mode, setMode] = useState(null); // setup: 'key' | 'password' | 'unlock' | 'changePassword'
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [shownKey, setShownKey] = useState(null);
  const [keyAck, setKeyAck] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([ownBackup.isSetUp(), ownBackup.getPrefs()]);
      setSetUp(s); setPrefsState(p);
      try { setInfo(await ownBackup.listBackups()); } catch {}
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => ownBackup.subscribe((p) => {
    setProgress(p);
    if (p?.phase === 'done' || p?.phase === 'error') refresh();
  }), [refresh]);

  const latest = info.sets?.[0] || null;
  const running = !!progress && progress.phase !== 'done' && progress.phase !== 'error';

  const doBackup = useCallback(async () => {
    setError(null); setNotice(null); setBusy('backup');
    try {
      const r = await ownBackup.runBackup({ manual: true });
      setNotice(t('ownBackup.doneNotice', { n: r.msg_count, size: fmtBytes(r.uploaded_bytes) }));
    } catch (e) { setError(errorText(t, e)); }
    finally { setBusy(null); refresh(); }
  }, [t, refresh]);

  const doSetup = useCallback(async (m) => {
    setError(null);
    if (m === 'password') {
      if (pw.length < 8) { setError(t('ownBackup.errPasswordShort')); return; }
      if (pw !== pw2) { setError(t('ownBackup.errPasswordMismatch')); return; }
    }
    setBusy('setup');
    try {
      const r = await ownBackup.setupBackupKey({ mode: m, password: m === 'password' ? pw : undefined });
      setPw(''); setPw2('');
      setShownKey(r.recoveryKey); setKeyAck(m === 'password');
      setMode(null);
      await refresh();
    } catch (e) { setError(errorText(t, e)); }
    finally { setBusy(null); }
  }, [pw, pw2, t, refresh]);

  const doUnlock = useCallback(async (andRestore) => {
    if (!latest) return;
    setError(null); setBusy('unlock');
    try {
      const isKey = !!ownBackup.parseRecoveryKey(keyInput);
      const u = await ownBackup.unlockBackup({ uid: latest.uid, manifest: latest.manifest, password: isKey ? undefined : keyInput, recoveryKey: isKey ? keyInput : undefined });
      setKeyInput('');
      if (andRestore) {
        const r = await ownBackup.restoreBackup(latest.uid, { manifest: u.manifest });
        setNotice(t('ownBackup.restoredNotice', { n: r.restored }));
      } else setNotice(t('ownBackup.unlockedNotice'));
      setMode(null);
      await refresh();
    } catch (e) {
      const left = e?.attemptsLeft;
      setError(errorText(t, e) + (left != null && e?.code === 'ERR_BAD_PASSWORD' ? ` ${t('ownBackup.attemptsLeft', { n: left })}` : ''));
    } finally { setBusy(null); }
  }, [latest, keyInput, t, refresh]);

  const doChangePassword = useCallback(async () => {
    setError(null);
    if (pw.length < 8) { setError(t('ownBackup.errPasswordShort')); return; }
    if (pw !== pw2) { setError(t('ownBackup.errPasswordMismatch')); return; }
    setBusy('password');
    try { await ownBackup.setBackupPassword(pw); setPw(''); setPw2(''); setMode(null); setNotice(t('ownBackup.passwordSaved')); await refresh(); }
    catch (e) { setError(errorText(t, e)); }
    finally { setBusy(null); }
  }, [pw, pw2, t, refresh]);

  const doDelete = useCallback(async () => {
    const ok = await confirmAsync(t('ownBackup.deleteTitle'), t('ownBackup.deleteBody'), t('ownBackup.deleteConfirm'), t('common.cancel'));
    if (!ok) return;
    setBusy('delete'); setError(null);
    try { await ownBackup.deleteAllBackups(); setNotice(t('ownBackup.deletedNotice')); await refresh(); }
    catch (e) { setError(errorText(t, e)); }
    finally { setBusy(null); }
  }, [t, refresh]);

  const startOver = useCallback(async () => {
    const ok = await confirmAsync(t('ownBackup.startOverTitle'), t('ownBackup.startOverBody'), t('ownBackup.startOverConfirm'), t('common.cancel'));
    if (ok) setMode('key');
  }, [t]);

  const showKey = useCallback(async () => {
    if (shownKey) { setShownKey(null); return; }
    setShownKey(await ownBackup.getRecoveryKey()); setKeyAck(true);
  }, [shownKey]);

  const copyKey = useCallback(async () => {
    try { await require('expo-clipboard').setStringAsync(ownBackup.formatRecoveryKey(shownKey)); setNotice(t('ownBackup.keyCopied')); } catch {}
  }, [shownKey, t]);

  const setPref = useCallback(async (patch) => {
    const next = await ownBackup.setPrefs(patch);
    if (next) setPrefsState(next);
  }, []);

  const quotaLine = useMemo(() => {
    const q = info.quota;
    if (!q) return null;
    return t('ownBackup.quotaLine', { used: fmtBytes(q.backup_used), limit: q.storage_limit ? fmtBytes(q.storage_limit) : '∞' });
  }, [info.quota, t]);

  const input = (props) => (
    <TextInput
      autoCapitalize="none"
      autoCorrect={false}
      placeholderTextColor={colors.textSecondary}
      style={[st.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
      {...props}
    />
  );

  return (
    <View style={[st.card, { backgroundColor: colors.surface, borderColor: colors.border }]} testID="ownbk-card">
      <View style={st.row}>
        <IconCloudUpload size={20} color={colors.text} />
        <Text style={[st.title, { color: colors.text }]}>{t('ownBackup.title')}</Text>
      </View>
      <View style={[st.row, { marginTop: 6, alignItems: 'flex-start' }]}>
        <IconLock size={14} color={colors.textSecondary} style={{ marginTop: 2 }} />
        <Text style={[st.small, { color: colors.textSecondary, flex: 1 }]}>{t('ownBackup.subtitle')}</Text>
      </View>

      {loading ? <ActivityIndicator color={colors.text} style={{ marginTop: Spacing.md }} /> : null}

      {!loading && setUp ? (
        <View style={{ marginTop: Spacing.md }}>
          <Text style={[st.body, { color: colors.text }]} testID="ownbk-last">
            {latest
              ? t('ownBackup.lastBackup', { date: fmtDate(latest.created_at), n: latest.msg_count, size: fmtBytes(latest.size_bytes) })
              : t('ownBackup.noBackupYet')}
          </Text>
          {quotaLine ? <Text style={[st.small, { color: colors.textSecondary }]}>{quotaLine}</Text> : null}
          <ProgressBar progress={running ? progress : null} colors={colors} t={t} />
          <View style={{ marginTop: Spacing.md }}>
            <Btn testID="ownbk-backup-now" primary colors={colors} icon={IconCloudUpload}
              label={running || busy === 'backup' ? t('ownBackup.backingUp') : t('ownBackup.backupNow')}
              disabled={running || !!busy} onPress={doBackup} />
          </View>
          <View style={{ marginTop: Spacing.md }}>
            <Toggle testID="ownbk-auto" colors={colors} label={t('ownBackup.autoDaily')} desc={t('ownBackup.autoDailyDesc')}
              value={prefs?.auto} onChange={(v) => setPref({ auto: v })} />
            <Toggle testID="ownbk-cellular" colors={colors} label={t('ownBackup.useCellular')} desc={t('ownBackup.useCellularDesc')}
              value={prefs?.allowCellular} onChange={(v) => setPref({ allowCellular: v })} />
            <Toggle testID="ownbk-media" colors={colors} label={t('ownBackup.includeMedia')} desc={t('ownBackup.includeMediaDesc')}
              value={prefs?.includeMedia} onChange={(v) => setPref({ includeMedia: v })} />
          </View>
          <View style={[st.row, { marginTop: Spacing.md, flexWrap: 'wrap', gap: 8 }]}>
            <Btn testID="ownbk-show-key" colors={colors} icon={shownKey ? IconEyeOff : IconKey}
              label={shownKey ? t('ownBackup.hideKey') : t('ownBackup.showKey')} onPress={showKey} />
            <Btn testID="ownbk-password" colors={colors} icon={IconLock}
              label={info.hasPassword ? t('ownBackup.changePassword') : t('ownBackup.setPassword')}
              onPress={() => setMode(mode === 'changePassword' ? null : 'changePassword')} />
            {info.sets?.length ? (
              <Btn testID="ownbk-delete" colors={colors} icon={IconTrash} label={t('ownBackup.deleteAll')}
                disabled={!!busy || running} onPress={doDelete} />
            ) : null}
          </View>
          {mode === 'changePassword' ? (
            <View style={{ marginTop: Spacing.md }}>
              <Text style={[st.small, { color: colors.textSecondary }]}>{t('ownBackup.passwordHint')}</Text>
              {input({ value: pw, onChangeText: setPw, secureTextEntry: true, placeholder: t('ownBackup.passwordPlaceholder'), testID: 'ownbk-pw1' })}
              {input({ value: pw2, onChangeText: setPw2, secureTextEntry: true, placeholder: t('ownBackup.passwordConfirm'), testID: 'ownbk-pw2' })}
              <Btn testID="ownbk-pw-save" primary colors={colors} label={t('ownBackup.savePassword')} disabled={busy === 'password'} onPress={doChangePassword} />
            </View>
          ) : null}
        </View>
      ) : null}

      {!loading && !setUp && latest && mode !== 'key' && mode !== 'password' ? (
        <View style={{ marginTop: Spacing.md }}>
          <Text style={[st.body, { color: colors.text }]}>
            {t('ownBackup.foundOther', { date: fmtDate(latest.created_at), n: latest.msg_count })}
          </Text>
          <Text style={[st.small, { color: colors.textSecondary }]}>
            {info.hasPassword ? t('ownBackup.unlockHintPassword') : t('ownBackup.unlockHintKey')}
          </Text>
          {input({ value: keyInput, onChangeText: setKeyInput, secureTextEntry: info.hasPassword && !ownBackup.parseRecoveryKey(keyInput),
            placeholder: info.hasPassword ? t('ownBackup.passwordOrKey') : t('ownBackup.keyPlaceholder'), testID: 'ownbk-unlock-input' })}
          <ProgressBar progress={running ? progress : null} colors={colors} t={t} />
          <View style={[st.row, { flexWrap: 'wrap', gap: 8 }]}>
            <Btn testID="ownbk-restore" primary colors={colors} label={t('ownBackup.restoreNow')} disabled={!keyInput || !!busy} onPress={() => doUnlock(true)} />
            <Btn testID="ownbk-unlock" colors={colors} label={t('ownBackup.unlockOnly')} disabled={!keyInput || !!busy} onPress={() => doUnlock(false)} />
          </View>
          <TouchableOpacity onPress={startOver} style={{ marginTop: Spacing.sm }} testID="ownbk-start-over">
            <Text style={[st.link, { color: colors.text }]}>{t('ownBackup.startOver')}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {!loading && !setUp && (!latest || mode === 'key' || mode === 'password') ? (
        <View style={{ marginTop: Spacing.md }}>
          <Text style={[st.body, { color: colors.text }]}>{t('ownBackup.setupIntro')}</Text>
          {mode === 'password' ? (
            <View style={{ marginTop: Spacing.sm }}>
              <Text style={[st.small, { color: colors.textSecondary }]}>{t('ownBackup.passwordHint')}</Text>
              {input({ value: pw, onChangeText: setPw, secureTextEntry: true, placeholder: t('ownBackup.passwordPlaceholder'), testID: 'ownbk-setup-pw1' })}
              {input({ value: pw2, onChangeText: setPw2, secureTextEntry: true, placeholder: t('ownBackup.passwordConfirm'), testID: 'ownbk-setup-pw2' })}
              <Btn testID="ownbk-setup-pw-go" primary colors={colors} icon={IconLock} label={t('ownBackup.setupWithPassword')} disabled={busy === 'setup'} onPress={() => doSetup('password')} />
            </View>
          ) : (
            <View style={[st.row, { marginTop: Spacing.sm, flexWrap: 'wrap', gap: 8 }]}>
              <Btn testID="ownbk-setup-password" primary colors={colors} icon={IconLock} label={t('ownBackup.setupWithPassword')} onPress={() => setMode('password')} />
              <Btn testID="ownbk-setup-key" colors={colors} icon={IconKey} label={t('ownBackup.setupWithKey')} disabled={busy === 'setup'} onPress={() => doSetup('key')} />
            </View>
          )}
        </View>
      ) : null}

      {shownKey ? (
        <View style={[st.keyBox, { borderColor: colors.text }]} testID="ownbk-key-box">
          <Text style={[st.small, { color: colors.textSecondary }]}>{t('ownBackup.keyExplain')}</Text>
          <Text selectable style={[st.keyText, { color: colors.text }]} testID="ownbk-key-text">{ownBackup.formatRecoveryKey(shownKey)}</Text>
          <View style={[st.row, { gap: 8, flexWrap: 'wrap' }]}>
            <Btn colors={colors} icon={IconCopy} label={t('ownBackup.copyKey')} onPress={copyKey} />
            {!keyAck ? (
              <Btn testID="ownbk-key-ack" primary colors={colors} icon={IconCheck} label={t('ownBackup.keySaved')} onPress={() => { setKeyAck(true); setShownKey(null); }} />
            ) : null}
          </View>
        </View>
      ) : null}

      {notice ? <Text style={[st.small, { color: colors.text, marginTop: Spacing.sm }]} testID="ownbk-notice">{notice}</Text> : null}
      {error ? (
        <View style={[st.row, { marginTop: Spacing.sm }]} testID="ownbk-error">
          <IconAlertTriangle size={14} color={colors.text} />
          <Text style={[st.small, { color: colors.text, flex: 1 }]}>{error}</Text>
        </View>
      ) : null}
      {!loading && setUp && prefs?.lastError && !running && !error ? (
        <Text style={[st.small, { color: colors.textSecondary, marginTop: Spacing.sm }]}>
          {t('ownBackup.lastFailed', { date: fmtDate(prefs.lastErrorAt) })}
        </Text>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: BorderRadius.lg || 12, padding: Spacing.lg, marginBottom: Spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: FontSize.lg || 17, fontWeight: '700' },
  body: { fontSize: FontSize.md || 15, lineHeight: 21 },
  small: { fontSize: FontSize.sm || 13, lineHeight: 18, marginTop: 4 },
  link: { fontSize: FontSize.sm || 13, textDecorationLine: 'underline' },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 11, paddingHorizontal: 16, borderRadius: BorderRadius.md || 10, marginTop: 6 },
  btnText: { fontSize: FontSize.md || 15, fontWeight: '600' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  input: { borderWidth: 1, borderRadius: BorderRadius.md || 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: FontSize.md || 15, marginTop: 8, marginBottom: 4 },
  barTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3 },
  keyBox: { borderWidth: 1, borderRadius: BorderRadius.md || 10, padding: Spacing.md, marginTop: Spacing.md },
  keyText: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 15, letterSpacing: 1, lineHeight: 24, marginVertical: 8 },
});
