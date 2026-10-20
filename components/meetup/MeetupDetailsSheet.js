// [encontro3 2026-10-20] Detalhes do encontro (toque no cartão): título, data, local com mapa +
// "Como chegar" (visualizador nativo), descrição, quem criou, participantes por resposta
// (Vão / Talvez / Não vão / Sem resposta em grupo), botões Vou/Talvez/Não vou, Editar/Cancelar
// p/ o autor e "Adicionar ao calendário" (expo-calendar, já no binário). Uma folha só (sem Modal
// sobre Modal): ações que abrem outra tela fecham esta antes. Ao vivo: o `msg` vem da lista da
// conversa (WS meetup_rsvp_update / edit já atualizam a linha).

import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Pressable, ActivityIndicator, Alert, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AvatarCircle from '../AvatarCircle';
import LocationMapPreview from '../LocationMapPreview';
import { IconCalendar, IconClock, IconMapPin, IconX, IconNavigation, IconUser } from '../Icons';
import * as api from '../../services/api';
import { parseMeetupLocation, meetupState } from './meetupLocation';

function _json(c) {
  if (c && typeof c === 'object') return c;
  try { const j = JSON.parse(String(c || '')); return j && typeof j === 'object' ? j : null; } catch { return null; }
}
function _mapKeep(arr, fn) {
  let changed = false;
  const out = arr.map((x) => { const y = fn(x); if (y !== x) changed = true; return y; });
  return changed ? out : arr;
}
const _lc = (e) => String(e || '').trim().toLowerCase();

