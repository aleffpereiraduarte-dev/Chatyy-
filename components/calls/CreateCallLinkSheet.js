// components/calls/CreateCallLinkSheet.js — [call-link 2026-10-19] "Criar link de chamada"
// nível WhatsApp, P&B premium.
//
//   form → Vídeo | Áudio + nome opcional → Criar
//   done → o link (chatyy.com.br/c/xxxx-xxxx-xxxx) + Copiar link · Compartilhar ·
//          Enviar no Chatyy · Entrar agora
//   send → escolher conversas/grupos (cache local primeiro, até 5) → manda a
//          mensagem de texto com a URL (clientes novos desenham o cartão
//          CallLinkCard; antigos veem o link clicável).
// Servidor: chat_create_call_link { call_type, title } → { link_id, code, url, … }.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Share, Text, TextInput, View } from 'react-native';
import Sheet, { useOverlayColors } from '../ui/Sheet';
import { showToast } from '../ui/Toast';
import AvatarCircle from '../AvatarCircle';
import {
  IconCopy, IconShare, IconSend, IconVideo, IconPhone, IconCheck, IconSearch, IconChevronLeft, IconLink,
} from '../Icons';
import { addMyCallLink } from './myCallLinks';
import { buildCallLinkMessage, callLinkRoute, copyText } from './callLinkUtil';

const MAX_SEND = 5;

function tr(t, key, fb, params) {
  let v;
  try { v = t?.(key, params); } catch {}
  if (v && v !== key) return v;
  let s = fb;
  if (params) Object.keys(params).forEach((k) => { s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(params[k])); });
  return s;
}

function readLocalConversations() {
  try {
    const l = require('../../services/chatStore').getConversationsSync?.();
    if (Array.isArray(l) && l.length) return l;
  } catch {}
  try {
    const l = require('../../services/smartChatCache').getCachedConversationsSync?.();
    if (Array.isArray(l) && l.length) return l;
  } catch {}
  return [];
}
function _ts(c) {
  const v = c?.last_message_at || c?.updated_at || c?.created_at || 0;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}
function normalize(list) {
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || c.id == null || seen.has(String(c.id))) continue;
    if (c.type === 'channel' || c.archived) continue;
    seen.add(String(c.id));
    out.push(c);
  }
  return out.sort((a, b) => _ts(b) - _ts(a));
}

function BigAction({ icon: Icon, label, onPress, oc, testID }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      style={({ pressed }) => ({
        flex: 1, minHeight: 84, borderRadius: 16, alignItems: 'center', justifyContent: 'center', gap: 8,
        paddingHorizontal: 6, backgroundColor: oc.neutralButton, opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon size={22} color={oc.text} />
      <Text numberOfLines={2} style={{ fontSize: 13, fontWeight: '600', color: oc.text, textAlign: 'center' }}>{label}</Text>
    </Pressable>
  );
}

function PrimaryButton({ label, onPress, busy, disabled, oc, icon: Icon, testID }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy || disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!(busy || disabled), busy: !!busy }}
      testID={testID}
      style={({ pressed }) => ({
        height: 52, borderRadius: 26, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        backgroundColor: oc.primaryButton, opacity: disabled ? 0.45 : (busy ? 0.7 : (pressed ? 0.85 : 1)),
      })}
    >
      {busy ? <ActivityIndicator size="small" color={oc.onPrimaryButton} /> : (Icon ? <Icon size={20} color={oc.onPrimaryButton} /> : null)}
      <Text style={{ fontSize: 16, fontWeight: '700', color: oc.onPrimaryButton }}>{label}</Text>
    </Pressable>
  );
}

function TypeOption({ active, icon: Icon, label, onPress, oc }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: !!active }}
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flex: 1, height: 48, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        backgroundColor: active ? oc.primaryButton : oc.neutralButton, opacity: pressed ? 0.8 : 1,
      })}
    >
      <Icon size={19} color={active ? oc.onPrimaryButton : oc.text} />
      <Text style={{ fontSize: 15, fontWeight: '600', color: active ? oc.onPrimaryButton : oc.text }}>{label}</Text>
    </Pressable>
  );
}

