import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput, Animated,
  ActivityIndicator, Platform, Alert, Modal, useWindowDimensions, Linking, Easing,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconArrowLeft, IconStar, IconStarFilled, IconCheck, IconChevronDown, IconChevronUp,
  IconX, IconSparkles, IconUsers, IconShield, IconPlus, IconTrash,
  IconArchive, IconCloud, IconRefresh, IconPaperclip, IconSmartphone,
  IconMessageSquare, IconPhone, IconMail, IconCalendar, IconBell,
  IconFileText, IconArrowRight, IconImage, IconSettings, IconLink,
} from '../components/Icons';

const STRIPE_PK = 'pk_live_51T0hKGCEHBjnf15zZqr1xJdsIoKNmL7MrxhJEM8VLVXJ6qJHpskJ0qhS3gmyLxSY1v4vJEzKg2ON7TgIqjAQyj8G00FtweDczV';

const safeAlert = (title, message, buttons) => {
  if (Platform.OS === 'web') {
    if (buttons?.length) {
      const ok = buttons.find(b => b.style !== 'cancel');
      if (ok?.onPress && window.confirm(`${title}\n${message || ''}`)) ok.onPress();
    } else { window.alert(message || title); }
  } else { Alert.alert(title, message, buttons); }
};

// ============================================================
// ONE AI SHOWCASE — Animated flipping text
// ============================================================
const ONE_AI_ACTIONS = [
  'mandar emails',
  'montar planilhas',
  'fazer ligações',
  'enviar WhatsApp',
  'agendar reuniões',
  'criar lembretes',
  'resumir documentos',
  'escrever textos',
  'organizar sua agenda',
  'gerenciar contatos',
  'responder mensagens',
  'criar apresentações',
  'analisar dados',
  'fazer pesquisas',
  'traduzir textos',
  'rascunhar respostas',
  'agendar compromissos',
  'enviar notificações',
  'criar relatórios',
  'organizar arquivos',
  'calcular orçamentos',
  'planejar viagens',
  'sugerir restaurantes',
  'acompanhar entregas',
  'monitorar preços',
  'gerenciar senhas',
  'criar listas de tarefas',
  'programar pagamentos',
  'verificar clima',
  'buscar receitas',
  'converter moedas',
  'resumir notícias',
  'agendar médico',
  'controlar gastos',
  'criar convites',
  'editar fotos',
  'transcrever áudios',
  'gerar QR codes',
  'comparar produtos',
  'rastrear encomendas',
  'organizar eventos',
  'fazer backup',
  'configurar alarmes',
  'sugerir presentes',
  'planejar cardápio',
  'controlar dieta',
  'acompanhar treinos',
  'gerenciar assinaturas',
  'automatizar tarefas',
  'e muito mais...',
];

