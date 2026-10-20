// [mural 2026-10-20] Tela 5 do mockup: compositor "Nova publicação".
// Texto, fotos ou os dois; público Todos / Contatos / Só eu; até 1000
// caracteres com contador; fotos em carrossel com remover e "+Foto" (galeria e
// câmera pelo seletor do photo-new — services/profilePostComposer.pickPostMedia);
// prévia ao vivo (cartão e quadro da grade); publicar pela fila durável
// (services/profilePostQueue, aceita SÓ TEXTO). Modo edição (edit=<id>): texto
// e público (post_edit); as fotos ficam como estão.
// Rota: /photo-new (app/photo-new.js escolhe este quando
// globalThis.__chatyy_mural_composer !== false).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, TextInput, KeyboardAvoidingView, Platform, Alert,
  InteractionManager, StatusBar, StyleSheet, useWindowDimensions, ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { useLanguage } from '../../context/LanguageContext';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import MIcon from './MuralIcons';
import { useMuralTheme } from './muralTheme';
import { Avatar, audienceIcon } from './parts';
import * as store from '../../services/muralStore';
import { pickPostMedia, takePendingPostItems, showActionMenu, POST_MAX_ITEMS } from '../../services/profilePostComposer';
import { enqueueProfilePost, newPostJobId } from '../../services/profilePostQueue';

const MAX_TEXT = 1000;
const AUDS = ['public', 'contacts', 'private'];

let _tiles = null;
function _tg() { if (_tiles === null) { try { _tiles = require('../profile/tg/TgPostTiles'); } catch { _tiles = false; } } return _tiles; }

function _defaultAud() {
  try { const m = require('../../services/muralPrefs'); return m.getDefaultAudience?.() || 'public'; } catch { return 'public'; }
}
function _normAud(a) {
  const v = String(a || '').toLowerCase();
  if (v === 'contacts') return 'contacts';
  if (v === 'private' || v === 'only_me') return 'private';
  return 'public';
}

