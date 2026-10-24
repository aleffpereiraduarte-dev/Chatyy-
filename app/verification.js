// [verificado 2026-10-24] Perfil > Configurações > "Solicitar verificação" — selo azul nível Instagram.
// Contrato: /root/verificado-2026-10-24/API.md (verif_status / verif_submit multipart / verif_cancel).
// Tela é ROTA (não Modal): seletor de câmera/galeria = Alert/ActionSheet do sistema (sem Modal sobre Modal no iOS).
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, TextInput, ActivityIndicator, Image, StyleSheet, Platform,
  KeyboardAvoidingView, ActionSheetIOS, RefreshControl,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Circle, Rect } from 'react-native-svg';
import { USE_NATIVE_HEADER, nativeHeaderOptions, nativeScrollInsetProps } from '../components/nativeHeader';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft } from '../components/Icons';
import { VerifiedGlyph, VERIFIED_BLUE } from '../components/VerifiedBadge';
import { verifStatus, verifSubmit, verifCancel, ensureVerifiedBadges } from '../services/verification';

// helpers fora do componente
function _alert(title, msg, buttons) {
  try { require('../services/alerts').safeAlert(title, msg, buttons); return; } catch {}
  try { require('react-native').Alert.alert(title, msg, buttons); } catch {}
}
function _haptic(kind) { try { const h = require('../services/haptics'); if (h && h.hapticEvent) h.hapticEvent(kind || 'success'); } catch {} }
function _back(router) { try { if (router.canGoBack()) router.back(); else router.replace('/settings'); } catch {} }
function _region() {
  try { const L = require('expo-localization'); const l = (L.getLocales && L.getLocales()[0]) || {}; return String(l.regionCode || '').toUpperCase().slice(0, 2); } catch { return ''; }
}
function _fmtDate(v, lang) {
  if (!v) return '';
  try { const d = new Date(v); if (isNaN(d)) return ''; return d.toLocaleDateString(lang || undefined, { day: '2-digit', month: 'long', year: 'numeric' }); } catch { return String(v).slice(0, 10); }
}
async function _prepImage(uri) {
  let IM = null;
  try { IM = require('expo-image-manipulator'); } catch {}
  if (!IM || typeof IM.manipulateAsync !== 'function' || Platform.OS === 'web') return uri;
  try {
    const out = await IM.manipulateAsync(uri, [{ resize: { width: 2000 } }], { compress: 0.85, format: (IM.SaveFormat && IM.SaveFormat.JPEG) || 'jpeg' });
    return (out && out.uri) || uri;
  } catch { return uri; }
}
async function _pick(source) {
  let IP;
  try { IP = require('expo-image-picker'); } catch { return null; }
  try {
    if (source === 'camera') {
      const p = await IP.requestCameraPermissionsAsync();
      if (!p || p.status !== 'granted') return { denied: true };
      const r = await IP.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9, allowsEditing: false, exif: false });
      if (r.canceled || !r.assets || !r.assets[0]) return null;
      return { uri: await _prepImage(r.assets[0].uri) };
    }
    if (Platform.OS !== 'web') {
      const p = await IP.requestMediaLibraryPermissionsAsync();
      if (!p || p.status !== 'granted') return { denied: true };
    }
    const r = await IP.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9, allowsEditing: false, exif: false, selectionLimit: 1 });
    if (r.canceled || !r.assets || !r.assets[0]) return null;
    return { uri: await _prepImage(r.assets[0].uri) };
  } catch { return null; }
}

