import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Platform,
  StatusBar,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Simple SVG-free icon components using Unicode/emoji-like text
function IconCircle({ color, size = 64, children }) {
  return (
    <View style={[styles.iconCircle, { width: size, height: size, borderRadius: size / 2, backgroundColor: color + '18' }]}>
      <Text style={{ fontSize: size * 0.45, color }}>{children}</Text>
    </View>
  );
}

function FeatureRow({ icon, text, color, colors }) {
  return (
    <View style={styles.featureRow}>
      <View style={[styles.featureIcon, { backgroundColor: (color || colors.primary) + '15' }]}>
        <Text style={{ fontSize: 18, color: color || colors.primary }}>{icon}</Text>
      </View>
      <Text style={[styles.featureText, { color: colors.text }]}>{text}</Text>
    </View>
  );
}

function StepItem({ number, text, colors }) {
  return (
    <View style={styles.stepRow}>
      <View style={[styles.stepCircle, { backgroundColor: colors.primary }]}>
        <Text style={styles.stepNumber}>{number}</Text>
      </View>
      <Text style={[styles.stepText, { color: colors.text }]}>{text}</Text>
    </View>
  );
}

function PageDots({ total, current, colors }) {
  return (
    <View style={styles.dotsContainer}>
      {Array.from({ length: total }).map((_, i) => (
        <View
          key={i}
          style={[
            styles.dot,
            {
              backgroundColor: i === current ? colors.primary : colors.border,
              width: i === current ? 24 : 8,
            },
          ]}
        />
      ))}
    </View>
  );
}

const TOTAL_PAGES = 6;

