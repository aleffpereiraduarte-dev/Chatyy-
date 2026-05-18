/**
 * /reels-recorder — full-screen dedicated camera surface for Reels creation.
 *
 * Hosts <ReelsRecorder /> as a fullScreenModal route. The component owns the
 * UI; this screen wires close + completion handlers to navigation.
 *
 * On complete the recorder hands back `{ clips, music, totalDurationMs }`.
 * We persist a lightweight draft (clip URIs + music + timestamp) under the
 * AsyncStorage `reel_drafts` array (capped at 5, newest first). The user can
 * resume from /reels-drafts. Cold-kill safe — `globalThis.__pendingReelDraft`
 * was memory-only and lost across process restarts.
 */
import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ReelsRecorder from '../components/ReelsRecorder';

export const REEL_DRAFTS_KEY = 'reel_drafts';
export const MAX_REEL_DRAFTS = 5;

/**
 * Persist a new draft to AsyncStorage. Drafts are stored newest-first,
 * trimmed to MAX_REEL_DRAFTS to avoid unbounded disk usage from abandoned
 * recordings. Returns the persisted record (with id + savedAt).
 */
export async function saveReelDraft(payload) {
  try {
    const raw = await AsyncStorage.getItem(REEL_DRAFTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const safeList = Array.isArray(list) ? list : [];
    const record = {
      id: `draft_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      savedAt: Date.now(),
      clips: payload?.clips || [],
      music: payload?.music || null,
      totalDurationMs: payload?.totalDurationMs || 0,
    };
    const next = [record, ...safeList].slice(0, MAX_REEL_DRAFTS);
    await AsyncStorage.setItem(REEL_DRAFTS_KEY, JSON.stringify(next));
    return record;
  } catch {
    return null;
  }
}

export default function ReelsRecorderScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();

  // Optional pre-seeded sound from /reels-sound "Use this sound" deep link.
  // Pass as `?sound_id=…&sound_url=…&sound_title=…`.
  const initialMusic = params?.sound_id
    ? {
        id: String(params.sound_id),
        url: String(params.sound_url || ''),
        title: String(params.sound_title || ''),
      }
    : null;

  const handleClose = useCallback(() => {
    try { router.back(); } catch {}
  }, [router]);

  const handleComplete = useCallback(async (payload) => {
    // Persist a recoverable draft AND keep the in-memory ref so the next
    // composer cut (router.push('/reels-compose')) can pick the clip stack
    // up immediately without re-reading AsyncStorage.
    try {
      // eslint-disable-next-line no-undef
      globalThis.__pendingReelDraft = payload;
    } catch {}
    try { await saveReelDraft(payload); } catch {}
    try { router.back(); } catch {}
  }, [router]);

  const handleOpenDrafts = useCallback(() => {
    try { router.push('/reels-drafts'); } catch {}
  }, [router]);

  return (
    <View style={styles.root}>
      <ReelsRecorder
        onClose={handleClose}
        onComplete={handleComplete}
        onOpenDrafts={handleOpenDrafts}
        initialMusic={initialMusic}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
});
