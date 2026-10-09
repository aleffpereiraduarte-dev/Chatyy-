// [2026-10-09 per-user-vault] Cofre do Drive — pasta privada por pessoa,
// arquivos cifrados no aparelho (services/driveVault.js). Mesma senha/chave de
// 64 dígitos do backup das conversas. Preto e branco, ícones SVG, textos t().
// Atrás de flag no servidor (DRIVE_VAULT): fora dela a tela só avisa.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator, Platform, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { BorderRadius, FontSize, Spacing } from '../constants/theme';
import {
  IconArrowLeft, IconLock, IconUpload, IconTrash, IconSearch, IconFile, IconKey, IconShield, IconCopy,
} from '../components/Icons';
import { fmtBytes, fmtDate } from '../components/OwnBackupCard';
import * as vault from '../services/driveVault';
import * as ownBackup from '../services/ownBackup';

function errKey(e) {
  const c = e?.code || e;
  return ({
    ERR_NETWORK: 'vault.errNetwork', ERR_QUOTA: 'vault.errQuota', ERR_AUTH: 'vault.errAuth',
    ERR_BAD_PASSWORD: 'vault.errBadPassword', ERR_BAD_KEY: 'vault.errBadKey', ERR_LOCKED: 'vault.errLockedVault',
    ERR_PASSWORD_SHORT: 'vault.errPasswordShort', ERR_TOO_BIG: 'vault.errTooBig', ERR_DISABLED: 'vault.unavailable',
    ERR_DECRYPT: 'vault.errDecrypt', ERR_CORRUPT: 'vault.errDecrypt',
  })[c] || 'vault.errGeneric';
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

export default function DriveVaultScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const email = String(user?.email || '').toLowerCase() || undefined;

  const [phase, setPhase] = useState('loading'); // loading | off | setup | unlock | showKey | ready | error
  const [status, setStatus] = useState(null);
  const [files, setFiles] = useState([]);
  const [quota, setQuota] = useState(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(null); // { label, pct }
  const [msg, setMsg] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [useKey, setUseKey] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; vault.wipeTemp(); }, []);

  const reload = useCallback(async () => {
    const r = await vault.listFiles(email);
    if (!mounted.current) return;
    setFiles(r.files);
    setQuota(r.quota);
  }, [email]);

  const boot = useCallback(async () => {
    setMsg('');
    try {
      const s = await vault.getStatus();
      if (!mounted.current) return;
      setStatus(s);
      if (!s?.enabled) { setPhase('off'); return; }
      await vault.wipeTemp();
      if (await vault.hasKey(email)) { await reload(); if (mounted.current) setPhase('ready'); return; }
      setPhase(s.count > 0 || s.has_password_vault ? 'unlock' : 'setup');
    } catch (e) {
      if (!mounted.current) return;
      if (e?.code === 'ERR_DISABLED') { setPhase('off'); return; }
      setMsg(t(errKey(e))); setPhase('error');
    }
  }, [email, reload, t]);
  useEffect(() => { boot(); }, [boot]);

  const doSetup = useCallback(async () => {
    setMsg('');
    if (pw.length < 8) { setMsg(t('vault.errPasswordShort')); return; }
    if (pw !== pw2) { setMsg(t('vault.errPasswordMismatch')); return; }
    setBusy({ label: t('vault.working') });
    try {
      const r = await vault.setupWithPassword(pw, email);
      if (!mounted.current) return;
      setRecoveryKey(r?.recoveryKey || '');
      setPw(''); setPw2('');
      setPhase('showKey');
    } catch (e) { if (mounted.current) setMsg(t(errKey(e))); }
    finally { if (mounted.current) setBusy(null); }
  }, [pw, pw2, email, t]);

  const doUnlock = useCallback(async () => {
    setMsg('');
    setBusy({ label: t('vault.working') });
    try {
      await vault.unlock(useKey ? { recoveryKey: keyInput } : { password: pw }, email);
      if (!mounted.current) return;
      setPw(''); setKeyInput('');
      await reload();
      if (mounted.current) setPhase('ready');
    } catch (e) {
      if (!mounted.current) return;
      const left = e?.attemptsLeft;
      setMsg(t(errKey(e)) + (left != null && e?.code === 'ERR_BAD_PASSWORD' ? ` ${t('vault.attemptsLeft').replace('{n}', String(left))}` : ''));
    } finally { if (mounted.current) setBusy(null); }
  }, [useKey, keyInput, pw, email, reload, t]);

  const uploadList = useCallback(async (list) => {
    setMsg('');
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const label = `${t('vault.encrypting')} ${list.length > 1 ? `${i + 1}/${list.length} ` : ''}· ${f.name || ''}`;
      setBusy({ label, pct: 0 });
      try {
        await vault.uploadFile(f, { name: f.name, mimeType: f.mimeType || f.type, onProgress: (p) => mounted.current && setBusy({ label, pct: p }) }, email);
      } catch (e) {
        if (mounted.current) setMsg(`${f.name || ''}: ${t(errKey(e))}`);
        break;
      }
    }
    try { await reload(); } catch {}
    if (mounted.current) setBusy(null);
  }, [email, reload, t]);

  const pickAndUpload = useCallback(async () => {
    if (busy) return;
    if (Platform.OS === 'web') {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.onchange = (e) => { const l = Array.from(e.target.files || []); if (l.length) uploadList(l); };
      input.click();
      return;
    }
    try {
      const DocumentPicker = require('expo-document-picker');
      const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (r.canceled || !r.assets?.length) return;
      await uploadList(r.assets.map((a) => ({ uri: a.uri, name: a.name, mimeType: a.mimeType, size: a.size })));
    } catch (e) { if (mounted.current) setMsg(t(errKey(e))); }
  }, [busy, uploadList, t]);

  const openItem = useCallback(async (f) => {
    if (busy) return;
    if (f.locked) { setMsg(t('vault.itemLocked')); return; }
    setMsg('');
    const label = `${t('vault.decrypting')} · ${f.name}`;
    setBusy({ label, pct: 0 });
    try { await vault.openFile(f, { onProgress: (p) => mounted.current && setBusy({ label, pct: p }) }); }
    catch (e) { if (mounted.current) setMsg(t(errKey(e))); }
    finally { if (mounted.current) setBusy(null); }
  }, [busy, t]);

  const deleteItem = useCallback(async (f) => {
    const ok = await confirmAsync(t('vault.deleteTitle'), t('vault.deleteMsg').replace('{name}', f.name || t('vault.lockedName')), t('vault.delete'), t('common.cancel'));
    if (!ok) return;
    setBusy({ label: t('vault.working') });
    try { await vault.deleteFile(f.item); await reload(); }
    catch (e) { if (mounted.current) setMsg(t(errKey(e))); }
    finally { if (mounted.current) setBusy(null); }
  }, [reload, t]);

  const copyKey = useCallback(async () => {
    try {
      const Clipboard = require('expo-clipboard');
      await Clipboard.setStringAsync(recoveryKey);
      setMsg(t('vault.keyCopied'));
    } catch {}
  }, [recoveryKey, t]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => String(f.name || '').toLowerCase().includes(q));
  }, [files, query]);

  const input = [st.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }];

  const header = (
    <View style={[st.header, { borderBottomColor: colors.border, paddingTop: Platform.OS === 'web' ? Spacing.md : insets.top + Spacing.sm }]}>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('common.back')} onPress={() => (router.canGoBack() ? router.back() : router.replace('/drive'))} style={st.iconBtn} testID="vault-back">
        <IconArrowLeft size={22} color={colors.text} />
      </TouchableOpacity>
      <Text style={[st.title, { color: colors.text }]} numberOfLines={1}>{t('vault.title')}</Text>
      {phase === 'ready' ? (
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('vault.add')} onPress={pickAndUpload} style={st.iconBtn} disabled={!!busy} testID="vault-upload">
          <IconUpload size={22} color={colors.text} />
        </TouchableOpacity>
      ) : <View style={st.iconBtn} />}
    </View>
  );

  const busyBar = busy ? (
    <View style={st.busy} testID="vault-busy">
      <View style={[st.barTrack, { backgroundColor: colors.border }]}>
        <View style={[st.barFill, { backgroundColor: colors.text, width: `${Math.round(Math.max(0.04, busy.pct || 0.04) * 100)}%` }]} />
      </View>
      <Text style={[st.small, { color: colors.textSecondary }]} numberOfLines={1}>{busy.label}</Text>
    </View>
  ) : null;

  const message = msg ? <Text style={[st.msg, { color: colors.text }]} testID="vault-msg">{msg}</Text> : null;

  let body = null;
  if (phase === 'loading') {
    body = <View style={st.center}><ActivityIndicator color={colors.text} /></View>;
  } else if (phase === 'off' || phase === 'error') {
    body = (
      <View style={st.pad}>
        <IconLock size={32} color={colors.text} />
        <Text style={[st.h2, { color: colors.text }]}>{phase === 'off' ? t('vault.unavailable') : t('vault.errGeneric')}</Text>
        {message}
        {phase === 'error' ? <Btn label={t('vault.retry')} onPress={boot} colors={colors} /> : null}
      </View>
    );
  } else if (phase === 'setup') {
    body = (
      <View style={st.pad} testID="vault-setup">
        <IconShield size={32} color={colors.text} />
        <Text style={[st.h2, { color: colors.text }]}>{t('vault.setupTitle')}</Text>
        <Text style={[st.p, { color: colors.textSecondary }]}>{t('vault.explain')}</Text>
        <Text style={[st.p, { color: colors.textSecondary }]}>{t('vault.setupBody')}</Text>
        <TextInput testID="vault-pw" style={input} value={pw} onChangeText={setPw} secureTextEntry placeholder={t('vault.password')} placeholderTextColor={colors.textSecondary} autoCapitalize="none" />
        <TextInput testID="vault-pw2" style={input} value={pw2} onChangeText={setPw2} secureTextEntry placeholder={t('vault.passwordConfirm')} placeholderTextColor={colors.textSecondary} autoCapitalize="none" />
        <Text style={[st.small, { color: colors.textSecondary }]}>{t('vault.noRecoveryWarning')}</Text>
        {message}
        {busyBar}
        <Btn testID="vault-setup-btn" label={t('vault.create')} onPress={doSetup} colors={colors} primary disabled={!!busy} icon={IconLock} />
      </View>
    );
  } else if (phase === 'unlock') {
    body = (
      <View style={st.pad} testID="vault-unlock">
        <IconKey size={32} color={colors.text} />
        <Text style={[st.h2, { color: colors.text }]}>{t('vault.unlockTitle')}</Text>
        <Text style={[st.p, { color: colors.textSecondary }]}>{t('vault.unlockBody')}</Text>
        {useKey ? (
          <TextInput testID="vault-key" style={[input, { minHeight: 64 }]} value={keyInput} onChangeText={setKeyInput} placeholder={t('vault.recoveryKey')} placeholderTextColor={colors.textSecondary} autoCapitalize="none" multiline />
        ) : (
          <TextInput testID="vault-pw" style={input} value={pw} onChangeText={setPw} secureTextEntry placeholder={t('vault.password')} placeholderTextColor={colors.textSecondary} autoCapitalize="none" />
        )}
        {message}
        {busyBar}
        <Btn testID="vault-unlock-btn" label={t('vault.unlock')} onPress={doUnlock} colors={colors} primary disabled={!!busy} icon={IconLock} />
        <TouchableOpacity onPress={() => { setUseKey((v) => !v); setMsg(''); }} style={{ marginTop: Spacing.md }} testID="vault-toggle-key">
          <Text style={[st.link, { color: colors.text }]}>{useKey ? t('vault.usePassword') : t('vault.useKey')}</Text>
        </TouchableOpacity>
        {status?.has_password_vault ? null : <Text style={[st.small, { color: colors.textSecondary }]}>{t('vault.noPasswordVault')}</Text>}
      </View>
    );
  } else if (phase === 'showKey') {
    body = (
      <View style={st.pad} testID="vault-showkey">
        <IconKey size={32} color={colors.text} />
        <Text style={[st.h2, { color: colors.text }]}>{t('vault.keyTitle')}</Text>
        <Text style={[st.p, { color: colors.textSecondary }]}>{t('vault.keyBody')}</Text>
        <Text selectable style={[st.key, { color: colors.text, borderColor: colors.border }]}>{ownBackup.formatRecoveryKey(recoveryKey)}</Text>
        {message}
        <Btn label={t('vault.copyKey')} onPress={copyKey} colors={colors} icon={IconCopy} />
        <View style={{ height: Spacing.sm }} />
        <Btn testID="vault-keydone" label={t('vault.keySaved')} onPress={async () => { setMsg(''); try { await reload(); } catch {} setPhase('ready'); }} colors={colors} primary />
      </View>
    );
  } else {
    const used = quota?.vault_used || 0;
    body = (
      <View style={{ flex: 1 }}>
        <View style={[st.banner, { borderColor: colors.border }]}>
          <IconLock size={16} color={colors.text} />
          <Text style={[st.small, { color: colors.textSecondary, flex: 1, marginTop: 0 }]}>{t('vault.explain')}</Text>
        </View>
        <View style={[st.search, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <IconSearch size={16} color={colors.textSecondary} />
          <TextInput testID="vault-search" value={query} onChangeText={setQuery} placeholder={t('vault.searchLocal')} placeholderTextColor={colors.textSecondary} style={[st.searchInput, { color: colors.text }]} autoCapitalize="none" />
        </View>
        <Text style={[st.small, { color: colors.textSecondary, paddingHorizontal: Spacing.lg }]} testID="vault-usage">
          {t('vault.usage').replace('{n}', String(files.length)).replace('{size}', fmtBytes(used))}
        </Text>
        {busyBar}
        {message}
        <FlatList
          data={shown}
          keyExtractor={(f) => f.item}
          contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
          ListEmptyComponent={(
            <View style={st.pad}>
              <Text style={[st.p, { color: colors.textSecondary }]}>{query ? t('vault.noResults') : t('vault.empty')}</Text>
              {!query ? <Btn label={t('vault.add')} onPress={pickAndUpload} colors={colors} primary icon={IconUpload} disabled={!!busy} /> : null}
            </View>
          )}
          renderItem={({ item: f }) => (
            <TouchableOpacity testID={`vault-item-${f.item}`} onPress={() => openItem(f)} style={[st.row, { borderBottomColor: colors.border }]} accessibilityRole="button">
              {f.locked ? <IconLock size={22} color={colors.textSecondary} /> : <IconFile size={22} color={colors.text} />}
              <View style={{ flex: 1, marginLeft: Spacing.md }}>
                <Text style={[st.name, { color: colors.text }]} numberOfLines={1}>{f.locked ? t('vault.lockedName') : f.name}</Text>
                <Text style={[st.small, { color: colors.textSecondary, marginTop: 2 }]}>{`${fmtBytes(f.locked ? f.stored : f.size)} · ${fmtDate(f.createdAt)}`}</Text>
              </View>
              <TouchableOpacity onPress={() => deleteItem(f)} style={st.iconBtn} accessibilityLabel={t('vault.delete')} testID={`vault-del-${f.item}`}>
                <IconTrash size={18} color={colors.textSecondary} />
              </TouchableOpacity>
            </TouchableOpacity>
          )}
        />
      </View>
    );
  }

  return (
    <View style={[st.container, { backgroundColor: colors.background }]} testID="vault-screen">
      {header}
      {body}
    </View>
  );
}

const st = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.sm, paddingBottom: Spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: FontSize.lg, fontWeight: '700', textAlign: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pad: { padding: Spacing.lg, maxWidth: 560, width: '100%', alignSelf: 'center' },
  h2: { fontSize: FontSize.lg, fontWeight: '700', marginTop: Spacing.md, marginBottom: Spacing.sm },
  p: { fontSize: FontSize.md, lineHeight: 21, marginBottom: Spacing.md },
  small: { fontSize: FontSize.sm, marginTop: Spacing.xs },
  msg: { fontSize: FontSize.sm, marginVertical: Spacing.sm, paddingHorizontal: Spacing.lg, fontWeight: '600' },
  link: { fontSize: FontSize.sm, textDecorationLine: 'underline', textAlign: 'center' },
  input: { borderWidth: 1, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, paddingVertical: 10, fontSize: FontSize.md, marginBottom: Spacing.sm },
  key: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: FontSize.md, lineHeight: 24, borderWidth: 1, borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.md },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: BorderRadius.md, paddingVertical: 12, paddingHorizontal: Spacing.lg, marginTop: Spacing.sm },
  btnText: { fontSize: FontSize.md, fontWeight: '600' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, margin: Spacing.lg, marginBottom: Spacing.sm, padding: Spacing.md, borderWidth: 1, borderRadius: BorderRadius.md },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: Spacing.lg, paddingHorizontal: Spacing.md, borderWidth: 1, borderRadius: BorderRadius.md },
  searchInput: { flex: 1, paddingVertical: 8, fontSize: FontSize.md },
  busy: { paddingHorizontal: Spacing.lg, marginTop: Spacing.sm },
  barTrack: { height: 4, borderRadius: 2, overflow: 'hidden' },
  barFill: { height: 4 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  name: { fontSize: FontSize.md, fontWeight: '500' },
});
