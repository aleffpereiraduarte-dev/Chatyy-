import { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, ScrollView, Modal,
  StyleSheet, Platform, Animated, ActivityIndicator, useWindowDimensions,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, Spacing, FontSize } from '../constants/theme';
import {
  IconX, IconShield, IconInfo, IconMessageCircle, IconMail,
  IconCheck, IconChevronRight, IconChevronDown, IconChevronUp,
  IconArrowLeft, IconLock, IconGlobe,
  IconAlertTriangle, IconUser, IconSend, IconFileText,
} from './Icons';

/* ══════════════════════════════════════════════════════
   HELP MODAL — Smart support center with ticket system
   ══════════════════════════════════════════════════════ */

const FAQ_ITEMS = [
  { icon: IconLock, key: 'cantLogin', category: 'account' },
  { icon: IconMail, key: 'notReceiving', category: 'email' },
  { icon: IconSend, key: 'cantSend', category: 'email' },
  { icon: IconUser, key: 'forgotPassword', category: 'account' },
  { icon: IconShield, key: 'accountSecurity', category: 'security' },
  { icon: IconGlobe, key: 'appAccess', category: 'general' },
];

export function HelpModal({ visible, onClose }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { width } = useWindowDimensions();
  const isMobile = width < 600;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(60)).current;
  const scaleAnim = useRef(new Animated.Value(0.95)).current;

  const [view, setView] = useState('main'); // main | faq | ticket | ticketSent
  const [expandedFaq, setExpandedFaq] = useState(null);
  const [ticketType, setTicketType] = useState('');
  const [ticketEmail, setTicketEmail] = useState('');
  const [ticketMessage, setTicketMessage] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (visible) {
      setView('main');
      setExpandedFaq(null);
      setTicketType('');
      setTicketEmail('');
      setTicketMessage('');
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 280, useNativeDriver: false }),
        Animated.spring(slideAnim, { toValue: 0, tension: 50, friction: 12, useNativeDriver: false }),
        Animated.spring(scaleAnim, { toValue: 1, tension: 50, friction: 12, useNativeDriver: false }),
      ]).start();
    } else {
      fadeAnim.setValue(0);
      slideAnim.setValue(60);
      scaleAnim.setValue(0.95);
    }
  }, [visible]);

  const handleClose = useCallback(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 0, duration: 220, useNativeDriver: false }),
      Animated.timing(slideAnim, { toValue: 40, duration: 220, useNativeDriver: false }),
      Animated.timing(scaleAnim, { toValue: 0.97, duration: 220, useNativeDriver: false }),
    ]).start(() => onClose());
  }, [onClose]);

  const [ticketError, setTicketError] = useState('');

  const handleSendTicket = async () => {
    if (!ticketEmail.trim() || !ticketMessage.trim()) return;
    setSending(true);
    setTicketError('');
    try {
      const res = await fetch('https://chatyy.com.br/api/email.php?action=support_ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'support_ticket',
          email: ticketEmail.trim(),
          type: ticketType || 'general',
          message: ticketMessage.trim(),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.message || 'Failed');
      }
      setSending(false);
      setView('ticketSent');
    } catch (err) {
      setSending(false);
      setTicketError(t('help.ticketError'));
    }
  };

  const cardBg = isDark ? '#1e293b' : '#ffffff';
  const cardBorder = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const itemBg = isDark ? 'rgba(255,255,255,0.04)' : '#f8fafc';
  const itemBorder = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
  const accentColor = colors.primary;

  const renderMain = () => (
    <>
      {/* Hero */}
      <View style={ms.hero}>
        <View style={[ms.heroIconOuter, { backgroundColor: accentColor + '08' }]}>
          <View style={[ms.heroIcon, { backgroundColor: accentColor + '14' }]}>
            <IconInfo size={28} color={accentColor} />
          </View>
        </View>
        <Text style={[ms.heroTitle, { color: colors.text }]}>{t('help.title')}</Text>
        <Text style={[ms.heroSub, { color: colors.textSecondary }]}>{t('help.subtitle')}</Text>
      </View>

      {/* Quick Actions */}
      <View style={ms.actions}>
        <TouchableOpacity
          style={[ms.actionCard, { backgroundColor: accentColor + '06', borderColor: accentColor + '18' }]}
          onPress={() => setView('faq')}
          activeOpacity={0.65}
        >
          <View style={[ms.actionIcon, { backgroundColor: accentColor + '12' }]}>
            <IconMessageCircle size={22} color={accentColor} />
          </View>
          <View style={ms.actionContent}>
            <Text style={[ms.actionTitle, { color: colors.text }]}>{t('help.faqTitle')}</Text>
            <Text style={[ms.actionDesc, { color: colors.textSecondary }]}>{t('help.faqDesc')}</Text>
          </View>
          <View style={[ms.actionArrow, { backgroundColor: accentColor + '0a' }]}>
            <IconChevronRight size={16} color={accentColor} />
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[ms.actionCard, { backgroundColor: '#10b981' + '06', borderColor: '#10b981' + '18' }]}
          onPress={() => setView('ticket')}
          activeOpacity={0.65}
        >
          <View style={[ms.actionIcon, { backgroundColor: '#10b981' + '12' }]}>
            <IconSend size={22} color="#10b981" />
          </View>
          <View style={ms.actionContent}>
            <Text style={[ms.actionTitle, { color: colors.text }]}>{t('help.ticketTitle')}</Text>
            <Text style={[ms.actionDesc, { color: colors.textSecondary }]}>{t('help.ticketDesc')}</Text>
          </View>
          <View style={[ms.actionArrow, { backgroundColor: '#10b981' + '0a' }]}>
            <IconChevronRight size={16} color="#10b981" />
          </View>
        </TouchableOpacity>
      </View>

      {/* Divider */}
      <View style={[ms.sectionDivider, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' }]} />

      {/* Contact info */}
      <View style={[ms.contactBox, { backgroundColor: itemBg, borderColor: itemBorder }]}>
        <IconMail size={15} color={colors.textTertiary} />
        <Text style={[ms.contactText, { color: colors.textSecondary }]}>support@chatyy.com.br</Text>
      </View>
    </>
  );

  const renderFaq = () => (
    <>
      <TouchableOpacity onPress={() => setView('main')} style={ms.backBtn} activeOpacity={0.6}>
        <View style={ms.backBtnInner}>
          <IconArrowLeft size={16} color={accentColor} />
          <Text style={[ms.backText, { color: accentColor }]}>{t('help.back')}</Text>
        </View>
      </TouchableOpacity>
      <Text style={[ms.sectionTitle, { color: colors.text }]}>{t('help.faqTitle')}</Text>
      <View style={ms.faqList}>
        {FAQ_ITEMS.map((item, i) => {
          const Icon = item.icon;
          const isOpen = expandedFaq === i;
          return (
            <TouchableOpacity
              key={i}
              style={[
                ms.faqItem,
                {
                  backgroundColor: isOpen ? accentColor + '06' : itemBg,
                  borderColor: isOpen ? accentColor + '20' : itemBorder,
                },
              ]}
              onPress={() => setExpandedFaq(isOpen ? null : i)}
              activeOpacity={0.6}
            >
              <View style={ms.faqHeader}>
                <View style={[ms.faqIcon, { backgroundColor: (isOpen ? accentColor : colors.textTertiary) + '10' }]}>
                  <Icon size={17} color={isOpen ? accentColor : colors.textSecondary} />
                </View>
                <Text style={[ms.faqQ, { color: isOpen ? colors.text : colors.text, fontWeight: isOpen ? '700' : '500' }]}>
                  {t(`help.faq.${item.key}.q`)}
                </Text>
                <View style={[ms.faqChevronWrap, { backgroundColor: isOpen ? accentColor + '0c' : 'transparent' }]}>
                  {isOpen
                    ? <IconChevronUp size={16} color={accentColor} />
                    : <IconChevronDown size={16} color={colors.textTertiary} />
                  }
                </View>
              </View>
              {isOpen && (
                <View style={[ms.faqAnswerWrap, { borderTopColor: accentColor + '10' }]}>
                  <Text style={[ms.faqA, { color: colors.textSecondary }]}>
                    {t(`help.faq.${item.key}.a`)}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>
      {/* CTA */}
      <View style={[ms.ctaDivider, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' }]} />
      <TouchableOpacity
        style={[ms.ctaBtn, { backgroundColor: accentColor }]}
        onPress={() => setView('ticket')}
        activeOpacity={0.75}
      >
        <IconSend size={16} color="#fff" style={{ marginRight: 8 }} />
        <Text style={ms.ctaBtnText}>{t('help.stillNeedHelp')}</Text>
      </TouchableOpacity>
    </>
  );

  const TICKET_TYPES = [
    { key: 'cant_login', icon: IconLock, color: '#dc2626' },
    { key: 'email_issue', icon: IconMail, color: '#2563eb' },
    { key: 'security', icon: IconShield, color: '#7c3aed' },
    { key: 'other', icon: IconInfo, color: '#64748b' },
  ];

  const renderTicket = () => {
    const isDisabled = !ticketEmail.trim() || !ticketMessage.trim();
    return (
      <>
        <TouchableOpacity onPress={() => setView('main')} style={ms.backBtn} activeOpacity={0.6}>
          <View style={ms.backBtnInner}>
            <IconArrowLeft size={16} color={accentColor} />
            <Text style={[ms.backText, { color: accentColor }]}>{t('help.back')}</Text>
          </View>
        </TouchableOpacity>
        <Text style={[ms.sectionTitle, { color: colors.text }]}>{t('help.createTicket')}</Text>
        <Text style={[ms.sectionSub, { color: colors.textSecondary }]}>{t('help.ticketInfo')}</Text>

        {/* Ticket type selector */}
        <Text style={[ms.fieldLabel, { color: colors.textTertiary }]}>{t('help.issueType')}</Text>
        <View style={ms.typeGrid}>
          {TICKET_TYPES.map(tt => {
            const Icon = tt.icon;
            const selected = ticketType === tt.key;
            return (
              <TouchableOpacity
                key={tt.key}
                style={[
                  ms.typeChip,
                  {
                    backgroundColor: selected ? tt.color + '10' : itemBg,
                    borderColor: selected ? tt.color + '35' : itemBorder,
                    borderWidth: selected ? 1.5 : 1,
                  },
                ]}
                onPress={() => setTicketType(tt.key)}
                activeOpacity={0.6}
              >
                <Icon size={15} color={selected ? tt.color : colors.textSecondary} />
                <Text style={[ms.typeLabel, { color: selected ? tt.color : colors.textSecondary, fontWeight: selected ? '700' : '500' }]}>
                  {t(`help.type.${tt.key}`)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Email */}
        <Text style={[ms.fieldLabel, { color: colors.textTertiary }]}>{t('help.yourEmail')}</Text>
        <TextInput
          style={[ms.input, { color: colors.text, borderColor: itemBorder, backgroundColor: itemBg }]}
          value={ticketEmail}
          onChangeText={setTicketEmail}
          placeholder="email@example.com"
          placeholderTextColor={colors.textTertiary}
          keyboardType="email-address"
          autoCapitalize="none"
        />

        {/* Message */}
        <Text style={[ms.fieldLabel, { color: colors.textTertiary }]}>{t('help.describe')}</Text>
        <TextInput
          style={[ms.textArea, { color: colors.text, borderColor: itemBorder, backgroundColor: itemBg }]}
          value={ticketMessage}
          onChangeText={setTicketMessage}
          placeholder={t('help.describePlaceholder')}
          placeholderTextColor={colors.textTertiary}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />

        {/* Error message */}
        {!!ticketError && (
          <View style={[ms.errorRow, { backgroundColor: (colors.error || '#ef4444') + '0a', borderColor: (colors.error || '#ef4444') + '20' }]}>
            <IconAlertTriangle size={14} color={colors.error || '#ef4444'} />
            <Text style={[ms.errorText, { color: colors.error || '#ef4444' }]}>{ticketError}</Text>
          </View>
        )}

        {/* Submit */}
        <TouchableOpacity
          style={[ms.submitBtn, { backgroundColor: isDisabled ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)') : accentColor }]}
          onPress={handleSendTicket}
          disabled={isDisabled || sending}
          activeOpacity={0.75}
        >
          {sending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <IconSend size={16} color={isDisabled ? colors.textTertiary : '#fff'} style={{ marginRight: 8 }} />
              <Text style={[ms.submitText, { color: isDisabled ? colors.textTertiary : '#fff' }]}>{t('help.send')}</Text>
            </>
          )}
        </TouchableOpacity>
      </>
    );
  };

  const renderTicketSent = () => (
    <View style={ms.sentWrap}>
      <View style={[ms.sentIconOuter, { backgroundColor: '#10b981' + '08' }]}>
        <View style={[ms.sentIcon, { backgroundColor: '#10b981' + '14' }]}>
          <IconCheck size={32} color="#10b981" />
        </View>
      </View>
      <Text style={[ms.sentTitle, { color: colors.text }]}>{t('help.ticketSent')}</Text>
      <Text style={[ms.sentSub, { color: colors.textSecondary }]}>{t('help.ticketSentDesc')}</Text>
      <TouchableOpacity
        style={[ms.sentBtn, { backgroundColor: accentColor }]}
        onPress={handleClose}
        activeOpacity={0.75}
      >
        <Text style={ms.sentBtnText}>{t('help.close')}</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={handleClose} statusBarTranslucent>
      <Animated.View style={[ms.overlay, { opacity: fadeAnim }]}>
        <TouchableOpacity style={ms.overlayBg} onPress={handleClose} activeOpacity={1} />
        <Animated.View style={[
          ms.modal, { backgroundColor: cardBg, borderColor: cardBorder, maxWidth: isMobile ? '92%' : 520 },
          { transform: [{ translateY: slideAnim }, { scale: scaleAnim }] },
          Platform.OS === 'web' && {
            boxShadow: isDark
              ? '0 25px 70px rgba(0,0,0,0.55), 0 8px 24px rgba(0,0,0,0.35)'
              : '0 25px 70px rgba(0,0,0,0.12), 0 8px 24px rgba(0,0,0,0.06)',
          },
        ]}>
          {/* Top accent line */}
          <View style={[ms.accentLine, { backgroundColor: accentColor }]} />

          {/* Close button */}
          <TouchableOpacity
            style={[ms.closeBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}
            onPress={handleClose}
            activeOpacity={0.6}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          >
            <IconX size={18} color={colors.textSecondary} />
          </TouchableOpacity>

          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={ms.scrollContent}
            bounces={false}
          >
            {view === 'main' && renderMain()}
            {view === 'faq' && renderFaq()}
            {view === 'ticket' && renderTicket()}
            {view === 'ticketSent' && renderTicketSent()}
          </ScrollView>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

/* ══════════════════════════════════════════
   PRIVACY MODAL
   ══════════════════════════════════════════ */

const PRIVACY_SECTIONS = [
  'dataCollection', 'dataUsage', 'dataSecurity', 'dataEncryption', 'aiProcessing',
  'pushNotifications', 'chatPrivacy', 'meetingsPrivacy', 'cookies', 'thirdParties',
  'dataRetention', 'childrenPrivacy', 'internationalData', 'breachNotification',
  'openSource', 'rights', 'contact',
];

export function PrivacyModal({ visible, onClose }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { width } = useWindowDimensions();
  const isMobile = width < 600;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(60)).current;
  const scaleAnim = useRef(new Animated.Value(0.95)).current;
  const privacyAccent = '#7c3aed';

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 280, useNativeDriver: false }),
        Animated.spring(slideAnim, { toValue: 0, tension: 50, friction: 12, useNativeDriver: false }),
        Animated.spring(scaleAnim, { toValue: 1, tension: 50, friction: 12, useNativeDriver: false }),
      ]).start();
    } else {
      fadeAnim.setValue(0);
      slideAnim.setValue(60);
      scaleAnim.setValue(0.95);
    }
  }, [visible]);

  const handleClose = useCallback(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 0, duration: 220, useNativeDriver: false }),
      Animated.timing(slideAnim, { toValue: 40, duration: 220, useNativeDriver: false }),
      Animated.timing(scaleAnim, { toValue: 0.97, duration: 220, useNativeDriver: false }),
    ]).start(() => onClose());
  }, [onClose]);

  const cardBg = isDark ? '#1e293b' : '#ffffff';
  const cardBorder = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const sectionBg = isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc';

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={handleClose} statusBarTranslucent>
      <Animated.View style={[ms.overlay, { opacity: fadeAnim }]}>
        <TouchableOpacity style={ms.overlayBg} onPress={handleClose} activeOpacity={1} />
        <Animated.View style={[
          ms.modal, { backgroundColor: cardBg, borderColor: cardBorder, maxWidth: isMobile ? '92%' : 560 },
          { transform: [{ translateY: slideAnim }, { scale: scaleAnim }] },
          Platform.OS === 'web' && {
            boxShadow: isDark
              ? '0 25px 70px rgba(0,0,0,0.55), 0 8px 24px rgba(0,0,0,0.35)'
              : '0 25px 70px rgba(0,0,0,0.12), 0 8px 24px rgba(0,0,0,0.06)',
          },
        ]}>
          {/* Top accent line */}
          <View style={[ms.accentLine, { backgroundColor: privacyAccent }]} />

          <TouchableOpacity
            style={[ms.closeBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}
            onPress={handleClose}
            activeOpacity={0.6}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          >
            <IconX size={18} color={colors.textSecondary} />
          </TouchableOpacity>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={ms.scrollContent} bounces={false}>
            <View style={ms.hero}>
              <View style={[ms.heroIconOuter, { backgroundColor: privacyAccent + '08' }]}>
                <View style={[ms.heroIcon, { backgroundColor: privacyAccent + '14' }]}>
                  <IconShield size={28} color={privacyAccent} />
                </View>
              </View>
              <Text style={[ms.heroTitle, { color: colors.text }]}>{t('privacy.title')}</Text>
              <Text style={[ms.heroSub, { color: colors.textSecondary }]}>{t('privacy.subtitle')}</Text>
            </View>

            {PRIVACY_SECTIONS.map((key, i) => (
              <View key={key} style={[ms.policySection, { backgroundColor: sectionBg, borderColor: cardBorder }]}>
                <View style={ms.policySectionHeader}>
                  <View style={[ms.policyNum, { backgroundColor: privacyAccent + '12' }]}>
                    <Text style={[ms.policyNumText, { color: privacyAccent }]}>{i + 1}</Text>
                  </View>
                  <Text style={[ms.policySectionTitle, { color: colors.text }]}>{t(`privacy.${key}.title`)}</Text>
                </View>
                <Text style={[ms.policySectionBody, { color: colors.textSecondary }]}>{t(`privacy.${key}.body`)}</Text>
              </View>
            ))}

            <View style={[ms.lastUpdatedWrap, { borderTopColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }]}>
              <Text style={[ms.lastUpdated, { color: colors.textTertiary }]}>{t('privacy.lastUpdated')}</Text>
            </View>
          </ScrollView>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

/* ══════════════════════════════════════════
   TERMS MODAL
   ══════════════════════════════════════════ */

const TERMS_SECTIONS = [
  'acceptance', 'services', 'accounts', 'conduct', 'content', 'aiAssistant',
  'communications', 'storage', 'privacy', 'intellectualProperty',
  'limitation', 'termination', 'disputes', 'changes',
];

export function TermsModal({ visible, onClose }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { width } = useWindowDimensions();
  const isMobile = width < 600;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(60)).current;
  const scaleAnim = useRef(new Animated.Value(0.95)).current;
  const termsAccent = '#2563eb';

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 280, useNativeDriver: false }),
        Animated.spring(slideAnim, { toValue: 0, tension: 50, friction: 12, useNativeDriver: false }),
        Animated.spring(scaleAnim, { toValue: 1, tension: 50, friction: 12, useNativeDriver: false }),
      ]).start();
    } else {
      fadeAnim.setValue(0);
      slideAnim.setValue(60);
      scaleAnim.setValue(0.95);
    }
  }, [visible]);

  const handleClose = useCallback(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 0, duration: 220, useNativeDriver: false }),
      Animated.timing(slideAnim, { toValue: 40, duration: 220, useNativeDriver: false }),
      Animated.timing(scaleAnim, { toValue: 0.97, duration: 220, useNativeDriver: false }),
    ]).start(() => onClose());
  }, [onClose]);

  const cardBg = isDark ? '#1e293b' : '#ffffff';
  const cardBorder = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const sectionBg = isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc';

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={handleClose} statusBarTranslucent>
      <Animated.View style={[ms.overlay, { opacity: fadeAnim }]}>
        <TouchableOpacity style={ms.overlayBg} onPress={handleClose} activeOpacity={1} />
        <Animated.View style={[
          ms.modal, { backgroundColor: cardBg, borderColor: cardBorder, maxWidth: isMobile ? '92%' : 560 },
          { transform: [{ translateY: slideAnim }, { scale: scaleAnim }] },
          Platform.OS === 'web' && {
            boxShadow: isDark
              ? '0 25px 70px rgba(0,0,0,0.55), 0 8px 24px rgba(0,0,0,0.35)'
              : '0 25px 70px rgba(0,0,0,0.12), 0 8px 24px rgba(0,0,0,0.06)',
          },
        ]}>
          {/* Top accent line */}
          <View style={[ms.accentLine, { backgroundColor: termsAccent }]} />

          <TouchableOpacity
            style={[ms.closeBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}
            onPress={handleClose}
            activeOpacity={0.6}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          >
            <IconX size={18} color={colors.textSecondary} />
          </TouchableOpacity>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={ms.scrollContent} bounces={false}>
            <View style={ms.hero}>
              <View style={[ms.heroIconOuter, { backgroundColor: termsAccent + '08' }]}>
                <View style={[ms.heroIcon, { backgroundColor: termsAccent + '14' }]}>
                  <IconFileText size={28} color={termsAccent} />
                </View>
              </View>
              <Text style={[ms.heroTitle, { color: colors.text }]}>{t('terms.title')}</Text>
              <Text style={[ms.heroSub, { color: colors.textSecondary }]}>{t('terms.subtitle')}</Text>
            </View>

            {TERMS_SECTIONS.map((key, i) => (
              <View key={key} style={[ms.policySection, { backgroundColor: sectionBg, borderColor: cardBorder }]}>
                <View style={ms.policySectionHeader}>
                  <View style={[ms.policyNum, { backgroundColor: termsAccent + '12' }]}>
                    <Text style={[ms.policyNumText, { color: termsAccent }]}>{i + 1}</Text>
                  </View>
                  <Text style={[ms.policySectionTitle, { color: colors.text }]}>{t(`terms.${key}.title`)}</Text>
                </View>
                <Text style={[ms.policySectionBody, { color: colors.textSecondary }]}>{t(`terms.${key}.body`)}</Text>
              </View>
            ))}

            <View style={[ms.lastUpdatedWrap, { borderTopColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }]}>
              <Text style={[ms.lastUpdated, { color: colors.textTertiary }]}>{t('terms.lastUpdated')}</Text>
            </View>
          </ScrollView>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

/* ══════════════════════════════════════════
   Shared styles
   ══════════════════════════════════════════ */

const ms = StyleSheet.create({
  overlay: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' } : {}),
  },
  overlayBg: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  modal: {
    width: '95%', maxHeight: '85%',
    borderRadius: 20, borderWidth: 1, overflow: 'hidden',
  },
  accentLine: {
    height: 3, borderTopLeftRadius: 20, borderTopRightRadius: 20,
  },
  closeBtn: {
    position: 'absolute', top: 16, right: 16, zIndex: 10,
    width: 34, height: 34, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center',
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 0.15s ease, transform 0.15s ease' } : {}),
  },
  scrollContent: { padding: 28, paddingTop: 24, paddingBottom: 32 },

  // Hero
  hero: { alignItems: 'center', marginBottom: 28 },
  heroIconOuter: {
    width: 80, height: 80, borderRadius: 40,
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  heroIcon: {
    width: 56, height: 56, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  heroTitle: {
    fontSize: 22, fontWeight: '800', marginBottom: 8, textAlign: 'center',
    letterSpacing: -0.3,
  },
  heroSub: { fontSize: 14, textAlign: 'center', lineHeight: 21, maxWidth: 360, letterSpacing: 0.1 },

  // Action cards
  actions: { gap: 10, marginBottom: 16 },
  actionCard: {
    flexDirection: 'row', alignItems: 'center',
    padding: 16, borderRadius: 14, borderWidth: 1,
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'all 0.2s ease' } : {}),
  },
  actionIcon: {
    width: 42, height: 42, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', marginRight: 14,
  },
  actionContent: { flex: 1 },
  actionTitle: { fontSize: 15, fontWeight: '700', marginBottom: 3, letterSpacing: -0.1 },
  actionDesc: { fontSize: 12.5, lineHeight: 17, letterSpacing: 0.1 },
  actionArrow: {
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center', marginLeft: 8,
  },

  // Section divider
  sectionDivider: { height: 1, marginVertical: 16, borderRadius: 1 },

  // Contact
  contactBox: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1,
  },
  contactText: { fontSize: 13, fontWeight: '500', letterSpacing: 0.1 },

  // Back button
  backBtn: { marginBottom: 20 },
  backBtnInner: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  backText: { fontSize: 14, fontWeight: '600' },

  // Section title
  sectionTitle: { fontSize: 20, fontWeight: '800', marginBottom: 6, letterSpacing: -0.3 },
  sectionSub: { fontSize: 13.5, lineHeight: 19, marginBottom: 20, letterSpacing: 0.1 },

  // FAQ
  faqList: { gap: 8 },
  faqItem: {
    borderRadius: 14, borderWidth: 1, padding: 14,
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'all 0.2s ease' } : {}),
  },
  faqHeader: { flexDirection: 'row', alignItems: 'center' },
  faqIcon: {
    width: 34, height: 34, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  faqQ: { fontSize: 14, flex: 1, lineHeight: 20, letterSpacing: -0.1 },
  faqChevronWrap: {
    width: 26, height: 26, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center', marginLeft: 8,
  },
  faqAnswerWrap: {
    marginTop: 12, paddingTop: 12, borderTopWidth: 1,
  },
  faqA: { fontSize: 13.5, lineHeight: 21, paddingLeft: 46, letterSpacing: 0.1 },
  ctaDivider: { height: 1, marginTop: 20, marginBottom: 16, borderRadius: 1 },
  ctaBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderRadius: 50, paddingVertical: 14,
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'all 0.2s ease' } : {}),
  },
  ctaBtnText: { color: '#fff', fontSize: 14, fontWeight: '700', letterSpacing: 0.1 },

  // Ticket form
  fieldLabel: {
    fontSize: 11, fontWeight: '700', marginBottom: 8,
    letterSpacing: 0.5, textTransform: 'uppercase',
  },
  typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 22 },
  typeChip: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingVertical: 9, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1,
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'all 0.15s ease' } : {}),
  },
  typeLabel: { fontSize: 13, letterSpacing: 0.1 },
  input: {
    borderWidth: 1, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 16,
    fontSize: 15, marginBottom: 20,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none', transition: 'border-color 0.2s ease' } : {}),
  },
  textArea: {
    borderWidth: 1, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 16,
    fontSize: 14, lineHeight: 21, marginBottom: 20, minHeight: 120,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none', transition: 'border-color 0.2s ease' } : {}),
  },
  errorRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1,
    marginBottom: 16,
  },
  errorText: { fontSize: 13, fontWeight: '500', flex: 1 },
  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderRadius: 14, paddingVertical: 15, marginTop: 4,
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'all 0.2s ease' } : {}),
  },
  submitText: { fontSize: 15, fontWeight: '700', letterSpacing: 0.1 },

  // Ticket sent
  sentWrap: { alignItems: 'center', paddingVertical: 40 },
  sentIconOuter: {
    width: 96, height: 96, borderRadius: 48,
    alignItems: 'center', justifyContent: 'center', marginBottom: 24,
  },
  sentIcon: {
    width: 68, height: 68, borderRadius: 34,
    alignItems: 'center', justifyContent: 'center',
  },
  sentTitle: { fontSize: 22, fontWeight: '800', marginBottom: 8, textAlign: 'center', letterSpacing: -0.3 },
  sentSub: { fontSize: 14, textAlign: 'center', lineHeight: 21, marginBottom: 28, maxWidth: 320, letterSpacing: 0.1 },
  sentBtn: {
    borderRadius: 14, paddingVertical: 13, paddingHorizontal: 36,
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'all 0.2s ease' } : {}),
  },
  sentBtnText: { color: '#fff', fontSize: 14, fontWeight: '700', letterSpacing: 0.1 },

  // Policy sections (Privacy & Terms)
  policySection: {
    borderRadius: 14, borderWidth: 1, padding: 18, marginBottom: 10,
  },
  policySectionHeader: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 12,
  },
  policyNum: {
    width: 28, height: 28, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  policyNumText: { fontSize: 12, fontWeight: '800' },
  policySectionTitle: { fontSize: 15, fontWeight: '700', flex: 1, letterSpacing: -0.1 },
  policySectionBody: { fontSize: 13.5, lineHeight: 21, letterSpacing: 0.1 },
  lastUpdatedWrap: { borderTopWidth: 1, marginTop: 12, paddingTop: 16 },
  lastUpdated: { fontSize: 12, textAlign: 'center', letterSpacing: 0.2 },
});
