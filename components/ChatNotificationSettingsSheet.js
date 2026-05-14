/**
 * ChatNotificationSettingsSheet — bottom sheet for per-conversation
 * notification controls. Surfaced from the chat-conversation header
 * overflow menu.
 *
 * Settings:
 *   - notify_messages   (toggle)   — master switch for this conv
 *   - sound             (picker)   — default | custom | silent
 *   - vibration         (picker)   — default | short | long | off
 *   - preview           (toggle)   — show message body in push banner
 *   - mention_exception (toggle)   — bypass mute on @everyone / @me (groups)
 *   - mute_until        (picker)   — 8h / 1w / forever / unmute
 *
 * Persists via api.chatSetConvSettings and mirrors to AsyncStorage so the
 * push handler in services/pushNotifications.js can read it synchronously
 * on the next conv push.
 *
 * No new i18n keys — labels reuse existing chatConv/chatNotif/notif/common
 * strings with PT-BR fallbacks.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, Modal, Pressable, TouchableOpacity, ScrollView, Switch,
  StyleSheet, Platform, ActivityIndicator, Vibration, Animated, Easing,
} from 'react-native';
import * as api from '../services/api';
import { IconX, IconBell, IconCheck } from './Icons';

// Built-in vibration patterns matched to the picker labels. Mirrors the
// values the native push handler reads when emitting vibration so the
// preview the user feels here is exactly what arrives on a push.
const VIB_PRESETS = {
  default: [0, 250],
  short:   [0, 80],
  long:    [0, 600],
  off:     null,
};

function previewVibration(name, pattern) {
  if (Platform.OS === 'web') return;
  try {
    Vibration.cancel();
    if (pattern && Array.isArray(pattern) && pattern.length) {
      Vibration.vibrate(pattern, false);
      return;
    }
    const preset = VIB_PRESETS[name];
    if (preset === null || preset === undefined) return;
    Vibration.vibrate(preset, false);
  } catch {}
}

const ACCENT = '#7C3AED';

// Cache mirror so the push handler can read these settings synchronously
// (it lives in services/pushNotifications.js and may run in the
// notification-handler tick where awaiting is risky).
const SETTINGS_CACHE_KEY = (cid) => `chat_notif_settings_${cid}`;

export async function readCachedConvSettings(conversationId) {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const raw = await AsyncStorage.getItem(SETTINGS_CACHE_KEY(conversationId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

async function writeCachedConvSettings(conversationId, settings) {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.setItem(SETTINGS_CACHE_KEY(conversationId), JSON.stringify(settings));
  } catch {}
}

const DEFAULT_SETTINGS = {
  notify_messages: true,
  sound: 'default',
  vibration: 'default',
  vibration_pattern: null, // {durations:[100,50,200]} | null
  preview: true,
  mention_exception: true,
  mute_until: null,
};

export default function ChatNotificationSettingsSheet({
  visible, onClose, conversationId, conversationType, colors, isDark, t,
}) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Hydrate every time the sheet opens — pulls fresh server state but falls
  // back to the local cache so the UI is never blank if the request fails.
  useEffect(() => {
    if (!visible || !conversationId) return;
    let alive = true;
    (async () => {
      setLoading(true);
      const cached = await readCachedConvSettings(conversationId);
      if (alive && cached) setSettings(prev => ({ ...DEFAULT_SETTINGS, ...cached }));
      try {
        const r = await api.chatGetConvSettings(conversationId);
        if (alive && r?.success && r?.data) {
          const merged = { ...DEFAULT_SETTINGS, ...r.data };
          setSettings(merged);
          writeCachedConvSettings(conversationId, merged);
        }
      } catch {}
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [visible, conversationId]);

  // Persist a single field optimistically and roll back on failure so the
  // local cache and server stay aligned (push handler trusts the cache).
  const saveField = useCallback(async (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    writeCachedConvSettings(conversationId, next);
    setSaving(true);
    try {
      const r = await api.chatSetConvSettings(conversationId, patch);
      if (r?.success === false) throw new Error(r?.message || 'failed');
    } catch {
      // Roll back UI but keep cache mirror — user will retry; we log nothing.
      setSettings(settings);
      writeCachedConvSettings(conversationId, settings);
    } finally {
      setSaving(false);
    }
  }, [conversationId, settings]);

  const handleMuteFor = useCallback(async (duration) => {
    let muteUntil = null;
    if (duration === '30m') muteUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    else if (duration === '1h') muteUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    else if (duration === '8h') muteUntil = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
    else if (duration === '1w') muteUntil = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    else if (duration === 'forever') muteUntil = '2099-12-31T23:59:59Z';
    saveField({ mute_until: muteUntil });
    // Mirror to chatMute so the existing mute UI badge stays in sync.
    try { await api.chatMute(conversationId, muteUntil); } catch {}
  }, [conversationId, saveField]);

  // Custom vibration recorder modal state. Captures press timings inside a
  // 3-second window and saves the resulting `{durations:[...]}` blob to
  // chat_user_conv_settings.vibration_pattern. On save, also flips the
  // `vibration` enum to 'custom' so the native push handler knows to read
  // the JSON column instead of the preset table.
  const [showCustomVib, setShowCustomVib] = useState(false);

  if (!visible) return null;

  const isGroup = conversationType === 'group';

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onClose}>
        <Pressable
          onPress={e => e.stopPropagation?.()}
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            backgroundColor: colors?.background || (isDark ? '#0f0f12' : '#fff'),
            borderTopLeftRadius: 18, borderTopRightRadius: 18,
            maxHeight: '88%', minHeight: 360,
            paddingBottom: Platform.OS === 'ios' ? 24 : 12,
          }}
        >
          {/* Drag handle */}
          <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 4 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: isDark ? '#333' : '#ddd' }} />
          </View>

          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 10 }}>
            <IconBell size={20} color={ACCENT} />
            <Text style={{ flex: 1, marginLeft: 10, fontSize: 17, fontWeight: '700', color: colors?.text }}>
              {t?.('notifications.title') || 'Notificações'}
            </Text>
            {saving ? <ActivityIndicator size="small" color={ACCENT} style={{ marginRight: 8 }} /> : null}
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, left: 8, right: 8, bottom: 8 }}>
              <IconX size={22} color={colors?.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: Platform.OS === 'android' ? 64 : 48 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {loading && !settings ? (
              <View style={{ padding: 32, alignItems: 'center' }}>
                <ActivityIndicator color={ACCENT} />
              </View>
            ) : null}

            {/* Mensagens (master toggle) */}
            <ToggleRow
              label={t?.('chat.messages') || 'Mensagens'}
              value={!!settings.notify_messages}
              onChange={(v) => saveField({ notify_messages: v })}
              colors={colors}
            />

            {/* Mostrar prévia */}
            <ToggleRow
              label={t?.('chatConv.showPreview') || 'Mostrar prévia'}
              value={!!settings.preview}
              onChange={(v) => saveField({ preview: v })}
              colors={colors}
            />

            {/* Som picker */}
            <SectionHeader text={t?.('notif.sound') || 'Som'} colors={colors} />
            <PickerRow
              options={[
                { value: 'default', label: t?.('chatNotif.default') || 'Padrão' },
                { value: 'custom',  label: t?.('chatConv.customSound') || 'Personalizado' },
                { value: 'silent',  label: t?.('chatNotif.none') || 'Silenciado' },
              ]}
              value={settings.sound}
              onChange={(v) => saveField({ sound: v })}
              colors={colors}
            />

            {/* Vibração picker — tapping each option fires a haptic preview
                so the user can FEEL the difference before saving. The
                "Personalizar" row opens a recorder where they tap-out a
                custom rhythm; saved pattern is mirrored on the row label. */}
            <SectionHeader text={t?.('notif.vibration') || 'Vibração'} colors={colors} />
            <PickerRow
              options={[
                { value: 'default', label: t?.('chatNotif.default') || 'Padrão' },
                { value: 'short',   label: t?.('chatConv.vibShort') || 'Curta' },
                { value: 'long',    label: t?.('chatConv.vibLong') || 'Longa' },
                { value: 'custom',  label: (t?.('chatConv.vibCustom') || 'Personalizar') + (settings.vibration_pattern?.durations?.length ? ` (${settings.vibration_pattern.durations.length})` : '') },
                { value: 'off',     label: t?.('common.off') || 'Desligada' },
              ]}
              value={settings.vibration}
              onChange={(v) => {
                if (v === 'custom') {
                  // Open the recorder. If the user already has a saved
                  // pattern, the recorder pre-loads it so they can extend.
                  setShowCustomVib(true);
                  return;
                }
                // Preview the preset right when the row is tapped — gives
                // immediate physical feedback before persisting. Saving the
                // pattern field to null clears any previous custom blob.
                previewVibration(v, null);
                saveField({ vibration: v, vibration_pattern: null });
              }}
              colors={colors}
            />

            {/* Mention exception — only meaningful for groups */}
            {isGroup ? (
              <View style={{ paddingTop: 4 }}>
                <ToggleRow
                  label={t?.('chatConv.mentionException') || 'Notificar mesmo mutado em @menção'}
                  value={!!settings.mention_exception}
                  onChange={(v) => saveField({ mention_exception: v })}
                  colors={colors}
                />
              </View>
            ) : null}

            {/* Silenciar por */}
            <SectionHeader text={t?.('chatConv.muteChat') || 'Silenciar conversa'} colors={colors} />
            <PickerRow
              options={[
                { value: '30m',     label: t?.('chatConv.muteFor30m') || 'Silenciar por 30 minutos' },
                { value: '1h',      label: t?.('chatConv.muteFor1h') || 'Silenciar por 1 hora' },
                { value: '8h',      label: t?.('chatConv.muteFor8h') || 'Silenciar por 8 horas' },
                { value: '1w',      label: t?.('chatConv.muteFor1w') || 'Silenciar por 1 semana' },
                { value: 'forever', label: t?.('chatConv.muteForever') || 'Silenciar sempre' },
                { value: null,      label: t?.('chatConv.unmute') || 'Desativar silêncio' },
              ]}
              // Map mute_until into one of the 6 buckets so the user sees a
              // checkmark on the row that matches their current state.
              value={(() => {
                if (!settings.mute_until) return null;
                if (settings.mute_until.startsWith('2099-')) return 'forever';
                const ms = new Date(settings.mute_until).getTime() - Date.now();
                if (!Number.isFinite(ms) || ms <= 0) return null;
                if (ms <= 45 * 60 * 1000) return '30m';
                if (ms <= 90 * 60 * 1000) return '1h';
                if (ms <= 12 * 3600 * 1000) return '8h';
                return '1w';
              })()}
              onChange={(v) => handleMuteFor(v)}
              colors={colors}
            />
          </ScrollView>
        </Pressable>
      </Pressable>
      <CustomVibrationRecorder
        visible={showCustomVib}
        initialPattern={settings.vibration_pattern?.durations}
        onClose={() => setShowCustomVib(false)}
        onSave={(durations) => {
          // Empty save → fall back to "default" preset; clears the pattern.
          if (!durations || durations.length === 0) {
            saveField({ vibration: 'default', vibration_pattern: null });
          } else {
            saveField({
              vibration: 'custom',
              vibration_pattern: { durations },
            });
          }
          setShowCustomVib(false);
        }}
        colors={colors}
        isDark={isDark}
        t={t}
      />
    </Modal>
  );
}

