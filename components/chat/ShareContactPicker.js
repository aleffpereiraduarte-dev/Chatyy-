// components/chat/ShareContactPicker.js — [2026-10-17 share-contact] Seletor
// "Enviar contato" estilo WhatsApp, P&B. SÓ o conteúdo (sem <Modal> próprio):
// o host (chat-conversation) já o monta dentro do NativeSheetModal do seletor
// antigo → nada de Modal sobre Modal nem troca de tipo de Modal.
//
//   Passo 1 (escolher): busca + "No Chatyy" (quem você conversa + agenda
//   sincronizada) + "Contatos do celular" (expo-contacts, só se a permissão já
//   existe ou o usuário tocar em "Permitir"), multi-seleção até 5 (chips).
//   Passo 2 (revisar): cada contato com seus números (marcar/desmarcar) e o
//   selo "No Chatyy" quando resolvido → Enviar.
//
// Props: { t, colors, isDark, currentEmail, onClose(), onSend(cards) → Promise<boolean>,
//          onSystemPicker?() (sem permissão da agenda: seletor do sistema, 1 contato),
//          bottomPad? (respiro inferior do botão Enviar) }
// cards = [{ name, phone, phones:[E.164], email, chatyy, avatar }]
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  View, Text, TextInput, SectionList, ScrollView, TouchableOpacity, ActivityIndicator, Platform, StyleSheet, Linking,
} from 'react-native';
import AvatarCircle from '../AvatarCircle';
import { IconX, IconSearch, IconCheck, IconArrowLeft, IconSend, IconSmartphone, IconUser } from '../Icons';
import { MAX_SHARE_CONTACTS, toE164Smart, prettyPhone } from './contactShare';

function _tr(t, k, fb) {
  try { const v = t(k); return v && v !== k ? v : fb; } catch { return fb; }
}
function _digits(s) { return String(s || '').replace(/\D+/g, ''); }
function _withTimeout(p, ms) {
  return Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]);
}

