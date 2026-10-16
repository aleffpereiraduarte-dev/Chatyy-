import { useEffect, useRef, useCallback } from 'react';
import { View, Animated, Image, StyleSheet, Easing, Platform } from 'react-native';
// [2026-10-07 coldstart] Splash hide goes through services/bootTrace so the
// boot trace records who released it (idempotent with the chat-list owner).
import { hideNativeSplash, isSplashHidden, mark as bootMark } from '../services/bootTrace';

// [#1239 2026-05-20] Restore Chatyy logo on the JS splash so the cold-start
// hand-off doesn't show a blank white square. The native splash image lives
// in app.json (splash-blank.png — kept blank to avoid a flash-of-native-logo)
// so we paint the logo here in JS, with a gentle scale+fade entrance and the
// existing 200ms fade-out hand-off to the real UI.
//
// [WAVE 53 2026-05-21] Adds a one-shot wink/blink on the icon right after
// it lands — same pattern as the ChatyyOneAvatar wink (close 80ms / hold
// 60ms / open 110ms). The new app icon is a face, so the blink reads as
// "the app is alive and saying hi" instead of staring blankly.
// Implemented as two small overlay bars positioned over the icon's eyes
// that scaleY from 0 → 1 → 0 in sync. Sized as a fraction of the logo so
// it scales correctly across devices.

const LOGO_SIZE = 132;
// Eye position is empirically tuned to match the new icon's face. The
// icon has its eyes at roughly y=44% of its height, with the pair centered
// horizontally and ~22px apart (relative to a 132px logo).
const EYE_TOP_FRAC = 0.42;
const EYE_OFFSET_X = 18; // half-distance between eyes, in logo px
const EYE_W = 12;
const EYE_H = 6;

