// Premium animated reaction burst — full-screen emoji particles
import { useEffect, useRef } from 'react';
import { View, Text, Image, Animated, StyleSheet, Dimensions, Easing } from 'react-native';
import * as api from '../services/api';

const { width: SW, height: SH } = Dimensions.get('window');

// Plays a burst of emoji particles that fly up and fade out.
// Props: emoji, particles (count), onDone, premium (bigger, longer).
export default function ReactionBurst({ emoji = '❤️', particles = 12, onDone, premium = false }) {
  const anims = useRef(
    Array.from({ length: premium ? 18 : particles }, () => ({
      x: new Animated.Value(0),
      y: new Animated.Value(0),
      rot: new Animated.Value(0),
      scale: new Animated.Value(0.2),
      opacity: new Animated.Value(1),
      dx: (Math.random() - 0.5) * (premium ? SW * 0.9 : SW * 0.6),
      dy: -(SH * (premium ? 0.6 : 0.45)) - Math.random() * 120,
      drot: (Math.random() - 0.5) * 720,
      size: premium ? 32 + Math.random() * 24 : 24 + Math.random() * 16,
      delay: Math.random() * (premium ? 200 : 120),
    }))
  ).current;

  useEffect(() => {
    const duration = premium ? 1600 : 1100;
    Animated.parallel(
      anims.map((a) =>
        Animated.sequence([
          Animated.delay(a.delay),
          Animated.parallel([
            Animated.timing(a.x, { toValue: a.dx, duration, useNativeDriver: true, easing: Easing.out(Easing.quad) }),
            Animated.timing(a.y, { toValue: a.dy, duration, useNativeDriver: true, easing: Easing.out(Easing.cubic) }),
            Animated.timing(a.rot, { toValue: a.drot, duration, useNativeDriver: true }),
            Animated.sequence([
              Animated.spring(a.scale, { toValue: 1, tension: 180, friction: 6, useNativeDriver: true }),
              Animated.timing(a.scale, { toValue: 0.6, duration: duration * 0.6, useNativeDriver: true, delay: duration * 0.3 }),
            ]),
            Animated.timing(a.opacity, { toValue: 0, duration, useNativeDriver: true, easing: Easing.in(Easing.quad) }),
          ]),
        ])
      )
    ).start(() => { onDone && onDone(); });
  }, []);

  // Sticker reactions arrive as 'sticker:<url>' so the burst renders the
  // image instead of a text glyph. URL is resolved through getMediaUrl so
  // relative /data/ paths still work.
  const isSticker = typeof emoji === 'string' && emoji.startsWith('sticker:');
  const stickerUri = isSticker ? api.getMediaUrl(emoji.slice(8)) : null;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={{ position: 'absolute', left: SW / 2, top: SH / 2 }}>
        {anims.map((a, i) => {
          const transform = [
            { translateX: a.x },
            { translateY: a.y },
            { rotate: a.rot.interpolate({ inputRange: [-720, 720], outputRange: ['-720deg', '720deg'] }) },
            { scale: a.scale },
          ];
          if (isSticker) {
            return (
              <Animated.View key={i} style={{ position: 'absolute', opacity: a.opacity, transform }}>
                <Image source={{ uri: stickerUri }} style={{ width: a.size * 1.6, height: a.size * 1.6 }} resizeMode="contain" />
              </Animated.View>
            );
          }
          return (
            <Animated.Text
              key={i}
              style={{
                position: 'absolute',
                fontSize: a.size,
                opacity: a.opacity,
                transform,
              }}
            >
              {emoji}
            </Animated.Text>
          );
        })}
      </View>
    </View>
  );
}
