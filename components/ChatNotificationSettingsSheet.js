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

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, Modal, Pressable, TouchableOpacity, ScrollView, Switch,
  StyleSheet, Platform, ActivityIndicator,
} from 'react-native';
import * as api from '../services/api';
import { IconX, IconBell, IconCheck } from './Icons';

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
    if (duration === '8h') muteUntil = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
    else if (duration === '1w') muteUntil = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    else if (duration === 'forever') muteUntil = '2099-12-31T23:59:59Z';
    saveField({ mute_until: muteUntil });
    // Mirror to chatMute so the existing mute UI badge stays in sync.
    try { await api.chatMute(conversationId, muteUntil); } catch {}
  }, [conversationId, saveField]);

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
            contentContainerStyle={{ paddingBottom: 24 }}
            keyboardShouldPersistTaps="handled"
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

            {/* Vibração picker */}
            <SectionHeader text={t?.('notif.vibration') || 'Vibração'} colors={colors} />
            <PickerRow
              options={[
                { value: 'default', label: t?.('chatNotif.default') || 'Padrão' },
                { value: 'short',   label: t?.('chatConv.vibShort') || 'Curta' },
                { value: 'long',    label: t?.('chatConv.vibLong') || 'Longa' },
                { value: 'off',     label: t?.('common.off') || 'Desligada' },
              ]}
              value={settings.vibration}
              onChange={(v) => saveField({ vibration: v })}
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
                { value: '8h',      label: t?.('chatConv.muteFor8h') || 'Silenciar por 8 horas' },
                { value: '1w',      label: t?.('chatConv.muteFor1w') || 'Silenciar por 1 semana' },
                { value: 'forever', label: t?.('chatConv.muteForever') || 'Silenciar sempre' },
                { value: null,      label: t?.('chatConv.unmute') || 'Desativar silêncio' },
              ]}
              // Map mute_until into one of the 4 buckets so the user sees a
              // checkmark on the row that matches their current state.
              value={(() => {
                if (!settings.mute_until) return null;
                if (settings.mute_until.startsWith('2099-')) return 'forever';
                const ms = new Date(settings.mute_until).getTime() - Date.now();
                if (!Number.isFinite(ms) || ms <= 0) return null;
                if (ms <= 12 * 3600 * 1000) return '8h';
                return '1w';
              })()}
              onChange={(v) => handleMuteFor(v)}
              colors={colors}
            />
          </ScrollView>
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
      {options.map((opt, idx) => {
        const active = String(opt.value) === String(value);
        return (
          <TouchableOpacity
            key={String(opt.value)}
            onPress={() => onChange(opt.value)}
            activeOpacity={0.7}
            style={{
              flexDirection: 'row', alignItems: 'center',
              paddingHorizontal: 18, paddingVertical: 12,
              borderBottomWidth: idx === options.length - 1 ? 0 : StyleSheet.hairlineWidth,
              borderBottomColor: colors?.border,
            }}
          >
            <Text style={{ flex: 1, fontSize: 15, color: colors?.text }}>{opt.label}</Text>
            {active ? <IconCheck size={18} color={ACCENT} /> : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}
