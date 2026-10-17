// [busca-conversa 2026-10-16] "Ir para data" da busca na conversa (WhatsApp/Telegram).
// Calendário mensal: só os dias que TÊM mensagem visível ficam tocáveis (servidor
// chat_message_days, no fuso do aparelho). Servidor velho / offline → libera todos
// os dias até hoje. Tocar no dia chama onPick(Date local 00:00) e fecha.
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconChevronLeft, IconX } from '../Icons';
import * as api from '../../services/api';
import { useLanguage } from '../../context/LanguageContext';
import useDragToDismiss, { DragSheetRoot, DragPanel, DragBackdrop } from '../ui/useDragToDismiss';

const pad2 = (n) => (n < 10 ? '0' + n : String(n));
export const dayKeyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const parseKey = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

// Cache curto por conversa (reabrir o calendário não refaz a consulta).
const _daysCache = new Map(); // cid → { at, days:Set, first, last }

function firstWeekday(locale) {
  try {
    const L = new Intl.Locale(locale || 'pt-BR');
    const wi = (typeof L.getWeekInfo === 'function' ? L.getWeekInfo() : L.weekInfo) || null;
    if (wi && wi.firstDay) return wi.firstDay % 7; // 1=seg … 7=dom → 0=dom
  } catch {}
  return 0;
}

const tr = (t, k, fb) => { try { const v = t && t(k); return v && v !== k ? v : fb; } catch { return fb; } };

