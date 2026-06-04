import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Pressable, TextInput,
  ScrollView, StyleSheet, Platform,
} from 'react-native';
import { Shadow } from '../constants/theme';
import { IconClock, IconX, IconTrash } from './Icons';

/**
 * Scrollable wheel picker for date/time — replaces manual "YYYY-MM-DD HH:MM"
 * typing (bad UX, Apple-flagged). Pure RN ScrollView wheels (Day/Hour/Minute),
 * no native dependency, works on iOS/Android/web. WhatsApp/iMessage-style.
 */
const WHEEL_ITEM_H = 44;
const WHEEL_VISIBLE = 5; // odd → center row is the selection

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function buildDays(t) {
  const out = [];
  const loc = (t && t('_locale')) || undefined; // follow APP language, not device
  const base = new Date(); base.setHours(0, 0, 0, 0);
  for (let i = 0; i < 90; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    let label;
    if (i === 0) label = (t && t('chat.today')) || 'Hoje';
    else if (i === 1) label = (t && t('chat.tomorrow')) || 'Amanhã';
    else {
      try { label = d.toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'short' }); }
      catch { label = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`; }
    }
    out.push({ date: d, label });
  }
  return out;
}

function Wheel({ data, index, onIndex, colors, width }) {
  const ref = useRef(null);
  useEffect(() => {
    const id = setTimeout(() => {
      try { ref.current?.scrollTo({ y: index * WHEEL_ITEM_H, animated: false }); } catch {}
    }, 0);
    return () => clearTimeout(id);
  }, []); // initial sync to default index
  const pad = ((WHEEL_VISIBLE - 1) / 2) * WHEEL_ITEM_H;
  const onEnd = (e) => {
    const y = e.nativeEvent.contentOffset.y;
    let i = Math.round(y / WHEEL_ITEM_H);
    if (i < 0) i = 0; if (i > data.length - 1) i = data.length - 1;
    if (i !== index) onIndex(i);
  };
  return (
    <View style={{ width, height: WHEEL_ITEM_H * WHEEL_VISIBLE }}>
      <ScrollView
        ref={ref}
        showsVerticalScrollIndicator={false}
        snapToInterval={WHEEL_ITEM_H}
        decelerationRate="fast"
        contentContainerStyle={{ paddingVertical: pad }}
        onMomentumScrollEnd={onEnd}
        onScrollEndDrag={onEnd}
        nestedScrollEnabled
      >
        {data.map((item, i) => {
          const sel = i === index;
          return (
            <View key={i} style={{ height: WHEEL_ITEM_H, alignItems: 'center', justifyContent: 'center' }}>
              <Text
                numberOfLines={1}
                style={{
                  fontSize: sel ? 20 : 17,
                  fontWeight: sel ? '700' : '400',
                  color: sel ? colors.text : colors.textTertiary,
                  opacity: sel ? 1 : 0.55,
                }}
              >
                {typeof item === 'string' ? item : item.label}
              </Text>
            </View>
          );
        })}
      </ScrollView>
      <View pointerEvents="none" style={{
        position: 'absolute', left: 0, right: 0, top: pad, height: WHEEL_ITEM_H,
        borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
      }} />
    </View>
  );
}

export function WheelDateTimePicker({ colors, t, onChange, initial }) {
  const days = useRef(buildDays(t)).current;
  const start = initial instanceof Date && !isNaN(initial) ? initial : new Date(Date.now() + 60 * 60000); // default: +1h
  // find the day index matching `start` (0-89), else 0
  const startDi = (() => {
    const sm = new Date(start); sm.setHours(0, 0, 0, 0);
    const i = Math.round((sm.getTime() - days[0].date.getTime()) / 86400000);
    return i >= 0 && i < days.length ? i : 0;
  })();
  const [di, setDi] = useState(startDi);
  const [hi, setHi] = useState(start.getHours());
  const [mi, setMi] = useState(start.getMinutes());
  const hours = useRef(Array.from({ length: 24 }, (_, i) => pad2(i))).current;
  const mins = useRef(Array.from({ length: 60 }, (_, i) => pad2(i))).current;

  useEffect(() => {
    const d = new Date(days[di].date);
    d.setHours(hi, mi, 0, 0);
    onChange(d);
  }, [di, hi, mi]);

  return (
    <View style={{ marginBottom: 16 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}>
        <Wheel data={days} index={di} onIndex={setDi} colors={colors} width={150} />
        <Wheel data={hours} index={hi} onIndex={setHi} colors={colors} width={56} />
        <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text, marginHorizontal: 2 }}>:</Text>
        <Wheel data={mins} index={mi} onIndex={setMi} colors={colors} width={56} />
      </View>
    </View>
  );
}

/**
 * Schedule Toast - shows confirmation after scheduling
 */
export function ScheduleToast({ visible, message, colors }) {
  if (!visible || !message) return null;
  return (
    <View style={{
      position: 'absolute', bottom: 80, alignSelf: 'center',
      backgroundColor: colors.surface, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10,
      flexDirection: 'row', alignItems: 'center', gap: 8,
      borderWidth: 1, borderColor: colors.border, ...Shadow.md,
    }}>
      <IconClock size={14} color={colors.primary} />
      <Text style={{ fontSize: 13, color: colors.text }}>{message}</Text>
    </View>
  );
}

/**
 * Reusable date/time picker modal — tap a field, pick via scrollable wheels.
 * Used by the calendar (meeting-create, event-detail) to replace manual
 * "YYYY-MM-DD HH:MM" typing. Returns a Date via onConfirm.
 */
export function DateTimePickerModal({ visible, onClose, initial, onConfirm, colors, t, title, minDate }) {
  const [picked, setPicked] = React.useState(null);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={modalStyles.overlay} onPress={onClose}>
        <Pressable style={[modalStyles.sheet, { backgroundColor: colors.surface, padding: 20, minWidth: 320 }, Shadow.lg]} onPress={() => {}}>
          {!!title && (
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 12, textAlign: 'center' }}>{title}</Text>
          )}
          {visible && <WheelDateTimePicker colors={colors} t={t} initial={initial} onChange={setPicked} />}
          <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
            <TouchableOpacity onPress={onClose} style={{ paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8 }}>
              <Text style={{ color: colors.textSecondary }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                const dt = picked || (initial instanceof Date ? initial : null);
                if (dt && !isNaN(dt.getTime())) {
                  if (minDate && dt < minDate) { onConfirm(new Date(minDate)); }
                  else onConfirm(dt);
                }
                onClose();
              }}
              style={{ paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8, backgroundColor: colors.primary }}
            >
              <Text style={{ color: '#fff', fontWeight: '600' }}>{t('common.ok') || t('common.confirm') || 'OK'}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * Custom Schedule Picker Modal - datetime input for custom scheduling
 */
export function CustomScheduleModal({ visible, onClose, customDate, setCustomDate, onSchedule, colors, t }) {
  const [pickedDate, setPickedDate] = useState(null);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={modalStyles.overlay} onPress={onClose}>
        {/* [2026-06-04] Pressable no-op (era View): toque simples na roleta de
            data borbulhava até o overlay e FECHAVA o modal antes do usuário
            conseguir escolher (print do founder). Mesmo padrão do
            DateTimePickerModal acima. */}
        <Pressable onPress={() => {}} style={[modalStyles.sheet, { backgroundColor: colors.surface, padding: 20, minWidth: 300 }, Shadow.lg]}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 12 }}>
            {t('chat.scheduleCustom')}
          </Text>
          {Platform.OS === 'web' ? (
            <input
              type="datetime-local"
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
              style={{
                padding: 10, fontSize: 16, borderRadius: 8,
                border: `1px solid ${colors.border}`,
                backgroundColor: colors.background, color: colors.text,
                width: '100%', marginBottom: 16,
              }}
              min={new Date().toISOString().slice(0, 16)}
            />
          ) : (
            <WheelDateTimePicker colors={colors} t={t} onChange={setPickedDate} />
          )}
          <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
            <TouchableOpacity onPress={onClose} style={{ paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8 }}>
              <Text style={{ color: colors.textSecondary }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                // Native uses the wheel picker (pickedDate); web uses the
                // datetime-local string (customDate).
                const dt = Platform.OS === 'web'
                  ? (customDate ? new Date(customDate) : null)
                  : pickedDate;
                if (dt && !isNaN(dt.getTime()) && dt > new Date()) {
                  onSchedule(dt.toISOString());
                }
              }}
              style={{ paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8, backgroundColor: colors.primary }}
            >
              <Text style={{ color: '#fff', fontWeight: '600' }}>{t('chat.schedule')}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * Scheduled Messages List Modal - view/cancel pending scheduled messages
 */
export function ScheduledMessagesModal({ visible, onClose, messages, onCancel, colors, t }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={modalStyles.overlay} onPress={onClose}>
        {/* [2026-06-04] Pressable no-op (era View) — mesmo fix do CustomScheduleModal */}
        <Pressable onPress={() => {}} style={[modalStyles.sheet, { backgroundColor: colors.surface, maxHeight: '70%', minWidth: 320, padding: 0 }, Shadow.lg]}>
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
          }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
              {t('chat.scheduledMessages')}
            </Text>
            <TouchableOpacity onPress={onClose}>
              <IconX size={20} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
          <ScrollView style={{ padding: 16 }}>
            {messages.length === 0 ? (
              <Text style={{ color: colors.textTertiary, textAlign: 'center', paddingVertical: 20 }}>
                {t('chat.noScheduledMessages')}
              </Text>
            ) : messages.map(sm => (
              <View key={sm.id} style={{
                backgroundColor: colors.background, borderRadius: 10, padding: 12, marginBottom: 10,
                borderWidth: 1, borderColor: colors.border,
              }}>
                <Text style={{ fontSize: 14, color: colors.text, marginBottom: 6 }} numberOfLines={3}>
                  {sm.content}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <IconClock size={12} color={colors.primary} />
                    <Text style={{ fontSize: 12, color: colors.primary }}>
                      {new Date(sm.scheduled_at + 'Z').toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => onCancel(sm.id)}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 4,
                      paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6,
                      backgroundColor: colors.error + '15',
                    }}
                  >
                    <IconTrash size={12} color={colors.error} />
                    <Text style={{ fontSize: 12, color: colors.error }}>{t('chat.scheduleCancel')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    borderRadius: 16, overflow: 'hidden',
  },
});
