// app/group-new-details.js — [2026-10-15 native-group-create]
//
// Novo grupo (passo 2) / Novo canal — tela de DETALHES nível WhatsApp:
//   foto (câmera nativa / galeria → editor nativo com recorte circular),
//   nome com contador, descrição, mensagens temporárias, permissões
//   (quem envia / quem edita os dados), "Criar" com haptic e transição DIRETA
//   para a conversa nova (a conversa substitui Nova conversa + Detalhes na
//   pilha; o 1º quadro já vem do handoff → sem tela branca).
// Linhas = lista agrupada NATIVA (ChatyySettingsList, a mesma das Ajustes);
// foto/nome/descrição = cabeçalho RN (TextInput nativo) que rola junto.
//
// Endpoints = os mesmos de antes: chat_create (+disappearing_seconds, que o
// servidor já aceitava) / chat_create_channel; depois, sem bloquear a
// navegação: chat_upload + chat_update(avatar_url) (foto), chat_update_group
// (descrição), chat_group_set_admin_only (só admins enviam),
// chat_group_admin {email, permissions:{edit_info}} (todos editam os dados).
//
// Só é aberta com o fluxo nativo ligado (components/groupCreate/
// groupCreateDraft.js → nativeGroupCreateEnabled). Rascunho vazio (reload
// nesta rota) → volta.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, Platform, Pressable, ActivityIndicator,
  ActionSheetIOS, Keyboard,
} from 'react-native';
import { Stack, useRouter, useNavigation } from 'expo-router';
import { Image as ExpoImage } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import * as api from '../services/api';
import { haptic } from '../constants/theme';
import { nativeHeaderOptions } from '../components/nativeHeader';
import { IconCamera } from '../components/Icons';
import NativeSettingsList from '../components/settings/NativeSettingsList';
import { useGroupedColors } from '../components/settings/SettingsKit';
import { NativeSheetModal } from '../components/NativeSheet';
import { getGroupDraft, clearGroupDraft, markNativeGroupCreateFailed } from '../components/groupCreate/groupCreateDraft';
import { pickGroupPhoto } from '../components/groupCreate/pickGroupPhoto';
import { safeAlert } from '../services/alerts';

const NAME_MAX = 60;   // chat_update/chat_update_group cortam em 60
const DESC_MAX = 500;  // idem (descrição)
const TIMERS = [0, 86400, 604800, 7776000];

function displayName(m) {
  const n = String(m?.name || '').trim();
  if (n && !n.includes('@')) return n;
  return String(m?.email || n || '').split('@')[0];
}

