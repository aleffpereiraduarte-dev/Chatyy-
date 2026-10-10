/**
 * LiveFollowButton — pílula "Seguir" ao lado do nome do host (viewer).
 *
 * Consulta is_following (get_public_profile) uma vez; se já segue (ou é o
 * próprio usuário) não aparece. Toque → follow_user otimista; vira check e
 * some com fade após 1.4s (TikTok). Falha → volta pro estado anterior.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { TouchableOpacity, Text, StyleSheet, Animated } from 'react-native';
import { useLanguage } from '../../context/LanguageContext';
import { IconCheck, IconPlus } from '../Icons';
import * as engApi from './liveEngageApi';

function LiveFollowButton({ hostEmail, myEmail }) {
  const { t } = useLanguage();
  const [state, setState] = useState('unknown'); // unknown | follow | done | hidden
  const fade = useRef(new Animated.Value(1)).current;
  const host = String(hostEmail || '').toLowerCase();
  const me = String(myEmail || '').toLowerCase();

  useEffect(() => {
    if (!host || host === me) { setState('hidden'); return undefined; }
    let alive = true;
    engApi.isFollowing(host).then((f) => {
      if (!alive) return;
      setState(f === true ? 'hidden' : 'follow');
    }).catch(() => { if (alive) setState('follow'); });
    return () => { alive = false; };
  }, [host, me]);

  const onPress = async () => {
    if (state !== 'follow') return;
    setState('done');
    try {
      const r = await engApi.follow(host);
      if (r && r.success === false) throw new Error(r.message || 'follow failed');
      setTimeout(() => {
        Animated.timing(fade, { toValue: 0, duration: 260, useNativeDriver: true }).start(() => setState('hidden'));
      }, 1400);
    } catch {
      setState('follow');
    }
  };

  if (state === 'hidden' || state === 'unknown') return null;
  const done = state === 'done';
  return (
    <Animated.View style={{ opacity: fade }}>
      <TouchableOpacity
        onPress={onPress}
        disabled={done}
        style={[styles.pill, done && styles.pillDone]}
        hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
        accessibilityRole="button"
        accessibilityLabel={done ? t('liveEng.following') : t('liveEng.follow')}
      >
        {done ? <IconCheck size={12} color="#fff" /> : <IconPlus size={12} color="#000" />}
        <Text style={[styles.text, done && styles.textDone]}>{done ? t('liveEng.following') : t('liveEng.follow')}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

export default memo(LiveFollowButton);

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 3, height: 24, paddingHorizontal: 9,
    borderRadius: 12, backgroundColor: '#fff',
  },
  pillDone: { backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
  text: { color: '#000', fontSize: 11, fontWeight: '900', letterSpacing: 0.2 },
  textDone: { color: '#fff' },
});
