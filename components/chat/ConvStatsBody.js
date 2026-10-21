// [2026-10-19 stats-v2] Corpo da folha "Estatísticas" da conversa.
// Antes era um IIFE memoizado por ref dentro de chat-conversation.js (abria
// vazio na folha nativa) e só contava as mensagens carregadas na tela.
// Agora: componente próprio que busca chat_conversation_stats (histórico
// inteiro, SQL no servidor) e cai para as mensagens locais se falhar.
// Visual mono (preto/branco), cartões arredondados, barras finas.
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import AvatarCircle from '../AvatarCircle';
import {
  IconMessageSquare, IconImage, IconFilm, IconMusic, IconSparkles, IconPaperclip,
  IconMapPin, IconBarChart, IconClock, IconCalendar, IconPhone, IconZap,
} from '../Icons';
import { chatConversationStats } from '../../services/api';

const TYPE_ORDER = ['text', 'image', 'video', 'audio', 'sticker', 'gif', 'file', 'location', 'poll', 'call', 'other'];
const TYPE_ICON = {
  text: IconMessageSquare, image: IconImage, video: IconFilm, audio: IconMusic, sticker: IconSparkles,
  gif: IconFilm, file: IconPaperclip, location: IconMapPin, poll: IconBarChart, call: IconPhone, other: IconBarChart,
};

function tr(t, k, fb) {
  try { const v = t ? t(k) : ''; return v && v !== k ? v : fb; } catch { return fb; }
}

// [2026-10-21 polish-conv] separador de milhar no idioma do aparelho (era pt-BR fixo).
function fmtNum(n) {
  try { return Number(n || 0).toLocaleString(); } catch { return String(n || 0); }
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return ''; }
}

