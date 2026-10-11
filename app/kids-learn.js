import { androidTopInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput, ActivityIndicator, Platform, Linking, Animated, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconSend, IconZap, IconHash, IconFileText, IconSparkles, IconBuilding, IconTranslate, IconPalette, IconMusic, IconGlobe, IconBookmark, IconFilm, IconClock, IconAward } from '../components/Icons';
import Svg, { Path, Circle as SvgCircle } from 'react-native-svg';
import * as api from '../services/api';
import ErrorBoundary from '../components/ErrorBoundary';

const { width: SCREEN_W } = Dimensions.get('window');

function IconStar({ size = 20, color = '#fbbf24' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <Path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </Svg>
  );
}

function IconCheck({ size = 22, color = '#22c55e' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20 6L9 17l-5-5" />
    </Svg>
  );
}

// Bounce animation wrapper
function BounceIn({ children, delay = 0 }) {
  const scale = useRef(new Animated.Value(0.5)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, delay, tension: 80, friction: 7, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, delay, duration: 200, useNativeDriver: true }),
    ]).start();
  }, []);
  return <Animated.View style={{ transform: [{ scale }], opacity }}>{children}</Animated.View>;
}

const CATEGORIES = [
  { key: 'math', Icon: IconHash, color: '#111111', videos: [
    { titleKey: 'kidsLearn.video.divide', duration: '5 min', url: 'https://youtube.com/results?search_query=como+dividir+para+criancas' },
    { titleKey: 'kidsLearn.video.fractions', duration: '7 min', url: 'https://youtube.com/results?search_query=fracoes+para+criancas+explicacao' },
    { titleKey: 'kidsLearn.video.timesTable', duration: '4 min', url: 'https://youtube.com/results?search_query=tabuada+divertida+criancas' },
    { titleKey: 'kidsLearn.video.geometry', duration: '6 min', url: 'https://youtube.com/results?search_query=geometria+para+criancas' },
  ]},
  { key: 'portuguese', Icon: IconFileText, color: '#22c55e', videos: [
    { titleKey: 'kidsLearn.video.accents', duration: '5 min', url: 'https://youtube.com/results?search_query=acentuacao+portugues+criancas' },
    { titleKey: 'kidsLearn.video.subjectPredicate', duration: '6 min', url: 'https://youtube.com/results?search_query=sujeito+predicado+criancas' },
    { titleKey: 'kidsLearn.video.essay', duration: '8 min', url: 'https://youtube.com/results?search_query=como+fazer+redacao+criancas' },
  ]},
  { key: 'science', Icon: IconSparkles, color: '#f59e0b', videos: [
    { titleKey: 'kidsLearn.video.solarSystem', duration: '7 min', url: 'https://youtube.com/results?search_query=sistema+solar+criancas+manual+do+mundo' },
    { titleKey: 'kidsLearn.video.humanBody', duration: '6 min', url: 'https://youtube.com/results?search_query=corpo+humano+criancas' },
    { titleKey: 'kidsLearn.video.experiments', duration: '5 min', url: 'https://youtube.com/results?search_query=experimentos+caseiros+criancas+manual+do+mundo' },
  ]},
  { key: 'history', Icon: IconBuilding, color: '#111111', videos: [
    { titleKey: 'kidsLearn.video.discoveryBrazil', duration: '6 min', url: 'https://youtube.com/results?search_query=descobrimento+brasil+criancas' },
    { titleKey: 'kidsLearn.video.indigenous', duration: '7 min', url: 'https://youtube.com/results?search_query=povos+indigenas+brasil+criancas' },
    { titleKey: 'kidsLearn.video.independence', duration: '5 min', url: 'https://youtube.com/results?search_query=independencia+brasil+criancas' },
  ]},
  { key: 'english', Icon: IconTranslate, color: '#111111', videos: [
    { titleKey: 'kidsLearn.video.colorsEn', duration: '3 min', url: 'https://youtube.com/results?search_query=colors+in+english+for+kids' },
    { titleKey: 'kidsLearn.video.numbersEn', duration: '4 min', url: 'https://youtube.com/results?search_query=numbers+in+english+for+kids' },
    { titleKey: 'kidsLearn.video.animalsEn', duration: '5 min', url: 'https://youtube.com/results?search_query=animals+in+english+for+kids' },
  ]},
  { key: 'art', Icon: IconPalette, color: '#ef4444', videos: [
    { titleKey: 'kidsLearn.video.drawAnimals', duration: '8 min', url: 'https://youtube.com/results?search_query=como+desenhar+animais+facil+criancas' },
    { titleKey: 'kidsLearn.video.primaryColors', duration: '4 min', url: 'https://youtube.com/results?search_query=cores+primarias+secundarias+criancas' },
  ]},
  { key: 'music', Icon: IconMusic, color: '#06b6d4', videos: [
    { titleKey: 'kidsLearn.video.instruments', duration: '5 min', url: 'https://youtube.com/results?search_query=instrumentos+musicais+para+criancas' },
    { titleKey: 'kidsLearn.video.rhythm', duration: '4 min', url: 'https://youtube.com/results?search_query=ritmo+compasso+musica+criancas' },
  ]},
  { key: 'geography', Icon: IconGlobe, color: '#84cc16', videos: [
    { titleKey: 'kidsLearn.video.continents', duration: '6 min', url: 'https://youtube.com/results?search_query=continentes+do+mundo+criancas' },
    { titleKey: 'kidsLearn.video.southAmerica', duration: '5 min', url: 'https://youtube.com/results?search_query=paises+america+sul+criancas' },
  ]},
];

