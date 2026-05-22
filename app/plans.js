import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput, Animated,
  ActivityIndicator, Platform, Alert, Modal, useWindowDimensions, Linking, Easing,
} from 'react-native';
import { useRouter, useLocalSearchParams, Redirect } from 'expo-router';
// [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag
import { PLANS_ENABLED } from '../constants/featureFlags';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useCurrency } from '../context/CurrencyContext';
import { useAuth } from '../context/AuthContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import * as IAP from '../services/iap';
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
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(glowAnim, { toValue: 0.4, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  useEffect(() => {
    if (showAll) return;
    const interval = setInterval(() => {
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 0, duration: 250, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(slideAnim, { toValue: -24, duration: 250, easing: Easing.out(Easing.ease), useNativeDriver: true }),
      ]).start(() => {
        setCurrentIndex(prev => (prev + 1) % ONE_AI_ACTIONS.length);
        slideAnim.setValue(24);
        Animated.parallel([
          Animated.timing(fadeAnim, { toValue: 1, duration: 350, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(slideAnim, { toValue: 0, duration: 350, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        ]).start();
      });
    }, 2200);
    return () => clearInterval(interval);
  }, [showAll]);

  const AI_DEMOS = [
    { Icon: IconMessageSquare, color: '#7C3AED', title: 'WhatsApp', desc: t('plans.aiWhatsapp') },
    { Icon: IconPhone, color: '#A78BFA', title: t('plans.cancel').includes('Cancelar') ? 'Liga\u00E7\u00F5es' : 'Calls', desc: t('plans.aiCalls') },
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
                backgroundImage: 'linear-gradient(90deg, #A78BFA, #c4b5fd, #8b5cf6)',
              } : {}),
            }} />
          </View>
        )}

        {/* 3-column AI feature grid */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 20, width: '100%' }}>
          {AI_DEMOS.map((demo, i) => (
            <View key={i} style={{
              width: '30%',
              minWidth: 85,
              flexGrow: 1,
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
        Animated.spring(scaleAnim, { toValue: 1, friction: 4, tension: 100, useNativeDriver: true }),
        Animated.timing(opacityAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
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
    const loop = Animated.loop(
      Animated.timing(spinAnim, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
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

// Plan pricing and feature config (must match App Store Connect prices)
// 2026-04 redesigned 3-tier ladder (Free / Plus / Pro). Backend
// constants live in /var/www/mail/api/plans.php and use the same
// shape; this client copy is the source of truth for the upgrade
// screen rendering. Legacy `one` and `family` keys are kept as
// aliases so the rest of the app (storage chooser, IAP receipts,
// subscription rows) keeps working during the rename window.
// Pricing reuses the ASC-approved legacy SKUs (one_monthly R$14.99 +
// family_monthly R$29.99) so we don't need a new App Store review.
// Plus = legacy "one" tier; Pro = legacy "family" tier. Tier names
// were rebranded to feel modern; pricing stays exactly what the
// store already accepted.
const PLANS = {
  free:   { price: 0,     storage: 100,  maxFile: 2, mediaRetention: null, label: 'Chatyy Free' },
  plus:   { price: 14.99, storage: 200,  maxFile: 2, mediaRetention: null, label: 'Chatyy Plus' },
  pro:    { price: 29.99, storage: 500,  maxFile: 2, mediaRetention: null, label: 'Chatyy Pro', maxMembers: 6 },
  // Legacy aliases — same entitlement, old name routes here.
  one:    { price: 14.99, storage: 200,  maxFile: 2, mediaRetention: null, label: 'Chatyy Plus' },
  family: { price: 29.99, storage: 500,  maxFile: 2, mediaRetention: null, label: 'Chatyy Pro', maxMembers: 6 },
};

// Pricing in centavos. Monthly + annual values match the ASC-approved
// products (one_*: R$14.99/R$12.49 ; family_*: R$29.99/R$23.33). Annual
// rates are the per-month equivalent that StoreKit charges yearly:
//   plus.annual  = 1249 → R$12.49/mo  → R$149.88 billed yearly
//   pro.annual   = 2333 → R$23.33/mo  → R$279.96 billed yearly
const PRICING = {
  plus:   { monthly: 1499, annual: 1249 },
  pro:    { monthly: 2999, annual: 2333 },
  // Legacy keys still receive the same prices.
  one:    { monthly: 1499, annual: 1249 },
  family: { monthly: 2999, annual: 2333 },
};

// Storage add-on prices (Apple tier prices)
const STORAGE_EXTRA = {
  500: { monthly: 999, annual: 799 },         // R$9.99/mo or R$7.99/mo
  1000: { monthly: 1999, annual: 1499 },      // R$19.99/mo or R$14.99/mo
  2000: { monthly: 3499, annual: 2999 },      // R$34.99/mo or R$29.99/mo
};

// Storage tier options per plan (extra = price in centavos on top of base plan)
const STORAGE_OPTIONS_ONE = [
  { gb: 200, extra: 0, label: '200GB', included: true },
  { gb: 500, extra: 499, label: '500GB' },
  { gb: 1000, extra: 1499, label: '1TB' },
  { gb: 2000, extra: 2499, label: '2TB' },
];

// Pro tier (legacy "family") ships with 500GB included — matches the
// ASC-approved family_monthly product. Storage add-ons let users top
// up to 1TB or 2TB without leaving the tier.
const STORAGE_OPTIONS_FAMILY = [
  { gb: 500,  extra: 0,    label: '500GB', included: true },
  { gb: 1000, extra: 999,  label: '1TB' },
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
    const timeout = setTimeout(() => {
      stripePromise = null; // allow retry
      reject(new Error('Stripe.js load timeout'));
    }, 15000);
    script.onload = () => { clearTimeout(timeout); resolve(window.Stripe(STRIPE_PK)); };
    script.onerror = () => { clearTimeout(timeout); stripePromise = null; reject(new Error('Failed to load Stripe.js')); };
    document.head.appendChild(script);
  });
  return stripePromise;
}

export default function PlansScreen() {
  // [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag.
  // Plans/Premium/IAP all paused — app ships WhatsApp-style fully free.
  // Route stays registered so any lingering deep-link is a soft redirect
  // instead of a 404. Flip PLANS_ENABLED to bring the subscription
  // upgrade flow back without a rebuild.
  if (!PLANS_ENABLED) {
    return <Redirect href="/chat" />;
  }
  const { colors, isDark } = useTheme();
  const { t, language } = useLanguage();
  // Display currency for past invoices + current subscription amount.
  // NOTE: the headline pricing tiles still render BRL directly because
  // App Store / Play Store IAP receipts come back in BRL and the user
  // is actually charged the BRL price — converting on the tile would
  // mislead. Only post-sale displays (where the amount is informational)
  // get the converted view.
  const { format: formatMoney } = useCurrency(language);
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
  const [storageUpgradeLoading, setStorageUpgradeLoading] = useState(false);

  // Apple IAP state
  const [iapProducts, setIapProducts] = useState([]);
  const [iapConnected, setIapConnected] = useState(false);
  const [iapPurchasing, setIapPurchasing] = useState(false);
  const [iapRestoring, setIapRestoring] = useState(false);
  const [hasAppleSub, setHasAppleSub] = useState(false);
  const isIOS = Platform.OS === 'ios';

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

  // Initialize Apple IAP on iOS
  useEffect(() => {
    if (!isIOS) return;
    let cancelled = false;
    const init = async () => {
      try {
        // initIAP() returns a boolean (true/false) — NOT an object. The
        // previous code destructured `{ products, connected }` from it
        // which yielded undefined and crashed as soon as anything on the
        // screen touched those values. Fix: read products via getProducts().
        const connected = await IAP.initIAP();
        if (!cancelled) {
          let products = [];
          try { products = IAP.getProducts() || []; } catch {}
          setIapProducts(products);
          setIapConnected(!!connected);
        }
        try {
          const subRes = await api.iapSubscriptionInfo();
          if (!cancelled && subRes?.data?.has_subscription) {
            setHasAppleSub(true);
          }
        } catch {}
      } catch (e) {
        if (__DEV__) console.warn('[Plans] IAP init error:', e?.message);
      }
    };
    init();
    return () => {
      cancelled = true;
      try { IAP.disconnectIAP?.(); } catch {}
    };
  }, [isIOS]);

  // Animate modal in when opening
  useEffect(() => {
    if (paymentModal) {
      modalScaleAnim.setValue(0.9);
      modalOpacityAnim.setValue(0);
      Animated.parallel([
        Animated.spring(modalScaleAnim, { toValue: 1, friction: 8, tension: 100, useNativeDriver: true }),
        Animated.timing(modalOpacityAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
      ]).start();
    }
  }, [paymentModal]);

  // Animate error shake
  useEffect(() => {
    if (paymentError) {
      errorBannerAnim.setValue(0);
      Animated.timing(errorBannerAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
      // Shake animation
      Animated.sequence([
        Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 8, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -8, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 4, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
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
            const planLabel = paymentModal.plan === 'family' ? 'Chatyy Pro' : 'Chatyy Plus';
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

  // Handle IAP purchase on iOS — real StoreKit subscription via react-native-iap.
  // Show a diagnostic alert when IAP can't load. The failure mode changes
  // the user-visible message + action buttons so the user can actually
  // recover instead of seeing a generic "try again" dead-end.
  const showIapUnavailable = () => {
    const diag = IAP.getLastDiagnostic?.() || '';
    let title = t('iap.unavailableTitle') || 'Assinaturas indisponíveis';
    let body = '';
    let buttons = null;

    if (diag === 'module_not_loaded') {
      body = 'O suporte a assinaturas não está disponível nesta versão do app. Instale a última versão pelo TestFlight.';
    } else if (diag === 'no_products_returned') {
      // Apple's StoreKit (esp. during App Review) sometimes returns 0 products
      // on the first init call. The retry inside initIAP() catches most cases;
      // when it still fails we ask the user to retry — but DO NOT instruct the
      // App Review team to set up sandbox testers (that confused them and
      // triggered rejections). Reviewers see this same dialog as users do.
      body =
        'Não conseguimos carregar os planos da Apple agora. Isso costuma ser temporário.\n\n' +
        'Toque em "Tentar de novo" em alguns segundos. Se persistir, feche e reabra o app.';
      buttons = [
        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
        { text: t('iap.retry') || 'Tentar de novo', onPress: () => { try { IAP.initIAP?.(); } catch {} } },
      ];
    } else if (diag && diag.startsWith('fetch_failed')) {
      body =
        'Não conseguimos carregar os planos na Apple Store agora. Pode ser um problema temporário de rede.\n\n' +
        `Detalhe técnico: ${diag.replace('fetch_failed:', '')}\n\n` +
        'Verifique sua conexão e tente de novo.';
    } else if (diag && diag.startsWith('init_failed')) {
      body =
        'Não conseguimos conectar ao StoreKit da Apple.\n\n' +
        `Detalhe: ${diag.replace('init_failed:', '')}\n\n` +
        'Tente fechar e abrir o app novamente.';
    } else {
      body = 'Não conseguimos carregar os planos agora. Feche e abra o app e tente de novo.';
    }

    if (buttons) {
      if (typeof Alert !== 'undefined' && Alert.alert) {
        Alert.alert(title, body, buttons);
      } else {
        safeAlert(title, body);
      }
    } else {
      safeAlert(title, body);
    }
  };

  const handleIAPPurchase = async (plan, storage, billing) => {
    const bp = billing || billingPeriod;
    const storageGb = storage?.gb && !storage?.included ? storage.gb : null;

    let productId;
    if (storageGb && currentPlan !== 'free') {
      productId = IAP.getProductId(null, 'monthly', storageGb);
    } else {
      productId = IAP.getProductId(plan, bp);
    }

    if (!productId) {
      // IAP path missing → don't dead-end the user with "Em breve". Surface
      // a real CTA pointing at the web checkout (which uses their existing
      // Chatyy credentials). Falls back to safeAlert if Alert.alert isn't
      // available (web SSR / prerender edge).
      const planSlug = plan === 'family' ? 'pro' : (plan === 'one' ? 'plus' : plan);
      const webUrl = 'https://chatyy.com.br/plans?plan=' + encodeURIComponent(planSlug);
      const title = t('iap.unavailableTitleShort') || 'Assinaturas in-app indisponíveis no momento';
      const body = t('iap.fallbackBody') || 'Você pode usar suas credenciais Chatyy normais.';
      if (typeof Alert !== 'undefined' && Alert.alert) {
        Alert.alert(title, body, [
          { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
          { text: t('iap.subscribeOnWeb') || 'Assinar pelo site', onPress: () => { try { Linking.openURL(webUrl); } catch {} } },
        ]);
      } else {
        safeAlert(title, body);
      }
      return;
    }

    // Disclosure dialog BEFORE opening StoreKit sheet. Only the Chatyy One
    // plan has the 30-day intro offer configured in ASC — Family doesn't
    // (and would confuse user if we claimed a trial it doesn't get).
    const hasTrial = !storageGb && plan === 'one';
    if (hasTrial) {
      const trialMsg = t('iap.trialConfirmMsg') ||
        'Você terá 30 dias grátis pra testar. Depois disso, a cobrança ' +
        'começa automaticamente via Apple. Pode cancelar a qualquer momento ' +
        'em Ajustes → [seu nome] → Assinaturas.';
      const confirmed = await new Promise((resolve) => {
        if (typeof Alert !== 'undefined' && Alert.alert) {
          Alert.alert(
            t('iap.trialConfirmTitle') || '30 dias grátis',
            trialMsg,
            [
              { text: t('common.cancel') || 'Cancelar', style: 'cancel', onPress: () => resolve(false) },
              { text: t('iap.continuePurchase') || 'Começar trial', onPress: () => resolve(true) },
            ]
          );
        } else { resolve(true); }
      });
      if (!confirmed) return;
    }

    setIapPurchasing(true);
    try {
      const result = await IAP.purchaseSubscription(productId);
      if (result?.deferred) {
        safeAlert(t('iap.purchaseDeferred'), '');
      } else {
        // requestPurchase returns immediately after queuing — the real
        // success event arrives via purchaseUpdatedListener → receipt
        // verify → backend flips plan. We wait ~2s then refresh so the
        // UI reflects the new plan. Without this delay, loadPlanInfo()
        // races against the listener and shows the stale plan.
        safeAlert(t('iap.purchaseSuccess'), t('plans.planActiveDesc', { plan: plan === 'family' || plan === 'pro' ? 'Pro' : 'Plus' }));
        setHasAppleSub(true);
        setTimeout(() => { loadPlanInfo().catch(() => {}); }, 2500);
      }
    } catch (e) {
      if (e.message === 'CANCELLED' || e.message === 'ios_iap_unavailable') {
        // Cancelled by user OR iOS IAP not yet configured — silent noop.
        // Apple review: we do NOT show error alerts on tap.
      } else {
        safeAlert(
          t('iap.comingSoonTitle') || 'Em breve',
          t('iap.comingSoonBody') || 'Assinaturas in-app estão em aprovação. Assine pelo site em chatyy.com.br/plans.'
        );
        if (__DEV__) console.warn('[Plans] IAP purchase error:', e);
      }
    } finally {
      setIapPurchasing(false);
    }
  };

  // Handle restore purchases (iOS only)
  const handleRestorePurchases = async () => {
    setIapRestoring(true);
    try {
      const result = await IAP.restorePurchases();
      if (result?.success) {
        safeAlert(t('iap.restoreSuccess'), '');
        setHasAppleSub(true);
        await loadPlanInfo();
      } else {
        safeAlert(t('iap.restoreNotFound'), '');
      }
    } catch (e) {
      safeAlert('Erro', t('iap.restoreNotFound'));
      console.error('[Plans] Restore error:', e);
    } finally {
      setIapRestoring(false);
    }
  };

  const handleUpgrade = async (plan, storage, billing) => {
    const bp = billing || billingPeriod;

    // iOS: ALWAYS use Apple IAP. Never show Stripe on iOS — Apple rejects
    // third-party billing for digital goods (Guideline 3.1.1). If the user
    // already has ANY active plan (iAP or Stripe from web), switching plans
    // on iOS goes through Apple's subscription-group upgrade flow (same
    // group, different product = auto-prorated swap by Apple).
    if (isIOS) {
      let available = IAP.isAvailable() && IAP.getProducts().length > 0;
      if (!available) {
        try { await IAP.initIAP(); available = IAP.isAvailable() && IAP.getProducts().length > 0; } catch {}
      }
      if (available) return handleIAPPurchase(plan, storage, billing);
      showIapUnavailable();
      return;
    }

    // Non-iOS (web + Android): Stripe path.
    // If already a paid subscriber, try to do a plan change (no card needed).
    if (currentPlan !== 'free' && currentPlan !== plan) {
      setUpgrading(true);
      try {
        const res = await api.stripeUpgrade(plan);
        if (res?.success) {
          safeAlert(t('plans.upgradeSuccess') || 'Plano atualizado!',
            plan === 'family' ? 'Upgrade para Família concluído! Só a diferença foi cobrada.' : 'Plano alterado com sucesso!');
          await loadPlanInfo();
          if (subInfo) loadSubscriptionInfo();
        } else {
          // The most common failure is "No active subscription" — the user
          // is on a free plan (or renewed outside Stripe) and tapped Upgrade
          // expecting to subscribe. Route them to the new-subscription flow
          // (Stripe checkout) instead of dead-ending on a generic error.
          const msg = (res?.message || '').toLowerCase();
          // Backend now returns data.needs_new_subscription=true for the
          // legacy / IAP-on-web case where user has a plan but no Stripe
          // customer. Route straight to checkout.
          if (res?.data?.needs_new_subscription || msg.includes('no active') || msg.includes('sem assinatura') || msg.includes('nenhuma assinatura')) {
            setUpgrading(false);
            // Drop through to the subscribe-from-scratch flow
            setPaymentModal({ plan, mode: 'subscribe', storage, billingPeriod: bp });
            setCardNumber(''); setCardExpiry(''); setCardCvc(''); setCardName('');
            setPaymentError(''); setPaymentSuccess(false); setPaymentLoading(false);
            api.stripeSavedCard().then(r2 => {
              if (r2?.success && r2?.data?.card?.last4) { setSavedCard(r2.data.card); setUseSavedCard(true); }
              else { setSavedCard(null); setUseSavedCard(false); }
            }).catch(() => { setSavedCard(null); setUseSavedCard(false); });
            return;
          }
          safeAlert('Erro', res?.message || 'Erro ao mudar plano');
        }
      } catch { safeAlert('Erro', 'Erro de conexão'); }
      finally { setUpgrading(false); }
      return;
    }

    // iOS: must go through Apple IAP — showing a Stripe card form on iOS
    // violates App Store Guideline 3.1.1 (non-Apple billing for digital
    // goods) and got us rejected once already. If IAP isn't ready yet
    // (products still loading, sandbox misconfigured, network blip), retry
    // initConnection once on-demand, then surface an error rather than
    // silently falling back to Stripe.
    if (isIOS) {
      let available = IAP.isAvailable() && IAP.getProducts().length > 0;
      if (!available) {
        try {
          await IAP.initIAP();
          available = IAP.isAvailable() && IAP.getProducts().length > 0;
        } catch {}
      }
      if (available) return handleIAPPurchase(plan, storage, billing);
      showIapUnavailable();
      return;
    }

    // Web / Android: Stripe card form
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

  const handleStorageUpgrade = async (storageGb, priceDiffLabel) => {
    const confirmMsg = t('plans.storageUpgradeConfirm', { tier: storageGb >= 1000 ? (storageGb / 1000) + 'TB' : storageGb + 'GB', price: priceDiffLabel });
    const doUpgrade = async () => {
      // On iOS, ALWAYS go through Apple IAP for storage purchases —
      // App Store guideline 3.1.1 forbids using Stripe/external payment
      // for digital goods on iOS. Previously we only switched to IAP if
      // the user already had an Apple subscription, which meant first-time
      // storage buyers on iOS got the Stripe modal and Apple wouldn't
      // accept the build. Now: iOS = IAP always; web/Android = Stripe.
      if (isIOS) {
        const productId = IAP.getProductId(null, 'monthly', storageGb);
        if (!productId) {
          safeAlert(
            t('iap.comingSoonTitle') || 'Em breve',
            t('iap.comingSoonBody') || 'Assinaturas in-app estão em aprovação. Assine pelo site em chatyy.com.br/plans.'
          );
          return;
        }
        setIapPurchasing(true);
        try {
          const result = await IAP.purchaseSubscription(productId);
          if (result && !result.deferred) {
            safeAlert(t('plans.storageUpgradeSuccess'), t('plans.storageUpgradeSuccessMsg'));
            await loadPlanInfo();
          } else if (result?.deferred) {
            safeAlert(t('iap.purchaseDeferred'), '');
          }
        } catch (e) {
          if (e.message !== 'CANCELLED' && e.message !== 'ios_iap_unavailable') {
            safeAlert(
              t('iap.comingSoonTitle') || 'Em breve',
              t('iap.comingSoonBody') || 'Assinaturas in-app estão em aprovação. Assine pelo site em chatyy.com.br/plans.'
            );
          }
        } finally {
          setIapPurchasing(false);
        }
        return;
      }
      setStorageUpgradeLoading(true);
      try {
        const res = await api.stripeUpgrade(currentPlan, storageGb);
        if (res?.success) {
          safeAlert(t('plans.storageUpgradeSuccess'), t('plans.storageUpgradeSuccessMsg'));
          await loadPlanInfo();
          if (subInfo) loadSubscriptionInfo();
        } else {
          safeAlert('Erro', res?.message || t('plans.paymentFailed'));
        }
      } catch { safeAlert('Erro', t('plans.paymentFailed')); }
      finally { setStorageUpgradeLoading(false); }
    };
    safeAlert(t('plans.storageUpgradeTitle'), confirmMsg, [
      { text: t('plans.cancel'), style: 'cancel' },
      { text: 'Upgrade', onPress: doUpgrade },
    ]);
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
    // On iOS with Apple subscription, redirect to App Store
    if (isIOS && hasAppleSub) {
      setShowCancelConfirm(false);
      Linking.openURL('https://apps.apple.com/account/subscriptions');
      return;
    }
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

  const PLUS_COLOR = '#A78BFA';
  const PLUS_LIGHT = isDark ? 'rgba(99, 102, 241, 0.15)' : 'rgba(99, 102, 241, 0.08)';
  const PLUS_BORDER = isDark ? 'rgba(99, 102, 241, 0.3)' : 'rgba(99, 102, 241, 0.2)';
  const FAMILY_COLOR = '#f59e0b';
  const FAMILY_LIGHT = isDark ? 'rgba(245, 158, 11, 0.15)' : 'rgba(245, 158, 11, 0.08)';
  const FAMILY_BORDER = isDark ? 'rgba(245, 158, 11, 0.3)' : 'rgba(245, 158, 11, 0.2)';
  const GREEN = isDark ? '#4ade80' : '#16a34a';
  const AMBER = isDark ? '#fbbf24' : '#d97706';
  const RED = isDark ? '#f87171' : '#dc2626';

  const AI_PURPLE = isDark ? '#a78bfa' : '#7C3AED';

  // Storage tier selector — modern chips
  const StorageSelector = ({ options, selected, onSelect, accentColor, basePriceCents }) => {
    const total = basePriceCents + selected.extra;
    const gradientBg = accentColor === FAMILY_COLOR
      ? 'linear-gradient(135deg, #f59e0b, #f97316)'
      : 'linear-gradient(135deg, #A78BFA, #8b5cf6)';
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
    if (lower.includes('armazenamento') || lower.includes('storage') || lower.includes('almacenamiento') || lower.includes('gb')) return { Icon: IconArchive, color: '#A78BFA' };
    if (lower.includes('backup') || lower.includes('nuvem') || lower.includes('cloud')) return { Icon: IconCloud, color: '#22c55e' };
    if (lower.includes('recuperar') || lower.includes('recover') || lower.includes('apagad')) return { Icon: IconRefresh, color: '#A78BFA' };
    if (lower.includes('arquivo') || lower.includes('file') || lower.includes('mb')) return { Icon: IconPaperclip, color: '#f59e0b' };
    if (lower.includes('proteg') || lower.includes('safe') || lower.includes('segur') || lower.includes('perca') || lower.includes('lose')) return { Icon: IconShield, color: '#10b981' };
    if (lower.includes('dispositivo') || lower.includes('device')) return { Icon: IconSmartphone, color: '#8b5cf6' };
    if (lower.includes('suporte') || lower.includes('support') || lower.includes('priorit')) return { Icon: IconStar, color: '#f59e0b' };
    if (lower.includes('pessoa') || lower.includes('people') || lower.includes('membr') || lower.includes('familia') || lower.includes('family')) return { Icon: IconUsers, color: '#f97316' };
    if (lower.includes('ai') || lower.includes('assistente') || lower.includes('assistant')) return { Icon: IconSparkles, color: '#8b5cf6' };
    if (lower.includes('foto') || lower.includes('photo') || lower.includes('video')) return { Icon: IconImage, color: '#06b6d4' };
    if (lower.includes('gerenciar') || lower.includes('manage') || lower.includes('gestionar')) return { Icon: IconSettings, color: '#64748b' };
    if (lower.includes('compartilh') || lower.includes('shared')) return { Icon: IconLink, color: '#A78BFA' };
    if (lower.includes('tudo') || lower.includes('everything') || lower.includes('todo')) return { Icon: IconStarFilled, color: '#f59e0b' };
    return { Icon: IconCheck, color: '#10b981' };
  };

  const FeatureItem = ({ text, highlight, desc }) => {
    const iconData = highlight ? { Icon: IconSparkles, color: AI_PURPLE } : getFeatureIconData(text);
    const bgColor = isDark ? (iconData.color + '15') : (iconData.color + '0d');
    return (
      <View style={{ flexDirection: 'row', alignItems: highlight ? 'flex-start' : 'center', marginBottom: 16, paddingVertical: 2 }}>
        <View style={{
          width: 38, height: 38, borderRadius: 12,
          backgroundColor: bgColor,
          alignItems: 'center', justifyContent: 'center',
          marginRight: 14,
          borderWidth: 1,
          borderColor: isDark ? (iconData.color + '20') : (iconData.color + '12'),
        }}>
          <iconData.Icon size={18} color={iconData.color} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{
            color: highlight ? AI_PURPLE : colors.text,
            fontSize: 14.5,
            fontWeight: highlight ? '600' : '500',
            lineHeight: 21,
            letterSpacing: 0.1,
          }}>{text}</Text>
          {desc ? (
            <Text style={{ color: colors.textTertiary, fontSize: 12, marginTop: 3, lineHeight: 17 }}>{desc}</Text>
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
  const modalPlanLabel = (modalPlan === 'family' || modalPlan === 'pro') ? 'Chatyy Pro' : 'Chatyy Plus';
  const modalColor = modalPlan === 'family' ? FAMILY_COLOR : PLUS_COLOR;
  const cardBrand = detectCardBrand(cardNumber);

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
            paddingTop: 56,
            paddingBottom: 40,
            alignItems: 'center',
            backgroundColor: isDark ? '#0c0a1a' : '#0f0832',
            ...(Platform.OS === 'web' ? {
              backgroundImage: isDark
                ? 'radial-gradient(ellipse at 50% 0%, rgba(99, 102, 241, 0.2) 0%, transparent 60%), linear-gradient(135deg, #0c0a1a 0%, #1a1040 40%, #0f172a 100%)'
                : 'radial-gradient(ellipse at 50% 0%, rgba(139, 92, 246, 0.25) 0%, transparent 60%), linear-gradient(135deg, #0f0832 0%, #1e1145 30%, #312e81 60%, #5B21B6 100%)',
            } : {}),
          }}>
            {/* Decorative floating orbs (web only) */}
            {Platform.OS === 'web' && (
              <>
                <View style={{ position: 'absolute', top: 20, left: '10%', width: 100, height: 100, borderRadius: 50, backgroundColor: 'rgba(99, 102, 241, 0.08)' }} />
                <View style={{ position: 'absolute', top: 60, right: '5%', width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(139, 92, 246, 0.06)' }} />
              </>
            )}

            {/* Sparkle icon */}
            <View style={{
              width: 48, height: 48, borderRadius: 24,
              backgroundColor: 'rgba(139, 92, 246, 0.2)',
              alignItems: 'center', justifyContent: 'center',
              marginBottom: 16,
              ...(Platform.OS === 'web' ? {
                boxShadow: '0 0 40px rgba(139, 92, 246, 0.3)',
              } : {}),
            }}>
              <IconSparkles size={24} color="#c4b5fd" />
            </View>

            <Text style={{
              color: '#fff',
              fontSize: 38,
              fontWeight: '900',
              textAlign: 'center',
              letterSpacing: -0.6,
              ...(Platform.OS === 'web' ? {
                backgroundImage: 'linear-gradient(135deg, #e9d5ff, #ffffff, #c4b5fd)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              } : {
                textShadowColor: 'rgba(139, 92, 246, 0.7)',
                textShadowOffset: { width: 0, height: 0 },
                textShadowRadius: 30,
              }),
            }}>
              {t('plans.heroTitle') || 'Escolha seu plano'}
            </Text>
            <Text style={{
              color: 'rgba(196, 181, 253, 0.85)',
              fontSize: 15.5,
              textAlign: 'center',
              marginTop: 10,
              fontWeight: '500',
              letterSpacing: 0.2,
              lineHeight: 22,
              maxWidth: 320,
            }}>
              {t('plans.heroSubtitle') || 'Free, Plus ou Pro — pague mensal ou economize com anual.'}
            </Text>

            {/* Quick value pills row */}
            <View style={{
              flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center',
              gap: 8, marginTop: 18, paddingHorizontal: 8,
            }}>
              {[
                { icon: '✓', label: t('plans.heroPill1') || '7 dias grátis' },
                { icon: '✓', label: t('plans.heroPill2') || 'Cancele quando quiser' },
                { icon: '✓', label: t('plans.heroPill3') || 'Sem fidelidade' },
              ].map((p, i) => (
                <View key={i} style={{
                  flexDirection: 'row', alignItems: 'center', gap: 4,
                  paddingVertical: 5, paddingHorizontal: 11,
                  borderRadius: 12,
                  backgroundColor: 'rgba(255,255,255,0.06)',
                  borderWidth: 1, borderColor: 'rgba(196, 181, 253, 0.18)',
                }}>
                  <Text style={{ color: '#10b981', fontSize: 11, fontWeight: '900' }}>{p.icon}</Text>
                  <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 11.5, fontWeight: '600' }}>{p.label}</Text>
                </View>
              ))}
            </View>

            {/* Premium Pill Toggle */}
            <View style={{
              marginTop: 28,
              flexDirection: 'row',
              backgroundColor: 'rgba(255,255,255,0.06)',
              borderRadius: 28,
              padding: 4,
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.08)',
              ...(Platform.OS === 'web' ? {
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                boxShadow: '0 4px 24px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.06)',
              } : {}),
            }}>
              <TouchableOpacity
                style={{
                  paddingVertical: 12,
                  paddingHorizontal: 28,
                  borderRadius: 24,
                  backgroundColor: billingPeriod === 'monthly' ? 'rgba(255,255,255,0.12)' : 'transparent',
                  ...(billingPeriod === 'monthly' && Platform.OS === 'web' ? {
                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                    backdropFilter: 'blur(10px)',
                  } : {}),
                }}
                onPress={() => setBillingPeriod('monthly')}
                activeOpacity={0.7}
              >
                <Text style={{ color: billingPeriod === 'monthly' ? '#fff' : 'rgba(255,255,255,0.45)', fontWeight: '700', fontSize: 14 }}>
                  {t('plans.monthly')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{
                  paddingVertical: 12,
                  paddingHorizontal: 28,
                  borderRadius: 24,
                  backgroundColor: billingPeriod === 'annual' ? 'rgba(255,255,255,0.12)' : 'transparent',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  ...(billingPeriod === 'annual' && Platform.OS === 'web' ? {
                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                    backdropFilter: 'blur(10px)',
                  } : {}),
                }}
                onPress={() => setBillingPeriod('annual')}
                activeOpacity={0.7}
              >
                <Text style={{ color: billingPeriod === 'annual' ? '#fff' : 'rgba(255,255,255,0.45)', fontWeight: '700', fontSize: 14 }}>
                  {t('plans.annual')}
                </Text>
                {/* -33% pill — always visible on the annual button (even
                    when monthly is selected) so the savings are obvious
                    from first glance. Only hidden on the inactive monthly
                    button to avoid visual noise. */}
                <View style={{
                  backgroundColor: '#fbbf24',
                  borderRadius: 8,
                  paddingHorizontal: 7, paddingVertical: 2,
                }}>
                  <Text style={{ color: '#000', fontSize: 10, fontWeight: '900', letterSpacing: 0.3 }}>-33%</Text>
                </View>
              </TouchableOpacity>
            </View>

            {billingPeriod === 'annual' && (
              <View style={{
                marginTop: 12,
                backgroundColor: '#22c55e',
                borderRadius: 14,
                paddingHorizontal: 16,
                paddingVertical: 6,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                ...(Platform.OS === 'web' ? {
                  boxShadow: '0 2px 12px rgba(34, 197, 94, 0.3)',
                } : {}),
              }}>
                <IconCheck size={12} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 0.3 }}>
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
                disabled={upgrading || iapPurchasing}
              >
                <Text style={{ color: '#fff', fontSize: FontSize.base, fontWeight: '700' }}>
                  {t('plans.subscribe')} Chatyy Plus
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
                  {t('plans.yourPlan')}: {(currentPlan === 'plus' || currentPlan === 'one') ? 'Chatyy Plus' : (currentPlan === 'pro' || currentPlan === 'family') ? 'Chatyy Pro' : t('plans.family')}
                </Text>
              </View>
              <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, marginTop: 6, marginLeft: 26, lineHeight: 20 }}>
                {t('plans.thankYou')} {'\u2764\uFE0F'}
              </Text>
              {nextBilling && (
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, marginTop: 4, marginLeft: 26 }}>
                  {t('plans.nextBilling')}: {nextBilling}
                </Text>
              )}
              <View style={{ marginTop: 10, marginLeft: 26 }}>
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, lineHeight: 18 }}>
                  {'\u2022'} {t('plans.storage', { n: PLANS[currentPlan]?.storage || 200 })}
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, lineHeight: 18 }}>
                  {'\u2022'} {t('plans.permanentBackup')}
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, lineHeight: 18 }}>
                  {'\u2022'} {t('plans.recoverMessages')}
                </Text>
                {currentPlan === 'family' && (
                  <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, lineHeight: 18 }}>
                    {'\u2022'} {t('plans.upToPeople', { n: 5 })}
                  </Text>
                )}
              </View>
            </View>
          )}

          {/* Free Card — Subdued but clean */}
          <View style={{
            borderRadius: 24,
            borderWidth: 1,
            padding: 24,
            marginBottom: 16,
            marginTop: 20,
            backgroundColor: isDark ? 'rgba(148,163,184,0.03)' : 'rgba(148,163,184,0.03)',
            borderColor: isDark ? 'rgba(148,163,184,0.12)' : 'rgba(148,163,184,0.12)',
            opacity: currentPlan === 'free' ? 1 : 0.65,
            ...(Platform.OS === 'web' ? {
              transition: 'all 0.3s ease',
            } : {}),
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: '#94a3b8', fontSize: 22, fontWeight: '800' }}>{t('plans.free')}</Text>
              {currentPlan === 'free' && (
                <View style={{ backgroundColor: isDark ? 'rgba(148,163,184,0.12)' : 'rgba(148,163,184,0.08)', paddingHorizontal: 14, paddingVertical: 5, borderRadius: 20 }}>
                  <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '600' }}>{t('plans.yourCurrentPlan')}</Text>
                </View>
              )}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: 8, gap: 2, marginBottom: 4 }}>
              <Text style={{ color: colors.text, fontSize: 38, fontWeight: '800', letterSpacing: -1.5 }}>R$0</Text>
              <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{t('plans.perMonth')}</Text>
            </View>
            <View style={{ marginTop: 14 }}>
              <FeatureItem text={t('plans.storage', { n: '15' })} />
              <FeatureItem text={t('plans.mediaRetention', { n: '30' })} desc={t('plans.mediaExpires30')} />
              <FeatureItem text={t('plans.maxFileSize', { n: '25' })} />
              <FeatureItem text={t('plans.limitedAI')} highlight />
            </View>
          </View>

          {/* ===== Chatyy One Card — Premium Glassmorphism ===== */}
          <View style={{
            borderRadius: 24,
            padding: 28,
            marginBottom: 16,
            overflow: 'hidden',
            position: 'relative',
            borderWidth: (currentPlan === 'plus' || currentPlan === 'one') ? 2 : 1,
            borderColor: isDark ? 'rgba(99,102,241,0.35)' : 'rgba(99,102,241,0.2)',
            backgroundColor: isDark ? 'rgba(99,102,241,0.05)' : 'rgba(99,102,241,0.02)',
            ...(Platform.OS === 'web' ? {
              backdropFilter: 'blur(24px) saturate(150%)',
              WebkitBackdropFilter: 'blur(24px) saturate(150%)',
              boxShadow: isDark
                ? '0 12px 40px rgba(99, 102, 241, 0.15), 0 0 0 1px rgba(99, 102, 241, 0.08), inset 0 1px 0 rgba(255,255,255,0.04)'
                : '0 12px 40px rgba(99, 102, 241, 0.12), 0 0 0 1px rgba(99, 102, 241, 0.06)',
              transition: 'all 0.3s ease',
            } : {}),
          }}>
            {/* Top gradient accent */}
            <View style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: 4,
              backgroundColor: PLUS_COLOR,
              ...(Platform.OS === 'web' ? { backgroundImage: 'linear-gradient(90deg, #4f46e5, #A78BFA, #8b5cf6, #a78bfa)' } : {}),
            }} />

            {/* "Mais popular" badge — recomenda Plus como entry-tier
                e ajuda na decisão. Pesquisa de SaaS pricing mostra que
                marcar a tier do meio aumenta conversão em 30%+. */}
            <View style={{
              position: 'absolute',
              top: 14, right: 14,
              backgroundColor: '#fbbf24',
              borderRadius: 14,
              paddingHorizontal: 10, paddingVertical: 4,
              zIndex: 5,
              ...(Platform.OS === 'web' ? { boxShadow: '0 3px 10px rgba(251, 191, 36, 0.4)' } : { shadowColor: '#fbbf24', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.4, shadowRadius: 8, elevation: 4 }),
            }}>
              <Text style={{ color: '#000', fontSize: 10, fontWeight: '900', letterSpacing: 0.5 }}>
                {t('plans.mostPopular') || 'MAIS POPULAR'}
              </Text>
            </View>

            {/* Annual savings badge — absolute top-right corner (under
                the Mais Popular pill). Uses theme success color tinted
                background (success + '20') so it harmonizes with light
                and dark mode. Renders only when annual toggle is ON.
                Distinct from the inline pct pill next to the price —
                this one's the at-a-glance "discount" affordance the
                user sees while scanning the cards. */}
            {billingPeriod === 'annual' && (() => {
              const pct = Math.round((1 - PRICING.one.annual / PRICING.one.monthly) * 100);
              if (pct < 5) return null;
              return (
                <View style={{
                  position: 'absolute',
                  top: 44, right: 14,
                  backgroundColor: colors.success + '20',
                  borderRadius: 12,
                  paddingHorizontal: 8, paddingVertical: 3,
                  zIndex: 5,
                }}>
                  <Text style={{ color: colors.success, fontSize: 11, fontWeight: '800', letterSpacing: 0.3 }}>
                    {(t('plans.savePercent', { pct }) || `ECONOMIZE ${pct}%`)}
                  </Text>
                </View>
              );
            })()}

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{
                width: 36, height: 36, borderRadius: 11,
                backgroundColor: PLUS_COLOR + '18',
                alignItems: 'center', justifyContent: 'center',
                ...Platform.select({
                  web: { boxShadow: `0 4px 12px ${PLUS_COLOR}33` },
                  ios: { shadowColor: PLUS_COLOR, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 12 },
                  android: { elevation: 4 },
                }),
              }}>
                <IconStarFilled size={20} color={PLUS_COLOR} />
              </View>
              <Text style={{ color: PLUS_COLOR, fontSize: 26, fontWeight: '900', letterSpacing: -0.4 }}>Chatyy Plus</Text>
            </View>

            {/* Price — BIG */}
            <View style={{ marginTop: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                {billingPeriod === 'annual' && (
                  <Text style={{ fontSize: 18, fontWeight: '500', color: colors.textTertiary, textDecorationLine: 'line-through' }}>
                    R${(PRICING.one.monthly / 100).toFixed(2).replace('.', ',')}
                  </Text>
                )}
                <Text style={{
                  color: colors.text, fontSize: 48, fontWeight: '800', letterSpacing: -1.5,
                  ...(Platform.OS === 'web' ? {
                    backgroundImage: `linear-gradient(135deg, ${isDark ? '#e0e7ff' : '#1e1b4b'}, ${isDark ? '#c7d2fe' : '#312e81'})`,
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                  } : {}),
                }}>
                  R${(PRICING.one[billingPeriod] / 100).toFixed(2).replace('.', ',')}
                </Text>
                {/* Percent-discount badge — visible inline com o preço pra
                    surfaca o saving "ECONOMIZE X%" mesmo no mobile (antes
                    só aparecia no hover desktop). Renderiza só se o desconto
                    for >= 10%, threshold pra evitar badge ruidoso quando
                    a diferença é trivial. */}
                {billingPeriod === 'annual' && (() => {
                  const pct = Math.round((1 - PRICING.one.annual / PRICING.one.monthly) * 100);
                  if (pct < 10) return null;
                  return (
                    <View style={{
                      backgroundColor: '#22c55e',
                      borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3,
                      ...(Platform.OS === 'web' ? { boxShadow: '0 2px 6px rgba(34,197,94,0.35)' } : { shadowColor: '#22c55e', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 2 }),
                    }}>
                      <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.3 }}>
                        {(t('plans.savePercent', { pct }) || `ECONOMIZE ${pct}%`)}
                      </Text>
                    </View>
                  );
                })()}
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

            {/* Feature list with icons — full set, transparente sobre o que
                desbloqueia (user reportou que pagava sem saber o que ganhava). */}
            <View>
              <FeatureItem text={t('plans.unlimitedCalls') || 'Chamadas ilimitadas (Chatyy + qualquer número)'} highlight />
              <FeatureItem text={t('plans.aiPriority') || 'IA prioritária — Llama 3.3 70B + transcrição ilimitada'} highlight />
              <FeatureItem text={t('plans.hdVideo') || 'Reels e vídeo em HD (1080p)'} />
              <FeatureItem text={t('plans.aiSummary') || 'Resumo de conversa com IA'} />
              <FeatureItem text={t('plans.storage', { n: '200' })} />
              <FeatureItem text={t('plans.photoBackup')} />
              <FeatureItem text={t('plans.permanentBackup')} />
              <FeatureItem text={t('plans.recoverMessages')} />
              <FeatureItem text={t('plans.maxFileSize', { n: '100' })} />
              <FeatureItem text={t('plans.vanishMode') || 'Modo invisível e mensagens efêmeras'} />
              <FeatureItem text={t('plans.verifiedBadge') || 'Selo verificado e anel dourado no perfil'} />
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
                  minHeight: 58,
                  borderRadius: 18,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginTop: 24,
                  paddingVertical: 14,
                  paddingHorizontal: 20,
                  backgroundColor: PLUS_COLOR,
                  ...(Platform.OS === 'web' ? {
                    backgroundImage: 'linear-gradient(135deg, #4f46e5, #A78BFA, #8b5cf6)',
                    boxShadow: '0 6px 24px rgba(99, 102, 241, 0.35), 0 2px 8px rgba(99, 102, 241, 0.2)',
                    transition: 'all 0.3s ease',
                  } : {}),
                  ...Shadow.md,
                }}
                onPress={() => handleUpgrade('one', selectedStorageOne, billingPeriod)}
                disabled={upgrading || iapPurchasing}
                activeOpacity={0.85}
              >
                {upgrading ? <ActivityIndicator color="#fff" size="small" /> :
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Text style={{ color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 0.3, textAlign: 'center' }}>
                      {t('plans.startNow')} {'\u2014'} R${((PRICING.one[billingPeriod] + selectedStorageOne.extra) / 100).toFixed(2).replace('.', ',')}{t('plans.perMonth')}
                    </Text>
                    <IconArrowRight size={18} color="#fff" />
                  </View>
                }
              </TouchableOpacity>
            )}
          </View>

          {/* ===== Family Card — Premium Glassmorphism ===== */}
          <View style={{
            borderRadius: 24,
            padding: 28,
            marginBottom: 16,
            overflow: 'hidden',
            position: 'relative',
            borderWidth: currentPlan === 'family' ? 2 : 1,
            borderColor: isDark ? 'rgba(245,158,11,0.35)' : 'rgba(245,158,11,0.2)',
            backgroundColor: isDark ? 'rgba(245,158,11,0.05)' : 'rgba(245,158,11,0.02)',
            ...(Platform.OS === 'web' ? {
              backdropFilter: 'blur(24px) saturate(150%)',
              WebkitBackdropFilter: 'blur(24px) saturate(150%)',
              boxShadow: isDark
                ? '0 12px 40px rgba(245, 158, 11, 0.12), 0 0 0 1px rgba(245, 158, 11, 0.08), inset 0 1px 0 rgba(255,255,255,0.04)'
                : '0 12px 40px rgba(245, 158, 11, 0.1), 0 0 0 1px rgba(245, 158, 11, 0.05)',
              transition: 'all 0.3s ease',
            } : {}),
          }}>
            {/* Top gradient accent */}
            <View style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: 4,
              backgroundColor: FAMILY_COLOR,
              ...(Platform.OS === 'web' ? { backgroundImage: 'linear-gradient(90deg, #d97706, #f59e0b, #f97316, #fb923c)' } : {}),
            }} />

            {/* "Melhor custo" — Pro vale o dobro do Plus por menos de
                2× o preço (3 a 6 pessoas no plano = R$5/mês por pessoa). */}
            <View style={{
              position: 'absolute',
              top: 14, right: 14,
              backgroundColor: '#10b981',
              borderRadius: 14,
              paddingHorizontal: 10, paddingVertical: 4,
              zIndex: 5,
              ...(Platform.OS === 'web' ? { boxShadow: '0 3px 10px rgba(16, 185, 129, 0.4)' } : { shadowColor: '#10b981', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.4, shadowRadius: 8, elevation: 4 }),
            }}>
              <Text style={{ color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: 0.5 }}>
                {t('plans.bestValue') || 'MELHOR CUSTO'}
              </Text>
            </View>

            {/* Annual savings badge — same pattern as the Plus card. Pro's
                annual discount is usually ~22%, even more compelling, so
                surfacing it absolute top-right makes the toggle's value
                impossible to miss. */}
            {billingPeriod === 'annual' && (() => {
              const pct = Math.round((1 - PRICING.family.annual / PRICING.family.monthly) * 100);
              if (pct < 5) return null;
              return (
                <View style={{
                  position: 'absolute',
                  top: 44, right: 14,
                  backgroundColor: colors.success + '20',
                  borderRadius: 12,
                  paddingHorizontal: 8, paddingVertical: 3,
                  zIndex: 5,
                }}>
                  <Text style={{ color: colors.success, fontSize: 11, fontWeight: '800', letterSpacing: 0.3 }}>
                    {(t('plans.savePercent', { pct }) || `ECONOMIZE ${pct}%`)}
                  </Text>
                </View>
              );
            })()}

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <View style={{
                width: 36, height: 36, borderRadius: 11,
                backgroundColor: FAMILY_COLOR + '18',
                alignItems: 'center', justifyContent: 'center',
                ...Platform.select({
                  web: { boxShadow: `0 4px 12px ${FAMILY_COLOR}33` },
                  ios: { shadowColor: FAMILY_COLOR, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 12 },
                  android: { elevation: 4 },
                }),
              }}>
                <IconUsers size={20} color={FAMILY_COLOR} />
              </View>
              <Text style={{ color: FAMILY_COLOR, fontSize: 26, fontWeight: '900', letterSpacing: -0.4 }}>Chatyy Pro</Text>
              <View style={{
                backgroundColor: '#f59e0b',
                borderRadius: 14,
                paddingHorizontal: 12,
                paddingVertical: 4,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                ...Platform.select({
                  web: {
                    backgroundImage: 'linear-gradient(135deg, #f59e0b, #d97706)',
                    boxShadow: '0 2px 8px rgba(245, 158, 11, 0.3)',
                  },
                  ios: { shadowColor: '#f59e0b', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 8 },
                  android: { elevation: 3 },
                }),
              }}>
                <IconStarFilled size={10} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 }}>{t('plans.mostPopular')}</Text>
              </View>
            </View>

            {/* Price — BIG */}
            <View style={{ marginTop: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                {billingPeriod === 'annual' && (
                  <Text style={{ fontSize: 18, fontWeight: '500', color: colors.textTertiary, textDecorationLine: 'line-through' }}>
                    R${(PRICING.family.monthly / 100).toFixed(2).replace('.', ',')}
                  </Text>
                )}
                <Text style={{
                  color: colors.text, fontSize: 48, fontWeight: '800', letterSpacing: -1.5,
                  ...(Platform.OS === 'web' ? {
                    backgroundImage: `linear-gradient(135deg, ${isDark ? '#fef3c7' : '#78350f'}, ${isDark ? '#fde68a' : '#92400e'})`,
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                  } : {}),
                }}>
                  R${(PRICING.family[billingPeriod] / 100).toFixed(2).replace('.', ',')}
                </Text>
                {/* Mesmo badge de percentual do Plus — pra Pro o desconto
                    em geral é maior (~22%), super-relevante mostrar inline
                    no card do mobile pra incentivar o switch annual. */}
                {billingPeriod === 'annual' && (() => {
                  const pct = Math.round((1 - PRICING.family.annual / PRICING.family.monthly) * 100);
                  if (pct < 10) return null;
                  return (
                    <View style={{
                      backgroundColor: '#22c55e',
                      borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3,
                      ...(Platform.OS === 'web' ? { boxShadow: '0 2px 6px rgba(34,197,94,0.35)' } : { shadowColor: '#22c55e', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 2 }),
                    }}>
                      <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.3 }}>
                        {(t('plans.savePercent', { pct }) || `ECONOMIZE ${pct}%`)}
                      </Text>
                    </View>
                  );
                })()}
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
                  minHeight: 58,
                  borderRadius: 18,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginTop: 24,
                  paddingVertical: 14,
                  paddingHorizontal: 20,
                  backgroundColor: FAMILY_COLOR,
                  ...(Platform.OS === 'web' ? {
                    backgroundImage: 'linear-gradient(135deg, #d97706, #f59e0b, #f97316)',
                    boxShadow: '0 6px 24px rgba(245, 158, 11, 0.35), 0 2px 8px rgba(245, 158, 11, 0.2)',
                    transition: 'all 0.3s ease',
                  } : {}),
                  ...Shadow.md,
                }}
                onPress={() => handleUpgrade('family', selectedStorageFamily, billingPeriod)}
                disabled={upgrading || iapPurchasing}
                activeOpacity={0.85}
              >
                {upgrading ? <ActivityIndicator color="#fff" size="small" /> :
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Text style={{ color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 0.3, textAlign: 'center' }}>
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
                    {subInfo.plan_label || (currentPlan === 'family' ? 'Chatyy Pro' : 'Chatyy Plus')}
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
                        {formatMoney(subInfo.amount)}/{t('plans.perMonth').replace('/', '')}
                      </Text>
                    </View>
                  </>
                )}
              </View>

              {/* Divider */}
              <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 12 }} />

              {/* Payment failure warning banner */}
              {(subInfo.status === 'past_due' || subInfo.status === 'unpaid') && (
                <View style={{
                  backgroundColor: isDark ? 'rgba(239, 68, 68, 0.12)' : '#fef2f2',
                  borderRadius: 12,
                  padding: 14,
                  marginBottom: 16,
                  borderWidth: 1,
                  borderColor: isDark ? 'rgba(239, 68, 68, 0.25)' : '#fecaca',
                }}>
                  <Text style={{ color: '#ef4444', fontSize: FontSize.sm, fontWeight: '600', marginBottom: 6 }}>
                    {t('plans.paymentFailedWarning')}
                  </Text>
                  <Text style={{ color: isDark ? '#fca5a5' : '#991b1b', fontSize: FontSize.xs, marginBottom: 10, lineHeight: 18 }}>
                    {t('plans.paymentFailedDesc')}
                  </Text>
                  <TouchableOpacity
                    onPress={handleChangeCard}
                    style={{
                      backgroundColor: '#ef4444',
                      borderRadius: 10,
                      paddingVertical: 10,
                      paddingHorizontal: 16,
                      alignItems: 'center',
                    }}
                    activeOpacity={0.8}
                  >
                    <Text style={{ color: '#fff', fontSize: FontSize.sm, fontWeight: '700' }}>
                      {t('plans.updatePaymentMethod')}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Card info */}
              <View style={{ marginBottom: 16 }}>
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, fontWeight: '500', marginBottom: 10 }}>
                  {t('plans.card')}
                </Text>
                {subInfo.card && subInfo.card.last4 ? (
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
                ) : (
                  <TouchableOpacity
                    onPress={handleChangeCard}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      backgroundColor: isDark ? 'rgba(99, 102, 241, 0.12)' : 'rgba(99, 102, 241, 0.06)',
                      borderRadius: 12,
                      paddingVertical: 12,
                      paddingHorizontal: 16,
                      borderWidth: 1,
                      borderColor: isDark ? 'rgba(99, 102, 241, 0.25)' : 'rgba(99, 102, 241, 0.15)',
                    }}
                    activeOpacity={0.7}
                  >
                    <IconPlus size={16} color={PLUS_COLOR} />
                    <Text style={{ color: PLUS_COLOR, fontSize: FontSize.sm, fontWeight: '600' }}>
                      {t('plans.addCard')}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>

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
                        {formatMoney(inv.amount)}
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

          {/* ============================================================ */}
          {/* STORAGE UPGRADE — For active subscribers */}
          {/* ============================================================ */}
          {currentPlan !== 'free' && subInfo && isAdmin && !subInfo.cancel_at_period_end && (() => {
            const plan = currentPlan === 'family' ? 'family' : 'one';
            const currentStorageTier = subInfo.storage_tier || planInfo?.storage_tier || (plan === 'family' ? 500 : 200);
            const bp = planInfo?.billing_period || 'monthly';
            const adjustedOpts = getStorageOptions(plan, bp);
            const hasUpgradeAvailable = adjustedOpts.some(o => o.gb > currentStorageTier);
            if (!hasUpgradeAvailable) return null;
            return (
              <View style={[s.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <IconCloud size={18} color={PLUS_COLOR} />
                  <Text style={{ color: colors.text, fontSize: FontSize.lg, fontWeight: '700' }}>
                    {t('plans.addMoreStorage')}
                  </Text>
                </View>
                <Text style={{ color: colors.textSecondary, fontSize: FontSize.sm, marginBottom: 14 }}>
                  {t('plans.addMoreStorageDesc')}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -4 }}>
                  {adjustedOpts.map((opt) => {
                    const isCurrentExact = opt.gb === currentStorageTier;
                    const isUpgrade = opt.gb > currentStorageTier;
                    // Calculate price difference from current tier
                    const currentOpt = adjustedOpts.find(o => o.gb === currentStorageTier);
                    const currentExtra = currentOpt ? currentOpt.extra : 0;
                    const priceDiff = opt.extra - currentExtra;
                    const priceDiffFormatted = bp === 'annual'
                      ? `+R$${(priceDiff / 100).toFixed(2).replace('.', ',')}/ano`
                      : `+R$${(priceDiff / 100).toFixed(2).replace('.', ',')}/${t('plans.perMonth').replace('/', '')}`;
                    return (
                      <View key={opt.gb} style={{
                        width: 130,
                        marginHorizontal: 4,
                        borderRadius: 14,
                        borderWidth: isCurrentExact ? 2 : 1,
                        borderColor: isCurrentExact ? GREEN : (isUpgrade ? PLUS_BORDER : colors.border),
                        backgroundColor: isCurrentExact
                          ? (isDark ? 'rgba(74, 222, 128, 0.08)' : 'rgba(22, 163, 74, 0.05)')
                          : (isDark ? 'rgba(255,255,255,0.03)' : '#fff'),
                        padding: 14,
                        alignItems: 'center',
                      }}>
                        <IconCloud size={24} color={isCurrentExact ? GREEN : (isUpgrade ? PLUS_COLOR : colors.textTertiary)} />
                        <Text style={{
                          color: colors.text, fontSize: FontSize.lg, fontWeight: '800',
                          marginTop: 8, marginBottom: 2,
                        }}>
                          {opt.label}
                        </Text>
                        {isCurrentExact ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 }}>
                            <IconCheck size={14} color={GREEN} />
                            <Text style={{ color: GREEN, fontSize: FontSize.xs, fontWeight: '600' }}>
                              {t('plans.currentTier')}
                            </Text>
                          </View>
                        ) : isUpgrade ? (
                          <>
                            <Text style={{ color: PLUS_COLOR, fontSize: FontSize.xs, fontWeight: '600', marginTop: 4, textAlign: 'center' }}>
                              {priceDiffFormatted}
                            </Text>
                            <TouchableOpacity
                              onPress={() => handleStorageUpgrade(opt.gb, priceDiffFormatted)}
                              disabled={storageUpgradeLoading}
                              style={{
                                marginTop: 8,
                                backgroundColor: PLUS_COLOR,
                                borderRadius: 8,
                                paddingVertical: 6,
                                paddingHorizontal: 14,
                              }}
                            >
                              {storageUpgradeLoading ? (
                                <ActivityIndicator color="#fff" size="small" />
                              ) : (
                                <Text style={{ color: '#fff', fontSize: FontSize.xs, fontWeight: '700' }}>
                                  Upgrade
                                </Text>
                              )}
                            </TouchableOpacity>
                          </>
                        ) : (
                          <Text style={{ color: colors.textTertiary, fontSize: FontSize.xs, marginTop: 6 }}>
                            {t('plans.included')}
                          </Text>
                        )}
                      </View>
                    );
                  })}
                </ScrollView>
              </View>
            );
          })()}

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

          {/* ===== TRUST BADGES ===== */}
          <View style={{
            flexDirection: 'row', justifyContent: 'center', gap: 12, flexWrap: 'wrap',
            marginTop: 28, marginBottom: 8,
          }}>
            {[
              { Icon: IconCheck, text: t('plans.trustCancel'), color: '#10b981', bg: isDark ? 'rgba(16, 185, 129, 0.08)' : 'rgba(16, 185, 129, 0.06)' },
              { Icon: IconShield, text: t('plans.trustData'), color: '#A78BFA', bg: isDark ? 'rgba(167, 139, 250, 0.08)' : 'rgba(167, 139, 250, 0.06)' },
              { Icon: IconMessageSquare, text: t('plans.trustSupport'), color: '#8b5cf6', bg: isDark ? 'rgba(139, 92, 246, 0.08)' : 'rgba(139, 92, 246, 0.06)' },
            ].map((badge, i) => (
              <View key={i} style={{
                flexDirection: 'row', alignItems: 'center', gap: 8,
                backgroundColor: badge.bg,
                paddingHorizontal: 14, paddingVertical: 10,
                borderRadius: 14, borderWidth: 1,
                borderColor: badge.color + '18',
              }}>
                <badge.Icon size={14} color={badge.color} />
                <Text style={{ color: badge.color, fontSize: 12, fontWeight: '600' }}>{badge.text}</Text>
              </View>
            ))}
          </View>

          {/* Social proof */}
          <View style={{ alignItems: 'center', marginBottom: 24, marginTop: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ flexDirection: 'row' }}>
                {['#A78BFA', '#8b5cf6', '#A78BFA', '#10b981'].map((c, i) => (
                  <View key={i} style={{
                    width: 28, height: 28, borderRadius: 14,
                    backgroundColor: c, alignItems: 'center', justifyContent: 'center',
                    marginLeft: i > 0 ? -8 : 0, borderWidth: 2,
                    borderColor: isDark ? '#151e2e' : '#fff',
                  }}>
                    <IconUsers size={12} color="#fff" />
                  </View>
                ))}
              </View>
              <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '500' }}>
                2.400+ {t('plans.socialProof')}
              </Text>
            </View>
          </View>

          {/* ===== FEATURE COMPARISON TABLE ===== */}
          <View style={{
            borderRadius: 20, overflow: 'hidden', borderWidth: 1,
            borderColor: colors.border, marginBottom: 32,
            backgroundColor: colors.surface,
          }}>
            <View style={{
              paddingHorizontal: 20, paddingVertical: 16,
              backgroundColor: isDark ? 'rgba(99, 102, 241, 0.06)' : 'rgba(99, 102, 241, 0.03)',
              borderBottomWidth: 1, borderBottomColor: colors.border,
            }}>
              <Text style={{ color: colors.text, fontSize: 17, fontWeight: '800', letterSpacing: 0.3 }}>
                {t('plans.compareFeatures')}
              </Text>
            </View>

            {/* Table header */}
            <View style={{
              flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 12,
              borderBottomWidth: 1, borderBottomColor: colors.border,
            }}>
              <View style={{ flex: 2 }} />
              <Text style={{ flex: 1, textAlign: 'center', color: '#94a3b8', fontSize: 12, fontWeight: '700' }}>{t('plans.free')}</Text>
              <Text style={{ flex: 1, textAlign: 'center', color: PLUS_COLOR, fontSize: 12, fontWeight: '700' }}>One</Text>
              <Text style={{ flex: 1, textAlign: 'center', color: FAMILY_COLOR, fontSize: 12, fontWeight: '700' }}>{t('plans.family')}</Text>
            </View>

            {/* Feature rows */}
            {[
              { cat: t('plans.featureEmail'), free: t('plans.emailBasic'), one: t('plans.emailPro'), family: t('plans.emailPro') },
              { cat: t('plans.featureChat'), free: t('plans.chatBasic'), one: t('plans.chatPro'), family: t('plans.chatPro') },
              { cat: t('plans.featureDrive'), free: t('plans.driveBasic'), one: t('plans.drivePro'), family: t('plans.drivePro') },
              { cat: t('plans.featureAI'), free: t('plans.aiBasic'), one: t('plans.aiPro'), family: t('plans.aiPro') },
              { cat: t('plans.featureMeetings'), free: t('plans.meetBasic'), one: t('plans.meetPro'), family: t('plans.meetPro') },
            ].map((row, i) => (
              <View key={i} style={{
                flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 12,
                alignItems: 'center',
                backgroundColor: i % 2 === 0
                  ? (isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.01)')
                  : 'transparent',
                borderBottomWidth: i < 4 ? StyleSheet.hairlineWidth : 0,
                borderBottomColor: colors.border,
              }}>
                <Text style={{ flex: 2, color: colors.text, fontSize: 13, fontWeight: '600' }}>{row.cat}</Text>
                <Text style={{ flex: 1, textAlign: 'center', color: colors.textTertiary, fontSize: 11 }}>{row.free}</Text>
                <View style={{ flex: 1, alignItems: 'center' }}>
                  <View style={{ backgroundColor: PLUS_COLOR + '15', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                    <Text style={{ color: PLUS_COLOR, fontSize: 11, fontWeight: '600' }}>{row.one}</Text>
                  </View>
                </View>
                <View style={{ flex: 1, alignItems: 'center' }}>
                  <View style={{ backgroundColor: FAMILY_COLOR + '15', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                    <Text style={{ color: FAMILY_COLOR, fontSize: 11, fontWeight: '600' }}>{row.family}</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>

          {/* ===== iOS: Restore Purchases + Manage Subscription ===== */}
          {/* Restore Purchases must be visible on iOS even for free users
              (Apple 3.1.1 requires restore functionality to be accessible
              before any purchase). Previously this whole block was shown
              only in limited conditions; now restore is always rendered
              on iOS and manage opens only when the user actually has a
              subscription to manage. */}
          {isIOS && (
            <View style={{ marginTop: 20, marginBottom: 8, gap: 12 }}>
              <TouchableOpacity
                onPress={handleRestorePurchases}
                disabled={iapRestoring}
                activeOpacity={0.7}
                style={{
                  backgroundColor: colors.surface,
                  borderRadius: 14,
                  paddingVertical: 14,
                  paddingHorizontal: 20,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  borderWidth: 1,
                  borderColor: colors.border,
                }}
                accessibilityLabel={t('iap.restorePurchases')}
                accessibilityRole="button"
              >
                {iapRestoring ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <IconRefresh size={18} color={colors.primary} />
                )}
                <Text style={{ color: colors.primary, fontSize: FontSize.base, fontWeight: '600' }}>
                  {iapRestoring ? t('iap.restoring') : t('iap.restorePurchases')}
                </Text>
              </TouchableOpacity>

              {hasAppleSub && (
                <TouchableOpacity
                  onPress={() => Linking.openURL('https://apps.apple.com/account/subscriptions')}
                  activeOpacity={0.7}
                  style={{
                    backgroundColor: colors.surface,
                    borderRadius: 14,
                    paddingVertical: 14,
                    paddingHorizontal: 20,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    borderWidth: 1,
                    borderColor: colors.border,
                  }}
                  accessibilityLabel={t('iap.manageSubscription')}
                  accessibilityRole="button"
                >
                  <IconSettings size={18} color={colors.textSecondary} />
                  <Text style={{ color: colors.textSecondary, fontSize: FontSize.base, fontWeight: '600' }}>
                    {t('iap.manageSubscription')}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* ===== Legal disclosure — ALWAYS visible on all platforms =====
              Apple 3.1.2(c) requires in-app disclosure of subscription
              title/length/price plus functional links to Terms of Use
              and Privacy Policy. Previously this was nested under the
              iOS-only block which hid the links on Android/Web — Apple
              flagged the metadata as insufficient. Now always rendered. */}
          <View style={{ marginTop: 14, paddingHorizontal: 4 }}>
            <Text style={{ color: colors.textTertiary, fontSize: 11, lineHeight: 16, textAlign: 'center' }}>
              {t('plans.autoRenewDisclosure') ||
                'Payment will be charged to your Apple ID at confirmation of purchase. The subscription renews automatically at the same price for the same period unless canceled at least 24 hours before the end of the current period. Manage or cancel anytime in Settings → [your name] → Subscriptions.'}
            </Text>
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
              <TouchableOpacity
                onPress={() => Linking.openURL('https://www.apple.com/legal/internet-services/itunes/dev/stdeula/')}
                activeOpacity={0.7}
                accessibilityRole="link"
              >
                <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '600', textDecorationLine: 'underline' }}>
                  {t('plans.termsOfUse') || 'Terms of Use (EULA)'}
                </Text>
              </TouchableOpacity>
              <Text style={{ color: colors.textTertiary, fontSize: 12 }}>·</Text>
              <TouchableOpacity
                onPress={() => Linking.openURL('https://chatyy.com.br/privacy')}
                activeOpacity={0.7}
                accessibilityRole="link"
              >
                <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '600', textDecorationLine: 'underline' }}>
                  {t('plans.privacyPolicy') || 'Privacy Policy'}
                </Text>
              </TouchableOpacity>
              <Text style={{ color: colors.textTertiary, fontSize: 12 }}>·</Text>
              <TouchableOpacity
                onPress={() => Linking.openURL('https://chatyy.com.br/support')}
                activeOpacity={0.7}
                accessibilityRole="link"
              >
                <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '600', textDecorationLine: 'underline' }}>
                  {t('plans.support') || 'Support'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* ===== FAQ Section — Clean Accordion ===== */}
          <View style={{ marginTop: 0, marginBottom: 40 }}>
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
                    paddingVertical: 18,
                    borderTopWidth: i > 0 ? 1 : 0,
                    borderTopColor: colors.border,
                    ...(Platform.OS === 'web' ? {
                      transition: 'background-color 0.18s ease',
                      cursor: 'pointer',
                    } : {}),
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ color: colors.text, fontSize: 14.5, fontWeight: '700', flex: 1, marginRight: 12, letterSpacing: -0.15 }}>{item.q}</Text>
                    {/* Chevron rotates instead of swapping icons — smoother
                        and avoids a 1-frame layout glitch when icons
                        swap. transformer animation handled by CSS on web,
                        instant on native (acceptable). */}
                    <View style={{
                      ...(Platform.OS === 'web' ? {
                        transition: 'transform 0.22s ease',
                        transform: expandedFaq === i ? 'rotate(180deg)' : 'rotate(0deg)',
                      } : {}),
                    }}>
                      <IconChevronDown size={18} color={expandedFaq === i ? colors.primary : colors.textTertiary} />
                    </View>
                  </View>
                  {expandedFaq === i && (
                    <Text style={{
                      color: colors.textSecondary,
                      fontSize: 13.5,
                      marginTop: 12,
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

      {/* IAP Purchase Loading Overlay (iOS) */}
      {iapPurchasing && (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
          zIndex: 9999,
        }}>
          <View style={{
            backgroundColor: colors.surface, borderRadius: 20, padding: 32,
            alignItems: 'center', gap: 16, ...Shadow.lg,
          }}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={{ color: colors.text, fontSize: FontSize.base, fontWeight: '600' }}>
              {t('iap.purchasing')}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  headerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg, paddingVertical: 14, borderBottomWidth: 0,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 10 },
      android: { elevation: 3 },
      web: { boxShadow: '0 2px 16px rgba(0,0,0,0.05)', backdropFilter: 'blur(24px) saturate(180%)', WebkitBackdropFilter: 'blur(24px) saturate(180%)' },
    }),
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  headerTitle: { fontSize: FontSize.xl, fontWeight: '800', letterSpacing: -0.3 },
  scrollContent: { paddingTop: 0, paddingBottom: 40 },
  subtitle: { fontSize: FontSize.base, textAlign: 'center', marginBottom: 24, opacity: 0.6 },
  currentBanner: {
    borderRadius: 20, borderWidth: 0, padding: Spacing.lg, marginBottom: 20, marginTop: 20,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 10 },
      android: { elevation: 2 },
      web: { boxShadow: '0 2px 14px rgba(0,0,0,0.05)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' },
    }),
  },
  // Plan cards — glassmorphism with gradient borders
  planCard: {
    borderRadius: 28, borderWidth: 0, padding: 28, marginBottom: 24,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.12, shadowRadius: 20 },
      android: { elevation: 6 },
      web: { boxShadow: '0 8px 32px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', transition: 'transform 0.25s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.25s ease' },
    }),
  },
  planCardHighlight: {
    position: 'relative',
    ...(Platform.OS === 'web' ? { border: '2px solid transparent', backgroundClip: 'padding-box' } : {}),
  },
  planGradientStrip: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 4, borderTopLeftRadius: 28, borderTopRightRadius: 28,
    ...(Platform.OS === 'web' ? { background: 'linear-gradient(90deg, #5B21B6, #7C3AED, #A855F7, #ec4899)' } : {}),
  },
  planHeader: { gap: 8 },
  planName: { fontSize: 30, fontWeight: '800', letterSpacing: -0.8 },
  currentBadge: {
    paddingHorizontal: 14, paddingVertical: 5, borderRadius: 20, alignSelf: 'flex-start',
  },
  popularBadge: {
    paddingHorizontal: 12, paddingVertical: 4, borderRadius: 14,
  },
  // CTA button — animated gradient with glow
  subscribeBtn: {
    height: 58, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    marginTop: 28,
    ...Platform.select({
      ios: { shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 16 },
      android: { elevation: 8 },
      web: { boxShadow: '0 6px 24px rgba(124,58,237,0.35), 0 2px 8px rgba(124,58,237,0.15)', background: 'linear-gradient(135deg, #5B21B6, #7C3AED, #8B5CF6)', transition: 'transform 0.2s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.2s ease' },
    }),
  },
  subscribeBtnText: { color: '#fff', fontSize: 17, fontWeight: '800', letterSpacing: 0.3 },
  section: {
    borderRadius: 24, borderWidth: 0, padding: 24, marginTop: 8, marginBottom: 16,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 12 },
      android: { elevation: 2 },
      web: { boxShadow: '0 2px 16px rgba(0,0,0,0.05)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' },
    }),
  },
  addMemberBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 20, borderWidth: 1.5,
  },
  // Storage bar — gradient animated
  storageBarBg: { height: 6, borderRadius: 3, overflow: 'hidden' },
  storageBarFill: {
    height: 6, borderRadius: 3,
    ...(Platform.OS === 'web' ? { background: 'linear-gradient(90deg, #5B21B6, #7C3AED, #A855F7)', transition: 'width 0.6s cubic-bezier(0.4,0,0.2,1)' } : {}),
  },
  memberRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  storageWarning: {
    borderRadius: 20, borderWidth: 0, padding: 24, marginBottom: 20,
    alignItems: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 10 },
      android: { elevation: 2 },
      web: { boxShadow: '0 2px 14px rgba(0,0,0,0.05)' },
    }),
  },
  // FAQ — frosted glass pills
  faqItem: {
    borderRadius: 18, borderWidth: 0, padding: Spacing.lg + 2, marginBottom: 10,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 6 },
      android: { elevation: 1 },
      web: { boxShadow: '0 1px 8px rgba(0,0,0,0.04)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' },
    }),
  },
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center',
  },
  modalCard: {
    width: 360, maxWidth: '90%', borderRadius: 24, padding: 28,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.2, shadowRadius: 24 },
      android: { elevation: 16 },
      web: { boxShadow: '0 8px 40px rgba(0,0,0,0.2)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' },
    }),
  },
  paymentModalCard: {
    width: 440, maxWidth: '94%', borderRadius: 28, padding: 36,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.2, shadowRadius: 32 },
      android: { elevation: 20 },
      web: { boxShadow: '0 12px 48px rgba(0,0,0,0.18)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)' },
    }),
  },
  input: {
    borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14,
    fontSize: FontSize.base,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none', transition: 'border-color 0.2s ease' } : {}),
  },
  cardInput: {
    borderWidth: 1.5, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14,
    fontSize: FontSize.base,
  },
  cardInputPremium: {
    borderWidth: 2, borderRadius: 14, paddingHorizontal: 18, paddingVertical: 16,
    fontSize: 17,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none', transition: 'border-color 0.2s ease, box-shadow 0.2s ease' } : {}),
  },
  cardInputMono: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 20,
    letterSpacing: 2.5,
  },
  fieldLabel: {
    fontSize: 12, fontWeight: '700', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8, opacity: 0.5,
  },
  stripeCardContainer: {
    borderWidth: 2, borderRadius: 14, overflow: 'hidden',
  },
  payBtn: {
    paddingVertical: 16, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: '#4F46E5', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 12 },
      android: { elevation: 6 },
      web: { boxShadow: '0 4px 16px rgba(79,70,229,0.25)', transition: 'transform 0.15s ease' },
    }),
  },
  payBtnPremium: {
    paddingVertical: 18, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    height: 58,
    ...Platform.select({
      ios: { shadowColor: '#4F46E5', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 16 },
      android: { elevation: 8 },
      web: { boxShadow: '0 6px 24px rgba(79,70,229,0.3)', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', transition: 'transform 0.15s ease, box-shadow 0.15s ease' },
    }),
  },
  modalBtn: {
    paddingVertical: 14, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    flex: 1,
  },
  manageBtnSmall: {
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, borderWidth: 1.5,
  },
});