function fmtGap(sec, t) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '—';
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86400)} ${tr(t, 'chatConv.statsDays', 'dias')}`;
}

// Servidor manda by_hour em UTC → gira para o fuso do aparelho.
function toLocalHours(utc) {
  const out = new Array(24).fill(0);
  if (!Array.isArray(utc)) return out;
  const off = Math.round(-new Date().getTimezoneOffset() / 60);
  for (let h = 0; h < 24; h++) out[(h + off + 48) % 24] += Number(utc[h] || 0);
  return out;
}

// Reserva: mesmas métricas a partir das mensagens carregadas.
function localStats(messages, myEmail) {
  const msgs = (messages || []).filter((m) => m && !m._pending && m.type !== 'system');
  const bySender = {};
  const byType = {};
  const byHour = new Array(24).fill(0);
  let chars = 0, first = null, last = null;
  for (const m of msgs) {
    const s = String(m.sender_email || '');
    if (s) bySender[s] = (bySender[s] || 0) + 1;
    const tp = TYPE_ORDER.includes(m.type) ? m.type : (m.type ? 'other' : 'text');
    byType[tp] = (byType[tp] || 0) + 1;
    if (typeof m.content === 'string') chars += m.content.length;
    const ts = new Date(m.created_at).getTime();
    if (!isNaN(ts)) {
      if (first == null || ts < first) first = ts;
      if (last == null || ts > last) last = ts;
      byHour[new Date(ts).getHours()]++;
    }
  }
  const total = msgs.length;
  const span = first != null ? Math.max(1, Math.ceil((last - first) / 86400000)) : 1;
  const me = String(myEmail || '').toLowerCase();
  return {
    total_messages: total,
    avg_message_chars: total ? Math.round(chars / total) : 0,
    first_message_at: first != null ? new Date(first).toISOString() : null,
    span_days: span,
    messages_per_day: Math.round(total / span),
    by_participant: Object.entries(bySender).sort((a, b) => b[1] - a[1]).map(([email, count]) => ({
      email, name: email.split('@')[0], count, is_me: email.toLowerCase() === me,
      percent: total ? Math.round((count * 100) / total) : 0,
    })),
    by_type: byType,
    _hoursLocal: byHour,
    _partial: true,
  };
}

export default function ConvStatsBody({ conversationId, messages, myEmail, colors, isDark, t }) {
  const [remote, setRemote] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setRemote(null); // [2026-10-21 polish-conv] nunca mostra os números da conversa anterior
    (async () => {
      try {
        const r = await chatConversationStats(conversationId);
        const d = r?.data || null;
        if (alive && r?.success && d && typeof d.total_messages === 'number') setRemote(d);
      } catch {}
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [conversationId]);

  const local = useMemo(() => (remote ? null : localStats(messages, myEmail)), [remote, messages, myEmail]);
  const s = remote || local || {};
  const hours = remote ? toLocalHours(remote.by_hour) : (s._hoursLocal || new Array(24).fill(0));
  const maxHour = Math.max(1, ...hours);
  const peakHour = hours.indexOf(Math.max(...hours));

  const card = isDark ? 'rgba(255,255,255,0.05)' : '#FFFFFF';
  const line = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const track = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const ink = colors.text;
  const sub = colors.textSecondary;
  const faint = colors.textTertiary || sub;

  const Card = ({ children, style }) => (
    <View style={[{ backgroundColor: card, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: line, padding: 16 }, style]}>{children}</View>
  );
  const SectionTitle = ({ children }) => (
    <Text style={{ fontSize: 12, fontWeight: '700', color: sub, letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 22, marginBottom: 8, marginLeft: 4 }}>{children}</Text>
  );
  const Metric = ({ Icon, value, label }) => (
    <Card style={{ flex: 1, padding: 14 }}>
      <Icon size={18} color={sub} />
      <Text style={{ fontSize: 22, fontWeight: '800', color: ink, marginTop: 10, letterSpacing: -0.4 }} numberOfLines={1} adjustsFontSizeToFitWidth>{value}</Text>
      <Text style={{ fontSize: 12, color: sub, marginTop: 2 }} numberOfLines={1}>{label}</Text>
    </Card>
  );

  if (loading && !remote && !(messages || []).length) {
    return <View style={{ paddingVertical: 60, alignItems: 'center' }}><ActivityIndicator color={sub} /></View>;
  }

  const total = Number(s.total_messages || 0);
  const parts = Array.isArray(s.by_participant) ? s.by_participant : [];
  const types = TYPE_ORDER.map((k) => [k, Number((s.by_type || {})[k] || 0)]).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  const maxType = Math.max(1, ...types.map(([, c]) => c));
  const daily = Array.isArray(s.daily_14d) ? s.daily_14d : [];
  const maxDaily = Math.max(1, ...daily.map((d) => Number(d.count || 0)));
  const typeLabel = {
    text: tr(t, 'chatConv.statsTypeText', 'Texto'), image: tr(t, 'chatConv.statsTypeImage', 'Fotos'),
    video: tr(t, 'chatConv.statsTypeVideo', 'Vídeos'), audio: tr(t, 'chatConv.statsTypeAudio', 'Áudios'),
    sticker: tr(t, 'chatConv.statsTypeSticker', 'Figurinhas'), gif: 'GIFs', file: tr(t, 'chatConv.statsTypeFile', 'Arquivos'),
    location: tr(t, 'chatConv.statsTypeLocation', 'Localização'), poll: tr(t, 'chatConv.statsTypePoll', 'Enquetes'),
    call: tr(t, 'chatConv.statsTypeCall', 'Ligações'), other: tr(t, 'chatConv.statsTypeOther', 'Outros'),
  };
  const since = fmtDate(s.first_message_at);
  const nameOf = (p) => (p.is_me ? tr(t, 'chatConv.statsYou', 'Você') : (p.name || String(p.email || '').split('@')[0]));
  const twoWay = parts.length === 2;

  return (
    <View>
      {/* Destaque: total */}
      <View style={{ alignItems: 'center', paddingTop: 6, paddingBottom: 18 }}>
        <Text style={{ fontSize: 44, fontWeight: '800', color: ink, letterSpacing: -1.5 }}>{fmtNum(total)}</Text>
        <Text style={{ fontSize: 15, color: sub, marginTop: 2 }}>{tr(t, 'chatConv.statsMessagesWord', 'mensagens')}</Text>
        {since ? (
          <Text style={{ fontSize: 13, color: faint, marginTop: 6 }}>
            {tr(t, 'chatConv.statsSince', 'desde')} {since}{s.active_days ? ` · ${fmtNum(s.active_days)} ${tr(t, 'chatConv.statsActiveDays', 'dias ativos')}` : ''}
          </Text>
        ) : null}
        {s._partial && loading ? <ActivityIndicator style={{ marginTop: 8 }} size="small" color={faint} /> : null}
      </View>

      {/* Métricas */}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Metric Icon={IconCalendar} value={fmtNum(s.messages_per_day)} label={tr(t, 'chatConv.statsPerDay', 'Por dia')} />
        <Metric Icon={IconClock} value={`${peakHour}h`} label={tr(t, 'chatConv.statsPeakHour', 'Hora de pico')} />
      </View>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
        {remote ? (
          <Metric Icon={IconZap} value={fmtGap(remote.avg_reply_seconds, t)} label={tr(t, 'chatConv.statsReply', 'Tempo de resposta')} />
        ) : (
          <Metric Icon={IconMessageSquare} value={fmtNum(s.avg_message_chars)} label={tr(t, 'chatConv.statsAvgLen', 'Tamanho médio')} />
        )}
        <Metric Icon={IconImage} value={fmtNum(remote ? remote.media_total : types.filter(([k]) => k !== 'text').reduce((a, [, c]) => a + c, 0))} label={tr(t, 'chatConv.statsMedia', 'Mídias')} />
      </View>

      {/* Quem fala mais */}
      {parts.length > 0 ? (
        <>
          <SectionTitle>{tr(t, 'chatConv.statsBySender', 'Por participante')}</SectionTitle>
          <Card>
            {twoWay ? (
              <>
                <View style={{ flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden', backgroundColor: track }}>
                  <View style={{ flex: Math.max(1, parts[0].count), backgroundColor: ink }} />
                  <View style={{ width: 2 }} />
                  <View style={{ flex: Math.max(1, parts[1].count), backgroundColor: isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.28)' }} />
                </View>
                {parts.map((p, i) => (
                  <View key={p.email} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 14 }}>
                    <AvatarCircle email={p.email} name={nameOf(p)} size={32} />
                    <View style={{ width: 8, height: 8, borderRadius: 4, marginLeft: 12, backgroundColor: i === 0 ? ink : (isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.28)') }} />
                    <Text style={{ flex: 1, marginLeft: 8, fontSize: 15, fontWeight: '600', color: ink }} numberOfLines={1}>{nameOf(p)}</Text>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: ink }}>{p.percent}%</Text>
                    <Text style={{ fontSize: 13, color: faint, marginLeft: 6, minWidth: 44, textAlign: 'right' }}>{fmtNum(p.count)}</Text>
                  </View>
                ))}
              </>
            ) : parts.slice(0, 10).map((p, i) => (
              <View key={p.email} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderTopColor: line }}>
                <AvatarCircle email={p.email} name={nameOf(p)} size={32} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: ink }} numberOfLines={1}>{nameOf(p)}</Text>
                    <Text style={{ fontSize: 13, color: sub }}>{fmtNum(p.count)} · {p.percent}%</Text>
                  </View>
                  <View style={{ height: 5, borderRadius: 3, backgroundColor: track, marginTop: 6, overflow: 'hidden' }}>
                    <View style={{ width: `${Math.max(2, p.percent)}%`, height: '100%', backgroundColor: ink, borderRadius: 3 }} />
                  </View>
                </View>
              </View>
            ))}
          </Card>
        </>
      ) : null}

      {/* Últimos 14 dias */}
      {daily.length ? (
        <>
          <SectionTitle>{tr(t, 'chatConv.statsLast14', 'Últimos 14 dias')}</SectionTitle>
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 84, gap: 5 }}>
              {daily.map((d, i) => {
                const c = Number(d.count || 0);
                return (
                  <View key={d.date || i} style={{ flex: 1, height: '100%', justifyContent: 'flex-end' }}>
                    <View style={{ height: `${Math.max(4, (c / maxDaily) * 100)}%`, borderRadius: 4, backgroundColor: c ? ink : track }} />
                  </View>
                );
              })}
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
              <Text style={{ fontSize: 11, color: faint }}>{(() => { try { return new Date(daily[0].date + 'T12:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); } catch { return ''; } })()}</Text>
              <Text style={{ fontSize: 11, color: faint }}>{tr(t, 'chatConv.statsToday', 'Hoje')}</Text>
            </View>
          </Card>
        </>
      ) : null}

      {/* Atividade por hora */}
      {hours.some((h) => h > 0) ? (
        <>
          <SectionTitle>{tr(t, 'chatConv.statsActivity24h', 'Atividade em 24h')}</SectionTitle>
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 64, gap: 2 }}>
              {hours.map((h, i) => (
                <View key={i} style={{ flex: 1, height: '100%', justifyContent: 'flex-end' }}>
                  <View style={{ height: `${Math.max(4, (h / maxHour) * 100)}%`, borderRadius: 2, backgroundColor: h ? ink : track, opacity: h && i !== peakHour ? 0.55 : 1 }} />
                </View>
              ))}
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
              {['0h', '6h', '12h', '18h', '23h'].map((l) => <Text key={l} style={{ fontSize: 11, color: faint }}>{l}</Text>)}
            </View>
          </Card>
        </>
      ) : null}

      {/* Por tipo */}
      {types.length ? (
        <>
          <SectionTitle>{tr(t, 'chatConv.statsByType', 'Por tipo')}</SectionTitle>
          <Card style={{ paddingVertical: 6 }}>
            {types.map(([k, c], i) => {
              const Icon = TYPE_ICON[k] || IconBarChart;
              return (
                <View key={k} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderTopColor: line }}>
                  <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: track, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon size={16} color={ink} />
                  </View>
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 15, color: ink, fontWeight: '600' }}>{typeLabel[k] || k}</Text>
                      <Text style={{ fontSize: 14, color: sub, fontWeight: '600' }}>{fmtNum(c)}</Text>
                    </View>
                    <View style={{ height: 4, borderRadius: 2, backgroundColor: track, marginTop: 6, overflow: 'hidden' }}>
                      <View style={{ width: `${Math.max(2, (c / maxType) * 100)}%`, height: '100%', backgroundColor: ink, borderRadius: 2 }} />
                    </View>
                  </View>
                </View>
              );
            })}
          </Card>
        </>
      ) : null}

      {/* Primeira mensagem */}
      {remote?.first_message?.preview ? (
        <>
          <SectionTitle>{tr(t, 'chatConv.statsFirstMsg', 'Primeira mensagem')}</SectionTitle>
          <Card>
            <View style={{ borderLeftWidth: 3, borderLeftColor: ink, paddingLeft: 12 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: ink }} numberOfLines={1}>
                {String(remote.first_message.sender_email || '').toLowerCase() === String(myEmail || '').toLowerCase()
                  ? tr(t, 'chatConv.statsYou', 'Você') : (remote.first_message.sender_name || '')}
              </Text>
              <Text style={{ fontSize: 15, color: ink, marginTop: 4, lineHeight: 20 }} numberOfLines={3}>{remote.first_message.preview}</Text>
              <Text style={{ fontSize: 12, color: faint, marginTop: 6 }}>{fmtDate(remote.first_message.created_at)}</Text>
            </View>
          </Card>
        </>
      ) : null}

      {s._partial && !loading ? (
        <Text style={{ fontSize: 12, color: faint, textAlign: 'center', marginTop: 18 }}>
          {tr(t, 'chatConv.statsPartial', 'Baseado nas mensagens carregadas neste aparelho')}
        </Text>
      ) : null}
    </View>
  );
}
