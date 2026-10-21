// [2026-10-19 callinfo] "Informações da chamada" no nível do app Telefone do
// iOS / info de ligação do WhatsApp. Abre de uma linha da aba Ligações.
//
//  - Topo: avatar grande, nome, @usuário (ou telefone; e-mail só se não houver
//    nada melhor) + ações rápidas redondas P&B: Mensagem, Áudio, Vídeo.
//  - TODAS as ligações com a pessoa, agrupadas por dia (Hoje / Ontem / 18 de out.),
//    hora 24 h, direção com texto (Perdida em vermelho), tipo e duração por
//    extenso ("2 min 13 s"); sem duração → o próprio status (Não atendida /
//    Cancelada / Recusada) no lugar de "0:00".
//  - Rede: só o que o servidor tem de verdade (net.region = servidor de mídia
//    do convite; net.weak = aparelho reportou conexão fraca). Sem dado → nada.
//  - "Ligar novamente" em tinta (colors.text), nunca verde; rodapé "Apagar do
//    histórico" e "Bloquear" com confirmação.
//
// Folha nativa do sistema (NativeSheet) com o cabeçalho no FLUXO normal do
// conteúdo (sem position absolute) — web/kill-switch → <Modal> pageSheet.
//
// <CallInfoSheet item visible onClose calls onCall={(target, video)} onMessage={(target)} onDeleted={(peerKey)} />
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Modal, Platform, Alert, ActivityIndicator, StyleSheet } from 'react-native';
import Svg, { Path, Polyline } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AvatarCircle from '../AvatarCircle';
import { IconPhone, IconVideo, IconMessageCircle, IconX, IconTrash, IconShield } from '../Icons';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { useGroupedColors } from '../settings/SettingsKit';
import { USE_NATIVE_SHEETS, NativeSheet, runAfterNativeSheet } from '../NativeSheet';
import { androidBottomInset } from '../../utils/systemInsets';
import { callDirection } from '../../services/callHistoryStore';

const RED = '#E53935';

