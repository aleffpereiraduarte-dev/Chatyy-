/**
 * StatusReplyInput.js
 *
 * Instagram/WhatsApp-style reply-to-status bar shown at the bottom of the
 * status viewer when viewing ANOTHER person's status (not your own).
 *
 * Features:
 *  - Text input with "Reply to status…" placeholder
 *  - Emoji quick-reaction row (❤️🔥😂😮😢👏)
 *  - Tapping an emoji sends it immediately as a chat message (no confirm needed)
 *  - Pressing Send on the text input sends the reply and clears the field
 *  - Visual send-in-progress state (spinner, disabled input)
 *  - Keyboard-aware layout via KeyboardAvoidingView
 *
 * Props:
 *   ownerEmail     {string}    — email of the status owner (recipient)
 *   ownerName      {string}    — display name for accessibility labels
 *   currentItem    {object}    — the status item currently on screen
 *   t              {function}  — i18n translate function
 *   colors         {object}    — theme colors
 *   isDark         {boolean}
 *   onSent         {function}  — optional callback after a successful send
 *   onFocus        {function}  — called when the input gains focus (parent can pause timer)
 *   onBlur         {function}  — called when the input loses focus (parent can resume timer)
 *
 * The component is intentionally self-contained: it handles the API calls for
 * both text replies and emoji reactions internally. The parent only needs to
 * mount/unmount it and pass the current item.
 */

import React, { useState, useRef, useCallback, memo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  KeyboardAvoidingView,
  ActivityIndicator,
  Animated,
} from 'react-native';
import * as api from '../services/api';
import { BASE_URL } from '../services/api';

const QUICK_REACTIONS = ['❤️', '🔥', '😂', '😮', '😢', '👏'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function _ensureConversation(ownerEmail) {
  const r = await api.chatCreate([ownerEmail], '', 'direct');
  const convId = r?.data?.conversation_id || r?.data?.id;
  if (!convId) throw new Error('Could not open conversation');
  return convId;
}

function _buildStatusContext(item, ownerName, t) {
  if (!item) return null;
  const type = item.type || 'text';
  const label = `↩️ ${t?.('status.replyToStatus') || 'Replied to your status'}`;

  if (type === 'image' && item.content) {
    const imgUrl = (item.content || '').split('\n')[0];
    const fullUrl = imgUrl.startsWith('/') ? BASE_URL + imgUrl : imgUrl;
    return { type: 'image', fileUrl: fullUrl, label };
  }
  if (type === 'video' && item.content) {
    const vidUrl = (item.content || '').split('\n')[0];
    const fullUrl = vidUrl.startsWith('/') ? BASE_URL + vidUrl : vidUrl;
    return { type: 'video', fileUrl: fullUrl, label };
  }
  // Text / music / other
  const preview = (item.content || '').substring(0, 80);
  return { type: 'text', preview, label, ownerName };
}

// ─── Reaction button with scale animation ────────────────────────────────────
const ReactionButton = memo(function ReactionButton({ emoji, onPress, sent, disabled }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePress = useCallback(() => {
    if (disabled) return;
    // Pop animation
    Animated.sequence([
      Animated.spring(scaleAnim, { toValue: 1.4, useNativeDriver: true, tension: 200, friction: 5 }),
      Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, tension: 100, friction: 8 }),
    ]).start();
    onPress(emoji);
  }, [emoji, onPress, disabled, scaleAnim]);

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={disabled}
      activeOpacity={0.7}
      style={[styles.reactionBtn, sent && styles.reactionBtnSent]}
      accessibilityLabel={`React with ${emoji}`}
      accessibilityRole="button"
    >
      <Animated.Text
        style={[styles.reactionEmoji, { transform: [{ scale: scaleAnim }] }]}
        allowFontScaling={false}
      >
        {emoji}
      </Animated.Text>
      {sent && <View style={styles.reactionSentDot} />}
    </TouchableOpacity>
  );
});

