import { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput, ActivityIndicator, Platform, Linking, Animated, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconArrowLeft, IconSend, IconZap } from '../components/Icons';
import Svg, { Path, Circle as SvgCircle } from 'react-native-svg';
import * as api from '../services/api';

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
  { key: 'math', emoji: '\uD83D\uDD22', color: '#8b5cf6', videos: [
    { title: 'Como fazer conta de dividir', duration: '5 min', url: 'https://youtube.com/results?search_query=como+dividir+para+criancas' },
    { title: 'O que sao fracoes', duration: '7 min', url: 'https://youtube.com/results?search_query=fracoes+para+criancas+explicacao' },
    { title: 'Tabuada divertida', duration: '4 min', url: 'https://youtube.com/results?search_query=tabuada+divertida+criancas' },
    { title: 'Geometria: formas e areas', duration: '6 min', url: 'https://youtube.com/results?search_query=geometria+para+criancas' },
  ]},
  { key: 'portuguese', emoji: '\uD83D\uDCD6', color: '#22c55e', videos: [
    { title: 'Acentuacao: quando usar', duration: '5 min', url: 'https://youtube.com/results?search_query=acentuacao+portugues+criancas' },
    { title: 'Sujeito e predicado', duration: '6 min', url: 'https://youtube.com/results?search_query=sujeito+predicado+criancas' },
    { title: 'Como fazer uma redacao', duration: '8 min', url: 'https://youtube.com/results?search_query=como+fazer+redacao+criancas' },
  ]},
  { key: 'science', emoji: '\uD83D\uDD2C', color: '#f59e0b', videos: [
    { title: 'Sistema Solar explicado', duration: '7 min', url: 'https://youtube.com/results?search_query=sistema+solar+criancas+manual+do+mundo' },
    { title: 'Como funciona o corpo humano', duration: '6 min', url: 'https://youtube.com/results?search_query=corpo+humano+criancas' },
    { title: 'Experimentos caseiros faceis', duration: '5 min', url: 'https://youtube.com/results?search_query=experimentos+caseiros+criancas+manual+do+mundo' },
  ]},
  { key: 'history', emoji: '\uD83C\uDFDB\uFE0F', color: '#3b82f6', videos: [
    { title: 'Descobrimento do Brasil', duration: '6 min', url: 'https://youtube.com/results?search_query=descobrimento+brasil+criancas' },
    { title: 'Povos indigenas', duration: '7 min', url: 'https://youtube.com/results?search_query=povos+indigenas+brasil+criancas' },
    { title: 'Independencia do Brasil', duration: '5 min', url: 'https://youtube.com/results?search_query=independencia+brasil+criancas' },
  ]},
  { key: 'english', emoji: '\uD83C\uDDEC\uD83C\uDDE7', color: '#ec4899', videos: [
    { title: 'Cores em ingles', duration: '3 min', url: 'https://youtube.com/results?search_query=colors+in+english+for+kids' },
    { title: 'Numeros em ingles', duration: '4 min', url: 'https://youtube.com/results?search_query=numbers+in+english+for+kids' },
    { title: 'Animais em ingles', duration: '5 min', url: 'https://youtube.com/results?search_query=animals+in+english+for+kids' },
  ]},
  { key: 'art', emoji: '\uD83C\uDFA8', color: '#ef4444', videos: [
    { title: 'Como desenhar animais', duration: '8 min', url: 'https://youtube.com/results?search_query=como+desenhar+animais+facil+criancas' },
    { title: 'Cores primarias e secundarias', duration: '4 min', url: 'https://youtube.com/results?search_query=cores+primarias+secundarias+criancas' },
  ]},
  { key: 'music', emoji: '\uD83C\uDFB5', color: '#06b6d4', videos: [
    { title: 'Instrumentos musicais', duration: '5 min', url: 'https://youtube.com/results?search_query=instrumentos+musicais+para+criancas' },
    { title: 'Ritmo e compasso', duration: '4 min', url: 'https://youtube.com/results?search_query=ritmo+compasso+musica+criancas' },
  ]},
  { key: 'geography', emoji: '\uD83C\uDF0E', color: '#84cc16', videos: [
    { title: 'Continentes do mundo', duration: '6 min', url: 'https://youtube.com/results?search_query=continentes+do+mundo+criancas' },
    { title: 'Paises da America do Sul', duration: '5 min', url: 'https://youtube.com/results?search_query=paises+america+sul+criancas' },
  ]},
];