// ── helpers ────────────────────────────────────────────────────────────────
const _lc = (s) => String(s || '').trim().toLowerCase();
const _email = (c) => _lc(c && (c.contactEmail || c.contact_email));
const _phone = (c) => String((c && c.to_number) || '').replace(/[^0-9+]/g, '');
export function callInfoPeerKey(c) {
  const e = _email(c);
  if (e) return e;
  const p = _phone(c);
  return p ? 'tel:' + p : '';
}
const _peerOf = callInfoPeerKey;
const isPhoneOnlyRow = (c) => !_email(c) && !!_phone(c);
function _ts(c) {
  const n = Number(c && c.timestamp);
  if (n > 0) return n < 1e12 ? n * 1000 : n;
  const d = Date.parse((c && (typeof c.timestamp === 'string' ? c.timestamp : '') || (c && (c.started_at || c.created_at))) || '');
  return isNaN(d) ? 0 : d;
}
// id do servidor (a lista da aba prefixa "chat_"; "voip_" = PSTN antigo, outra tabela)
function _sid(c) {
  const raw = String((c && c.id) != null ? c.id : '');
  if (/^voip_/.test(raw)) return 0;
  const n = Number(raw.replace(/^chat_/, ''));
  return n > 0 ? n : 0;
}
function _dur(c) {
  const d = Number(c && (c.duration != null ? c.duration : c.duration_seconds));
  return d > 0 ? Math.round(d) : 0;
}
function _isVideo(c) {
  return !!(c && (c.video === true || c.video === 1 || c.is_video || String(c.type || '').toLowerCase() === 'video'));
}
function _isPlainHandle(s) {
  return /^[a-z0-9]+([._-][a-z0-9]+)*$/.test(String(s || '').trim());
}
function _prettify(s) {
  if (!s || typeof s !== 'string') return s || '?';
  if (/^\+?\d[\d\s\-()]{4,}$/.test(s.trim())) return s;
  let local = s.replace(/@(chatyy\.com\.br|chatyy\.com|onemundo\.com\.br)$/i, '');
  if (local.includes('@')) local = local.split('@')[0];
  local = local.replace(/[._-]+/g, ' ').trim();
  if (!local) return s;
  return local.replace(/\b(\w)/g, (ch) => ch.toUpperCase());
}
function _locale(language) {
  const l = String(language || 'pt-BR');
  if (l === 'pt' || l === 'pt-BR') return 'pt-BR';
  if (l === 'en') return 'en-US';
  return l;
}
// Hora: 24 h (13:53) em todo idioma que não seja inglês; inglês = relógio local do Intl.
function _fmtTime(ms, language) {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  if (String(language || '').startsWith('en')) {
    try { return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); } catch {}
  }
  const hh = d.getHours();
  const mm = d.getMinutes();
  return `${hh < 10 ? '0' : ''}${hh}:${mm < 10 ? '0' : ''}${mm}`;
}
function _dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function _dayLabel(ms, language, t) {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return t('calls.today', 'Hoje');
  if (d.toDateString() === y.toDateString()) return t('calls.yesterday', 'Ontem');
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  try { return d.toLocaleDateString(_locale(language), opts); } catch {}
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}
// 2 min 13 s · 45 s · 1 h 3 min
function _fmtDuration(sec) {
  if (!sec || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return s > 0 ? `${m} min ${s} s` : `${m} min`;
  return `${s} s`;
}
// Resultado da ligação → { kind, label, missed }
function _outcome(c, t) {
  const dir = callDirection(c);
  const st = String((c && c.status) || '').toLowerCase();
  const dur = _dur(c);
  if (dir === 'missed') return { kind: 'missed', label: t('callInfo.missed', 'Perdida'), missed: true };
  if (dir === 'incoming') {
    if (dur > 0 || st === 'answered') return { kind: 'incoming', label: t('callInfo.incoming', 'Recebida') };
    if (st === 'declined' || st === 'busy') return { kind: 'incoming', label: t('callInfo.declined', 'Recusada') };
    return { kind: 'missed', label: t('callInfo.missed', 'Perdida'), missed: true };
  }
  if (dur > 0 || st === 'answered') return { kind: 'outgoing', label: t('callInfo.outgoing', 'Efetuada') };
  if (st === 'cancelled') return { kind: 'outgoing', label: t('callInfo.cancelled', 'Cancelada') };
  if (st === 'declined') return { kind: 'outgoing', label: t('callInfo.declined', 'Recusada') };
  if (st === 'busy') return { kind: 'outgoing', label: t('callInfo.busy', 'Ocupado') };
  if (st === 'ringing') return { kind: 'outgoing', label: t('callInfo.ringing', 'Chamando') };
  return { kind: 'outgoing', label: t('callInfo.noAnswer', 'Não atendida') };
}
const _REGION_FB = {
  us: 'Nova York, EUA', usw: 'Seattle, EUA', br: 'São Paulo, Brasil', br2: 'São Paulo, Brasil',
  eu: 'Manchester, Reino Unido', sg: 'Ásia', in: 'Índia',
};
function _regionLabel(code, t) {
  const c = String(code || '').toLowerCase();
  if (!c || !/^[a-z0-9]{1,12}$/.test(c)) return '';
  if (!_REGION_FB[c]) return c.toUpperCase();
  return t('callInfo.region.' + c, _REGION_FB[c]);
}

// ── ícones de direção (SVG) ────────────────────────────────────────────────
function ArrowOut({ size = 13, color }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M7 17L17 7" /><Polyline points="7 7 17 7 17 17" />
    </Svg>
  );
}
function ArrowIn({ size = 13, color }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M17 7L7 17" /><Polyline points="17 17 7 17 7 7" />
    </Svg>
  );
}
function MissedIcon({ size = 13, color = RED }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M3 7l6 6 4-4 8 8" /><Polyline points="21 11 21 17 15 17" />
    </Svg>
  );
}

