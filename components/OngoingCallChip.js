// components/OngoingCallChip.js
// =================================================================
// "Join ongoing call" header chip (gap E2, 2026-05-20).
//
// Shown in the chat-conversation header WHEN:
//   1. chat_call_state_active(conversation_id) returns { active: true }.
//   2. The call is NOT locked (host hasn't sealed the room).
//   3. The current user is NOT already in `participants`.
//
// Tap → mint a LiveKit token via chatLivekitToken and route to
// /group-call?conversation_id=X&room=ROOM&joining=1. We polling refresh
// every 25s while the chip is visible; on mount the first probe is
// instant so the user doesn't sit on a stale empty header for 25s
// after entering the conversation.
//
// NB: This is a "weak" hint UI — backend WS already fans `call_invite`
// for new outbound calls. The chip catches the case where the user
// silenced the invite, missed it during a network blip, or the call
// was started by someone before they joined the convo.
//
// API contract: chatCallStateActive(conversation_id) — see services/api.js.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { TouchableOpacity, Text, View, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import { IconPhone, IconVideo } from './Icons';

const POLL_MS = 20000;

// `refreshKey` — optional. The host screen bumps it when a call_card
// message lands in the conversation (a call just started or ended) so the
// banner re-probes immediately instead of waiting for the next poll tick.
export default function OngoingCallChip({ conversationId, refreshKey }) {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();

  const [state, setState] = useState(null); // { active, locked, call_id, room, participants, video }
  const [joining, setJoining] = useState(false);
  const aliveRef = useRef(true);
  const pollTimerRef = useRef(null);

  const probe = useCallback(async () => {
    if (!conversationId) return;
    try {
      const r = await api.chatCallStateActive(conversationId);
      if (!aliveRef.current) return;
      const data = r?.data || r;
      if (data && typeof data === 'object') {
        setState(data);
      }
    } catch {
      // Backend may not have the endpoint yet — silent fallback to null
      // hides the chip entirely. We intentionally don't surface errors;
      // this is a passive hint.
    }
  }, [conversationId]);

  // Poll ONLY while the host screen is focused — useFocusEffect stops the
  // interval when chat-conversation blurs (e.g. user navigated into the
  // call itself or backed out to the list) and re-probes instantly on
  // return, so coming back from /group-call hides the banner right away.
  useFocusEffect(useCallback(() => {
    aliveRef.current = true;
    probe();
    pollTimerRef.current = setInterval(probe, POLL_MS);
    return () => {
      aliveRef.current = false;
      if (pollTimerRef.current) {
        try { clearInterval(pollTimerRef.current); } catch {}
        pollTimerRef.current = null;
      }
    };
  }, [probe]));

  // call_card landed in the thread → a call just started/ended here.
  // Re-probe immediately instead of waiting up to POLL_MS.
  useEffect(() => {
    if (refreshKey) probe();
  }, [refreshKey, probe]);

  // Visibility gate. We hide when:
  //   - state not yet loaded OR endpoint failed
  //   - call ended
  //   - room is locked (host closed it to new joiners)
  //   - current user is already a participant
  const me = (user?.email || '').toLowerCase();
  const participants = Array.isArray(state?.participants) ? state.participants : [];
  const meIsIn = !!me && participants.some(p => String(p || '').toLowerCase() === me);
  const visible = !!state?.active && !state?.locked && !meIsIn;
  if (!visible) return null;

  const handleJoin = async () => {
    if (joining) return;
    setJoining(true);
    try {
      const room = state?.room || state?.call_id || '';
      // Mint a token up-front so the group-call screen renders the WebView
      // without waiting on its own fetch; the screen also re-mints if our
      // token is missing/expired.
      let preToken = null;
      try {
        const r = await api.chatLivekitToken(conversationId, room);
        const d = r?.data || r;
        if (d?.token) preToken = d.token;
      } catch {}
      router.push({
        pathname: '/group-call',
        params: {
          conversation_id: String(conversationId),
          room: String(room || ''),
          joining: '1',
          video: state?.video ? '1' : '0',
          ...(preToken ? { __t: preToken } : {}),
        },
      });
      // Optimistically count myself as a participant so the banner hides
      // the moment we navigate (meIsIn gate) — the focus re-probe on
      // return confirms the real state.
      if (me) {
        setState(prev => (prev && typeof prev === 'object')
          ? { ...prev, participants: [...participants, me] }
          : prev);
      }
    } finally {
      if (aliveRef.current) setJoining(false);
    }
  };

  const isVideo = !!state?.video;
  const greenBg = isDark ? '#0E6B3A' : '#10b981';
  const otherCount = participants.length;
  // WhatsApp-style combined label ("Chamada em andamento · Toque para
  // entrar"); falls back to the older join-chip strings if the new key
  // hasn't shipped to a locale yet.
  const label = (t('chatConv.ongoingCallBanner') || t('chatConv.ongoingCallJoin') || 'Chamada em andamento · Toque para entrar')
    + (otherCount > 0 ? ` · ${otherCount}` : '');

  return (
    <TouchableOpacity
      onPress={handleJoin}
      activeOpacity={0.85}
      disabled={joining}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.chip, { backgroundColor: greenBg }]}
    >
      {joining ? (
        <ActivityIndicator size="small" color="#fff" />
      ) : isVideo ? (
        <IconVideo size={14} color="#fff" />
      ) : (
        <IconPhone size={14} color="#fff" />
      )}
      <Text style={styles.chipText} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  // Slim full-width banner pinned under the header (WhatsApp-style green
  // "ongoing call" strip) — was a small left-aligned chip before the
  // 2026-06-12 group-call banner round.
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    gap: 6,
    alignSelf: 'stretch',
  },
  chipText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});