const CATS = ['artist', 'athlete', 'journalist', 'creator', 'business', 'government', 'ngo', 'public_figure'];
const DOCS_PERSON = ['rg', 'cnh', 'passport', 'foreign_id'];
const DOCS_BUSINESS = ['company_doc', 'rg', 'cnh', 'passport', 'foreign_id'];
const BACK_DEFAULT = { rg: true, cnh: true, passport: false, foreign_id: true, company_doc: false };
const ERR_KEYS = {
  verif_disabled: 'verif.err.disabled', verif_pending: 'verif.err.pending', verif_cooldown: 'verif.err.cooldown',
  verif_already: 'verif.err.already', verif_profile_incomplete: 'verif.err.profileIncomplete', verif_bad_field: 'verif.err.badField',
  verif_reason_short: 'verif.err.reasonShort', verif_docs_missing: 'verif.err.docsMissing', verif_file_type: 'verif.err.fileType',
  verif_file_too_big: 'verif.err.fileTooBig', verif_consent: 'verif.err.consent', verif_rate: 'verif.err.rate',
};

function Glyph({ name, color, size = 20 }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  if (name === 'check') return <Svg {...p}><Circle cx={12} cy={12} r={9} /><Path d="M8 12.5l2.8 2.8L16.5 9.5" /></Svg>;
  if (name === 'miss') return <Svg {...p}><Circle cx={12} cy={12} r={9} /><Path d="M12 7.5v5.5M12 16.5h.01" /></Svg>;
  if (name === 'lock') return <Svg {...p}><Rect x={5} y={10.5} width={14} height={10} rx={2} /><Path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></Svg>;
  if (name === 'camera') return <Svg {...p}><Path d="M4 8h3l1.6-2.2h6.8L17 8h3v11H4z" /><Circle cx={12} cy={13.3} r={3.4} /></Svg>;
  if (name === 'clock') return <Svg {...p}><Circle cx={12} cy={12} r={9} /><Path d="M12 7v5l3.2 2" /></Svg>;
  if (name === 'x') return <Svg {...p}><Circle cx={12} cy={12} r={9} /><Path d="M9 9l6 6M15 9l-6 6" /></Svg>;
  if (name === 'box') return <Svg {...p}><Rect x={4} y={4} width={16} height={16} rx={4} /></Svg>;
  if (name === 'boxOn') return <Svg {...p} stroke={VERIFIED_BLUE}><Rect x={4} y={4} width={16} height={16} rx={4} fill={VERIFIED_BLUE} /><Path d="M8 12.3l2.7 2.7L16.2 9.4" stroke="#fff" strokeWidth={2.2} /></Svg>;
  return null;
}