// Tap-to-record recorder. Opens a 3-second window — each tap records a
// `wait` (gap since previous tap) followed by a fixed 50ms buzz, packed
// into the standard React Native Vibration array `[wait, buzz, wait, buzz, ...]`.
// Cap at 16 taps to keep the array sane. Replay button uses Vibration.vibrate()
// on the captured pattern so the user can confirm the rhythm before saving.
function CustomVibrationRecorder({ visible, onClose, onSave, initialPattern, colors, isDark, t }) {
  const [recording, setRecording] = useState(false);
  const [durations, setDurations] = useState(() => Array.isArray(initialPattern) ? initialPattern.slice() : []);
  const [remaining, setRemaining] = useState(3000);
  const startRef = useRef(0);
  const lastTapRef = useRef(0);
  const tickRef = useRef(null);

  // Reset state every time the modal opens — pre-loads any saved pattern
  // so users can iterate on a previous recording instead of starting over.
  useEffect(() => {
    if (!visible) return;
    setDurations(Array.isArray(initialPattern) ? initialPattern.slice() : []);
    setRecording(false);
    setRemaining(3000);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, [visible]);

  const startRecording = useCallback(() => {
    setDurations([]);
    setRecording(true);
    startRef.current = Date.now();
    lastTapRef.current = startRef.current;
    setRemaining(3000);
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      const elapsed = Date.now() - startRef.current;
      const left = Math.max(0, 3000 - elapsed);
      setRemaining(left);
      if (left <= 0) {
        clearInterval(tickRef.current);
        tickRef.current = null;
        setRecording(false);
      }
    }, 50);
  }, []);

  const stopRecording = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    setRecording(false);
  }, []);

  const onTap = useCallback(() => {
    if (!recording) return;
    const now = Date.now();
    const wait = Math.max(20, now - lastTapRef.current);
    lastTapRef.current = now;
    setDurations(prev => {
      if (prev.length >= 32) return prev;
      const buzz = 50; // fixed 50ms haptic per tap, like Telegram
      return [...prev, wait, buzz];
    });
    // Tactile confirmation that the tap registered.
    try { Vibration.vibrate(20); } catch {}
  }, [recording]);

  const replay = useCallback(() => {
    if (Platform.OS === 'web' || durations.length === 0) return;
    try { Vibration.cancel(); Vibration.vibrate(durations, false); } catch {}
  }, [durations]);

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' }} onPress={onClose}>
        <Pressable
          onPress={e => e.stopPropagation?.()}
          style={{ width: 320, borderRadius: 18, padding: 22, backgroundColor: colors?.background || (isDark ? '#0f0f12' : '#fff') }}
        >
          <Text style={{ fontSize: 17, fontWeight: '700', color: colors?.text, marginBottom: 6 }}>
            {t?.('chatConv.vibCustom') || 'Vibração personalizada'}
          </Text>
          <Text style={{ fontSize: 12, color: colors?.textSecondary, marginBottom: 14 }}>
            {t?.('chatConv.vibCustomHint') || 'Toque o ritmo na área abaixo durante 3 segundos.'}
          </Text>

          <Pressable
            onPress={recording ? onTap : undefined}
            disabled={!recording}
            style={{
              height: 140, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
              backgroundColor: recording ? ACCENT + '22' : (isDark ? '#1a1a1f' : '#f3f4f6'),
              borderWidth: recording ? 2 : 1,
              borderColor: recording ? ACCENT : (colors?.border || '#ddd'),
            }}
          >
            <Text style={{ fontSize: 36, fontWeight: '700', color: recording ? ACCENT : colors?.textSecondary }}>
              {recording ? `${(remaining / 1000).toFixed(1)}s` : `${Math.floor(durations.length / 2)}`}
            </Text>
            <Text style={{ fontSize: 12, color: colors?.textSecondary, marginTop: 4 }}>
              {recording
                ? (t?.('chatConv.vibTapHere') || 'Toque aqui no ritmo')
                : (t?.('chatConv.vibTapsCount') || 'toques gravados')}
            </Text>
          </Pressable>

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
            <TouchableOpacity
              onPress={recording ? stopRecording : startRecording}
              style={{ flex: 1, height: 42, borderRadius: 10, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ color: '#fff', fontWeight: '600' }}>
                {recording ? (t?.('common.stop') || 'Parar') : (t?.('common.start') || 'Iniciar')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={replay}
              disabled={durations.length === 0 || recording}
              style={{
                flex: 1, height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                backgroundColor: (durations.length === 0 || recording) ? (colors?.border || '#ddd') : (colors?.surface || '#f3f4f6'),
                borderWidth: 1, borderColor: colors?.border || '#ddd',
              }}
            >
              <Text style={{ color: colors?.text, fontWeight: '600' }}>{t?.('common.preview') || 'Prévia'}</Text>
            </TouchableOpacity>
          </View>

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <TouchableOpacity onPress={onClose} style={{ flex: 1, height: 40, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: colors?.textSecondary, fontWeight: '500' }}>{t?.('common.cancel') || 'Cancelar'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onSave(durations)}
              disabled={recording}
              style={{ flex: 1, height: 40, borderRadius: 10, backgroundColor: recording ? (colors?.border || '#ddd') : '#10B981', alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ color: '#fff', fontWeight: '600' }}>{t?.('common.save') || 'Salvar'}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function SectionHeader({ text, colors }) {
  return (
    <Text style={{
      paddingHorizontal: 18, paddingTop: 16, paddingBottom: 6,
      fontSize: 11, fontWeight: '700', letterSpacing: 0.6,
      color: colors?.textSecondary, textTransform: 'uppercase',
    }}>
      {text}
    </Text>
  );
}

function ToggleRow({ label, value, onChange, colors }) {
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: 18, paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors?.border,
    }}>
      <Text style={{ flex: 1, fontSize: 15, color: colors?.text }}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: '#888', true: ACCENT }}
        thumbColor={Platform.OS === 'android' ? '#fff' : undefined}
      />
    </View>
  );
}

