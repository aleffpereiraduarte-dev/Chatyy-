// [2026-10-13 calendario] Visão DIA (nível Calendário do iOS / Fantastical, P&B):
//  • grade de 24h com rótulos, blocos com hora/local, sobreposição em colunas;
//  • linha "Agora" (tinta, pulsa a cada minuto) + rolagem automática até ela;
//  • toque num horário vazio → novo evento naquele horário (snap 15 min);
//  • segurar e arrastar um bloco → muda o horário (snap 15 min, mostra a nova
//    hora durante o arraste; recorrentes/dia-inteiro/de terceiros não arrastam);
//  • faixa "dia inteiro" com eventos de dia inteiro + tarefas com prazo no dia.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, PanResponder, Animated, Platform, TouchableOpacity } from 'react-native';
import { IconChevronLeft, IconChevronRight } from '../Icons';
import { parseCalDate, sameDay, startOfDay, hhmm } from '../../utils/calDate';
import { haptic } from '../../constants/theme';
import { dueDate } from '../../utils/taskUtils';

export const DAY_HOUR_H = 64;
const GUTTER = 56;
const SNAP = 15;

function layoutDay(events, day) {
  const ds = startOfDay(day).getTime();
  const de = ds + 86400000;
  const items = [];
  const allDay = [];
  (events || []).forEach((evt) => {
    const s = parseCalDate(evt.start_at).getTime();
    const e = parseCalDate(evt.end_at || evt.start_at).getTime();
    if (!Number.isFinite(s)) return;
    const en = Number.isFinite(e) ? e : s + 3600000;
    if (s >= de || en < ds) return;
    if (evt.all_day || (en - s) >= 86400000 - 60000) { allDay.push(evt); return; }
    const segS = Math.max(s, ds); const segE = Math.min(en, de);
    const startMin = (segS - ds) / 60000;
    const endMin = Math.max((segE - ds) / 60000, startMin + 20);
    items.push({ evt, startMin, endMin, track: 0, tracks: 1, multi: s < ds || en > de });
  });
  items.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  // agrupa clusters que se sobrepõem p/ dividir a largura só dentro do cluster
  let cluster = []; let clusterEnd = -1;
  const flush = () => {
    const tracks = [];
    cluster.forEach((it) => {
      let k = tracks.findIndex((end) => end <= it.startMin);
      if (k === -1) { tracks.push(it.endMin); k = tracks.length - 1; } else tracks[k] = it.endMin;
      it.track = k;
    });
    cluster.forEach((it) => { it.tracks = Math.max(tracks.length, 1); });
    cluster = []; clusterEnd = -1;
  };
  items.forEach((it) => {
    if (cluster.length && it.startMin >= clusterEnd) flush();
    cluster.push(it); clusterEnd = Math.max(clusterEnd, it.endMin);
  });
  if (cluster.length) flush();
  return { items, allDay };
}

function evtColor(evt, colors) {
  const c = evt.color || evt.calendar_color || '';
  return /^#[0-9a-f]{3,8}$/i.test(c) ? c : (colors.text || '#111111');
}

