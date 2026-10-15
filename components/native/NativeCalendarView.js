// components/native/NativeCalendarView.js — [2026-10-15 native-apps]
//
// Calendário (visão MÊS + agenda do dia) em NATIVO — modules/expo-chat-
// conversation-list → view ChatyyCalendarView:
//   iOS: grade do mês própria (CoreGraphics, P&B, hoje = círculo cheio,
//        selecionado = círculo neutro, pontos por cor, faixas de vários dias),
//        arrastar p/ os lados troca o mês; agenda em UICollectionView (lista
//        compositional + diffable), swipe Editar/Apagar, UIRefreshControl.
//   Android: mesma grade (Canvas) + RecyclerView/DiffUtil, ItemTouchHelper,
//        SwipeRefreshLayout.
// Por que grade própria e não UICalendarView/CalendarView: as do sistema não
// aceitam o tema P&B do app (tinta/realce/fonte), não desenham faixas de vários
// dias e não existem iguais nos dois SOs (UICalendarView só iOS 16+).
//
// A tela continua dona dos dados e dos fluxos: mês/dia selecionado, eventos,
// criar/editar (AddEventModal, event-detail) — o nativo só desenha e devolve
// eventos: onSelectDate(key), onLongPressDate(key), onMonthChange(dir ±1),
// onPress(id), onAction(id, action) (edit | delete | join | add), onRefresh().
// `header` = filho RN entre a grade e a agenda (resumo do dia, avisos…).
// Qualquer erro (render ou onNativeError) → onFailure(msg) e a tela volta para
// a FlatList JS na hora (globalThis.__chatyy_native_calendar_failed na sessão).
//
// Desligar (OTA/console): globalThis.__chatyy_native_calendar = false

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { getNativeCalendarView } from '../../modules/expo-chat-conversation-list';
import { createPatcher } from '../chatlist/nativeAdapter';
import { nativeColor, nativeColors } from '../contacts/contactListAdapter';

export const CALENDAR_KILL_SWITCH = '__chatyy_native_calendar';

class NativeCalendarBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    try { this.props.onFailure?.(String(error?.message || error)); } catch {}
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

/** Liga o calendário nativo? (binário com a view + kill switch + não falhou nesta sessão). */
export function nativeCalendarEnabled() {
  try {
    const k = CALENDAR_KILL_SWITCH;
    if (globalThis[k] === false) return false;
    if (globalThis[`${k}_failed`]) return false;
    return !!getNativeCalendarView();
  } catch { return false; }
}

/** Hook: estado "nativo ligado" com queda para JS na 1ª falha. */
export function useNativeCalendar() {
  const k = CALENDAR_KILL_SWITCH;
  const [failed, setFailed] = useState(() => {
    try { return !!globalThis[`${k}_failed`]; } catch { return false; }
  });
  const enabled = !failed && nativeCalendarEnabled();
  const onFailure = useCallback((msg) => {
    try {
      globalThis[`${k}_failed`] = true;
      console.warn('[native_calendar] fallback JS:', msg);
      try { require('../../services/crashReporter').reportNativeFallback('native_calendar', msg); } catch {}
    } catch {}
    setFailed(true);
  }, [k]);
  return [enabled, onFailure];
}

/** Cores do ThemeContext → prop `colors` (ARGB). */
export function calendarColors(colors, isDark) {
  const c = colors || {};
  return nativeColors({
    dark: !!isDark,
    bg: c.background,
    text: c.text,
    sub: c.textSecondary,
    faint: c.textTertiary || c.textSecondary,
    hair: c.borderLight || c.border,
    primary: c.primary,
    onPrimary: c.onPrimary,
    error: c.error || '#FF3B30',
    press: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
    chipBg: c.surfaceVariant || c.surface || (isDark ? '#1C1C1E' : '#F0F1F3'),
    card: c.surface || (isDark ? '#111111' : '#FFFFFF'),
    border: c.border || (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'),
  });
}

/** Cor de evento → ARGB (ou undefined). */
export function argb(c) {
  return nativeColor(c);
}

function NativeCalendarInner(props) {
  const {
    year, month, selectedKey = '', todayKey = '', firstWeekday = 0, marks, showGrid = true,
    rows, colors, isDark, labels, refreshing = false, bottomInset = 0, header, style,
  } = props;
  const Native = getNativeCalendarView();

  const patcherRef = useRef(null);
  if (!patcherRef.current) patcherRef.current = createPatcher();
  const [resyncToken, setResyncToken] = useState(0);

  const safeRows = Array.isArray(rows) ? rows : [];
  const { patch, snapshot } = useMemo(
    () => patcherRef.current.diff(safeRows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [safeRows, resyncToken]
  );
  useLayoutEffect(() => {
    patcherRef.current.commit(snapshot);
  }, [snapshot]);

  const nColors = useMemo(() => calendarColors(colors, isDark), [colors, isDark]);
  const monthProp = useMemo(() => ({ y: Number(year) || 0, m: Number(month) || 0 }), [year, month]);

  const propsRef = useRef(props);
  propsRef.current = props;

  const handlers = useMemo(() => {
    const ev = (e) => (e?.nativeEvent ?? e) || {};
    return {
      onSelectDate: (e) => {
        const d = String(ev(e).date || ''); if (!d) return;
        try { propsRef.current.onSelectDate?.(d); } catch {}
      },
      onLongPressDate: (e) => {
        const d = String(ev(e).date || ''); if (!d) return;
        try { propsRef.current.onLongPressDate?.(d); } catch {}
      },
      onMonthChange: (e) => {
        const dir = Number(ev(e).dir) || 0; if (!dir) return;
        try { propsRef.current.onMonthChange?.(dir > 0 ? 1 : -1); } catch {}
      },
      onRowPress: (e) => {
        const id = String(ev(e).id ?? ''); if (!id) return;
        try { propsRef.current.onPress?.(id); } catch {}
      },
      onRowAction: (e) => {
        const x = ev(e);
        const id = String(x.id ?? ''); if (!id) return;
        try { propsRef.current.onAction?.(id, String(x.action || '')); } catch {}
      },
      onRefresh: () => { try { propsRef.current.onRefresh?.(); } catch {} },
      onResync: () => {
        patcherRef.current.requestReset();
        setResyncToken((v) => v + 1);
      },
      onFirstPaint: () => {},
      onNativeError: (e) => {
        const msg = String(ev(e).message || 'native error');
        try { propsRef.current.onFailure?.(msg); } catch {}
      },
    };
  }, []);

  if (!Native) return null;
  return (
    <Native
      style={[styles.fill, style]}
      month={monthProp}
      selected={String(selectedKey || '')}
      today={String(todayKey || '')}
      firstWeekday={Number(firstWeekday) || 0}
      marks={marks || {}}
      showGrid={!!showGrid}
      rowsPatch={patch}
      colors={nColors}
      labels={labels || {}}
      refreshing={!!refreshing}
      bottomInset={bottomInset || 0}
      {...handlers}
    >
      <View collapsable={false} style={styles.slot}>
        {header || null}
      </View>
    </Native>
  );
}

export default function NativeCalendarView(props) {
  return (
    <NativeCalendarBoundary onFailure={props.onFailure}>
      <NativeCalendarInner {...props} />
    </NativeCalendarBoundary>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Filho RN: o nativo o posiciona entre a grade e a agenda.
  slot: { position: 'absolute', top: 0, left: 0, right: 0 },
});
