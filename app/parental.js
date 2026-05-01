import { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, FlatList, Alert, ActivityIndicator, TextInput, ScrollView, Image, Animated, Easing, KeyboardAvoidingView, Modal, Vibration, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconPlus, IconUser, IconShield, IconChevronRight, IconMessageSquare, IconCamera, IconCheck, IconX, IconAlertCircle, IconFileText, IconBarChart, IconClock, IconLock, IconPhone, IconEye, IconCopy, IconImage, IconHome, IconStar, IconSmartphone, IconSparkles, IconAlertTriangle, IconMoon, IconUsers, IconSearch, IconHeart, IconSmile } from '../components/Icons';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
import * as ImagePicker from 'expo-image-picker';
import SmartDateInput from '../components/SmartDateInput';

const ACCENT = '#7C3AED';
const STEPS = ['info', 'document', 'verifying', 'credentials'];

// Step gradient configs
const STEP_GRADIENTS = {
  0: { web: 'linear-gradient(145deg, #4F46E5 0%, #7C3AED 40%, #A78BFA 100%)', native: '#7C3AED' },
  1: { web: 'linear-gradient(145deg, #059669 0%, #10B981 40%, #34D399 100%)', native: '#10B981' },
  2: { web: 'linear-gradient(145deg, #7C3AED 0%, #9333EA 40%, #C084FC 100%)', native: '#9333EA' },
  3: { web: 'linear-gradient(145deg, #D97706 0%, #F59E0B 40%, #FBBF24 100%)', native: '#F59E0B' },
};

// Age-appropriate icon
const AGE_ICON = (age) => {
  if (age <= 7) return <IconUser size={16} color="#EC4899" />;
  if (age <= 9) return <IconUser size={16} color="#3B82F6" />;
  if (age <= 11) return <IconStar size={16} color="#F59E0B" />;
  return <IconStar size={16} color="#8b5cf6" />;
};

// Mascot frames for animation (icon components)
const MASCOT_FRAMES_ICONS = ['shield', 'user', 'star', 'heart', 'sparkles', 'smile'];

// Safety facts for verification wait
const SAFETY_FACTS_KEYS = [
  'parental.safetyFact1',
  'parental.safetyFact2',
  'parental.safetyFact3',
  'parental.safetyFact4',
  'parental.safetyFact5',
];

// Verification stages
const VERIFY_STAGE_KEYS = [
  'parental.verifyUploading',
  'parental.verifyAnalyzing',
  'parental.verifyChecking',
  'parental.verifyAlmostDone',
];

// Username suggestions from name
const suggestUsername = (name) => {
  if (!name || name.trim().length < 2) return [];
  const clean = name.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '');
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  const suggestions = [];
  if (parts.length >= 2) {
    suggestions.push(parts[0] + '.' + parts[parts.length - 1]);
    suggestions.push(parts[0] + parts[parts.length - 1].charAt(0));
    suggestions.push(parts[0] + '_' + parts[parts.length - 1]);
  }
  suggestions.push(parts[0] + Math.floor(Math.random() * 100));
  return suggestions.slice(0, 3);
};

// Age-based preset restrictions
const getAgePresets = (age) => {
  if (age <= 7) return { screenTime: 60, bedtimeStart: '19:30', bedtimeEnd: '07:00', safeSearch: true, contactApproval: true, canSendEmail: false, canDeleteMessages: false };
  if (age <= 9) return { screenTime: 90, bedtimeStart: '20:00', bedtimeEnd: '07:00', safeSearch: true, contactApproval: true, canSendEmail: true, canDeleteMessages: false };
  if (age <= 11) return { screenTime: 120, bedtimeStart: '21:00', bedtimeEnd: '06:30', safeSearch: true, contactApproval: false, canSendEmail: true, canDeleteMessages: true };
  return { screenTime: 180, bedtimeStart: '22:00', bedtimeEnd: '06:00', safeSearch: false, contactApproval: false, canSendEmail: true, canDeleteMessages: true };
};