export default function MeetupDetailsSheet({
  msg, members, currentEmail, isGroup, colors, t, isDark,
  onClose, setMessages, onOpenMap, onEdit,
}) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(null); // status em envio | 'cancel' | 'cal'
  const tr = (k, fb) => { try { const v = t && t(k); return v && v !== k ? v : fb; } catch { return fb; } };
  const mt = _json(msg && msg.content) || (msg && msg.meetup) || {};
  const st = meetupState(mt);
  const me = _lc(currentEmail);
  const isAuthor = msg && _lc(msg.sender_email) === me && typeof msg.id === 'number';
  const d = new Date(mt.datetime);
  const validDate = !isNaN(d.getTime());
  const isPast = validDate && d.getTime() < Date.now();
  const loc = parseMeetupLocation(mt.location);
  const hasC = loc.lat != null && loc.lng != null;
  const ink = colors.text;
  const onInk = colors.background || colors.surface;

  const nameOf = useMemo(() => {
    const byEmail = new Map();
    (members || []).forEach((m) => { if (m && m.email) byEmail.set(_lc(m.email), m); });
    return (email) => {
      const e = _lc(email);
      if (e === me) return tr('chat.you', 'Você');
      let nick = '';
      try { nick = require('../../services/nicknames').getNickname?.(email) || ''; } catch {}
      const m = byEmail.get(e);
      const dn = nick || (m && (m.display_name || m.name)) || '';
      if (dn && !dn.includes('@')) return dn;
      try { return api.emailToDisplayName(email) || email; } catch { return email; }
    };
  }, [members, me]); // eslint-disable-line react-hooks/exhaustive-deps

  // email → going | maybe | not_going (content.rsvp é o formato que o app já mantém ao vivo)
  const rsvp = useMemo(() => {
    const out = {};
    const flat = mt.rsvp && typeof mt.rsvp === 'object' ? mt.rsvp : null;
    if (flat) Object.keys(flat).forEach((k) => { out[_lc(k)] = flat[k]; });
    else if (mt.rsvps && typeof mt.rsvps === 'object') {
      const map = { yes: 'going', no: 'not_going', maybe: 'maybe' };
      Object.keys(mt.rsvps).forEach((g) => (mt.rsvps[g] || []).forEach((e) => { out[_lc(e)] = map[g] || g; }));
    }
    return out;
  }, [msg && msg.content]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const g = { going: [], maybe: [], not_going: [], none: [] };
    Object.keys(rsvp).forEach((e) => { if (g[rsvp[e]]) g[rsvp[e]].push(e); });
    if (isGroup) (members || []).forEach((m) => { const e = _lc(m && m.email); if (e && !rsvp[e]) g.none.push(e); });
    const sortFn = (a, b) => (a === me ? -1 : b === me ? 1 : nameOf(a).localeCompare(nameOf(b)));
    Object.keys(g).forEach((k) => g[k].sort(sortFn));
    return g;
  }, [rsvp, members, isGroup, nameOf, me]);
  const myRsvp = rsvp[me] || null;

  const dateLong = (() => {
    if (!validDate) return String(mt.datetime || '');
    const locTag = tr('_locale', undefined);
    try {
      const day = d.toLocaleDateString(locTag, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
      const hm = d.toLocaleTimeString(locTag, { hour: '2-digit', minute: '2-digit' });
      return `${day.charAt(0).toUpperCase()}${day.slice(1)} · ${hm}`;
    } catch { return d.toString(); }
  })();

  const patchContent = (fn) => {
    if (!setMessages || !msg) return;
    setMessages((prev) => _mapKeep(prev, (x) => {
      if (String(x.id) !== String(msg.id)) return x;
      const j = _json(x.content) || {};
      const nj = fn(j);
      return { ...x, content: JSON.stringify(nj), meetup: { ...(x.meetup || {}), ...nj } };
    }));
  };

  const doRsvp = async (status) => {
    if (busy || st.cancelled || !msg || typeof msg.id !== 'number') return;
    setBusy(status);
    try {
      const r = await api.chatMeetupRsvp(msg.id, status);
      if (r && r.success && r.data) patchContent((j) => ({ ...j, ...(r.data.rsvp ? { rsvp: r.data.rsvp } : {}), ...(r.data.rsvps ? { rsvps: r.data.rsvps } : {}) }));
      else if (r && r.data && r.data.code === 'meetup_cancelled') patchContent((j) => ({ ...j, cancelled: true }));
    } catch {}
    setBusy(null);
  };

  const doCancel = () => {
    const go = async () => {
      setBusy('cancel');
      try {
        const r = await api.chatUpdateMeetup(msg.id, { cancel: 1 });
        if (r && r.success && r.data && typeof r.data.content === 'string') {
          const nj = _json(r.data.content) || {};
          patchContent(() => nj);
        }
      } catch {}
      setBusy(null);
    };
    const ttl = tr('chatConv.meetupCancelTitle', 'Cancelar encontro?');
    const m = tr('chatConv.meetupCancelMsg', 'Todos na conversa verão o encontro como cancelado.');
    if (Platform.OS === 'web') { try { if (window.confirm(`${ttl}\n${m}`)) go(); } catch {} return; }
    Alert.alert(ttl, m, [
      { text: tr('common.back', 'Voltar'), style: 'cancel' },
      { text: tr('chatConv.meetupCancelConfirm', 'Cancelar encontro'), style: 'destructive', onPress: go },
    ]);
  };

  const calAvailable = Platform.OS !== 'web' && validDate && (() => {
    try { const C = require('expo-calendar'); return typeof C.createEventInCalendarAsync === 'function'; } catch { return false; }
  })();
  const addToCalendar = () => {
    if (!calAvailable) return;
    const ev = {
      title: String(mt.title || ''),
      startDate: d,
      endDate: new Date(d.getTime() + 2 * 3600 * 1000),
      location: loc.text || undefined,
      notes: mt.description ? String(mt.description) : undefined,
    };
    onClose && onClose();
    // a folha do sistema abre DEPOIS desta fechar (sem Modal sobre Modal)
    setTimeout(() => { try { require('expo-calendar').createEventInCalendarAsync(ev).catch(() => {}); } catch {} }, 450);
  };

  const openMap = () => {
    if (!hasC) return;
    onClose && onClose();
    setTimeout(() => { try { onOpenMap && onOpenMap({ lat: loc.lat, lng: loc.lng, label: loc.text || String(mt.title || '') }); } catch {} }, 400);
  };
  const edit = () => {
    onClose && onClose();
    setTimeout(() => { try { onEdit && onEdit(msg); } catch {} }, 400);
  };

  const Row = ({ Icon, children }) => (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
      <View style={{ width: 22, alignItems: 'center', paddingTop: 1 }}><Icon size={18} color={colors.textSecondary} /></View>
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );

  const Section = ({ label, list }) => {
    if (!list.length) return null;
    return (
      <View style={{ marginTop: 14 }}>
        <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textSecondary, marginBottom: 6, letterSpacing: 0.2 }}>{`${label} (${list.length})`}</Text>
        {list.map((e) => (
          <View key={e} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 7, gap: 12 }}>
            <AvatarCircle email={e} name={nameOf(e)} size={36} />
            <Text style={{ flex: 1, fontSize: 15, color: colors.text, fontWeight: e === me ? '600' : '400' }} numberOfLines={1}>{nameOf(e)}</Text>
            {_lc(msg && msg.sender_email) === e ? <Text style={{ fontSize: 12, color: colors.textTertiary }}>{tr('chatConv.meetupOrganizer', 'Organizador')}</Text> : null}
          </View>
        ))}
      </View>
    );
  };

  const labels = { going: tr('chatConv.imGoing', 'Vou'), maybe: tr('chatConv.imMaybe', 'Talvez'), not_going: tr('chatConv.imNotGoing', 'Não vou') };
  const totalAnswered = groups.going.length + groups.maybe.length + groups.not_going.length;

  return (
    <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' }}>
      <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityRole="button" accessibilityLabel={tr('common.close', 'Fechar')} />
      <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '92%', paddingTop: 10, overflow: 'hidden' }}>
        <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 8 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, marginBottom: 10 }}>
          <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surfaceVariant, alignItems: 'center', justifyContent: 'center' }}>
            <IconCalendar size={21} color={ink} />
          </View>
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={{ fontSize: 20, fontWeight: '800', color: colors.text }} numberOfLines={2}>{String(mt.title || tr('chatConv.meetup', 'Encontro'))}</Text>
            {st.cancelled ? <Text style={{ fontSize: 12, fontWeight: '700', color: colors.textSecondary, marginTop: 2 }}>{tr('chatConv.meetupCancelled', 'Encontro cancelado')}</Text>
              : isPast ? <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textSecondary, marginTop: 2 }}>{tr('chatConv.eventPast', 'Evento encerrado')}</Text>
                : st.updated ? <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textSecondary, marginTop: 2, letterSpacing: 0.3 }}>{tr('chatConv.meetupUpdatedBadge', 'ATUALIZADO')}</Text> : null}
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={tr('common.close', 'Fechar')} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surfaceVariant, alignItems: 'center', justifyContent: 'center' }}>
            <IconX size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>

        <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: (insets.bottom || 12) + 16 }} showsVerticalScrollIndicator={false}>
          <Row Icon={IconClock}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text, textDecorationLine: st.cancelled ? 'line-through' : 'none' }}>{dateLong}</Text>
          </Row>
          {loc.text || hasC ? (
            <Row Icon={IconMapPin}>
              <Text style={{ fontSize: 15, color: colors.text }}>{loc.text}</Text>
              {hasC ? (
                <TouchableOpacity activeOpacity={0.85} onPress={openMap} accessibilityRole="button" style={{ marginTop: 8, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: colors.border }}>
                  <View style={{ height: 130 }}><LocationMapPreview lat={loc.lat} lng={loc.lng} isDark={isDark} zoom={15} /></View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 10, backgroundColor: colors.surfaceVariant }}>
                    <IconNavigation size={15} color={ink} />
                    <Text style={{ fontSize: 14, fontWeight: '700', color: ink }}>{tr('chatConv.meetupDirections', 'Como chegar')}</Text>
                  </View>
                </TouchableOpacity>
              ) : null}
            </Row>
          ) : null}
          {mt.description ? (
            <Row Icon={IconCalendar}><Text style={{ fontSize: 15, color: colors.text, lineHeight: 21 }}>{String(mt.description)}</Text></Row>
          ) : null}
          {msg && msg.sender_email ? (
            <Row Icon={IconUser}><Text style={{ fontSize: 14, color: colors.textSecondary }}>{`${tr('chatConv.meetupCreatedBy', 'Criado por')} ${nameOf(msg.sender_email)}`}</Text></Row>
          ) : null}

          {!st.cancelled && typeof (msg && msg.id) === 'number' ? (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
              {['going', 'maybe', 'not_going'].map((s) => {
                const on = myRsvp === s;
                return (
                  <TouchableOpacity key={s} onPress={() => doRsvp(s)} disabled={!!busy} activeOpacity={0.8} accessibilityRole="button" accessibilityState={{ selected: on }}
                    style={{ flex: 1, paddingVertical: 11, borderRadius: 12, alignItems: 'center', backgroundColor: on ? ink : colors.surfaceVariant, borderWidth: 1, borderColor: on ? ink : colors.border }}>
                    {busy === s ? <ActivityIndicator size="small" color={on ? onInk : ink} />
                      : <Text style={{ fontSize: 14, fontWeight: on ? '700' : '600', color: on ? onInk : colors.text }}>{labels[s].replace(/!$/, '')}</Text>}
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}

          <Section label={tr('chatConv.meetupGoingList', 'Vão')} list={groups.going} />
          <Section label={tr('chatConv.meetupMaybeList', 'Talvez')} list={groups.maybe} />
          <Section label={tr('chatConv.meetupNotGoingList', 'Não vão')} list={groups.not_going} />
          {isGroup ? <Section label={tr('chatConv.meetupNoAnswerList', 'Sem resposta')} list={groups.none} /> : null}
          {!totalAnswered && !(isGroup && groups.none.length) ? (
            <Text style={{ fontSize: 14, color: colors.textSecondary, marginTop: 16 }}>{tr('chatConv.meetupNoAnswersYet', 'Ninguém respondeu ainda.')}</Text>
          ) : null}

          {calAvailable && !st.cancelled ? (
            <TouchableOpacity onPress={addToCalendar} activeOpacity={0.75} accessibilityRole="button"
              style={{ marginTop: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border }}>
              <IconCalendar size={16} color={ink} />
              <Text style={{ fontSize: 15, fontWeight: '600', color: ink }}>{tr('chatConv.meetupAddToCalendar', 'Adicionar ao calendário')}</Text>
            </TouchableOpacity>
          ) : null}
          {isAuthor && !st.cancelled ? (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
              <TouchableOpacity onPress={edit} activeOpacity={0.75} accessibilityRole="button" style={{ flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: colors.surfaceVariant }}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: ink }}>{tr('chatConv.edit', 'Editar')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={doCancel} disabled={busy === 'cancel'} activeOpacity={0.75} accessibilityRole="button" style={{ flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: colors.border }}>
                {busy === 'cancel' ? <ActivityIndicator size="small" color={ink} /> : <Text style={{ fontSize: 15, fontWeight: '600', color: ink }}>{tr('chatConv.meetupCancelConfirm', 'Cancelar encontro')}</Text>}
              </TouchableOpacity>
            </View>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}