function PickerRow({ options, value, onChange, colors }) {
  return (
    <View>
      {options.map((opt, idx) => (
        <PickerRowItem
          key={String(opt.value)}
          opt={opt}
          active={String(opt.value) === String(value)}
          isLast={idx === options.length - 1}
          onPress={() => onChange(opt.value)}
          colors={colors}
        />
      ))}
    </View>
  );
}

// Each picker option owns its own scale + check fade animators so taps stay
// independent and the row that just got selected gets a satisfying scale-
// pop together with the checkmark fading in (instead of popping in cold).
function PickerRowItem({ opt, active, isLast, onPress, colors }) {
  const scale = useRef(new Animated.Value(1)).current;
  const checkFade = useRef(new Animated.Value(active ? 1 : 0)).current;
  // Animate the checkmark in/out when `active` changes — fades 0↔1 over
  // 200ms so the selection feels intentional, not flickery.
  useEffect(() => {
    Animated.timing(checkFade, {
      toValue: active ? 1 : 0,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [active, checkFade]);
  const handlePress = () => {
    // Scale-pop — 0.94 → 1 spring rebound. Native driver keeps it smooth
    // even on big picker lists.
    Animated.sequence([
      Animated.timing(scale, { toValue: 0.94, duration: 80, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 4, tension: 220, useNativeDriver: true }),
    ]).start();
    onPress();
  };
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <TouchableOpacity
        onPress={handlePress}
        activeOpacity={0.7}
        style={{
          flexDirection: 'row', alignItems: 'center',
          paddingHorizontal: 18, paddingVertical: 12,
          borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
          borderBottomColor: colors?.border,
        }}
      >
        <Text style={{ flex: 1, fontSize: 15, color: colors?.text }}>{opt.label}</Text>
        <Animated.View style={{ opacity: checkFade, transform: [{ scale: checkFade }] }}>
          <IconCheck size={18} color={ACCENT} />
        </Animated.View>
      </TouchableOpacity>
    </Animated.View>
  );
}
