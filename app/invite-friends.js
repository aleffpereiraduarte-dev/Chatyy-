// /invite-friends — "Convidar um amigo" nível WhatsApp.
//
// [2026-10-19 convite-wa] O founder mandou print: a página era uma lista crua
// da agenda ("-amiga", ":3", "…", emojis primeiro) com "Convidar" em texto
// cinza. Agora (JS puro, sem build):
//   • busca fixa no topo (nome sem acento OU dígitos do número);
//   • cartão "Compartilhar link de convite" (folha do sistema) + "Copiar link"
//     + QR + "Tenho um código de convite";
//   • "Já estão no Chatyy" (contactSync.chatyContacts = check_contacts com
//     hash) → toque abre a conversa;
//   • resto da agenda em seções A–Z (letras primeiro, "#" no fim; sem nome →
//     número formatado), círculo com iniciais, pílula "Convidar" → WhatsApp /
//     SMS / outras opções, com o texto do convite; "Convidado" lembrado 30 dias;
//   • FlatList achatada (cabeçalhos + linhas de altura fixa) c/ getItemLayout.
// Consentimento/permissão de contatos: igual à categoria antiga — abrir a tela
// nunca pede sozinho; só o cache ou um sync quando os dois já foram dados.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, FlatList, Pressable, ActivityIndicator, Linking, Platform, Share, StyleSheet, Keyboard } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Rect, Path } from 'react-native-svg';
import { USE_NATIVE_HEADER, nativeHeaderOptions } from '../components/nativeHeader';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { useSurface, Sheet, ActionList, showToast, TopBar, PressableRow } from '../components/ui';
import { IconSearch, IconX, IconShare, IconCopy, IconCheck, IconTag, IconMessageCircle, IconMessageSquare, IconUserPlus, IconChevronRight } from '../components/Icons';
import AvatarCircle from '../components/AvatarCircle';
import InviteCodeSheet from '../components/settings/InviteCodeSheet';
import { useSection } from '../components/settings/categories/shared';
import { HapticsCompat as Haptics } from '../services/haptics';
import {
  prepareInviteContacts, prepareChatyyContacts, matchesQuery, getInvitedMap, markInvited,
} from '../services/inviteContacts';

let QRCode = null;
try { QRCode = require('react-native-qrcode-svg').default; } catch {}

const ROW_H = 64;
const HEAD_H = 36;
const AV = 44;

function inviteLink(code) {
  return code ? `https://chatyy.app/signup?ref=${encodeURIComponent(code)}` : 'https://chatyy.app';
}

function openSms(digits, msg) {
  const body = encodeURIComponent(msg);
  const to = digits ? `+${digits}` : '';
  const url = Platform.OS === 'ios' ? `sms:${to}&body=${body}` : `sms:${to}?body=${body}`;
  return Linking.openURL(url);
}

async function openWhatsApp(digits, msg) {
  const text = encodeURIComponent(msg);
  if (Platform.OS !== 'web') {
    const app = digits ? `whatsapp://send?phone=${digits}&text=${text}` : `whatsapp://send?text=${text}`;
    try { await Linking.openURL(app); return; } catch {}
  }
  await Linking.openURL(digits ? `https://wa.me/${digits}?text=${text}` : `https://wa.me/?text=${text}`);
}

function QrGlyph({ size = 20, color }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.2" stroke={color} strokeWidth="1.8" />
      <Rect x="14" y="3.5" width="6.5" height="6.5" rx="1.2" stroke={color} strokeWidth="1.8" />
      <Rect x="3.5" y="14" width="6.5" height="6.5" rx="1.2" stroke={color} strokeWidth="1.8" />
      <Path d="M14 14h2.5v2.5H14zM18 18h2.5v2.5H18zM18 14h2.5M14 18v2.5" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}

// Tons de cinza estáveis por contato (P&B, sem cor de marca).
const GRAYS_LIGHT = ['#E9E9EC', '#DEDEE2', '#D2D2D7', '#E4E4E7'];
const GRAYS_DARK = ['#2C2C2E', '#3A3A3C', '#323234', '#28282A'];
function grayFor(key, isDark) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const arr = isDark ? GRAYS_DARK : GRAYS_LIGHT;
  return arr[Math.abs(h) % arr.length];
}