export default function KidsLearnScreen() {
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
      setTutorResponse(r?.data?.response || r?.data?.text || r?.message || 'Hmm, nao consegui pensar agora. Tenta de novo!');
      setStars(prev => prev + 1);
    } catch {
      setTutorResponse('Ops, algo deu errado. Tenta de novo!');
    }
    setTutorLoading(false);
  }, [question, tutorLoading]);

  const openVideo = (url) => {
    Linking.openURL(url).catch(() => {});
  };

  return (
    <View style={[s.container, { backgroundColor: isDark ? '#0f0720' : '#faf5ff' }]}>
      {/* Colorful gradient header */}
      <View style={[s.header,
        Platform.OS === 'web'
          ? { background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 40%, #ec4899 70%, #f43f5e 100%)' }
          : { backgroundColor: '#6366f1' }
      ]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityLabel="Back" accessibilityRole="button">
          <IconArrowLeft size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={s.headerEmoji}>{'\uD83D\uDCDA'}</Text>
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
                  backgroundColor: activeCategory === cat.key ? cat.color : (isDark ? '#1e1145' : '#fff'),
                  borderColor: activeCategory === cat.key ? cat.color : (isDark ? '#2d1b4e' : '#e5e7eb'),
                  ...(activeCategory === cat.key && Platform.OS === 'web' ? { boxShadow: `0 4px 12px ${cat.color}40` } : {}),
                }]}
                onPress={() => setActiveCategory(cat.key)}
                accessibilityLabel={t(`kids.categories.${cat.key}`) || cat.key}
                accessibilityRole="button"
              >
                <Text style={s.catEmoji}>{cat.emoji}</Text>
                <Text style={[s.catLabel, { color: activeCategory === cat.key ? '#fff' : (isDark ? '#e9d5ff' : '#1e1b4b') }]}>
                  {t(`kids.categories.${cat.key}`) || cat.key}
                </Text>
              </TouchableOpacity>
            </BounceIn>
          ))}
        </ScrollView>

        {/* Video cards - large, colorful */}
        <Text style={[s.sectionTitle, { color: isDark ? '#e9d5ff' : '#1e1b4b' }]}>
          {'\uD83C\uDFAC'} {t('kids.videos') || 'Videos'}
        </Text>
        {category.videos.map((video, i) => (
          <BounceIn key={i} delay={i * 60}>
            <TouchableOpacity
              style={[s.videoCard, {
                backgroundColor: isDark ? '#1e1145' : '#fff',
                borderColor: isDark ? '#2d1b4e' : '#e5e7eb',
                ...(Platform.OS === 'web' ? { boxShadow: '0 4px 16px rgba(0,0,0,0.06)' } : {}),
              }]}
              onPress={() => openVideo(video.url)}
              activeOpacity={0.7}
              accessibilityLabel={video.title}
              accessibilityRole="button"
            >
              <View style={[s.videoThumb, { backgroundColor: category.color + '20' }]}>
                <Text style={{ fontSize: 32 }}>{category.emoji}</Text>
              </View>
              <View style={s.videoInfo}>
                <Text style={[s.videoTitle, { color: isDark ? '#e9d5ff' : '#1e1b4b' }]}>{video.title}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 }}>
                  <Text style={{ fontSize: 12 }}>{'\u23F1'}</Text>
                  <Text style={[s.videoDuration, { color: isDark ? '#a78bfa' : '#6b7280' }]}>{video.duration}</Text>
                </View>
              </View>
            </TouchableOpacity>
          </BounceIn>
        ))}

        {/* AI Tutor - large card with playful design */}
        <View style={[s.tutorCard, {
          backgroundColor: isDark ? '#1e1145' : '#fff',
          borderColor: '#8b5cf640',
          ...(Platform.OS === 'web' ? { boxShadow: '0 6px 24px rgba(139,92,246,0.1)' } : {}),
        }]}>
          <View style={s.tutorHeader}>
            <View style={{ width: 52, height: 52, borderRadius: 18, backgroundColor: '#8b5cf620', alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 30 }}>{'\uD83C\uDF93'}</Text>
            </View>
            <View style={{ flex: 1, marginLeft: 14 }}>
              <Text style={[s.tutorTitle, { color: isDark ? '#e9d5ff' : '#1e1b4b' }]}>{t('kids.homework') || 'Dever de Casa'}</Text>
              <Text style={[s.tutorDesc, { color: isDark ? '#a78bfa' : '#6b7280' }]}>{t('kids.homeworkDesc') || 'Precisa de ajuda? Pergunte!'}</Text>
            </View>
          </View>

          <View style={s.tutorInputRow}>
            <TextInput
              style={[s.tutorInput, {
                backgroundColor: isDark ? '#0f0720' : '#faf5ff',
                color: isDark ? '#e9d5ff' : '#1e1b4b',
                borderColor: isDark ? '#2d1b4e' : '#e5e7eb',
              }]}
              placeholder={t('kids.homeworkPlaceholder') || 'Qual sua duvida?'}
              placeholderTextColor={isDark ? '#6b5895' : '#a78bfa'}
              value={question}
              onChangeText={setQuestion}
              multiline
            />
            <TouchableOpacity
              style={[s.tutorSendBtn, {
                backgroundColor: question.trim() ? '#8b5cf6' : (isDark ? '#2d1b4e' : '#e9d5ff'),
                ...(question.trim() && Platform.OS === 'web' ? { boxShadow: '0 4px 12px rgba(139,92,246,0.3)' } : {}),
              }]}
              onPress={askTutor}
              disabled={!question.trim() || tutorLoading}
              accessibilityLabel="Send" accessibilityRole="button"
            >
              {tutorLoading ? <ActivityIndicator size="small" color="#fff" /> : <IconSend size={20} color={question.trim() ? '#fff' : (isDark ? '#6b5895' : '#a78bfa')} />}
            </TouchableOpacity>
          </View>

          {tutorResponse ? (
            <View style={[s.tutorResponse, { backgroundColor: isDark ? '#0f0720' : '#faf5ff' }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <IconCheck size={18} color="#22c55e" />
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#22c55e' }}>{t('kids.teacherOne')}</Text>
              </View>
              <Text style={[s.tutorResponseText, { color: isDark ? '#e9d5ff' : '#1e1b4b' }]}>{tutorResponse}</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', padding: 18,
    paddingTop: Platform.OS === 'ios' ? 56 : 18, gap: 10,
  },
  backBtn: { padding: 8, minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  headerEmoji: { fontSize: 24 },
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
  catEmoji: { fontSize: 22, marginRight: 8 },
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