export default function PostComposer() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const pickParam = String(params?.pick || '');
  const fromParam = String(params?.from || '');
  const editId = params?.edit ? String(params.edit) : '';
  const th = useMuralTheme();
  const { t, language } = useLanguage();
  const { user } = useAuth() || {};
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const contentW = Math.min(winW, 640);

  const editing = editId ? store.getPost(editId) : null;
  const [text, setText] = useState(() => (editing ? String(editing.caption || '').slice(0, MAX_TEXT) : String(params?.text || '').slice(0, MAX_TEXT)));
  const [items, setItems] = useState([]);
  const [aud, setAud] = useState(() => (editing ? editing.audience : (params?.audience ? _normAud(params.audience) : _defaultAud())));
  const [preview, setPreview] = useState(true);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [location, setLocation] = useState(null); // { name, latitude, longitude }
  const [locOpen, setLocOpen] = useState(false);
  const clientIdRef = useRef(newPostJobId());
  const doneRef = useRef(false);
  const mountedRef = useRef(true);
  const inputRef = useRef(null);
  const attRef = useRef(null);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // padrão "Quem vê minhas publicações" (perfil) — carrega do disco
  useEffect(() => {
    if (editId || params?.audience) return;
    try {
      const m = require('../../services/muralPrefs');
      m.loadDefaultAudience?.().then((v) => { if (mountedRef.current && v) setAud((cur) => (cur === 'public' ? _normAud(v) : cur)); }).catch(() => {});
    } catch {}
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // edição sem cópia local → busca
  const [editPost, setEditPost] = useState(editing);
  useEffect(() => {
    if (!editId || editPost) return;
    store.loadPost(editId).then((p) => {
      if (!mountedRef.current || !p) return;
      setEditPost(p);
      setText(String(p.caption || '').slice(0, MAX_TEXT));
      setAud(p.audience || 'public');
    });
  }, [editId]); // eslint-disable-line react-hooks/exhaustive-deps

  // conteúdo mudou → nova chave de idempotência
  useEffect(() => { clientIdRef.current = newPostJobId(); }, [items, aud, text]);

  const runPicker = useCallback(async (mode) => {
    const remaining = POST_MAX_ITEMS - items.length;
    if (remaining <= 0) { try { Alert.alert(t('mural.maxPhotos', 'Máximo de 10 fotos por publicação')); } catch {} return; }
    setPicking(true);
    let got = null;
    try { got = await pickPostMedia({ mode, limit: remaining }); } catch { got = null; }
    if (!mountedRef.current) return;
    setPicking(false);
    if (got && got.length) {
      setItems((prev) => prev.concat(got).slice(0, POST_MAX_ITEMS));
      setTimeout(() => { try { attRef.current?.scrollToEnd({ animated: true }); } catch {} }, 80);
    }
  }, [items.length, t]);

  // itens já escolhidos (Fotos / compartilhar) ou seletor automático (?pick=)
  useEffect(() => {
    if (editId) return undefined;
    let cancelled = false;
    const pre = takePendingPostItems();
    if (pre && pre.length) { setItems(pre.slice(0, POST_MAX_ITEMS)); return undefined; }
    if (pickParam === 'library' || pickParam === 'camera') {
      (async () => {
        await new Promise((r) => { try { InteractionManager.runAfterInteractions(() => r()); } catch { r(); } });
        await new Promise((r) => setTimeout(r, Platform.OS === 'ios' ? 420 : 120));
        if (!cancelled && mountedRef.current) runPicker(pickParam);
      })();
    } else if (Platform.OS !== 'web') {
      setTimeout(() => { if (!cancelled) inputRef.current?.focus(); }, Platform.OS === 'ios' ? 520 : 260);
    }
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const trimmed = text.trim();
  const media = editPost ? (editPost.media || []) : items;
  const hasContent = editPost ? (trimmed.length > 0 || media.length > 0) : (trimmed.length > 0 || items.length > 0);
  const changed = editPost ? (trimmed !== String(editPost.caption || '').trim() || aud !== editPost.audience) : hasContent;
  const canPublish = hasContent && changed && !busy && !(editPost && !media.length && !trimmed);

  const close = useCallback(() => {
    if (busy) return;
    const leave = () => { try { if (router.canGoBack()) router.back(); else router.replace('/chat'); } catch {} };
    if (!changed) { leave(); return; }
    Alert.alert(
      editPost ? t('mural.discardEditTitle', 'Descartar alterações?') : t('mural.discardTitle', 'Descartar publicação?'),
      editPost ? '' : t('mural.discardMsg', 'O texto e as fotos não serão salvos.'),
      [
        { text: t('mural.keepEditing', 'Continuar editando'), style: 'cancel' },
        { text: t('mural.discard', 'Descartar'), style: 'destructive', onPress: leave },
      ],
    );
  }, [busy, changed, editPost, router, t]);

  const publish = useCallback(async () => {
    if (!canPublish || doneRef.current) return;
    if (editPost) {
      setBusy(true);
      const r = await store.editPost(editPost.id, { text: trimmed !== String(editPost.caption || '').trim() ? trimmed : undefined, audience: aud !== editPost.audience ? aud : undefined });
      if (!mountedRef.current) return;
      setBusy(false);
      if (!r.ok) { try { Alert.alert(t('mural.err.save', 'Não foi possível salvar'), r.error || ''); } catch {} return; }
      doneRef.current = true;
      try { require('../ui/Toast').showToast({ message: t('mural.savedEdit', 'Publicação atualizada'), kind: 'success' }); } catch {}
      try { router.back(); } catch {}
      return;
    }
    const me = String(user?.email || '').trim();
    try {
      enqueueProfilePost({
        id: clientIdRef.current, email: me, items, caption: trimmed,
        audience: aud === 'public' ? 'everyone' : aud, aspect: 'orig',
        ...(location ? { location } : {}),
      });
    } catch (e) {
      try { Alert.alert(t('mural.err.publish', 'Não foi possível publicar'), e?.message || ''); } catch {}
      return;
    }
    doneRef.current = true;
    try { require('../../services/haptics').hapticEvent?.('send'); } catch {}
    try { require('../ui/Toast').showToast({ message: t('mural.published', 'Publicado no seu perfil'), kind: 'success' }); } catch {}
    try {
      if (fromParam === 'profile' || !me) router.back();
      else router.replace(`/u/${encodeURIComponent(me)}`);
    } catch {}
  }, [canPublish, editPost, trimmed, aud, user?.email, items, location, fromParam, router, t]);

  const addMenu = useCallback(() => {
    if (busy || picking) return;
    if (Platform.OS === 'web') { runPicker('library'); return; }
    showActionMenu({
      options: [
        { label: t('mural.gallery', 'Galeria'), onPress: () => setTimeout(() => runPicker('library'), Platform.OS === 'ios' ? 380 : 0) },
        { label: t('mural.camera', 'Câmera'), onPress: () => setTimeout(() => runPicker('camera'), Platform.OS === 'ios' ? 380 : 0) },
      ],
      cancelLabel: t('common.cancel', 'Cancelar'),
    });
  }, [busy, picking, runPicker, t]);

  const removeAt = useCallback((i) => setItems((prev) => prev.filter((_, j) => j !== i)), []);

  // ─── prévia (mesmos componentes da grade/lista do perfil) ───
  const myName = user?.name || user?.display_name || String(user?.email || '').split('@')[0];
  const myUser = user?.username || String(user?.email || '').split('@')[0];
  const draft = useMemo(() => ({
    id: 'draft',
    text: trimmed,
    kind: media.length ? (trimmed ? 'media_text' : 'media') : 'text',
    media: media.map((m) => ({ url: m.url || m.uri, thumb: m.thumb || m.uri || m.url, type: m.type === 'video' ? 'video' : 'image', w: m.w || m.width || 0, h: m.h || m.height || 0 })),
    created_at: new Date().toISOString(),
    audience: aud,
    like_count: 0, comment_count: 0, liked_by_me: false, allow_comments: true,
    author: { email: user?.email || '', name: myName, username: myUser },
    style: 'ink',
  }), [trimmed, media, aud, user?.email, myName, myUser]);
  const tg = _tg();
  const pvLabel = media.length ? (trimmed ? t('mural.pv.both', 'foto + texto') : t('mural.pv.photo', 'só foto')) : (trimmed ? t('mural.pv.text', 'só texto') : '');
  const hint = aud === 'contacts' ? t('mural.hint.contacts', 'Só seus contatos salvos verão este post.')
    : aud === 'private' ? t('mural.hint.private', 'Fica salvo só para você, como um rascunho privado.')
      : t('mural.hint.public', 'Qualquer pessoa que abrir seu perfil verá este post.');

  const LocationPicker = useMemo(() => { try { return require('../LocationPickerSheet').default; } catch { return null; } }, []);
  const themeCtx = useTheme();

  const chip = (on) => ({ flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingLeft: 8, paddingRight: 10, borderRadius: 999, backgroundColor: on ? th.accent : th.chip });
  const tool = (on) => ({ flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 9, paddingHorizontal: 13, borderRadius: 12, backgroundColor: on ? th.accent : th.chip });

  return (
    <View style={{ flex: 1, backgroundColor: th.card }}>
      <StatusBar barStyle={th.isDark ? 'light-content' : 'dark-content'} />
      <View style={{ paddingTop: insets.top + (Platform.OS === 'ios' ? 4 : 8), paddingHorizontal: 12, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: th.card, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: th.line }}>
        <Pressable onPress={close} disabled={busy} hitSlop={10} style={{ paddingVertical: 6, paddingRight: 12, paddingLeft: 4, minWidth: 80 }} accessibilityRole="button">
          <Text style={{ color: th.text, fontSize: 15, fontWeight: '500' }}>{t('common.cancel', 'Cancelar')}</Text>
        </Pressable>
        <Text style={{ color: th.text, fontSize: 16, fontWeight: '700' }} numberOfLines={1}>{editPost ? t('mural.editPost', 'Editar publicação') : t('mural.newPost', 'Nova publicação')}</Text>
        <View style={{ minWidth: 80, alignItems: 'flex-end' }}>
          <Pressable onPress={publish} disabled={!canPublish} accessibilityRole="button" accessibilityState={{ disabled: !canPublish }}
            style={({ pressed }) => ({ backgroundColor: th.accent, paddingVertical: 7, paddingHorizontal: 16, borderRadius: 999, opacity: !canPublish ? 0.3 : pressed ? 0.75 : 1, minWidth: 84, alignItems: 'center' })}>
            {busy ? <ActivityIndicator size="small" color={th.accentInk} /> : <Text style={{ color: th.accentInk, fontWeight: '700', fontSize: 14.5 }}>{editPost ? t('mural.save', 'Salvar') : t('mural.publish', 'Publicar')}</Text>}
          </Pressable>
        </View>
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={{ paddingBottom: 40 + insets.bottom, maxWidth: 680, width: '100%', alignSelf: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 14 }}>
            <Avatar email={user?.email} name={myName} size={44} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: th.text, fontSize: 15, fontWeight: '700' }} numberOfLines={1}>{myName}</Text>
              <View style={{ flexDirection: 'row', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
                {AUDS.map((k) => {
                  const on = aud === k;
                  return (
                    <Pressable key={k} onPress={() => setAud(k)} style={chip(on)} accessibilityRole="button" accessibilityState={{ selected: on }}>
                      <MIcon name={audienceIcon(k)} size={14} color={on ? th.accentInk : th.muted} />
                      <Text style={{ fontSize: 12.5, fontWeight: '600', color: on ? th.accentInk : th.muted }}>
                        {k === 'contacts' ? t('mural.aud.contacts', 'Contatos') : k === 'private' ? t('mural.aud.private', 'Só eu') : t('mural.aud.public', 'Todos')}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </View>

          <TextInput
            ref={inputRef}
            value={text}
            onChangeText={(v) => setText(v.slice(0, MAX_TEXT))}
            maxLength={MAX_TEXT}
            multiline
            placeholder={t('mural.whatsOnMind', 'No que você está pensando?')}
            placeholderTextColor={th.muted}
            editable={!busy}
            style={{ color: th.text, fontSize: 19, lineHeight: 26, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6, minHeight: 120, textAlignVertical: 'top' }}
            accessibilityLabel={t('mural.whatsOnMind', 'No que você está pensando?')}
          />
          <Text style={{ textAlign: 'right', paddingHorizontal: 16, fontSize: 12, color: text.length > MAX_TEXT - 50 ? th.danger : th.muted }}>{`${text.length}/${MAX_TEXT}`}</Text>

          {(media.length > 0 || !editPost) ? (
            <ScrollView ref={attRef} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 12 }}>
              {media.map((m, i) => (
                <View key={m.id || m.url || `${i}`} style={{ width: 140, aspectRatio: 3 / 4, borderRadius: 14, overflow: 'hidden', backgroundColor: th.chip }}>
                  <ExpoImage source={{ uri: m.thumb || m.uri || m.url }} style={StyleSheet.absoluteFill} contentFit="cover" />
                  {m.type === 'video' ? <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }} pointerEvents="none"><MIcon name="play" size={28} color="#fff" fill="#fff" strokeWidth={1} /></View> : null}
                  {!editPost ? (
                    <Pressable onPress={() => removeAt(i)} hitSlop={8} style={{ position: 'absolute', right: 6, top: 6, width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={t('mural.removePhoto', 'Remover foto')}>
                      <MIcon name="x" size={14} color="#fff" strokeWidth={2.4} />
                    </Pressable>
                  ) : null}
                  <View style={{ position: 'absolute', left: 8, bottom: 7, backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999 }}>
                    <Text style={{ color: '#fff', fontSize: 11.5, fontWeight: '700' }}>{`${i + 1}/${media.length}`}</Text>
                  </View>
                </View>
              ))}
              {!editPost && items.length < POST_MAX_ITEMS ? (
                <Pressable onPress={addMenu} disabled={picking || busy} accessibilityRole="button" accessibilityLabel={t('mural.addPhoto', 'Foto')}
                  style={({ pressed }) => ({ width: 100, aspectRatio: 3 / 4, borderRadius: 14, borderWidth: 1.5, borderStyle: 'dashed', borderColor: th.muted, alignItems: 'center', justifyContent: 'center', gap: 4, opacity: pressed ? 0.6 : 1 })}>
                  {picking ? <ActivityIndicator color={th.muted} /> : <MIcon name="plus" size={24} color={th.muted} />}
                  <Text style={{ color: th.muted, fontSize: 12.5, fontWeight: '600' }}>{t('mural.addPhoto', 'Foto')}</Text>
                </Pressable>
              ) : null}
            </ScrollView>
          ) : null}

          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 6, flexWrap: 'wrap' }}>
            {!editPost ? (
              <>
                <Pressable onPress={() => runPicker('library')} disabled={picking || busy} style={tool(false)} accessibilityRole="button">
                  <MIcon name="image" size={18} color={th.text} />
                  <Text style={{ color: th.text, fontWeight: '600', fontSize: 14 }}>{t('mural.gallery', 'Galeria')}</Text>
                </Pressable>
                {Platform.OS !== 'web' ? (
                  <Pressable onPress={() => runPicker('camera')} disabled={picking || busy} style={tool(false)} accessibilityRole="button">
                    <MIcon name="camera" size={18} color={th.text} />
                    <Text style={{ color: th.text, fontWeight: '600', fontSize: 14 }}>{t('mural.camera', 'Câmera')}</Text>
                  </Pressable>
                ) : null}
                {LocationPicker && Platform.OS !== 'web' ? (
                  <Pressable onPress={() => (location ? setLocation(null) : setLocOpen(true))} style={tool(!!location)} accessibilityRole="button" accessibilityState={{ selected: !!location }}>
                    <MIcon name="pin" size={18} color={location ? th.accentInk : th.text} />
                    <Text style={{ color: location ? th.accentInk : th.text, fontWeight: '600', fontSize: 14, maxWidth: 160 }} numberOfLines={1}>{location ? location.name : t('mural.location', 'Local')}</Text>
                    {location ? <MIcon name="x" size={14} color={th.accentInk} /> : null}
                  </Pressable>
                ) : null}
              </>
            ) : null}
            <Pressable onPress={() => setPreview((v) => !v)} style={tool(preview)} accessibilityRole="button" accessibilityState={{ selected: preview }}>
              <MIcon name="eye" size={18} color={preview ? th.accentInk : th.text} />
              <Text style={{ color: preview ? th.accentInk : th.text, fontWeight: '600', fontSize: 14 }}>{t('mural.preview', 'Prévia')}</Text>
            </Pressable>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, marginHorizontal: 16, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: th.bg }}>
            <MIcon name={audienceIcon(aud)} size={18} color={th.muted} />
            <Text style={{ flex: 1, color: th.muted, fontSize: 13, lineHeight: 18 }}>{`${hint} ${t('mural.hint.textTile', 'Texto sozinho vira um quadrado tipográfico na grade.')}`}</Text>
          </View>

          {preview ? (
            <View style={{ marginTop: 18, paddingTop: 14, paddingBottom: 18, backgroundColor: th.bg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: th.line }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 18, paddingBottom: 10 }}>
                <Text style={{ color: th.muted, fontSize: 12.5, letterSpacing: 0.5 }}>{t('mural.pv.title', 'PRÉVIA NO MURAL')}</Text>
                <Text style={{ color: th.muted, fontSize: 12.5, letterSpacing: 0.5 }}>{pvLabel.toUpperCase()}</Text>
              </View>
              {hasContent ? (
                <>
                  {tg && tg.PostCard ? (
                    <View pointerEvents="none">
                      <tg.PostCard post={draft} th={th} lang={language} author={{ name: myName, username: myUser, avatar: (sz) => <Avatar email={user?.email} name={myName} size={sz} /> }}
                        onOpen={() => {}} onLike={() => {}} onComments={() => {}} onShare={() => {}} onMore={() => {}} onBookmark={() => {}} bookmarked={false} />
                    </View>
                  ) : null}
                  <Text style={{ color: th.muted, fontSize: 12.5, letterSpacing: 0.5, paddingHorizontal: 18, paddingTop: 14 }}>{t('mural.pv.grid', 'NA GRADE')}</Text>
                  {tg && tg.GridRow ? (
                    <View pointerEvents="none" style={{ marginTop: 10, marginLeft: 18, width: Math.round(contentW / 2) }}>
                      <tg.GridRow row={[draft]} width={Math.round(contentW / 2)} th={th} lang={language} onPress={() => {}} />
                    </View>
                  ) : null}
                </>
              ) : (
                <View style={{ marginHorizontal: 10, padding: 20, borderRadius: 18, borderWidth: 1.5, borderStyle: 'dashed', borderColor: th.line, alignItems: 'center' }}>
                  <Text style={{ color: th.muted, fontSize: 13.5, textAlign: 'center' }}>{t('mural.pv.empty', 'Escreva algo ou adicione uma foto para ver a prévia.')}</Text>
                </View>
              )}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
      {LocationPicker && locOpen ? (
        <LocationPicker visible={locOpen} onClose={() => setLocOpen(false)} colors={themeCtx?.colors} t={t}
          onSend={({ latitude, longitude, address }) => {
            setLocOpen(false);
            setLocation({ name: address || t('mural.location', 'Local'), latitude, longitude });
          }} />
      ) : null}
    </View>
  );
}