export default function ParentalInfoModal({ visible, onClose, onStartCreate }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [currentPage, setCurrentPage] = useState(0);
  const scrollRef = useRef(null);

  // Web: close on Escape so keyboard users have an exit. (No-op on native.)
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const onKey = (ev) => { if (ev.key === 'Escape' && onClose) onClose(); };
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }
  }, [visible, onClose]);

  if (!visible) return null;

  const handleScroll = (e) => {
    const page = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    if (page >= 0 && page < TOTAL_PAGES) setCurrentPage(page);
  };

  const goToPage = (page) => {
    scrollRef.current?.scrollTo({ x: page * SCREEN_WIDTH, animated: true });
    setCurrentPage(page);
  };

  const handleStart = () => {
    if (onStartCreate) onStartCreate();
    if (onClose) onClose();
  };

  const greenAccent = '#16a34a';
  const blueAccent = colors.primary;
  const purpleAccent = '#7c3aed';
  const orangeAccent = '#ea580c';
  const tealAccent = '#0d9488';

  const bgGradient = isDark ? '#0f172a' : '#f0fdf4';
  const cardBg = isDark ? '#1e293b' : '#ffffff';

  return (
    <View style={[styles.overlay, { backgroundColor: isDark ? '#000000ee' : '#000000aa' }]}>
      <StatusBar barStyle="light-content" />
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {/* Skip button */}
        <TouchableOpacity
          style={styles.skipButton}
          onPress={onClose}
          accessibilityLabel={t('parental.onboarding.skip') || 'Pular'}
          accessibilityRole="button"
        >
          <Text style={[styles.skipText, { color: colors.textSecondary }]}>
            {t('parental.onboarding.skip') || 'Pular'}
          </Text>
        </TouchableOpacity>

        {/* Pages */}
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleScroll}
          scrollEventThrottle={16}
          style={styles.scrollView}
          decelerationRate="fast"
          snapToInterval={SCREEN_WIDTH}
          snapToAlignment="start"
        >
          {/* PAGE 1: Protect your child */}
          <View style={[styles.page, { width: SCREEN_WIDTH }]}>
            <ScrollView style={styles.pageScroll} contentContainerStyle={styles.pageContent} showsVerticalScrollIndicator={false}>
              <View style={[styles.heroSection, { backgroundColor: greenAccent + '10' }]}>
                <IconCircle color={greenAccent} size={80}>
                  {'\u{1F6E1}'}
                </IconCircle>
                <Text style={[styles.pageTitle, { color: colors.text }]}>
                  {t('parental.onboarding.protectTitle') || 'Proteja seu filho no Chatyy'}
                </Text>
                <Text style={[styles.pageSubtitle, { color: colors.textSecondary }]}>
                  {t('parental.onboarding.protectSubtitle') || 'O Chatyy oferece controle parental completo para criancas de 6 a 13 anos. Voce tera total controle sobre a experiencia digital do seu filho.'}
                </Text>
              </View>

              <View style={[styles.card, { backgroundColor: cardBg }]}>
                <FeatureRow icon={'\u{1F4AC}'} text={t('parental.onboarding.feat1') || 'Monitore todas as conversas'} colors={colors} color={blueAccent} />
                <FeatureRow icon={'\u{1F4DE}'} text={t('parental.onboarding.feat2') || 'Veja o historico de chamadas'} colors={colors} color={purpleAccent} />
                <FeatureRow icon={'\u{1F465}'} text={t('parental.onboarding.feat3') || 'Controle quem pode entrar em contato'} colors={colors} color={orangeAccent} />
                <FeatureRow icon={'\u{23F1}'} text={t('parental.onboarding.feat4') || 'Defina limites de tempo de uso'} colors={colors} color={tealAccent} />
                <FeatureRow icon={'\u{1F4CD}'} text={t('parental.onboarding.feat5') || 'Localizacao em tempo real 24h'} colors={colors} color={'#dc2626'} />
                <FeatureRow icon={'\u{1F916}'} text={t('parental.onboarding.feat6') || 'Resumos diarios com IA'} colors={colors} color={greenAccent} />
              </View>
            </ScrollView>
          </View>

          {/* PAGE 2: How it works */}
          <View style={[styles.page, { width: SCREEN_WIDTH }]}>
            <ScrollView style={styles.pageScroll} contentContainerStyle={styles.pageContent} showsVerticalScrollIndicator={false}>
              <View style={[styles.heroSection, { backgroundColor: blueAccent + '10' }]}>
                <IconCircle color={blueAccent} size={80}>
                  {'\u{2699}'}
                </IconCircle>
                <Text style={[styles.pageTitle, { color: colors.text }]}>
                  {t('parental.onboarding.howTitle') || 'Como funciona'}
                </Text>
              </View>

              <View style={[styles.card, { backgroundColor: cardBg }]}>
                <StepItem number="1" text={t('parental.onboarding.step1') || 'Voce cria a conta do seu filho (nome, data de nascimento)'} colors={colors} />
                <StepItem number="2" text={t('parental.onboarding.step2') || 'Envia um documento de identidade (RG, Certidao de Nascimento, Termo de Guarda)'} colors={colors} />
                <StepItem number="3" text={t('parental.onboarding.step3') || 'Nossa IA analisa o documento automaticamente'} colors={colors} />
                <StepItem number="4" text={t('parental.onboarding.step4') || 'Conta ativada! Seu filho recebe email e senha para entrar'} colors={colors} />
              </View>

              <View style={[styles.timeNote, { backgroundColor: greenAccent + '12' }]}>
                <Text style={[styles.timeNoteText, { color: greenAccent }]}>
                  {'\u{26A1}'} {t('parental.onboarding.twoMinutes') || 'Todo o processo leva menos de 2 minutos'}
                </Text>
              </View>
            </ScrollView>
          </View>

          {/* PAGE 3: What you can monitor */}
          <View style={[styles.page, { width: SCREEN_WIDTH }]}>
            <ScrollView style={styles.pageScroll} contentContainerStyle={styles.pageContent} showsVerticalScrollIndicator={false}>
              <View style={[styles.heroSection, { backgroundColor: purpleAccent + '10' }]}>
                <IconCircle color={purpleAccent} size={80}>
                  {'\u{1F440}'}
                </IconCircle>
                <Text style={[styles.pageTitle, { color: colors.text }]}>
                  {t('parental.onboarding.monitorTitle') || 'O que voce pode monitorar'}
                </Text>
              </View>

              <View style={[styles.card, { backgroundColor: cardBg }]}>
                <FeatureRow icon={'\u{1F4AC}'} text={t('parental.onboarding.mon1') || 'Conversas: Leia todas as mensagens do seu filho (somente leitura)'} colors={colors} color={blueAccent} />
                <FeatureRow icon={'\u{1F4DE}'} text={t('parental.onboarding.mon2') || 'Chamadas: Veja quem ligou e por quanto tempo'} colors={colors} color={purpleAccent} />
                <FeatureRow icon={'\u{1F465}'} text={t('parental.onboarding.mon3') || 'Contatos: Defina uma lista de contatos permitidos'} colors={colors} color={orangeAccent} />
                <FeatureRow icon={'\u{1F4F1}'} text={t('parental.onboarding.mon4') || 'Tempo de tela: Veja quanto tempo seu filho usa o app por dia'} colors={colors} color={tealAccent} />
                <FeatureRow icon={'\u{1F553}'} text={t('parental.onboarding.mon5') || 'Horarios: Defina horarios permitidos (ex: 8h-21h)'} colors={colors} color={greenAccent} />
                <FeatureRow icon={'\u{1F4CD}'} text={t('parental.onboarding.mon6') || 'Localização: Saiba onde seu filho esta em tempo real, 24 horas'} colors={colors} color={'#dc2626'} />
                <FeatureRow icon={'\u{1F514}'} text={t('parental.onboarding.mon7') || 'Alertas IA: Receba alertas automaticos sobre atividades suspeitas'} colors={colors} color={'#d97706'} />
              </View>
            </ScrollView>
          </View>

          {/* PAGE 4: At age 13 */}
          <View style={[styles.page, { width: SCREEN_WIDTH }]}>
            <ScrollView style={styles.pageScroll} contentContainerStyle={styles.pageContent} showsVerticalScrollIndicator={false}>
              <View style={[styles.heroSection, { backgroundColor: orangeAccent + '10' }]}>
                <IconCircle color={orangeAccent} size={80}>
                  {'\u{1F382}'}
                </IconCircle>
                <Text style={[styles.pageTitle, { color: colors.text }]}>
                  {t('parental.onboarding.thirteenTitle') || 'Aos 13 anos'}
                </Text>
                <Text style={[styles.pageSubtitle, { color: colors.textSecondary }]}>
                  {t('parental.onboarding.thirteenSubtitle') || 'Quando seu filho completar 13 anos, a conta automaticamente se torna uma conta normal.'}
                </Text>
              </View>

              <View style={[styles.card, { backgroundColor: cardBg }]}>
                <FeatureRow icon={'\u{1F514}'} text={t('parental.onboarding.grad1') || 'Voce recebe uma notificacao'} colors={colors} color={blueAccent} />
                <FeatureRow icon={'\u{1F6D1}'} text={t('parental.onboarding.grad2') || 'O monitoramento e desativado'} colors={colors} color={orangeAccent} />
                <FeatureRow icon={'\u{1F512}'} text={t('parental.onboarding.grad3') || 'Seu filho ganha total privacidade'} colors={colors} color={greenAccent} />
                <FeatureRow icon={'\u{2705}'} text={t('parental.onboarding.grad4') || 'As restricoes sao removidas'} colors={colors} color={purpleAccent} />
                <FeatureRow icon={'\u{1F4E7}'} text={t('parental.onboarding.grad5') || 'A conta continua funcionando normalmente'} colors={colors} color={tealAccent} />
              </View>

              <View style={[styles.legalNote, { backgroundColor: colors.surfaceVariant }]}>
                <Text style={[styles.legalNoteText, { color: colors.textSecondary }]}>
                  {t('parental.onboarding.legalNote') || 'Esta e a idade minima recomendada pela legislacao brasileira (LGPD) e internacional (COPPA).'}
                </Text>
              </View>
            </ScrollView>
          </View>

          {/* PAGE 5: 24h Location */}
          <View style={[styles.page, { width: SCREEN_WIDTH }]}>
            <ScrollView style={styles.pageScroll} contentContainerStyle={styles.pageContent} showsVerticalScrollIndicator={false}>
              <View style={[styles.heroSection, { backgroundColor: '#dc2626' + '10' }]}>
                <IconCircle color={'#dc2626'} size={80}>
                  {'\u{1F5FA}'}
                </IconCircle>
                <Text style={[styles.pageTitle, { color: colors.text }]}>
                  {t('parental.onboarding.locationTitle') || 'Localizacao 24h'}
                </Text>
                <Text style={[styles.pageSubtitle, { color: colors.textSecondary }]}>
                  {t('parental.onboarding.locationSubtitle') || 'Com a permissao de localizacao ativada no celular do seu filho, voce pode:'}
                </Text>
              </View>

              <View style={[styles.card, { backgroundColor: cardBg }]}>
                <FeatureRow icon={'\u{1F4CD}'} text={t('parental.onboarding.loc1') || 'Ver a localizacao em tempo real no mapa'} colors={colors} color={'#dc2626'} />
                <FeatureRow icon={'\u{1F6A8}'} text={t('parental.onboarding.loc2') || 'Receber alertas quando sair de areas seguras (geofencing)'} colors={colors} color={orangeAccent} />
                <FeatureRow icon={'\u{1F4C5}'} text={t('parental.onboarding.loc3') || 'Ver o historico de locais visitados'} colors={colors} color={blueAccent} />
                <FeatureRow icon={'\u{1F4A4}'} text={t('parental.onboarding.loc4') || 'Tudo de forma discreta — seu filho nao recebe notificacao'} colors={colors} color={purpleAccent} />
              </View>

              <View style={[styles.privacyNote, { backgroundColor: greenAccent + '10' }]}>
                <Text style={[styles.privacyIcon]}>{'\u{1F512}'}</Text>
                <Text style={[styles.privacyText, { color: greenAccent }]}>
                  {t('parental.onboarding.locPrivacy') || 'A localizacao e criptografada e so voce tem acesso.'}
                </Text>
              </View>
            </ScrollView>
          </View>

          {/* PAGE 6: Let's start */}
          <View style={[styles.page, { width: SCREEN_WIDTH }]}>
            <View style={[styles.pageScroll, styles.pageContent, styles.centerContent]}>
              <View style={[styles.heroSection, { backgroundColor: greenAccent + '10' }]}>
                <IconCircle color={greenAccent} size={96}>
                  {'\u{1F680}'}
                </IconCircle>
                <Text style={[styles.pageTitle, { color: colors.text, fontSize: 28 }]}>
                  {t('parental.onboarding.startTitle') || 'Vamos comecar!'}
                </Text>
              </View>

              <TouchableOpacity
                style={[styles.startButton, { backgroundColor: greenAccent }]}
                onPress={handleStart}
                accessibilityLabel={t('parental.onboarding.createButton') || 'Criar conta para meu filho'}
                accessibilityRole="button"
                activeOpacity={0.85}
              >
                <Text style={styles.startButtonText}>
                  {t('parental.onboarding.createButton') || 'Criar conta para meu filho'}
                </Text>
              </TouchableOpacity>

              <Text style={[styles.docNote, { color: colors.textSecondary }]}>
                {t('parental.onboarding.docNote') || 'Voce precisara de um documento de identidade'}
              </Text>
            </View>
          </View>
        </ScrollView>

        {/* Bottom: pagination dots + next button */}
        <View style={[styles.bottomBar, { borderTopColor: colors.border }]}>
          <PageDots total={TOTAL_PAGES} current={currentPage} colors={colors} />
          {currentPage < TOTAL_PAGES - 1 && (
            <TouchableOpacity
              style={[styles.nextButton, { backgroundColor: colors.primary }]}
              onPress={() => goToPage(currentPage + 1)}
              accessibilityRole="button"
            >
              <Text style={styles.nextButtonText}>
                {t('parental.onboarding.next') || 'Proximo'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    flex: 1,
    width: '100%',
    maxWidth: 500,
    alignSelf: 'center',
    ...(Platform.OS === 'web' ? { height: '100vh' } : {}),
  },
  skipButton: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 56 : 16,
    right: 16,
    zIndex: 10,
    padding: 8,
  },
  skipText: {
    fontSize: 15,
    fontWeight: '500',
  },
  scrollView: {
    flex: 1,
  },
  page: {
    flex: 1,
  },
  pageScroll: {
    flex: 1,
  },
  pageContent: {
    paddingHorizontal: 24,
    paddingTop: Platform.OS === 'ios' ? 72 : 48,
    paddingBottom: 24,
  },
  centerContent: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroSection: {
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 16,
    borderRadius: 20,
    marginBottom: 24,
  },
  iconCircle: {
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  pageTitle: {
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
    lineHeight: 32,
  },
  pageSubtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    paddingHorizontal: 8,
  },
  card: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8 },
      android: { elevation: 3 },
      web: { boxShadow: '0 2px 8px rgba(0,0,0,0.08)' },
    }),
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
  },
  featureIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  featureText: {
    fontSize: 15,
    flex: 1,
    lineHeight: 21,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 12,
  },
  stepCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  stepNumber: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  stepText: {
    fontSize: 15,
    flex: 1,
    lineHeight: 21,
    paddingTop: 5,
  },
  timeNote: {
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  timeNoteText: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  legalNote: {
    borderRadius: 12,
    padding: 16,
    marginTop: 8,
  },
  legalNoteText: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    fontStyle: 'italic',
  },
  privacyNote: {
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  privacyIcon: {
    fontSize: 20,
    marginRight: 10,
  },
  privacyText: {
    fontSize: 14,
    flex: 1,
    fontWeight: '500',
    lineHeight: 20,
  },
  startButton: {
    paddingVertical: 18,
    paddingHorizontal: 48,
    borderRadius: 16,
    marginTop: 24,
    minWidth: 280,
    alignItems: 'center',
  },
  startButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  docNote: {
    fontSize: 13,
    marginTop: 16,
    textAlign: 'center',
  },
  bottomBar: {
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dotsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    height: 8,
    borderRadius: 4,
  },
  nextButton: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 12,
  },
  nextButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