export default function VerificationScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  const tr = useCallback((k, vars) => {
    let s = t(k);
    if (!s || s === k) s = k;
    if (vars) Object.keys(vars).forEach((v) => { s = s.split('{' + v + '}').join(String(vars[v])); });
    return s;
  }, [t]);

  const [st, setSt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  // formulário
  const [kind, setKind] = useState('person');
  const [category, setCategory] = useState('');
  const [fullName, setFullName] = useState('');
  const [knownAs, setKnownAs] = useState('');
  const [country, setCountry] = useState(_region() || 'BR');
  const [docType, setDocType] = useState('rg');
  const [cnpj, setCnpj] = useState('');
  const [links, setLinks] = useState('');
  const [audience, setAudience] = useState('');
  const [reason, setReason] = useState('');
  const [consent, setConsent] = useState(false);
  const [files, setFiles] = useState({ doc_front: '', doc_back: '', selfie: '' });

  const load = useCallback(async () => {
    try {
      const d = await verifStatus();
      setSt(d); setLoadErr('');
    } catch (e) {
      setLoadErr((e && e.message) || 'error');
    }
    setLoading(false); setRefreshing(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const reasonMin = (st && st.reason_min) || 30;
  const reasonMax = (st && st.reason_max) || 2000;
  const linksMax = (st && st.links_max) || 8;
  const retention = (st && st.docs_retention_days) || 30;
  const cooldown = (st && st.cooldown_days) || 30;
  const backReq = (st && st.doc_back_required) || BACK_DEFAULT;
  const cats = (st && Array.isArray(st.categories) && st.categories.length) ? st.categories : CATS;
  const allowedDocs = useMemo(() => {
    const srv = (st && Array.isArray(st.doc_types) && st.doc_types.length) ? st.doc_types : null;
    const base = kind === 'business' ? DOCS_BUSINESS : DOCS_PERSON;
    return srv ? base.filter((d) => srv.indexOf(d) >= 0) : base;
  }, [st, kind]);
  useEffect(() => { if (allowedDocs.indexOf(docType) < 0) setDocType(allowedDocs[0] || 'rg'); }, [allowedDocs, docType]);
  const needBack = !!backReq[docType];

  const prof = (st && st.profile) || {};
  const missing = Array.isArray(prof.missing) ? prof.missing : [];
  const hardMissing = missing.filter((m) => m === 'photo' || m === 'name');
  const req = st && st.request;
  const reqStatus = req && req.status !== 'cancelled' ? req.status : '';

  const linkList = useMemo(() => links.split(/\n|,|\s+/).map((x) => x.trim()).filter(Boolean).slice(0, 20), [links]);
  const reasonLen = reason.trim().length;
  const canSend = !busy && consent && !!category && fullName.trim().length >= 3 && country.trim().length === 2
    && reasonLen >= reasonMin && reasonLen <= reasonMax && !!files.doc_front && (!needBack || !!files.doc_back)
    && linkList.length <= linksMax && hardMissing.length === 0;

  const choosePhoto = useCallback((slot) => {
    const run = async (src) => {
      const r = await _pick(src);
      if (!r) return;
      if (r.denied) { _alert(tr('verif.permTitle'), src === 'camera' ? tr('verif.permCamera') : tr('verif.permGallery')); return; }
      setFiles((f) => ({ ...f, [slot]: r.uri }));
    };
    if (Platform.OS === 'web') { run('gallery'); return; }
    const opts = [tr('verif.takePhoto'), tr('verif.chooseGallery')];
    if (files[slot]) opts.push(tr('verif.removePhoto'));
    const onIdx = (i) => {
      if (i === 0) run('camera');
      else if (i === 1) run('gallery');
      else if (i === 2 && files[slot]) setFiles((f) => ({ ...f, [slot]: '' }));
    };
    if (Platform.OS === 'ios' && ActionSheetIOS && ActionSheetIOS.showActionSheetWithOptions) {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...opts, tr('verif.cancel')], cancelButtonIndex: opts.length, destructiveButtonIndex: files[slot] ? 2 : undefined },
        (i) => { if (i < opts.length) onIdx(i); },
      );
      return;
    }
    const buttons = opts.map((o, i) => ({ text: o, style: i === 2 ? 'destructive' : 'default', onPress: () => onIdx(i) }));
    buttons.push({ text: tr('verif.cancel'), style: 'cancel' });
    _alert(tr('verif.photoTitle'), '', buttons);
  }, [files, tr]);

  const submit = useCallback(async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      const fields = {
        kind, category, full_name: fullName.trim(), known_as: knownAs.trim(), country: country.trim().toUpperCase(),
        doc_type: docType, reason: reason.trim(), links: linkList.slice(0, linksMax), audience: audience.trim(),
        cnpj: kind === 'business' ? cnpj.replace(/\D/g, '') : '', lang: language || '',
      };
      const f = { doc_front: files.doc_front, doc_back: needBack ? files.doc_back : (files.doc_back || ''), selfie: files.selfie };
      await verifSubmit(fields, f);
      _haptic('success');
      setFiles({ doc_front: '', doc_back: '', selfie: '' });
      setShowForm(false);
      _alert(tr('verif.sentTitle'), tr('verif.sentBody', { days: retention }));
      await load();
    } catch (e) {
      const code = e && e.data && e.data.code;
      let msg = (e && e.network) ? tr('verif.err.network') : ((code && ERR_KEYS[code]) ? tr(ERR_KEYS[code]) : ((e && e.message) || tr('verif.err.generic')));
      if (code === 'verif_cooldown' && e.data.next_allowed_at) msg += ' ' + tr('verif.retryFrom', { date: _fmtDate(e.data.next_allowed_at, language) });
      _haptic('error');
      _alert(tr('verif.err.title'), msg);
    }
    setBusy(false);
  }, [canSend, kind, category, fullName, knownAs, country, docType, reason, linkList, linksMax, audience, cnpj, language, files, needBack, retention, tr, load]);

  const cancelReq = useCallback(() => {
    if (!req || !req.id) return;
    _alert(tr('verif.cancelTitle'), tr('verif.cancelBody'), [
      { text: tr('verif.keep'), style: 'cancel' },
      { text: tr('verif.cancelConfirm'), style: 'destructive', onPress: async () => {
        setBusy(true);
        try { await verifCancel(req.id); _haptic('success'); await load(); }
        catch (e) { _alert(tr('verif.err.title'), (e && e.message) || tr('verif.err.generic')); }
        setBusy(false);
      } },
    ]);
  }, [req, tr, load]);

  useEffect(() => { if (st && st.verified) ensureVerifiedBadges(true); }, [st]);

  const card = { backgroundColor: colors.surface || colors.background, borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)' };
  const inputSt = [s.input, { color: colors.text, borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)', backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)' }];
  const sub = colors.textSecondary;

  const Chip = ({ on, label, onPress, testID }) => (
    <TouchableOpacity onPress={onPress} testID={testID} accessibilityRole="button" accessibilityState={{ selected: !!on }}
      style={[s.chip, { borderColor: on ? VERIFIED_BLUE : (isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.14)'), backgroundColor: on ? (isDark ? 'rgba(0,149,246,0.18)' : 'rgba(0,149,246,0.09)') : 'transparent' }]}>
      <Text style={[s.chipTxt, { color: on ? VERIFIED_BLUE : colors.text }]}>{label}</Text>
    </TouchableOpacity>
  );
  const Label = ({ children, hint }) => (
    <View style={{ marginTop: 16, marginBottom: 6 }}>
      <Text style={[s.label, { color: colors.text }]}>{children}</Text>
      {hint ? <Text style={[s.hint, { color: sub }]}>{hint}</Text> : null}
    </View>
  );
  const PhotoSlot = ({ slot, title, hint, required }) => (
    <TouchableOpacity onPress={() => choosePhoto(slot)} accessibilityRole="button" accessibilityLabel={title} testID={'verif-photo-' + slot}
      style={[s.slot, { borderColor: files[slot] ? VERIFIED_BLUE : (isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.16)') }]}>
      {files[slot] ? <Image source={{ uri: files[slot] }} style={s.slotImg} resizeMode="cover" /> : (
        <View style={{ alignItems: 'center', gap: 6, paddingHorizontal: 8 }}>
          <Glyph name="camera" color={sub} size={26} />
          <Text style={[s.slotTitle, { color: colors.text }]} numberOfLines={2}>{title}{required ? ' *' : ''}</Text>
          {hint ? <Text style={[s.slotHint, { color: sub }]} numberOfLines={3}>{hint}</Text> : null}
        </View>
      )}
    </TouchableOpacity>
  );

  const header = USE_NATIVE_HEADER ? (
    <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title: tr('verif.title') })} />
  ) : (
    <View style={[s.header, { borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }]}>
      <TouchableOpacity onPress={() => _back(router)} style={s.headerBtn} accessibilityRole="button" accessibilityLabel={tr('verif.back')}>
        <IconArrowLeft size={24} color={colors.text} />
      </TouchableOpacity>
      <Text style={[s.headerTitle, { color: colors.text }]} numberOfLines={1}>{tr('verif.title')}</Text>
      <View style={s.headerBtn} />
    </View>
  );

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }}>
        {header}
        <View style={s.center}><ActivityIndicator color={sub} /></View>
      </View>
    );
  }
  if (!st || st.enabled === false) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }}>
        {header}
        <View style={s.center}>
          <Text style={[s.emptyT, { color: colors.text }]}>{loadErr ? tr('verif.err.load') : tr('verif.unavailable')}</Text>
          {loadErr ? (
            <TouchableOpacity onPress={() => { setLoading(true); load(); }} style={[s.btn, { backgroundColor: VERIFIED_BLUE, marginTop: 14 }]} accessibilityRole="button">
              <Text style={s.btnTxt}>{tr('verif.retry')}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  }

  // ───── estado do pedido ─────
  let statusNode = null;
  if (st.verified) {
    statusNode = (
      <View style={[s.card, card, { alignItems: 'center' }]}>
        <VerifiedGlyph size={44} />
        <Text style={[s.statusT, { color: colors.text }]}>{tr('verif.st.approvedTitle')}</Text>
        <Text style={[s.statusB, { color: sub }]}>{tr('verif.st.approvedBody')}</Text>
        {st.verified_at ? <Text style={[s.small, { color: sub }]}>{tr('verif.since', { date: _fmtDate(st.verified_at, language) })}</Text> : null}
      </View>
    );
  } else if (reqStatus === 'new' || reqStatus === 'review') {
    statusNode = (
      <View style={[s.card, card]}>
        <View style={s.rowC}><Glyph name="clock" color={VERIFIED_BLUE} size={24} />
          <Text style={[s.statusT, { color: colors.text, marginTop: 0, marginLeft: 10, flex: 1 }]}>{reqStatus === 'review' ? tr('verif.st.reviewTitle') : tr('verif.st.newTitle')}</Text></View>
        <Text style={[s.statusB, { color: sub, textAlign: 'left' }]}>{tr('verif.st.pendingBody')}</Text>
        {req.created_at ? <Text style={[s.small, { color: sub }]}>{tr('verif.sentOn', { date: _fmtDate(req.created_at, language) })}</Text> : null}
        <TouchableOpacity onPress={cancelReq} disabled={busy} style={[s.btnGhost, { borderColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.15)' }]} accessibilityRole="button" testID="verif-cancel">
          <Text style={[s.btnGhostTxt, { color: colors.error || '#E5484D' }]}>{tr('verif.cancelReq')}</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (reqStatus === 'rejected' || reqStatus === 'approved') {
    const rej = reqStatus === 'rejected';
    statusNode = (
      <View style={[s.card, card]}>
        <View style={s.rowC}><Glyph name={rej ? 'x' : 'check'} color={rej ? (colors.error || '#E5484D') : VERIFIED_BLUE} size={24} />
          <Text style={[s.statusT, { color: colors.text, marginTop: 0, marginLeft: 10, flex: 1 }]}>{rej ? tr('verif.st.rejectedTitle') : tr('verif.st.removedTitle')}</Text></View>
        {req.reject_text ? <Text style={[s.statusB, { color: colors.text, textAlign: 'left' }]}>{req.reject_text}</Text> : null}
        {st.next_allowed_at && !st.can_apply ? <Text style={[s.small, { color: sub }]}>{tr('verif.retryFrom', { date: _fmtDate(st.next_allowed_at, language) })}</Text> : null}
      </View>
    );
  }
  const docsNode = req && (req.docs_purged || req.docs_purge_at) ? (
    <View style={[s.rowC, { marginTop: 10, paddingHorizontal: 4 }]}>
      <Glyph name="lock" color={sub} size={16} />
      <Text style={[s.small, { color: sub, marginTop: 0, marginLeft: 6, flex: 1 }]}>
        {req.docs_purged ? tr('verif.docsPurged') : tr('verif.docsPurgeOn', { date: _fmtDate(req.docs_purge_at, language) })}
      </Text>
    </View>
  ) : null;

  const blocked = st.blocked_reason;
  const canStart = !!st.can_apply && !st.verified && !(reqStatus === 'new' || reqStatus === 'review');

  const criteria = [
    ['authentic', tr('verif.crit.authentic'), tr('verif.crit.authenticBody')],
    ['unique', tr('verif.crit.unique'), tr('verif.crit.uniqueBody')],
    ['complete', tr('verif.crit.complete'), tr('verif.crit.completeBody')],
    ['notable', tr('verif.crit.notable'), tr('verif.crit.notableBody')],
  ];
  const checklist = [
    ['photo', tr('verif.chk.photo'), !missing.includes('photo')],
    ['name', tr('verif.chk.name'), !missing.includes('name')],
    ['username', tr('verif.chk.username'), !missing.includes('username')],
    ['bio', tr('verif.chk.bio'), !missing.includes('bio')],
    ['posts', tr('verif.chk.posts'), !missing.includes('posts')],
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }} testID="verification-screen">
      {header}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          {...nativeScrollInsetProps()}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, paddingBottom: (insets.bottom || 0) + 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={sub} />}
        >
          {!showForm ? (
            <View style={{ alignItems: 'center', marginTop: 8, marginBottom: 16 }}>
              <VerifiedGlyph size={56} />
              <Text style={[s.hero, { color: colors.text }]}>{tr('verif.heroTitle')}</Text>
              <Text style={[s.heroSub, { color: sub }]}>{tr('verif.heroBody')}</Text>
            </View>
          ) : null}

          {statusNode}
          {docsNode}

          {!showForm ? (
            <>
              <Text style={[s.section, { color: sub }]}>{tr('verif.critTitle')}</Text>
              <View style={[s.card, card, { paddingVertical: 4 }]}>
                {criteria.map(([k, title, body], i) => (
                  <View key={k} style={[s.critRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }]}>
                    <Text style={[s.critT, { color: colors.text }]}>{title}</Text>
                    <Text style={[s.critB, { color: sub }]}>{body}</Text>
                  </View>
                ))}
              </View>
              <Text style={[s.small, { color: sub, paddingHorizontal: 4 }]}>{tr('verif.critNote')}</Text>

              {!st.verified ? (
                <>
                  <Text style={[s.section, { color: sub }]}>{tr('verif.chkTitle')}</Text>
                  <View style={[s.card, card, { paddingVertical: 6 }]}>
                    {checklist.map(([k, label, ok]) => (
                      <View key={k} style={[s.rowC, { paddingVertical: 7 }]}>
                        <Glyph name={ok ? 'check' : 'miss'} color={ok ? '#30A46C' : (k === 'photo' || k === 'name' ? (colors.error || '#E5484D') : '#E09B13')} size={20} />
                        <Text style={[s.chkTxt, { color: colors.text }]}>{label}</Text>
                        {!ok && (k === 'photo' || k === 'name') ? <Text style={[s.small, { color: colors.error || '#E5484D', marginTop: 0 }]}>{tr('verif.required')}</Text> : null}
                      </View>
                    ))}
                  </View>
                  {missing.length ? (
                    <TouchableOpacity onPress={() => { try { router.push('/edit-profile'); } catch {} }} style={{ paddingHorizontal: 4, paddingVertical: 6 }} accessibilityRole="button">
                      <Text style={{ color: VERIFIED_BLUE, fontWeight: '600' }}>{tr('verif.editProfile')}</Text>
                    </TouchableOpacity>
                  ) : null}
                </>
              ) : null}

              {canStart ? (
                <TouchableOpacity onPress={() => setShowForm(true)} style={[s.btn, { backgroundColor: VERIFIED_BLUE, marginTop: 18 }]} accessibilityRole="button" testID="verif-start">
                  <Text style={s.btnTxt}>{tr('verif.start')}</Text>
                </TouchableOpacity>
              ) : (!st.verified && blocked === 'cooldown' && st.next_allowed_at) ? (
                <Text style={[s.small, { color: sub, textAlign: 'center', marginTop: 16 }]}>{tr('verif.cooldownNote', { days: cooldown, date: _fmtDate(st.next_allowed_at, language) })}</Text>
              ) : (!st.verified && blocked === 'profile_incomplete') ? (
                <Text style={[s.small, { color: sub, textAlign: 'center', marginTop: 16 }]}>{tr('verif.err.profileIncomplete')}</Text>
              ) : null}
            </>
          ) : (
            <>
              <Label>{tr('verif.f.kind')}</Label>
              <View style={s.chips}>
                <Chip on={kind === 'person'} label={tr('verif.kind.person')} onPress={() => setKind('person')} testID="verif-kind-person" />
                <Chip on={kind === 'business'} label={tr('verif.kind.business')} onPress={() => { setKind('business'); if (!category) setCategory('business'); }} testID="verif-kind-business" />
              </View>

              <Label hint={tr('verif.f.categoryHint')}>{tr('verif.f.category')}</Label>
              <View style={s.chips}>
                {cats.map((c) => <Chip key={c} on={category === c} label={tr('verif.cat.' + c)} onPress={() => setCategory(c)} testID={'verif-cat-' + c} />)}
              </View>

              <Label hint={kind === 'business' ? tr('verif.f.fullNameBizHint') : tr('verif.f.fullNameHint')}>{kind === 'business' ? tr('verif.f.fullNameBiz') : tr('verif.f.fullName')}</Label>
              <TextInput value={fullName} onChangeText={setFullName} style={inputSt} maxLength={120} autoCapitalize="words" placeholderTextColor={sub} testID="verif-fullname" />

              <Label hint={tr('verif.f.knownAsHint')}>{tr('verif.f.knownAs')}</Label>
              <TextInput value={knownAs} onChangeText={setKnownAs} style={inputSt} maxLength={80} placeholderTextColor={sub} />

              {kind === 'business' ? (
                <>
                  <Label hint={tr('verif.f.cnpjHint')}>{tr('verif.f.cnpj')}</Label>
                  <TextInput value={cnpj} onChangeText={(v) => setCnpj(v.replace(/[^\d./-]/g, '').slice(0, 18))} style={inputSt} keyboardType="number-pad" placeholder="00.000.000/0000-00" placeholderTextColor={sub} />
                </>
              ) : null}

              <Label hint={tr('verif.f.countryHint')}>{tr('verif.f.country')}</Label>
              <TextInput value={country} onChangeText={(v) => setCountry(v.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2))} style={[inputSt, { width: 90 }]} autoCapitalize="characters" maxLength={2} placeholder="BR" placeholderTextColor={sub} />

              <Label hint={tr('verif.f.docTypeHint')}>{tr('verif.f.docType')}</Label>
              <View style={s.chips}>
                {allowedDocs.map((d) => <Chip key={d} on={docType === d} label={tr('verif.doc.' + d)} onPress={() => setDocType(d)} testID={'verif-doc-' + d} />)}
              </View>
              <View style={s.slots}>
                <PhotoSlot slot="doc_front" title={needBack ? tr('verif.f.front') : tr('verif.f.photoDoc')} hint={tr('verif.f.frontHint')} required />
                {needBack ? <PhotoSlot slot="doc_back" title={tr('verif.f.back')} hint={tr('verif.f.backHint')} required /> : null}
                <PhotoSlot slot="selfie" title={tr('verif.f.selfie')} hint={tr('verif.f.selfieHint')} />
              </View>
              <Text style={[s.small, { color: sub }]}>{tr('verif.f.selfieRecommend')}</Text>

              <Label hint={tr('verif.f.linksHint', { n: linksMax })}>{tr('verif.f.links')}</Label>
              <TextInput value={links} onChangeText={setLinks} style={[inputSt, { minHeight: 76, textAlignVertical: 'top' }]} multiline autoCapitalize="none" autoCorrect={false} keyboardType={Platform.OS === 'ios' ? 'url' : 'default'} placeholder="https://" placeholderTextColor={sub} />
              {linkList.length > linksMax ? <Text style={[s.small, { color: colors.error || '#E5484D' }]}>{tr('verif.f.linksTooMany', { n: linksMax })}</Text> : null}

              <Label hint={tr('verif.f.audienceHint')}>{tr('verif.f.audience')}</Label>
              <TextInput value={audience} onChangeText={setAudience} style={inputSt} maxLength={200} placeholderTextColor={sub} />

              <Label hint={tr('verif.f.reasonHint')}>{tr('verif.f.reason')}</Label>
              <TextInput value={reason} onChangeText={(v) => setReason(v.slice(0, reasonMax))} style={[inputSt, { minHeight: 120, textAlignVertical: 'top' }]} multiline placeholderTextColor={sub} testID="verif-reason" />
              <Text style={[s.small, { color: reasonLen < reasonMin ? sub : '#30A46C', textAlign: 'right' }]}>
                {reasonLen < reasonMin ? tr('verif.f.reasonMin', { n: reasonMin - reasonLen }) : `${reasonLen}/${reasonMax}`}
              </Text>

              <View style={[s.card, card, { marginTop: 16 }]}>
                <View style={s.rowC}><Glyph name="lock" color={VERIFIED_BLUE} size={20} />
                  <Text style={[s.critT, { color: colors.text, marginLeft: 8, flex: 1 }]}>{tr('verif.privacyTitle')}</Text></View>
                <Text style={[s.critB, { color: sub, marginTop: 8 }]}>{tr('verif.privacyBody', { days: retention })}</Text>
              </View>

              <TouchableOpacity onPress={() => setConsent((c) => !c)} style={[s.rowC, { marginTop: 14, alignItems: 'flex-start' }]} accessibilityRole="checkbox" accessibilityState={{ checked: consent }} testID="verif-consent">
                <Glyph name={consent ? 'boxOn' : 'box'} color={sub} size={22} />
                <Text style={[s.consentTxt, { color: colors.text }]}>{tr('verif.consent', { days: retention })}</Text>
              </TouchableOpacity>

              {hardMissing.length ? <Text style={[s.small, { color: colors.error || '#E5484D', marginTop: 12 }]}>{tr('verif.err.profileIncomplete')}</Text> : null}

              <TouchableOpacity onPress={submit} disabled={!canSend} style={[s.btn, { backgroundColor: VERIFIED_BLUE, opacity: canSend ? 1 : 0.45, marginTop: 18 }]} accessibilityRole="button" accessibilityState={{ disabled: !canSend }} testID="verif-submit">
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnTxt}>{tr('verif.submit')}</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowForm(false)} disabled={busy} style={{ alignItems: 'center', paddingVertical: 14 }} accessibilityRole="button">
                <Text style={{ color: sub, fontWeight: '600' }}>{tr('verif.cancel')}</Text>
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyT: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  hero: { fontSize: 22, fontWeight: '800', marginTop: 12, textAlign: 'center' },
  heroSub: { fontSize: 14.5, lineHeight: 20, marginTop: 6, textAlign: 'center', paddingHorizontal: 8 },
  section: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 22, marginBottom: 8, paddingHorizontal: 4 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  critRow: { paddingVertical: 10 },
  critT: { fontSize: 15, fontWeight: '700' },
  critB: { fontSize: 13.5, lineHeight: 19, marginTop: 3 },
  rowC: { flexDirection: 'row', alignItems: 'center' },
  chkTxt: { fontSize: 15, marginLeft: 10, flex: 1 },
  statusT: { fontSize: 17, fontWeight: '800', marginTop: 10, textAlign: 'center' },
  statusB: { fontSize: 14, lineHeight: 20, marginTop: 8, textAlign: 'center' },
  small: { fontSize: 12.5, lineHeight: 17, marginTop: 6 },
  label: { fontSize: 15, fontWeight: '700' },
  hint: { fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 11 : 8, fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 13, paddingVertical: 7 },
  chipTxt: { fontSize: 14, fontWeight: '600' },
  slots: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  slot: { width: '31%', minWidth: 100, aspectRatio: 0.8, borderWidth: 1.5, borderStyle: 'dashed', borderRadius: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  slotImg: { width: '100%', height: '100%' },
  slotTitle: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  slotHint: { fontSize: 11, lineHeight: 14, textAlign: 'center' },
  consentTxt: { flex: 1, fontSize: 13.5, lineHeight: 19, marginLeft: 10 },
  btn: { height: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  btnTxt: { color: '#fff', fontSize: 16, fontWeight: '700' },
  btnGhost: { marginTop: 14, height: 44, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  btnGhostTxt: { fontSize: 15, fontWeight: '600' },
});