// ─── Main component ────────────────────────────────────────────────────────────
function StatusReplyInput({
  ownerEmail,
  ownerName,
  currentItem,
  t,
  colors,
  isDark,
  onSent,
  onFocus,
  onBlur,
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sentReactions, setSentReactions] = useState({}); // { emoji: true }
  const inputRef = useRef(null);

  const bg = isDark ? 'rgba(0,0,0,0.72)' : 'rgba(255,255,255,0.92)';
  const inputBg = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)';
  const inputText = isDark ? '#fff' : '#111';
  const placeholderColor = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)';
  const sendColor = colors?.primary || '#7C3AED';
  const dividerColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

  // ─── Send text reply ───────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || !ownerEmail) return;

    setSending(true);
    inputRef.current?.blur();
    try {
      const convId = await _ensureConversation(ownerEmail);
      const ctx = _buildStatusContext(currentItem, ownerName, t);

      if (ctx?.type === 'image') {
        await api.chatSend(convId, `${ctx.label}: ${trimmed}`, 'image', null, null, ctx.fileUrl);
      } else if (ctx?.type === 'video') {
        await api.chatSend(convId, `${ctx.label}: ${trimmed}`, 'video', null, null, ctx.fileUrl);
      } else {
        const preview = ctx?.preview ? `"${ctx.preview}"` : '';
        const msg = preview
          ? `${ctx?.label || ''}: ${preview}\n\n${trimmed}`
          : trimmed;
        await api.chatSend(convId, msg, 'text');
      }

      setText('');
      onSent?.({ type: 'text', text: trimmed });
    } catch (err) {
      // Silently fail — the UX stays open for a retry
      if (__DEV__) console.warn('[StatusReplyInput] Send failed:', err?.message);
    } finally {
      setSending(false);
    }
  }, [text, sending, ownerEmail, ownerName, currentItem, t, onSent]);

  // ─── Send emoji reaction ───────────────────────────────────────────────────
  const handleReact = useCallback(async (emoji) => {
    if (sending || !ownerEmail) return;

    // Optimistic: mark this emoji as sent
    setSentReactions(prev => ({ ...prev, [emoji]: true }));
    setSending(true);

    try {
      // Try dedicated status_react endpoint first (new backend endpoint)
      const statusId = currentItem?.id;
      if (statusId) {
        const r = await api.apiCall('status_react', { status_id: statusId, emoji }, 'POST');
        if (r?.success) {
          onSent?.({ type: 'reaction', emoji });
          return;
        }
      }

      // Fallback: send as a regular chat message (always works even before
      // the backend adds status_react)
      const convId = await _ensureConversation(ownerEmail);
      const ctx = _buildStatusContext(currentItem, ownerName, t);
      if (ctx?.type === 'image') {
        await api.chatSend(convId, `${emoji} ${ctx.label}`, 'image', null, null, ctx.fileUrl);
      } else if (ctx?.type === 'video') {
        await api.chatSend(convId, `${emoji} ${ctx.label}`, 'video', null, null, ctx.fileUrl);
      } else {
        await api.chatSend(convId, emoji, 'text');
      }
      onSent?.({ type: 'reaction', emoji });
    } catch (err) {
      // Undo optimistic update on failure
      setSentReactions(prev => {
        const next = { ...prev };
        delete next[emoji];
        return next;
      });
      if (__DEV__) console.warn('[StatusReplyInput] React failed:', err?.message);
    } finally {
      setSending(false);
    }
  }, [sending, ownerEmail, ownerName, currentItem, t, onSent]);

  const canSend = text.trim().length > 0 && !sending;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
    >
      <View style={[styles.container, { backgroundColor: bg }]}>
        {/* Emoji quick reactions */}
        <View style={[styles.reactionsRow, { borderBottomColor: dividerColor }]}>
          {QUICK_REACTIONS.map((emoji) => (
            <ReactionButton
              key={emoji}
              emoji={emoji}
              onPress={handleReact}
              sent={!!sentReactions[emoji]}
              disabled={sending}
            />
          ))}
        </View>

        {/* Text input row */}
        <View style={styles.inputRow}>
          <TextInput
            ref={inputRef}
            style={[styles.input, { backgroundColor: inputBg, color: inputText }]}
            value={text}
            onChangeText={setText}
            placeholder={
              t?.('status.replyPlaceholder') || 'Reply to status...'
            }
            placeholderTextColor={placeholderColor}
            onFocus={onFocus}
            onBlur={onBlur}
            editable={!sending}
            returnKeyType="send"
            onSubmitEditing={handleSend}
            multiline={false}
            maxLength={1000}
            accessibilityLabel={t?.('status.replyPlaceholder') || 'Reply to status'}
            accessibilityHint={
              ownerName
                ? (t?.('status.replyHint') || 'Send a reply to {name}').replace('{name}', ownerName)
                : undefined
            }
          />

          {/* Send button / spinner */}
          <TouchableOpacity
            style={[
              styles.sendBtn,
              { backgroundColor: canSend ? sendColor : 'transparent' },
              // Why: violet ambient glow only when the button is "live" — keeps
              // the disabled state quiet and gives the active CTA real punch.
              canSend && Platform.OS === 'web' && { boxShadow: '0 4px 14px rgba(124,58,237,0.45)' },
              canSend && Platform.OS === 'ios' && { shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.32, shadowRadius: 8 },
              canSend && Platform.OS === 'android' && { elevation: 4 },
            ]}
            onPress={handleSend}
            disabled={!canSend}
            activeOpacity={0.75}
            accessibilityLabel={t?.('common.send') || 'Send'}
            accessibilityRole="button"
          >
            {sending && text.trim().length > 0 ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <SendIcon color={canSend ? '#fff' : placeholderColor} />
            )}
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// ─── Inline send icon (avoids Icon import cycle) ─────────────────────────────
function SendIcon({ color = '#fff', size = 20 }) {
  // Simple paper-plane path drawn inline so this component has zero extra deps
  return (
    <View
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      accessibilityElementsHidden
    >
      {/* Unicode plane fallback for web/native cross-compat */}
      <Text style={{ fontSize: size * 0.8, color, lineHeight: size }} allowFontScaling={false}>
        ➤
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingBottom: Platform.OS === 'ios' ? 28 : 12,
    paddingTop: 0,
  },
  reactionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  reactionBtn: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 21,
  },
  reactionBtnSent: {
    backgroundColor: 'rgba(124,58,237,0.15)',
  },
  reactionEmoji: {
    fontSize: 26,
  },
  reactionSentDot: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#7C3AED',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 10,
    gap: 8,
  },
  input: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    paddingHorizontal: 18,
    paddingVertical: 0,
    fontSize: 14.5,
    // Why: bumped pill (42→44, radius 21→22, padX 16→18) so the field reads
    // as primary input instead of secondary control. Web transition smooths
    // the focus tint when the parent toggles inputBg on focus.
    ...(Platform.OS === 'web' ? { outlineStyle: 'none', transition: 'background-color 200ms ease' } : {}),
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    // Violet ambient glow when send is enabled — matches /one + plans CTA.
    ...(Platform.OS === 'web' ? { transition: 'transform 140ms ease, box-shadow 200ms ease', cursor: 'pointer' } : {}),
  },
});

export default memo(StatusReplyInput);