function EventBlock({ it, colors, isDark, width, onPress, onMove, canDrag, setScrollEnabled, t }) {
  const { evt, startMin, endMin, track, tracks } = it;
  const top = (startMin / 60) * DAY_HOUR_H;
  const height = Math.max(((endMin - startMin) / 60) * DAY_HOUR_H - 2, 20);
  const colW = width / tracks;
  const dy = useRef(new Animated.Value(0)).current;
  const [drag, setDrag] = useState(null); // minutos de deslocamento durante o arraste
  const armed = useRef(false);
  const timer = useRef(null);
  const moved = useRef(false);
  const lastMin = useRef(0);

  const color = evtColor(evt, colors);
  const isInk = color.toLowerCase() === '#111111' || color.toLowerCase() === '#111' || color.toLowerCase() === '#000000';
  const bg = isInk ? (isDark ? 'rgba(255,255,255,0.14)' : 'rgba(17,17,17,0.08)') : color + (isDark ? '40' : '22');
  const bar = isInk ? (isDark ? '#F5F5F7' : '#111111') : color;
  const fg = isDark ? '#F5F5F7' : '#111111';

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => armed.current,
    onPanResponderTerminationRequest: () => !armed.current,
    onPanResponderGrant: () => {
      moved.current = false; armed.current = false; lastMin.current = 0;
      if (!canDrag) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        armed.current = true; haptic.medium(); setScrollEnabled(false); setDrag(0);
      }, 320);
    },
    onPanResponderMove: (_, gs) => {
      if (!armed.current) {
        if (Math.abs(gs.dy) > 8 || Math.abs(gs.dx) > 8) { moved.current = true; clearTimeout(timer.current); }
        return;
      }
      const mins = Math.round(((gs.dy / DAY_HOUR_H) * 60) / SNAP) * SNAP;
      const clamped = Math.max(-startMin, Math.min(mins, 24 * 60 - endMin));
      dy.setValue((clamped / 60) * DAY_HOUR_H);
      if (clamped !== lastMin.current) { lastMin.current = clamped; haptic.select(); setDrag(clamped); }
    },
    onPanResponderRelease: () => {
      clearTimeout(timer.current);
      if (armed.current) {
        armed.current = false; setScrollEnabled(true);
        const delta = lastMin.current;
        setDrag(null);
        // o pai aplica otimista (novo start_at → nova key/bloco); zera já.
        dy.setValue(0);
        if (delta) onMove(evt, delta);
        return;
      }
      if (!moved.current) onPress(evt);
    },
    onPanResponderTerminate: () => {
      clearTimeout(timer.current);
      if (armed.current) { armed.current = false; setScrollEnabled(true); }
      setDrag(null); dy.setValue(0);
    },
  }), [canDrag, startMin, endMin, evt, onMove, onPress, setScrollEnabled, dy]);

  const s0 = parseCalDate(evt.start_at); const e0 = parseCalDate(evt.end_at || evt.start_at);
  const shown = drag != null && drag !== 0
    ? `${hhmm(new Date(s0.getTime() + drag * 60000))} – ${hhmm(new Date(e0.getTime() + drag * 60000))}`
    : `${hhmm(s0)} – ${hhmm(e0)}`;
  const compact = height < 40;
  return (
    <Animated.View
      {...pan.panHandlers}
      style={[st.block, {
        top, height, left: GUTTER + track * colW + 2, width: colW - 4,
        backgroundColor: bg, borderLeftColor: bar,
        transform: [{ translateY: dy }, { scale: drag != null ? 1.02 : 1 }],
        zIndex: drag != null ? 20 : 2,
        ...(drag != null ? (Platform.OS === 'web' ? { boxShadow: '0 8px 24px rgba(0,0,0,0.25)' } : { shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: 8 }) : null),
      }]}
      accessibilityRole="button"
      accessibilityLabel={`${evt.title || ''}, ${shown}`}
      accessibilityHint={canDrag ? (t('calendar.dragHint') || 'Segure e arraste para mudar o horário') : undefined}
    >
      {compact ? (
        <Text style={[st.blockTitle, { color: fg }]} numberOfLines={1}>{evt.title || ''} <Text style={[st.blockTime, { color: fg }]}>{shown}</Text></Text>
      ) : (
        <>
          <Text style={[st.blockTitle, { color: fg }]} numberOfLines={height > 70 ? 2 : 1}>{evt.title || ''}</Text>
          <Text style={[st.blockTime, { color: fg, fontWeight: drag != null ? '800' : '500' }]} numberOfLines={1}>{shown}</Text>
          {!!evt.location && height > 78 && <Text style={[st.blockLoc, { color: fg }]} numberOfLines={1}>{evt.location}</Text>}
        </>
      )}
    </Animated.View>
  );
}

