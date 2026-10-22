// [2026-10-13 video-studio] PUBLICAR — legenda (#hashtags e @menções com
// sugestões), quem pode ver, comentários/dueto, salvar no aparelho, rascunho.
// "Publicar" entrega a EDL à fila services/videoStudio/renderQueue (upload
// retomável → reels_render_submit → acompanha em 2º plano) e fecha o estúdio;
// o progresso aparece no banner do Reels/Feed e o vídeo entra no perfil/Reels.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, ScrollView, Platform, Alert, ActivityIndicator, Switch } from 'react-native';
import KeyboardSafeView from '../../components/ui/KeyboardSafeView'; // [2026-10-22 kb-uniforme]
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Image } from 'expo-image';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { haptic } from '../../constants/theme';
import { IconArrowLeft, IconGlobe, IconUsers, IconLock, IconHash, IconAtSign, IconMessageCircle, IconRepeat, IconDownload } from '../../components/Icons';
import * as api from '../../services/api';
import { C, PrimaryButton } from '../../components/videoStudio/ui';
import { useSourceInfo, thumbAt } from '../../components/videoStudio/thumbs';
import { FilterLayer } from '../../components/videoStudio/filters';
import { loadDraft, updateDraft, saveDraftNow } from '../../services/videoStudio/draftStore';
import { validate } from '../../services/videoStudio/edl';
import { locate, totalDuration, fmtTime } from '../../services/videoStudio/edlOps';
import { enqueueStudioRender, isDraftPublishing } from '../../services/videoStudio/renderQueue';

