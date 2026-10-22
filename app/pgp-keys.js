/**
 * /pgp-keys — Chave PGP (OpenPGP) do usuário.  [2026-10-16 pgp-v2]
 *
 * Gerar (Curve25519, senha forte com medidor), ver impressão digital + QR,
 * compartilhar/copiar a pública, testar (cifra+assina+decifra+verifica),
 * exportar/restaurar backup da privada (continua cifrada pela senha), chaves
 * de contatos e apagar. Toda a criptografia vive em services/pgp.js.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput,
  ActivityIndicator, Platform, Share,
} from 'react-native';
import SheetKeyboardAvoider from '../components/chat/SheetKeyboardAvoider'; // [2026-10-22 kb-uniforme] Android: teclado não cobre campos (edge-to-edge)
import { useRouter, Stack } from 'expo-router';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader'; // [2026-10-09 native-sheets-headers]
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { Spacing, BorderRadius, FontSize } from '../constants/theme';
import {
  IconLock, IconKey, IconTrash, IconShare, IconCheck, IconCopy, IconShield, IconEye, IconEyeOff,
  IconAlertTriangle, IconDownload, IconUpload, IconChevronRight, IconUsers, IconGrid, IconPenTool, IconX, IconCloudCheck,
} from '../components/Icons';
import ModalHeader from '../components/ModalHeader';
import FadeSlideIn from '../components/FadeSlideIn';
import PressableScale from '../components/PressableScale';
import * as Clipboard from 'expo-clipboard';
import { safeAlert } from '../services/alerts';
import { pgpKeyGet } from '../services/api';
import {
  getMyKey, generateMyKey, deleteMyKey, importPrivateBackup, publishMyKey, selfTest,
  listContactKeys, saveContactKey, removeContactKey, passphraseStrength, passphraseOk,
  formatFingerprint, isWebStorage, MIN_PASSPHRASE,
} from '../services/pgp';
import { a11yLabel } from '../utils/a11yLabel'; // [2026-10-20 a11y] rótulos dos botões só-ícone

let QRCode = null;
try { QRCode = require('react-native-qrcode-svg').default; } catch {}

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

function PassInput({ value, onChangeText, placeholder, colors, autoFocus, onSubmitEditing, testID }) {
  const [show, setShow] = useState(false);
  return (
    <View style={[s.inputWrap, { borderColor: colors.border, backgroundColor: colors.background }]}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        secureTextEntry={!show}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType="none"
        autoFocus={autoFocus}
        onSubmitEditing={onSubmitEditing}
        style={[s.inputInner, { color: colors.text }]}
        testID={testID}
      />
      <TouchableOpacity onPress={() => setShow(v => !v)} hitSlop={10} style={s.eyeBtn} accessibilityRole="button">
        {show ? <IconEyeOff size={18} color={colors.textSecondary} /> : <IconEye size={18} color={colors.textSecondary} />}
      </TouchableOpacity>
    </View>
  );
}

function StrengthMeter({ value, colors, t }) {
  const score = passphraseStrength(value);
  const labels = [t('pgp.strengthWeak'), t('pgp.strengthWeak'), t('pgp.strengthFair'), t('pgp.strengthGood'), t('pgp.strengthStrong')];
  if (!value) return null;
  return (
    <View style={s.meterRow}>
      <View style={s.meterBars}>
        {[1, 2, 3, 4].map(i => (
          <View key={i} style={[s.meterBar, { backgroundColor: i <= Math.max(1, score) ? colors.text : colors.borderLight, opacity: i <= Math.max(1, score) ? (score <= 1 ? 0.45 : 1) : 1 }]} />
        ))}
      </View>
      <Text style={[s.meterLabel, { color: score >= 2 ? colors.text : colors.textSecondary }]}>{labels[score]}</Text>
    </View>
  );
}

function ActionRow({ icon: Icon, label, hint, onPress, colors, danger, last, busy }) {
  const c = danger ? (colors.error || '#d11') : colors.text;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} disabled={busy}
      style={[s.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight }]}>
      <View style={[s.rowIcon, { backgroundColor: colors.surfaceVariant || colors.borderLight }]}>
        <Icon size={17} color={c} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[s.rowLabel, { color: c }]}>{label}</Text>
        {!!hint && <Text style={[s.rowHint, { color: colors.textTertiary }]}>{hint}</Text>}
      </View>
      {busy ? <ActivityIndicator color={colors.textSecondary} /> : <IconChevronRight size={16} color={colors.textTertiary} />}
    </TouchableOpacity>
  );
}

export default function PgpKeysScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth() || {};
  const me = String(user?.email || '').toLowerCase();

  const [loading, setLoading] = useState(true);
  const [mine, setMine] = useState(null);
  const [serverHas, setServerHas] = useState(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null); // { kind:'ok'|'err', text }
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [panel, setPanel] = useState(''); // 'restore' | 'test' | 'contact' | 'qr'
  const [restoreArmor, setRestoreArmor] = useState('');
  const [panelPass, setPanelPass] = useState('');
  const [contactArmor, setContactArmor] = useState('');
  const [contacts, setContacts] = useState({});

  const flash = useCallback((kind, text) => { setNotice({ kind, text }); }, []);
  const errText = useCallback((e) => {
    const code = e?.code || '';
    if (code === 'wrong_passphrase') return t('pgp.wrongPassphrase');
    if (code === 'invalid_key' || code === 'no_email' || code === 'is_own') return t('pgp.invalidKey');
    if (code === 'is_private') return t('pgp.privateNotAllowed');
    return t('pgp.genericError');
  }, [t]);

  const load = useCallback(async () => {
    if (!me) { setLoading(false); return; }
    try {
      const k = await getMyKey(me);
      setMine(k);
      setContacts(await listContactKeys(me));
      try {
        const r = await pgpKeyGet(me);
        if (r?.success) setServerHas(!!r.data?.found && (!k || String(r.data?.fingerprint || '').toUpperCase() === k.fingerprint));
      } catch {}
    } catch {}
    setLoading(false);
  }, [me]);
  useEffect(() => { load(); }, [load]);

  const canGenerate = passphraseOk(pass) && pass === pass2;

  const generate = useCallback(async () => {
    setNotice(null);
    if (!passphraseOk(pass)) { flash('err', t('pgp.passphraseTooWeak')); return; }
    if (pass !== pass2) { flash('err', t('pgp.passphraseMismatch')); return; }
    setBusy('generate');
    try {
      const r = await generateMyKey({ email: me, name: user?.name || me, passphrase: pass });
      setPass(''); setPass2('');
      await load();
      setServerHas(!!r.published);
      flash('ok', t('pgp.generated'));
    } catch (e) {
      flash('err', t('pgp.genericError'));
    } finally { setBusy(''); }
  }, [pass, pass2, me, user?.name, load, flash, t]);

  const sharePublic = useCallback(async () => {
    if (!mine) return;
    try {
      if (Platform.OS === 'web') {
        if (navigator?.share) { await navigator.share({ title: 'PGP — ' + me, text: mine.publicArmor }); return; }
        await Clipboard.setStringAsync(mine.publicArmor);
        flash('ok', t('pgp.publicCopied'));
        return;
      }
      await Share.share({ message: mine.publicArmor, title: 'PGP — ' + me });
    } catch {}
  }, [mine, me, flash, t]);

  const copyPublic = useCallback(async () => {
    if (!mine) return;
    try { await Clipboard.setStringAsync(mine.publicArmor); flash('ok', t('pgp.publicCopied')); } catch {}
  }, [mine, flash, t]);

  const exportBackup = useCallback(() => {
    if (!mine) return;
    safeAlert(t('pgp.backup'), t('pgp.backupHint'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('pgp.backupExport'), onPress: async () => {
        try {
          if (Platform.OS === 'web') {
            const blob = new Blob([mine.privateArmor], { type: 'application/pgp-keys' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'chatyy-pgp-backup-' + me.replace(/[^a-z0-9]+/gi, '_') + '.asc';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
          } else {
            await Share.share({ message: mine.privateArmor, title: 'Chatyy PGP backup' });
          }
        } catch {}
      } },
    ]);
  }, [mine, me, t]);

  const doRestore = useCallback(async () => {
    setNotice(null); setBusy('restore');
    try {
      await importPrivateBackup({ email: me, armored: restoreArmor, passphrase: panelPass });
      setRestoreArmor(''); setPanelPass(''); setPanel('');
      await load();
      flash('ok', t('pgp.restored'));
    } catch (e) { flash('err', errText(e)); }
    finally { setBusy(''); }
  }, [me, restoreArmor, panelPass, load, flash, errText, t]);

  const doTest = useCallback(async () => {
    setNotice(null); setBusy('test');
    try {
      const ok = await selfTest({ me, passphrase: panelPass });
      setPanelPass(''); setPanel('');
      flash(ok ? 'ok' : 'err', ok ? t('pgp.testOk') : t('pgp.genericError'));
    } catch (e) { flash('err', errText(e)); }
    finally { setBusy(''); }
  }, [me, panelPass, flash, errText, t]);

  const doPublish = useCallback(async () => {
    setBusy('publish');
    const ok = await publishMyKey(me);
    setServerHas(ok); setBusy('');
    flash(ok ? 'ok' : 'err', ok ? t('pgp.generated') : t('pgp.genericError'));
  }, [me, flash, t]);

  const doSaveContact = useCallback(async () => {
    setNotice(null); setBusy('contact');
    try {
      const r = await saveContactKey(me, contactArmor);
      setContactArmor(''); setPanel('');
      setContacts(await listContactKeys(me));
      flash('ok', t('pgp.contactSaved', { email: r.email }));
    } catch (e) { flash('err', errText(e)); }
    finally { setBusy(''); }
  }, [me, contactArmor, flash, errText, t]);

  const removeContact = useCallback((email) => {
    safeAlert(t('pgp.removeContact'), email, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('pgp.removeContact'), style: 'destructive', onPress: async () => { await removeContactKey(me, email); setContacts(await listContactKeys(me)); } },
    ]);
  }, [me, t]);

  const revoke = useCallback(() => {
    safeAlert(t('pgp.revokeConfirm'), t('pgp.revokeWarning'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('pgp.revoke'), style: 'destructive', onPress: async () => {
        await deleteMyKey(me);
        setMine(null); setServerHas(false); setPanel('');
      } },
    ]);
  }, [me, t]);

  const created = useMemo(() => {
    try { return mine?.createdAt ? new Date(mine.createdAt).toLocaleDateString() : ''; } catch { return ''; }
  }, [mine?.createdAt]);
  const contactList = Object.entries(contacts || {});

  const card = [s.card, { backgroundColor: colors.surface, borderColor: colors.borderLight }];
  const primaryBg = colors.text;
  const primaryFg = colors.background;

  const renderPanelPass = (onSubmit, label) => (
    <>
      <PassInput value={panelPass} onChangeText={setPanelPass} placeholder={t('pgp.passphraseEnter')} colors={colors} autoFocus onSubmitEditing={onSubmit} />
      <PressableScale onPress={onSubmit} disabled={!panelPass || !!busy}
        style={[s.primaryBtn, { backgroundColor: primaryBg, opacity: !panelPass || busy ? 0.5 : 1 }]}>
        {busy ? <ActivityIndicator color={primaryFg} /> : <Text style={[s.primaryBtnLabel, { color: primaryFg }]}>{label}</Text>}
      </PressableScale>
    </>
  );

  return (
    <SheetKeyboardAvoider style={[s.root, { backgroundColor: colors.background }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title: t('pgp.title') })} />
      ) : (
        <ModalHeader title={t('pgp.title')} onClose={() => router.back()} />
      )}
      <FadeSlideIn>
        <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 96 }} keyboardShouldPersistTaps="handled">
          {!!notice && (
            <TouchableOpacity onPress={() => setNotice(null)} activeOpacity={0.8}
              style={[s.notice, { borderColor: notice.kind === 'ok' ? colors.text : (colors.error || '#d11'), backgroundColor: colors.surface }]}>
              {notice.kind === 'ok' ? <IconCheck size={16} color={colors.text} /> : <IconAlertTriangle size={16} color={colors.error || '#d11'} />}
              <Text style={[s.noticeText, { color: notice.kind === 'ok' ? colors.text : (colors.error || '#d11') }]}>{notice.text}</Text>
              <IconX size={14} color={colors.textTertiary} />
            </TouchableOpacity>
          )}

          {loading ? (
            <View style={{ paddingVertical: 60, alignItems: 'center' }}><ActivityIndicator color={colors.text} /></View>
          ) : mine ? (
            <>
              {/* ── chave ativa ── */}
              <View style={card}>
                <View style={s.cardHead}>
                  <View style={[s.badge, { backgroundColor: colors.text }]}><IconShield size={18} color={colors.background} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.cardHeadTitle, { color: colors.text }]}>{t('pgp.active')}</Text>
                    <Text style={[s.meta, { color: colors.textTertiary }]}>
                      {[mine.algorithm, created ? t('pgp.createdOn', { date: created }) : ''].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                </View>
                <Text style={[s.label, { color: colors.textTertiary }]}>{t('pgp.fingerprint')}</Text>
                <Text selectable style={[s.fingerprint, { color: colors.text, backgroundColor: colors.surfaceVariant || colors.borderLight }]}>
                  {formatFingerprint(mine.fingerprint)}
                </Text>
                <View style={s.pillRow}>
                  <View style={[s.pill, { borderColor: colors.border }]}>
                    {serverHas ? <IconCloudCheck size={13} color={colors.text} /> : <IconAlertTriangle size={13} color={colors.textSecondary} />}
                    <Text style={[s.pillText, { color: serverHas ? colors.text : colors.textSecondary }]}>
                      {serverHas ? t('pgp.publishedLong') : t('pgp.notPublishedLong')}
                    </Text>
                  </View>
                  {serverHas === false && (
                    <TouchableOpacity onPress={doPublish} disabled={!!busy} hitSlop={8}>
                      <Text style={[s.link, { color: colors.text }]}>{t('pgp.publish')}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              {panel === 'qr' && (
                <View style={[card, { alignItems: 'center' }]}>
                  <View style={[s.qrBox, { backgroundColor: '#fff' }]}>
                    {QRCode ? <QRCode value={mine.publicArmor} size={232} ecl="L" color="#000" backgroundColor="#fff" /> : <IconGrid size={64} color="#000" />}
                  </View>
                  <Text style={[s.hint, { color: colors.textSecondary, textAlign: 'center', marginTop: 12 }]}>{t('pgp.qrHint')}</Text>
                </View>
              )}

              <View style={[card, { paddingVertical: 4 }]}>
                <ActionRow icon={IconShare} label={t('pgp.sharePublic')} onPress={sharePublic} colors={colors} />
                <ActionRow icon={IconCopy} label={t('pgp.copyPublic')} onPress={copyPublic} colors={colors} />
                <ActionRow icon={IconGrid} label={panel === 'qr' ? t('pgp.hideQr') : t('pgp.showQr')} onPress={() => setPanel(p => (p === 'qr' ? '' : 'qr'))} colors={colors} />
                <ActionRow icon={IconPenTool} label={t('pgp.testTitle')} hint={t('pgp.testHint')} onPress={() => { setPanelPass(''); setPanel(p => (p === 'test' ? '' : 'test')); }} colors={colors} />
                <ActionRow icon={IconDownload} label={t('pgp.backup')} hint={t('pgp.backupHint')} onPress={exportBackup} colors={colors} last />
              </View>

              {panel === 'test' && (
                <View style={card}>
                  <Text style={[s.hint, { color: colors.textSecondary, marginBottom: 10 }]}>{t('pgp.testHint')}</Text>
                  {renderPanelPass(doTest, t('pgp.testTitle'))}
                </View>
              )}
            </>
          ) : (
            <>
              {/* ── sem chave ── */}
              <View style={[card, { alignItems: 'center', paddingTop: 28 }]}>
                <View style={[s.hero, { backgroundColor: colors.text }]}><IconLock size={30} color={colors.background} /></View>
                <Text style={[s.heroTitle, { color: colors.text }]}>{t('pgp.heroTitle')}</Text>
                <Text style={[s.hint, { color: colors.textSecondary, textAlign: 'center' }]}>{t('pgp.introV2')}</Text>
                <View style={{ alignSelf: 'stretch', marginTop: 16 }}>
                  {[[IconLock, 'pgp.benefitRead'], [IconPenTool, 'pgp.benefitSign'], [IconKey, 'pgp.benefitDevice']].map(([I, k]) => (
                    <View key={k} style={s.benefit}>
                      <I size={16} color={colors.text} />
                      <Text style={[s.benefitText, { color: colors.text }]}>{t(k)}</Text>
                    </View>
                  ))}
                </View>
              </View>

              <View style={card}>
                <Text style={[s.cardHeadTitle, { color: colors.text, marginBottom: 6 }]}>{t('pgp.generateTitle')}</Text>
                <Text style={[s.hint, { color: colors.textSecondary, marginBottom: 12 }]}>{t('pgp.passphraseHelp', { n: MIN_PASSPHRASE })}</Text>
                <PassInput value={pass} onChangeText={setPass} placeholder={t('pgp.passphraseMin', { n: MIN_PASSPHRASE })} colors={colors} testID="pgp-pass" />
                <StrengthMeter value={pass} colors={colors} t={t} />
                <PassInput value={pass2} onChangeText={setPass2} placeholder={t('pgp.passphraseConfirm')} colors={colors} testID="pgp-pass2" />
                {!!pass2 && pass !== pass2 && <Text style={[s.inlineErr, { color: colors.error || '#d11' }]}>{t('pgp.passphraseMismatch')}</Text>}
                <View style={[s.warn, { borderColor: colors.border, backgroundColor: colors.surfaceVariant || colors.borderLight }]}>
                  <IconAlertTriangle size={16} color={colors.text} />
                  <Text style={[s.warnText, { color: colors.text }]}>{t('pgp.noRecovery')}</Text>
                </View>
                <PressableScale onPress={generate} disabled={!canGenerate || !!busy}
                  style={[s.primaryBtn, { backgroundColor: primaryBg, opacity: !canGenerate || busy ? 0.45 : 1 }]} testID="pgp-generate">
                  {busy === 'generate' ? (
                    <><ActivityIndicator color={primaryFg} /><Text style={[s.primaryBtnLabel, { color: primaryFg }]}>{t('pgp.generating')}</Text></>
                  ) : (
                    <><IconLock size={17} color={primaryFg} /><Text style={[s.primaryBtnLabel, { color: primaryFg }]}>{t('pgp.generate')}</Text></>
                  )}
                </PressableScale>
              </View>

              <View style={[card, { paddingVertical: 4 }]}>
                <ActionRow icon={IconUpload} label={t('pgp.importBackup')} hint={t('pgp.importBackupHint')} onPress={() => { setPanelPass(''); setPanel(p => (p === 'restore' ? '' : 'restore')); }} colors={colors} last />
              </View>
              {panel === 'restore' && (
                <View style={card}>
                  <TextInput value={restoreArmor} onChangeText={setRestoreArmor} multiline placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
                    placeholderTextColor={colors.textTertiary} autoCapitalize="none" autoCorrect={false}
                    style={[s.area, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]} />
                  {renderPanelPass(doRestore, t('pgp.restore'))}
                </View>
              )}
            </>
          )}

          {/* ── chaves de contatos ── */}
          {!loading && (
            <>
              <Text style={[s.section, { color: colors.textSecondary }]}>{t('pgp.contactsTitle')}</Text>
              <View style={[card, { paddingVertical: 4 }]}>
                {contactList.length === 0 && (
                  <View style={s.emptyRow}>
                    <IconUsers size={18} color={colors.textTertiary} />
                    <Text style={[s.hint, { color: colors.textTertiary, flex: 1, marginLeft: 10 }]}>{t('pgp.contactsEmpty')}</Text>
                  </View>
                )}
                {contactList.map(([email, info]) => (
                  <View key={email} style={[s.row, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight }]}>
                    <View style={[s.rowIcon, { backgroundColor: colors.surfaceVariant || colors.borderLight }]}><IconKey size={16} color={colors.text} /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.rowLabel, { color: colors.text }]} numberOfLines={1}>{email}</Text>
                      <Text style={[s.rowHint, { color: colors.textTertiary, fontFamily: MONO }]} numberOfLines={1}>{formatFingerprint(info?.fingerprint).replace('\n', ' ')}</Text>
                    </View>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={a11yLabel('common.delete', 'Excluir')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => removeContact(email)} hitSlop={10}><IconTrash size={16} color={colors.textSecondary} /></TouchableOpacity>
                  </View>
                ))}
                <ActionRow icon={IconUpload} label={t('pgp.importContact')} onPress={() => setPanel(p => (p === 'contact' ? '' : 'contact'))} colors={colors} last />
              </View>
              {panel === 'contact' && (
                <View style={card}>
                  <Text style={[s.hint, { color: colors.textSecondary, marginBottom: 10 }]}>{t('pgp.importContactHint')}</Text>
                  <TextInput value={contactArmor} onChangeText={setContactArmor} multiline placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
                    placeholderTextColor={colors.textTertiary} autoCapitalize="none" autoCorrect={false}
                    style={[s.area, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]} />
                  <PressableScale onPress={doSaveContact} disabled={!contactArmor.trim() || !!busy}
                    style={[s.primaryBtn, { backgroundColor: primaryBg, opacity: !contactArmor.trim() || busy ? 0.5 : 1 }]}>
                    {busy === 'contact' ? <ActivityIndicator color={primaryFg} /> : <Text style={[s.primaryBtnLabel, { color: primaryFg }]}>{t('pgp.importSave')}</Text>}
                  </PressableScale>
                </View>
              )}
            </>
          )}

          {!loading && mine && (
            <View style={[card, { paddingVertical: 4, marginTop: Spacing.md }]}>
              <ActionRow icon={IconTrash} label={t('pgp.revoke')} hint={t('pgp.revokeHint')} onPress={revoke} colors={colors} danger last />
            </View>
          )}

          {isWebStorage && !loading && (
            <Text style={[s.foot, { color: colors.textTertiary }]}>{t('pgp.webNotice')}</Text>
          )}
        </ScrollView>
      </FadeSlideIn>
    </SheetKeyboardAvoider>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  card: { padding: Spacing.lg, borderRadius: BorderRadius.xl, borderWidth: 1, marginBottom: Spacing.md },
  cardHead: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  badge: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  cardHeadTitle: { fontSize: FontSize.lg, fontWeight: '800', letterSpacing: -0.2 },
  meta: { fontSize: FontSize.xs, marginTop: 2 },
  label: { fontSize: FontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 },
  fingerprint: { fontFamily: MONO, fontSize: 14, lineHeight: 22, padding: 12, borderRadius: BorderRadius.md, letterSpacing: 1.2, textAlign: 'center' },
  pillRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  pill: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, gap: 6 },
  pillText: { fontSize: FontSize.xs, fontWeight: '600' },
  link: { fontSize: FontSize.sm, fontWeight: '700', textDecorationLine: 'underline' },
  qrBox: { padding: 14, borderRadius: 16 },
  hero: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  heroTitle: { fontSize: 20, fontWeight: '800', letterSpacing: -0.3, marginBottom: 6, textAlign: 'center' },
  benefit: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, gap: 10 },
  benefitText: { fontSize: FontSize.sm, fontWeight: '600', flex: 1 },
  hint: { fontSize: FontSize.sm, lineHeight: 20 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: BorderRadius.md, marginBottom: 10 },
  inputInner: { flex: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: FontSize.base },
  eyeBtn: { paddingHorizontal: 12, paddingVertical: 10 },
  meterRow: { flexDirection: 'row', alignItems: 'center', marginTop: -2, marginBottom: 12 },
  meterBars: { flex: 1, flexDirection: 'row', gap: 4 },
  meterBar: { flex: 1, height: 4, borderRadius: 2 },
  meterLabel: { fontSize: FontSize.xs, fontWeight: '700', marginLeft: 10, minWidth: 64, textAlign: 'right' },
  inlineErr: { fontSize: FontSize.xs, marginTop: -4, marginBottom: 8 },
  warn: { flexDirection: 'row', alignItems: 'flex-start', borderWidth: 1, borderRadius: BorderRadius.md, padding: 12, gap: 10, marginTop: 4, marginBottom: 6 },
  warnText: { flex: 1, fontSize: FontSize.xs, lineHeight: 18, fontWeight: '600' },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 15, borderRadius: BorderRadius.lg, marginTop: 8, gap: 8 },
  primaryBtnLabel: { fontWeight: '800', fontSize: FontSize.base },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 },
  rowIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  rowLabel: { fontSize: FontSize.base, fontWeight: '600' },
  rowHint: { fontSize: FontSize.xs, marginTop: 2 },
  section: { fontSize: FontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: Spacing.md, marginBottom: Spacing.sm, marginLeft: 4 },
  emptyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  area: { minHeight: 110, borderWidth: 1, borderRadius: BorderRadius.md, padding: 12, fontFamily: MONO, fontSize: 12, textAlignVertical: 'top', marginBottom: 10 },
  notice: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: BorderRadius.lg, padding: 12, gap: 10, marginBottom: Spacing.md },
  noticeText: { flex: 1, fontSize: FontSize.sm, fontWeight: '600' },
  foot: { fontSize: FontSize.xs, lineHeight: 18, textAlign: 'center', marginTop: Spacing.md, paddingHorizontal: Spacing.md },
});