// ── componente ─────────────────────────────────────────────────────────────
export default function CallInfoSheet({ item, visible, onClose, calls, onCall, onMessage, onDeleted }) {
  const { colors } = useTheme();
  const { t: rawT, language } = useLanguage();
  const g = useGroupedColors();
  const insets = useSafeAreaInsets();
  const t = useCallback((k, fb, params) => {
    let v;
    try { v = rawT ? rawT(k, params ? { ...params, defaultValue: fb } : fb) : null; } catch { v = null; }
    if (!v || v === k) v = fb;
    if (params && typeof v === 'string') Object.keys(params).forEach((p) => { v = v.split('{' + p + '}').join(String(params[p])); });
    return v;
  }, [rawT]);

  const peer = item ? _peerOf(item) : '';
  const email = item ? _email(item) : '';
  const phone = item ? _phone(item) : '';

  // Ligações com a pessoa: 1º o que já está na lista (instantâneo), depois o servidor (filtro por peer).
  const localRows = useMemo(() => {
    if (!peer || !Array.isArray(calls)) return [];
    return calls.filter((c) => c && _peerOf(c) === peer);
  }, [calls, peer]);
  const [serverRows, setServerRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState(null);
  const [blocked, setBlocked] = useState(null);
  const [busy, setBusy] = useState('');
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  useEffect(() => {
    if (!visible || !peer) return undefined;
    let alive = true;
    setServerRows(null);
    setBlocked(null);
    // [2026-10-21] fechar no meio da busca pulava o setLoading(false) (alive=false)
    // → ao reabrir um contato só com telefone ficava spinner eterno.
    setLoading(!!email);
    // Perfil: cópia local primeiro (sem rede), depois profile_get.
    if (email) {
      try {
        const c = require('../../services/infoCache').getContactInfo(email);
        if (c && c.identity) setProfile(c.identity); else setProfile(null);
      } catch { setProfile(null); }
    } else setProfile(null);
    (async () => {
      const api = require('../../services/api');
      if (email) {
        setLoading(true);
        try {
          const r = await api.callHistoryListPeer(email, 200);
          const arr = r && r.success && r.data && Array.isArray(r.data.calls) ? r.data.calls : null;
          // edge c/ email.php antigo ignora `peer` → filtra aqui também.
          if (alive && arr) setServerRows(arr.filter((c) => _peerOf(c) === peer));
        } catch {}
        if (alive) setLoading(false);
        try {
          const pr = await api.profileGet(email);
          if (alive && pr && pr.success && pr.data && pr.data.identity) {
            setProfile(pr.data.identity);
            try { require('../../services/infoCache').ingestProfile(email, pr.data); } catch {}
          }
        } catch {}
        try {
          const b = await api.chatCheckBlocked(email);
          if (alive && b && b.success && b.data) setBlocked(!!b.data.blocked);
        } catch {}
      }
    })();
    return () => { alive = false; };
  }, [visible, peer, email]);

  const rows = useMemo(() => {
    const seen = new Set();
    const out = [];
    const push = (c) => {
      const id = _sid(c);
      const k = id ? 'i:' + id : ((c.call_id || c.callId) ? 'c:' + (c.call_id || c.callId) : 't:' + _ts(c) + ':' + String(c.id || ''));
      if (seen.has(k)) return;
      seen.add(k);
      out.push(c);
    };
    if (serverRows) {
      serverRows.forEach(push);
      // Da lista local só o que é MAIS NOVO que o servidor (ligação otimista
      // ainda não sincronizada) — o resto já veio do servidor.
      const newest = serverRows.reduce((m, c) => Math.max(m, _ts(c)), 0);
      localRows.forEach((c) => { if (_ts(c) > newest + 1000) push(c); });
    } else {
      localRows.forEach(push);
    }
    out.sort((a, b) => _ts(b) - _ts(a));
    return out;
  }, [serverRows, localRows]);

  const sections = useMemo(() => {
    const map = new Map();
    rows.forEach((c) => {
      const ms = _ts(c);
      const k = ms ? _dayKey(ms) : 'x';
      if (!map.has(k)) map.set(k, { key: k, title: ms ? _dayLabel(ms, language, t) : '', data: [] });
      map.get(k).data.push(c);
    });
    return Array.from(map.values());
  }, [rows, language, t]);

  if (!item) return null;

  // Identidade
  const savedName = item.contactName || item.contact_name || '';
  const profName = profile && profile.name ? String(profile.name) : '';
  const rawName = profName || savedName || item.to_number || email || '?';
  const displayName = (!profName && savedName && _isPlainHandle(savedName)) || (!profName && !savedName)
    ? _prettify(rawName)
    : rawName;
  const username = profile && profile.username ? String(profile.username).replace(/^@/, '') : '';
  const profPhone = profile && profile.phone ? String(profile.phone) : '';
  const subtitle = username ? '@' + username : (profPhone || phone || email || '');

  const ink = g.ink;
  const onInk = g.onInk;
  const sub = g.secondary;
  const sep = g.separator;
  const card = g.cardBg;
  const pageBg = g.pageBg;
  const chip = g.fill;
  const danger = RED;

  // Alvo neutro (sem status/tipo da linha tocada): Mensagem não herda o rascunho
  // "Voltei sua ligação" de uma perdida; Áudio/Vídeo decidem pelo botão.
  const target = {
    contactEmail: email || '', contactName: savedName || profName || '',
    conversation_id: item.conversation_id || item.conversationId || '',
    ...(isPhoneOnlyRow(item) ? { to_number: item.to_number } : {}),
  };
  const after = (fn) => { onClose && onClose(); if (USE_NATIVE_SHEETS) runAfterNativeSheet(fn); else fn(); };
  const doMessage = () => after(() => onMessage && onMessage(target));
  const doCall = (video) => after(() => onCall && onCall({ ...target, video: !!video, type: video ? 'video' : 'audio' }, !!video));

  const confirmDelete = () => {
    Alert.alert(
      t('callInfo.deleteConfirmTitle', 'Apagar histórico de ligações?'),
      t('callInfo.deleteConfirmBody', 'Todas as ligações com {name} serão apagadas do seu histórico.', { name: displayName }),
      [
        { text: t('common.cancel', 'Cancelar'), style: 'cancel' },
        {
          text: t('callInfo.deleteHistory', 'Apagar do histórico'), style: 'destructive',
          onPress: async () => {
            setBusy('delete');
            const api = require('../../services/api');
            let ok = false;
            if (email) {
              try { const r = await api.callHistoryDeletePeer(email); ok = !!(r && r.success); } catch {}
            }
            if (!ok) {
              // servidor sem o modo peer (edge antigo) → uma a uma.
              const ids = rows.map(_sid).filter((id) => id > 0);
              for (let i = 0; i < ids.length; i += 5) {
                try { await Promise.all(ids.slice(i, i + 5).map((id) => api.callHistoryDelete(id).catch(() => null))); } catch {}
              }
            }
            try { onDeleted && onDeleted(peer); } catch {}
            if (aliveRef.current) setBusy('');
            onClose && onClose();
          },
        },
      ],
    );
  };

  const confirmBlock = () => {
    if (!email) return;
    if (blocked) {
      setBusy('block');
      require('../../services/api').chatUnblockUser(email)
        .then((r) => { if (aliveRef.current && r && r.success) setBlocked(false); })
        .catch(() => {})
        .finally(() => { if (aliveRef.current) setBusy(''); });
      return;
    }
    Alert.alert(
      t('callInfo.blockConfirmTitle', 'Bloquear {name}?', { name: displayName }),
      t('callInfo.blockConfirmBody', 'Contatos bloqueados não poderão ligar nem enviar mensagens para você.'),
      [
        { text: t('common.cancel', 'Cancelar'), style: 'cancel' },
        {
          text: t('callInfo.blockAction', 'Bloquear'), style: 'destructive',
          onPress: async () => {
            setBusy('block');
            try {
              const r = await require('../../services/api').chatBlockUser(email);
              if (r && r.success) { if (aliveRef.current) setBlocked(true); }
              else Alert.alert(t('callInfo.errorTitle', 'Não foi possível concluir'), (r && r.message) || '');
            } catch {
              Alert.alert(t('callInfo.errorTitle', 'Não foi possível concluir'));
            }
            if (aliveRef.current) setBusy('');
          },
        },
      ],
    );
  };

  const quickBtn = ({ Icon, label, onPress, testID }) => (
    <TouchableOpacity
      key={testID}
      onPress={onPress}
      activeOpacity={0.6}
      style={st.quick}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      <View style={[st.quickCircle, { backgroundColor: chip }]}>
        <Icon size={22} color={ink} />
      </View>
      <Text style={[st.quickLabel, { color: ink }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );

  const callRow = (c, last, key) => {
    const o = _outcome(c, t);
    const video = _isVideo(c);
    const dur = _dur(c);
    const net = c && c.net && typeof c.net === 'object' ? c.net : null;
    const region = net && net.region ? _regionLabel(net.region, t) : '';
    const weak = !!(net && net.weak);
    const tone = o.missed ? danger : ink;
    const Arrow = o.missed ? MissedIcon : (o.kind === 'incoming' ? ArrowIn : ArrowOut);
    const typeLabel = video ? t('calls.video', 'Vídeo') : t('calls.audio', 'Áudio');
    const timeStr = _fmtTime(_ts(c), language);
    return (
      <View
        key={key}
        style={[st.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: sep }]}
        accessible
        accessibilityLabel={[timeStr, o.label, typeLabel, _fmtDuration(dur)].filter(Boolean).join(', ')}
      >
        <Text style={[st.rowTime, { color: ink }]}>{timeStr}</Text>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={st.rowMain}>
            <Arrow size={13} color={o.missed ? danger : sub} />
            <Text style={[st.rowLabel, { color: tone }]} numberOfLines={1}>{o.label}</Text>
            <Text style={[st.rowType, { color: sub }]} numberOfLines={1}>{'  ·  ' + typeLabel}</Text>
          </View>
          {(region || weak) ? (
            <Text style={[st.rowNet, { color: sub }]} numberOfLines={1}>
              {[region ? t('callInfo.server', 'Servidor: {region}', { region }) : '', weak ? t('callInfo.weak', 'Conexão instável') : ''].filter(Boolean).join('  ·  ')}
            </Text>
          ) : null}
        </View>
        {dur > 0 ? <Text style={[st.rowDur, { color: sub }]}>{_fmtDuration(dur)}</Text> : null}
      </View>
    );
  };

  const isPhoneOnly = !email && !!phone;
  const body = (
    <View style={{ flex: 1, backgroundColor: pageBg }}>
      {/* Cabeçalho no fluxo (nunca absolute — evita sobrepor o conteúdo na folha nativa) */}
      <View style={[st.header, { paddingTop: Platform.OS === 'ios' && USE_NATIVE_SHEETS ? 16 : 12 }]}>
        <View style={st.headerSide} />
        <Text style={[st.headerTitle, { color: ink }]} numberOfLines={1} accessibilityRole="header">
          {t('calls.callInfo', 'Informações da chamada')}
        </Text>
        <View style={[st.headerSide, { alignItems: 'flex-end' }]}>
          <TouchableOpacity
            onPress={onClose}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={[st.closeBtn, { backgroundColor: chip }]}
            accessibilityRole="button"
            accessibilityLabel={t('common.close', 'Fechar')}
            testID="callinfo-close"
          >
            <IconX size={16} color={sub} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: (Platform.OS === 'ios' ? (insets.bottom || 0) : androidBottomInset(0)) + 28 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Identidade */}
        <View style={st.hero}>
          {email ? (
            <AvatarCircle name={displayName} email={email} size={92} />
          ) : (
            <View style={[st.heroAvatar, { backgroundColor: chip }]}>
              <IconPhone size={36} color={sub} />
            </View>
          )}
          <Text style={[st.heroName, { color: ink }]} numberOfLines={2}>{displayName}</Text>
          {subtitle ? <Text style={[st.heroSub, { color: sub }]} numberOfLines={1}>{subtitle}</Text> : null}
          {blocked ? (
            <Text style={[st.heroSub, { color: danger, marginTop: 4 }]}>{t('callInfo.blocked', 'Bloqueado')}</Text>
          ) : null}
        </View>

        {/* Ações rápidas */}
        <View style={st.quickRow}>
          {!isPhoneOnly ? quickBtn({ Icon: IconMessageCircle, label: t('callInfo.message', 'Mensagem'), onPress: doMessage, testID: 'callinfo-message' }) : null}
          {quickBtn({ Icon: IconPhone, label: t('calls.audio', 'Áudio'), onPress: () => doCall(false), testID: 'callinfo-audio' })}
          {!isPhoneOnly ? quickBtn({ Icon: IconVideo, label: t('calls.video', 'Vídeo'), onPress: () => doCall(true), testID: 'callinfo-video' }) : null}
        </View>

        {/* Ligações com a pessoa, por dia */}
        {sections.length === 0 ? (
          <View style={[st.card, { backgroundColor: card, alignItems: 'center', paddingVertical: 22 }]}>
            {loading ? <ActivityIndicator color={sub} /> : (
              <Text style={{ color: sub, fontSize: 15 }}>{t('callInfo.empty', 'Nenhuma ligação registrada')}</Text>
            )}
          </View>
        ) : sections.map((sec) => (
          <View key={sec.key} style={{ marginBottom: 18 }}>
            <Text style={[st.secTitle, { color: g.header }]}>{sec.title}</Text>
            <View style={[st.card, { backgroundColor: card }]}>
              {sec.data.map((c, i) => (
                callRow(c, i === sec.data.length - 1, String(c.id != null ? c.id : (c.call_id || i)) + ':' + i)
              ))}
            </View>
          </View>
        ))}
        {loading && sections.length > 0 ? (
          <View style={{ alignItems: 'center', marginTop: -8, marginBottom: 12 }}><ActivityIndicator size="small" color={sub} /></View>
        ) : null}

        {/* Ligar novamente — tinta, nunca verde */}
        <TouchableOpacity
          onPress={() => doCall(false)}
          activeOpacity={0.8}
          style={[st.primary, { backgroundColor: colors.text || ink }]}
          accessibilityRole="button"
          testID="callinfo-call-again"
        >
          <IconPhone size={18} color={onInk} />
          <Text style={[st.primaryText, { color: onInk }]}>
            {isPhoneOnly ? t('calls.callViaChatyy', 'Ligar pelo Chatyy') : t('calls.callAgain', 'Ligar novamente')}
          </Text>
        </TouchableOpacity>

        {/* Rodapé destrutivo */}
        <View style={[st.card, { backgroundColor: card, marginTop: 22 }]}>
          <TouchableOpacity
            onPress={confirmDelete}
            disabled={!!busy}
            activeOpacity={0.6}
            style={[st.footRow, email && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: sep }]}
            accessibilityRole="button"
            testID="callinfo-delete"
          >
            <IconTrash size={19} color={danger} />
            <Text style={[st.footText, { color: danger }]}>{t('callInfo.deleteHistory', 'Apagar do histórico')}</Text>
            {busy === 'delete' ? <ActivityIndicator size="small" color={sub} /> : null}
          </TouchableOpacity>
          {email ? (
            <TouchableOpacity
              onPress={confirmBlock}
              disabled={!!busy}
              activeOpacity={0.6}
              style={st.footRow}
              accessibilityRole="button"
              testID="callinfo-block"
            >
              <IconShield size={19} color={danger} />
              <Text style={[st.footText, { color: danger }]} numberOfLines={1}>
                {blocked
                  ? t('callInfo.unblock', 'Desbloquear {name}', { name: displayName })
                  : t('callInfo.block', 'Bloquear {name}', { name: displayName })}
              </Text>
              {busy === 'block' ? <ActivityIndicator size="small" color={sub} /> : null}
            </TouchableOpacity>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );

  if (USE_NATIVE_SHEETS) {
    return (
      <NativeSheet visible={!!visible} onClose={onClose} detents={[0.82, 1]} backgroundColor={pageBg}>
        {body}
      </NativeSheet>
    );
  }
  return (
    <Modal visible={!!visible} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined} onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: pageBg, paddingTop: Platform.OS === 'ios' ? 0 : (insets.top || 0) }}>
        {body}
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 6 },
  headerSide: { width: 44 },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', letterSpacing: -0.2 },
  closeBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  hero: { alignItems: 'center', paddingTop: 10, paddingBottom: 18 },
  heroAvatar: { width: 92, height: 92, borderRadius: 46, alignItems: 'center', justifyContent: 'center' },
  heroName: { fontSize: 26, fontWeight: '700', letterSpacing: -0.4, marginTop: 12, textAlign: 'center' },
  heroSub: { fontSize: 15, marginTop: 3, textAlign: 'center' },
  quickRow: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginBottom: 26 },
  quick: { alignItems: 'center', width: 72 },
  quickCircle: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  quickLabel: { fontSize: 13, fontWeight: '500', marginTop: 7 },
  secTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.3, marginLeft: 16, marginBottom: 7 },
  card: { borderRadius: 14, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, minHeight: 52 },
  rowTime: { width: 64, fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  rowMain: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowLabel: { fontSize: 16, flexShrink: 1 },
  rowType: { fontSize: 15, flexShrink: 1 },
  rowNet: { fontSize: 13, marginTop: 3, marginLeft: 19 },
  rowDur: { fontSize: 15, marginLeft: 8, fontVariant: ['tabular-nums'] },
  primary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 52, borderRadius: 14, marginTop: 6 },
  primaryText: { fontSize: 17, fontWeight: '600' },
  footRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, minHeight: 50 },
  footText: { flex: 1, fontSize: 16 },
});