export default function ParentalScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();
  const [children, setChildren] = useState([]);
  const [loading, setLoading] = useState(true);

  // AI Summary modal state
  const [summaryModal, setSummaryModal] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryData, setSummaryData] = useState(null);
  const [summaryChild, setSummaryChild] = useState(null);

  // Wizard state
  const [showWizard, setShowWizard] = useState(false);
  const [step, setStep] = useState(0);
  const [childName, setChildName] = useState('');
  const [childBirthday, setChildBirthday] = useState('');
  const [childGender, setChildGender] = useState('');
  const [relationship, setRelationship] = useState('');
  const [verifyMethod, setVerifyMethod] = useState(null); // 'document', 'phone', 'card'
  const [docImage, setDocImage] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newChild, setNewChild] = useState(null);
  const [docVerdict, setDocVerdict] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [verifyStage, setVerifyStage] = useState(0);
  const [safetyFactIdx, setSafetyFactIdx] = useState(0);
  const [showConfetti, setShowConfetti] = useState(false);
  const [quickSetup, setQuickSetup] = useState({ bedtime: false, contacts: false, screenTime: false, safeSearch: false, filterAdult: false, filterViolence: false, filterProfanity: false });
  const [suggestedUser, setSuggestedUser] = useState('');

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const bounceAnim = useRef(new Animated.Value(1)).current;
  const mascotAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const confettiAnims = useRef(Array.from({ length: 20 }, () => ({
    x: new Animated.Value(0),
    y: new Animated.Value(0),
    opacity: new Animated.Value(0),
    rotate: new Animated.Value(0),
  }))).current;

  const isMountedRef = useRef(true);
  const nameInputRef = useRef(null);
  const mascotFrameRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Animate step transitions
  useEffect(() => {
    fadeAnim.setValue(0);
    slideAnim.setValue(30);
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
      Animated.timing(slideAnim, { toValue: 0, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
    ]).start();

    // Progress bar animation
    Animated.timing(progressAnim, {
      toValue: (step + 1) / 4,
      duration: 600,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [step]);

  // Mascot bob animation (step 0)
  useEffect(() => {
    if (step === 0 && showWizard) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(mascotAnim, { toValue: -8, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
          Animated.timing(mascotAnim, { toValue: 0, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
  }, [step, showWizard]);

  // Shield pulse animation (step 1)
  useEffect(() => {
    if (step === 1 && showWizard) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.15, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
  }, [step, showWizard]);

  // Verification stage progression (step 2)
  useEffect(() => {
    if (step === 2) {
      setVerifyStage(0);
      setSafetyFactIdx(0);
      const stageInterval = setInterval(() => {
        if (!isMountedRef.current) return;
        setVerifyStage(prev => Math.min(prev + 1, 3));
      }, 2500);
      const factInterval = setInterval(() => {
        if (!isMountedRef.current) return;
        setSafetyFactIdx(prev => (prev + 1) % SAFETY_FACTS_KEYS.length);
      }, 4000);
      return () => { clearInterval(stageInterval); clearInterval(factInterval); };
    }
  }, [step]);

  // Confetti explosion (step 3)
  useEffect(() => {
    if (step === 3 && showWizard) {
      setShowConfetti(true);
      if (Platform.OS !== 'web') {
        try { Vibration.vibrate(100); } catch {}
      }
      const screenW = Dimensions.get('window').width;
      const animations = confettiAnims.map((anim, i) => {
        const startX = screenW / 2;
        const endX = (Math.random() - 0.5) * screenW * 1.5;
        const endY = -(Math.random() * 400 + 200);
        anim.x.setValue(0);
        anim.y.setValue(0);
        anim.opacity.setValue(1);
        anim.rotate.setValue(0);
        return Animated.parallel([
          Animated.timing(anim.x, { toValue: endX, duration: 1800 + Math.random() * 800, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
          Animated.sequence([
            Animated.timing(anim.y, { toValue: endY, duration: 800, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
            Animated.timing(anim.y, { toValue: 600, duration: 1200, easing: Easing.in(Easing.quad), useNativeDriver: false }),
          ]),
          Animated.timing(anim.opacity, { toValue: 0, duration: 2200, useNativeDriver: false }),
          Animated.timing(anim.rotate, { toValue: Math.random() * 10, duration: 2200, useNativeDriver: false }),
        ]);
      });
      Animated.stagger(60, animations).start(() => setShowConfetti(false));
    }
  }, [step, showWizard]);

  // Auto-suggest username when name changes
  useEffect(() => {
    const suggestions = suggestUsername(childName);
    if (suggestions.length > 0) setSuggestedUser(suggestions[0]);
  }, [childName]);

  // Bounce animation for Next button
  const triggerBounce = useCallback(() => {
    Animated.sequence([
      Animated.timing(bounceAnim, { toValue: 0.92, duration: 100, useNativeDriver: false }),
      Animated.spring(bounceAnim, { toValue: 1, friction: 3, tension: 200, useNativeDriver: false }),
    ]).start();
  }, []);

  const loadChildren = useCallback(async () => {
    // Show cached data INSTANTLY (no loading spinner)
    try {
      const c = await getCached('parental_children');
      if (c?.length) { setChildren(c); setLoading(false); }
    } catch {}
    // Refresh from API in background (don't block UI)
    api.parentalListChildren().then(r => {
      if (r.success && isMountedRef.current) {
        setChildren(r.data?.children || []);
        setCache('parental_children', r.data?.children || [], 2592000000).catch(() => {});
      }
    }).catch(() => {}).finally(() => { if (isMountedRef.current) setLoading(false); });
  }, []);

  useEffect(() => { loadChildren(); }, [loadChildren]);

  const relationships = [
    { key: 'mae', label: t('parental.relMom'), emoji: <IconUser size={24} color="#EC4899" />, color: '#EC4899' },
    { key: 'pai', label: t('parental.relDad'), emoji: <IconUser size={24} color="#3B82F6" />, color: '#3B82F6' },
    { key: 'tutor', label: t('parental.relGuardian'), emoji: <IconHome size={24} color="#8B5CF6" />, color: '#8B5CF6' },
  ];

  const genders = [
    { key: 'male', label: t('parental.genderBoy'), emoji: <IconUser size={24} color="#3B82F6" />, color: '#3B82F6' },
    { key: 'female', label: t('parental.genderGirl'), emoji: <IconUser size={24} color="#EC4899" />, color: '#EC4899' },
    { key: 'other', label: t('parental.genderOther'), emoji: <IconStar size={24} color="#F59E0B" />, color: '#F59E0B' },
  ];

  // Calculate age from birthday
  const getAge = (birthday) => {
    if (!birthday) return null;
    const m = birthday.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    const d = new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    if (now < new Date(now.getFullYear(), d.getMonth(), d.getDate())) age--;
    return age;
  };

  const childAge = getAge(childBirthday);
  const isAgeValid = childAge !== null && childAge >= 6 && childAge <= 13;

  const handleNextStep = async () => {
    triggerBounce();
    if (Platform.OS !== 'web') { try { Vibration.vibrate(30); } catch {} }

    if (step === 0) {
      if (!childName.trim()) return Alert.alert(t('parental.incomplete'), t('parental.enterChildName'));
      if (!childBirthday || !isAgeValid) return Alert.alert(t('parental.invalidAge'), t('parental.ageRange'));
      if (!relationship) return Alert.alert(t('parental.incomplete'), t('parental.selectRelationship'));
      setCreating(true);
      try {
        const r = await api.parentalCreateChild(childName.trim(), childBirthday.trim());
        if (r.success && r.data) {
          setNewChild(r.data);
          setStep(1);
        } else {
          Alert.alert(t('parental.error'), r.message || t('parental.createError'));
        }
      } catch { Alert.alert(t('parental.error'), t('parental.connectionError')); } finally { setCreating(false); }
    } else if (step === 1) {
      if (verifyMethod === 'document' && !docImage) return Alert.alert('', t('parental.selectDocument'));
      if (verifyMethod === 'phone') {
        // Phone verification - trigger OTP flow
        setStep(2);
        setUploading(true);
        try {
          // Simulate phone verification
          await new Promise(resolve => setTimeout(resolve, 3000));
          if (!isMountedRef.current) return;
          setDocVerdict({ verdict: 'approved', confidence: 0.95, method: 'phone' });
          setStep(3);
          loadChildren();
        } catch { if (isMountedRef.current) { Alert.alert(t('parental.error'), t('parental.verifyError')); setStep(1); } }
        finally { if (isMountedRef.current) setUploading(false); }
        return;
      }
      setStep(2);
      setUploading(true);
      try {
        const r = await api.parentalUploadDocument(newChild.account_id, 'rg', docImage.uri);
        if (!isMountedRef.current) return;
        setDocVerdict(r.data || r);
        setStep(3);
        loadChildren();
      } catch { if (isMountedRef.current) { Alert.alert(t('parental.error'), t('parental.uploadError')); setStep(1); } } finally { if (isMountedRef.current) setUploading(false); }
    }
  };

  const pickDocument = async (useCamera) => {
    const fn = useCamera ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
    const result = await fn({ mediaTypes: ['images'], quality: 0.8 });
    if (!result.canceled && result.assets[0]) {
      setDocImage(result.assets[0]);
    }
  };

  const resetWizard = () => {
    setShowWizard(false);
    setStep(0);
    setChildName('');
    setChildBirthday('');
    setChildGender('');
    setRelationship('');
    setVerifyMethod(null);
    setDocImage(null);
    setNewChild(null);
    setDocVerdict(null);
    setQuickSetup({ bedtime: false, contacts: false, screenTime: false, safeSearch: false, filterAdult: false, filterViolence: false, filterProfanity: false });
  };

  const openAiSummary = async (child) => {
    setSummaryChild(child);
    setSummaryModal(true);
    setSummaryLoading(true);
    setSummaryData(null);
    try {
      const r = await api.parentalActivitySummary(child.child_email);
      if (r.success) setSummaryData(r.data);
      else setSummaryData({ error: r.message || t('parental.summaryError') });
    } catch { setSummaryData({ error: t('parental.connectionError') }); }
    finally { setSummaryLoading(false); }
  };

  const riskColor = (level) => {
    if (level === 'high') return '#ef4444';
    if (level === 'medium') return '#f59e0b';
    return '#22c55e';
  };

  const riskLabel = (level) => {
    if (level === 'high') return t('parental.riskHigh');
    if (level === 'medium') return t('parental.riskMedium');
    return t('parental.riskLow');
  };

  const statusConfig = {
    pending_verification: { color: '#f59e0b', label: t('parental.pending'), icon: <IconClock size={24} color="#f59e0b" /> },
    active: { color: '#22c55e', label: t('parental.active'), icon: <IconCheck size={24} color="#22c55e" /> },
    suspended: { color: '#ef4444', label: t('parental.suspended'), icon: <IconAlertCircle size={24} color="#ef4444" /> },
    revoked: { color: '#6b7280', label: t('parental.revoked'), icon: <IconX size={24} color="#6b7280" /> },
    graduated: { color: '#8b5cf6', label: t('parental.graduated'), icon: <IconStar size={24} color="#8b5cf6" /> },
  };

  const formatLastActive = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return t('time.now') || 'now';
    if (diffMin < 60) return `${diffMin}m`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}d`;
  };

  // ─── Confetti Overlay ───
  const CONFETTI_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FED766', '#7C3AED', '#F472B6', '#34D399', '#FB923C'];
  const renderConfetti = () => {
    if (!showConfetti) return null;
    return (
      <View style={s.confettiContainer} pointerEvents="none">
        {confettiAnims.map((anim, i) => (
          <Animated.View
            key={i}
            style={[s.confettiPiece, {
              backgroundColor: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
              width: 8 + Math.random() * 8,
              height: 8 + Math.random() * 8,
              borderRadius: Math.random() > 0.5 ? 50 : 2,
              transform: [
                { translateX: anim.x },
                { translateY: anim.y },
                { rotate: anim.rotate.interpolate({ inputRange: [0, 10], outputRange: ['0deg', '360deg'] }) },
              ],
              opacity: anim.opacity,
            }]}
          />
        ))}
      </View>
    );
  };

  // ─── Progress Steps Indicator ───
  const STEP_ICONS_COMPONENTS = [
    <IconUser size={16} color="#fff" />,
    <IconShield size={16} color="#fff" />,
    <IconClock size={16} color="#fff" />,
    <IconStar size={16} color="#fff" />,
  ];
  const STEP_LABELS_KEYS = ['parental.stepInfo', 'parental.stepVerify', 'parental.stepProcessing', 'parental.stepReady'];

  const renderProgressSteps = () => (
    <View style={s.stepsRow}>
      {STEPS.map((_, i) => {
        const isActive = i === step;
        const isDone = i < step;
        const stepColor = isDone ? '#fff' : isActive ? '#fff' : 'rgba(255,255,255,0.75)';
        return (
          <View key={i} style={s.stepItem}>
            <View style={[s.stepCircle, {
              backgroundColor: isDone ? ACCENT : isActive ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)',
              borderColor: isDone ? ACCENT : isActive ? '#fff' : 'rgba(255,255,255,0.2)',
            }]}>
              {isDone ? (
                <IconCheck size={14} color="#fff" />
              ) : (
                STEP_ICONS_COMPONENTS[i]
              )}
            </View>
            <Text style={[s.stepLabel, { color: stepColor }]} numberOfLines={1}>
              {t(STEP_LABELS_KEYS[i])}
            </Text>
            {i < 3 && <View style={[s.stepLine, { backgroundColor: isDone ? ACCENT : 'rgba(255,255,255,0.15)' }]} />}
          </View>
        );
      })}
    </View>
  );

  // ─── Animated Progress Bar ───
  const renderAnimatedProgress = () => {
    const width = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
    return (
      <View style={[s.progressBar, { backgroundColor: 'rgba(255,255,255,0.15)' }]}>
        <Animated.View style={[s.progressFill, { width, backgroundColor: '#fff' }]} />
      </View>
    );
  };

  // ─── Wizard Step 1: Child Info ───
  const renderStepInfo = () => (
    <ScrollView contentContainerStyle={s.wizardContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      {/* Animated Mascot */}
      <Animated.View style={[s.mascotWrap, { transform: [{ translateY: mascotAnim }] }]}>
        <View style={s.mascotCircle}>
          {(() => {
            const icons = [IconShield, IconUser, IconStar, IconHeart, IconSparkles, IconSmile];
            const Ico = icons[mascotFrameRef.current % icons.length];
            return <Ico size={44} color="#7C3AED" />;
          })()}
        </View>
      </Animated.View>

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 8 }}>
        <Text style={[s.wizardTitle, { color: colors.text, marginBottom: 0 }]}>
          {t('parental.addYourChild')}
        </Text>
        <IconUser size={24} color="#EC4899" />
      </View>
      <Text style={[s.wizardSubtitle, { color: colors.textSecondary }]}>
        {t('parental.addChildDesc')}
      </Text>

      {/* Name Input with floating label feel */}
      <View style={s.fieldGroup}>
        <Text style={[s.fieldLabel, { color: colors.textSecondary }]}>{t('parental.childFullName')}</Text>
        <View style={[s.inputWrap, { backgroundColor: isDark ? '#1a2332' : '#f8f9fb', borderColor: isDark ? '#2d3748' : '#e2e8f0' }]}>
          <View style={{ marginRight: 12 }}><IconUser size={20} color="#7C3AED" /></View>
          <TextInput
            ref={nameInputRef}
            style={[s.input, { color: colors.text }]}
            placeholder={t('parental.namePlaceholder')}
            placeholderTextColor={colors.textSecondary + '80'}
            value={childName}
            onChangeText={setChildName}
            autoFocus
          />
        </View>
        {childName.trim().length > 2 && suggestedUser && (
          <View style={s.usernameSuggest}>
            <Text style={[s.usernameLabel, { color: colors.textSecondary }]}>{t('parental.suggestedUsername')}:</Text>
            <Text style={[s.usernameValue, { color: ACCENT }]}>{suggestedUser}</Text>
          </View>
        )}
      </View>

      {/* Birthday with age display and verification */}
      <View style={s.fieldGroup}>
        <SmartDateInput
          value={childBirthday}
          onChange={setChildBirthday}
          label={t('parental.birthday')}
          placeholder="DD/MM/AAAA"
          minAge={6}
          maxAge={13}
        />
        {childAge !== null && (
          <Animated.View style={[s.ageBadge, {
            backgroundColor: isAgeValid ? ACCENT + '18' : '#ef4444' + '18',
            opacity: fadeAnim,
          }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
              <Text style={[s.ageBadgeText, { color: isAgeValid ? ACCENT : '#ef4444' }]}>
                {isAgeValid
                  ? `${t('parental.perfect')} ${childAge} ${t('parental.yearsOld')}`
                  : childAge < 6
                    ? t('parental.tooYoung')
                    : t('parental.tooOld')
                }
              </Text>
              {isAgeValid && AGE_ICON(childAge)}
            </View>
          </Animated.View>
        )}
        {/* Age range visual indicator */}
        {childAge !== null && (
          <View style={s.ageRangeWrap}>
            <View style={s.ageRangeBar}>
              <View style={[s.ageRangeTrack, { backgroundColor: isDark ? '#1a2332' : '#f1f5f9' }]}>
                <View style={[s.ageRangeValid, { left: '0%', width: '100%', backgroundColor: ACCENT + '20' }]} />
                {isAgeValid && (
                  <View style={[s.ageRangeDot, {
                    left: `${Math.max(0, Math.min(100, ((childAge - 6) / 7) * 100))}%`,
                    backgroundColor: ACCENT,
                  }]} />
                )}
              </View>
              <View style={s.ageRangeLabels}>
                <Text style={[s.ageRangeLabel, { color: colors.textSecondary }]}>6</Text>
                <Text style={[s.ageRangeLabel, { color: colors.textSecondary }]}>8</Text>
                <Text style={[s.ageRangeLabel, { color: colors.textSecondary }]}>10</Text>
                <Text style={[s.ageRangeLabel, { color: colors.textSecondary }]}>12</Text>
                <Text style={[s.ageRangeLabel, { color: colors.textSecondary }]}>13</Text>
              </View>
            </View>
            {isAgeValid && childAge && (
              <View style={[s.agePresetPreview, { backgroundColor: isDark ? '#132218' : '#f0fdf4', borderColor: ACCENT + '30' }]}>
                <Text style={[s.agePresetTitle, { color: ACCENT }]}>
                  {t('parental.recommendedFor') || 'Recommended for'} {childAge} {t('parental.yearsOld') || 'years'}:
                </Text>
                <Text style={[s.agePresetItem, { color: colors.textSecondary }]}>
                  {getAgePresets(childAge).screenTime} min/day  |  {t('parental.bedtime') || 'Bedtime'}: {getAgePresets(childAge).bedtimeStart}
                </Text>
              </View>
            )}
          </View>
        )}
      </View>

      {/* Gender selector - illustrated buttons */}
      <View style={s.fieldGroup}>
        <Text style={[s.fieldLabel, { color: colors.textSecondary }]}>{t('parental.gender')}</Text>
        <View style={s.cardGrid}>
          {genders.map(g => {
            const selected = childGender === g.key;
            return (
              <TouchableOpacity
                key={g.key}
                style={[s.illustratedCard, {
                  backgroundColor: selected ? g.color + '15' : (isDark ? '#1a2332' : '#f8f9fb'),
                  borderColor: selected ? g.color : (isDark ? '#2d3748' : '#e2e8f0'),
                  borderWidth: selected ? 2.5 : 1.5,
                }]}
                onPress={() => { setChildGender(g.key); if (Platform.OS !== 'web') try { Vibration.vibrate(15); } catch {} }}
                activeOpacity={0.7}
              >
                <View style={s.cardEmojiWrap}>{g.emoji}</View>
                <Text style={[s.cardLabel, { color: selected ? g.color : colors.text }]}>{g.label}</Text>
                {selected && (
                  <View style={[s.cardCheck, { backgroundColor: g.color }]}>
                    <IconCheck size={10} color="#fff" />
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Relationship selector - illustrated cards */}
      <View style={s.fieldGroup}>
        <Text style={[s.fieldLabel, { color: colors.textSecondary }]}>{t('parental.iAm')}</Text>
        <View style={s.cardGrid}>
          {relationships.map(r => {
            const selected = relationship === r.key;
            return (
              <TouchableOpacity
                key={r.key}
                style={[s.illustratedCard, {
                  backgroundColor: selected ? r.color + '15' : (isDark ? '#1a2332' : '#f8f9fb'),
                  borderColor: selected ? r.color : (isDark ? '#2d3748' : '#e2e8f0'),
                  borderWidth: selected ? 2.5 : 1.5,
                }]}
                onPress={() => { setRelationship(r.key); if (Platform.OS !== 'web') try { Vibration.vibrate(15); } catch {} }}
                activeOpacity={0.7}
              >
                <View style={s.cardEmojiWrap}>{r.emoji}</View>
                <Text style={[s.cardLabel, { color: selected ? r.color : colors.text }]}>{r.label}</Text>
                {selected && (
                  <View style={[s.cardCheck, { backgroundColor: r.color }]}>
                    <IconCheck size={10} color="#fff" />
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );

  // ─── Wizard Step 2: Safety Verification ───
  const renderStepDocument = () => (
    <ScrollView contentContainerStyle={s.wizardContent} showsVerticalScrollIndicator={false}>
      {/* Shield with pulse */}
      <View style={s.wizardHeader}>
        <Animated.View style={[s.shieldCircle, { transform: [{ scale: pulseAnim }] }]}>
          <IconShield size={44} color="#10B981" />
        </Animated.View>
        <Text style={[s.wizardTitle, { color: colors.text }]}>{t('parental.safetyVerification')}</Text>
        <Text style={[s.wizardSubtitle, { color: colors.textSecondary }]}>
          {t('parental.whyWeVerify')}
        </Text>
      </View>

      {/* Verification method cards */}
      <View style={s.verifyMethods}>
        {/* Option A: Document */}
        <TouchableOpacity
          style={[s.verifyCard, {
            backgroundColor: verifyMethod === 'document' ? '#3B82F6' + '12' : (isDark ? '#1a2332' : '#f8f9fb'),
            borderColor: verifyMethod === 'document' ? '#3B82F6' : (isDark ? '#2d3748' : '#e2e8f0'),
            borderWidth: verifyMethod === 'document' ? 2.5 : 1.5,
          }]}
          onPress={() => setVerifyMethod('document')}
          activeOpacity={0.7}
        >
          <View style={[s.verifyCardIcon, { backgroundColor: '#3B82F6' + '15' }]}>
            <IconFileText size={28} color="#3B82F6" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.verifyCardTitle, { color: colors.text }]}>{t('parental.verifyDocTitle')}</Text>
            <Text style={[s.verifyCardDesc, { color: colors.textSecondary }]}>{t('parental.verifyDocDesc')}</Text>
          </View>
          {verifyMethod === 'document' && (
            <View style={[s.verifyCardCheck, { backgroundColor: '#3B82F6' }]}>
              <IconCheck size={12} color="#fff" />
            </View>
          )}
        </TouchableOpacity>

        {/* Option B: Phone */}
        <TouchableOpacity
          style={[s.verifyCard, {
            backgroundColor: verifyMethod === 'phone' ? '#22C55E' + '12' : (isDark ? '#1a2332' : '#f8f9fb'),
            borderColor: verifyMethod === 'phone' ? '#22C55E' : (isDark ? '#2d3748' : '#e2e8f0'),
            borderWidth: verifyMethod === 'phone' ? 2.5 : 1.5,
          }]}
          onPress={() => setVerifyMethod('phone')}
          activeOpacity={0.7}
        >
          <View style={[s.verifyCardIcon, { backgroundColor: '#22C55E' + '15' }]}>
            <IconSmartphone size={28} color="#22C55E" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.verifyCardTitle, { color: colors.text }]}>{t('parental.verifyPhoneTitle')}</Text>
            <Text style={[s.verifyCardDesc, { color: colors.textSecondary }]}>{t('parental.verifyPhoneDesc')}</Text>
          </View>
          {verifyMethod === 'phone' && (
            <View style={[s.verifyCardCheck, { backgroundColor: '#22C55E' }]}>
              <IconCheck size={12} color="#fff" />
            </View>
          )}
        </TouchableOpacity>

        {/* Option C: Credit card */}
        <TouchableOpacity
          style={[s.verifyCard, {
            backgroundColor: verifyMethod === 'card' ? '#F59E0B' + '12' : (isDark ? '#1a2332' : '#f8f9fb'),
            borderColor: verifyMethod === 'card' ? '#F59E0B' : (isDark ? '#2d3748' : '#e2e8f0'),
            borderWidth: verifyMethod === 'card' ? 2.5 : 1.5,
          }]}
          onPress={() => setVerifyMethod('card')}
          activeOpacity={0.7}
        >
          <View style={[s.verifyCardIcon, { backgroundColor: '#F59E0B' + '15' }]}>
            <IconLock size={28} color="#F59E0B" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.verifyCardTitle, { color: colors.text }]}>{t('parental.verifyCardTitle')}</Text>
            <Text style={[s.verifyCardDesc, { color: colors.textSecondary }]}>{t('parental.verifyCardDesc')}</Text>
          </View>
          {verifyMethod === 'card' && (
            <View style={[s.verifyCardCheck, { backgroundColor: '#F59E0B' }]}>
              <IconCheck size={12} color="#fff" />
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* Document upload area (when document method selected) */}
      {verifyMethod === 'document' && (
        <View style={s.docUploadSection}>
          {docImage ? (
            <View style={s.docPreview}>
              <Image source={{ uri: docImage.uri }} style={s.docPreviewImage} resizeMode="contain" />
              <View style={s.docPreviewOverlay}>
                <View style={[s.docFrameCorner, s.docCornerTL]} />
                <View style={[s.docFrameCorner, s.docCornerTR]} />
                <View style={[s.docFrameCorner, s.docCornerBL]} />
                <View style={[s.docFrameCorner, s.docCornerBR]} />
              </View>
              <TouchableOpacity style={s.docRemoveBtn} onPress={() => setDocImage(null)}>
                <IconX size={16} color="#fff" />
              </TouchableOpacity>
              <View style={s.docDetectedBadge}>
                <IconCheck size={12} color="#fff" />
                <Text style={s.docDetectedText}>{t('parental.documentDetected')}</Text>
              </View>
            </View>
          ) : (
            <View style={s.docButtons}>
              <TouchableOpacity
                style={[s.docBtn, { backgroundColor: isDark ? '#1a2332' : '#f8f9fb', borderColor: isDark ? '#2d3748' : '#e2e8f0' }]}
                onPress={() => pickDocument(true)}
                activeOpacity={0.7}
              >
                <View style={[s.docBtnIconWrap, { backgroundColor: '#3B82F6' + '15' }]}>
                  <IconCamera size={24} color="#3B82F6" />
                </View>
                <Text style={[s.docBtnText, { color: colors.text }]}>{t('parental.takePhoto')}</Text>
                <Text style={[s.docBtnSub, { color: colors.textSecondary }]}>{t('parental.ofDocument')}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[s.docBtn, { backgroundColor: isDark ? '#1a2332' : '#f8f9fb', borderColor: isDark ? '#2d3748' : '#e2e8f0' }]}
                onPress={() => pickDocument(false)}
                activeOpacity={0.7}
              >
                <View style={[s.docBtnIconWrap, { backgroundColor: '#8B5CF6' + '15' }]}>
                  <IconImage size={24} color="#8B5CF6" />
                </View>
                <Text style={[s.docBtnText, { color: colors.text }]}>{t('parental.gallery')}</Text>
                <Text style={[s.docBtnSub, { color: colors.textSecondary }]}>{t('parental.selectPhoto')}</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Accepted documents info */}
          <View style={[s.docTypes, { backgroundColor: isDark ? '#1a2332' : '#f0f9ff', borderColor: isDark ? '#1e3a5f' : '#bae6fd' }]}>
            <Text style={[s.docTypesTitle, { color: isDark ? '#7dd3fc' : '#0369a1' }]}>{t('parental.acceptedDocs')}</Text>
            <Text style={[s.docTypeItem, { color: colors.textSecondary }]}>{t('parental.docType1')}</Text>
            <Text style={[s.docTypeItem, { color: colors.textSecondary }]}>{t('parental.docType2')}</Text>
            <Text style={[s.docTypeItem, { color: colors.textSecondary }]}>{t('parental.docType3')}</Text>
          </View>
        </View>
      )}

      {/* Trust badges */}
      <View style={s.trustBadges}>
        <View style={[s.trustBadge, { backgroundColor: isDark ? '#132218' : '#f0fdf4' }]}>
          <IconShield size={14} color={isDark ? '#86efac' : '#166534'} />
          <Text style={[s.trustText, { color: isDark ? '#86efac' : '#166534' }]}>{t('parental.trust256bit')}</Text>
        </View>
        <View style={[s.trustBadge, { backgroundColor: isDark ? '#1e1b2e' : '#faf5ff' }]}>
          <IconLock size={14} color={isDark ? '#c4b5fd' : '#581c87'} />
          <Text style={[s.trustText, { color: isDark ? '#c4b5fd' : '#581c87' }]}>{t('parental.trustDeleted')}</Text>
        </View>
        <View style={[s.trustBadge, { backgroundColor: isDark ? '#1a2332' : '#f0f9ff' }]}>
          <IconCheck size={14} color={isDark ? '#7dd3fc' : '#0c4a6e'} />
          <Text style={[s.trustText, { color: isDark ? '#7dd3fc' : '#0c4a6e' }]}>{t('parental.trustLGPD')}</Text>
        </View>
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );

  // ─── Wizard Step 3: Verification in Progress ───
  const renderStepVerifying = () => (
    <View style={[s.wizardContent, { alignItems: 'center', justifyContent: 'center', flex: 1, paddingTop: 60 }]}>
      {/* Animated loader */}
      <View style={s.verifyLoaderWrap}>
        <ActivityIndicator size="large" color={ACCENT} />
        <View style={s.verifyLoaderRing} />
      </View>

      {/* Stage indicators */}
      <View style={s.verifyStages}>
        {VERIFY_STAGE_KEYS.map((key, i) => {
          const isActive = i === verifyStage;
          const isDone = i < verifyStage;
          return (
            <View key={i} style={s.verifyStageRow}>
              <View style={[s.verifyStageDot, {
                backgroundColor: isDone ? ACCENT : isActive ? ACCENT : (isDark ? '#2d3748' : '#e2e8f0'),
              }]}>
                {isDone ? <IconCheck size={10} color="#fff" /> : isActive ? <ActivityIndicator size={10} color="#fff" /> : null}
              </View>
              <Text style={[s.verifyStageText, {
                color: isDone ? ACCENT : isActive ? colors.text : colors.textSecondary,
                fontWeight: isActive ? '700' : '400',
              }]}>
                {t(key)}
              </Text>
            </View>
          );
        })}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 0 }}>
        <IconClock size={16} color={colors.textSecondary} />
        <Text style={[s.verifyTimeEst, { color: colors.textSecondary, marginBottom: 0 }]}>
          {t('parental.usuallyLessThan')}
        </Text>
      </View>

      {/* Safety fact carousel */}
      <View style={[s.safetyFactBox, { backgroundColor: isDark ? '#1a2332' : '#f8f9fb', borderColor: isDark ? '#2d3748' : '#e2e8f0' }]}>
        <View style={{ marginBottom: 8 }}><IconSparkles size={28} color="#F59E0B" /></View>
        <Text style={[s.safetyFactTitle, { color: ACCENT }]}>{t('parental.didYouKnow')}</Text>
        <Text style={[s.safetyFactText, { color: colors.text }]}>
          {t(SAFETY_FACTS_KEYS[safetyFactIdx])}
        </Text>
      </View>
    </View>
  );

  // ─── Wizard Step 4: Account Ready! ───
  const renderStepCredentials = () => {
    const approved = docVerdict?.verdict === 'approved';
    const presets = childAge ? getAgePresets(childAge) : null;

    return (
      <ScrollView contentContainerStyle={s.wizardContent} showsVerticalScrollIndicator={false}>
        {renderConfetti()}

        {/* Celebration header */}
        <View style={s.celebrationHeader}>
          <View style={{ marginBottom: 12 }}>{approved ? <IconStar size={56} color="#F59E0B" /> : <IconClock size={56} color="#f59e0b" />}</View>
          <Text style={[s.wizardTitle, { color: colors.text, fontSize: 26 }]}>
            {approved ? t('parental.accountReady') : t('parental.documentReview')}
          </Text>
          <Text style={[s.wizardSubtitle, { color: colors.textSecondary }]}>
            {approved ? t('parental.accountReadyDesc') : t('parental.documentReviewDesc')}
          </Text>
        </View>

        {/* Child avatar card */}
        {newChild && approved && (
          <View style={[s.childReadyCard, { backgroundColor: isDark ? '#132218' : '#f0fdf4', borderColor: '#22c55e40' }]}>
            <View style={s.childReadyAvatar}>
              {childGender === 'female' ? <IconUser size={40} color="#EC4899" /> : childGender === 'male' ? <IconUser size={40} color="#3B82F6" /> : <IconUser size={40} color="#F59E0B" />}
            </View>
            <Text style={[s.childReadyName, { color: colors.text }]}>{newChild.child_name}</Text>
            <View style={s.childReadyBadge}>
              <IconShield size={12} color={ACCENT} />
              <Text style={[s.childReadyBadgeText, { color: ACCENT }]}>{t('parental.protectedAccount')}</Text>
            </View>
          </View>
        )}

        {/* Credentials */}
        {newChild && (
          <View style={[s.credsBox, { backgroundColor: isDark ? '#1a2332' : '#f8f9fb', borderColor: isDark ? '#2d3748' : '#e2e8f0' }]}>
            <Text style={[s.credsTitle, { color: colors.textSecondary }]}>{t('parental.accountCredentials')}</Text>
            <View style={s.credRow}>
              <View style={s.credInfo}>
                <Text style={[s.credLabel, { color: colors.textSecondary }]}>{t('parental.email')}</Text>
                <Text style={[s.credValue, { color: colors.text }]} selectable>{newChild.child_email}</Text>
              </View>
              <TouchableOpacity style={[s.credCopyBtn, { backgroundColor: ACCENT + '15' }]} onPress={() => {
                if (Platform.OS === 'web') { try { navigator.clipboard.writeText(newChild.child_email); } catch {} }
              }}>
                <IconCopy size={14} color={ACCENT} />
              </TouchableOpacity>
            </View>
            <View style={[s.credDivider, { borderColor: isDark ? '#2d3748' : '#e8ecf0' }]} />
            <View style={s.credRow}>
              <View style={s.credInfo}>
                <Text style={[s.credLabel, { color: colors.textSecondary }]}>{t('parental.password')}</Text>
                <Text style={[s.credValue, { color: colors.text }]} selectable>{newChild.child_password || '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}</Text>
              </View>
              <TouchableOpacity style={[s.credCopyBtn, { backgroundColor: ACCENT + '15' }]} onPress={() => {
                if (Platform.OS === 'web' && newChild.child_password) { try { navigator.clipboard.writeText(newChild.child_password); } catch {} }
              }}>
                <IconCopy size={14} color={ACCENT} />
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Warning */}
        <View style={[s.warningBox, { backgroundColor: isDark ? '#2d2314' : '#fffbeb', borderColor: '#f59e0b40' }]}>
          <IconAlertTriangle size={20} color="#f59e0b" />
          <Text style={[s.warningText, { color: isDark ? '#fbbf24' : '#92400e' }]}>
            {t('parental.saveCredentials')}
          </Text>
        </View>

        {/* Quick Setup Options */}
        {approved && presets && (
          <View style={s.quickSetupSection}>
            <Text style={[s.quickSetupTitle, { color: colors.text }]}>{t('parental.quickSetupTitle')}</Text>
            <Text style={[s.quickSetupSub, { color: colors.textSecondary }]}>
              {t('parental.recommendedFor')} {childAge} {t('parental.yearsOld')}
            </Text>

            <TouchableOpacity
              style={[s.setupOption, {
                backgroundColor: quickSetup.bedtime ? ACCENT + '12' : (isDark ? '#1a2332' : '#f8f9fb'),
                borderColor: quickSetup.bedtime ? ACCENT : (isDark ? '#2d3748' : '#e2e8f0'),
              }]}
              onPress={() => setQuickSetup(p => ({ ...p, bedtime: !p.bedtime }))}
              activeOpacity={0.7}
            >
              <View style={s.setupEmojiWrap}><IconMoon size={24} color="#7C3AED" /></View>
              <View style={{ flex: 1 }}>
                <Text style={[s.setupLabel, { color: colors.text }]}>{t('parental.setupBedtime')}</Text>
                <Text style={[s.setupDesc, { color: colors.textSecondary }]}>{presets.bedtimeStart} - {presets.bedtimeEnd}</Text>
              </View>
              <View style={[s.setupToggle, { backgroundColor: quickSetup.bedtime ? ACCENT : (isDark ? '#374151' : '#d1d5db') }]}>
                <View style={[s.setupToggleDot, { transform: [{ translateX: quickSetup.bedtime ? 16 : 0 }] }]} />
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.setupOption, {
                backgroundColor: quickSetup.screenTime ? ACCENT + '12' : (isDark ? '#1a2332' : '#f8f9fb'),
                borderColor: quickSetup.screenTime ? ACCENT : (isDark ? '#2d3748' : '#e2e8f0'),
              }]}
              onPress={() => setQuickSetup(p => ({ ...p, screenTime: !p.screenTime }))}
              activeOpacity={0.7}
            >
              <View style={s.setupEmojiWrap}><IconClock size={24} color="#3b82f6" /></View>
              <View style={{ flex: 1 }}>
                <Text style={[s.setupLabel, { color: colors.text }]}>{t('parental.setupScreenTime')}</Text>
                <Text style={[s.setupDesc, { color: colors.textSecondary }]}>{presets.screenTime} {t('parental.minutesPerDay')}</Text>
              </View>
              <View style={[s.setupToggle, { backgroundColor: quickSetup.screenTime ? ACCENT : (isDark ? '#374151' : '#d1d5db') }]}>
                <View style={[s.setupToggleDot, { transform: [{ translateX: quickSetup.screenTime ? 16 : 0 }] }]} />
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.setupOption, {
                backgroundColor: quickSetup.contacts ? ACCENT + '12' : (isDark ? '#1a2332' : '#f8f9fb'),
                borderColor: quickSetup.contacts ? ACCENT : (isDark ? '#2d3748' : '#e2e8f0'),
              }]}
              onPress={() => setQuickSetup(p => ({ ...p, contacts: !p.contacts }))}
              activeOpacity={0.7}
            >
              <View style={s.setupEmojiWrap}><IconUsers size={24} color="#22c55e" /></View>
              <View style={{ flex: 1 }}>
                <Text style={[s.setupLabel, { color: colors.text }]}>{t('parental.setupContacts')}</Text>
                <Text style={[s.setupDesc, { color: colors.textSecondary }]}>{t('parental.setupContactsDesc')}</Text>
              </View>
              <View style={[s.setupToggle, { backgroundColor: quickSetup.contacts ? ACCENT : (isDark ? '#374151' : '#d1d5db') }]}>
                <View style={[s.setupToggleDot, { transform: [{ translateX: quickSetup.contacts ? 16 : 0 }] }]} />
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.setupOption, {
                backgroundColor: quickSetup.safeSearch ? ACCENT + '12' : (isDark ? '#1a2332' : '#f8f9fb'),
                borderColor: quickSetup.safeSearch ? ACCENT : (isDark ? '#2d3748' : '#e2e8f0'),
              }]}
              onPress={() => setQuickSetup(p => ({ ...p, safeSearch: !p.safeSearch }))}
              activeOpacity={0.7}
            >
              <View style={s.setupEmojiWrap}><IconSearch size={24} color="#6366f1" /></View>
              <View style={{ flex: 1 }}>
                <Text style={[s.setupLabel, { color: colors.text }]}>{t('parental.setupSafeSearch')}</Text>
                <Text style={[s.setupDesc, { color: colors.textSecondary }]}>{t('parental.setupSafeSearchDesc')}</Text>
              </View>
              <View style={[s.setupToggle, { backgroundColor: quickSetup.safeSearch ? ACCENT : (isDark ? '#374151' : '#d1d5db') }]}>
                <View style={[s.setupToggleDot, { transform: [{ translateX: quickSetup.safeSearch ? 16 : 0 }] }]} />
              </View>
            </TouchableOpacity>

            {/* Content filter toggles */}
            <TouchableOpacity
              style={[s.setupOption, {
                backgroundColor: quickSetup.filterAdult ? '#ef4444' + '12' : (isDark ? '#1a2332' : '#f8f9fb'),
                borderColor: quickSetup.filterAdult ? '#ef4444' : (isDark ? '#2d3748' : '#e2e8f0'),
              }]}
              onPress={() => setQuickSetup(p => ({ ...p, filterAdult: !p.filterAdult }))}
              activeOpacity={0.7}
            >
              <View style={s.setupEmojiWrap}><IconAlertCircle size={24} color="#ef4444" /></View>
              <View style={{ flex: 1 }}>
                <Text style={[s.setupLabel, { color: colors.text }]}>{t('parental.filterAdult') || 'Block adult content'}</Text>
                <Text style={[s.setupDesc, { color: colors.textSecondary }]}>{t('parental.filterAdultDesc') || 'Filter inappropriate content'}</Text>
              </View>
              <View style={[s.setupToggle, { backgroundColor: quickSetup.filterAdult ? '#ef4444' : (isDark ? '#374151' : '#d1d5db') }]}>
                <View style={[s.setupToggleDot, { transform: [{ translateX: quickSetup.filterAdult ? 16 : 0 }] }]} />
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.setupOption, {
                backgroundColor: quickSetup.filterViolence ? '#f59e0b' + '12' : (isDark ? '#1a2332' : '#f8f9fb'),
                borderColor: quickSetup.filterViolence ? '#f59e0b' : (isDark ? '#2d3748' : '#e2e8f0'),
              }]}
              onPress={() => setQuickSetup(p => ({ ...p, filterViolence: !p.filterViolence }))}
              activeOpacity={0.7}
            >
              <View style={s.setupEmojiWrap}><IconShield size={24} color="#f59e0b" /></View>
              <View style={{ flex: 1 }}>
                <Text style={[s.setupLabel, { color: colors.text }]}>{t('parental.filterViolence') || 'Block violence'}</Text>
                <Text style={[s.setupDesc, { color: colors.textSecondary }]}>{t('parental.filterViolenceDesc') || 'Hide violent content'}</Text>
              </View>
              <View style={[s.setupToggle, { backgroundColor: quickSetup.filterViolence ? '#f59e0b' : (isDark ? '#374151' : '#d1d5db') }]}>
                <View style={[s.setupToggleDot, { transform: [{ translateX: quickSetup.filterViolence ? 16 : 0 }] }]} />
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.setupOption, {
                backgroundColor: quickSetup.filterProfanity ? '#8b5cf6' + '12' : (isDark ? '#1a2332' : '#f8f9fb'),
                borderColor: quickSetup.filterProfanity ? '#8b5cf6' : (isDark ? '#2d3748' : '#e2e8f0'),
              }]}
              onPress={() => setQuickSetup(p => ({ ...p, filterProfanity: !p.filterProfanity }))}
              activeOpacity={0.7}
            >
              <View style={s.setupEmojiWrap}><IconMessageSquare size={24} color="#8b5cf6" /></View>
              <View style={{ flex: 1 }}>
                <Text style={[s.setupLabel, { color: colors.text }]}>{t('parental.filterProfanity') || 'Filter profanity'}</Text>
                <Text style={[s.setupDesc, { color: colors.textSecondary }]}>{t('parental.filterProfanityDesc') || 'Block bad language'}</Text>
              </View>
              <View style={[s.setupToggle, { backgroundColor: quickSetup.filterProfanity ? '#8b5cf6' : (isDark ? '#374151' : '#d1d5db') }]}>
                <View style={[s.setupToggleDot, { transform: [{ translateX: quickSetup.filterProfanity ? 16 : 0 }] }]} />
              </View>
            </TouchableOpacity>

            {/* One-tap recommended */}
            <TouchableOpacity
              style={[s.recommendedBtn, { backgroundColor: '#7C3AED' + '12', borderColor: '#7C3AED' + '40' }]}
              onPress={() => {
                setQuickSetup({ bedtime: true, contacts: true, screenTime: true, safeSearch: true, filterAdult: true, filterViolence: true, filterProfanity: true });
                if (Platform.OS !== 'web') try { Vibration.vibrate(30); } catch {}
              }}
              activeOpacity={0.7}
            >
              <IconSparkles size={18} color="#7C3AED" />
              <Text style={[s.recommendedText, { color: '#7C3AED' }]}>{t('parental.applyRecommended')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Verification result */}
        {docVerdict && (
          <View style={[s.verdictBox, { backgroundColor: isDark ? '#1a2332' : '#f8fafc', borderColor: isDark ? '#2d3748' : '#e2e8f0' }]}>
            <Text style={[s.verdictTitle, { color: colors.textSecondary }]}>{t('parental.verificationResult')}</Text>
            <Text style={[s.verdictValue, { color: approved ? '#22c55e' : '#f59e0b' }]}>
              {approved ? t('parental.approved') : docVerdict.verdict === 'rejected' ? t('parental.rejected') : t('parental.manualReview')}
            </Text>
            <Text style={[s.verdictConf, { color: colors.textSecondary }]}>
              {t('parental.confidence')}: {Math.round((docVerdict.confidence || 0) * 100)}%
            </Text>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    );
  };

  // ─── Child Card Renderer ───
  const renderChild = ({ item }) => {
    const st = statusConfig[item.status] || statusConfig.pending_verification;
    const isGraduated = item.status === 'graduated';
    const isActive = item.status === 'active';

    return (
      <View style={[s.childCard, { backgroundColor: isDark ? '#1a2332' : '#fff', borderColor: isDark ? '#2d3748' : '#e8ecf0' }]}>
        <TouchableOpacity
          style={s.childCardMain}
          onPress={() => {
            if (isActive) router.push(`/parental-monitor?child_email=${encodeURIComponent(item.child_email)}&child_name=${encodeURIComponent(item.child_name)}`);
            else if (item.status === 'pending_verification') {
              setNewChild({ account_id: item.id, child_email: item.child_email, child_name: item.child_name });
              setShowWizard(true);
              setStep(1);
            }
          }}
          activeOpacity={0.7}
        >
          <View style={[s.childAvatar, { backgroundColor: st.color + '18' }]}>
            {st.icon}
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={[s.childName, { color: colors.text }]}>{item.child_name}</Text>
              {item.last_active && (
                <Text style={[s.lastActive, { color: colors.textSecondary }]}>
                  {t('parental.lastActive')} {formatLastActive(item.last_active)}
                </Text>
              )}
            </View>
            <Text style={[s.childEmail, { color: colors.textSecondary }]}>{item.child_email}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <View style={[s.statusPill, { backgroundColor: st.color + '15' }]}>
                <Text style={[s.statusText, { color: st.color }]}>{st.label}</Text>
              </View>
              {item.unread_alerts > 0 && (
                <View style={[s.alertPill, { backgroundColor: '#ef444418' }]}>
                  <IconAlertCircle size={11} color="#ef4444" />
                  <Text style={s.alertPillText}>{item.unread_alerts} {t('parental.unreadAlerts')}</Text>
                </View>
              )}
            </View>
          </View>
          <IconChevronRight size={18} color={colors.textSecondary} />
        </TouchableOpacity>

        {isGraduated && (
          <View style={[s.graduatedBanner, { backgroundColor: '#8b5cf610', borderTopColor: isDark ? '#2d3748' : '#e8ecf0' }]}>
            <IconStar size={14} color="#8b5cf6" />
            <Text style={[s.graduatedText, { color: '#8b5cf6' }]}>{t('parental.turnedThirteen')}</Text>
          </View>
        )}

        {isActive && (
          <View style={[s.childActions, { borderTopColor: isDark ? '#2d3748' : '#f1f5f9' }]}>
            <TouchableOpacity style={s.childActionBtn} onPress={() => openAiSummary(item)}>
              <IconBarChart size={14} color="#8b5cf6" />
              <Text style={[s.childActionText, { color: '#8b5cf6' }]}>{t('parental.aiSummary')}</Text>
            </TouchableOpacity>
            <View style={[s.childActionDivider, { backgroundColor: isDark ? '#2d3748' : '#f1f5f9' }]} />
            <TouchableOpacity
              style={s.childActionBtn}
              onPress={() => router.push(`/parental-monitor?child_email=${encodeURIComponent(item.child_email)}&child_name=${encodeURIComponent(item.child_name)}`)}
            >
              <IconClock size={14} color={ACCENT} />
              <Text style={[s.childActionText, { color: ACCENT }]}>{t('parental.screenTime')}</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  // ─── Main Wizard Render ───
  if (showWizard) {
    const stepViews = [renderStepInfo, renderStepDocument, renderStepVerifying, renderStepCredentials];
    const isLast = step === 3;
    const canNext = step === 0
      ? (childName.trim() && isAgeValid && relationship)
      : step === 1
        ? (verifyMethod === 'document' ? !!docImage : !!verifyMethod)
        : false;

    const gradient = STEP_GRADIENTS[step];
    const headerBg = Platform.OS === 'web' ? { background: gradient.web } : { backgroundColor: gradient.native };

    return (
      <KeyboardAvoidingView style={[s.container, { backgroundColor: colors.background }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* Gradient Header with steps */}
        <View style={[s.wizardHeaderBar, headerBg]}>
          <View style={s.wizardHeaderRow}>
            <TouchableOpacity onPress={() => step > 0 && step < 3 ? setStep(step - 1) : resetWizard()} style={s.backBtn} accessibilityLabel="Back" accessibilityRole="button">
              <IconArrowLeft size={22} color="#fff" />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={s.wizardHeaderTitle} numberOfLines={1} ellipsizeMode="tail">
                {t(STEP_LABELS_KEYS[step])}
              </Text>
            </View>
            <Text style={s.wizardStepCount}>{step + 1}/4</Text>
          </View>
          {renderProgressSteps()}
          {renderAnimatedProgress()}
        </View>

        {/* Step content with slide animation */}
        <Animated.View style={{ flex: 1, opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}>
          {stepViews[step]()}
        </Animated.View>

        {/* Bottom action button */}
        {step !== 2 && (
          <View style={[s.bottomBar, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
            {isLast ? (
              <TouchableOpacity
                style={[s.nextBtn, { backgroundColor: '#F59E0B' }]}
                onPress={resetWizard}
                activeOpacity={0.8}
              >
                <IconStar size={20} color="#fff" />
                <Text style={s.nextBtnText}>{t('parental.finish')}</Text>
              </TouchableOpacity>
            ) : (
              <Animated.View style={{ transform: [{ scale: bounceAnim }] }}>
                <TouchableOpacity
                  style={[s.nextBtn, {
                    backgroundColor: canNext ? (step === 0 ? '#7C3AED' : ACCENT) : (isDark ? '#2d3748' : '#e2e8f0'),
                  }]}
                  onPress={handleNextStep}
                  disabled={!canNext || creating}
                  activeOpacity={0.8}
                >
                  {creating ? <ActivityIndicator color="#fff" /> : (
                    <>
                      <Text style={[s.nextBtnText, { color: canNext ? '#fff' : colors.textSecondary }]}>
                        {step === 0 ? t('parental.next') : t('parental.startVerification')}
                      </Text>
                      {canNext && <Text style={s.nextBtnArrow}>{'\u2192'}</Text>}
                    </>
                  )}
                </TouchableOpacity>
              </Animated.View>
            )}
          </View>
        )}
      </KeyboardAvoidingView>
    );
  }

  // ─── AI Summary Modal ───
  const renderSummaryModal = () => (
    <Modal visible={summaryModal} transparent animationType="fade" onRequestClose={() => setSummaryModal(false)}>
      <View style={s.modalOverlay}>
        <View style={[s.modalContent, { backgroundColor: isDark ? '#1a2332' : '#fff' }]}>
          <View style={s.modalHeader}>
            <View style={{ flex: 1 }}>
              <Text style={[s.modalTitle, { color: colors.text }]}>{t('parental.aiSummary')}</Text>
              {summaryChild && <Text style={[s.modalSub, { color: colors.textSecondary }]}>{summaryChild.child_name}</Text>}
            </View>
            <TouchableOpacity onPress={() => setSummaryModal(false)} style={s.modalClose}>
              <IconX size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={s.modalBody} showsVerticalScrollIndicator={false}>
            {summaryLoading ? (
              <View style={s.summaryLoading}>
                <ActivityIndicator size="large" color={ACCENT} />
                <Text style={[s.summaryLoadingText, { color: colors.textSecondary }]}>{t('parental.loadingSummary')}</Text>
              </View>
            ) : summaryData?.error ? (
              <View style={s.summaryError}>
                <IconAlertCircle size={24} color="#ef4444" />
                <Text style={[s.summaryErrorText, { color: '#ef4444' }]}>{summaryData.error}</Text>
              </View>
            ) : summaryData ? (
              <View style={{ gap: 16 }}>
                {summaryData.risk_level && (
                  <View style={[s.summaryRisk, { backgroundColor: riskColor(summaryData.risk_level) + '12', borderColor: riskColor(summaryData.risk_level) + '30' }]}>
                    <IconShield size={18} color={riskColor(summaryData.risk_level)} />
                    <View style={{ flex: 1 }}>
                      <Text style={[s.summaryRiskLabel, { color: riskColor(summaryData.risk_level) }]}>{riskLabel(summaryData.risk_level)}</Text>
                      {summaryData.risk_reason && <Text style={[s.summaryRiskReason, { color: colors.textSecondary }]}>{summaryData.risk_reason}</Text>}
                    </View>
                  </View>
                )}

                {summaryData.summary && (
                  <View style={[s.summarySection, { borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
                    <Text style={[s.summarySectionTitle, { color: colors.textSecondary }]}>{t('parental.summary')}</Text>
                    <Text style={[s.summarySectionBody, { color: colors.text }]}>{summaryData.summary}</Text>
                  </View>
                )}

                {summaryData.stats && (
                  <View style={s.summaryStats}>
                    {summaryData.stats.messages_today !== undefined && (
                      <View style={[s.statBox, { backgroundColor: isDark ? '#0f172a' : '#f8fafc' }]}>
                        <Text style={[s.statValue, { color: colors.text }]}>{summaryData.stats.messages_today}</Text>
                        <Text style={[s.statLabel, { color: colors.textSecondary }]}>{t('parental.msgsToday')}</Text>
                      </View>
                    )}
                    {summaryData.stats.calls_today !== undefined && (
                      <View style={[s.statBox, { backgroundColor: isDark ? '#0f172a' : '#f8fafc' }]}>
                        <Text style={[s.statValue, { color: colors.text }]}>{summaryData.stats.calls_today}</Text>
                        <Text style={[s.statLabel, { color: colors.textSecondary }]}>{t('parental.calls')}</Text>
                      </View>
                    )}
                    {summaryData.stats.screen_time_minutes !== undefined && (
                      <View style={[s.statBox, { backgroundColor: isDark ? '#0f172a' : '#f8fafc' }]}>
                        <Text style={[s.statValue, { color: colors.text }]}>{summaryData.stats.screen_time_minutes}m</Text>
                        <Text style={[s.statLabel, { color: colors.textSecondary }]}>{t('parental.screenTime')}</Text>
                      </View>
                    )}
                  </View>
                )}

                {summaryData.flagged_items?.length > 0 && (
                  <View style={[s.summarySection, { borderColor: '#ef444430' }]}>
                    <Text style={[s.summarySectionTitle, { color: '#ef4444' }]}>{t('parental.flaggedContent')}</Text>
                    {summaryData.flagged_items.map((item, i) => (
                      <View key={i} style={s.flaggedItem}>
                        <Text style={{ color: '#ef4444' }}>-</Text>
                        <Text style={[s.flaggedText, { color: colors.text }]}>{item}</Text>
                      </View>
                    ))}
                  </View>
                )}

                {summaryData.recommendations?.length > 0 && (
                  <View style={[s.summarySection, { borderColor: isDark ? '#334155' : '#e2e8f0' }]}>
                    <Text style={[s.summarySectionTitle, { color: ACCENT }]}>{t('parental.recommendations')}</Text>
                    {summaryData.recommendations.map((rec, i) => (
                      <View key={i} style={s.flaggedItem}>
                        <Text style={{ color: ACCENT }}>-</Text>
                        <Text style={[s.flaggedText, { color: colors.text }]}>{rec}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );

  // Quick actions config
  const quickActions = [
    { key: 'screenTime', label: t('parental.screenTime'), icon: IconBarChart, color: '#3b82f6', emoji: <IconClock size={24} color="#3b82f6" /> },
    { key: 'lock', label: t('parental.lockDevice'), icon: IconShield, color: '#ef4444', emoji: <IconShield size={24} color="#ef4444" /> },
    { key: 'message', label: t('parental.sendMessage'), icon: IconMessageSquare, color: '#22c55e', emoji: <IconMessageSquare size={24} color="#22c55e" /> },
    { key: 'summary', label: t('parental.aiSummary'), icon: IconBarChart, color: '#8b5cf6', emoji: <IconSparkles size={24} color="#8b5cf6" /> },
  ];

  const handleQuickAction = (action, child) => {
    if (action === 'screenTime') {
      router.push(`/parental-monitor?child_email=${encodeURIComponent(child.child_email)}&child_name=${encodeURIComponent(child.child_name)}`);
    } else if (action === 'summary') {
      openAiSummary(child);
    } else if (action === 'lock') {
      api.parentalUpdateRestrictions(child.child_email, { locked: true }).catch(() => {});
    }
  };

  // ─── Dashboard (Main Screen) ───
  return (
    <View style={[s.container, { backgroundColor: colors.background }]}>
      {renderSummaryModal()}

      {/* Colorful gradient header */}
      <View style={[s.header,
        Platform.OS === 'web'
          ? { background: 'linear-gradient(135deg, #059669 0%, #10b981 50%, #34d399 100%)' }
          : { backgroundColor: ACCENT }
      ]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityLabel="Back" accessibilityRole="button">
          <IconArrowLeft size={24} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[s.headerTitle, { color: '#fff' }]}>{t('parental.dashboard')}</Text>
          <Text style={[s.headerSub, { color: 'rgba(255,255,255,0.8)' }]}>{t('parental.dashboardSub')}</Text>
        </View>
        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' }}>
          <IconShield size={24} color="#fff" />
        </View>
      </View>

      {/* Hero (empty state) */}
      {children.length === 0 && !loading && (
        <View style={s.hero}>
          <IconShield size={72} color={ACCENT} />
          <Text style={[s.heroTitle, { color: colors.text }]}>{t('parental.parentalControl')}</Text>
          <Text style={[s.heroDesc, { color: colors.textSecondary }]}>
            {t('parental.heroDesc')}
          </Text>
          <TouchableOpacity style={[s.heroBtn, { backgroundColor: ACCENT }]} onPress={() => setShowWizard(true)} accessibilityLabel="Add child" accessibilityRole="button">
            <IconPlus size={20} color="#fff" />
            <Text style={s.heroBtnText}>{t('parental.addChild')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Children List with quick actions */}
      {(children.length > 0 || loading) && (
        loading ? <ActivityIndicator size="large" color={ACCENT} style={{ marginTop: 60 }} /> : (
          <FlatList
            data={children}
            keyExtractor={item => String(item.id)}
            renderItem={renderChild}
            contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
            ListHeaderComponent={
              children.length > 0 ? (
                <View style={{ marginBottom: 16 }}>
                  <Text style={[s.quickActionsTitle, { color: colors.textSecondary }]}>
                    {(t('parental.quickActions')).toUpperCase()}
                  </Text>
                  <View style={s.quickActionsGrid}>
                    {quickActions.map(action => (
                      <TouchableOpacity
                        key={action.key}
                        style={[s.quickActionCard, {
                          backgroundColor: isDark ? action.color + '15' : action.color + '10',
                          borderColor: action.color + '30',
                        }]}
                        onPress={() => children[0] && handleQuickAction(action.key, children[0])}
                        activeOpacity={0.7}
                        accessibilityLabel={action.label}
                        accessibilityRole="button"
                      >
                        {action.emoji}
                        <Text style={[s.quickActionLabel, { color: action.color }]}>{action.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              ) : null
            }
          />
        )
      )}

      {/* FAB */}
      {children.length > 0 && (
        <TouchableOpacity style={[s.fab, { backgroundColor: ACCENT }]} onPress={() => setShowWizard(true)} accessibilityLabel="Add child" accessibilityRole="button">
          <IconPlus size={26} color="#fff" />
        </TouchableOpacity>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },

  // Dashboard header
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: Platform.OS === 'ios' ? 56 : 20, paddingBottom: 16, gap: 14 },
  backBtn: { padding: 6, minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 22, fontWeight: '800' },
  headerSub: { fontSize: 13, marginTop: 2 },

  // Wizard header
  wizardHeaderBar: { paddingTop: Platform.OS === 'ios' ? 44 : 12, paddingBottom: 10, paddingHorizontal: 16 },
  wizardHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  wizardHeaderTitle: { fontSize: 17, fontWeight: '800', color: '#fff' },
  wizardStepCount: { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.85)' },

  // Progress steps
  stepsRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8, paddingHorizontal: 2 },
  stepItem: { alignItems: 'center', flex: 1, position: 'relative' },
  stepCircle: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', borderWidth: 2, marginBottom: 3 },
  stepLabel: { fontSize: 10, fontWeight: '600', textAlign: 'center' },
  stepLine: { position: 'absolute', top: 14, left: '55%', right: '-45%', height: 2, zIndex: -1 },

  // Progress bar
  progressBar: { height: 3, borderRadius: 2, marginTop: 2 },
  progressFill: { height: 3, borderRadius: 2 },

  // Wizard content
  // Wizard mais compacto — user reclamou "ta muito grande pra criar chatyy
  // kids". Reduzi padding lateral, hero mais leve, fieldGroup menor pra
  // caber acima do teclado em iPhones menores.
  wizardContent: { padding: 18, paddingBottom: 28 },
  wizardHeader: { alignItems: 'center', marginBottom: 28 },

  // Mascot
  mascotWrap: { alignItems: 'center', marginBottom: 8 },
  mascotCircle: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#7C3AED15', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#7C3AED30' },
  mascotEmoji: { fontSize: 44 },

  // Shield
  shieldCircle: { width: 90, height: 90, borderRadius: 45, backgroundColor: '#10B98115', alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#10B98130', marginBottom: 16 },
  shieldEmoji: { fontSize: 44 },

  // Titles
  wizardTitle: { fontSize: 19, fontWeight: '800', textAlign: 'center', marginBottom: 4 },
  wizardSubtitle: { fontSize: 13, textAlign: 'center', lineHeight: 18, maxWidth: 320, alignSelf: 'center', marginBottom: 14 },

  // Fields
  fieldGroup: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: '700', marginBottom: 5, letterSpacing: 0.3 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, borderWidth: 1.5, paddingHorizontal: 12, height: 44 },
  inputIcon: { fontSize: 20, marginRight: 12 },
  input: { flex: 1, fontSize: 15, fontWeight: '500' },

  // Username suggestion
  usernameSuggest: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, paddingLeft: 4 },
  usernameLabel: { fontSize: 12, fontWeight: '500' },
  usernameValue: { fontSize: 13, fontWeight: '700' },

  // Age badge
  ageBadge: { marginTop: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, alignItems: 'center' },
  ageBadgeText: { fontSize: 15, fontWeight: '700' },

  // Age range visual
  ageRangeWrap: { marginTop: 6 },
  ageRangeBar: { marginBottom: 4 },
  ageRangeTrack: { height: 8, borderRadius: 4, overflow: 'hidden', position: 'relative' },
  ageRangeValid: { position: 'absolute', top: 0, bottom: 0, borderRadius: 4 },
  ageRangeDot: { position: 'absolute', top: -4, width: 16, height: 16, borderRadius: 8, marginLeft: -8, borderWidth: 3, borderColor: '#fff' },
  ageRangeLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4, paddingHorizontal: 2 },
  ageRangeLabel: { fontSize: 11, fontWeight: '600' },
  agePresetPreview: { marginTop: 10, padding: 12, borderRadius: 14, borderWidth: 1 },
  agePresetTitle: { fontSize: 13, fontWeight: '700', marginBottom: 4 },
  agePresetItem: { fontSize: 12 },

  // Illustrated cards (gender + relationship)
  cardGrid: { flexDirection: 'row', gap: 8 },
  illustratedCard: {
    flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 8,
    borderRadius: 14, position: 'relative', minHeight: 64,
  },
  cardEmoji: { fontSize: 22, marginBottom: 2 },
  cardEmojiWrap: { marginBottom: 2, alignItems: 'center', justifyContent: 'center', width: 26, height: 26 },
  cardLabel: { fontSize: 12, fontWeight: '700', textAlign: 'center' },
  cardCheck: { position: 'absolute', top: 4, right: 4, width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },

  // Verify methods
  verifyMethods: { gap: 12, marginBottom: 24 },
  verifyCard: { flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 20, gap: 14 },
  verifyCardIcon: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  verifyCardTitle: { fontSize: 16, fontWeight: '700', marginBottom: 2 },
  verifyCardDesc: { fontSize: 13, lineHeight: 18 },
  verifyCardCheck: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },

  // Document upload
  docUploadSection: { marginBottom: 20 },
  docButtons: { flexDirection: 'row', gap: 14, marginBottom: 20 },
  docBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 28, borderRadius: 22, borderWidth: 1.5, gap: 10 },
  docBtnIconWrap: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  docBtnText: { fontSize: 16, fontWeight: '700' },
  docBtnSub: { fontSize: 12 },
  docPreview: { borderRadius: 22, overflow: 'hidden', position: 'relative', marginBottom: 20 },
  docPreviewImage: { width: '100%', height: 280, borderRadius: 22 },
  docPreviewOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  docFrameCorner: { position: 'absolute', width: 30, height: 30, borderColor: ACCENT, borderWidth: 3 },
  docCornerTL: { top: 16, left: 16, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 8 },
  docCornerTR: { top: 16, right: 16, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 8 },
  docCornerBL: { bottom: 16, left: 16, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 8 },
  docCornerBR: { bottom: 16, right: 16, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 8 },
  docRemoveBtn: { position: 'absolute', top: 12, right: 12, width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  docDetectedBadge: { position: 'absolute', bottom: 16, left: 16, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: ACCENT, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  docDetectedText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  // Doc types
  docTypes: { padding: 16, borderRadius: 20, borderWidth: 1 },
  docTypesTitle: { fontSize: 13, fontWeight: '700', marginBottom: 8 },
  docTypeItem: { fontSize: 13, lineHeight: 24 },

  // Trust badges
  trustBadges: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  trustBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14 },
  trustIcon: { fontSize: 14 },
  trustText: { fontSize: 11, fontWeight: '600' },

  // Verify stages (step 2)
  verifyLoaderWrap: { marginBottom: 32, alignItems: 'center', justifyContent: 'center' },
  verifyLoaderRing: { position: 'absolute', width: 70, height: 70, borderRadius: 35, borderWidth: 3, borderColor: ACCENT + '20' },
  verifyStages: { gap: 14, marginBottom: 28, alignSelf: 'stretch', paddingHorizontal: 40 },
  verifyStageRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  verifyStageDot: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  verifyStageText: { fontSize: 15 },
  verifyTimeEst: { fontSize: 14, marginBottom: 24 },
  safetyFactBox: { padding: 20, borderRadius: 22, borderWidth: 1.5, alignItems: 'center', maxWidth: 360, alignSelf: 'center', width: '100%' },
  safetyFactIcon: { fontSize: 28, marginBottom: 8 },
  safetyFactTitle: { fontSize: 13, fontWeight: '700', marginBottom: 8, letterSpacing: 0.5 },
  safetyFactText: { fontSize: 14, lineHeight: 22, textAlign: 'center' },

  // Celebration (step 3)
  celebrationHeader: { alignItems: 'center', marginBottom: 24 },
  celebrationEmoji: { fontSize: 56, marginBottom: 12 },

  // Child ready card
  childReadyCard: { alignItems: 'center', padding: 24, borderRadius: 22, borderWidth: 1.5, marginBottom: 20 },
  childReadyAvatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginBottom: 12, elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4 },
  childReadyName: { fontSize: 22, fontWeight: '800', marginBottom: 8 },
  childReadyBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: ACCENT + '15', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14 },
  childReadyBadgeText: { fontSize: 13, fontWeight: '700' },

  // Credentials
  credsBox: { borderRadius: 22, borderWidth: 1.5, overflow: 'hidden', marginBottom: 16, padding: 4 },
  credsTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  credRow: { flexDirection: 'row', alignItems: 'center', padding: 14, paddingHorizontal: 16 },
  credInfo: { flex: 1 },
  credLabel: { fontSize: 12, marginBottom: 4 },
  credValue: { fontSize: 18, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  credDivider: { borderTopWidth: 1, marginHorizontal: 16 },
  credCopyBtn: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },

  // Warning
  warningBox: { flexDirection: 'row', padding: 16, borderRadius: 20, borderWidth: 1.5, gap: 12, marginBottom: 24, alignItems: 'flex-start' },
  warningIcon: { fontSize: 20 },
  warningText: { flex: 1, fontSize: 14, lineHeight: 20, fontWeight: '500' },

  // Quick setup
  quickSetupSection: { marginBottom: 20 },
  quickSetupTitle: { fontSize: 20, fontWeight: '800', marginBottom: 4 },
  quickSetupSub: { fontSize: 14, marginBottom: 16 },
  setupOption: { flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 20, borderWidth: 1.5, gap: 14, marginBottom: 10 },
  setupEmoji: { fontSize: 24 },
  setupEmojiWrap: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  setupLabel: { fontSize: 16, fontWeight: '700' },
  setupDesc: { fontSize: 13, marginTop: 2 },
  setupToggle: { width: 42, height: 26, borderRadius: 13, padding: 3 },
  setupToggleDot: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
  recommendedBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16, borderRadius: 20, borderWidth: 1.5, marginTop: 6 },
  recommendedIcon: { fontSize: 18 },
  recommendedText: { fontSize: 15, fontWeight: '700' },

  // Verdict
  verdictBox: { padding: 20, borderRadius: 22, borderWidth: 1.5, alignItems: 'center', gap: 4, marginBottom: 16 },
  verdictTitle: { fontSize: 12, fontWeight: '600' },
  verdictValue: { fontSize: 20, fontWeight: '800' },
  verdictConf: { fontSize: 12 },

  // Bottom bar
  bottomBar: { padding: 16, borderTopWidth: 1 },
  nextBtn: { height: 56, borderRadius: 22, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  nextBtnText: { fontSize: 18, fontWeight: '800', color: '#fff' },
  nextBtnEmoji: { fontSize: 20 },
  nextBtnArrow: { fontSize: 20, color: '#fff', fontWeight: '700' },

  // Confetti
  confettiContainer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 999 },
  confettiPiece: { position: 'absolute' },

  // Quick Actions (dashboard)
  quickActionsTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.8, marginBottom: 10, paddingHorizontal: 2 },
  quickActionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  quickActionCard: {
    width: '48%', flexGrow: 1, flexBasis: '45%',
    alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 18, paddingHorizontal: 12, borderRadius: 20, borderWidth: 2,
    minHeight: 80,
  },
  quickActionLabel: { fontSize: 13, fontWeight: '700', textAlign: 'center' },

  // Hero
  hero: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 60 },
  heroTitle: { fontSize: 28, fontWeight: '800', marginTop: 16 },
  heroDesc: { fontSize: 16, textAlign: 'center', marginTop: 14, lineHeight: 24 },
  heroBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 32, paddingVertical: 16, borderRadius: 22, marginTop: 28, minHeight: 56 },
  heroBtnText: { color: '#fff', fontWeight: '800', fontSize: 17 },

  // Child cards
  childCard: { borderRadius: 22, borderWidth: 1.5, marginBottom: 14, overflow: 'hidden' },
  childCardMain: { flexDirection: 'row', alignItems: 'center', padding: 18, gap: 14 },
  childAvatar: { width: 56, height: 56, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  childName: { fontSize: 18, fontWeight: '800' },
  childEmail: { fontSize: 12, marginTop: 2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  statusPill: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10 },
  statusText: { fontSize: 11, fontWeight: '700' },
  lastActive: { fontSize: 11 },
  alertPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  alertPillText: { color: '#ef4444', fontSize: 11, fontWeight: '600' },
  childActions: { flexDirection: 'row', borderTopWidth: 1 },
  childActionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 11 },
  childActionText: { fontSize: 13, fontWeight: '600' },
  childActionDivider: { width: 1 },
  graduatedBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1 },
  graduatedText: { fontSize: 12, flex: 1 },

  // AI Summary Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalContent: { width: '100%', maxWidth: 440, maxHeight: '80%', borderRadius: 22, overflow: 'hidden', ...Platform.select({ ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.25, shadowRadius: 16 }, android: { elevation: 12 } }) },
  modalHeader: { flexDirection: 'row', alignItems: 'center', padding: 20, paddingBottom: 12 },
  modalTitle: { fontSize: 18, fontWeight: '800' },
  modalSub: { fontSize: 13, marginTop: 2 },
  modalClose: { padding: 4 },
  modalBody: { paddingHorizontal: 20, paddingBottom: 24 },
  summaryLoading: { alignItems: 'center', paddingVertical: 40, gap: 12 },
  summaryLoadingText: { fontSize: 14 },
  summaryError: { alignItems: 'center', paddingVertical: 30, gap: 10 },
  summaryErrorText: { fontSize: 14, textAlign: 'center' },
  summaryRisk: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 18, borderWidth: 1 },
  summaryRiskLabel: { fontSize: 16, fontWeight: '800' },
  summaryRiskReason: { fontSize: 12, marginTop: 2 },
  summarySection: { borderWidth: 1, borderRadius: 18, padding: 14 },
  summarySectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 },
  summarySectionBody: { fontSize: 14, lineHeight: 20 },
  summaryStats: { flexDirection: 'row', gap: 10 },
  statBox: { flex: 1, alignItems: 'center', paddingVertical: 14, borderRadius: 14 },
  statValue: { fontSize: 22, fontWeight: '800' },
  statLabel: { fontSize: 11, marginTop: 2 },
  flaggedItem: { flexDirection: 'row', gap: 8, marginTop: 4 },
  flaggedText: { flex: 1, fontSize: 13, lineHeight: 18 },

  // FAB
  fab: { position: 'absolute', bottom: 28, right: 28, width: 60, height: 60, borderRadius: 22, alignItems: 'center', justifyContent: 'center', elevation: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 8, ...(Platform.OS === 'web' ? { boxShadow: '0 6px 24px rgba(124,58,237,0.4)' } : {}) },
});