function OneAIShowcase({ colors, isDark, t }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(0)).current;
  const glowAnim = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    // Pulsing glow effect
    Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(glowAnim, { toValue: 0.4, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      ])
    ).start();
  }, []);

  useEffect(() => {
    if (showAll) return;
    const interval = setInterval(() => {
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 0, duration: 250, easing: Easing.out(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(slideAnim, { toValue: -24, duration: 250, easing: Easing.out(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      ]).start(() => {
        setCurrentIndex(prev => (prev + 1) % ONE_AI_ACTIONS.length);
        slideAnim.setValue(24);
        Animated.parallel([
          Animated.timing(fadeAnim, { toValue: 1, duration: 350, easing: Easing.out(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
          Animated.timing(slideAnim, { toValue: 0, duration: 350, easing: Easing.out(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        ]).start();
      });
    }, 2200);
    return () => clearInterval(interval);
  }, [showAll]);

  const AI_DEMOS = [
    { Icon: IconMessageSquare, color: '#25D366', title: 'WhatsApp', desc: t('plans.aiWhatsapp') },
    { Icon: IconPhone, color: '#3b82f6', title: t('plans.cancel').includes('Cancelar') ? 'Liga\u00E7\u00F5es' : 'Calls', desc: t('plans.aiCalls') },
    { Icon: IconMail, color: '#ef4444', title: 'Emails', desc: t('plans.aiEmails') },
    { Icon: IconCalendar, color: '#f59e0b', title: t('plans.cancel').includes('Cancelar') ? 'Agenda' : 'Calendar', desc: t('plans.cancel').includes('Cancelar') ? 'Gerencia compromissos' : 'Manages appointments' },
    { Icon: IconBell, color: '#8b5cf6', title: t('plans.cancel').includes('Cancelar') ? 'Lembretes' : 'Reminders', desc: t('plans.cancel').includes('Cancelar') ? 'Avisa na hora certa' : 'Alerts at the right time' },
    { Icon: IconFileText, color: '#06b6d4', title: t('plans.cancel').includes('Cancelar') ? 'Documentos' : 'Documents', desc: t('plans.cancel').includes('Cancelar') ? 'Cria textos e planilhas' : 'Creates docs & sheets' },
  ];

  return (
    <View style={{
      marginTop: 20,
      borderRadius: 20,
      overflow: 'hidden',
    }}>
      {/* Dark gradient header */}
      <View style={{
        backgroundColor: isDark ? '#0f0a1e' : '#1a1035',
        paddingVertical: 28,
        paddingHorizontal: 24,
        alignItems: 'center',
      }}>
        {/* Glow circle behind icon */}
        <Animated.View style={{
          width: 56, height: 56, borderRadius: 28,
          backgroundColor: 'rgba(139, 92, 246, 0.25)',
          alignItems: 'center', justifyContent: 'center',
          marginBottom: 14,
          opacity: glowAnim,
          ...(Platform.OS === 'web' ? {
            boxShadow: '0 0 30px rgba(139, 92, 246, 0.5), 0 0 60px rgba(99, 102, 241, 0.3)',
          } : {}),
        }}>
          <View style={{
            width: 56, height: 56, borderRadius: 28,
            backgroundColor: 'rgba(139, 92, 246, 0.3)',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <IconSparkles size={28} color="#c4b5fd" />
          </View>
        </Animated.View>
        <Text style={{
          color: '#e9d5ff',
          fontSize: 24,
          fontWeight: '800',
          textAlign: 'center',
          letterSpacing: 0.5,
          textShadowColor: 'rgba(139, 92, 246, 0.6)',
          textShadowOffset: { width: 0, height: 0 },
          textShadowRadius: 20,
        }}>
          One AI
        </Text>
        <Text style={{ color: 'rgba(196, 181, 253, 0.8)', fontSize: 13, textAlign: 'center', marginTop: 6 }}>
          Sua assistente pessoal vai te ajudar a...
        </Text>

        {/* Flipping text */}
        {!showAll && (
          <View style={{ alignItems: 'center' }}>
            <Animated.View style={{
              marginTop: 14,
              opacity: fadeAnim,
              transform: [{ translateY: slideAnim }],
              minHeight: 34,
              justifyContent: 'center',
            }}>
              <Text style={{
                color: '#fff',
                fontSize: 20,
                fontWeight: '700',
                textAlign: 'center',
                textShadowColor: 'rgba(139, 92, 246, 0.5)',
                textShadowOffset: { width: 0, height: 2 },
                textShadowRadius: 10,
              }}>
                {ONE_AI_ACTIONS[currentIndex]}
              </Text>
            </Animated.View>
            {/* Animated gradient line indicator */}
            <Animated.View style={{
              marginTop: 10,
              width: 48,
              height: 3,
              borderRadius: 1.5,
              opacity: glowAnim,
              backgroundColor: '#8b5cf6',
              ...(Platform.OS === 'web' ? {
                backgroundImage: 'linear-gradient(90deg, #6366f1, #c4b5fd, #8b5cf6)',
              } : {}),
            }} />
          </View>
        )}

        {/* 3-column AI feature grid */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 20, width: '100%' }}>
          {AI_DEMOS.map((demo, i) => (
            <View key={i} style={{
              width: '31%',
              backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.08)',
              borderRadius: 12,
              padding: 12,
              alignItems: 'center',
              gap: 6,
              borderWidth: 1,
              borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(139, 92, 246, 0.12)',
            }}>
              <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: demo.color + '15', alignItems: 'center', justifyContent: 'center' }}>
                <demo.Icon size={20} color={demo.color} />
              </View>
              <Text style={{ color: '#e9d5ff', fontSize: 12, fontWeight: '600', textAlign: 'center' }}>{demo.title}</Text>
              <Text style={{ color: 'rgba(196,181,253,0.6)', fontSize: 10, textAlign: 'center', lineHeight: 13 }}>{demo.desc}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Show all / collapse */}
      <TouchableOpacity
        style={{
          backgroundColor: isDark ? 'rgba(139,92,246,0.08)' : 'rgba(139,92,246,0.05)',
          paddingVertical: 13,
          paddingHorizontal: 20,
          alignItems: 'center',
          flexDirection: 'row',
          justifyContent: 'center',
          gap: 6,
        }}
        onPress={() => setShowAll(!showAll)}
        activeOpacity={0.7}
      >
        <Text style={{ color: '#8b5cf6', fontSize: 13, fontWeight: '600' }}>
          {showAll ? t('plans.collapseFeatures') : t('plans.viewAllFeatures')}
        </Text>
        {showAll ? <IconChevronUp size={14} color="#8b5cf6" /> : <IconChevronDown size={14} color="#8b5cf6" />}
      </TouchableOpacity>

      {/* Expanded list */}
      {showAll && (
        <View style={{
          backgroundColor: isDark ? 'rgba(139,92,246,0.04)' : '#faf8ff',
          paddingHorizontal: 16,
          paddingBottom: 16,
        }}>
          {ONE_AI_ACTIONS.map((action, i) => (
            <View key={i} style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingVertical: 8,
              borderBottomWidth: i < ONE_AI_ACTIONS.length - 1 ? StyleSheet.hairlineWidth : 0,
              borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
            }}>
              <View style={{
                width: 26, height: 26, borderRadius: 13,
                backgroundColor: 'rgba(139,92,246,0.12)',
                alignItems: 'center', justifyContent: 'center',
                marginRight: 12,
              }}>
                <IconCheck size={12} color="#8b5cf6" />
              </View>
              <Text style={{ color: colors.text, fontSize: 14, flex: 1, textTransform: 'capitalize' }}>
                {action}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// Detect card brand from number prefix
function detectCardBrand(num) {
  const n = num.replace(/\s/g, '');
  if (/^4/.test(n)) return 'visa';
  if (/^5[1-5]/.test(n) || /^2[2-7]/.test(n)) return 'mastercard';
  if (/^3[47]/.test(n)) return 'amex';
  if (/^6(?:011|5)/.test(n)) return 'discover';
  if (/^(?:636|504|509|606282)/.test(n)) return 'elo';
  return null;
}

// Card brand display
function CardBrandIcon({ brand, size = 28, large = false }) {
  const labels = { visa: 'VISA', mastercard: 'MC', amex: 'AMEX', discover: 'DISC', elo: 'ELO' };
  const bgColors = { visa: '#1a1f71', mastercard: '#eb001b', amex: '#006fcf', discover: '#ff6600', elo: '#00a4e0' };
  if (!brand) return null;
  const fontSize = large ? 14 : size * 0.4;
  const px = large ? 10 : 6;
  const py = large ? 5 : 2;
  const br = large ? 6 : 4;
  return (
    <View style={{ backgroundColor: bgColors[brand] || '#666', borderRadius: br, paddingHorizontal: px, paddingVertical: py, marginRight: 8 }}>
      <Text style={{ color: '#fff', fontSize, fontWeight: '800', letterSpacing: 0.5 }}>{labels[brand] || brand?.toUpperCase() || ''}</Text>
    </View>
  );
}

// Animated checkmark for success state
function AnimatedCheckmark({ color, size = 72 }) {
  const scaleAnim = useRef(new Animated.Value(0)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.delay(100),
      Animated.parallel([
        Animated.spring(scaleAnim, { toValue: 1, friction: 4, tension: 100, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(opacityAnim, { toValue: 1, duration: 300, useNativeDriver: Platform.OS !== 'web' }),
      ]),
    ]).start();
  }, []);
  return (
    <Animated.View style={{ opacity: opacityAnim, transform: [{ scale: scaleAnim }], width: size, height: size, borderRadius: size / 2, backgroundColor: color + '18', alignItems: 'center', justifyContent: 'center' }}>
      <IconCheck size={size * 0.5} color={color} />
    </Animated.View>
  );
}

// Spinning loader for payment processing
function SpinningLoader({ color = '#fff', size = 20 }) {
  const spinAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.timing(spinAnim, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: Platform.OS !== 'web' })
    ).start();
  }, []);
  const spin = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 2.5, borderColor: color + '40', borderTopColor: color, transform: [{ rotate: spin }] }} />
  );
}

// Apple Pay / Google Pay styled button
function WalletPayButton({ type, onPress, colors, isDark, planLabel, price }) {
  const isApple = type === 'applePay';
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={{
        backgroundColor: isApple ? '#000' : '#fff',
        borderRadius: 14,
        height: 52,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 6,
        borderWidth: isApple ? 0 : 1,
        borderColor: isDark ? 'rgba(255,255,255,0.2)' : '#dadce0',
        ...Shadow.sm,
      }}
    >
      {isApple ? (
        <Text style={{ color: '#fff', fontSize: 18, fontWeight: '500', letterSpacing: 0.3 }}>
          {'\uF8FF'} Pay
        </Text>
      ) : (
        <Text style={{ fontSize: 17, fontWeight: '500', color: '#3c4043' }}>
          <Text style={{ color: '#4285F4' }}>G</Text>
          <Text style={{ color: '#EA4335' }}>o</Text>
          <Text style={{ color: '#FBBC05' }}>o</Text>
          <Text style={{ color: '#4285F4' }}>g</Text>
          <Text style={{ color: '#34A853' }}>l</Text>
          <Text style={{ color: '#EA4335' }}>e</Text>
          <Text style={{ color: '#3c4043' }}> Pay</Text>
        </Text>
      )}
    </TouchableOpacity>
  );
}

// Format card number with spaces every 4 digits
function formatCardNumber(raw) {
  const digits = raw.replace(/\D/g, '').slice(0, 16);
  return digits.replace(/(.{4})/g, '$1 ').trim();
}

// Format expiry as MM/YY
function formatExpiry(raw) {
  const digits = raw.replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) return digits;
  return digits.slice(0, 2) + '/' + digits.slice(2);
}

// Format date as dd/mm/yyyy
function formatDateBR(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

// Format amount from centavos to R$X,XX
function formatBRL(centavos) {
  const val = (centavos / 100).toFixed(2).replace('.', ',');
  return `R$${val}`;
}

// Plan pricing and feature config
const PLANS = {
  free: { price: 0, storage: 15, maxFile: 25, mediaRetention: 30 },
  one: { price: 12.99, storage: 200, maxFile: 100, mediaRetention: null },
  plus: { price: 12.99, storage: 200, maxFile: 100, mediaRetention: null }, // backward compat
  family: { price: 19.99, storage: 500, maxFile: 100, mediaRetention: null, maxMembers: 5 },
};

// Pricing in centavos: monthly and annual (per month)
const PRICING = {
  one: { monthly: 1299, annual: 999 },      // R$12.99/mo or R$9.99/mo (billed R$119.88/yr)
  family: { monthly: 1999, annual: 1499 },   // R$19.99/mo or R$14.99/mo (billed R$179.88/yr)
};

// Storage add-on prices
const STORAGE_EXTRA = {
  500: { monthly: 499, annual: 399 },
  1000: { monthly: 1499, annual: 1199 },
  2000: { monthly: 2499, annual: 1999 },
};

// Storage tier options per plan (extra = price in centavos on top of base plan)
const STORAGE_OPTIONS_ONE = [
  { gb: 200, extra: 0, label: '200GB', included: true },
  { gb: 500, extra: 499, label: '500GB' },
  { gb: 1000, extra: 1499, label: '1TB' },
  { gb: 2000, extra: 2499, label: '2TB' },
];

const STORAGE_OPTIONS_FAMILY = [
  { gb: 500, extra: 0, label: '500GB', included: true },
  { gb: 1000, extra: 999, label: '1TB' },
  { gb: 2000, extra: 1999, label: '2TB' },
];

// Get storage options adjusted for billing period
function getStorageOptions(plan, billingPeriod) {
  const base = plan === 'family' ? STORAGE_OPTIONS_FAMILY : STORAGE_OPTIONS_ONE;
  if (billingPeriod === 'monthly') return base;
  return base.map(opt => {
    if (opt.included) return opt;
    const annualExtra = STORAGE_EXTRA[opt.gb]?.[billingPeriod] || opt.extra;
    return { ...opt, extra: annualExtra };
  });
}

// Load Stripe.js dynamically (web only)
let stripePromise = null;
function loadStripeJs() {
  if (stripePromise) return stripePromise;
  if (Platform.OS !== 'web') return Promise.resolve(null);
  stripePromise = new Promise((resolve, reject) => {
    if (window.Stripe) { resolve(window.Stripe(STRIPE_PK)); return; }
    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3/';
    script.onload = () => resolve(window.Stripe(STRIPE_PK));
    script.onerror = () => reject(new Error('Failed to load Stripe.js'));
    document.head.appendChild(script);
  });
  return stripePromise;
}

export default function PlansScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isDesktop = width > 768;

  const [loading, setLoading] = useState(true);
  const [planInfo, setPlanInfo] = useState(null);
  const [familyMembers, setFamilyMembers] = useState([]);
  const [upgrading, setUpgrading] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [addingMember, setAddingMember] = useState(false);
  const [expandedFaq, setExpandedFaq] = useState(null);

  // Payment modal state
  const [paymentModal, setPaymentModal] = useState(null);
  const [savedCard, setSavedCard] = useState(null); // {brand, last4, exp_month, exp_year, payment_method_id}
  const [useSavedCard, setUseSavedCard] = useState(true);
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvc, setCardCvc] = useState('');
  const [cardName, setCardName] = useState('');
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [paymentError, setPaymentError] = useState('');
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  const [walletPayAvailable, setWalletPayAvailable] = useState(null); // null | { applePay: bool, googlePay: bool }
  const paymentRequestRef = useRef(null);

  // Billing period toggle
  const [billingPeriod, setBillingPeriod] = useState('monthly');

  // Storage tier selection state
  const [selectedStorageOne, setSelectedStorageOne] = useState(STORAGE_OPTIONS_ONE[0]);
  const [selectedStorageFamily, setSelectedStorageFamily] = useState(STORAGE_OPTIONS_FAMILY[0]);

  // Modal animation refs
  const modalScaleAnim = useRef(new Animated.Value(0.9)).current;
  const modalOpacityAnim = useRef(new Animated.Value(0)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const errorBannerAnim = useRef(new Animated.Value(0)).current;

  // Subscription management state
  const [subInfo, setSubInfo] = useState(null);
  const [subLoading, setSubLoading] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [reactivateLoading, setReactivateLoading] = useState(false);

  // Stripe Elements refs (web only)
  const stripeRef = useRef(null);
  const cardElementRef = useRef(null);
  const cardMountRef = useRef(null);

  // Auto-advance refs for mobile card fields
  const expiryInputRef = useRef(null);
  const cvcInputRef = useRef(null);
  const nameInputRef = useRef(null);

  const searchParams = useLocalSearchParams();
  const [successShown, setSuccessShown] = useState(false);

  const currentPlan = planInfo?.plan || 'free';
  const nextBilling = planInfo?.next_billing || null;
  const storageUsedBytes = planInfo?.storage_used || 0;
  const storageUsed = storageUsedBytes / (1024 * 1024 * 1024); // bytes → GB
  const storageTotal = PLANS[currentPlan]?.storage || 20;
  const isAdmin = !planInfo?.family_admin; // null = you're the admin (you pay)
  const familyAdmin = planInfo?.family_admin || null; // email of admin if you're a member

  // Handle ?success=1 or ?cancelled=1 from Stripe redirect (legacy)
  useEffect(() => {
    if (searchParams?.success === '1' && !successShown) {
      setSuccessShown(true);
      safeAlert('Assinatura ativada!', 'Seu plano foi ativado com sucesso. Aproveite os beneficios premium!');
      loadPlanInfo();
    } else if (searchParams?.cancelled === '1' && !successShown) {
      setSuccessShown(true);
    }
  }, [searchParams]);

  const loadPlanInfo = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.planInfo();
      if (res?.data) setPlanInfo(res.data);
    } catch (e) { /* silent */ }
    finally { setLoading(false); }
  }, []);

  const loadSubscriptionInfo = useCallback(async () => {
    if (currentPlan === 'free') { setSubInfo(null); return; }
    try {
      setSubLoading(true);
      const res = await api.stripeSubscriptionInfo();
      if (res?.success && res?.data) {
        setSubInfo(res.data);
      }
    } catch (e) { /* silent */ }
    finally { setSubLoading(false); }
  }, [currentPlan]);

  const loadFamilyMembers = useCallback(async () => {
    if (currentPlan !== 'family') return;
    try {
      const res = await api.planFamilyList();
      if (res?.data?.members) setFamilyMembers(res.data.members);
    } catch (e) { /* silent */ }
  }, [currentPlan]);

  useEffect(() => { loadPlanInfo(); }, [loadPlanInfo]);
  useEffect(() => { loadSubscriptionInfo(); }, [loadSubscriptionInfo]);
  useEffect(() => { loadFamilyMembers(); }, [loadFamilyMembers]);

  // Animate modal in when opening
  useEffect(() => {
    if (paymentModal) {
      modalScaleAnim.setValue(0.9);
      modalOpacityAnim.setValue(0);
      Animated.parallel([
        Animated.spring(modalScaleAnim, { toValue: 1, friction: 8, tension: 100, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(modalOpacityAnim, { toValue: 1, duration: 250, useNativeDriver: Platform.OS !== 'web' }),
      ]).start();
    }
  }, [paymentModal]);

  // Animate error shake
  useEffect(() => {
    if (paymentError) {
      errorBannerAnim.setValue(0);
      Animated.timing(errorBannerAnim, { toValue: 1, duration: 300, useNativeDriver: Platform.OS !== 'web' }).start();
      // Shake animation
      Animated.sequence([
        Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(shakeAnim, { toValue: 8, duration: 50, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(shakeAnim, { toValue: -8, duration: 50, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(shakeAnim, { toValue: 4, duration: 50, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: Platform.OS !== 'web' }),
      ]).start();
    }
  }, [paymentError]);

  // Mount Stripe Card Element + PaymentRequest when payment modal opens (web only)
  useEffect(() => {
    if (!paymentModal || Platform.OS !== 'web') return;
    let cancelled = false;
    const mountCard = async () => {
      try {
        const stripe = await loadStripeJs();
        if (cancelled || !stripe) return;
        stripeRef.current = stripe;

        // Setup PaymentRequest (Apple Pay / Google Pay) for subscribe mode
        if (paymentModal.mode === 'subscribe') {
          try {
            const pmBp = paymentModal.billingPeriod || 'monthly';
            const storageExtra = paymentModal.storage?.extra || 0;
            const pmBase = PRICING[paymentModal.plan]?.[pmBp] || (paymentModal.plan === 'family' ? 1999 : 1299);
            const planPrice = pmBp === 'annual' ? ((pmBase + storageExtra) * 12) : (pmBase + storageExtra);
            const planLabel = paymentModal.plan === 'family' ? 'Chatyy Família' : 'Chatyy One';
            const pr = stripe.paymentRequest({
              country: 'BR',
              currency: 'brl',
              total: { label: planLabel, amount: planPrice },
              requestPayerName: true,
              requestPayerEmail: true,
            });
            const canMake = await pr.canMakePayment();
            if (!cancelled && canMake) {
              setWalletPayAvailable(canMake);
              paymentRequestRef.current = pr;
              pr.on('paymentmethod', async (ev) => {
                try {
                  const storageOpts = paymentModal.storage ? { storage_gb: paymentModal.storage.gb, extra_price: paymentModal.storage.extra } : undefined;
                  const result = await api.stripeSubscribe(paymentModal.plan, ev.paymentMethod.id, storageOpts, paymentModal.billingPeriod || 'monthly');
                  if (result?.data?.requires_action) {
                    const { error } = await stripe.confirmCardPayment(result.data.client_secret);
                    if (error) {
                      ev.complete('fail');
                      setPaymentError(error.message);
                      return;
                    }
                  }
                  if (result?.success || result?.data?.requires_action) {
                    ev.complete('success');
                    setPaymentSuccess(true);
                    await loadPlanInfo();
                  } else {
                    ev.complete('fail');
                    setPaymentError(result?.message || t('plans.paymentFailed'));
                  }
                } catch (e) {
                  ev.complete('fail');
                  setPaymentError(e.message || t('plans.paymentFailed'));
                }
              });
            } else {
              if (!cancelled) setWalletPayAvailable(null);
            }
          } catch (e) {
            console.log('PaymentRequest not available:', e.message);
            if (!cancelled) setWalletPayAvailable(null);
          }
        }

        // Wait for DOM mount
        const waitForMount = () => new Promise((resolve) => {
          const check = () => {
            const el = document.getElementById('stripe-card-element');
            if (el) { resolve(el); return; }
            setTimeout(check, 50);
          };
          check();
        });
        const mountEl = await waitForMount();
        if (cancelled) return;
        const elements = stripe.elements();
        const cardElement = elements.create('card', {
          style: {
            base: {
              fontSize: '17px',
              color: isDark ? '#e5e7eb' : '#1f2937',
              fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", Menlo, Consolas, monospace',
              letterSpacing: '1px',
              '::placeholder': { color: isDark ? '#6b7280' : '#9ca3af' },
              iconColor: isDark ? '#9ca3af' : '#6b7280',
            },
            invalid: { color: '#ef4444', iconColor: '#ef4444' },
          },
          hidePostalCode: true,
        });
        cardElement.mount(mountEl);
        cardElementRef.current = cardElement;
      } catch (e) {
        console.error('Stripe mount error:', e);
      }
    };
    mountCard();
    return () => {
      cancelled = true;
      setWalletPayAvailable(null);
      paymentRequestRef.current = null;
      if (cardElementRef.current) {
        try { cardElementRef.current.unmount(); } catch (_) {}
        cardElementRef.current = null;
      }
    };
  }, [paymentModal, isDark]);

  const handleUpgrade = async (plan, storage, billing) => {
    const bp = billing || billingPeriod;
    // If already a paid subscriber, do a plan change (no card needed)
    if (currentPlan !== 'free' && currentPlan !== plan) {
      setUpgrading(true);
      try {
        const res = await api.stripeUpgrade(plan);
        if (res?.success) {
          safeAlert(t('plans.upgradeSuccess') || 'Plano atualizado!',
            plan === 'family' ? 'Upgrade para Familia concluido! So a diferenca foi cobrada.' : 'Plano alterado com sucesso!');
          await loadPlanInfo();
          if (subInfo) loadSubscriptionInfo();
        } else {
          safeAlert('Erro', res?.message || 'Erro ao mudar plano');
        }
      } catch { safeAlert('Erro', 'Erro de conexão'); }
      finally { setUpgrading(false); }
      return;
    }
    // New subscriber — show card form
    setPaymentModal({ plan, mode: 'subscribe', storage, billingPeriod: bp });
    setCardNumber('');
    setCardExpiry('');
    setCardCvc('');
    setCardName('');
    setPaymentError('');
    setPaymentSuccess(false);
    setPaymentLoading(false);
    // Check for saved card (works even without active subscription)
    api.stripeSavedCard().then(res => {
      if (res?.success && res?.data?.card?.last4) {
        setSavedCard(res.data.card);
        setUseSavedCard(true);
      } else {
        setSavedCard(null);
        setUseSavedCard(false);
      }
    }).catch(() => { setSavedCard(null); setUseSavedCard(false); });
  };

  const handleChangeCard = () => {
    setPaymentModal({ plan: currentPlan, mode: 'update_card' });
    setCardNumber('');
    setCardExpiry('');
    setCardCvc('');
    setCardName('');
    setPaymentError('');
    setPaymentSuccess(false);
    setPaymentLoading(false);
  };

  const closePaymentModal = () => {
    setPaymentModal(null);
    setPaymentError('');
    setPaymentSuccess(false);
    setPaymentLoading(false);
    setWalletPayAvailable(null);
    paymentRequestRef.current = null;
    if (cardElementRef.current) {
      try { cardElementRef.current.unmount(); } catch (_) {}
      cardElementRef.current = null;
    }
  };

  const handleWalletPay = () => {
    if (Platform.OS === 'web' && paymentRequestRef.current) {
      paymentRequestRef.current.show();
    }
  };

  // Create payment method from card form (shared between subscribe and update_card)
  const createPaymentMethodFromForm = async () => {
    if (Platform.OS === 'web') {
      const stripe = stripeRef.current;
      const cardElement = cardElementRef.current;
      if (!stripe || !cardElement) {
        throw new Error('Payment system not loaded');
      }
      const { paymentMethod, error } = await stripe.createPaymentMethod({
        type: 'card',
        card: cardElement,
        billing_details: { name: cardName || undefined },
      });
      if (error) throw new Error(error.message);
      return paymentMethod.id;
    } else {
      const digits = cardNumber.replace(/\s/g, '');
      const expiryParts = cardExpiry.split('/');
      if (digits.length < 13 || expiryParts.length !== 2) {
        throw new Error(t('plans.paymentFailed'));
      }
      const expMonth = parseInt(expiryParts[0], 10);
      const expYear = parseInt('20' + expiryParts[1], 10);
      if (!expMonth || !expYear || cardCvc.length < 3) {
        throw new Error(t('plans.paymentFailed'));
      }

      const body = new URLSearchParams();
      body.append('type', 'card');
      body.append('card[number]', digits);
      body.append('card[exp_month]', String(expMonth));
      body.append('card[exp_year]', String(expYear));
      body.append('card[cvc]', cardCvc);
      if (cardName) body.append('billing_details[name]', cardName);

      const res = await fetch('https://api.stripe.com/v1/payment_methods', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + STRIPE_PK,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
      const pm = await res.json();
      if (pm.error) throw new Error(pm.error.message);
      return pm.id;
    }
  };

  // Card number change with auto-advance
  const handleCardNumberChange = (v) => {
    const formatted = formatCardNumber(v);
    setCardNumber(formatted);
    if (formatted.replace(/\s/g, '').length >= 16) {
      expiryInputRef.current?.focus();
    }
  };

  // Expiry change with auto-advance
  const handleExpiryChange = (v) => {
    const formatted = formatExpiry(v);
    setCardExpiry(formatted);
    if (formatted.length >= 5) {
      cvcInputRef.current?.focus();
    }
  };

  // CVC change with auto-advance
  const handleCvcChange = (v) => {
    const cleaned = v.replace(/\D/g, '').slice(0, 4);
    setCardCvc(cleaned);
    if (cleaned.length >= 3) {
      nameInputRef.current?.focus();
    }
  };

  const handlePaymentSubmit = async () => {
    if (paymentLoading) return;
    setPaymentError('');
    setPaymentLoading(true);

    try {
      // Use saved card if selected, otherwise create new payment method
      let paymentMethodId;
      if (useSavedCard && savedCard?.payment_method_id) {
        paymentMethodId = savedCard.payment_method_id;
      } else {
        paymentMethodId = await createPaymentMethodFromForm();
      }

      if (paymentModal.mode === 'update_card') {
        // Update card flow
        const result = await api.stripeUpdateCard(paymentMethodId);
        if (!result?.success) {
          setPaymentError(result?.message || t('plans.paymentFailed'));
          setPaymentLoading(false);
          return;
        }
        setPaymentSuccess(true);
        setPaymentLoading(false);
        // Refresh subscription info
        await loadSubscriptionInfo();
        setTimeout(() => closePaymentModal(), 2500);
        return;
      }

      // Subscribe flow
      const storageOpts = paymentModal.storage ? { storage_gb: paymentModal.storage.gb, extra_price: paymentModal.storage.extra } : undefined;
      const result = await api.stripeSubscribe(paymentModal.plan, paymentMethodId, storageOpts, paymentModal.billingPeriod || 'monthly');

      if (result?.data?.requires_action) {
        if (Platform.OS === 'web' && stripeRef.current) {
          const { error } = await stripeRef.current.confirmCardPayment(result.data.client_secret);
          if (error) {
            setPaymentError(error.message);
            setPaymentLoading(false);
            return;
          }
          await loadPlanInfo();
          setPaymentSuccess(true);
          setPaymentLoading(false);
          setTimeout(() => closePaymentModal(), 2500);
        } else {
          setPaymentError('3D Secure verification needed. Please try on web.');
          setPaymentLoading(false);
        }
        return;
      }

      if (!result?.success) {
        setPaymentError(result?.message || t('plans.paymentFailed'));
        setPaymentLoading(false);
        return;
      }

      setPaymentSuccess(true);
      setPaymentLoading(false);
      await loadPlanInfo();
      // Auto-close after 2.5s
      setTimeout(() => closePaymentModal(), 2500);
    } catch (e) {
      setPaymentError(e.message || t('plans.paymentFailed'));
      setPaymentLoading(false);
    }
  };

  const handleCancelSubscription = async () => {
    setCancelLoading(true);
    try {
      const result = await api.stripeCancelSubscription();
      if (result?.success) {
        setShowCancelConfirm(false);
        await loadSubscriptionInfo();
        await loadPlanInfo();
        safeAlert(t('plans.cancellationScheduled'), t('plans.activeUntil', { date: formatDateBR(result?.data?.current_period_end) }));
      } else {
        safeAlert('Erro', result?.message || 'Erro ao cancelar');
      }
    } catch (e) {
      safeAlert('Erro', 'Erro de conexao');
    } finally { setCancelLoading(false); }
  };

  const handleReactivate = async () => {
    setReactivateLoading(true);
    try {
      const result = await api.stripeReactivate();
      if (result?.success) {
        await loadSubscriptionInfo();
        await loadPlanInfo();
        safeAlert(t('plans.reactivated'));
      } else {
        safeAlert('Erro', result?.message || 'Erro ao reativar');
      }
    } catch (e) {
      safeAlert('Erro', 'Erro de conexao');
    } finally { setReactivateLoading(false); }
  };

  const handleCancel = () => {
    safeAlert(t('plans.cancel'), t('plans.cancelConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('settings.confirm'), onPress: async () => {
        try {
          await api.planCancel();
          await loadPlanInfo();
        } catch (e) { /* silent */ }
      }},
    ]);
  };

  const handleAddMember = async () => {
    if (!newMemberEmail.trim()) return;
    setAddingMember(true);
    try {
      const res = await api.planFamilyAdd(newMemberEmail.trim());
      if (res?.data?.success) {
        setNewMemberEmail('');
        setShowAddMember(false);
        await loadFamilyMembers();
      } else {
        safeAlert('Erro', res?.data?.message || 'Erro ao adicionar membro');
      }
    } catch (e) {
      safeAlert('Erro', 'Erro de conexao');
    } finally { setAddingMember(false); }
  };

  const handleRemoveMember = (email) => {
    safeAlert(t('plans.removeMember'), email, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('plans.removeMember'), onPress: async () => {
        try {
          await api.planFamilyRemove(email);
          await loadFamilyMembers();
        } catch (e) { /* silent */ }
      }},
    ]);
  };

  const faqItems = [
    { q: t('plans.faqWhatIsPlus'), a: t('plans.faqWhatIsPlusAnswer') },
    { q: t('plans.cancelWhat'), a: t('plans.faqCancelAnswer') },
    { q: t('plans.faqHowFamily'), a: t('plans.faqHowFamilyAnswer') },
    { q: t('plans.changePlan'), a: t('plans.faqChangePlanAnswer') },
    { q: t('plans.faqCardDeclined'), a: t('plans.faqCardDeclinedAnswer') },
    { q: t('plans.faqDataSafe'), a: t('plans.faqDataSafeAnswer') },
  ];

  const contentWidth = isDesktop ? Math.min(640, width - 80) : width;

  const PLUS_COLOR = '#6366f1';
  const PLUS_LIGHT = isDark ? 'rgba(99, 102, 241, 0.15)' : 'rgba(99, 102, 241, 0.08)';
  const PLUS_BORDER = isDark ? 'rgba(99, 102, 241, 0.3)' : 'rgba(99, 102, 241, 0.2)';
  const FAMILY_COLOR = '#f59e0b';
  const FAMILY_LIGHT = isDark ? 'rgba(245, 158, 11, 0.15)' : 'rgba(245, 158, 11, 0.08)';
  const FAMILY_BORDER = isDark ? 'rgba(245, 158, 11, 0.3)' : 'rgba(245, 158, 11, 0.2)';
  const GREEN = isDark ? '#4ade80' : '#16a34a';
  const AMBER = isDark ? '#fbbf24' : '#d97706';
  const RED = isDark ? '#f87171' : '#dc2626';

  const AI_PURPLE = isDark ? '#a78bfa' : '#7c3aed';

  // Storage tier selector — modern chips
  const StorageSelector = ({ options, selected, onSelect, accentColor, basePriceCents }) => {
    const total = basePriceCents + selected.extra;
    const gradientBg = accentColor === FAMILY_COLOR
      ? 'linear-gradient(135deg, #f59e0b, #f97316)'
      : 'linear-gradient(135deg, #6366f1, #8b5cf6)';
    return (
      <View style={{ marginTop: 20, marginBottom: 4 }}>
        <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.8 }}>
          {t('plans.chooseStorage')}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {options.map((opt, idx) => {
            const isSelected = selected.gb === opt.gb;
            const isBest = idx === options.length - 1 && options.length > 1;
            return (
              <TouchableOpacity
                key={opt.gb}
                onPress={() => onSelect(opt)}
                activeOpacity={0.7}
                style={{
                  flex: 1,
                  minWidth: 72,
                  paddingVertical: 14,
                  paddingHorizontal: 8,
                  borderRadius: 16,
                  borderWidth: isSelected ? 2 : 1.5,
                  borderColor: isSelected ? accentColor : (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'),
                  backgroundColor: isSelected
                    ? (isDark ? accentColor + '20' : accentColor + '10')
                    : (isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)'),
                  alignItems: 'center',
                  ...(Platform.OS === 'web' && isSelected ? { backgroundImage: gradientBg, borderColor: 'transparent' } : {}),
                }}
              >
                {isBest && (
                  <View style={{ marginBottom: 4 }}>
                    <IconStar size={14} color={isSelected ? (Platform.OS === 'web' ? '#fff' : accentColor) : '#f59e0b'} />
                  </View>
                )}
                <Text style={{
                  fontSize: 15,
                  fontWeight: '800',
                  color: isSelected ? (Platform.OS === 'web' ? '#fff' : accentColor) : colors.text,
                }}>
                  {opt.label}
                </Text>
                {isSelected && (
                  <View style={{ marginTop: 4 }}>
                    <IconCheck size={12} color={Platform.OS === 'web' ? '#fff' : accentColor} />
                  </View>
                )}
                <Text style={{
                  fontSize: 11,
                  color: opt.included
                    ? (isSelected && Platform.OS === 'web' ? 'rgba(255,255,255,0.9)' : GREEN)
                    : (isSelected && Platform.OS === 'web' ? 'rgba(255,255,255,0.8)' : colors.textSecondary),
                  fontWeight: opt.included ? '600' : '500',
                  marginTop: 4,
                }}>
                  {opt.included ? t('plans.included') : `+R$${(opt.extra / 100).toFixed(2).replace('.', ',')}`}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'flex-end', marginTop: 14, gap: 4 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '500' }}>
            {t('plans.total')}
          </Text>
          <Text style={{ color: colors.text, fontSize: 22, fontWeight: '800' }}>
            R${(total / 100).toFixed(2).replace('.', ',')}
          </Text>
          <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
            {t('plans.perMonth')}
          </Text>
        </View>
      </View>
    );
  };

  // Feature list icons mapped by content keywords — returns { Icon, color } for SVG icons
  const getFeatureIconData = (text) => {
    const lower = (text || '').toLowerCase();
    if (lower.includes('armazenamento') || lower.includes('storage') || lower.includes('almacenamiento') || lower.includes('gb')) return { Icon: IconArchive, color: '#6366f1' };
    if (lower.includes('backup') || lower.includes('nuvem') || lower.includes('cloud')) return { Icon: IconCloud, color: '#22c55e' };
    if (lower.includes('recuperar') || lower.includes('recover') || lower.includes('apagad')) return { Icon: IconRefresh, color: '#3b82f6' };
    if (lower.includes('arquivo') || lower.includes('file') || lower.includes('mb')) return { Icon: IconPaperclip, color: '#f59e0b' };
    if (lower.includes('proteg') || lower.includes('safe') || lower.includes('segur') || lower.includes('perca') || lower.includes('lose')) return { Icon: IconShield, color: '#10b981' };
    if (lower.includes('dispositivo') || lower.includes('device')) return { Icon: IconSmartphone, color: '#8b5cf6' };
    if (lower.includes('suporte') || lower.includes('support') || lower.includes('priorit')) return { Icon: IconStar, color: '#f59e0b' };
    if (lower.includes('pessoa') || lower.includes('people') || lower.includes('membr') || lower.includes('familia') || lower.includes('family')) return { Icon: IconUsers, color: '#f97316' };
    if (lower.includes('ai') || lower.includes('assistente') || lower.includes('assistant')) return { Icon: IconSparkles, color: '#8b5cf6' };
    if (lower.includes('foto') || lower.includes('photo') || lower.includes('video')) return { Icon: IconImage, color: '#06b6d4' };
    if (lower.includes('gerenciar') || lower.includes('manage') || lower.includes('gestionar')) return { Icon: IconSettings, color: '#64748b' };
    if (lower.includes('compartilh') || lower.includes('shared')) return { Icon: IconLink, color: '#3b82f6' };
    if (lower.includes('tudo') || lower.includes('everything') || lower.includes('todo')) return { Icon: IconStarFilled, color: '#f59e0b' };
    return { Icon: IconCheck, color: '#10b981' };
  };

  const FeatureItem = ({ text, highlight, desc }) => {
    const iconData = highlight ? { Icon: IconSparkles, color: AI_PURPLE } : getFeatureIconData(text);
    const bgColor = isDark ? (iconData.color + '18') : (iconData.color + '12');
    return (
      <View style={{ flexDirection: 'row', alignItems: highlight ? 'flex-start' : 'center', marginBottom: 14, paddingVertical: 2 }}>
        <View style={{
          width: 36, height: 36, borderRadius: 10,
          backgroundColor: bgColor,
          alignItems: 'center', justifyContent: 'center',
          marginRight: 12,
        }}>
          <iconData.Icon size={18} color={iconData.color} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{
            color: highlight ? AI_PURPLE : colors.text,
            fontSize: 14,
            fontWeight: highlight ? '600' : '500',
            lineHeight: 20,
          }}>{text}</Text>
          {desc ? (
            <Text style={{ color: colors.textTertiary, fontSize: 12, marginTop: 2, lineHeight: 16 }}>{desc}</Text>
          ) : null}
        </View>
      </View>
    );
  };

  // Invoice status helpers
  const invoiceStatusColor = (status) => {
    if (status === 'paid') return GREEN;
    if (status === 'open') return AMBER;
    return RED;
  };
  const invoiceStatusLabel = (status) => {
    if (status === 'paid') return t('plans.paid');
    if (status === 'open') return t('plans.pending');
    return t('plans.failed');
  };

  // Payment modal plan info
  const modalPlan = paymentModal?.plan;
  const modalMode = paymentModal?.mode || 'subscribe';
  const modalBillingPeriod = paymentModal?.billingPeriod || 'monthly';
  const modalStorageExtra = paymentModal?.storage?.extra || 0;
  const modalBaseCents = modalPlan ? (PRICING[modalPlan]?.[modalBillingPeriod] || (modalPlan === 'family' ? 1999 : 1299)) : 0;
  const modalTotalCents = modalBaseCents + modalStorageExtra;
  const modalPrice = (modalTotalCents / 100).toFixed(2).replace('.', ',');
  const modalAnnualTotal = modalBillingPeriod === 'annual' ? ((modalTotalCents * 12) / 100).toFixed(2).replace('.', ',') : null;
  const modalPlanLabel = modalPlan === 'family' ? t('plans.family') : 'One';
  const modalColor = modalPlan === 'family' ? FAMILY_COLOR : PLUS_COLOR;
  const cardBrand = detectCardBrand(cardNumber);

  if (loading) {
    return (
      <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={s.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
          <Text style={[s.headerTitle, { color: colors.text }]}>{t('plans.title')}</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </View>
    );
  }

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Floating back button */}
      <TouchableOpacity
        onPress={() => router.back()}
        style={{
          position: 'absolute', top: insets.top + 8, left: 16, zIndex: 10,
          width: 40, height: 40, borderRadius: 20,
          backgroundColor: 'rgba(0,0,0,0.3)',
          alignItems: 'center', justifyContent: 'center',
          ...(Platform.OS === 'web' ? { backdropFilter: 'blur(10px)' } : {}),
        }}
        accessibilityLabel="Back"
        accessibilityRole="button"
      >
        <IconArrowLeft size={20} color="#fff" />
      </TouchableOpacity>

      <ScrollView contentContainerStyle={[s.scrollContent, { alignItems: 'center', paddingTop: 0 }]} showsVerticalScrollIndicator={false}>
        <View style={{ width: contentWidth, maxWidth: '100%', paddingHorizontal: Spacing.lg }}>

          {/* ===== PREMIUM HERO SECTION ===== */}
          <View style={{
            marginHorizontal: -Spacing.lg,
            marginTop: -Spacing.xl,
            paddingHorizontal: Spacing.lg,
            paddingTop: 36,
            paddingBottom: 32,
            alignItems: 'center',
            backgroundColor: isDark ? '#0c0a1a' : '#1e1145',
            ...(Platform.OS === 'web' ? {
              backgroundImage: 'linear-gradient(135deg, #1e1145 0%, #312e81 40%, #1e40af 100%)',
            } : {}),
          }}>
            <Text style={{
              color: '#e9d5ff',
              fontSize: 36,
              fontWeight: '900',
              textAlign: 'center',
              letterSpacing: 1,
              textShadowColor: 'rgba(139, 92, 246, 0.7)',
              textShadowOffset: { width: 0, height: 0 },
              textShadowRadius: 30,
            }}>
              Chatyy One
            </Text>
            <Text style={{
              color: 'rgba(196, 181, 253, 0.8)',
              fontSize: 15,
              textAlign: 'center',
              marginTop: 8,
              fontWeight: '500',
              letterSpacing: 0.3,
            }}>
              {t('plans.heroTagline')}
            </Text>

            {/* Premium Pill Toggle */}
            <View style={{
              marginTop: 24,
              flexDirection: 'row',
              backgroundColor: 'rgba(255,255,255,0.08)',
              borderRadius: 28,
              padding: 4,
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.1)',
              ...(Platform.OS === 'web' ? { backdropFilter: 'blur(10px)' } : {}),
            }}>
              <TouchableOpacity
                style={{
                  paddingVertical: 12,
                  paddingHorizontal: 28,
                  borderRadius: 24,
                  backgroundColor: billingPeriod === 'monthly' ? 'rgba(255,255,255,0.15)' : 'transparent',
                  ...(billingPeriod === 'monthly' && Platform.OS === 'web' ? { backdropFilter: 'blur(10px)' } : {}),
                }}
                onPress={() => setBillingPeriod('monthly')}
                activeOpacity={0.7}
              >
                <Text style={{ color: billingPeriod === 'monthly' ? '#fff' : 'rgba(255,255,255,0.5)', fontWeight: '700', fontSize: 14 }}>
                  {t('plans.monthly')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{
                  paddingVertical: 12,
                  paddingHorizontal: 28,
                  borderRadius: 24,
                  backgroundColor: billingPeriod === 'annual' ? 'rgba(255,255,255,0.15)' : 'transparent',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  ...(billingPeriod === 'annual' && Platform.OS === 'web' ? { backdropFilter: 'blur(10px)' } : {}),
                }}
                onPress={() => setBillingPeriod('annual')}
                activeOpacity={0.7}
              >
                <Text style={{ color: billingPeriod === 'annual' ? '#fff' : 'rgba(255,255,255,0.5)', fontWeight: '700', fontSize: 14 }}>
                  {t('plans.annual')} {t('plans.annualDiscount')}
                </Text>
                <IconSparkles size={14} color={billingPeriod === 'annual' ? '#fbbf24' : 'rgba(255,255,255,0.4)'} />
              </TouchableOpacity>
            </View>

            {billingPeriod === 'annual' && (
              <View style={{
                marginTop: 10,
                backgroundColor: '#22c55e',
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 4,
              }}>
                <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 }}>
                  {t('plans.bestValue')}
                </Text>
              </View>
            )}
          </View>

          {/* Storage warning for free users near limit */}
          {currentPlan === 'free' && storageUsed > 0 && (storageUsed / storageTotal) > 0.8 && (
            <View style={[s.storageWarning, {
              backgroundColor: isDark ? 'rgba(245, 158, 11, 0.12)' : 'rgba(245, 158, 11, 0.08)',
              borderColor: isDark ? 'rgba(245, 158, 11, 0.3)' : 'rgba(245, 158, 11, 0.25)',
            }]}>
              <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: AMBER + '20', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
                <IconShield size={18} color={AMBER} />
              </View>
              <Text style={{ color: AMBER, fontSize: FontSize.base, fontWeight: '700', marginBottom: 2 }}>
                {t('plans.storageWarning', { used: `${storageUsed.toFixed(1)} GB`, total: `${storageTotal} GB` })}
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, marginBottom: 10 }}>
                {t('plans.storageWarningUpgrade')}
              </Text>
              <TouchableOpacity
                style={[s.subscribeBtn, { backgroundColor: PLUS_COLOR, marginTop: 0, paddingVertical: 10 }]}
                onPress={() => handleUpgrade('one', selectedStorageOne, billingPeriod)}
                disabled={upgrading}
              >
                <Text style={{ color: '#fff', fontSize: FontSize.base, fontWeight: '700' }}>
                  {t('plans.subscribe')} Chatyy One
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Current Plan Banner */}
          {currentPlan !== 'free' && (
            <View style={[s.currentBanner, {
              backgroundColor: currentPlan === 'family' ? FAMILY_LIGHT : PLUS_LIGHT,
              borderColor: currentPlan === 'family' ? FAMILY_BORDER : PLUS_BORDER,
            }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <IconCheck size={18} color={GREEN} />
                <Text style={{ color: colors.text, fontSize: FontSize.lg, fontWeight: '600' }}>
                  {t('plans.currentPlan')}: {(currentPlan === 'plus' || currentPlan === 'one') ? 'Chatyy One' : t('plans.family')}
                </Text>
              </View>
              {nextBilling && (
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, marginTop: 4, marginLeft: 26 }}>
                  {t('plans.nextBilling')}: {nextBilling}
                </Text>
              )}
            </View>
          )}

          {/* Free Card — Subdued */}
          <View style={{
            borderRadius: 20,
            borderWidth: 1,
            padding: 20,
            marginBottom: 16,
            marginTop: 20,
            backgroundColor: isDark ? 'rgba(148,163,184,0.04)' : 'rgba(148,163,184,0.04)',
            borderColor: isDark ? 'rgba(148,163,184,0.15)' : 'rgba(148,163,184,0.15)',
            opacity: currentPlan === 'free' ? 1 : 0.7,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: '#94a3b8', fontSize: 20, fontWeight: '700' }}>{t('plans.free')}</Text>
              {currentPlan === 'free' && (
                <View style={{ backgroundColor: isDark ? 'rgba(148,163,184,0.15)' : 'rgba(148,163,184,0.1)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20 }}>
                  <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '600' }}>{t('plans.yourCurrentPlan')}</Text>
                </View>
              )}
            </View>
            <View style={{ marginTop: 14 }}>
              <FeatureItem text={t('plans.storage', { n: '15' })} />
              <FeatureItem text={t('plans.mediaRetention', { n: '30' })} desc={t('plans.mediaExpires30')} />
              <FeatureItem text={t('plans.maxFileSize', { n: '25' })} />
              <FeatureItem text={t('plans.limitedAI')} highlight />
            </View>
          </View>

          {/* ===== Chatyy One Card — Glass Morphism ===== */}
          <View style={{
            borderRadius: 20,
            padding: 24,
            marginBottom: 16,
            overflow: 'hidden',
            position: 'relative',
            borderWidth: (currentPlan === 'plus' || currentPlan === 'one') ? 2 : 1,
            borderColor: isDark ? 'rgba(99,102,241,0.4)' : 'rgba(99,102,241,0.25)',
            backgroundColor: isDark ? 'rgba(99,102,241,0.06)' : 'rgba(99,102,241,0.03)',
            ...(Platform.OS === 'web' ? {
              backdropFilter: 'blur(20px)',
              boxShadow: '0 8px 32px rgba(99, 102, 241, 0.15), 0 0 0 1px rgba(99, 102, 241, 0.08)',
            } : {}),
          }}>
            {/* Top gradient accent */}
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 4, backgroundColor: PLUS_COLOR, ...(Platform.OS === 'web' ? { backgroundImage: 'linear-gradient(90deg, #6366f1, #8b5cf6)' } : {}) }} />

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <IconStarFilled size={22} color={PLUS_COLOR} />
              <Text style={{ color: PLUS_COLOR, fontSize: 24, fontWeight: '800', letterSpacing: 0.3 }}>Chatyy One</Text>
            </View>

            {/* Price — BIG */}
            <View style={{ marginTop: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                {billingPeriod === 'annual' && (
                  <Text style={{ fontSize: 18, fontWeight: '500', color: colors.textSecondary, textDecorationLine: 'line-through' }}>
                    R${(PRICING.one.monthly / 100).toFixed(2).replace('.', ',')}
                  </Text>
                )}
                <Text style={{ color: colors.text, fontSize: 42, fontWeight: '800', letterSpacing: -1 }}>
                  R${(PRICING.one[billingPeriod] / 100).toFixed(2).replace('.', ',')}
                </Text>
              </View>
              <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '500', marginTop: -2 }}>
                {t('plans.perMonth')}
              </Text>
              {billingPeriod === 'annual' && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                    {t('plans.billedAnnually', { total: ((PRICING.one.annual * 12) / 100).toFixed(2).replace('.', ',') })}
                  </Text>
                  <View style={{ backgroundColor: '#22c55e', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 }}>
                    <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>
                      {t('plans.saveAmount', { amount: (((PRICING.one.monthly - PRICING.one.annual) * 12) / 100).toFixed(0) })}
                    </Text>
                  </View>
                </View>
              )}
            </View>

            <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 12, marginBottom: 16, lineHeight: 19 }}>
              {t('plans.plusDescUpdated') || t('plans.plusDesc')}
            </Text>

            {/* Feature list with icons */}
            <View>
              <FeatureItem text={t('plans.storage', { n: '200' })} />
              <FeatureItem text={t('plans.photoBackup')} />
              <FeatureItem text={t('plans.permanentBackup')} />
              <FeatureItem text={t('plans.recoverMessages')} />
              <FeatureItem text={t('plans.maxFileSize', { n: '100' })} />
              <FeatureItem text={t('plans.neverLose')} />
              <FeatureItem text={t('plans.crossDevice')} />
              <FeatureItem text={t('plans.prioritySupport')} />
            </View>

            {/* One AI Showcase */}
            <OneAIShowcase colors={colors} isDark={isDark} t={t} />

            {/* Storage tier selector */}
            {currentPlan !== 'family' && (currentPlan !== 'plus' && currentPlan !== 'one') && (
              <StorageSelector
                options={getStorageOptions('one', billingPeriod)}
                selected={selectedStorageOne}
                onSelect={setSelectedStorageOne}
                accentColor={PLUS_COLOR}
                basePriceCents={PRICING.one[billingPeriod]}
              />
            )}

            {currentPlan === 'family' ? (
              <View style={{ marginTop: 12, paddingVertical: 8, alignItems: 'center' }}>
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, fontStyle: 'italic' }}>
                  {t('plans.familyIncludesPlus')}
                </Text>
              </View>
            ) : (currentPlan !== 'plus' && currentPlan !== 'one') && (
              <TouchableOpacity
                style={{
                  height: 56,
                  borderRadius: 16,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginTop: 20,
                  backgroundColor: PLUS_COLOR,
                  ...(Platform.OS === 'web' ? {
                    backgroundImage: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                    boxShadow: '0 4px 20px rgba(99, 102, 241, 0.4)',
                  } : {}),
                  ...Shadow.md,
                }}
                onPress={() => handleUpgrade('one', selectedStorageOne, billingPeriod)}
                disabled={upgrading}
                activeOpacity={0.85}
              >
                {upgrading ? <ActivityIndicator color="#fff" size="small" /> :
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: 0.3 }}>
                      {t('plans.startNow')} {'\u2014'} R${((PRICING.one[billingPeriod] + selectedStorageOne.extra) / 100).toFixed(2).replace('.', ',')}{t('plans.perMonth')}
                    </Text>
                    <IconArrowRight size={18} color="#fff" />
                  </View>
                }
              </TouchableOpacity>
            )}
          </View>

          {/* ===== Family Card — Glass Morphism ===== */}
          <View style={{
            borderRadius: 20,
            padding: 24,
            marginBottom: 16,
            overflow: 'hidden',
            position: 'relative',
            borderWidth: currentPlan === 'family' ? 2 : 1,
            borderColor: isDark ? 'rgba(245,158,11,0.4)' : 'rgba(245,158,11,0.25)',
            backgroundColor: isDark ? 'rgba(245,158,11,0.06)' : 'rgba(245,158,11,0.03)',
            ...(Platform.OS === 'web' ? {
              backdropFilter: 'blur(20px)',
              boxShadow: '0 8px 32px rgba(245, 158, 11, 0.12), 0 0 0 1px rgba(245, 158, 11, 0.06)',
            } : {}),
          }}>
            {/* Top gradient accent */}
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 4, backgroundColor: FAMILY_COLOR, ...(Platform.OS === 'web' ? { backgroundImage: 'linear-gradient(90deg, #f59e0b, #f97316)' } : {}) }} />

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <IconUsers size={22} color={FAMILY_COLOR} />
              <Text style={{ color: FAMILY_COLOR, fontSize: 24, fontWeight: '800', letterSpacing: 0.3 }}>{t('plans.family')}</Text>
              <View style={{
                backgroundColor: FAMILY_COLOR,
                borderRadius: 12,
                paddingHorizontal: 10,
                paddingVertical: 3,
              }}>
                <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700', letterSpacing: 0.5 }}>{t('plans.mostPopular')}</Text>
              </View>
            </View>

            {/* Price — BIG */}
            <View style={{ marginTop: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                {billingPeriod === 'annual' && (
                  <Text style={{ fontSize: 18, fontWeight: '500', color: colors.textSecondary, textDecorationLine: 'line-through' }}>
                    R${(PRICING.family.monthly / 100).toFixed(2).replace('.', ',')}
                  </Text>
                )}
                <Text style={{ color: colors.text, fontSize: 42, fontWeight: '800', letterSpacing: -1 }}>
                  R${(PRICING.family[billingPeriod] / 100).toFixed(2).replace('.', ',')}
                </Text>
              </View>
              <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '500', marginTop: -2 }}>
                {t('plans.perMonth')}
              </Text>
              {billingPeriod === 'annual' && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                    {t('plans.billedAnnually', { total: ((PRICING.family.annual * 12) / 100).toFixed(2).replace('.', ',') })}
                  </Text>
                  <View style={{ backgroundColor: '#22c55e', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 }}>
                    <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>
                      {t('plans.saveAmount', { amount: (((PRICING.family.monthly - PRICING.family.annual) * 12) / 100).toFixed(0) })}
                    </Text>
                  </View>
                </View>
              )}
            </View>

            <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 12, marginBottom: 16, lineHeight: 19 }}>
              {t('plans.familyDesc')}
            </Text>

            <View>
              <FeatureItem text={t('plans.sharedStorage', { n: '500' })} />
              <FeatureItem text={t('plans.upToPeople', { n: '5' })} />
              <FeatureItem text={t('plans.allPlusForFamily')} />
              <FeatureItem text={t('plans.photoBackup')} />
              <FeatureItem text={t('plans.permanentBackup')} />
              <FeatureItem text={t('plans.recoverMessages')} />
              <FeatureItem text={t('plans.familyAdmin')} />
              <FeatureItem text={t('plans.crossDevice')} />
              <FeatureItem text={t('plans.oneAIFamily')} highlight />
            </View>

            {/* Storage tier selector */}
            {currentPlan !== 'family' && (
              <StorageSelector
                options={getStorageOptions('family', billingPeriod)}
                selected={selectedStorageFamily}
                onSelect={setSelectedStorageFamily}
                accentColor={FAMILY_COLOR}
                basePriceCents={PRICING.family[billingPeriod]}
              />
            )}

            {currentPlan !== 'family' && (
              <TouchableOpacity
                style={{
                  height: 56,
                  borderRadius: 16,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginTop: 20,
                  backgroundColor: FAMILY_COLOR,
                  ...(Platform.OS === 'web' ? {
                    backgroundImage: 'linear-gradient(135deg, #f59e0b, #f97316)',
                    boxShadow: '0 4px 20px rgba(245, 158, 11, 0.4)',
                  } : {}),
                  ...Shadow.md,
                }}
                onPress={() => handleUpgrade('family', selectedStorageFamily, billingPeriod)}
                disabled={upgrading}
                activeOpacity={0.85}
              >
                {upgrading ? <ActivityIndicator color="#fff" size="small" /> :
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: 0.3 }}>
                      {(currentPlan === 'plus' || currentPlan === 'one')
                        ? t('plans.upgradeToFamily')
                        : `${t('plans.startNow')} \u2014 R$${((PRICING.family[billingPeriod] + selectedStorageFamily.extra) / 100).toFixed(2).replace('.', ',')}${t('plans.perMonth')}`}
                    </Text>
                    <IconArrowRight size={18} color="#fff" />
                  </View>
                }
              </TouchableOpacity>
            )}
          </View>

          {/* ============================================================ */}
          {/* MINHA ASSINATURA - In-app subscription management */}
          {/* ============================================================ */}
          {currentPlan !== 'free' && subInfo && isAdmin && (
            <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              {/* Section header */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <IconStarFilled size={18} color={PLUS_COLOR} />
                <Text style={{ color: colors.text, fontSize: FontSize.lg, fontWeight: '700' }}>
                  {t('plans.mySubscription')}
                </Text>
              </View>

              {/* Plan + Status */}
              <View style={{ marginBottom: 16 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                  <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm }}>Plano</Text>
                  <Text style={{ color: colors.text, fontSize: FontSize.base, fontWeight: '600' }}>
                    {subInfo.plan_label || (currentPlan === 'family' ? 'Chatyy Família' : 'Chatyy One')}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                  <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm }}>Status</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {subInfo.cancel_at_period_end ? (
                      <>
                        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: AMBER }} />
                        <Text style={{ color: AMBER, fontSize: FontSize.sm, fontWeight: '600' }}>
                          {t('plans.cancellationScheduled')}
                        </Text>
                      </>
                    ) : subInfo.status === 'past_due' ? (
                      <>
                        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: RED }} />
                        <Text style={{ color: RED, fontSize: FontSize.sm, fontWeight: '600' }}>
                          {t('plans.pastDue')}
                        </Text>
                      </>
                    ) : (
                      <>
                        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: GREEN }} />
                        <Text style={{ color: GREEN, fontSize: FontSize.sm, fontWeight: '600' }}>
                          {t('plans.active')}
                        </Text>
                      </>
                    )}
                  </View>
                </View>

                {subInfo.cancel_at_period_end ? (
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                    <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm }}>
                      {t('plans.activeUntil', { date: '' }).replace('{date}', '').trim()}
                    </Text>
                    <Text style={{ color: AMBER, fontSize: FontSize.base, fontWeight: '600' }}>
                      {formatDateBR(subInfo.current_period_end)}
                    </Text>
                  </View>
                ) : (
                  <>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                      <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm }}>{t('plans.nextBillingDate')}</Text>
                      <Text style={{ color: colors.text, fontSize: FontSize.base, fontWeight: '500' }}>
                        {formatDateBR(subInfo.current_period_end)}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm }}>{t('plans.amount')}</Text>
                      <Text style={{ color: colors.text, fontSize: FontSize.base, fontWeight: '500' }}>
                        {formatBRL(subInfo.amount)}/{t('plans.perMonth').replace('/', '')}
                      </Text>
                    </View>
                  </>
                )}
              </View>

              {/* Divider */}
              <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 12 }} />

              {/* Card info */}
              {subInfo.card && subInfo.card.last4 ? (
                <View style={{ marginBottom: 16 }}>
                  <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, fontWeight: '500', marginBottom: 10 }}>
                    {t('plans.card')}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <CardBrandIcon brand={subInfo.card.brand} />
                      <Text style={{ color: colors.text, fontSize: FontSize.base, fontWeight: '500' }}>
                        {'···· ' + subInfo.card.last4}
                      </Text>
                      <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, marginLeft: 12 }}>
                        {t('plans.validity')}: {String(subInfo.card.exp_month).padStart(2, '0')}/{String(subInfo.card.exp_year).slice(-2)}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={handleChangeCard}
                      style={[s.manageBtnSmall, {
                        backgroundColor: isDark ? 'rgba(99, 102, 241, 0.15)' : 'rgba(99, 102, 241, 0.08)',
                        borderColor: PLUS_BORDER,
                      }]}
                    >
                      <Text style={{ color: PLUS_COLOR, fontSize: FontSize.sm, fontWeight: '600' }}>
                        {t('plans.changeCard')}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}

              {/* Divider */}
              <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 12 }} />

              {/* Billing History */}
              <View style={{ marginBottom: 16 }}>
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, fontWeight: '500', marginBottom: 10 }}>
                  {t('plans.billingHistory')}
                </Text>
                {subInfo.invoices && subInfo.invoices.length > 0 ? (
                  subInfo.invoices.map((inv, i) => (
                    <View key={inv.id || i} style={{
                      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                      paddingVertical: 8,
                      borderTopWidth: i > 0 ? 1 : 0,
                      borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                    }}>
                      <Text style={{ color: colors.text, fontSize: FontSize.sm }}>
                        {formatDateBR(inv.date)}
                      </Text>
                      <Text style={{ color: colors.text, fontSize: FontSize.sm, fontWeight: '500' }}>
                        {formatBRL(inv.amount)}
                      </Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: invoiceStatusColor(inv.status) }} />
                        <Text style={{ color: invoiceStatusColor(inv.status), fontSize: FontSize.xs, fontWeight: '600' }}>
                          {invoiceStatusLabel(inv.status)}
                        </Text>
                      </View>
                    </View>
                  ))
                ) : (
                  <Text style={{ color: colors.textTertiary, fontSize: FontSize.sm, textAlign: 'center', paddingVertical: 8 }}>
                    {t('plans.noInvoices')}
                  </Text>
                )}
              </View>

              {/* Divider */}
              <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 4 }} />

              {/* Cancel / Reactivate */}
              {subInfo.cancel_at_period_end ? (
                <TouchableOpacity
                  onPress={handleReactivate}
                  disabled={reactivateLoading}
                  style={[s.subscribeBtn, { backgroundColor: GREEN, marginTop: 12 }]}
                >
                  {reactivateLoading ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={{ color: '#fff', fontSize: FontSize.base, fontWeight: '700' }}>
                      {t('plans.reactivate')}
                    </Text>
                  )}
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  onPress={() => setShowCancelConfirm(true)}
                  style={{ alignItems: 'center', marginTop: 12, paddingVertical: 10 }}
                >
                  <Text style={{ color: RED, fontSize: FontSize.sm, fontWeight: '500' }}>
                    {t('plans.cancelSubscription')}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Subscription info loading indicator */}
          {currentPlan !== 'free' && !subInfo && subLoading && (
            <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.border, alignItems: 'center', paddingVertical: 24 }]}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          )}

          {/* Family Management */}
          {currentPlan === 'family' && (
            <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <IconUsers size={18} color={FAMILY_COLOR} />
                  <Text style={{ color: colors.text, fontSize: FontSize.lg, fontWeight: '600' }}>{t('plans.familyMembers')}</Text>
                </View>
                {isAdmin ? (
                  <TouchableOpacity
                    style={[s.addMemberBtn, { backgroundColor: FAMILY_LIGHT, borderColor: FAMILY_BORDER }]}
                    onPress={() => setShowAddMember(true)}
                  >
                    <IconPlus size={14} color={FAMILY_COLOR} />
                    <Text style={{ color: FAMILY_COLOR, fontSize: FontSize.sm, fontWeight: '500' }}>{t('plans.addMember')}</Text>
                  </TouchableOpacity>
                ) : (
                  <View style={{ backgroundColor: FAMILY_LIGHT, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 }}>
                    <Text style={{ color: FAMILY_COLOR, fontSize: FontSize.xs, fontWeight: '500' }}>Membro</Text>
                  </View>
                )}
              </View>

              {/* Show admin info for members */}
              {!isAdmin && familyAdmin && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: isDark ? 'rgba(245,158,11,0.06)' : '#fffbeb', borderRadius: 8 }}>
                  <IconShield size={14} color={FAMILY_COLOR} />
                  <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm }}>
                    Admin: <Text style={{ fontWeight: '600', color: colors.text }}>{familyAdmin}</Text>
                  </Text>
                </View>
              )}

              {/* Storage bar */}
              <View style={{ marginBottom: 16 }}>
                <View style={[s.storageBarBg, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }]}>
                  <View style={[s.storageBarFill, { width: `${Math.min((storageUsed / storageTotal) * 100, 100)}%`, backgroundColor: FAMILY_COLOR }]} />
                </View>
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.xs, marginTop: 4 }}>
                  {t('plans.storageUsed', { used: `${storageUsed.toFixed(1)} GB`, total: `${storageTotal} GB` })}
                </Text>
              </View>

              {/* Members list */}
              {familyMembers.map((m, i) => (
                <View key={m.email || i} style={[s.memberRow, { borderTopColor: i > 0 ? colors.border : 'transparent', borderTopWidth: i > 0 ? 1 : 0 }]}>
                  <AvatarCircle email={m.email} name={m.name || m.email} size={36} />
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text style={{ color: colors.text, fontSize: FontSize.base, fontWeight: '500' }}>{m.name || m.email}</Text>
                    {m.storage_used != null && (
                      <Text style={{ color: colors.textSecondary, fontSize: FontSize.xs }}>{m.storage_used.toFixed(1)} GB</Text>
                    )}
                  </View>
                  {isAdmin && (
                    <TouchableOpacity onPress={() => handleRemoveMember(m.email)} style={{ padding: 6 }}>
                      <IconX size={16} color={colors.error} />
                    </TouchableOpacity>
                  )}
                </View>
              ))}
              {familyMembers.length === 0 && (
                <Text style={{ color: colors.textTertiary, fontSize: FontSize.sm, textAlign: 'center', paddingVertical: 12 }}>
                  {t('plans.addMember')}
                </Text>
              )}
            </View>
          )}

          {/* ===== FAQ Section — Clean Accordion ===== */}
          <View style={{ marginTop: 32, marginBottom: 40 }}>
            <Text style={{ color: colors.text, fontSize: 20, fontWeight: '800', marginBottom: 16, letterSpacing: 0.3 }}>{t('plans.faq')}</Text>
            <View style={{
              borderRadius: 20,
              overflow: 'hidden',
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.border,
            }}>
              {faqItems.map((item, i) => (
                <TouchableOpacity
                  key={i}
                  onPress={() => setExpandedFaq(expandedFaq === i ? null : i)}
                  activeOpacity={0.7}
                  style={{
                    paddingHorizontal: 20,
                    paddingVertical: 16,
                    borderTopWidth: i > 0 ? 1 : 0,
                    borderTopColor: colors.border,
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ color: colors.text, fontSize: 14, fontWeight: '600', flex: 1, marginRight: 12 }}>{item.q}</Text>
                    {expandedFaq === i
                      ? <IconChevronUp size={18} color={colors.textTertiary} />
                      : <IconChevronDown size={18} color={colors.textTertiary} />
                    }
                  </View>
                  {expandedFaq === i && (
                    <Text style={{
                      color: colors.textSecondary,
                      fontSize: 13,
                      marginTop: 10,
                      lineHeight: 20,
                      paddingLeft: 4,
                    }}>{item.a}</Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </View>

        </View>
      </ScrollView>

      {/* Payment Modal (subscribe or update card) */}
      <Modal visible={!!paymentModal} transparent animationType="none" onRequestClose={closePaymentModal}>
        <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={closePaymentModal}>
          <Animated.View style={{ opacity: modalOpacityAnim, transform: [{ scale: modalScaleAnim }, { translateX: shakeAnim }] }}>
          <TouchableOpacity activeOpacity={1} style={[s.paymentModalCard, { backgroundColor: colors.surface, ...Shadow.lg }]} onPress={() => {}}>
            <ScrollView showsVerticalScrollIndicator={false} bounces={false} style={{ maxHeight: 600 }}>
            {paymentSuccess ? (
              /* ===== Success State ===== */
              <View style={{ alignItems: 'center', paddingVertical: 32 }}>
                <AnimatedCheckmark color={GREEN} size={80} />
                <Text style={{ color: colors.text, fontSize: 22, fontWeight: '800', marginTop: 20, marginBottom: 6, textAlign: 'center' }}>
                  {modalMode === 'update_card' ? t('plans.cardUpdated') : t('plans.paymentApproved')}
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.base, textAlign: 'center', marginBottom: 8, lineHeight: 22 }}>
                  {modalMode === 'update_card' ? t('plans.cardUpdatedDesc') : t('plans.planActiveDesc', { plan: 'Chatyy ' + modalPlanLabel })}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, marginBottom: 20 }}>
                  <IconShield size={14} color={GREEN} />
                  <Text style={{ color: GREEN, fontSize: FontSize.sm, fontWeight: '600' }}>
                    {t('plans.paymentSuccess')}
                  </Text>
                </View>
              </View>
            ) : (
              /* ===== Card Form ===== */
              <>
                {/* Close button */}
                <TouchableOpacity
                  onPress={closePaymentModal}
                  style={{ position: 'absolute', top: 0, right: 0, zIndex: 10, padding: 8 }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <IconX size={20} color={colors.textTertiary} />
                </TouchableOpacity>

                {/* Header */}
                <View style={{ alignItems: 'center', marginBottom: 24, paddingTop: 4 }}>
                  {modalMode === 'update_card' ? (
                    <>
                      <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: PLUS_COLOR + '15', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
                        <IconShield size={26} color={PLUS_COLOR} />
                      </View>
                      <Text style={{ color: colors.text, fontSize: 22, fontWeight: '800' }}>
                        {t('plans.changeCard')}
                      </Text>
                      <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, marginTop: 6 }}>
                        {subInfo?.plan_label || 'Chatyy Plus'}
                      </Text>
                    </>
                  ) : (
                    <>
                      <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: modalColor + '15', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
                        {modalPlan === 'family'
                          ? <IconUsers size={28} color={modalColor} />
                          : <IconStarFilled size={28} color={modalColor} />
                        }
                      </View>
                      <Text style={{ color: colors.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>
                        Chatyy {modalPlanLabel}
                      </Text>
                      <Text style={{ color: modalColor, fontSize: 24, fontWeight: '800', marginBottom: 4 }}>
                        R${modalPrice}<Text style={{ fontSize: 14, fontWeight: '500', color: colors.textSecondary }}>{t('plans.perMonth')}</Text>
                      </Text>
                      {modalBillingPeriod === 'annual' && modalAnnualTotal && (
                        <Text style={{ color: colors.textSecondary, fontSize: 12, textAlign: 'center', marginBottom: 2 }}>
                          {t('plans.billedAnnually', { total: modalAnnualTotal })}
                        </Text>
                      )}
                      {/* Plan highlights */}
                      <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginTop: 4 }}>
                        {modalPlan === 'family'
                          ? '500GB \u2022 5 ' + t('plans.familyMembers').toLowerCase() + ' \u2022 One AI'
                          : '200GB \u2022 Backup \u2022 One AI'}
                      </Text>
                    </>
                  )}
                </View>

                {/* ===== Apple Pay / Google Pay Button ===== */}
                {modalMode === 'subscribe' && walletPayAvailable && (
                  <>
                    {walletPayAvailable.applePay && (
                      <WalletPayButton type="applePay" onPress={handleWalletPay} colors={colors} isDark={isDark} />
                    )}
                    {walletPayAvailable.googlePay && !walletPayAvailable.applePay && (
                      <WalletPayButton type="googlePay" onPress={handleWalletPay} colors={colors} isDark={isDark} />
                    )}

                    {/* Divider: "ou" / "or" */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 20 }}>
                      <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
                      <Text style={{ color: colors.textTertiary, fontSize: 13, fontWeight: '500', paddingHorizontal: 16 }}>
                        {t('plans.orPayWithCard')}
                      </Text>
                      <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
                    </View>
                  </>
                )}

                {/* Saved card option */}
                {savedCard?.last4 && paymentModal?.mode !== 'update_card' && (
                  <View style={{ marginBottom: 16 }}>
                    <TouchableOpacity
                      style={{
                        flexDirection: 'row', alignItems: 'center', padding: 16,
                        borderRadius: 14, borderWidth: 2,
                        borderColor: useSavedCard ? colors.primary : colors.border,
                        backgroundColor: useSavedCard ? (isDark ? 'rgba(99,102,241,0.08)' : 'rgba(99,102,241,0.04)') : 'transparent',
                      }}
                      onPress={() => setUseSavedCard(true)}
                      activeOpacity={0.7}
                    >
                      <View style={{
                        width: 22, height: 22, borderRadius: 11, borderWidth: 2,
                        borderColor: useSavedCard ? colors.primary : colors.border,
                        alignItems: 'center', justifyContent: 'center', marginRight: 12,
                      }}>
                        {useSavedCard && <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.primary }} />}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>
                          {(savedCard.brand || 'card').charAt(0).toUpperCase() + (savedCard.brand || 'card').slice(1)} •••• {savedCard.last4}
                        </Text>
                        <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                          Validade: {savedCard.exp_month}/{savedCard.exp_year}
                        </Text>
                      </View>
                      <IconCheck size={18} color={useSavedCard ? colors.primary : 'transparent'} />
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={{
                        flexDirection: 'row', alignItems: 'center', padding: 16, marginTop: 8,
                        borderRadius: 14, borderWidth: 2,
                        borderColor: !useSavedCard ? colors.primary : colors.border,
                        backgroundColor: !useSavedCard ? (isDark ? 'rgba(99,102,241,0.08)' : 'rgba(99,102,241,0.04)') : 'transparent',
                      }}
                      onPress={() => setUseSavedCard(false)}
                      activeOpacity={0.7}
                    >
                      <View style={{
                        width: 22, height: 22, borderRadius: 11, borderWidth: 2,
                        borderColor: !useSavedCard ? colors.primary : colors.border,
                        alignItems: 'center', justifyContent: 'center', marginRight: 12,
                      }}>
                        {!useSavedCard && <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.primary }} />}
                      </View>
                      <Text style={{ color: colors.text, fontSize: 15, fontWeight: '500' }}>Usar outro cartão</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {/* Card form - Web uses Stripe Elements, Mobile uses manual fields */}
                {(!savedCard?.last4 || !useSavedCard || paymentModal?.mode === 'update_card') && (
                <>
                {Platform.OS === 'web' ? (
                  <View style={{ marginBottom: 20 }}>
                    <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, fontWeight: '600', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {t('plans.cardDetails')}
                    </Text>
                    <View
                      style={[s.stripeCardContainer, {
                        borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)',
                        backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : '#fafafa',
                      }]}
                      nativeID="stripe-card-wrapper"
                    >
                      <div
                        id="stripe-card-element"
                        style={{ padding: '14px 16px', minHeight: 48 }}
                      />
                    </View>
                  </View>
                ) : (
                  /* Mobile manual fields */
                  <>
                    {/* Card holder name */}
                    <View style={{ marginBottom: 14 }}>
                      <Text style={[s.fieldLabel, { color: colors.textSecondary }]}>
                        {t('plans.cardHolder')}
                      </Text>
                      <TextInput
                        ref={nameInputRef}
                        value={cardName}
                        onChangeText={setCardName}
                        placeholder={t('plans.cardHolder')}
                        placeholderTextColor={colors.textTertiary}
                        autoCapitalize="words"
                        returnKeyType="next"
                        style={[s.cardInputPremium, { color: colors.text, borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)', backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : '#fafafa' }]}
                      />
                    </View>

                    {/* Card Number */}
                    <View style={{ marginBottom: 14 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <Text style={[s.fieldLabel, { color: colors.textSecondary, marginBottom: 0 }]}>
                          {t('plans.cardNumber')}
                        </Text>
                        <CardBrandIcon brand={cardBrand} large />
                      </View>
                      <TextInput
                        value={cardNumber}
                        onChangeText={handleCardNumberChange}
                        placeholder="4242  4242  4242  4242"
                        placeholderTextColor={colors.textTertiary}
                        keyboardType="number-pad"
                        maxLength={19}
                        returnKeyType="next"
                        style={[s.cardInputPremium, s.cardInputMono, { color: colors.text, borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)', backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : '#fafafa' }]}
                      />
                    </View>

                    {/* Expiry + CVC row */}
                    <View style={{ flexDirection: 'row', gap: 14, marginBottom: 20 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={[s.fieldLabel, { color: colors.textSecondary }]}>
                          {t('plans.expiry')}
                        </Text>
                        <TextInput
                          ref={expiryInputRef}
                          value={cardExpiry}
                          onChangeText={handleExpiryChange}
                          placeholder="MM/AA"
                          placeholderTextColor={colors.textTertiary}
                          keyboardType="number-pad"
                          maxLength={5}
                          returnKeyType="next"
                          style={[s.cardInputPremium, { color: colors.text, borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)', backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : '#fafafa' }]}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[s.fieldLabel, { color: colors.textSecondary }]}>
                          CVC
                        </Text>
                        <TextInput
                          ref={cvcInputRef}
                          value={cardCvc}
                          onChangeText={handleCvcChange}
                          placeholder={'\u2022\u2022\u2022'}
                          placeholderTextColor={colors.textTertiary}
                          keyboardType="number-pad"
                          maxLength={4}
                          secureTextEntry
                          returnKeyType="done"
                          style={[s.cardInputPremium, { color: colors.text, borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)', backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : '#fafafa' }]}
                        />
                      </View>
                    </View>
                  </>
                )}
                </>
                )}

                {/* Error banner */}
                {paymentError ? (
                  <Animated.View style={{
                    opacity: errorBannerAnim,
                    backgroundColor: isDark ? 'rgba(239, 68, 68, 0.12)' : 'rgba(239, 68, 68, 0.06)',
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: isDark ? 'rgba(239, 68, 68, 0.3)' : 'rgba(239, 68, 68, 0.2)',
                    padding: 14,
                    marginBottom: 16,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                  }}>
                    <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: '#ef444420', alignItems: 'center', justifyContent: 'center' }}>
                      <IconX size={14} color="#ef4444" />
                    </View>
                    <Text style={{ color: '#ef4444', fontSize: FontSize.sm, fontWeight: '500', flex: 1 }}>{paymentError}</Text>
                  </Animated.View>
                ) : null}

                {/* Pay / Update button */}
                <TouchableOpacity
                  style={[s.payBtnPremium, {
                    backgroundColor: paymentLoading ? (modalColor + '80') : modalColor,
                    opacity: paymentLoading ? 0.85 : 1,
                  }]}
                  onPress={handlePaymentSubmit}
                  disabled={paymentLoading}
                  activeOpacity={0.85}
                >
                  {paymentLoading ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <SpinningLoader color="#fff" size={20} />
                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                        {modalMode === 'update_card' ? t('plans.updatingCard') : t('plans.processing')}
                      </Text>
                    </View>
                  ) : (
                    <Text style={{ color: '#fff', fontSize: 17, fontWeight: '800', letterSpacing: 0.3 }}>
                      {modalMode === 'update_card'
                        ? t('plans.changeCard')
                        : modalBillingPeriod === 'annual'
                          ? `${t('plans.subscribe')} R$${modalAnnualTotal}${t('plans.perYear')}`
                          : t('plans.subscribeCta', { price: modalPrice })}
                    </Text>
                  )}
                </TouchableOpacity>

                {/* Security badge */}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 16, gap: 6 }}>
                  <IconShield size={13} color={colors.textTertiary} />
                  <Text style={{ color: colors.textTertiary, fontSize: 12 }}>
                    {t('plans.securePayment')}
                  </Text>
                </View>

                {/* Cancel link */}
                <TouchableOpacity onPress={closePaymentModal} style={{ alignItems: 'center', marginTop: 14, paddingVertical: 8 }}>
                  <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, fontWeight: '500' }}>
                    {t('plans.cancelPayment')}
                  </Text>
                </TouchableOpacity>
              </>
            )}
            </ScrollView>
          </TouchableOpacity>
          </Animated.View>
        </TouchableOpacity>
      </Modal>

      {/* Cancel Subscription Confirmation Modal */}
      <Modal visible={showCancelConfirm} transparent animationType="fade" onRequestClose={() => setShowCancelConfirm(false)}>
        <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => !cancelLoading && setShowCancelConfirm(false)}>
          <TouchableOpacity activeOpacity={1} style={[s.modalCard, { backgroundColor: colors.surface, ...Shadow.lg }]} onPress={() => {}}>
            <View style={{ alignItems: 'center', marginBottom: 16 }}>
              <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: isDark ? 'rgba(239, 68, 68, 0.15)' : 'rgba(239, 68, 68, 0.08)', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                <IconX size={24} color={RED} />
              </View>
              <Text style={{ color: colors.text, fontSize: FontSize.lg, fontWeight: '700', textAlign: 'center', marginBottom: 8 }}>
                {t('plans.cancelSubscription')}
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, textAlign: 'center', lineHeight: 20 }}>
                {t('plans.cancelConfirmMessage', { date: formatDateBR(subInfo?.current_period_end) })}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
              <TouchableOpacity
                style={[s.modalBtn, { backgroundColor: colors.background, borderColor: colors.border, borderWidth: 1 }]}
                onPress={() => setShowCancelConfirm(false)}
                disabled={cancelLoading}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>{t('plans.keepPlan')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalBtn, { backgroundColor: RED, flex: 1 }]}
                onPress={handleCancelSubscription}
                disabled={cancelLoading}
              >
                {cancelLoading ? <ActivityIndicator color="#fff" size="small" /> :
                  <Text style={{ color: '#fff', fontWeight: '600' }}>{t('plans.cancelSubscription')}</Text>
                }
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Add Member Modal */}
      <Modal visible={showAddMember} transparent animationType="fade" onRequestClose={() => setShowAddMember(false)}>
        <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setShowAddMember(false)}>
          <TouchableOpacity activeOpacity={1} style={[s.modalCard, { backgroundColor: colors.surface, ...Shadow.lg }]}>
            <Text style={{ color: colors.text, fontSize: FontSize.lg, fontWeight: '600', marginBottom: 16 }}>{t('plans.addMember')}</Text>
            <TextInput
              value={newMemberEmail}
              onChangeText={setNewMemberEmail}
              placeholder={t('plans.addMemberPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              keyboardType="email-address"
              autoCapitalize="none"
              style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
            />
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}>
              <TouchableOpacity
                style={[s.modalBtn, { backgroundColor: colors.background, borderColor: colors.border, borderWidth: 1 }]}
                onPress={() => setShowAddMember(false)}
              >
                <Text style={{ color: colors.text }}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalBtn, { backgroundColor: FAMILY_COLOR, flex: 1 }]}
                onPress={handleAddMember}
                disabled={addingMember}
              >
                {addingMember ? <ActivityIndicator color="#fff" size="small" /> :
                  <Text style={{ color: '#fff', fontWeight: '600' }}>{t('plans.addMember')}</Text>
                }
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  headerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg, paddingVertical: 14, borderBottomWidth: 1,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  headerTitle: { fontSize: FontSize.xl, fontWeight: '700' },
  scrollContent: { paddingTop: 0, paddingBottom: 40 },
  subtitle: { fontSize: FontSize.base, textAlign: 'center', marginBottom: 24 },
  currentBanner: {
    borderRadius: 20, borderWidth: 1, padding: Spacing.lg, marginBottom: 20, marginTop: 20,
  },
  planCard: {
    borderRadius: 20, borderWidth: 1, padding: 24, marginBottom: 16,
    overflow: 'hidden',
  },
  planCardHighlight: { position: 'relative' },
  planGradientStrip: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 4, borderTopLeftRadius: 20, borderTopRightRadius: 20,
  },
  planHeader: { gap: 4 },
  planName: { fontSize: 24, fontWeight: '800' },
  currentBadge: {
    paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20, alignSelf: 'flex-start',
  },
  popularBadge: {
    paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12,
  },
  subscribeBtn: {
    height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    marginTop: 20, ...Shadow.md,
  },
  subscribeBtnText: { color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },
  section: {
    borderRadius: 20, borderWidth: 1, padding: 20, marginTop: 8, marginBottom: 16,
  },
  addMemberBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 20, borderWidth: 1,
  },
  storageBarBg: { height: 6, borderRadius: 3, overflow: 'hidden' },
  storageBarFill: { height: 6, borderRadius: 3 },
  memberRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  storageWarning: {
    borderRadius: 20, borderWidth: 1, padding: 20, marginBottom: 20,
    alignItems: 'center',
  },
  faqItem: {
    borderRadius: 16, borderWidth: 1, padding: Spacing.lg, marginBottom: 8,
  },
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center',
  },
  modalCard: {
    width: 360, maxWidth: '90%', borderRadius: BorderRadius.xl, padding: 24,
  },
  paymentModalCard: {
    width: 440, maxWidth: '94%', borderRadius: 20, padding: 32,
  },
  input: {
    borderWidth: 1, borderRadius: BorderRadius.md, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: FontSize.base,
  },
  cardInput: {
    borderWidth: 1, borderRadius: BorderRadius.md, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: FontSize.base,
  },
  cardInputPremium: {
    borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14,
    fontSize: 16,
  },
  cardInputMono: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 18,
    letterSpacing: 2,
  },
  fieldLabel: {
    fontSize: 13, fontWeight: '600', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5,
  },
  stripeCardContainer: {
    borderWidth: 1.5, borderRadius: 12, overflow: 'hidden',
  },
  payBtn: {
    paddingVertical: 14, borderRadius: BorderRadius.lg, alignItems: 'center', justifyContent: 'center',
    ...Shadow.md,
  },
  payBtnPremium: {
    paddingVertical: 16, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    height: 54,
    ...Shadow.md,
  },
  modalBtn: {
    paddingVertical: 12, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center',
    flex: 1,
  },
  manageBtnSmall: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: BorderRadius.md, borderWidth: 1,
  },
});
