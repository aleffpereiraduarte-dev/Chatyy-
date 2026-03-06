import { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator,
  Animated, useWindowDimensions,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconSun, IconMoon, IconAlertTriangle,
  IconEye, IconEyeOff,
  IconMailLogo, IconShield,
} from '../components/Icons';
import { HelpModal, PrivacyModal, TermsModal } from '../components/LoginModals';

/* ─── Premium login — polished, animated, modern ─── */

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState('');
  const [step, setStep] = useState(1);
  const [showHelp, setShowHelp] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const { login } = useAuth();
  const { colors, isDark, toggle } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const params = useLocalSearchParams();
  const isAddAccount = params.add_account === '1';
  const { width } = useWindowDimensions();
  const mountedRef = useRef(true);
  const passwordRef = useRef(null);

  // Step transition + error shake
  const slideAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;

  // ── Premium entrance animated values ──
  const bgAnim = useRef(new Animated.Value(0)).current;
  const logoAnim = useRef(new Animated.Value(0)).current;
  const logoShimmer = useRef(new Animated.Value(0)).current;
  const brandAnim = useRef(new Animated.Value(0)).current;
  const titleAnim = useRef(new Animated.Value(0)).current;
  const subtitleAnim = useRef(new Animated.Value(0)).current;
  const formAnim = useRef(new Animated.Value(0)).current;
  const footerAnim = useRef(new Animated.Value(0)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  // Orbs: two axes each for organic Lissajous floating + breathing pulse
  const orb1A = useRef(new Animated.Value(0)).current;
  const orb1B = useRef(new Animated.Value(0)).current;
  const orb2A = useRef(new Animated.Value(0)).current;
  const orb2B = useRef(new Animated.Value(0)).current;
  const orb3A = useRef(new Animated.Value(0)).current;
  const orb3B = useRef(new Animated.Value(0)).current;
  const orbPulse1 = useRef(new Animated.Value(0)).current;
  const orbPulse2 = useRef(new Animated.Value(0)).current;
  const orbPulse3 = useRef(new Animated.Value(0)).current;

  // Responsive card padding
  const cardPadding = width < 380 ? 20 : width < 480 ? 28 : 40;

  useEffect(() => {
    mountedRef.current = true;

    // ── Orchestrated entrance (~1.3s total, overlapping phases) ──

    // Phase 1 (0ms): Background orbs softly fade in
    const bgIn = Animated.timing(bgAnim, {
      toValue: 1, duration: 600, useNativeDriver: Platform.OS !== 'web',
    });

    // Phase 2 (80ms): Logo scales from tiny (0.3x) + slight rotation with springy overshoot
    const logoIn = Animated.spring(logoAnim, {
      toValue: 1, tension: 55, friction: 6, useNativeDriver: Platform.OS !== 'web',
    });

    // Phase 3: Brief shimmer/pulse on logo after it lands
    const shimmer = Animated.sequence([
      Animated.timing(logoShimmer, { toValue: 1, duration: 250, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(logoShimmer, { toValue: 0, duration: 350, useNativeDriver: Platform.OS !== 'web' }),
    ]);

    // Phase 4+: Brand text, title, subtitle, form card, footer cascade
    const brandIn = Animated.spring(brandAnim, {
      toValue: 1, tension: 65, friction: 10, useNativeDriver: Platform.OS !== 'web',
    });
    const titleIn = Animated.spring(titleAnim, {
      toValue: 1, tension: 60, friction: 9, useNativeDriver: Platform.OS !== 'web',
    });
    const subtitleIn = Animated.spring(subtitleAnim, {
      toValue: 1, tension: 55, friction: 10, useNativeDriver: Platform.OS !== 'web',
    });
    const formIn = Animated.spring(formAnim, {
      toValue: 1, tension: 50, friction: 10, useNativeDriver: Platform.OS !== 'web',
    });
    const footerIn = Animated.timing(footerAnim, {
      toValue: 1, duration: 450, useNativeDriver: Platform.OS !== 'web',
    });

    // BG starts immediately; logo at 80ms; after logo spring settles:
    // shimmer + cascade everything else in parallel with staggered delays
    const entrance = Animated.parallel([
      bgIn,
      Animated.sequence([
        Animated.delay(80),
        logoIn,
        Animated.parallel([
          shimmer,
          Animated.sequence([Animated.delay(50), brandIn]),
          Animated.sequence([Animated.delay(120), titleIn]),
          Animated.sequence([Animated.delay(200), subtitleIn]),
          Animated.sequence([Animated.delay(300), formIn]),
          Animated.sequence([Animated.delay(420), footerIn]),
        ]),
      ]),
    ]);
    entrance.start();

    // ── Continuous glow breathing ──
    const glowLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 3000, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(glowAnim, { toValue: 0, duration: 3000, useNativeDriver: Platform.OS !== 'web' }),
      ])
    );
    glowLoop.start();

    // ── Organic orb floating: offset sine waves per axis for figure-8 paths ──
    const orbLoops = [];
    const floatOrb = (animA, animB, dA, dB) => {
      const lA = Animated.loop(Animated.sequence([
        Animated.timing(animA, { toValue: 1, duration: dA, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(animA, { toValue: 0, duration: dA, useNativeDriver: Platform.OS !== 'web' }),
      ]));
      const lB = Animated.loop(Animated.sequence([
        Animated.timing(animB, { toValue: 1, duration: dB, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(animB, { toValue: 0, duration: dB, useNativeDriver: Platform.OS !== 'web' }),
      ]));
      lA.start(); lB.start();
      orbLoops.push(lA, lB);
    };
    floatOrb(orb1A, orb1B, 6000, 8000);
    floatOrb(orb2A, orb2B, 7500, 5500);
    floatOrb(orb3A, orb3B, 9000, 6500);

    // ── Orb breathing: opacity pulsing at different rates ──
    const pulseOrb = (anim, dur) => {
      const l = Animated.loop(Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: dur, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(anim, { toValue: 0, duration: dur, useNativeDriver: Platform.OS !== 'web' }),
      ]));
      l.start(); orbLoops.push(l);
    };
    pulseOrb(orbPulse1, 4000);
    pulseOrb(orbPulse2, 5000);
    pulseOrb(orbPulse3, 4500);

    return () => {
      mountedRef.current = false;
      entrance.stop();
      glowLoop.stop();
      orbLoops.forEach(l => l.stop());
    };
  }, []);

  const animateStep = (next) => {
    const out = next === 2 ? -30 : 30;
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(slideAnim, { toValue: out, duration: 120, useNativeDriver: Platform.OS !== 'web' }),
    ]).start(() => {
      setStep(next);
      if (next === 1) setError('');
      slideAnim.setValue(-out);
      Animated.parallel([
        Animated.spring(fadeAnim, { toValue: 1, tension: 80, friction: 10, useNativeDriver: Platform.OS !== 'web' }),
        Animated.spring(slideAnim, { toValue: 0, tension: 80, friction: 10, useNativeDriver: Platform.OS !== 'web' }),
      ]).start(() => {
        if (next === 2) passwordRef.current?.focus();
      });
    });
  };

  const shake = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 40, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 40, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(shakeAnim, { toValue: 6, duration: 40, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(shakeAnim, { toValue: -6, duration: 40, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: Platform.OS !== 'web' }),
    ]).start();
  };

  const handleContinue = () => {
    const trimmed = email.trim();
    if (!trimmed) { setError(t('login.errorEmail')); shake(); return; }
    if (trimmed.includes('@') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError(t('login.errorEmail')); shake(); return;
    }
    setError('');
    animateStep(2);
  };

  const handleLogin = async () => {
    if (!password) { setError(t('login.errorPassword')); shake(); return; }
    setError('');
    setLoading(true);
    try {
      const fullEmail = email.includes('@') ? email : `${email}@onemundo.com.br`;
      const r = await login(fullEmail, password);
      if (!mountedRef.current) return;
      if (r.success) {
        router.replace('/inbox');
      } else {
        setError(r.message || t('login.errorCredentials'));
        shake();
      }
    } catch {
      if (!mountedRef.current) return;
      setError(t('login.errorConnection'));
      shake();
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  // ── Logo interpolations: scale from 0.3 with slight rotation + shimmer pulse ──
  const logoScale = logoAnim.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] });
  const logoRotate = logoAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: ['-12deg', '3deg', '0deg'] });
  const shimmerScale = logoShimmer.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  const shimmerGlow = logoShimmer.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.3, 1, 0.3] });

  // ── Brand text slide-up ──
  const brandTranslateY = brandAnim.interpolate({ inputRange: [0, 1], outputRange: [14, 0] });

  // ── Title / subtitle smooth slide-up ──
  const titleTranslateY = titleAnim.interpolate({ inputRange: [0, 1], outputRange: [28, 0] });
  const subtitleTranslateY = subtitleAnim.interpolate({ inputRange: [0, 1], outputRange: [22, 0] });

  // ── Form card slides up with subtle scale ──
  const formTranslateY = formAnim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] });
  const formScaleVal = formAnim.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] });

  // ── Footer slide-up ──
  const footerTranslateY = footerAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] });

  // ── Glow breathing ──
  const glowOpacity = glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.85] });
  const glowScale = glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.12] });

  // ── Orb Lissajous paths: organic figure-8 floating ──
  const orb1Y = orb1A.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, -28, 0] });
  const orb1X = orb1B.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 22, 0] });
  const orb2Y = orb2A.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 24, 0] });
  const orb2X = orb2B.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, -18, 0] });
  const orb3Y = orb3A.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, -22, 0] });
  const orb3X = orb3B.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 14, 0] });
  const orb3ScaleVal = orb3A.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.15, 1] });

  // ── Orb breathing opacity ──
  const orbOp1 = orbPulse1.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });
  const orbOp2 = orbPulse2.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0.95] });
  const orbOp3 = orbPulse3.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });

  const displayEmail = email.includes('@') ? email : (email ? `${email}@onemundo.com.br` : '');

  return (
    <View style={[s.root, { backgroundColor: colors.authBg }]}>
      {/* Animated floating background orbs with breathing */}
      <Animated.View style={[s.bgDecor, { opacity: bgAnim }]} pointerEvents="none">
        <Animated.View style={[s.bgCircle1, {
          backgroundColor: colors.primary + '0a',
          opacity: orbOp1,
          transform: [{ translateY: orb1Y }, { translateX: orb1X }],
        }]} />
        <Animated.View style={[s.bgCircle2, {
          backgroundColor: colors.primary + '08',
          opacity: orbOp2,
          transform: [{ translateY: orb2Y }, { translateX: orb2X }],
        }]} />
        <Animated.View style={[s.bgCircle3, {
          backgroundColor: (colors.authSuccessGreen || '#10b981') + '08',
          opacity: orbOp3,
          transform: [{ translateY: orb3Y }, { translateX: orb3X }, { scale: orb3ScaleVal }],
        }]} />
      </Animated.View>

      {/* Cancel button for add_account mode */}
      {isAddAccount && (
        <TouchableOpacity
          onPress={() => router.back()}
          style={{ position: 'absolute', top: Platform.OS === 'ios' ? 54 : 16, left: 16, zIndex: 10 }}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('account.cancel')}
        >
          <View style={[s.themeBtn, {
            backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#ffffff',
            borderColor: colors.authInputBorder,
            paddingHorizontal: 12, width: 'auto', borderRadius: 20,
          }]}>
            <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '600' }}>{t('account.cancel')}</Text>
          </View>
        </TouchableOpacity>
      )}

      {/* Theme toggle */}
      <TouchableOpacity
        onPress={toggle}
        style={s.themeToggle}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        <View style={[s.themeBtn, {
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#ffffff',
          borderColor: colors.authInputBorder,
          ...(Platform.OS === 'web' ? {
            boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
          } : {
            shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.06, shadowRadius: 3, elevation: 2,
          }),
        }]}>
          {isDark ? <IconSun size={16} color="#fbbf24" /> : <IconMoon size={16} color={colors.textSecondary} />}
        </View>
      </TouchableOpacity>

      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          <View style={s.center}>
            {/* Card wrapper: form slides up with subtle scale */}
            <Animated.View style={[s.cardWrap, {
              opacity: formAnim,
              transform: [{ translateY: formTranslateY }, { scale: formScaleVal }],
            }]}>

              {/* ── Card ── */}
              <View style={[s.card, {
                backgroundColor: colors.authCardBg,
                paddingHorizontal: cardPadding,
                ...(Platform.OS === 'web' ? {
                  boxShadow: isDark
                    ? '0 2px 8px rgba(0,0,0,0.35), 0 8px 32px rgba(0,0,0,0.2)'
                    : '0 1px 3px rgba(0,0,0,0.04), 0 4px 24px rgba(0,0,0,0.08)',
                } : {
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: isDark ? 0.3 : 0.12,
                  shadowRadius: 24,
                  elevation: 8,
                }),
                borderColor: isDark ? colors.authCardBorder : 'transparent',
                borderWidth: isDark ? 1 : 0,
              }]}>
                <Animated.View style={{
                  opacity: fadeAnim,
                  transform: [{ translateX: slideAnim }, { translateX: shakeAnim }],
                }}>

                  {/* Logo — magical entrance: scale from tiny + rotate + shimmer */}
                  <View style={s.logoRow}>
                    <Animated.View style={{
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: 10,
                      opacity: logoAnim,
                      transform: [
                        { scale: logoScale },
                        { rotate: logoRotate },
                      ],
                    }}>
                      <View style={s.logoWrap}>
                        {/* Breathing glow ring */}
                        <Animated.View style={[s.logoGlow, {
                          backgroundColor: colors.primary + '0a',
                          opacity: glowOpacity,
                          transform: [{ scale: glowScale }],
                        }]} />
                        {/* Shimmer pulse overlay */}
                        <Animated.View style={[s.logoGlow, {
                          backgroundColor: colors.primary + '12',
                          opacity: shimmerGlow,
                          transform: [{ scale: shimmerScale }],
                        }]} />
                        <View style={[s.logoCircle, {
                          backgroundColor: isDark ? colors.primary + '15' : '#ffffff',
                          ...(Platform.OS === 'web' ? {
                            boxShadow: isDark
                              ? `0 0 20px ${colors.primary}20, 0 2px 8px rgba(0,0,0,0.2)`
                              : `0 2px 12px ${colors.primary}15, 0 1px 3px rgba(0,0,0,0.06)`,
                          } : {
                            shadowColor: colors.primary,
                            shadowOffset: { width: 0, height: 2 },
                            shadowOpacity: 0.15,
                            shadowRadius: 12,
                            elevation: 4,
                          }),
                        }]}>
                          <IconMailLogo size={32} color={colors.primary} />
                        </View>
                      </View>
                    </Animated.View>
                    {/* Brand text — separate fade-up after logo */}
                    <Animated.Text style={[s.brand, {
                      color: colors.primary,
                      opacity: brandAnim,
                      transform: [{ translateY: brandTranslateY }],
                    }]}>OneMundo Mail</Animated.Text>
                  </View>

                  {step === 1 ? (
                    <>
                      {/* Title — smooth slide-up */}
                      <Animated.Text style={[s.title, {
                        color: colors.text,
                        opacity: titleAnim,
                        transform: [{ translateY: titleTranslateY }],
                      }]}>{t('login.title')}</Animated.Text>
                      {/* Subtitle — cascading slide-up */}
                      <Animated.Text style={[s.subtitle, {
                        color: colors.textSecondary,
                        opacity: subtitleAnim,
                        transform: [{ translateY: subtitleTranslateY }],
                      }]}>
                        {t('login.subtitle')}
                      </Animated.Text>

                      {!!error && (
                        <View style={[s.errorBox, { backgroundColor: colors.errorBg, borderColor: colors.error + '20' }]}>
                          <IconAlertTriangle size={14} color={colors.error} />
                          <Text style={[s.errorText, { color: colors.error }]}>{error}</Text>
                        </View>
                      )}

                      {/* Email input */}
                      <View style={[
                        s.inputBox,
                        { borderColor: focused === 'email' ? colors.authInputFocusBorder : colors.authInputBorder },
                        focused === 'email' && [s.inputFocused, Platform.OS === 'web' && {
                          boxShadow: `0 0 0 3px ${colors.authInputFocusGlow}`,
                        }],
                      ]}>
                        <Text style={[
                          s.floatingLabel,
                          { backgroundColor: colors.authCardBg },
                          focused === 'email' || email
                            ? [s.floatingLabelUp, { color: focused === 'email' ? colors.authInputFocusBorder : colors.authLabelColor }]
                            : { color: 'transparent' },
                        ]}>
                          {t('login.emailPlaceholder')}
                        </Text>
                        <TextInput
                          style={[s.textInput, { color: colors.text }]}
                          value={email}
                          onChangeText={(text) => { setEmail(text); if (error) setError(''); }}
                          autoCapitalize="none"
                          keyboardType="email-address"
                          autoComplete="email"
                          returnKeyType="next"
                          placeholder={focused === 'email' ? '' : t('login.emailPlaceholder')}
                          placeholderTextColor={colors.textTertiary}
                          onFocus={() => setFocused('email')}
                          onBlur={() => setFocused('')}
                          onSubmitEditing={handleContinue}
                          accessibilityLabel={t('login.emailPlaceholder')}
                        />
                      </View>

                      {/* Domain hint */}
                      {!email.includes('@') && email.length > 0 && (
                        <Text style={[s.domainHint, { color: colors.textSecondary }]}>
                          {t('login.fullEmail')} <Text style={{ fontWeight: '600', color: colors.primary }}>{email}@onemundo.com.br</Text>
                        </Text>
                      )}
                      {!email && (
                        <Text style={[s.domainHint, { color: colors.textTertiary }]}>
                          {t('login.domainHint')}
                        </Text>
                      )}

                      <TouchableOpacity
                        style={s.forgotLink}
                        activeOpacity={0.6}
                        onPress={() => setShowHelp(true)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Text style={[s.forgotText, { color: colors.primary }]}>{t('login.forgotEmail')}</Text>
                      </TouchableOpacity>

                      {/* Smart info section */}
                      <View style={[s.infoBox, {
                        backgroundColor: isDark ? colors.authChipBg : '#f0f7ff',
                        borderColor: isDark ? colors.authChipBorder : colors.primary + '15',
                      }]}>
                        <View style={[s.infoIconWrap, { backgroundColor: colors.primary + '12' }]}>
                          <IconShield size={14} color={colors.primary} />
                        </View>
                        <Text style={[s.infoText, { color: colors.textSecondary }]}>
                          {t('login.security')}
                        </Text>
                      </View>

                      {/* Buttons */}
                      <View style={s.btnRow}>
                        <TouchableOpacity
                          onPress={() => router.push('/signup/step-name')}
                          activeOpacity={0.7}
                          style={s.textBtn}
                          accessibilityRole="button"
                        >
                          <Text style={[s.textBtnLabel, { color: colors.primary }]}>{t('login.createAccount')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[s.primaryBtn, {
                            backgroundColor: colors.primary,
                            ...(Platform.OS === 'web' ? {
                              boxShadow: `0 1px 3px ${colors.primary}30, 0 4px 12px ${colors.primary}20`,
                            } : {
                              shadowColor: colors.primary,
                              shadowOffset: { width: 0, height: 2 },
                              shadowOpacity: 0.3,
                              shadowRadius: 8,
                              elevation: 4,
                            }),
                          }]}
                          onPress={handleContinue}
                          activeOpacity={0.85}
                          accessibilityRole="button"
                        >
                          <Text style={s.primaryBtnText}>{t('login.next')}</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  ) : (
                    <>
                      <Text style={[s.title, { color: colors.text }]}>{t('login.welcome')}</Text>

                      {/* User chip */}
                      <TouchableOpacity
                        style={[s.userChip, {
                          borderColor: colors.authInputBorder,
                          backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'transparent',
                        }]}
                        onPress={() => animateStep(1)}
                        activeOpacity={0.7}
                      >
                        <View style={[s.userAvatar, { backgroundColor: colors.primary }]}>
                          <Text style={s.userAvatarLetter}>{(email || '?')[0].toUpperCase()}</Text>
                        </View>
                        <Text style={[s.userEmail, { color: colors.text }]} numberOfLines={1}>
                          {displayEmail}
                        </Text>
                        <Text style={[s.chipArrow, { color: colors.textSecondary }]}>{'\u25BE'}</Text>
                      </TouchableOpacity>

                      {!!error && (
                        <View style={[s.errorBox, { backgroundColor: colors.errorBg, borderColor: colors.error + '20' }]}>
                          <IconAlertTriangle size={14} color={colors.error} />
                          <Text style={[s.errorText, { color: colors.error }]}>{error}</Text>
                        </View>
                      )}

                      {/* Password input */}
                      <View style={[
                        s.inputBox,
                        { borderColor: focused === 'pass' ? colors.authInputFocusBorder : colors.authInputBorder },
                        focused === 'pass' && [s.inputFocused, Platform.OS === 'web' && {
                          boxShadow: `0 0 0 3px ${colors.authInputFocusGlow}`,
                        }],
                      ]}>
                        <Text style={[
                          s.floatingLabel,
                          { backgroundColor: colors.authCardBg },
                          focused === 'pass' || password
                            ? [s.floatingLabelUp, { color: focused === 'pass' ? colors.authInputFocusBorder : colors.authLabelColor }]
                            : { color: 'transparent' },
                        ]}>
                          {t('login.passwordPlaceholder')}
                        </Text>
                        <TextInput
                          ref={passwordRef}
                          style={[s.textInput, { color: colors.text, paddingRight: 48 }]}
                          value={password}
                          onChangeText={(text) => { setPassword(text); if (error) setError(''); }}
                          secureTextEntry={!showPassword}
                          returnKeyType="go"
                          placeholder={focused === 'pass' ? '' : t('login.passwordInput')}
                          placeholderTextColor={colors.textTertiary}
                          onFocus={() => setFocused('pass')}
                          onBlur={() => setFocused('')}
                          onSubmitEditing={handleLogin}
                          accessibilityLabel={t('login.passwordPlaceholder')}
                        />
                        <TouchableOpacity
                          onPress={() => setShowPassword(!showPassword)}
                          style={s.eyeBtn}
                          activeOpacity={0.6}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          accessibilityRole="button"
                          accessibilityLabel={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                        >
                          {showPassword
                            ? <IconEyeOff size={20} color={colors.textSecondary} />
                            : <IconEye size={20} color={colors.textSecondary} />}
                        </TouchableOpacity>
                      </View>

                      {/* Show password checkbox */}
                      <TouchableOpacity
                        style={s.showPassRow}
                        onPress={() => setShowPassword(!showPassword)}
                        activeOpacity={0.7}
                      >
                        <View style={[s.checkbox, {
                          borderColor: showPassword ? colors.primary : colors.authInputBorder,
                          backgroundColor: showPassword ? colors.primary : 'transparent',
                        }]}>
                          {showPassword && <Text style={s.checkmark}>{'\u2713'}</Text>}
                        </View>
                        <Text style={[s.showPassText, { color: colors.text }]}>{t('login.showPassword')}</Text>
                      </TouchableOpacity>

                      <TouchableOpacity style={s.forgotLink} activeOpacity={0.6} onPress={() => router.push('/forgot')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Text style={[s.forgotText, { color: colors.primary }]}>{t('login.forgotPassword')}</Text>
                      </TouchableOpacity>

                      {/* Buttons */}
                      <View style={s.btnRow}>
                        <TouchableOpacity onPress={() => animateStep(1)} style={s.textBtn} activeOpacity={0.6} accessibilityRole="button">
                          <Text style={[s.textBtnLabel, { color: colors.primary }]}>{t('login.back')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[s.primaryBtn, {
                            backgroundColor: colors.primary,
                            ...(Platform.OS === 'web' ? {
                              boxShadow: `0 1px 3px ${colors.primary}30, 0 4px 12px ${colors.primary}20`,
                            } : {
                              shadowColor: colors.primary,
                              shadowOffset: { width: 0, height: 2 },
                              shadowOpacity: 0.3,
                              shadowRadius: 8,
                              elevation: 4,
                            }),
                          }, loading && { opacity: 0.65 }]}
                          onPress={handleLogin}
                          disabled={loading}
                          activeOpacity={0.85}
                          accessibilityRole="button"
                        >
                          {loading ? (
                            <ActivityIndicator color="#fff" size="small" />
                          ) : (
                            <Text style={s.primaryBtnText}>{t('login.enter')}</Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </Animated.View>
              </View>

              {/* Footer */}
              <Animated.View style={[s.footer, {
                opacity: footerAnim,
                transform: [{ translateY: footerTranslateY }],
              }]}>
                <Text style={[s.footerItem, { color: colors.authFooterText }]}>{t('login.footerLanguage')}</Text>
                <View style={s.footerLinks}>
                  <TouchableOpacity activeOpacity={0.6} onPress={() => setShowHelp(true)} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}>
                    <Text style={[s.footerItem, s.footerLink, { color: colors.authFooterText }]}>{t('login.help')}</Text>
                  </TouchableOpacity>
                  <Text style={[s.footerDot, { color: colors.authFooterText }]}> {'\u00B7'} </Text>
                  <TouchableOpacity activeOpacity={0.6} onPress={() => setShowPrivacy(true)} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}>
                    <Text style={[s.footerItem, s.footerLink, { color: colors.authFooterText }]}>{t('login.privacy')}</Text>
                  </TouchableOpacity>
                  <Text style={[s.footerDot, { color: colors.authFooterText }]}> {'\u00B7'} </Text>
                  <TouchableOpacity activeOpacity={0.6} onPress={() => setShowTerms(true)} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}>
                    <Text style={[s.footerItem, s.footerLink, { color: colors.authFooterText }]}>{t('login.terms')}</Text>
                  </TouchableOpacity>
                </View>
              </Animated.View>
            </Animated.View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <HelpModal visible={showHelp} onClose={() => setShowHelp(false)} />
      <PrivacyModal visible={showPrivacy} onClose={() => setShowPrivacy(false)} />
      <TermsModal visible={showTerms} onClose={() => setShowTerms(false)} />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, overflow: 'hidden' },
  flex: { flex: 1 },
  scroll: { flexGrow: 1 },

  /* Decorative background */
  bgDecor: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 0,
    overflow: 'hidden',
  },
  bgCircle1: {
    position: 'absolute', width: 400, height: 400, borderRadius: 200,
    top: -120, right: -100,
  },
  bgCircle2: {
    position: 'absolute', width: 300, height: 300, borderRadius: 150,
    bottom: -60, left: -80,
  },
  bgCircle3: {
    position: 'absolute', width: 200, height: 200, borderRadius: 100,
    top: '40%', left: '60%',
  },

  /* Theme toggle */
  themeToggle: { position: 'absolute', top: Platform.OS === 'ios' ? 54 : 16, right: 16, zIndex: 10 },
  themeBtn: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.2s ease' }, default: {} }),
  },

  /* Centered layout */
  center: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 48, minHeight: '100%',
    zIndex: 1,
  },
  cardWrap: { width: '100%', maxWidth: 448 },

  /* Card */
  card: {
    borderRadius: 24, paddingTop: 44, paddingBottom: 36,
    width: '100%',
  },

  /* Logo with glow */
  logoRow: { alignItems: 'center', marginBottom: 24 },
  logoWrap: { alignItems: 'center', justifyContent: 'center' },
  logoGlow: {
    position: 'absolute', width: 88, height: 88, borderRadius: 44,
  },
  logoCircle: {
    width: 64, height: 64, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  brand: {
    fontSize: 15, fontWeight: '700', letterSpacing: 0.5,
  },

  title: { fontSize: 24, fontWeight: '400', textAlign: 'center', marginBottom: 2, letterSpacing: -0.2 },
  subtitle: { fontSize: 15, textAlign: 'center', marginBottom: 32, lineHeight: 22 },

  /* Error */
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 12, borderRadius: 12, marginBottom: 16, borderWidth: 1,
  },
  errorText: { fontSize: 13, flex: 1, fontWeight: '500' },

  /* Input */
  inputBox: {
    position: 'relative',
    borderWidth: 1, borderRadius: 12,
    ...Platform.select({ web: { transition: 'all 0.2s ease' }, default: {} }),
  },
  inputFocused: {
    borderWidth: 2,
    margin: -1,
  },
  floatingLabel: {
    position: 'absolute', top: -9, left: 12,
    fontSize: 12, paddingHorizontal: 4, lineHeight: 16,
    ...Platform.select({ web: { transition: 'all 0.15s ease', pointerEvents: 'none' }, default: {} }),
  },
  floatingLabelUp: {
    top: -9, fontSize: 12, fontWeight: '500',
  },
  textInput: {
    fontSize: 16,
    paddingVertical: Platform.OS === 'web' ? 16 : 14,
    paddingHorizontal: 16,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  eyeBtn: {
    position: 'absolute', right: 8, top: 0, bottom: 0,
    justifyContent: 'center', padding: 8,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },

  /* Domain hint */
  domainHint: { fontSize: 13, marginTop: 8, marginBottom: 2, marginLeft: 2, lineHeight: 18 },

  /* User chip */
  userChip: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'center',
    borderRadius: 50, paddingVertical: 4, paddingLeft: 4, paddingRight: 16,
    borderWidth: 1, marginTop: 12, marginBottom: 24,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.15s ease' }, default: {} }),
  },
  userAvatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  userAvatarLetter: { color: '#fff', fontSize: 12, fontWeight: '700' },
  userEmail: { fontSize: 14, fontWeight: '500', flexShrink: 1 },
  chipArrow: { marginLeft: 6, fontSize: 12 },

  /* Show password */
  showPassRow: {
    flexDirection: 'row', alignItems: 'center', marginTop: 14, gap: 12,
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  checkbox: {
    width: 18, height: 18, borderWidth: 2, borderRadius: 4,
    alignItems: 'center', justifyContent: 'center',
    ...Platform.select({ web: { transition: 'all 0.15s ease' }, default: {} }),
  },
  checkmark: { color: '#fff', fontSize: 11, fontWeight: '700', marginTop: -1 },
  showPassText: { fontSize: 14 },

  /* Links */
  forgotLink: { alignSelf: 'flex-start', marginTop: 14, marginBottom: 24 },
  forgotText: { fontSize: 14, fontWeight: '600' },

  /* Info box */
  infoBox: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, padding: 12, marginBottom: 28, borderWidth: 1,
  },
  infoIconWrap: {
    width: 28, height: 28, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  infoText: { fontSize: 12, flex: 1 },

  /* Buttons */
  btnRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    flexWrap: 'wrap', gap: 8,
  },
  textBtn: {
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'background 0.15s ease' }, default: {} }),
  },
  textBtnLabel: { fontSize: 14, fontWeight: '600' },
  primaryBtn: {
    borderRadius: 50, paddingVertical: 11, paddingHorizontal: 28,
    alignItems: 'center', justifyContent: 'center', minWidth: 100,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.2s ease' }, default: {} }),
  },
  primaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '600', letterSpacing: 0.2 },

  /* Footer */
  footer: {
    flexDirection: 'column', alignItems: 'center',
    marginTop: 24, paddingHorizontal: 8, gap: 6,
  },
  footerLinks: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' },
  footerItem: { fontSize: 12 },
  footerLink: Platform.OS === 'web' ? { cursor: 'pointer', textDecorationLine: 'underline' } : { textDecorationLine: 'underline' },
  footerDot: { fontSize: 12 },
});