export default function GroupNewDetailsScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const g = useGroupedColors();
  const T = useCallback((k, fb, vars) => {
    let s;
    try { s = t(k, vars); } catch { s = null; }
    if (!s || s === k) s = fb;
    if (vars) for (const v of Object.keys(vars)) s = String(s).split(`{${v}}`).join(String(vars[v]));
    return s;
  }, [t]);

  const draftRef = useRef(getGroupDraft());
  const draft = draftRef.current;
  const isChannel = draft.kind === 'channel';
  const members = draft.members || [];

  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [nameError, setNameError] = useState(false);
  const [photo, setPhoto] = useState(null); // { uri, name, type }
  const [timer, setTimer] = useState(null); // null = padrão do usuário (não envia)
  const [defaultTimer, setDefaultTimer] = useState(0);
  const [membersCanSend, setMembersCanSend] = useState(true);
  const [membersCanEdit, setMembersCanEdit] = useState(false);
  const [isPublic, setIsPublic] = useState(true);
  const [creating, setCreating] = useState(false);
  const [timerSheet, setTimerSheet] = useState(false);
  const [nativeFailed, setNativeFailed] = useState(false);
  const nameRef = useRef(null);
  const creatingRef = useRef(false);

  // Rascunho vazio (reload direto nesta rota) → nada a criar.
  useEffect(() => {
    if (!isChannel && members.length === 0) { try { router.back(); } catch {} }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Timer padrão do usuário (o chat_create aplica sozinho quando não mandamos nada).
  useEffect(() => {
    if (isChannel) return;
    let alive = true;
    api.chatUserDefaultsGet?.().then(r => {
      const v = Number(r?.data?.default_disappearing_seconds ?? r?.data?.default_disappearing ?? 0) || 0;
      if (alive) setDefaultTimer(v);
    }).catch(() => {});
    return () => { alive = false; };
  }, [isChannel]);

  const effTimer = timer == null ? defaultTimer : timer;
  const timerLabel = useCallback((s) => {
    if (!s) return T('groupNew.off', 'Desativadas');
    if (s === 86400) return T('groupNew.h24', '24 horas');
    if (s === 604800) return T('groupNew.d7', '7 dias');
    if (s === 7776000) return T('groupNew.d90', '90 dias');
    if (s === 2592000) return T('groupNew.d30', '30 dias');
    if (s === 3600) return T('groupNew.h1', '1 hora');
    if (s === 300) return T('groupNew.m5', '5 minutos');
    return `${Math.round(s / 3600)} h`;
  }, [T]);

  // ── Foto ────────────────────────────────────────────────────────────────
  const pick = useCallback(async (source) => {
    try {
      const r = await pickGroupPhoto(source, t);
      if (!r) return;
      if (r.denied) {
        safeAlert(T('chatConv.permission', 'Permissão'), T('chatConv.galleryPermission', 'Permita o acesso nas configurações.'));
        return;
      }
      setPhoto(r);
      haptic.light();
    } catch {}
  }, [t, T]);

  const openPhotoMenu = useCallback(() => {
    Keyboard.dismiss();
    const opts = [T('groupNew.photoTake', 'Tirar foto'), T('groupNew.photoChoose', 'Escolher da galeria')];
    if (photo) opts.push(T('groupNew.photoRemove', 'Remover foto'));
    if (Platform.OS === 'ios') {
      opts.push(T('common.cancel', 'Cancelar'));
      ActionSheetIOS.showActionSheetWithOptions({
        options: opts,
        cancelButtonIndex: opts.length - 1,
        destructiveButtonIndex: photo ? 2 : undefined,
        userInterfaceStyle: isDark ? 'dark' : 'light',
      }, (i) => {
        if (i === 0) pick('camera');
        else if (i === 1) pick('library');
        else if (photo && i === 2) setPhoto(null);
      });
      return;
    }
    const btns = [
      { text: opts[0], onPress: () => pick('camera') },
      { text: opts[1], onPress: () => pick('library') },
    ];
    if (photo) btns.push({ text: opts[2], style: 'destructive', onPress: () => setPhoto(null) });
    safeAlert(T('groupNew.photoAdd', 'Foto do grupo'), '', btns);
  }, [T, photo, pick, isDark]);

  // ── Criar ───────────────────────────────────────────────────────────────
  const trimmedName = name.trim();
  const canCreate = !creating && (isChannel ? !!trimmedName : (members.length > 0 && (!!trimmedName || members.length > 1)));

  const goToConversation = useCallback((conv) => {
    const params = { id: String(conv.id), name: conv.name || '', type: conv.type };
    try { require('../utils/chatOpenHandoff').stashOpenConversation(conv); } catch {}
    // A conversa SUBSTITUI "Nova conversa" + "Detalhes" (WhatsApp): voltar dela
    // cai na lista de conversas. Um reset só = um push nativo, sem frame vazio.
    try {
      const { CommonActions } = require('@react-navigation/native');
      const state = navigation.getState?.();
      const routes = Array.isArray(state?.routes) ? state.routes : null;
      if (routes && routes.some(r => r && r.name === 'group-new-details')) {
        const kept = routes.filter(r => r && r.name !== 'group-new-details' && r.name !== 'chat-new');
        if (kept.length > 0) {
          const next = [...kept, { key: `chat-conversation-${conv.id}-${Date.now()}`, name: 'chat-conversation', params }];
          navigation.dispatch(CommonActions.reset({ ...state, routes: next, index: next.length - 1 }));
          return;
        }
      }
    } catch {}
    require('../services/openConversation').openConversation({ pathname: '/chat-conversation', params }, { replace: true });
  }, [navigation]);

  const runPostCreate = useCallback(async (convId) => {
    // Nada aqui bloqueia a navegação; cada passo é best-effort (o grupo já existe).
    if (photo) {
      try {
        const up = await api.chatUploadFile(convId, photo, '', false, null, 'image', null, true);
        const fileUrl = up?.data?.file_url || up?.data?.url || up?.data?.message?.file_url;
        if (fileUrl) await api.chatUpdate(convId, { avatar_url: fileUrl });
      } catch {}
    }
    if (isChannel) return;
    const d = desc.trim();
    if (d) { try { await api.chatUpdateGroup(convId, { description: d }); } catch {} }
    if (!membersCanSend) { try { await api.chatGroupSetAdminOnly(convId, true); } catch {} }
    if (membersCanEdit) {
      // edit_info é por membro (chat_group_admin); 4 por vez.
      const queue = members.map(m => m.email).filter(Boolean);
      const worker = async () => {
        while (queue.length) {
          const em = queue.shift();
          try { await api.chatGroupAdmin(convId, { email: em, permissions: { edit_info: true } }); } catch {}
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    }
  }, [photo, isChannel, desc, membersCanSend, membersCanEdit, members]);

  const create = useCallback(async () => {
    if (creatingRef.current) return;
    if (!isChannel && members.length === 0) return;
    if (!trimmedName && (isChannel || members.length === 1)) {
      setNameError(true);
      haptic.error();
      try { nameRef.current?.focus?.(); } catch {}
      return;
    }
    const finalName = trimmedName || members.slice(0, 3).map(m => api.emailToDisplayName ? api.emailToDisplayName(m.name || m.email) : displayName(m)).join(', ');
    creatingRef.current = true;
    setCreating(true);
    haptic.medium();
    Keyboard.dismiss();
    try {
      let r;
      if (isChannel) {
        r = await api.chatCreateChannel(finalName, desc.trim(), isPublic);
      } else {
        const extra = timer != null ? { disappearing_seconds: timer } : null;
        r = await api.chatCreate(members.map(m => m.email), finalName, 'group', extra);
      }
      const convId = r?.data?.conversation_id || r?.data?.id;
      if (r?.success && convId) {
        haptic.success();
        const type = isChannel ? 'channel' : 'group';
        const conv = {
          id: convId,
          type,
          name: r.data?.name || finalName,
          member_count: isChannel ? 1 : members.length + 1,
          ...(photo?.uri ? { avatar_url: photo.uri } : {}),
          ...(!isChannel && desc.trim() ? { description: desc.trim() } : {}),
        };
        clearGroupDraft();
        try { require('../components/mascot/ConfettiHost').celebrate({ y: 0.42 }); } catch {} // [2026-10-16 mascote]
        runPostCreate(convId);
        goToConversation(conv);
        return;
      }
      haptic.error();
      safeAlert(T('common.error', 'Erro'), r?.message || T(isChannel ? 'common.genericError' : 'chat.createGroupError', 'Não foi possível criar.'));
    } catch {
      haptic.error();
      safeAlert(T('common.error', 'Erro'), T('common.networkError', 'Erro de rede'));
    }
    creatingRef.current = false;
    setCreating(false);
  }, [isChannel, members, trimmedName, desc, isPublic, timer, photo, T, runPostCreate, goToConversation]);

  // ── Linhas nativas ──────────────────────────────────────────────────────
  const rows = useMemo(() => {
    const out = [];
    if (isChannel) {
      out.push({ id: 'public', k: 't', sid: 'vis', hd: T('groupNew.visibility', 'Visibilidade'), title: T('groupNew.channelPublic', 'Canal público'), sub: T('groupNew.channelPublicDesc', 'Qualquer pessoa pode encontrar e seguir'), on: isPublic });
      return out;
    }
    out.push({ id: 'timer', k: 'a', sid: 'cfg', hd: T('groupNew.settings', 'Configurações do grupo'), title: T('groupNew.disappearing', 'Mensagens temporárias'), sub: timerLabel(effTimer) });
    out.push({ id: 'canSend', k: 't', sid: 'perm', hd: T('groupNew.permissions', 'Os membros podem'), title: T('groupNew.permSend', 'Enviar mensagens'), on: membersCanSend });
    out.push({ id: 'canEdit', k: 't', sid: 'perm', title: T('groupNew.permEditInfo', 'Editar dados do grupo'), on: membersCanEdit });
    out.push({ id: 'members', k: 'a', sid: 'mem', hd: T('groupNew.members', 'Membros'), title: members.slice(0, 4).map(displayName).join(', ') + (members.length > 4 ? '…' : ''), sub: T('groupNew.membersCount', '{count} membros', { count: members.length + 1 }) });
    return out;
  }, [isChannel, isPublic, effTimer, membersCanSend, membersCanEdit, members, T, timerLabel]);

  const onRowPress = useCallback((id) => {
    if (id === 'timer') {
      Keyboard.dismiss();
      if (Platform.OS === 'ios') {
        const labels = TIMERS.map(timerLabel);
        labels.push(T('common.cancel', 'Cancelar'));
        ActionSheetIOS.showActionSheetWithOptions({
          title: T('groupNew.disappearing', 'Mensagens temporárias'),
          options: labels,
          cancelButtonIndex: labels.length - 1,
          userInterfaceStyle: isDark ? 'dark' : 'light',
        }, (i) => { if (i >= 0 && i < TIMERS.length) { setTimer(TIMERS[i]); haptic.select(); } });
      } else {
        setTimerSheet(true);
      }
    } else if (id === 'members') {
      try { router.back(); } catch {}
    }
  }, [T, timerLabel, isDark, router]);

  const onToggle = useCallback((id, value) => {
    if (id === 'canSend') setMembersCanSend(!!value);
    else if (id === 'canEdit') setMembersCanEdit(!!value);
    else if (id === 'public') setIsPublic(!!value);
  }, []);

  const onFailure = useCallback((msg) => {
    markNativeGroupCreateFailed(msg);
    setNativeFailed(true);
  }, []);

  // ── Cabeçalho (foto + nome + descrição) ─────────────────────────────────
  const fieldBg = g.cardBg;
  const header = (
    <View style={styles.headerWrap}>
      <Pressable
        onPress={openPhotoMenu}
        style={({ pressed }) => [styles.photo, { backgroundColor: g.fill, transform: [{ scale: pressed ? 0.96 : 1 }] }]}
        accessibilityRole="button"
        accessibilityLabel={T('groupNew.photoAdd', 'Foto do grupo')}
      >
        {/* [2026-10-16 native-wave7] A foto ia POR CIMA do selo da câmera: a ExpoImage
            (view nativa) não fica recortada pelo círculo do Pressable (sem overflow) e
            no Android/Fabric podia subir acima do irmão absoluto. Agora a foto mora
            numa camada própria recortada (absoluteFill + overflow hidden) e o selo
            tem zIndex/elevation explícitos — sempre por cima. */}
        {photo?.uri ? (
          <View style={styles.photoClip} pointerEvents="none">
            <ExpoImage source={{ uri: photo.uri }} style={styles.photoImg} contentFit="cover" transition={150} />
          </View>
        ) : (
          <IconCamera size={30} color={g.secondary} />
        )}
        <View style={[styles.photoBadge, { backgroundColor: g.ink, borderColor: g.pageBg }]} pointerEvents="none">
          <IconCamera size={13} color={g.onInk} />
        </View>
      </Pressable>
      <View style={[styles.card, { backgroundColor: fieldBg }]}>
        <View style={styles.nameRow}>
          <TextInput
            ref={nameRef}
            style={[styles.nameInput, { color: g.text }]}
            placeholder={isChannel ? T('groupNew.channelNamePlaceholder', 'Nome do canal') : T('groupNew.namePlaceholder', 'Nome do grupo')}
            placeholderTextColor={g.secondary}
            value={name}
            onChangeText={(v) => { setName(v); if (nameError && v.trim()) setNameError(false); }}
            maxLength={NAME_MAX}
            autoFocus={false}
            returnKeyType="next"
            accessibilityLabel={isChannel ? T('groupNew.channelNamePlaceholder', 'Nome do canal') : T('groupNew.namePlaceholder', 'Nome do grupo')}
          />
          <Text style={[styles.counter, { color: name.length >= NAME_MAX ? g.destructive : g.secondary }]}>{NAME_MAX - name.length}</Text>
        </View>
        <View style={[styles.sep, { backgroundColor: g.separator }]} />
        <View style={styles.descRow}>
          <TextInput
            style={[styles.descInput, { color: g.text }]}
            placeholder={T('groupNew.descPlaceholder', 'Descrição (opcional)')}
            placeholderTextColor={g.secondary}
            value={desc}
            onChangeText={setDesc}
            maxLength={DESC_MAX}
            multiline
            accessibilityLabel={T('groupNew.descPlaceholder', 'Descrição (opcional)')}
          />
          {desc.length > DESC_MAX - 100 ? (
            <Text style={[styles.counter, { color: g.secondary }]}>{DESC_MAX - desc.length}</Text>
          ) : null}
        </View>
      </View>
      {nameError ? (
        <Text style={[styles.error, { color: g.destructive }]} accessibilityLiveRegion="polite">
          {T('groupNew.nameRequired', 'Dê um nome ao grupo')}
        </Text>
      ) : null}
    </View>
  );

  const title = isChannel ? T('groupNew.channelTitle', 'Novo canal') : T('groupNew.title', 'Novo grupo');
  const headerRight = () => (
    <Pressable
      onPress={create}
      disabled={!canCreate}
      hitSlop={10}
      style={({ pressed }) => ({ opacity: !canCreate ? 0.35 : (pressed ? 0.5 : 1), paddingHorizontal: Platform.OS === 'ios' ? 4 : 8 })}
      accessibilityRole="button"
      accessibilityLabel={T('groupNew.create', 'Criar')}
    >
      {creating ? (
        <ActivityIndicator size="small" color={g.text} />
      ) : (
        <Text style={{ color: g.text, fontSize: 17, fontWeight: '600' }}>{T('groupNew.create', 'Criar')}</Text>
      )}
    </Pressable>
  );

  const sheet = (
    <NativeSheetModal
      visible={timerSheet}
      onRequestClose={() => setTimerSheet(false)}
      transparent
      animationType="fade"
      backgroundColor={g.cardBg}
      nativeContent={() => (
        <View style={[styles.sheet, { backgroundColor: g.cardBg, paddingBottom: Math.max(16, insets.bottom) }]}>
          <Text style={[styles.sheetTitle, { color: g.text }]}>{T('groupNew.disappearing', 'Mensagens temporárias')}</Text>
          {TIMERS.map(s => (
            <Pressable
              key={s}
              onPress={() => { setTimer(s); haptic.select(); setTimerSheet(false); }}
              android_ripple={{ color: g.fill }}
              style={styles.sheetRow}
              accessibilityRole="radio"
              accessibilityState={{ checked: effTimer === s }}
            >
              <Text style={[styles.sheetRowText, { color: g.text }]}>{timerLabel(s)}</Text>
              <View style={[styles.radio, { borderColor: effTimer === s ? g.ink : g.tertiary }]}>
                {effTimer === s ? <View style={[styles.radioDot, { backgroundColor: g.ink }]} /> : null}
              </View>
            </Pressable>
          ))}
        </View>
      )}
    >
      <Pressable style={styles.backdrop} onPress={() => setTimerSheet(false)}>
        <View style={[styles.sheet, styles.sheetFallback, { backgroundColor: g.cardBg }]}>
          <Text style={[styles.sheetTitle, { color: g.text }]}>{T('groupNew.disappearing', 'Mensagens temporárias')}</Text>
          {TIMERS.map(s => (
            <Pressable key={s} onPress={() => { setTimer(s); setTimerSheet(false); }} style={styles.sheetRow}>
              <Text style={[styles.sheetRowText, { color: g.text }]}>{timerLabel(s)}</Text>
              <View style={[styles.radio, { borderColor: effTimer === s ? g.ink : g.tertiary }]}>
                {effTimer === s ? <View style={[styles.radioDot, { backgroundColor: g.ink }]} /> : null}
              </View>
            </Pressable>
          ))}
        </View>
      </Pressable>
    </NativeSheetModal>
  );

  return (
    <View style={[styles.root, { backgroundColor: g.pageBg }]}>
      <Stack.Screen options={nativeHeaderOptions({
        colors: { ...colors, headerBgSolid: g.pageBg, background: g.pageBg },
        title,
        headerRight,
      })} />
      {!nativeFailed ? (
        <NativeSettingsList
          rows={rows}
          query=""
          header={header}
          isDark={isDark}
          palette={g}
          bottomInset={insets.bottom + 24}
          onRowPress={onRowPress}
          onToggle={onToggle}
          onFailure={onFailure}
        />
      ) : (
        // Fallback (erro nativo nesta sessão): mesmos controles em RN puro.
        <FallbackBody header={header} rows={rows} g={g} onRowPress={onRowPress} onToggle={onToggle} />
      )}
      {Platform.OS !== 'ios' ? sheet : null}
    </View>
  );
}

function FallbackBody({ header, rows, g, onRowPress, onToggle }) {
  const { ScrollView, Switch } = require('react-native');
  let lastSid = '';
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      {header}
      {rows.map((r, i) => {
        const showHd = r.sid !== lastSid && r.hd;
        // [2026-10-17 wa-polish] cartão agrupado de verdade: só a 1ª/última linha
        // da seção arredondam e as do meio ganham separador recuado (antes cada
        // linha era uma pílula solta com 1 px de vão).
        const first = r.sid !== lastSid;
        const last = !rows[i + 1] || rows[i + 1].sid !== r.sid;
        lastSid = r.sid;
        return (
          <View key={r.id}>
            {showHd ? <Text style={[styles.fbHd, { color: g.header }]}>{r.hd}</Text> : null}
            {!first ? <View style={{ backgroundColor: g.cardBg }}><View style={[styles.fbSep, { backgroundColor: g.separator }]} /></View> : null}
            <Pressable
              onPress={() => (r.k === 't' ? onToggle(r.id, !r.on) : onRowPress(r.id))}
              style={[styles.fbRow, { backgroundColor: g.cardBg }, first && styles.fbFirst, last && styles.fbLast, first && !showHd && { marginTop: 20 }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: g.text, fontSize: 16 }} numberOfLines={1}>{r.title}</Text>
                {r.sub ? <Text style={{ color: g.secondary, fontSize: 13, marginTop: 2 }} numberOfLines={2}>{r.sub}</Text> : null}
              </View>
              {r.k === 't' ? <Switch value={!!r.on} onValueChange={(v) => onToggle(r.id, v)} /> : null}
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerWrap: { alignItems: 'stretch', paddingBottom: 8 },
  photo: {
    width: 104, height: 104, borderRadius: 52, alignSelf: 'center',
    alignItems: 'center', justifyContent: 'center', marginTop: 8, marginBottom: 20,
  },
  photoClip: { ...StyleSheet.absoluteFillObject, borderRadius: 52, overflow: 'hidden', zIndex: 0 },
  photoImg: { width: 104, height: 104 },
  photoBadge: {
    position: 'absolute', right: 0, bottom: 2, width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', borderWidth: 2.5,
    zIndex: 2, elevation: 4,
  },
  card: { borderRadius: 18, overflow: 'hidden' },
  nameRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, minHeight: 52 },
  nameInput: { flex: 1, fontSize: 17, paddingVertical: Platform.OS === 'ios' ? 14 : 10 },
  counter: { fontSize: 13, marginLeft: 8, fontVariant: ['tabular-nums'] },
  sep: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  descRow: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 16 },
  descInput: { flex: 1, fontSize: 16, minHeight: 48, maxHeight: 140, paddingTop: 14, paddingBottom: 14, textAlignVertical: 'top' },
  error: { fontSize: 13, marginTop: 8, marginHorizontal: 16 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { paddingTop: 16 },
  sheetFallback: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 24 },
  sheetTitle: { fontSize: 17, fontWeight: '700', paddingHorizontal: 20, paddingBottom: 8 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, minHeight: 52 },
  sheetRowText: { flex: 1, fontSize: 16 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 11, height: 11, borderRadius: 6 },
  fbHd: { fontSize: 13, fontWeight: '600', marginTop: 20, marginBottom: 6, marginLeft: 16 },
  fbRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, minHeight: 50 },
  fbFirst: { borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  fbLast: { borderBottomLeftRadius: 14, borderBottomRightRadius: 14 },
  fbSep: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
});
