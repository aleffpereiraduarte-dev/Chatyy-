import { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import { IconThumbsUp, IconHeart, IconLaughFace, IconClap, IconSurpriseFace, IconFlame, IconThinkingFace, IconHundred } from './Icons';

const ICON_MAP = {
  thumbsup: IconThumbsUp,
  heart: IconHeart,
  laugh: IconLaughFace,
  clap: IconClap,
  surprise: IconSurpriseFace,
  fire: IconFlame,
  thinking: IconThinkingFace,
  hundred: IconHundred,
};

function ReactionBubble({ emoji, displayName }) {
  const opacity = useRef(new Animated.Value(1)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const left = useRef(Math.random() * 60 + 20).current;
  const ReactionIcon = ICON_MAP[emoji];

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: 3000, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: -200, duration: 3000, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <Animated.View
      style={[styles.bubble, { left: `${left}%`, opacity, transform: [{ translateY }] }]}
    >
      <View style={styles.disc}>{ReactionIcon ? <ReactionIcon size={28} color="#000" /> : null}</View>
      <Text style={styles.name} numberOfLines={1}>{displayName}</Text>
    </Animated.View>
  );
}

export default function MeetReactionsOverlay({ reactions }) {
  const visible = (reactions || []).slice(-10);

  return (
    <View style={styles.container} pointerEvents="none">
      {visible.map((r) => (
        <ReactionBubble key={r.id} emoji={r.emoji} displayName={r.displayName} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 80,
  },
  bubble: {
    position: 'absolute',
    bottom: 150,
    alignItems: 'center',
  },
  // [2026-10-15 meet-v2] disco branco + ícone preto: legível sobre qualquer vídeo
  disc: {
    width: 52, height: 52, borderRadius: 26, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  name: {
    fontSize: 11,
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
    marginTop: 2,
    overflow: 'hidden',
    maxWidth: 80,
  },
});