export default function CreateCallLinkSheet({ visible, onClose, t, router, currentEmail }) {
  const oc = useOverlayColors();
  const ink = oc.text;
  const sub = oc.textSecondary;
  const [stage, setStage] = useState('form'); // form | done | send
  const [isVideo, setIsVideo] = useState(true);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [link, setLink] = useState(null); // { link_id, url, is_video, title, code }
  const [convs, setConvs] = useState([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState([]);
  const [sending, setSending] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    if (visible) return;
    // fecha → zera (próxima abertura começa do formulário)
    const tm = setTimeout(() => {
      setStage('form'); setTitle(''); setErr(''); setLink(null); setQuery(''); setSelected([]); setBusy(false); setSending(false);
    }, 350);
    return () => clearTimeout(tm);
  }, [visible]);

  const create = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setErr('');
    try {
      const api = require('../../services/api');
      const r = await api.chatCreateCallLink(isVideo ? 'video' : 'audio', { title: title.trim() });
      const d = r?.data || r;
      if (!r || r.success === false || !d?.url) {
        const m = String(r?.message || '');
        setErr(/rate|too_many/i.test(m)
          ? tr(t, 'callLink.rateLimited', 'Você criou muitos links agora. Tente de novo em alguns minutos.')
          : tr(t, 'calls.callLinkFailed', 'Não foi possível criar o link. Tente novamente.'));
        return;
      }
      const next = {
        link_id: d.link_id || String(d.url).split('/').pop(),
        url: d.url,
        code: d.code || '',
        is_video: d.is_video ?? isVideo,
        title: d.title ?? title.trim(),
      };
      try { addMyCallLink({ ...next, expires_at: d.expires_at || 0 }); } catch {}
      setLink(next);
      setStage('done');
    } catch {
      setErr(tr(t, 'calls.callLinkFailed', 'Não foi possível criar o link. Tente novamente.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [isVideo, title, t]);

  const onCopy = useCallback(async () => {
    if (!link) return;
    if (await copyText(link.url)) showToast({ message: tr(t, 'calls.linkCopied', 'Link copiado'), kind: 'success' });
  }, [link, t]);

  const onShare = useCallback(async () => {
    if (!link) return;
    const message = buildCallLinkMessage(link, t);
    try {
      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && navigator.share) { await navigator.share({ text: message }); return; }
        if (await copyText(link.url)) showToast({ message: tr(t, 'calls.linkCopied', 'Link copiado'), kind: 'success' });
        return;
      }
      // iOS: só `message` (com url junto o sistema duplica o link no WhatsApp/Mensagens).
      await Share.share(Platform.OS === 'ios' ? { message } : { message, title: tr(t, 'calls.callLink', 'Link de chamada') });
    } catch {}
  }, [link, t]);

  const onJoin = useCallback(() => {
    if (!link) return;
    onClose?.();
    setTimeout(() => {
      try { router?.push?.(`${callLinkRoute(link.link_id)}?now=1`); } catch {}
    }, Platform.OS === 'ios' ? 320 : 60);
  }, [link, onClose, router]);

  // ── enviar no Chatyy ──
  const openSend = useCallback(async () => {
    setStage('send');
    setSelected([]);
    setQuery('');
    const local = normalize(readLocalConversations());
    if (local.length) setConvs(local);
    try {
      const api = require('../../services/api');
      const r = await api.chatConversations('', false);
      if (api.apiOk?.(r)) {
        const list = normalize(api.apiList(r, 'conversations', 'chats'));
        if (list.length) setConvs(list);
      }
    } catch {}
  }, []);

  const nameOf = useCallback((c) => {
    const isGroup = c.type === 'group' || !!c.is_group;
    const peer = !isGroup ? (c.other_email || c.contact_email || c.email || '') : '';
    if (c.type === 'saved' || (peer && currentEmail && peer.toLowerCase() === String(currentEmail).toLowerCase())) {
      return tr(t, 'chat.savedMessages', 'Mensagens salvas');
    }
    let nick = '';
    if (peer) { try { nick = require('../../services/nicknames').getNickname(peer) || ''; } catch {} }
    let disp = c.display_name || c.name || peer || '';
    try { disp = require('../../services/api').emailToDisplayName(disp) || disp; } catch {}
    return nick || disp || '—';
  }, [t, currentEmail]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? convs.filter((c) => [nameOf(c), c.name, c.display_name, c.other_email].filter(Boolean).join(' ').toLowerCase().includes(q))
      : convs;
    return base.slice(0, 60);
  }, [convs, query, nameOf]);

  const toggle = useCallback((c) => {
    setSelected((prev) => {
      const k = String(c.id);
      if (prev.some((x) => String(x.id) === k)) return prev.filter((x) => String(x.id) !== k);
      if (prev.length >= MAX_SEND) {
        showToast({ message: tr(t, 'callLink.sendMax', 'Até {n} conversas por vez', { n: MAX_SEND }) });
        return prev;
      }
      return [...prev, c];
    });
  }, [t]);

  const sendNow = useCallback(async () => {
    if (!link || !selected.length || sending) return;
    setSending(true);
    const api = require('../../services/api');
    const content = buildCallLinkMessage(link, t);
    let ok = 0;
    for (const c of selected) {
      try {
        const cmi = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const r = await api.chatSend(c.id, content, 'text', null, null, null, null, cmi);
        if (api.apiOk ? api.apiOk(r) : r?.success !== false) ok += 1;
      } catch {}
    }
    setSending(false);
    if (ok) {
      showToast({ message: ok === 1 ? tr(t, 'callLink.sentOne', 'Link enviado') : tr(t, 'callLink.sentMany', 'Link enviado para {n} conversas', { n: ok }), kind: 'success' });
      setSelected([]);
      setStage('done');
    } else {
      showToast({ message: tr(t, 'callLink.sendFailed', 'Não foi possível enviar. Tente novamente.'), kind: 'error' });
    }
  }, [link, selected, sending, t]);

  const kindLabel = (v) => (v ? tr(t, 'callLink.kindVideo', 'Chamada de vídeo do Chatyy') : tr(t, 'callLink.kindVoice', 'Chamada de voz do Chatyy'));

  let body = null;
  if (stage === 'form') {
    body = (
      <View style={{ paddingHorizontal: 20, paddingBottom: 18, gap: 14 }} testID="call-link-create-form">
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 10 }}>
          <TypeOption oc={oc} active={isVideo} icon={IconVideo} label={tr(t, 'callLink.typeVideo', 'Vídeo')} onPress={() => setIsVideo(true)} />
          <TypeOption oc={oc} active={!isVideo} icon={IconPhone} label={tr(t, 'callLink.typeAudio', 'Áudio')} onPress={() => setIsVideo(false)} />
        </View>
        <View>
          <Text style={{ fontSize: 13, color: sub, marginBottom: 6, marginLeft: 4 }}>{tr(t, 'callLink.nameLabel', 'Nome da chamada (opcional)')}</Text>
          <TextInput
            value={title}
            onChangeText={(v) => setTitle(v.slice(0, 60))}
            placeholder={tr(t, 'callLink.namePlaceholder', 'Ex.: Reunião de sexta')}
            placeholderTextColor={sub}
            maxLength={60}
            returnKeyType="done"
            onSubmitEditing={create}
            accessibilityLabel={tr(t, 'callLink.nameLabel', 'Nome da chamada (opcional)')}
            style={{
              height: 50, borderRadius: 14, paddingHorizontal: 16, fontSize: 16, color: ink,
              backgroundColor: oc.neutralButton,
            }}
            testID="call-link-title"
          />
        </View>
        {!!err && <Text style={{ fontSize: 13.5, fontWeight: '600', color: oc.danger }} accessibilityLiveRegion="polite">{err}</Text>}
        <PrimaryButton oc={oc} label={tr(t, 'callLink.create', 'Criar link')} icon={IconLink} busy={busy} onPress={create} testID="call-link-create" />
        <Text style={{ fontSize: 12.5, lineHeight: 17, color: sub, textAlign: 'center' }}>
          {tr(t, 'callLink.validityHint', 'Quem tiver o link pode entrar. Ele vale até você revogar ou ficar 90 dias sem uso.')}
        </Text>
      </View>
    );
  } else if (stage === 'done' && link) {
    const KindIcon = link.is_video ? IconVideo : IconPhone;
    body = (
      <View style={{ paddingHorizontal: 20, paddingBottom: 18, gap: 14 }} testID="call-link-created">
        <View style={{ borderRadius: 18, padding: 16, backgroundColor: oc.neutralButton, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: oc.primaryButton }}>
            <KindIcon size={22} color={oc.onPrimaryButton} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '700', color: ink }}>{link.title || kindLabel(link.is_video)}</Text>
            {!!link.title && <Text numberOfLines={1} style={{ fontSize: 13, color: sub, marginTop: 1 }}>{kindLabel(link.is_video)}</Text>}
            <Text selectable numberOfLines={1} style={{ fontSize: 14, color: ink, marginTop: 4, fontWeight: '500' }} testID="call-link-url">
              {String(link.url).replace(/^https?:\/\//, '')}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <BigAction oc={oc} icon={IconCopy} label={tr(t, 'callLink.copy', 'Copiar link')} onPress={onCopy} testID="call-link-copy" />
          <BigAction oc={oc} icon={IconShare} label={tr(t, 'common.share', 'Compartilhar')} onPress={onShare} testID="call-link-share" />
          <BigAction oc={oc} icon={IconSend} label={tr(t, 'callLink.sendInChatyy', 'Enviar no Chatyy')} onPress={openSend} testID="call-link-send" />
        </View>
        <PrimaryButton oc={oc} label={tr(t, 'callLink.joinNow', 'Entrar agora')} icon={KindIcon} onPress={onJoin} testID="call-link-join" />
      </View>
    );
  } else if (stage === 'send') {
    body = (
      <View style={{ paddingHorizontal: 16, paddingBottom: 16 }} testID="call-link-send-picker">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Pressable onPress={() => setStage('done')} hitSlop={8} accessibilityRole="button" accessibilityLabel={tr(t, 'common.back', 'Voltar')}
            style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: oc.neutralButton, opacity: pressed ? 0.6 : 1 })}>
            <IconChevronLeft size={20} color={ink} />
          </Pressable>
          <View style={{ flex: 1, height: 40, borderRadius: 12, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8, backgroundColor: oc.neutralButton }}>
            <IconSearch size={17} color={sub} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={tr(t, 'common.search', 'Pesquisar')}
              placeholderTextColor={sub}
              style={{ flex: 1, fontSize: 15, color: ink, paddingVertical: 0 }}
              accessibilityLabel={tr(t, 'common.search', 'Pesquisar')}
            />
          </View>
        </View>
        {filtered.length === 0 ? (
          <View style={{ paddingVertical: 28, alignItems: 'center' }}>
            {convs.length ? <Text style={{ color: sub, fontSize: 14 }}>{tr(t, 'common.noResults', 'Nenhum resultado')}</Text>
              : <ActivityIndicator color={ink} />}
          </View>
        ) : filtered.map((c) => {
          const name = nameOf(c);
          const isGroup = c.type === 'group' || !!c.is_group;
          const on = selected.some((x) => String(x.id) === String(c.id));
          return (
            <Pressable
              key={String(c.id)}
              onPress={() => toggle(c)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={name}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 4, opacity: pressed ? 0.7 : 1 })}
            >
              <AvatarCircle
                name={name}
                email={isGroup ? undefined : (c.other_email || c.contact_email || undefined)}
                uri={isGroup ? (c.avatar_url || undefined) : undefined}
                members={isGroup ? c.members : undefined}
                size={42}
              />
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 15.5, fontWeight: '500', color: ink }}>{name}</Text>
              <View style={{
                width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
                borderWidth: on ? 0 : 1.5, borderColor: sub, backgroundColor: on ? oc.primaryButton : 'transparent',
              }}>
                {on && <IconCheck size={15} color={oc.onPrimaryButton} />}
              </View>
            </Pressable>
          );
        })}
      </View>
    );
  }

  const footer = stage === 'send' ? (
    <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
      <PrimaryButton
        oc={oc}
        icon={IconSend}
        busy={sending}
        disabled={!selected.length}
        label={selected.length ? tr(t, 'callLink.sendTo', 'Enviar ({n})', { n: selected.length }) : tr(t, 'callLink.pickChats', 'Escolha as conversas')}
        onPress={sendNow}
        testID="call-link-send-go"
      />
    </View>
  ) : null;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={stage === 'send' ? tr(t, 'callLink.sendInChatyy', 'Enviar no Chatyy') : (stage === 'done' ? tr(t, 'callLink.ready', 'Link pronto') : tr(t, 'calls.createCallLink', 'Criar link de chamada'))}
      subtitle={stage === 'form' ? tr(t, 'callLink.formSubtitle', 'Compartilhe um link para uma chamada de vídeo ou de voz') : undefined}
      scroll={stage === 'send'}
      keyboardAware
      footer={footer}
      testID="create-call-link-sheet"
    >
      {body}
    </Sheet>
  );
}