export default function JumpToDateSheet({ visible, onClose, onPick, conversationId, colors, isDark, t }) {
  // [2026-10-17 drag-dismiss] folha desce arrastando de qualquer ponto (components/ui/useDragToDismiss).
  const _drag109 = useDragToDismiss({ onDismiss: () => { const f = onClose; if (typeof f === 'function') f(); } });
  const insets = useSafeAreaInsets();
  const { language } = useLanguage() || {};
  const locale = language || undefined;
  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const [info, setInfo] = useState(null); // { days:Set, first, last } | false (sem dados)
  const [month, setMonth] = useState(() => monthStart(new Date()));

  useEffect(() => {
    if (!visible || !conversationId) return undefined;
    let alive = true;
    const c = _daysCache.get(String(conversationId));
    const apply = (v) => {
      setInfo(v);
      // abre no mês da última mensagem (conversa parada há meses → não abre num mês vazio)
      if (v && v.last) setMonth(monthStart(v.last));
      else setMonth(monthStart(new Date()));
    };
    if (c && Date.now() - c.at < 60000) { apply(c); return undefined; }
    setInfo(null);
    Promise.resolve(api.chatMessageDays?.(conversationId))
      .then((r) => {
        if (!alive) return;
        const list = r && r.success && Array.isArray(r.data?.days) ? r.data.days : null;
        if (!list) { apply(false); return; }
        const v = { at: Date.now(), days: new Set(list.map((x) => x && x.d).filter(Boolean)), first: parseKey(r.data.first), last: parseKey(r.data.last) };
        _daysCache.set(String(conversationId), v);
        apply(v);
      })
      .catch(() => { if (alive) apply(false); });
    return () => { alive = false; };
  }, [visible, conversationId]);

  const fwd = useMemo(() => firstWeekday(locale), [locale]);
  const weekdays = useMemo(() => {
    const out = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(2026, 0, 4 + ((fwd + i) % 7)); // 04/01/2026 = domingo
      let s = '';
      try { s = d.toLocaleDateString(locale, { weekday: 'narrow' }); } catch { s = 'DSTQQSS'[d.getDay()]; }
      out.push(s);
    }
    return out;
  }, [fwd, locale]);

  const cells = useMemo(() => {
    const y = month.getFullYear(); const m = month.getMonth();
    const n = new Date(y, m + 1, 0).getDate();
    const lead = (new Date(y, m, 1).getDay() - fwd + 7) % 7;
    const out = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= n; d++) out.push(new Date(y, m, d));
    while (out.length % 7) out.push(null);
    return out;
  }, [month, fwd]);

  let monthLabel = '';
  try { monthLabel = month.toLocaleDateString(locale, { month: 'long', year: 'numeric' }); } catch { monthLabel = `${month.getMonth() + 1}/${month.getFullYear()}`; }
  monthLabel = monthLabel ? monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1) : '';

  const minMonth = info && info.first ? monthStart(info.first) : null;
  const maxMonth = monthStart(today);
  const canPrev = !minMonth || month > minMonth;
  const canNext = month < maxMonth;
  const shift = (k) => setMonth((p) => new Date(p.getFullYear(), p.getMonth() + k, 1));
  const enabled = (d) => !!d && d <= today && (!info || !info.days || info.days.has(dayKeyOf(d)));
  const loading = info === null;
  const fg = colors?.text || (isDark ? '#fff' : '#111');
  const sub = colors?.textTertiary || '#8e8e93';
  const accent = isDark ? '#ffffff' : '#111111';
  const accentInk = isDark ? '#000000' : '#ffffff';
  const pick = (d) => { onClose && onClose(); setTimeout(() => { try { onPick && onPick(d); } catch {} }, Platform.OS === 'ios' ? 280 : 0); };

  if (!visible) return null;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <DragSheetRoot>
      <Pressable style={[st.overlay, { backgroundColor: 'transparent' }]} onPress={onClose} accessibilityLabel={tr(t, 'common.close', 'Fechar')}>
        <DragBackdrop drag={_drag109} color="rgba(0,0,0,0.4)" />
        <DragPanel drag={_drag109} onStartShouldSetResponder={() => true}
          
          style={[st.sheet, { backgroundColor: colors?.surface || (isDark ? '#1c1c1e' : '#fff'), paddingBottom: 16 + (insets?.bottom || 0) }]}
          testID="jump-date-sheet"
        >
          <View style={st.headRow}>
            <Text style={[st.title, { color: fg }]} accessibilityRole="header">{tr(t, 'chatConv.jumpToDate', 'Ir para data')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={tr(t, 'common.close', 'Fechar')} style={st.iconBtn}>
              <IconX size={18} color={sub} />
            </TouchableOpacity>
          </View>
          <View style={st.monthRow}>
            <TouchableOpacity disabled={!canPrev} onPress={() => shift(-1)} hitSlop={10} style={[st.iconBtn, !canPrev && st.dim]}
              accessibilityRole="button" accessibilityLabel={tr(t, 'chatConv.prevMonth', 'Mês anterior')} accessibilityState={{ disabled: !canPrev }} testID="jump-date-prev">
              <IconChevronLeft size={20} color={fg} />
            </TouchableOpacity>
            <Text style={[st.month, { color: fg }]} accessibilityLiveRegion="polite">{monthLabel}</Text>
            <TouchableOpacity disabled={!canNext} onPress={() => shift(1)} hitSlop={10} style={[st.iconBtn, !canNext && st.dim]}
              accessibilityRole="button" accessibilityLabel={tr(t, 'chatConv.nextMonth', 'Próximo mês')} accessibilityState={{ disabled: !canNext }} testID="jump-date-next">
              <IconChevronLeft size={20} color={fg} style={{ transform: [{ rotate: '180deg' }] }} />
            </TouchableOpacity>
          </View>
          <View style={st.grid}>
            {weekdays.map((w, i) => (
              <View key={'w' + i} style={st.cell}><Text style={[st.wd, { color: sub }]}>{w}</Text></View>
            ))}
            {cells.map((d, i) => {
              if (!d) return <View key={'e' + i} style={st.cell} />;
              const on = enabled(d);
              const isToday = d.getTime() === today.getTime();
              const has = !!(info && info.days && info.days.has(dayKeyOf(d)));
              let a11y = '';
              try { a11y = d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); } catch { a11y = dayKeyOf(d); }
              return (
                <View key={'d' + i} style={st.cell}>
                  <TouchableOpacity
                    disabled={!on}
                    onPress={() => pick(d)}
                    accessibilityRole="button"
                    accessibilityLabel={a11y}
                    accessibilityState={{ disabled: !on }}
                    testID={'jump-date-' + dayKeyOf(d)}
                    style={[st.day, isToday && { borderWidth: 1.5, borderColor: accent }, has && on && { backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)' }]}
                  >
                    <Text style={[st.dayTxt, { color: on ? fg : sub, opacity: on ? 1 : 0.4, fontWeight: has ? '700' : '400' }]}>{d.getDate()}</Text>
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
          {loading ? (
            <View style={st.foot}><ActivityIndicator size="small" color={sub} /></View>
          ) : (
            <View style={st.foot}>
              {info && info.first ? (
                <TouchableOpacity onPress={() => pick(info.first)} style={[st.pill, { backgroundColor: accent }]} accessibilityRole="button" testID="jump-date-first">
                  <Text style={[st.pillTxt, { color: accentInk }]}>{tr(t, 'chatConv.jumpFirstMessage', 'Primeira mensagem')}</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity onPress={() => pick(today)} style={[st.pill, { borderWidth: StyleSheet.hairlineWidth, borderColor: sub }]} accessibilityRole="button" testID="jump-date-today">
                <Text style={[st.pillTxt, { color: fg }]}>{tr(t, 'date.today', 'Hoje')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </DragPanel>
      </Pressable>
      </DragSheetRoot>
    </Modal>
  );
}

const st = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end', alignItems: 'center' },
  sheet: { width: '100%', maxWidth: 480, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 16, paddingTop: 14 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  title: { fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 },
  month: { fontSize: 15, fontWeight: '600' },
  iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  dim: { opacity: 0.3 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center', maxHeight: 52 },
  wd: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  day: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  dayTxt: { fontSize: 15 },
  foot: { flexDirection: 'row', justifyContent: 'center', gap: 10, paddingTop: 10, minHeight: 44, alignItems: 'center' },
  pill: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 18 },
  pillTxt: { fontSize: 14, fontWeight: '600' },
});
