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
import ReelsRecorder from '../components/ReelsRecorder';
// [2026-10-08 reels-publish] drafts now live in services/reelDrafts.js (durable
// copies + compose metadata). Re-exported here for backwards compatibility.
import { saveReelDraft as _saveDraft, REEL_DRAFTS_KEY, MAX_REEL_DRAFTS } from '../services/reelDrafts';

export { REEL_DRAFTS_KEY, MAX_REEL_DRAFTS };

/**
 * Persist a new draft (see services/reelDrafts.js). Returns the persisted
 * record (with id + savedAt) or null.
 */
export async function saveReelDraft(payload) {
  return _saveDraft(payload);
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

  // [2026-10-08 reels-publish] Recorder → draft → /reels-compose. The draft is
  // persisted first (cold-kill safe); when the recorder was opened FROM the
  // composer (?from=compose) we hand the clips back via
  // globalThis.__pendingReelDraft + back(); otherwise we replace this screen
  // with the composer resuming that draft.
  const fromCompose = String(params?.from || '') === 'compose';
  const handleComplete = useCallback(async (payload) => {
    let rec = null;
    try { rec = await saveReelDraft(payload); } catch {}
    try {
      // eslint-disable-next-line no-undef
      globalThis.__pendingReelDraft = { ...payload, ...(rec ? { clips: rec.clips, draftId: rec.id } : {}) };
    } catch {}
    if (fromCompose) {
      try { router.back(); } catch {}
      return;
    }
    try {
      router.replace(rec?.id ? `/reels-compose?draft=${encodeURIComponent(rec.id)}` : '/reels-compose');
    } catch { try { router.back(); } catch {} }
  }, [router, fromCompose]);

  const handleOpenDrafts = useCallback(() => {
    try { router.push(fromCompose ? '/reels-drafts?from=compose' : '/reels-drafts'); } catch {}
  }, [router, fromCompose]);

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
