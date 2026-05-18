/**
 * /reels-recorder — full-screen dedicated camera surface for Reels creation.
 *
 * Hosts <ReelsRecorder /> as a fullScreenModal route. The component owns the
 * UI; this screen wires close + completion handlers to navigation.
 *
 * On complete the recorder hands back `{ clips, music, totalDurationMs }`.
 * For now we go back to the previous screen and (TODO) pass the clip stack
 * to a composer route (`/reels-compose`) that handles text overlays, filter
 * pass, caption, privacy, and the final POST `feed_create_post`.
 */
import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import ReelsRecorder from '../components/ReelsRecorder';

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

  const handleComplete = useCallback((payload) => {
    // TODO: route to /reels-compose with clip stack.
    // For now: stash via global and pop back; the parent (ChatReelsTab / feed)
    // can read it via an event bus in a follow-up cut.
    try {
      // eslint-disable-next-line no-undef
      globalThis.__pendingReelDraft = payload;
    } catch {}
    try { router.back(); } catch {}
  }, [router]);

  return (
    <View style={styles.root}>
      <ReelsRecorder
        onClose={handleClose}
        onComplete={handleComplete}
        initialMusic={initialMusic}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
});