export default function ShareContactPicker({ t, colors = {}, isDark, currentEmail, onClose, onSend, onSystemPicker, bottomPad = 14 }) {
  const ink = colors.text || (isDark ? '#F5F5F7' : '#111111');
  const onInk = isDark ? '#000000' : '#FFFFFF';
  const sub = colors.textSecondary || (isDark ? '#8E8E93' : '#6B6B70');
  const ter = colors.textTertiary || (isDark ? '#636366' : '#A1A1A6');
  const hair = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(60,60,67,0.14)';
  const fill = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(118,118,128,0.12)';
  const bg = colors.background || (isDark ? '#000000' : '#FFFFFF');

  const [step, setStep] = useState('pick');
  const [query, setQuery] = useState('');
  const [chatyy, setChatyy] = useState([]);       // [{key, name, email, phones[], avatar, chatyy:true}]
  const [phoneBook, setPhoneBook] = useState([]); // [{key, name, phones[], email}]
  const [pbState, setPbState] = useState(Platform.OS === 'web' ? 'na' : 'checking'); // checking|loading|ready|need|denied|na
  const [loadingChatyy, setLoadingChatyy] = useState(true);
  const [sel, setSel] = useState([]);             // ordem de seleção (keys)
  const [limitHit, setLimitHit] = useState(false);
  const [review, setReview] = useState([]);       // [{key, name, email, chatyy, avatar, phones:[{n, on}], resolving}]
  const [sending, setSending] = useState(false);
  const reviewRef = useRef([]); // espelho p/ doSend ver a resolução que chega durante a espera
  useEffect(() => { reviewRef.current = review; }, [review]);
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  const [syncedByPhone, setSyncedByPhone] = useState(() => new Map()); // E.164 → {email, name}

  // ── Chatyy: conversas + agenda sincronizada (cache) ──────────────────────
  useEffect(() => {
    (async () => {
      const me = String(currentEmail || '').toLowerCase();
      const byEmail = new Map();
      const synMap = new Map();
      const put = (email, name, phone, avatar) => {
        const em = String(email || '').trim().toLowerCase();
        if (!em || em === me || em.endsWith('@bots.chatyy') || em === 'ai@chatyy.com.br') return;
        const cur = byEmail.get(em) || { key: 'c:' + em, email: em, name: '', phones: [], avatar: '', chatyy: true };
        if (name && (!cur.name || cur._fromChat)) { cur.name = String(name); cur._fromChat = false; }
        if (phone) { const e = toE164Smart(String(phone)); if (e && !cur.phones.includes(e)) cur.phones.push(e); }
        if (avatar && /^https:\/\//i.test(String(avatar)) && !cur.avatar) cur.avatar = String(avatar);
        byEmail.set(em, cur);
      };
      try {
        const synced = await require('../../services/contactSync').getCachedChatyyContactsAnyAge();
        for (const c of synced || []) {
          put(c.email, c.name && c.name !== 'Unknown' ? c.name : '', c.phone, c.avatar);
          const e = c.phone ? toE164Smart(String(c.phone)) : '';
          if (e && c.email) synMap.set(e, { email: String(c.email).toLowerCase(), name: c.name });
        }
      } catch {}
      try {
        const api = require('../../services/api');
        const r = await _withTimeout(api.chatContacts(), 8000);
        let list = [];
        if (r) {
          if (typeof api.apiList === 'function') list = api.apiList(r, 'contacts');
          else { const d = r.data; list = Array.isArray(d) ? d : (Array.isArray(d && d.contacts) ? d.contacts : []); }
        }
        for (const c of Array.isArray(list) ? list : []) {
          if (!c || !c.email) continue;
          const em = String(c.email).toLowerCase();
          if (!byEmail.has(em)) { put(em, c.name || em.split('@')[0], '', ''); const x = byEmail.get(em); if (x) x._fromChat = true; }
        }
      } catch {}
      if (!aliveRef.current) return;
      const arr = Array.from(byEmail.values()).map((x) => ({ ...x, name: x.name || x.email.split('@')[0] }));
      arr.sort((a, b) => a.name.localeCompare(b.name));
      setSyncedByPhone(synMap);
      setChatyy(arr);
      setLoadingChatyy(false);
    })();
  }, [currentEmail]);

  // ── Agenda do celular ────────────────────────────────────────────────────
  const loadPhoneBook = useCallback(async (ask) => {
    if (Platform.OS === 'web') { setPbState('na'); return; }
    let Contacts = null;
    try { Contacts = require('expo-contacts'); } catch { setPbState('na'); return; }
    try {
      const perm = ask ? await Contacts.requestPermissionsAsync() : await Contacts.getPermissionsAsync();
      if (perm?.status !== 'granted') { if (aliveRef.current) setPbState(ask || perm?.canAskAgain === false ? 'denied' : 'need'); return; }
      if (aliveRef.current) setPbState('loading');
      const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails], sort: Contacts.SortTypes.FirstName });
      const out = [];
      for (const c of data || []) {
        const phones = [];
        for (const p of c.phoneNumbers || []) { const e = toE164Smart(String(p && p.number || '')); if (e && !phones.includes(e)) phones.push(e); }
        if (!phones.length) continue;
        const name = String(c.name || [c.firstName, c.lastName].filter(Boolean).join(' ') || '').trim() || phones[0];
        const email = String((c.emails && c.emails[0] && c.emails[0].email) || '').trim();
        out.push({ key: 'p:' + String(c.id || c.lookupKey || name + phones[0]), name, phones, email });
      }
      if (!aliveRef.current) return;
      setPhoneBook(out);
      setPbState('ready');
    } catch {
      if (aliveRef.current) setPbState('denied');
    }
  }, []);
  useEffect(() => { loadPhoneBook(false); }, [loadPhoneBook]);

  // Agenda × Chatyy: número da agenda que bate com a agenda sincronizada → vai
  // pro contato Chatyy (com o nome da agenda + os números) e sai de "celular".
  const { chatyyRows, phoneRows } = useMemo(() => {
    const syn = syncedByPhone;
    const cMap = new Map(chatyy.map((c) => [c.email, { ...c, phones: [...c.phones] }]));
    const rest = [];
    for (const p of phoneBook) {
      let hit = null;
      for (const e of p.phones) { const s = syn.get(e); if (s && cMap.has(s.email)) { hit = cMap.get(s.email); break; } }
      if (hit) { for (const e of p.phones) if (!hit.phones.includes(e)) hit.phones.push(e); if (p.name && !/^\+?\d/.test(p.name)) hit.name = p.name; }
      else rest.push(p);
    }
    const cr = Array.from(cMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    return { chatyyRows: cr, phoneRows: rest };
  }, [chatyy, phoneBook, syncedByPhone]);

  const byKey = useMemo(() => {
    const m = new Map();
    for (const r of chatyyRows) m.set(r.key, r);
    for (const r of phoneRows) m.set(r.key, r);
    return m;
  }, [chatyyRows, phoneRows]);

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qd = _digits(q);
    const match = (r) => !q || r.name.toLowerCase().includes(q) || (r.email && r.email.includes(q)) || (qd.length >= 3 && r.phones.some((p) => _digits(p).includes(qd)));
    const out = [];
    const a = chatyyRows.filter(match);
    const b = phoneRows.filter(match);
    if (a.length) out.push({ key: 'chatyy', title: _tr(t, 'shareContact.onChatyy', 'No Chatyy'), data: a });
    if (b.length) out.push({ key: 'phone', title: _tr(t, 'shareContact.phoneContacts', 'Contatos do celular'), data: b });
    return out;
  }, [query, chatyyRows, phoneRows, t]);

  const toggle = useCallback((key) => {
    setSel((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (prev.length >= MAX_SHARE_CONTACTS) {
        try { require('../../services/haptics').hapticEvent('warning'); } catch {}
        setLimitHit(true);
        setTimeout(() => { if (aliveRef.current) setLimitHit(false); }, 2200);
        return prev;
      }
      try { require('../../services/haptics').hapticEvent('toggle'); } catch {}
      return [...prev, key];
    });
  }, []);

  // ── Revisar: resolve "tem Chatyy?" dos contatos do celular ───────────────
  const goReview = useCallback(() => {
    const items = sel.map((k) => byKey.get(k)).filter(Boolean).map((r) => ({
      key: r.key, name: r.name, email: r.email || '', chatyy: !!r.chatyy, avatar: r.avatar || '',
      phones: r.phones.map((n) => ({ n, on: true })), resolving: !r.chatyy,
    }));
    setReview(items);
    setStep('review');
    const pending = items.filter((x) => x.resolving);
    if (!pending.length) return;
    (async () => {
      const found = new Map(); // key → email
      try {
        const allPhones = [];
        for (const x of pending) for (const p of x.phones) allPhones.push(p.n);
        const cs = require('../../services/contactSync');
        const r = await _withTimeout(cs.syncContactsHashed(allPhones), 6000);
        const matches = (r && Array.isArray(r.matches)) ? r.matches : [];
        for (const m of matches) {
          if (!m || !m.email || !m.phone) continue;
          const md = _digits(m.phone);
          for (const x of pending) if (!found.has(x.key) && x.phones.some((p) => _digits(p.n) === md)) found.set(x.key, String(m.email).toLowerCase());
        }
        if (!matches.length && (!r || r.error)) { // consent_required, sync_failed ou timeout → checa 1 a 1
          const api = require('../../services/api');
          await Promise.all(pending.map(async (x) => {
            const rr = await _withTimeout(api.chatCheckChatyy({ email: x.email || '', phone: (x.phones[0] && x.phones[0].n) || '' }), 5000);
            if (rr && rr.data && rr.data.has_chatyy && rr.data.email) found.set(x.key, String(rr.data.email).toLowerCase());
          }));
        }
      } catch {}
      if (!aliveRef.current) return;
      setReview((prev) => prev.map((x) => {
        if (!x.resolving) return x;
        const em = found.get(x.key);
        return em ? { ...x, email: em, chatyy: true, resolving: false } : { ...x, resolving: false };
      }));
    })();
  }, [sel, byKey]);

  const togglePhone = useCallback((key, idx) => {
    setReview((prev) => prev.map((x) => {
      if (x.key !== key) return x;
      const phones = x.phones.map((p, i) => (i === idx ? { ...p, on: !p.on } : p));
      return { ...x, phones };
    }));
  }, []);

  const doSend = useCallback(async () => {
    if (sending || !review.length) return;
    setSending(true);
    // espera curta pela resolução (no máx. ~3 s) — "Mensagem" já aparece pra quem recebe
    for (let i = 0; i < 15 && (reviewRef.current || []).some((x) => x.resolving); i++) await new Promise((r) => setTimeout(r, 200));
    const cards = (reviewRef.current || review).map((x) => {
      const phones = x.phones.filter((p) => p.on).map((p) => p.n);
      return { name: x.name, phone: phones[0] || '', phones, email: x.email || '', chatyy: !!(x.chatyy && x.email), avatar: x.avatar || '' };
    }).filter((c) => c.name || c.phone || c.email);
    let ok = false;
    try { ok = await onSend(cards); } catch { ok = false; }
    if (aliveRef.current) setSending(false);
    if (ok !== false && typeof onClose === 'function') onClose();
  }, [sending, review, onSend, onClose]);

  // ── UI ───────────────────────────────────────────────────────────────────
  const headerTitle = step === 'pick'
    ? _tr(t, 'shareContact.title', 'Enviar contato')
    : (review.length > 1 ? _tr(t, 'shareContact.sendN', 'Enviar {n} contatos').split('{n}').join(String(review.length)) : _tr(t, 'shareContact.title', 'Enviar contato'));
  const headerSub = step === 'pick'
    ? (sel.length ? _tr(t, 'shareContact.selectedOf', '{n} de {max} selecionados').split('{n}').join(String(sel.length)).split('{max}').join(String(MAX_SHARE_CONTACTS))
      : _tr(t, 'shareContact.upTo', 'Até {max} contatos').split('{max}').join(String(MAX_SHARE_CONTACTS)))
    : '';

  const renderRow = ({ item: r }) => {
    const on = sel.includes(r.key);
    const subline = r.chatyy
      ? (r.phones[0] ? prettyPhone(r.phones[0]) : _tr(t, 'shareContact.onChatyy', 'No Chatyy'))
      : prettyPhone(r.phones[0]) + (r.phones.length > 1 ? `  +${r.phones.length - 1}` : '');
    return (
      <TouchableOpacity onPress={() => toggle(r.key)} activeOpacity={0.6} style={st.row}
        accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={r.name} testID={`share-contact-row-${r.key}`}>
        <AvatarCircle name={r.name} email={r.chatyy ? r.email : undefined} uri={r.avatar || undefined} size={44} />
        <View style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
          <Text style={[st.name, { color: ink }]} numberOfLines={1}>{r.name}</Text>
          {!!subline && <Text style={[st.subline, { color: sub }]} numberOfLines={1}>{subline}</Text>}
        </View>
        <View style={[st.check, on ? { backgroundColor: ink, borderColor: ink } : { borderColor: ter }]}>
          {on ? <IconCheck size={14} color={onInk} /> : null}
        </View>
      </TouchableOpacity>
    );
  };

  const pbFooter = (() => {
    if (pbState === 'need' || pbState === 'denied') {
      return (
        <View style={[st.permBox, { borderColor: hair }]}>
          <IconSmartphone size={20} color={ink} />
          <Text style={[st.permText, { color: sub }]}>{_tr(t, 'shareContact.phoneAccess', 'Permita o acesso à agenda para enviar contatos do celular.')}</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
            <TouchableOpacity onPress={() => (pbState === 'denied' ? Linking.openSettings().catch(() => {}) : loadPhoneBook(true))}
              style={[st.pill, { backgroundColor: ink }]} accessibilityRole="button" testID="share-contact-allow">
              <Text style={[st.pillText, { color: onInk }]}>{pbState === 'denied' ? _tr(t, 'shareContact.openSettings', 'Abrir Ajustes') : _tr(t, 'shareContact.allow', 'Permitir acesso')}</Text>
            </TouchableOpacity>
            {typeof onSystemPicker === 'function' ? (
              <TouchableOpacity onPress={onSystemPicker} style={[st.pill, { backgroundColor: fill }]} accessibilityRole="button" testID="share-contact-system">
                <Text style={[st.pillText, { color: ink }]}>{_tr(t, 'shareContact.pickOne', 'Escolher na agenda')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      );
    }
    if (pbState === 'loading' || pbState === 'checking') return <ActivityIndicator color={ink} style={{ marginVertical: 18 }} />;
    return null;
  })();

  if (step === 'review') {
    return (
      <View style={{ flex: 1, backgroundColor: bg }}>
        <View style={[st.header, { borderBottomColor: hair }]}>
          <TouchableOpacity onPress={() => setStep('pick')} hitSlop={12} accessibilityRole="button" accessibilityLabel={_tr(t, 'common.back', 'Voltar')} testID="share-contact-back">
            <IconArrowLeft size={22} color={ink} />
          </TouchableOpacity>
          <Text style={[st.hTitle, { color: ink, marginLeft: 12, flex: 1 }]} numberOfLines={1}>{headerTitle}</Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
          {review.map((x) => (
            <View key={x.key} style={[st.card, { backgroundColor: fill }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <AvatarCircle name={x.name} email={x.chatyy ? x.email : undefined} uri={x.avatar || undefined} size={48} />
                <View style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
                  <Text style={[st.name, { color: ink, fontSize: 16 }]} numberOfLines={2}>{x.name}</Text>
                  {x.resolving
                    ? <ActivityIndicator size="small" color={sub} style={{ alignSelf: 'flex-start', marginTop: 4 }} />
                    : (x.chatyy
                      ? <View style={st.badgeRow}><IconUser size={12} color={sub} /><Text style={[st.subline, { color: sub, marginTop: 0, marginLeft: 4 }]}>{_tr(t, 'shareContact.onChatyy', 'No Chatyy')}</Text></View>
                      : <Text style={[st.subline, { color: sub }]}>{_tr(t, 'shareContact.notOnChatyy', 'Ainda não usa o Chatyy')}</Text>)}
                </View>
              </View>
              {x.phones.map((p, i) => (
                <TouchableOpacity key={p.n} onPress={() => togglePhone(x.key, i)} activeOpacity={0.6}
                  style={[st.phoneRow, { borderTopColor: hair }]} accessibilityRole="checkbox" accessibilityState={{ checked: p.on }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: sub, fontSize: 12 }}>{_tr(t, 'shareContact.phone', 'Telefone')}</Text>
                    <Text style={{ color: ink, fontSize: 15, marginTop: 1 }}>{prettyPhone(p.n)}</Text>
                  </View>
                  <View style={[st.check, p.on ? { backgroundColor: ink, borderColor: ink } : { borderColor: ter }]}>
                    {p.on ? <IconCheck size={14} color={onInk} /> : null}
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </ScrollView>
        <View style={[st.footer, { borderTopColor: hair, backgroundColor: bg, paddingBottom: bottomPad }]}>
          <TouchableOpacity onPress={doSend} disabled={sending} activeOpacity={0.8}
            style={[st.sendBtn, { backgroundColor: ink, opacity: sending ? 0.6 : 1 }]} accessibilityRole="button" testID="share-contact-send">
            {sending ? <ActivityIndicator color={onInk} /> : (
              <>
                <IconSend size={18} color={onInk} />
                <Text style={[st.sendText, { color: onInk }]}>{_tr(t, 'common.send', 'Enviar')}</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const selectedRows = sel.map((k) => byKey.get(k)).filter(Boolean);
  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <View style={[st.header, { borderBottomColor: hair }]}>
        <TouchableOpacity onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={_tr(t, 'common.close', 'Fechar')} testID="share-contact-close">
          <IconX size={22} color={ink} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={[st.hTitle, { color: ink }]} numberOfLines={1}>{headerTitle}</Text>
          <Text style={{ color: limitHit ? ink : sub, fontSize: 12, marginTop: 1, fontWeight: limitHit ? '600' : '400' }} numberOfLines={1}>
            {limitHit ? _tr(t, 'shareContact.limit', 'Você pode enviar até {max} contatos').split('{max}').join(String(MAX_SHARE_CONTACTS)) : headerSub}
          </Text>
        </View>
        <TouchableOpacity onPress={goReview} disabled={!sel.length} hitSlop={10} accessibilityRole="button" testID="share-contact-next"
          style={[st.nextBtn, { backgroundColor: sel.length ? ink : fill }]}>
          <Text style={{ color: sel.length ? onInk : ter, fontWeight: '700', fontSize: 14 }}>{_tr(t, 'shareContact.next', 'Avançar')}</Text>
        </TouchableOpacity>
      </View>

      <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
        <View style={[st.search, { backgroundColor: fill }]}>
          <IconSearch size={16} color={ter} />
          <TextInput value={query} onChangeText={setQuery} placeholder={_tr(t, 'common.search', 'Buscar')} placeholderTextColor={ter}
            style={{ flex: 1, fontSize: 15, color: ink, paddingVertical: 0, marginLeft: 8 }} autoCapitalize="none" autoCorrect={false} testID="share-contact-search" />
        </View>
      </View>

      {selectedRows.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 6, gap: 4 }} style={{ flexGrow: 0 }}>
          {selectedRows.map((r) => (
            <TouchableOpacity key={r.key} onPress={() => toggle(r.key)} style={st.chip} accessibilityRole="button" accessibilityLabel={r.name}>
              <View>
                <AvatarCircle name={r.name} email={r.chatyy ? r.email : undefined} uri={r.avatar || undefined} size={44} />
                <View style={[st.chipX, { backgroundColor: sub, borderColor: bg }]}><IconX size={9} color={onInk} /></View>
              </View>
              <Text style={{ color: ink, fontSize: 11, marginTop: 4, maxWidth: 60 }} numberOfLines={1}>{r.name.split(' ')[0]}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}

      <SectionList
        sections={sections}
        keyExtractor={(r) => r.key}
        renderItem={renderRow}
        extraData={sel}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={24}
        renderSectionHeader={({ section }) => (
          <Text style={[st.section, { color: sub }]}>{section.title}</Text>
        )}
        ListFooterComponent={pbFooter}
        ListEmptyComponent={(loadingChatyy || pbState === 'loading' || pbState === 'checking') ? null : (
          <Text style={{ color: ter, textAlign: 'center', paddingVertical: 40, fontSize: 14 }}>{_tr(t, 'chatConv.noContactsFound', 'Nenhum contato encontrado')}</Text>
        )}
        contentContainerStyle={{ paddingBottom: 24 }}
      />
    </View>
  );
}

const st = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  hTitle: { fontSize: 18, fontWeight: '700' },
  nextBtn: { paddingHorizontal: 14, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  search: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, paddingHorizontal: 12, height: 38 },
  section: { fontSize: 13, fontWeight: '600', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 9 },
  name: { fontSize: 15.5, fontWeight: '600' },
  subline: { fontSize: 13, marginTop: 2 },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginLeft: 10 },
  chip: { alignItems: 'center', width: 64 },
  chipX: { position: 'absolute', right: -2, top: -2, width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  permBox: { margin: 16, padding: 16, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  permText: { fontSize: 13.5, textAlign: 'center', marginTop: 8, lineHeight: 19 },
  pill: { paddingHorizontal: 16, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  pillText: { fontSize: 14, fontWeight: '600' },
  card: { borderRadius: 14, padding: 14, marginBottom: 12 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  phoneRow: { flexDirection: 'row', alignItems: 'center', paddingTop: 10, marginTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  footer: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14, borderTopWidth: StyleSheet.hairlineWidth },
  sendBtn: { height: 48, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  sendText: { fontSize: 16, fontWeight: '700' },
});