function KidsLearnScreenInner() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [activeCategory, setActiveCategory] = useState('math');
  const [question, setQuestion] = useState('');
  const [tutorResponse, setTutorResponse] = useState('');
  const [tutorLoading, setTutorLoading] = useState(false);
  const [stars, setStars] = useState(0);

  const category = CATEGORIES.find(c => c.key === activeCategory) || CATEGORIES[0];

  const askTutor = useCallback(async () => {
    if (!question.trim() || tutorLoading) return;
    setTutorLoading(true);
    setTutorResponse('');
    try {
      const r = await api.oneChat(
        `Voce e a Professora ONE. A crianca perguntou: "${question.trim()}". Ensine o raciocinio passo a passo, NUNCA de a resposta direta. Use emojis e linguagem amigavel.`,
        'kids_tutor'
      );
      setTutorResponse(r?.data?.response || r?.data?.text || r?.message || t('kidsLearn.tutorEmpty'));
      setStars(prev => prev + 1);
    } catch {
      setTutorResponse(t('kidsLearn.tutorError'));
    }
    setTutorLoading(false);
  }, [question, tutorLoading, t]);

  const openVideo = (url) => {
    Linking.openURL(url).catch(() => {});
  };

  return (
    <View style={[s.container, { backgroundColor: isDark ? '#0f0720' : '#faf5ff' }]}>
      {/* Colorful gradient header */}
      <View style={[s.header,
        Platform.OS === 'web'
          ? { background: 'linear-gradient(135deg, #111111 0%, #111111 40%, #111111 70%, #f43f5e 100%)' }
          : { backgroundColor: '#111111' }
      ]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityLabel={t('common.back')} accessibilityRole="button">
          <IconArrowLeft size={24} color="#fff" />
        </TouchableOpacity>
        <View style={s.headerEmoji}><IconBookmark size={22} color="#fff" /></View>
        <Text style={s.headerTitle}>{t('kids.learn') || 'Aprender'}</Text>
        {stars > 0 && (
          <View style={s.starBadge}>
            <IconStar size={16} color="#fbbf24" />
            <Text style={s.starText}>{stars}</Text>
          </View>
        )}
      </View>

      <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        {/* Category pills - large touch-friendly */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.catScroll} contentContainerStyle={s.catContent}>
          {CATEGORIES.map((cat, idx) => (
            <BounceIn key={cat.key} delay={idx * 40}>
              <TouchableOpacity
                style={[s.catChip, {
                  backgroundColor: activeCategory === cat.key ? cat.color : (isDark ? '#161618' : '#fff'),
                  borderColor: activeCategory === cat.key ? cat.color : (isDark ? '#161618' : '#e5e7eb'),
                  ...(activeCategory === cat.key && Platform.OS === 'web' ? { boxShadow: `0 4px 12px ${cat.color}40` } : {}),
                }]}
                onPress={() => setActiveCategory(cat.key)}
                accessibilityLabel={t(`kids.categories.${cat.key}`) || cat.key}
                accessibilityRole="button"
              >
                <View style={s.catEmoji}><cat.Icon size={20} color={activeCategory === cat.key ? '#fff' : (isDark ? '#F1F3F5' : '#1e1b4b')} /></View>
                <Text style={[s.catLabel, { color: activeCategory === cat.key ? '#fff' : (isDark ? '#F1F3F5' : '#1e1b4b') }]}>
                  {t(`kids.categories.${cat.key}`) || cat.key}
                </Text>
              </TouchableOpacity>
            </BounceIn>
          ))}
        </ScrollView>

        {/* Video cards - large, colorful */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <IconFilm size={20} color={isDark ? '#F1F3F5' : '#1e1b4b'} />
          <Text style={[s.sectionTitle, { color: isDark ? '#F1F3F5' : '#1e1b4b', marginBottom: 0 }]}>
            {t('kids.videos') || 'Vídeos'}
          </Text>
        </View>
        {category.videos.map((video, i) => (
          <BounceIn key={i} delay={i * 60}>
            <TouchableOpacity
              style={[s.videoCard, {
                backgroundColor: isDark ? '#161618' : '#fff',
                borderColor: isDark ? '#161618' : '#e5e7eb',
                ...(Platform.OS === 'web' ? { boxShadow: '0 4px 16px rgba(0,0,0,0.06)' } : {}),
              }]}
              onPress={() => openVideo(video.url)}
              activeOpacity={0.7}
              accessibilityLabel={t(video.titleKey)}
              accessibilityRole="button"
            >
              <View style={[s.videoThumb, { backgroundColor: category.color + '20' }]}>
                <category.Icon size={30} color={category.color} />
              </View>
              <View style={s.videoInfo}>
                <Text style={[s.videoTitle, { color: isDark ? '#F1F3F5' : '#1e1b4b' }]}>{t(video.titleKey)}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 }}>
                  <IconClock size={13} color={isDark ? '#8E8E93' : '#6b7280'} />
                  <Text style={[s.videoDuration, { color: isDark ? '#111111' : '#6b7280' }]}>{video.duration}</Text>
                </View>
              </View>
            </TouchableOpacity>
          </BounceIn>
        ))}

        {/* AI Tutor - large card with playful design */}
        <View style={[s.tutorCard, {
          backgroundColor: isDark ? '#161618' : '#fff',
          borderColor: '#11111140',
          ...(Platform.OS === 'web' ? { boxShadow: '0 6px 24px rgba(17, 17, 17,0.1)' } : {}),
        }]}>
          <View style={s.tutorHeader}>
            <View style={{ width: 52, height: 52, borderRadius: 18, backgroundColor: '#11111120', alignItems: 'center', justifyContent: 'center' }}>
              <IconAward size={28} color={isDark ? '#F1F3F5' : '#111111'} />
            </View>
            <View style={{ flex: 1, marginLeft: 14 }}>
              <Text style={[s.tutorTitle, { color: isDark ? '#F1F3F5' : '#1e1b4b' }]}>{t('kids.homework') || 'Dever de Casa'}</Text>
              <Text style={[s.tutorDesc, { color: isDark ? '#111111' : '#6b7280' }]}>{t('kids.homeworkDesc') || 'Precisa de ajuda? Pergunte!'}</Text>
            </View>
          </View>

          <View style={s.tutorInputRow}>
            <TextInput
              style={[s.tutorInput, {
                backgroundColor: isDark ? '#0f0720' : '#faf5ff',
                color: isDark ? '#F1F3F5' : '#1e1b4b',
                borderColor: isDark ? '#161618' : '#e5e7eb',
              }]}
              placeholder={t('kids.homeworkPlaceholder') || 'Qual sua dúvida?'}
              placeholderTextColor={isDark ? '#8E8E93' : '#111111'}
              value={question}
              onChangeText={setQuestion}
              multiline
            />
            <TouchableOpacity
              style={[s.tutorSendBtn, {
                backgroundColor: question.trim() ? '#111111' : (isDark ? '#161618' : '#F1F3F5'),
                ...(question.trim() && Platform.OS === 'web' ? { boxShadow: '0 4px 12px rgba(17, 17, 17,0.3)' } : {}),
              }]}
              onPress={askTutor}
              disabled={!question.trim() || tutorLoading}
              accessibilityLabel={t('common.send')} accessibilityRole="button"
            >
              {tutorLoading ? <ActivityIndicator size="small" color="#fff" /> : <IconSend size={20} color={question.trim() ? '#fff' : (isDark ? '#F5F5F7' : '#111111')} />}
            </TouchableOpacity>
          </View>

          {tutorResponse ? (
            <View style={[s.tutorResponse, { backgroundColor: isDark ? '#0f0720' : '#faf5ff' }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <IconCheck size={18} color="#22c55e" />
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#22c55e' }}>{t('kids.teacherOne')}</Text>
              </View>
              <Text style={[s.tutorResponseText, { color: isDark ? '#F1F3F5' : '#1e1b4b' }]}>{tutorResponse}</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

// [WAVE 63 #fam-crash] ErrorBoundary wrap to keep "Família"-adjacent screens
// from taking down the app on unexpected null data.
export default function KidsLearnScreen() {
  return <ErrorBoundary><KidsLearnScreenInner /></ErrorBoundary>;
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', padding: 18,
    paddingTop: Platform.OS === 'ios' ? 56 : androidTopInset(18), gap: 10,
  },
  backBtn: { padding: 8, minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  headerEmoji: { alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 22, fontWeight: '800', color: '#fff', flex: 1 },
  starBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14,
  },
  starText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  content: { padding: 18, paddingBottom: 40 },
  catScroll: { marginBottom: 22 },
  catContent: { gap: 10 },
  catChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 18, paddingVertical: 14, borderRadius: 20, borderWidth: 2,
    minHeight: 52,
  },
  catEmoji: { marginRight: 8 },
  catLabel: { fontSize: 16, fontWeight: '700' },
  sectionTitle: { fontSize: 20, fontWeight: '800', marginBottom: 14 },
  videoCard: {
    flexDirection: 'row', alignItems: 'center', padding: 14,
    borderRadius: 20, borderWidth: 2, marginBottom: 12,
    minHeight: 80,
  },
  videoThumb: { width: 64, height: 64, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  videoInfo: { flex: 1, marginLeft: 14 },
  videoTitle: { fontSize: 16, fontWeight: '700' },
  videoDuration: { fontSize: 13 },
  tutorCard: { marginTop: 28, borderRadius: 24, borderWidth: 2, padding: 20 },
  tutorHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 18 },
  tutorTitle: { fontSize: 19, fontWeight: '800' },
  tutorDesc: { fontSize: 14, marginTop: 3 },
  tutorInputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  tutorInput: {
    flex: 1, borderRadius: 18, borderWidth: 2,
    paddingHorizontal: 18, paddingVertical: 12, fontSize: 17, maxHeight: 120,
    minHeight: 52,
  },
  tutorSendBtn: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  tutorResponse: { marginTop: 14, borderRadius: 16, padding: 16 },
  tutorResponseText: { fontSize: 16, lineHeight: 24 },
});
