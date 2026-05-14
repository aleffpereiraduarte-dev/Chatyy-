/**
 * LiveConnectingOverlay — Instagram-style skeleton card shown while we wait
 * for the stream to connect. Pulsing red ring orbits a round host avatar,
 * "Conectando à live de X..." text below.
 *
 * Pure presentation — parent owns connected/error state and retry handlers.
 */

import { useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform, Animated,
} from 'react-native';
import AvatarCircle from '../AvatarCircle';

const LIVE_RED = '#dc2626';

export default function LiveConnectingOverlay({
  hostName,
  hostEmail,
  errorText = null,
  showRetry = false,
  onRetry,
  onBack,
  retryLabel = 'Tentar novamente',
  backLabel = 'Voltar',
  connectingTo,
  connectingFallback = 'Conectando...',
}) {
  const entrance = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0.4)).current;
  const ringPulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.spring(entrance, {
      toValue: 1,
      friction: 7,
      tension: 110,
      useNativeDriver: true,
    }).start();
  }, [entrance]);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 1000, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(ringPulse, { toValue: 1.18, duration: 800, useNativeDriver: true }),
        Animated.timing(ringPulse, { toValue: 1, duration: 800, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [ringPulse]);

  return (
    <Animated.View
      style={[
        styles.overlay,
        {
          opacity: entrance,
          transform: [
            { translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
            { scale: entrance.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
          ],
        },
      ]}
    >
      <View style={styles.avatarWrap}>
        <Animated.View
          style={[
            styles.ringPulse,
            {
              opacity: pulse,
              transform: [{ scale: ringPulse }],
            },
          ]}
          pointerEvents="none"
        />
        <AvatarCircle
          name={hostName}
          email={hostEmail}
          size={72}
          style={styles.avatar}
        />
      </View>

      <Animated.Text style={[styles.name, { opacity: pulse }]}>
        {hostName || '…'}
      </Animated.Text>

      {errorText ? (
        <>
          <Text style={styles.errorText}>{errorText}</Text>
          <View style={styles.actions}>
            {showRetry ? (
              <TouchableOpacity onPress={onRetry} style={styles.btnPrimary} activeOpacity={0.85}>
                <Text style={styles.btnText}>{retryLabel}</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity onPress={onBack} style={styles.btnGhost} activeOpacity={0.85}>
              <Text style={styles.btnText}>{backLabel}</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <>
          <ActivityIndicator size="small" color="rgba(255,255,255,0.55)" style={{ marginTop: 18 }} />
          <Animated.Text style={[styles.subText, { opacity: pulse }]}>
            {hostName && connectingTo
              ? connectingTo.replace('{name}', hostName)
              : connectingFallback}
          </Animated.Text>
        </>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15,15,26,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
    } : {}),
  },
  avatarWrap: {
    width: 100, height: 100,
    alignItems: 'center', justifyContent: 'center',
    position: 'relative',
  },
  ringPulse: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 50,
    borderWidth: 2.5,
    borderColor: LIVE_RED,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 0 24px rgba(220,38,38,0.55)',
    } : {}),
  },
  avatar: {
    borderRadius: 999,
  },
  name: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 18,
    letterSpacing: 0.2,
  },
  subText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    marginTop: 10,
    letterSpacing: 0.3,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 14,
    textAlign: 'center',
    paddingHorizontal: 22,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },
  btnPrimary: {
    paddingHorizontal: 22,
    paddingVertical: 10,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 20,
  },
  btnGhost: {
    paddingHorizontal: 22,
    paddingVertical: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 20,
  },
  btnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
});