export default function AnimatedSplash({ onFinish }) {
  const fadeOut = useRef(new Animated.Value(1)).current;
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoScale = useRef(new Animated.Value(0.86)).current;
  // Eyelid scaleY: 0 = open (lid hidden), 1 = closed (lid fully drawn).
  const eyelid = useRef(new Animated.Value(0)).current;

  // [2026-10-16 wave10-C boot] A marca NÃO esconde mais o splash nativo no
  // onLayout. Medido no Android: 63/98 boots em 1º plano soltavam o splash na
  // 'brand' (auth > 600 ms → index.js monta esta marca) e a lista só aparecia
  // depois da entrada (≥360 ms) + fade (220 ms) + router.replace — p50 1,99 s.
  // Agora, com o splash nativo ainda na tela, a marca libera o index.js NA HORA
  // (onFinish imediato): a rota anda assim que a auth resolve e quem esconde o
  // splash é a 1ª tela útil (lista do cache → bootTrace.markFirstListPaint, login,
  // etc.). A marca segue tocando por baixo e só aparece se a auth demorar além
  // do fallback do bootTrace (1,5 s após o gate / teto 4 s) — aí ela é o visual,
  // como antes. Kill switch: globalThis.__chatyy_brand_hold = false → antigo.
  // Web não tem splash nativo cobrindo → comportamento antigo (entrada + fade).
  const legacyRef = useRef((() => { try { return Platform.OS === 'web' || globalThis.__chatyy_brand_hold === false; } catch { return false; } })());
  const onLayoutReady = useCallback(() => {
    try { bootMark('brand_layout'); } catch {}
    if (legacyRef.current) hideNativeSplash('brand');
  }, []);

  // [COLD-START 2026-09-30] The branded JS splash used to HOLD a hardcoded
  // ~900ms + 220ms fade (~1120ms) on top of the native splash, and app/index.js
  // blocks routing on `splashDone` — so this fixed hold added a full second to
  // every cold start. Now the splash finishes on READINESS: onFinish fires as
  // soon as the entrance (scale+fade) completes, with a short safety cap so it
  // can never hang and never outlast auth/cache readiness. The blink still
  // plays; if it's mid-wink when the hand-off starts it simply fades out with
  // the rest. onFinish is fired exactly once (finishedRef guard).
  const finishedRef = useRef(false);
  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    try { bootMark('brand_finish'); } catch {}
    Animated.timing(fadeOut, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true,
    }).start(() => {
      onFinish?.();
    });
  }, [onFinish, fadeOut]);

  // [2026-10-16 wave10-C boot] Splash nativo ainda cobrindo a tela = ninguém vê
  // a marca → libera o index.js já (sem fade: não há o que esmaecer). Se o
  // splash nativo já caiu (marca visível), mantém entrada + fade como antes.
  useEffect(() => {
    if (legacyRef.current || finishedRef.current) return;
    let hidden = false;
    try { hidden = isSplashHidden(); } catch {}
    if (hidden) return;
    finishedRef.current = true;
    try { bootMark('brand_finish:covered'); } catch {}
    onFinish?.();
  }, [onFinish]);

  useEffect(() => {
    // Logo entrance: scale + fade up over 280ms with a soft ease-out. Fire the
    // hand-off as soon as this entrance settles so the branded splash overlaps
    // readiness instead of adding a fixed hold on top of it.
    Animated.parallel([
      Animated.timing(logoOpacity, {
        toValue: 1,
        duration: 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(logoScale, {
        toValue: 1,
        tension: 70,
        friction: 9,
        useNativeDriver: true,
      }),
    ]).start(() => { finish(); });

    // Wink: 300ms into the splash (logo has settled), close fast (80ms),
    // hold 60ms so the closed eyes register, then open slower (110ms) for
    // a friendly "blink hello" feel. Single shot — no loop.
    Animated.sequence([
      Animated.delay(320),
      Animated.timing(eyelid, { toValue: 1, duration: 80, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      Animated.delay(60),
      Animated.timing(eyelid, { toValue: 0, duration: 110, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();

    // Safety cap: NEVER let the splash hang. If the entrance animation's
    // completion callback doesn't fire (reduced-motion, backgrounded during
    // boot, a dropped frame), this short cap forces the hand-off. ~360ms keeps
    // the perceived branded moment while slashing the old ~1120ms floor.
    const cap = setTimeout(() => { finish(); }, 360);

    return () => clearTimeout(cap);
  }, [finish]);

  return (
    <Animated.View
      style={[s.container, { opacity: fadeOut }]}
      onLayout={onLayoutReady}
    >
      <Animated.View
        style={{
          opacity: logoOpacity,
          transform: [{ scale: logoScale }],
        }}
      >
        <Image
          source={require('../assets/icon.png')}
          style={s.logo}
          resizeMode="contain"
        />
        {/* Eyelids: two bars at eye height that "close" by scaleY 0→1.
            transformOrigin defaults to center, but for scaleY only the
            apparent close still reads as a blink at this tiny size. The
            colored matches the icon's eye-area tint so the closed lid
            blends with the face. */}
        <Animated.View
          pointerEvents="none"
          style={[
            s.eyelid,
            {
              top: LOGO_SIZE * EYE_TOP_FRAC,
              left: LOGO_SIZE / 2 - EYE_OFFSET_X - EYE_W / 2,
              transform: [{ scaleY: eyelid }],
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            s.eyelid,
            {
              top: LOGO_SIZE * EYE_TOP_FRAC,
              left: LOGO_SIZE / 2 + EYE_OFFSET_X - EYE_W / 2,
              transform: [{ scaleY: eyelid }],
            },
          ]}
        />
      </Animated.View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#FFFFFF',
    zIndex: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
    borderRadius: 28,
  },
  // Eyelid bars sit on top of the icon image. Tinted with the icon's
  // skin/face base color so the closed eye reads as part of the face
  // (matches Chatyy avatar). #161618 is the dark eye/lash area of the
  // current icon; tweak alongside the icon if the art changes.
  eyelid: {
    position: 'absolute',
    width: EYE_W,
    height: EYE_H,
    borderRadius: EYE_H / 2,
    backgroundColor: '#161618',
  },
});
