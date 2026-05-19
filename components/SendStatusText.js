/**
 * SendStatusText — humanized outbox state for a message bubble.
 *
 * Replaces the cryptic <IconWifiOff /> indicator below queued bubbles with
 * a short text line that mirrors WhatsApp's UX:
 *   queued      → "Enviando..."
 *   sending     → "Enviando..."
 *   failed      → "Tentando de novo (N)"  (when attempts > 0 and not max)
 *   permanently failed → "Falhou — tocar pra tentar"
 *   sent / delivered / read → null (the regular ticks take over)
 *
 * Subscribes to messageOutbox state for the specific client_message_id so
 * a status flip propagates without forcing the whole conversation list to
 * re-render.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { Text, TouchableOpacity, View, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import messageOutbox, { MAX_ATTEMPTS, subscribe as subscribeOutbox } from '../services/messageOutbox';

/**
 * Props:
 *   msg                — the message object (must have client_message_id OR id)
 *   color              — text color (defaults to theme.textTertiary)
 *   fontSize           — text size (default 10)
 *   onRetry            — optional callback. If omitted, taps the "failed" text
 *                        to call messageOutbox.requeue() + poke the worker.
 *   style              — extra View style
 */
export default function SendStatusText({ msg, color, fontSize = 10, onRetry, style }) {
  const { colors } = useTheme();
  const { t } = useLanguage();

  const cmi = msg?.client_message_id || msg?.id || null;
  const [snap, setSnap] = useState(null);

  // Initial hydration + live subscription.
  useEffect(() => {
    if (!cmi) return undefined;
    let active = true;
    (async () => {
      const s = await messageOutbox.getStatus(String(cmi));
      if (active && s) setSnap(s);
    })();
    const unsub = subscribeOutbox(String(cmi), (s) => {
      if (active) setSnap(s);
    });
    return () => { active = false; try { unsub?.(); } catch {} };
  }, [cmi]);

  const handleRetry = useCallback(async () => {
    if (typeof onRetry === 'function') {
      try { onRetry(msg); } catch {}
      return;
    }
    if (!cmi) return;
    try {
      await messageOutbox.requeue(String(cmi));
      const { poke } = require('../services/sendWorker');
      poke?.(msg?.conversation_id);
    } catch {}
  }, [cmi, msg, onRetry]);

  // Resolve text + behavior based on outbox state OR legacy msg flags.
  const state = snap?.state || (msg?._failed ? 'failed_legacy' : msg?._queued || msg?._pending ? 'queued' : null);
  const attempts = snap?.attempts || 0;
  const finalColor = color || colors.textTertiary;

  if (!state) return null;

  if (state === 'sent' || state === 'delivered' || state === 'read') {
    return null;
  }

  // Translate. We use existing chat.* keys when available and fall back to
  // sensible PT-BR defaults so a missing key doesn't show a literal id.
  let label = '';
  let tappable = false;
  if (state === 'queued' || state === 'sending') {
    label = t?.('chat.sending') || 'Enviando...';
  } else if (state === 'failed') {
    // Permanent failure surface — tap to retry.
    label = t?.('chat.failedTapToRetry') || 'Falhou — toque para tentar';
    tappable = true;
  } else if (state === 'failed_legacy') {
    label = t?.('chat.failedTapToRetry') || 'Falhou — toque para tentar';
    tappable = true;
  }

  // Mid-retry surface (attempts incremented but not at max). Reads as
  // "Tentando de novo (2)" so the user knows the app didn't forget.
  if ((state === 'queued' || state === 'sending') && attempts > 0 && attempts < MAX_ATTEMPTS) {
    label = (t?.('chat.retrying') || 'Tentando de novo') + ` (${attempts})`;
  }

  const node = (
    <Text
      numberOfLines={1}
      style={[
        { color: finalColor, fontSize, opacity: 0.85 },
        Platform.OS === 'web' ? { userSelect: 'none' } : null,
      ]}
      accessibilityLabel={label}
    >
      {label}
    </Text>
  );

  if (tappable) {
    return (
      <TouchableOpacity
        onPress={handleRetry}
        style={[{ flexDirection: 'row', alignItems: 'center', marginLeft: 3 }, style]}
        accessibilityRole="button"
      >
        {node}
      </TouchableOpacity>
    );
  }
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', marginLeft: 3 }, style]}>
      {node}
    </View>
  );
}