const CAPTION_MAX = 2200;
const VIS = [
  { id: 'public', labelKey: 'studio.publish.visPublic', Icon: IconGlobe },
  { id: 'friends', labelKey: 'studio.publish.visFriends', Icon: IconUsers },
  { id: 'private', labelKey: 'studio.publish.visPrivate', Icon: IconLock },
];
const TOKEN_RE = /(^|[\s(])([#@])([\p{L}\p{N}_.]*)$/u;

function extractHashtags(text) {
  const out = [];
  const re = /#([\p{L}\p{N}_]{1,60})/gu;
  let m;
  while ((m = re.exec(String(text || '')))) { const tg = m[1].toLowerCase(); if (!out.includes(tg)) out.push(tg); }
  return out.slice(0, 30);
}
function extractMentions(text) {
  const out = [];
  const re = /@([A-Za-z0-9_.]{2,40})/g;
  let m;
  while ((m = re.exec(String(text || '')))) { const u = m[1].replace(/\.$/, '').toLowerCase(); if (!out.includes(u)) out.push(u); }
  return out.slice(0, 30);
}

function CoverThumb({ edl }) {
  const ct = edl?.cover?.t || 0;
  const { index, local } = locate(edl, ct);
  const clip = edl?.clips?.[index];
  const info = useSourceInfo(clip);
  const src = !clip ? null : clip.kind === 'image' ? { uri: clip.uri } : (thumbAt(info, local) || (clip.thumb ? { uri: clip.thumb } : null));
  return (
    <View style={styles.cover}>
      {src ? <Image source={src} style={[StyleSheet.absoluteFill, clip?.mirror ? { transform: [{ scaleX: -1 }] } : null]} contentFit="cover" /> : null}
      <FilterLayer id={edl?.filter?.id} intensity={edl?.filter?.intensity ?? 1} />
      {!!edl?.cover?.text && (
        <View style={styles.coverTextWrap}><Text style={styles.coverText} numberOfLines={3}>{edl.cover.text}</Text></View>
      )}
    </View>
  );
}

function Row({ Icon, label, value, onValueChange, sub, last }) {
  return (
    <View style={[styles.row, last && { borderBottomWidth: 0 }]}>
      <Icon size={20} color="#fff" />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTxt}>{label}</Text>
        {!!sub && <Text style={styles.rowSub}>{sub}</Text>}
      </View>
      <Switch
        value={!!value}
        onValueChange={(v) => { try { haptic.select(); } catch {} onValueChange(v); }}
        trackColor={{ false: '#3A3A3C', true: '#FFFFFF' }}
        thumbColor={value ? '#000000' : (Platform.OS === 'android' ? '#BDBDBD' : '#FFFFFF')}
        ios_backgroundColor="#3A3A3C"
      />
    </View>
  );
}

export default function VideoStudioPublish() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const { user } = useAuth();
  const email = user?.email || '';
  const draftId = String(params.draft || params.draftId || '');

  const [draft, setDraft] = useState(null);
  const [caption, setCaption] = useState('');
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const [visibility, setVisibility] = useState('public');
  const [allowComments, setAllowComments] = useState(true);
  const [allowDuet, setAllowDuet] = useState(true);
  const [saveToDevice, setSaveToDevice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sugg, setSugg] = useState({ kind: null, items: [] });
  const tagsRef = useRef(null);
  const reqRef = useRef(0);
  const debRef = useRef(null);

  useEffect(() => {
    let alive = true;
    loadDraft(draftId).then((d) => {
      if (!alive) return;
      if (!d?.edl) { setDraft(false); return; }
      setDraft(d);
      const p = d.publish || d.edl?.meta?.publish || null;
      if (p) {
        setCaption(p.caption || '');
        if (p.visibility) setVisibility(p.visibility);
        if (p.allow_comments === false) setAllowComments(false);
        if (p.allow_duet === false) setAllowDuet(false);
      }
    }).catch(() => { if (alive) setDraft(false); }); // [2026-10-21 media-audit] erro de leitura = tela de "não encontrado" (antes: spinner eterno)
    return () => { alive = false; };
  }, [draftId]);

  // ─── Sugestões #/@ ─────────────────────────────────────────────────────
  const tokenAtCursor = useCallback((text, pos) => {
    const before = String(text || '').slice(0, pos);
    const m = TOKEN_RE.exec(before);
    if (!m) return null;
    return { kind: m[2], q: m[3], start: before.length - m[3].length - 1, end: pos };
  }, []);

  const refreshSugg = useCallback((text, pos) => {
    const tok = tokenAtCursor(text, pos);
    clearTimeout(debRef.current);
    if (!tok) { setSugg({ kind: null, items: [] }); return; }
    const id = ++reqRef.current;
    debRef.current = setTimeout(async () => {
      try {
        if (tok.kind === '#') {
          if (!tagsRef.current) {
            const r = await api.trendingHashtags(100);
            tagsRef.current = (r?.success && Array.isArray(r.data?.tags)) ? r.data.tags.map((x) => String(x.tag || x.name || '').replace(/^#/, '')).filter(Boolean) : [];
          }
          if (id !== reqRef.current) return;
          const q = tok.q.toLowerCase();
          const items = tagsRef.current.filter((x) => x.toLowerCase().startsWith(q)).slice(0, 8).map((x) => ({ key: x, label: `#${x}`, insert: `#${x}` }));
          setSugg({ kind: '#', items, tok });
        } else {
          if (tok.q.length < 2) { setSugg({ kind: '@', items: [], tok }); return; }
          const r = await api.searchUsers(tok.q);
          if (id !== reqRef.current) return;
          const users = (r?.success && Array.isArray(r.data?.users)) ? r.data.users : [];
          const items = users.slice(0, 8).map((u) => {
            const handle = u.username || String(u.email || '').split('@')[0];
            return { key: u.email || handle, label: `@${handle}`, sub: u.name || '', insert: `@${handle}` };
          });
          setSugg({ kind: '@', items, tok });
        }
      } catch { if (id === reqRef.current) setSugg({ kind: null, items: [] }); }
    }, tok.kind === '@' ? 250 : 80);
  }, [tokenAtCursor]);

  const onChangeCaption = (v) => {
    const s = v.slice(0, CAPTION_MAX);
    setCaption(s);
    const pos = Math.min(s.length, (sel.end || 0) + (s.length - caption.length));
    refreshSugg(s, pos);
  };
  const applySugg = (it) => {
    const tok = sugg.tok;
    if (!tok) return;
    const next = `${caption.slice(0, tok.start)}${it.insert} ${caption.slice(tok.end)}`;
    setCaption(next.slice(0, CAPTION_MAX));
    setSugg({ kind: null, items: [] });
    try { haptic.select(); } catch {}
  };
  const insertChar = (ch) => {
    const pos = sel.end || caption.length;
    const pre = caption.slice(0, pos);
    const sep = pre && !/\s$/.test(pre) ? ' ' : '';
    const next = `${pre}${sep}${ch}${caption.slice(pos)}`;
    setCaption(next.slice(0, CAPTION_MAX));
    refreshSugg(next, pos + sep.length + 1);
  };

  const publishObj = useCallback(() => ({
    caption: caption.trim(),
    hashtags: extractHashtags(caption),
    mentions: extractMentions(caption),
    visibility,
    allow_comments: !!allowComments,
    allow_duet: !!allowDuet,
    cover_t: draft?.edl?.cover?.t || 0,
  }), [caption, visibility, allowComments, allowDuet, draft]);

  const closeStudio = useCallback(() => {
    try {
      if (typeof router.dismissTo === 'function') { router.dismissTo({ pathname: '/chat', params: { tab: 'feed' } }); return; }
    } catch {}
    try { router.replace({ pathname: '/chat', params: { tab: 'feed' } }); } catch {}
  }, [router]);

  const saveDraft = useCallback(async () => {
    if (!draft) return;
    const p = publishObj();
    try {
      updateDraft(draftId, (e) => ({ ...e, meta: { ...(e.meta || {}), publish: p } }), { immediate: true });
      await saveDraftNow(draftId);
    } catch {
      Alert.alert(t('studio.drafts.title'), t('studio.publish.failed'));
      return;
    }
    try { haptic.success(); } catch {}
    Alert.alert(t('studio.drafts.title'), t('studio.publish.draftSaved'));
    closeStudio();
  }, [draft, draftId, publishObj, t, closeStudio]);

  const publish = useCallback(async () => {
    if (!draft || busy) return;
    if (!email) { Alert.alert(t('studio.publish.title'), t('studio.publish.loginRequired')); return; }
    if (isDraftPublishing(draftId)) { closeStudio(); return; }
    const e = draft.edl;
    const clean = { ...e, overlays: (e.overlays || []).map(({ id, kind, ...o }) => o) };
    const v = validate(clean);
    if (!v.ok) { Alert.alert(t('studio.publish.title'), t('studio.editor.invalid')); return; }
    setBusy(true);
    try {
      if (saveToDevice && Platform.OS !== 'web') {
        try { const ML = require('expo-media-library'); await ML.requestPermissionsAsync(true); } catch {}
      }
      const p = publishObj();
      // EDL vai com overlays sem campos só-cliente; segmentos de legenda seguem (extensão documentada).
      await enqueueStudioRender({ email, draftId, edl: clean, publish: p, saveToDevice });
      updateDraft(draftId, (x) => ({ ...x, meta: { ...(x.meta || {}), publish: p } }), { status: 'publishing', immediate: true });
      try { haptic.success(); } catch {}
      closeStudio();
    } catch {
      setBusy(false);
      Alert.alert(t('studio.publish.title'), t('studio.publish.failed'));
    }
  }, [draft, busy, email, draftId, saveToDevice, publishObj, t, closeStudio]);

  if (draft === false) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <StatusBar style="light" />
        <Text style={styles.empty}>{t('studio.editor.notFound')}</Text>
        <PrimaryButton label={t('common.back')} onPress={() => router.back()} />
      </View>
    );
  }
  if (!draft) return <View style={[styles.root, styles.center]}><ActivityIndicator color="#fff" /></View>;

  const dur = totalDuration(draft.edl);
  return (
    <KeyboardSafeView style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar style="light" />
      <View style={styles.top}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={styles.topBtn} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <IconArrowLeft size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>{t('studio.publish.title')}</Text>
        <View style={styles.topBtn} />
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        <View style={styles.captionRow}>
          <View style={{ flex: 1 }}>
            <TextInput
              value={caption}
              onChangeText={onChangeCaption}
              onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
              placeholder={t('studio.publish.captionPlaceholder')}
              placeholderTextColor={C.fg3}
              style={styles.caption}
              multiline
              maxLength={CAPTION_MAX}
              textAlignVertical="top"
            />
            <View style={styles.quick}>
              <TouchableOpacity onPress={() => insertChar('#')} style={styles.quickBtn} hitSlop={{ top: 7, bottom: 7, left: 4, right: 4 }} accessibilityRole="button"><IconHash size={14} color="#fff" /><Text style={styles.quickTxt}>{t('studio.publish.hashtags')}</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => insertChar('@')} style={styles.quickBtn} hitSlop={{ top: 7, bottom: 7, left: 4, right: 4 }} accessibilityRole="button"><IconAtSign size={14} color="#fff" /><Text style={styles.quickTxt}>{t('studio.publish.mention')}</Text></TouchableOpacity>
              <Text style={styles.count}>{`${caption.length}/${CAPTION_MAX}`}</Text>
            </View>
          </View>
          <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('studio.publish.editCover')}>
            <CoverThumb edl={draft.edl} />
            <Text style={styles.coverLbl}>{`${t('studio.tool.cover')} · ${fmtTime(dur)}`}</Text>
          </TouchableOpacity>
        </View>

        {sugg.items.length > 0 && (
          <View style={styles.sugg}>
            {sugg.items.map((it) => (
              <TouchableOpacity key={it.key} onPress={() => applySugg(it)} style={styles.suggRow} accessibilityRole="button">
                <Text style={styles.suggTxt}>{it.label}</Text>
                {!!it.sub && <Text style={styles.suggSub} numberOfLines={1}>{it.sub}</Text>}
              </TouchableOpacity>
            ))}
          </View>
        )}

        <Text style={styles.section}>{t('studio.publish.whoCanSee')}</Text>
        <View style={styles.segment}>
          {VIS.map(({ id, labelKey, Icon }) => {
            const on = visibility === id;
            return (
              <TouchableOpacity key={id} onPress={() => { setVisibility(id); try { haptic.select(); } catch {} }} style={[styles.segBtn, on && styles.segBtnOn]} accessibilityRole="radio" accessibilityState={{ selected: on }}>
                <Icon size={15} color={on ? '#000' : C.fg2} />
                <Text style={[styles.segTxt, on && { color: '#000' }]} numberOfLines={1}>{t(labelKey)}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.card}>
          <Row Icon={IconMessageCircle} label={t('studio.publish.allowComments')} value={allowComments} onValueChange={setAllowComments} />
          <Row Icon={IconRepeat} label={t('studio.publish.allowDuet')} value={allowDuet} onValueChange={setAllowDuet} last={Platform.OS === 'web'} />
          {Platform.OS !== 'web' && (
            <Row Icon={IconDownload} label={t('studio.publish.saveToDevice')} sub={t('studio.publish.saveToDeviceSub')} value={saveToDevice} onValueChange={setSaveToDevice} last />
          )}
        </View>
        <Text style={styles.note}>{t('studio.publish.backgroundNote')}</Text>
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: Math.max(12, insets.bottom) }]}>
        <PrimaryButton label={t('studio.publish.saveDraft')} onPress={saveDraft} dark style={{ flex: 1 }} />
        <PrimaryButton label={busy ? t('studio.publish.sending') : t('studio.publish.publish')} onPress={publish} disabled={busy} style={{ flex: 1.4 }} />
      </View>
    </KeyboardSafeView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center', gap: 16 },
  empty: { color: C.fg2, fontSize: 15, textAlign: 'center', paddingHorizontal: 30 },
  top: { height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  topBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', color: '#fff', fontSize: 17, fontWeight: '800' },
  captionRow: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: 8 },
  caption: { minHeight: 120, maxHeight: 220, color: '#fff', fontSize: 15, lineHeight: 21, paddingTop: 4 },
  quick: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  quickBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 30, paddingHorizontal: 10, borderRadius: 15, backgroundColor: C.card },
  quickTxt: { color: '#fff', fontSize: 12, fontWeight: '700' },
  count: { marginLeft: 'auto', color: C.fg3, fontSize: 11 },
  cover: { width: 96, height: 170, borderRadius: 10, overflow: 'hidden', backgroundColor: '#1a1a1a' },
  coverTextWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: 6 },
  coverText: { color: '#fff', fontSize: 13, fontWeight: '900', textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 4 },
  coverLbl: { color: C.fg2, fontSize: 11, textAlign: 'center', marginTop: 4 },
  sugg: { marginHorizontal: 16, marginTop: 8, borderRadius: 12, backgroundColor: C.card, overflow: 'hidden' },
  suggRow: { paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  suggTxt: { color: '#fff', fontSize: 14, fontWeight: '700' },
  suggSub: { color: C.fg2, fontSize: 12, marginTop: 1 },
  section: { color: C.fg2, fontSize: 12, fontWeight: '700', marginTop: 22, marginBottom: 8, marginHorizontal: 16, textTransform: 'uppercase', letterSpacing: 0.6 },
  segment: { flexDirection: 'row', marginHorizontal: 16, gap: 8 },
  segBtn: { flex: 1, height: 40, borderRadius: 12, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 6 },
  segBtnOn: { backgroundColor: '#fff', borderColor: '#fff' },
  segTxt: { color: C.fg2, fontSize: 13, fontWeight: '700' },
  card: { marginHorizontal: 16, marginTop: 18, borderRadius: 14, backgroundColor: C.card, paddingHorizontal: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  rowTxt: { color: '#fff', fontSize: 15, fontWeight: '600' },
  rowSub: { color: C.fg3, fontSize: 12, marginTop: 2 },
  note: { color: C.fg3, fontSize: 12, marginHorizontal: 16, marginTop: 14, lineHeight: 17 },
  footer: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line },
});