function InitialsAvatar({ item, s }) {
  return (
    <View style={[st.av, { backgroundColor: grayFor(item.key, s.isDark) }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {item.initials
        ? <Text style={[st.avTxt, { color: s.text }]} numberOfLines={1}>{item.initials}</Text>
        : <IconUserPlus size={20} color={s.textSecondary} />}
    </View>
  );
}

function Pill({ label, onPress, filled, s, done, a11y }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={a11y || label}
      style={({ pressed }) => [
        st.pill,
        filled && !done ? { backgroundColor: s.ink } : { backgroundColor: 'transparent', borderWidth: 1, borderColor: s.separator },
        pressed && { opacity: 0.6 },
      ]}
    >
      {done ? <IconCheck size={13} color={s.textSecondary} strokeWidth={2.4} /> : null}
      <Text style={[st.pillTxt, { color: filled && !done ? s.onInk : done ? s.textSecondary : s.text }, done && { marginLeft: 4 }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

function ActionRow({ Icon, glyph, title, subtitle, onPress, s, right, last, testID }) {
  return (
    <PressableRow onPress={onPress} accessibilityRole="button" accessibilityLabel={title} testID={testID}>
      <View style={st.actRow}>
        <View style={[st.actIcon, { backgroundColor: s.ink }]}>
          {glyph || (Icon ? <Icon size={19} color={s.onInk} /> : null)}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[st.actTitle, { color: s.text }]} numberOfLines={1}>{title}</Text>
          {subtitle ? <Text style={[st.actSub, { color: s.textSecondary }]} numberOfLines={1} ellipsizeMode="middle">{subtitle}</Text> : null}
        </View>
        {right || <IconChevronRight size={16} color={s.textTertiary} />}
      </View>
      {!last ? <View style={[st.actSep, { backgroundColor: s.separator }]} /> : null}
    </PressableRow>
  );
}

// Estados da agenda: idle|loading|denied|ready|error|web
function useInviteContacts(t, myEmail) {
  const [state, setState] = useState(Platform.OS === 'web' ? 'web' : 'idle');
  const [others, setOthers] = useState([]);
  const [onChatyy, setOnChatyy] = useState([]);

  const apply = useCallback((r) => {
    setOthers(prepareInviteContacts(r?.otherContacts));
    setOnChatyy(prepareChatyyContacts(r?.chatyContacts, myEmail));
    setState('ready');
  }, [myEmail]);

  const load = useCallback(async (force) => {
    if (Platform.OS === 'web') return;
    setState('loading');
    try {
      const cs = require('../services/contactSync');
      const r = await cs.syncContacts(!!force, t);
      if (r?.error === 'consent_denied' || r?.error === 'consent_required') { setState('idle'); return; }
      if (r?.error === 'permission_denied') { setState('denied'); return; }
      if (r?.error && !(r.otherContacts || []).length && !(r.chatyContacts || []).length) { setState('error'); return; }
      apply(r);
    } catch { setState('error'); }
  }, [apply, t]);

  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    let alive = true;
    (async () => {
      try {
        const cs = require('../services/contactSync');
        const cached = await cs.getCachedContacts();
        if (!alive) return;
        if (cached) apply(cached);
        // cache velho ou ausente → atualiza em silêncio se já houver consentimento + permissão
        if ((await cs.getContactsConsentState()) === 'granted' && (await cs.hasContactsPermissionNoPrompt())) {
          if (!alive) return;
          if (!cached) load(false);
          else cs.syncContacts(false, t).then((r) => { if (alive && r && !r.error) apply(r); }).catch(() => {});
        }
      } catch {}
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apply]);

  return { state, others, onChatyy, load };
}

export default function InviteFriendsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const s = useSurface();
  const { t } = useLanguage();
  const { user } = useAuth() || {};
  const myEmail = String(user?.email || '').toLowerCase();
  const ref = useSection('referral');
  const code = (ref && ref.code) || '';
  const count = Number((ref && ref.referred_count) || 0);
  const link = inviteLink(code);
  const shownLink = link.replace(/^https?:\/\//, '');
  const message = useMemo(
    () => t('invite.shareMessage', 'Vem conversar comigo no Chatyy: mensagens, chamadas e e-mail num app só. Entre pelo meu convite: {link}').split('{link}').join(link),
    [t, link],
  );
  const { state, others, onChatyy, load } = useInviteContacts(t, myEmail);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [codeSheet, setCodeSheet] = useState(false);
  const [target, setTarget] = useState(null); // contato no sheet "Convidar"
  const [invited, setInvited] = useState(() => getInvitedMap());
  const [headerH, setHeaderH] = useState(0);
  const listRef = useRef(null);

  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(id);
  }, [copied]);

  const copyLink = useCallback(async () => {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(link);
      else await require('expo-clipboard').setStringAsync(link);
      try { Haptics.notificationAsync('success'); } catch {}
      setCopied(true);
      showToast({ message: t('inviteV2.linkCopied', 'Link de convite copiado') });
    } catch {}
  }, [link, t]);

  const shareLink = useCallback(async () => {
    try { Haptics.selectionAsync(); } catch {}
    if (Platform.OS === 'web') {
      try { if (navigator.share) { await navigator.share({ text: message, url: link }); return; } } catch { return; }
      copyLink();
      return;
    }
    try { await Share.share(Platform.OS === 'ios' ? { message, url: link } : { message }); } catch {}
  }, [message, link, copyLink]);

  const openChat = useCallback((c) => {
    try { Haptics.selectionAsync(); } catch {}
    try {
      require('../services/openConversation').openConversation(`/chat-conversation?name=${encodeURIComponent(c.display)}&email=${encodeURIComponent(c.email)}`);
    } catch {}
  }, []);

  const askInvite = useCallback((c) => {
    try { Haptics.selectionAsync(); } catch {}
    Keyboard.dismiss();
    setTarget(c);
  }, []);

  const noteInvited = useCallback((c) => {
    if (!c) return;
    markInvited(c.key);
    setInvited((m) => ({ ...m, [c.key]: Date.now() }));
  }, []);

  // ── linhas da lista ─────────────────────────────────────────────────────
  const q = query.trim();
  const rows = useMemo(() => {
    const out = [];
    const chatyy = onChatyy.filter((c) => matchesQuery(c, q));
    const rest = others.filter((c) => matchesQuery(c, q));
    if (chatyy.length) {
      out.push({ type: 'head', key: 'h-on', label: t('inviteV2.onChatyy', 'Já estão no Chatyy') });
      chatyy.forEach((c, i) => out.push({ type: 'chatyy', key: c.key, item: c, last: i === chatyy.length - 1 }));
    }
    let cur = null;
    rest.forEach((c, i) => {
      if (c.letter !== cur) {
        cur = c.letter;
        out.push({ type: 'head', key: 'h-' + cur, label: cur });
      }
      const next = rest[i + 1];
      out.push({ type: 'contact', key: c.key, item: c, last: !next || next.letter !== cur });
    });
    let off = 0;
    for (const r of out) { r.offset = off; r.length = r.type === 'head' ? HEAD_H : ROW_H; off += r.length; }
    return out;
  }, [onChatyy, others, q, t]);

  const getItemLayout = useCallback((_, index) => {
    const r = rows[index];
    if (!r) return { length: ROW_H, offset: headerH + index * ROW_H, index };
    return { length: r.length, offset: headerH + r.offset, index };
  }, [rows, headerH]);

  const renderItem = useCallback(({ item: r }) => {
    if (r.type === 'head') {
      return (
        <View style={[st.head, { backgroundColor: s.bg }]}>
          <Text style={[st.headTxt, { color: s.textSecondary }]} accessibilityRole="header" numberOfLines={1}>{r.label.toUpperCase()}</Text>
        </View>
      );
    }
    const c = r.item;
    if (r.type === 'chatyy') {
      return (
        <PressableRow onPress={() => openChat(c)} accessibilityRole="button" accessibilityLabel={`${c.display}. ${t('inviteV2.chat', 'Conversar')}`}>
          <View style={st.row}>
            <AvatarCircle name={c.display} email={c.email} uri={c.avatar || undefined} size={AV} />
            <View style={st.rowMid}>
              <Text style={[st.name, { color: s.text }]} numberOfLines={1}>{c.display}</Text>
              <Text style={[st.sub, { color: s.textSecondary }]} numberOfLines={1}>{c.phoneLabel || t('inviteV2.onChatyyShort', 'No Chatyy')}</Text>
            </View>
            <Pill s={s} label={t('inviteV2.chat', 'Conversar')} onPress={() => openChat(c)} />
          </View>
          {!r.last ? <View style={[st.sep, { backgroundColor: s.separator }]} /> : null}
        </PressableRow>
      );
    }
    const done = !!invited[c.key];
    const sub = c.named ? c.phoneLabel : (c.rawName ? `~ ${c.rawName}` : t('inviteV2.noName', 'Sem nome na agenda'));
    return (
      <PressableRow onPress={() => askInvite(c)} accessibilityRole="button" accessibilityLabel={`${t('invite.inviteName', 'Convidar {name}').split('{name}').join(c.display)}. ${c.named ? c.phoneLabel : ''}`}>
        <View style={st.row}>
          <InitialsAvatar item={c} s={s} />
          <View style={st.rowMid}>
            <Text style={[st.name, { color: s.text }]} numberOfLines={1}>{c.display}</Text>
            <Text style={[st.sub, { color: s.textSecondary }]} numberOfLines={1}>{sub}</Text>
          </View>
          <Pill
            s={s}
            filled
            done={done}
            label={done ? t('inviteV2.invited', 'Convidado') : t('invite.inviteCta', 'Convidar')}
            onPress={() => askInvite(c)}
          />
        </View>
        {!r.last ? <View style={[st.sep, { backgroundColor: s.separator }]} /> : null}
      </PressableRow>
    );
  }, [s, t, invited, openChat, askInvite]);

  // ── cabeçalho (cartão do link + estado da agenda) ───────────────────────
  const searching = q.length > 0;
  const total = others.length + onChatyy.length;
  const header = (
    <View onLayout={(e) => { const h = Math.round(e.nativeEvent.layout.height); if (h !== headerH) setHeaderH(h); }}>
      {!searching ? (
        <>
          <View style={st.hero}>
            <Text style={[st.heroTitle, { color: s.text }]} accessibilityRole="header">{t('invite.heroTitle', 'Traga seus amigos para o Chatyy')}</Text>
            <Text style={[st.heroSub, { color: s.textSecondary }]}>{t('invite.heroSub', 'Mensagens, chamadas e e-mail num app só. Envie o seu link pessoal para quem você quiser.')}</Text>
            {count > 0 ? (
              <View style={[st.countChip, { backgroundColor: s.fill }]}>
                <Text style={[st.countTxt, { color: s.text }]}>
                  {count === 1 ? t('invite.joinedOne', '1 amigo entrou pelo seu convite') : t('invite.joinedMany', '{n} amigos entraram pelo seu convite').split('{n}').join(String(count))}
                </Text>
              </View>
            ) : null}
          </View>
          <View style={[st.card, { backgroundColor: s.surfaceMuted }]}>
            <ActionRow s={s} Icon={IconShare} title={t('inviteV2.shareLink', 'Compartilhar link de convite')} subtitle={code ? shownLink : t('inviteV2.loadingLink', 'Preparando seu link…')} onPress={shareLink} testID="invite-share" />
            <ActionRow
              s={s}
              Icon={copied ? IconCheck : IconCopy}
              title={copied ? t('invite.copied', 'Copiado') : t('invite.copyLink', 'Copiar link')}
              onPress={copyLink}
              right={<View />}
              testID="invite-copy"
            />
            {QRCode && code ? (
              <ActionRow s={s} glyph={<QrGlyph size={19} color={s.onInk} />} title={t('inviteV2.showQr', 'Mostrar QR code')} onPress={() => setQrOpen(true)} />
            ) : null}
            <ActionRow s={s} Icon={IconTag} title={t('invite.code.title', 'Tenho um código de convite')} onPress={() => setCodeSheet(true)} last />
          </View>
        </>
      ) : null}

      {state === 'web' ? (
        <Text style={[st.note, { color: s.textSecondary }]}>{t('inviteV2.webNote', 'No celular, o Chatyy mostra quem da sua agenda já está aqui e quem você pode convidar.')}</Text>
      ) : state === 'idle' ? (
        <View style={[st.card, { backgroundColor: s.surfaceMuted, marginTop: 20 }]}>
          <ActionRow s={s} Icon={IconUserPlus} title={t('invite.findContacts', 'Encontrar contatos para convidar')} subtitle={t('inviteV2.findSub', 'Veja quem já usa o Chatyy e convide o resto')} onPress={() => load(true)} last testID="invite-find" />
        </View>
      ) : state === 'loading' && !total ? (
        <View style={st.center}><ActivityIndicator color={s.textSecondary} /><Text style={[st.note, { color: s.textSecondary, marginTop: 10 }]}>{t('invite.loadingContacts', 'Procurando na sua agenda…')}</Text></View>
      ) : state === 'denied' ? (
        <View style={[st.card, { backgroundColor: s.surfaceMuted, marginTop: 20 }]}>
          <ActionRow s={s} Icon={IconUserPlus} title={t('invite.allowContacts', 'Permitir acesso aos contatos')} subtitle={t('invite.allowContactsSub', 'Abra os ajustes do sistema e libere Contatos para o Chatyy')} onPress={() => { Linking.openSettings?.().catch?.(() => {}); }} last />
        </View>
      ) : state === 'error' && !total ? (
        <View style={[st.card, { backgroundColor: s.surfaceMuted, marginTop: 20 }]}>
          <ActionRow s={s} Icon={IconUserPlus} title={t('invite.contactsError', 'Não consegui ler sua agenda agora')} subtitle={t('invite.tapToRetry', 'Toque para tentar de novo')} onPress={() => load(true)} last />
        </View>
      ) : null}
      {!searching && state !== 'web' && state !== 'idle' ? (
        <Text style={[st.note, { color: s.textSecondary }]}>{t('invite.contactsFooterIdle', 'Mostramos só quem da sua agenda ainda não está no Chatyy. Nada é enviado sem você tocar em Convidar.')}</Text>
      ) : null}
      {state === 'ready' && !total && !searching ? (
        <Text style={[st.empty, { color: s.textSecondary }]}>{t('inviteV2.noContacts', 'Nenhum contato com telefone na sua agenda.')}</Text>
      ) : null}
      {searching && !rows.length ? (
        <Text style={[st.empty, { color: s.textSecondary }]}>{t('inviteV2.noResults', 'Nenhum contato encontrado')}</Text>
      ) : null}
    </View>
  );

  const title = t('settings.cat.invite', 'Convidar um amigo');
  const showSearch = state === 'ready' && total > 0;
  return (
    <View style={[st.flex, { backgroundColor: s.bg, paddingTop: USE_NATIVE_HEADER ? 0 : insets.top }]}>
      {USE_NATIVE_HEADER ? (
        <Stack.Screen options={nativeHeaderOptions({ colors, isDark, title, headerShadowVisible: false })} />
      ) : (
        <TopBar title={title} onBack={() => { try { router.back(); } catch {} }} />
      )}
      {showSearch ? (
        <View style={[st.searchWrap, { backgroundColor: s.bg }]}>
          <View style={[st.search, { backgroundColor: s.fill }]}>
            <IconSearch size={17} color={s.textSecondary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t('inviteV2.search', 'Pesquisar contatos')}
              placeholderTextColor={s.textTertiary}
              style={[st.searchInput, { color: s.text }]}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              clearButtonMode="never"
              accessibilityLabel={t('inviteV2.search', 'Pesquisar contatos')}
              testID="invite-search"
            />
            {query ? (
              <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common.clear', 'Limpar')}>
                <View style={[st.clear, { backgroundColor: s.textTertiary }]}><IconX size={11} color={s.bg} /></View>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        extraData={invited}
        ListHeaderComponent={header}
        ListFooterComponent={<View style={{ height: insets.bottom + 24 }} />}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={18}
        maxToRenderPerBatch={24}
        windowSize={11}
        removeClippedSubviews={Platform.OS === 'android'}
        contentInsetAdjustmentBehavior="automatic"
      />

      <Sheet
        visible={!!target}
        onClose={() => setTarget(null)}
        title={target ? t('invite.inviteName', 'Convidar {name}').split('{name}').join(target.display) : ''}
        subtitle={target && target.named ? target.phoneLabel : undefined}
      >
        <ActionList
          onDone={() => setTarget(null)}
          items={target ? [
            { key: 'wa', label: 'WhatsApp', icon: IconMessageCircle, onPress: () => { const c = target; noteInvited(c); openWhatsApp(c.digits, message).catch(() => {}); } },
            { key: 'sms', label: t('invite.viaSms', 'Convidar por SMS'), icon: IconMessageSquare, onPress: () => { const c = target; noteInvited(c); openSms(c.digits, message).catch(() => {}); } },
            { key: 'more', label: t('inviteV2.moreOptions', 'Mais opções'), icon: IconShare, onPress: () => { const c = target; Share.share({ message }).then((r) => { if (r?.action === Share.sharedAction) noteInvited(c); }).catch(() => {}); } },
          ] : []}
        />
      </Sheet>

      <Sheet visible={qrOpen} onClose={() => setQrOpen(false)} title={t('inviteV2.showQr', 'Mostrar QR code')} subtitle={t('invite.qrCaption', 'Peça para apontar a câmera do celular')}>
        <View style={st.qrBlock}>
          {QRCode && code ? (
            <View style={st.qrTile}>
              <QRCode value={link} size={200} color="#0B0B0C" backgroundColor="#FFFFFF" ecl="M" />
            </View>
          ) : null}
          {code ? <Text style={[st.qrCode, { color: s.textSecondary }]}>{t('referral.yourCode', 'Seu código')}: <Text style={{ color: s.text, fontWeight: '600', letterSpacing: 1.2 }}>{code}</Text></Text> : null}
        </View>
      </Sheet>

      <InviteCodeSheet visible={codeSheet} onClose={() => setCodeSheet(false)} t={t} />
    </View>
  );
}

const st = StyleSheet.create({
  flex: { flex: 1 },
  searchWrap: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 },
  search: { flexDirection: 'row', alignItems: 'center', height: 38, borderRadius: 11, paddingHorizontal: 10, gap: 8 },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 0, height: 38 },
  clear: { width: 17, height: 17, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  hero: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 18, alignItems: 'center' },
  heroTitle: { fontSize: 22, fontWeight: '700', letterSpacing: -0.4, textAlign: 'center' },
  heroSub: { fontSize: 14, lineHeight: 20, marginTop: 6, textAlign: 'center', maxWidth: 340 },
  countChip: { marginTop: 12, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6 },
  countTxt: { fontSize: 13, fontWeight: '600' },
  card: { marginHorizontal: 16, borderRadius: 14, overflow: 'hidden' },
  actRow: { flexDirection: 'row', alignItems: 'center', minHeight: 58, paddingHorizontal: 14, paddingVertical: 9, gap: 14 },
  actIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  actTitle: { fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  actSub: { fontSize: 13, marginTop: 1 },
  actSep: { position: 'absolute', left: 64, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 32, marginTop: 10, textAlign: 'center' },
  empty: { fontSize: 15, textAlign: 'center', paddingHorizontal: 32, paddingVertical: 36 },
  center: { alignItems: 'center', paddingVertical: 36 },
  head: { height: HEAD_H, justifyContent: 'flex-end', paddingHorizontal: 20, paddingBottom: 6 },
  headTxt: { fontSize: 13, fontWeight: '600', letterSpacing: 0.4 },
  row: { height: ROW_H, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  rowMid: { flex: 1, minWidth: 0, marginLeft: 12, marginRight: 10 },
  name: { fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  sub: { fontSize: 13, marginTop: 2, fontVariant: ['tabular-nums'] },
  sep: { position: 'absolute', left: 16 + AV + 12, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  av: { width: AV, height: AV, borderRadius: AV / 2, alignItems: 'center', justifyContent: 'center' },
  avTxt: { fontSize: 16, fontWeight: '600', letterSpacing: 0.3 },
  pill: { flexDirection: 'row', alignItems: 'center', height: 32, borderRadius: 16, paddingHorizontal: 14, minWidth: 84, justifyContent: 'center' },
  pillTxt: { fontSize: 14, fontWeight: '600' },
  qrBlock: { alignItems: 'center', paddingVertical: 16, paddingBottom: 24 },
  qrTile: { padding: 16, borderRadius: 22, backgroundColor: '#FFFFFF' },
  qrCode: { fontSize: 14, marginTop: 14 },
});
