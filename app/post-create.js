/**
 * /post-create — Reels P0 entrypoint for Duet / Stitch flows.
 *
 * Mounts CreatePostModal pre-wired with `duetOf` or `stitchOf` so the recorder
 * boots into split-screen or trim+react mode. The composer fetches the parent
 * clip via chat_reels_duet_init / chat_reels_stitch_init, the user records a
 * companion clip, then publish calls duet-compose.php (ffmpeg) followed by
 * feed_create_post with parent_post_id + duet_type.
 */
import React, { useCallback } from 'react';
import { View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import CreatePostModal from '../components/CreatePostModal';

export default function PostCreateScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();

  const duetOf = params?.duet_of ? Number(params.duet_of) : null;
  const stitchOf = params?.stitch_of ? Number(params.stitch_of) : null;
  const presetSoundId = params?.sound_id ? String(params.sound_id) : null;
  const presetSoundLabel = params?.sound_label ? String(params.sound_label) : null;

  const handleClose = useCallback(() => {
    try { router.back(); } catch {}
  }, [router]);

  const handleCreated = useCallback(() => {
    try { router.replace('/chat?tab=feed'); } catch {}
  }, [router]);

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CreatePostModal
        visible
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        onClose={handleClose}
        onPostCreated={handleCreated}
        duetOf={duetOf}
        stitchOf={stitchOf}
        presetSoundId={presetSoundId}
        presetSoundLabel={presetSoundLabel}
      />
    </View>
  );
}
