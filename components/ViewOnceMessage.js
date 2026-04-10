import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, ImageBackground } from 'react-native';
import { IconEye, IconLock } from './Icons';

/**
 * View Once Message Component
 * WhatsApp-style disappearing image that:
 * 1. Shows blurred preview until first view
 * 2. Displays 10-second countdown after viewing
 * 3. Deletes automatically (shows "Expired")
 * 4. Marks as viewed when tapped
 */
export default function ViewOnceMessage({ msg, colors = {}, isOwn, onView, t }) {
  // FIX: safeColors com fallbacks para evitar undefined
  const safeColors = {
    surface: '#fff',
    border: '#e0e0e0',
    primary: '#007AFF',
    textTertiary: '#999',
    textSecondary: '#666',
    text: '#000',
    ...colors,
  };

  // FIX: estado sincronizado com msg via useEffect (não só inicialização)
  const [viewed, setViewed] = useState(!!msg?.viewed_at);
  const [timeLeft, setTimeLeft] = useState(10);
  const [expired, setExpired] = useState(!!msg?.expired_at);

  // FIX: sincronizar estado quando msg muda (ex: componente reutilizado com msg diferente)
  useEffect(() => {
    setViewed(!!msg?.viewed_at);
    setExpired(!!msg?.expired_at);
    setTimeLeft(10);
  }, [msg?.id]);

  const blurOpacity = useRef(new Animated.Value(msg?.viewed_at ? 0 : 1)).current;
  const countdownRotate = useRef(new Animated.Value(0)).current;

  // Countdown timer (10 segundos após primeiro view)
  useEffect(() => {
    if (!viewed || expired) return;

    const interval = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          setExpired(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [viewed, expired]);

  // Animate blur removal
  useEffect(() => {
    Animated.timing(blurOpacity, {
      toValue: viewed ? 0 : 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [viewed, blurOpacity]);

  // Animate countdown ring
  useEffect(() => {
    if (!viewed || expired) return;
    Animated.timing(countdownRotate, {
      toValue: 1 - timeLeft / 10,
      duration: 100,
      useNativeDriver: false,
    }).start();
  }, [timeLeft, viewed, expired, countdownRotate]);

  const handleView = () => {
    if (viewed || expired) return;
    setViewed(true);
    onView?.(msg?.id);
  };

  // FIX: validar file_url antes de usar
  const fileUrl = msg?.file_url || null;

  // Mensagem expirada
  if (expired) {
    return (
      <View style={[s.container, { backgroundColor: safeColors.surface }]}>
        <View style={s.expiredContent}>
          <IconLock size={40} color={safeColors.textSecondary} />
          <Text style={[s.expiredText, { color: safeColors.textSecondary }]}>
            {t?.('chatConv.viewOncePhoto') || 'View-once photo'}
          </Text>
          <Text style={[s.expiredSubtext, { color: safeColors.textTertiary }]}>
            {t?.('chatConv.expired') || 'Expired'}
          </Text>
        </View>
      </View>
    );
  }

  // Não visualizada — mostrar preview borrado
  if (!viewed) {
    return (
      <TouchableOpacity
        onPress={handleView}
        style={s.container}
        activeOpacity={0.8}
      >
        {fileUrl ? (
          <ImageBackground
            source={{ uri: fileUrl }}
            style={s.imageContainer}
            blurRadius={20}
          >
            <Animated.View style={[s.overlay, { opacity: blurOpacity }]}>
              <View style={[s.iconBg, { backgroundColor: 'rgba(0,0,0,0.4)' }]}>
                <IconEye size={32} color="#fff" />
              </View>
              <Text style={s.tapText}>{t?.('chatConv.tapToView') || 'Tap to view'}</Text>
            </Animated.View>
          </ImageBackground>
        ) : (
          <View style={[s.imageContainer, { backgroundColor: '#222', justifyContent: 'center', alignItems: 'center' }]}>
            <IconEye size={32} color="#fff" />
            <Text style={[s.tapText, { marginTop: 8 }]}>{t?.('chatConv.tapToView') || 'Tap to view'}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  }

  // Visualizada — mostrar countdown antes de expirar
  return (
    <View style={s.container}>
      {fileUrl ? (
        <ImageBackground
          source={{ uri: fileUrl }}
          style={s.imageContainer}
        >
          <View style={s.countdownContainer}>
            <Animated.View
              style={[
                s.countdownRing,
                {
                  transform: [
                    {
                      rotate: countdownRotate.interpolate({
                        inputRange: [0, 1],
                        outputRange: ['0deg', '360deg'],
                      }),
                    },
                  ],
                },
              ]}
            >
              <View style={[s.countdownInner, { backgroundColor: safeColors.surface }]}>
                <Text style={[s.countdownText, { color: safeColors.text }]}>
                  {timeLeft}
                </Text>
              </View>
            </Animated.View>
          </View>
        </ImageBackground>
      ) : (
        <View style={[s.imageContainer, { backgroundColor: '#222', justifyContent: 'center', alignItems: 'center' }]}>
          <Text style={[s.countdownText, { color: '#fff', fontSize: 32 }]}>{timeLeft}</Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    width: '100%',
    height: 300,
    marginVertical: 6,
    borderRadius: 12,
    overflow: 'hidden',
  },
  imageContainer: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  overlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconBg: {
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  tapText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  expiredContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  expiredText: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 12,
  },
  expiredSubtext: {
    fontSize: 12,
    marginTop: 4,
  },
  countdownContainer: {
    position: 'absolute',
    top: 16,
    right: 16,
    width: 50,
    height: 50,
    justifyContent: 'center',
    alignItems: 'center',
  },
  countdownRing: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 3,
    borderColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  countdownInner: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  countdownText: {
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
});