export default function DayTimeline({
  date, events, tasks = [], colors, isDark, t, locale, ownerEmail,
  onEventPress, onCreateAt, onMoveEvent, onPrevDay, onNextDay, onTaskPress, header,
}) {
  const scrollRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [scrollEnabled, setScrollEnabled] = useState(true);
  const [, setTick] = useState(0);
  useEffect(() => { const i = setInterval(() => setTick((x) => x + 1), 30000); return () => clearInterval(i); }, []);
  const now = new Date();
  const isToday = sameDay(date, now);
  const { items, allDay } = useMemo(() => layoutDay(events, date), [events, date]);
  const dayTasks = useMemo(() => (tasks || []).filter((tk) => !tk.done && !tk.parent_id && tk.due_at && sameDay(dueDate(tk), date)), [tasks, date]);

  useEffect(() => {
    const target = isToday ? Math.max(0, (now.getHours() - 1.5)) : 7.5;
    const id = setTimeout(() => { try { scrollRef.current?.scrollTo({ y: target * DAY_HOUR_H, animated: false }); } catch {} }, 60);
    return () => clearTimeout(id);
  }, [date]); // eslint-disable-line react-hooks/exhaustive-deps

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const colW = Math.max(width - GUTTER - 8, 60);
  const grid = colors.border || (isDark ? '#2C2C2E' : '#E5E5EA');
  const ink = colors.text || '#111111';
  const label = (() => {
    try { return date.toLocaleDateString(locale || undefined, { weekday: 'long', day: 'numeric', month: 'long' }); } catch { return date.toDateString(); }
  })();

  const handleBgPress = (e) => {
    const y = e?.nativeEvent?.locationY ?? e?.nativeEvent?.offsetY;
    if (!Number.isFinite(y)) return;
    const mins = Math.floor(((y / DAY_HOUR_H) * 60) / SNAP) * SNAP;
    const d = startOfDay(date); d.setMinutes(Math.max(0, Math.min(mins, 23 * 60 + 45)));
    haptic.light();
    onCreateAt(d);
  };

  const canDrag = (evt) => !evt.recurrence_rule && !evt.recurrence && !evt.is_recurrence_instance && !evt._instance
    && (!ownerEmail || !evt.user_email || String(evt.user_email).toLowerCase() === String(ownerEmail).toLowerCase());

  return (
    <View style={st.root}>
      <View style={st.nav}>
        <TouchableOpacity onPress={onPrevDay} style={st.navBtn} accessibilityRole="button" accessibilityLabel={t('calendar.prevDay') || 'Dia anterior'}>
          <IconChevronLeft size={22} color={ink} />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={[st.navTitle, { color: ink }]} numberOfLines={1}>{label.charAt(0).toUpperCase() + label.slice(1)}</Text>
          {isToday && <Text style={[st.navSub, { color: colors.textSecondary }]}>{t('calendar.today') || 'Hoje'}</Text>}
        </View>
        <TouchableOpacity onPress={onNextDay} style={st.navBtn} accessibilityRole="button" accessibilityLabel={t('calendar.nextDay') || 'Próximo dia'}>
          <IconChevronRight size={22} color={ink} />
        </TouchableOpacity>
      </View>
      {header}
      {(allDay.length > 0 || dayTasks.length > 0) && (
        <View style={[st.allDay, { borderBottomColor: grid }]}>
          <Text style={[st.allDayLabel, { color: colors.textTertiary || colors.textSecondary }]}>{t('calendar.allDay') || 'Dia todo'}</Text>
          <View style={{ flex: 1, gap: 4 }}>
            {allDay.map((evt) => (
              <TouchableOpacity key={'e' + evt.id} onPress={() => onEventPress(evt)} style={[st.allDayChip, { backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(17,17,17,0.07)', borderLeftColor: evtColor(evt, colors) }]}>
                <Text style={[st.allDayText, { color: ink }]} numberOfLines={1}>{evt.title}</Text>
              </TouchableOpacity>
            ))}
            {dayTasks.map((tk) => (
              <TouchableOpacity key={'t' + tk.id} onPress={() => onTaskPress?.(tk)} style={[st.allDayChip, st.taskChip, { borderColor: grid }]}>
                <View style={[st.taskRing, { borderColor: ink }]} />
                <Text style={[st.allDayText, { color: ink }]} numberOfLines={1}>{tk.title}{tk.due_all_day ? '' : ` · ${hhmm(dueDate(tk))}`}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}
      <ScrollView ref={scrollRef} scrollEnabled={scrollEnabled} style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <View style={{ height: 24 * DAY_HOUR_H }}>
          {Array.from({ length: 24 }, (_, h) => (
            <View key={h} style={[st.hourRow, { top: h * DAY_HOUR_H }]} pointerEvents="none">
              <Text style={[st.hourLabel, { color: colors.textTertiary || colors.textSecondary, opacity: isToday && Math.abs(nowMin - h * 60) < 14 ? 0 : 1 }]}>{h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}</Text>
              <View style={[st.hourLine, { backgroundColor: grid }]} />
            </View>
          ))}
          <Pressable onPress={handleBgPress} style={[StyleSheet.absoluteFill, { left: GUTTER }]} accessibilityLabel={t('calendar.tapToCreate') || 'Toque num horário para criar um evento'} />
          {width > 0 && items.map((it) => (
            <EventBlock
              key={`${it.evt.id}-${it.evt.start_at}`}
              it={it}
              colors={colors}
              isDark={isDark}
              width={colW}
              t={t}
              onPress={onEventPress}
              onMove={(evt, delta) => Promise.resolve(onMoveEvent(evt, delta))}
              canDrag={!it.multi && canDrag(it.evt)}
              setScrollEnabled={setScrollEnabled}
            />
          ))}
          {isToday && (
            <View pointerEvents="none" style={[st.nowRow, { top: (nowMin / 60) * DAY_HOUR_H - 9 }]}>
              <View style={[st.nowPill, { backgroundColor: ink }]}><Text style={[st.nowPillText, { color: colors.background || (isDark ? '#000' : '#fff') }]}>{hhmm(now)}</Text></View>
              <View style={[st.nowDot, { backgroundColor: ink }]} />
              <View style={[st.nowLine, { backgroundColor: ink }]} />
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1 },
  nav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 6 },
  navBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  navTitle: { fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  navSub: { fontSize: 12, fontWeight: '600', marginTop: 1 },
  allDay: { flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  allDayLabel: { width: GUTTER - 8, fontSize: 11, fontWeight: '600', paddingTop: 6 },
  allDayChip: { flexDirection: 'row', alignItems: 'center', minHeight: 28, borderRadius: 6, paddingHorizontal: 10, borderLeftWidth: 3 },
  taskChip: { borderLeftWidth: StyleSheet.hairlineWidth, borderWidth: StyleSheet.hairlineWidth, backgroundColor: 'transparent' },
  taskRing: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.4, marginRight: 8 },
  allDayText: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  hourRow: { position: 'absolute', left: 0, right: 0, height: DAY_HOUR_H, flexDirection: 'row' },
  hourLabel: { width: GUTTER, fontSize: 11, fontWeight: '500', textAlign: 'right', paddingRight: 8, marginTop: -7, fontVariant: ['tabular-nums'] },
  hourLine: { flex: 1, height: StyleSheet.hairlineWidth, marginRight: 8 },
  block: { position: 'absolute', borderRadius: 6, borderLeftWidth: 3, paddingHorizontal: 7, paddingVertical: 4, overflow: 'hidden' },
  blockTitle: { fontSize: 13, fontWeight: '700', letterSpacing: -0.1 },
  blockTime: { fontSize: 11.5, marginTop: 1, fontVariant: ['tabular-nums'] },
  blockLoc: { fontSize: 11.5, marginTop: 1, opacity: 0.8 },
  nowRow: { position: 'absolute', left: 0, right: 0, height: 18, flexDirection: 'row', alignItems: 'center', zIndex: 30 },
  nowPill: { width: GUTTER - 6, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginLeft: 2 },
  nowPillText: { fontSize: 10.5, fontWeight: '800', fontVariant: ['tabular-nums'] },
  nowDot: { width: 8, height: 8, borderRadius: 4, marginLeft: 2 },
  nowLine: { flex: 1, height: 2, marginRight: 8 },
});
