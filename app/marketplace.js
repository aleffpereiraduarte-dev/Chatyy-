import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, ScrollView, Image, Modal, Platform, Alert,
  KeyboardAvoidingView, RefreshControl, Pressable, Animated,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import { formatMoneyActive } from '../services/currencyService';
import { useCurrency } from '../context/CurrencyContext';
import AvatarCircle from '../components/AvatarCircle';
import {
  IconArrowLeft, IconSearch, IconPlus, IconX, IconCamera, IconHeart,
  IconMapPin, IconChevronRight, IconChevronLeft, IconEdit, IconTrash,
  IconShare, IconCheck, IconUser, IconMessageSquare,
} from '../components/Icons';
import Svg, { Path, Line, Circle, Rect, Polyline } from 'react-native-svg';

// ─── Safe alert helper ─────────────────────────────────────────────────────────
const safeAlert = (title, message, buttons) => {
  if (Platform.OS === 'web') {
    if (buttons?.length) {
      const ok = buttons.find(b => b.style !== 'cancel');
      if (ok?.onPress && window.confirm(`${title}\n${message || ''}`)) ok.onPress();
    } else { window.alert(message || title); }
  } else { Alert.alert(title, message, buttons); }
};

// ─── Price formatter ──────────────────────────────────────────────────────────
// Display-only: converts the canonical BRL-cents price to the user's
// selected display currency via the shared FX service. Listing prices
// are STORED in BRL cents; conversion never touches the stored value or
// the offer/charge path (parseBRL below stays BRL-canonical).
function formatBRL(cents) {
  if (cents == null || isNaN(cents)) return formatMoneyActive(0);
  return formatMoneyActive(Number(cents));
}

function parseBRL(text) {
  // "1.234,56" → 123456 cents
  const cleaned = text.replace(/[^\d,]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.round(num * 100);
}

// ─── Category pill icons ────────────────────────────────────────────────────────
function IconEletronicos({ size = 18, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="2" y="3" width="20" height="14" rx="2" />
      <Line x1="8" y1="21" x2="16" y2="21" />
      <Line x1="12" y1="17" x2="12" y2="21" />
    </Svg>
  );
}
function IconVeiculos({ size = 18, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M5 17H3a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v4" />
      <Circle cx="16" cy="17" r="2" />
      <Circle cx="7" cy="17" r="2" />
      <Path d="M14 17H9" />
    </Svg>
  );
}
function IconImoveis({ size = 18, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <Polyline points="9 22 9 12 15 12 15 22" />
    </Svg>
  );
}
function IconRoupas({ size = 18, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20.38 3.46L16 2a4 4 0 01-8 0L3.62 3.46a2 2 0 00-1.34 2.23l.58 3.57a1 1 0 00.99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 002-2V10h2.15a1 1 0 00.99-.84l.58-3.57a2 2 0 00-1.34-2.23z" />
    </Svg>
  );
}
function IconServicos({ size = 18, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.77 3.77z" />
    </Svg>
  );
}
function IconOutros({ size = 18, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="12" cy="12" r="1" /><Circle cx="19" cy="12" r="1" /><Circle cx="5" cy="12" r="1" />
    </Svg>
  );
}
function IconTag({ size = 18, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
      <Line x1="7" y1="7" x2="7.01" y2="7" />
    </Svg>
  );
}
function IconHeartFilled({ size = 18, color = '#EF4444' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
    </Svg>
  );
}
function IconStar({ size = 18, color = '#F59E0B' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <Polyline points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </Svg>
  );
}

// ─── Category config ──────────────────────────────────────────────────────────
const CATEGORIES = [
  { key: 'all', labelKey: 'marketplace.catAll', Icon: IconTag, color: '#7C3AED' },
  { key: 'Eletrônicos', labelKey: 'marketplace.catEletronicos', Icon: IconEletronicos, color: '#3B82F6' },
  { key: 'Veículos', labelKey: 'marketplace.catVeiculos', Icon: IconVeiculos, color: '#10B981' },
  { key: 'Imóveis', labelKey: 'marketplace.catImoveis', Icon: IconImoveis, color: '#F59E0B' },
  { key: 'Roupas', labelKey: 'marketplace.catRoupas', Icon: IconRoupas, color: '#EC4899' },
  { key: 'Serviços', labelKey: 'marketplace.catServicos', Icon: IconServicos, color: '#8B5CF6' },
  { key: 'Outros', labelKey: 'marketplace.catOutros', Icon: IconOutros, color: '#6B7280' },
];

const TABS = ['browse', 'my', 'saved'];

// ─── Marketplace API helpers (routed through email.php → marketplace.php) ─────
async function mktList(params = {}) { return api.apiCall('marketplace_list', params); }
async function mktCreate(data) { return api.apiCall('marketplace_create', data, 'POST'); }
async function mktDetail(listingId) { return api.apiCall('marketplace_detail', { listing_id: listingId }); }
async function mktFavorite(listingId) { return api.apiCall('marketplace_favorite', { listing_id: listingId }, 'POST'); }
async function mktOffer(listingId, amountCents, message) { return api.apiCall('marketplace_offer', { listing_id: listingId, amount_cents: amountCents, message }, 'POST'); }
async function mktMyListings() { return api.apiCall('marketplace_my_listings'); }
async function mktSaved() { return api.apiCall('marketplace_saved'); }
async function mktDelete(listingId) { return api.apiCall('marketplace_delete', { listing_id: listingId }, 'POST'); }

// ─── Photo carousel ────────────────────────────────────────────────────────────
function PhotoCarousel({ photos, width, height = 240 }) {
  const [idx, setIdx] = useState(0);
  const { colors } = useTheme();
  if (!photos || photos.length === 0) {
    return (
      <View style={[s.photoPlaceholder, { width, height, backgroundColor: colors.surface }]}>
        <IconCamera size={40} color={colors.textSecondary} />
        <Text style={{ color: colors.textSecondary, marginTop: 8, fontSize: 13 }}>Sem foto</Text>
      </View>
    );
  }
  const sorted = [...photos].sort((a, b) => a.position - b.position);
  return (
    <View style={{ width, height }}>
      <Image
        source={{ uri: sorted[idx]?.url }}
        style={{ width, height, resizeMode: 'cover' }}
      />
      {sorted.length > 1 && (
        <>
          {idx > 0 && (
            <TouchableOpacity
              style={[s.carouselBtn, { left: 8 }]}
              onPress={() => setIdx(i => Math.max(0, i - 1))}
              accessibilityLabel="Foto anterior"
            >
              <IconChevronLeft size={20} color="#fff" />
            </TouchableOpacity>
          )}
          {idx < sorted.length - 1 && (
            <TouchableOpacity
              style={[s.carouselBtn, { right: 8 }]}
              onPress={() => setIdx(i => Math.min(sorted.length - 1, i + 1))}
              accessibilityLabel="Próxima foto"
            >
              <IconChevronRight size={20} color="#fff" />
            </TouchableOpacity>
          )}
          <View style={s.carouselDots}>
            {sorted.map((_, i) => (
              <View key={i} style={[s.dot, i === idx && s.dotActive]} />
            ))}
          </View>
        </>
      )}
    </View>
  );
}

// ─── Listing card (2-column grid) ─────────────────────────────────────────────
function ListingCard({ item, onPress, onToggleSave, isSaved }) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const PADDING = 12;
  const cardWidth = (width - PADDING * 3) / 2;
  const photo = item.photos?.[0]?.url;
  const heart = useRef(new Animated.Value(isSaved ? 1 : 0)).current;

  const toggleSave = () => {
    Animated.sequence([
      Animated.timing(heart, { toValue: 1.3, duration: 120, useNativeDriver: true }),
      Animated.timing(heart, { toValue: isSaved ? 0 : 1, duration: 120, useNativeDriver: true }),
    ]).start();
    onToggleSave(item.id);
  };

  return (
    <TouchableOpacity
      style={[s.card, { width: cardWidth, backgroundColor: colors.surface }, Shadow.sm]}
      onPress={() => onPress(item)}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${formatBRL(item.price_cents)}`}
    >
      <View style={{ width: cardWidth, height: cardWidth * 0.85, backgroundColor: colors.border, borderTopLeftRadius: BorderRadius.md, borderTopRightRadius: BorderRadius.md, overflow: 'hidden' }}>
        {photo ? (
          <Image source={{ uri: photo }} style={{ width: cardWidth, height: cardWidth * 0.85, resizeMode: 'cover' }} />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <IconCamera size={32} color={colors.textSecondary} />
          </View>
        )}
        <TouchableOpacity style={s.heartBtn} onPress={toggleSave} hitSlop={{ top: 8, left: 8, right: 8, bottom: 8 }} accessibilityLabel={isSaved ? 'Remover dos salvos' : 'Salvar anúncio'}>
          <Animated.View style={{ transform: [{ scale: heart.interpolate({ inputRange: [0, 1, 1.3], outputRange: [1, 1, 1.3] }) }] }}>
            {isSaved ? <IconHeartFilled size={20} /> : <IconHeart size={20} color="#fff" />}
          </Animated.View>
        </TouchableOpacity>
      </View>
      <View style={{ padding: 8 }}>
        <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 15 }} numberOfLines={1}>
          {formatBRL(item.price_cents)}
        </Text>
        <Text style={{ color: colors.text, fontSize: 13, marginTop: 2 }} numberOfLines={2}>
          {item.title}
        </Text>
        {item.location ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
            <IconMapPin size={11} color={colors.textSecondary} />
            <Text style={{ color: colors.textSecondary, fontSize: 11, marginLeft: 2 }} numberOfLines={1}>
              {item.location}
            </Text>
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

// ─── Create / Edit listing modal ──────────────────────────────────────────────
function CreateListingModal({ visible, onClose, onCreated }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('Outros');
  const [location, setLocation] = useState('');
  const [photoUrls, setPhotoUrls] = useState(['']);
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setTitle(''); setPrice(''); setDescription('');
    setCategory('Outros'); setLocation(''); setPhotoUrls(['']);
  };

  const handleClose = () => { reset(); onClose(); };

  const handleCreate = async () => {
    if (!title.trim()) { safeAlert(t('marketplace.error'), t('marketplace.errTitle')); return; }
    const priceCents = parseBRL(price);
    if (priceCents <= 0) { safeAlert(t('marketplace.error'), t('marketplace.errPrice')); return; }
    setLoading(true);
    try {
      const photos = photoUrls.filter(u => u.trim());
      const res = await mktCreate({
        title: title.trim(),
        description: description.trim(),
        price_cents: priceCents,
        category,
        location: location.trim(),
        photos,
      });
      if (res?.success) {
        reset();
        onCreated?.();
        onClose();
      } else {
        safeAlert(t('marketplace.error'), res?.message || t('marketplace.errGeneric'));
      }
    } catch {
      safeAlert(t('marketplace.error'), t('marketplace.errGeneric'));
    } finally {
      setLoading(false);
    }
  };

  const catList = CATEGORIES.filter(c => c.key !== 'all');

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          {/* Header */}
          <View style={[s.modalHeader, { borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={handleClose} style={s.modalCloseBtn} accessibilityLabel={t('common.cancel')}>
              <IconX size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={[s.modalTitle, { color: colors.text }]}>{t('marketplace.createTitle')}</Text>
            <TouchableOpacity onPress={handleCreate} disabled={loading} style={[s.modalSaveBtn, { backgroundColor: colors.primary }]} accessibilityLabel={t('marketplace.publish')}>
              {loading ? <ActivityIndicator size="small" color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>{t('marketplace.publish')}</Text>}
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false}>
            {/* Photo URLs */}
            <Text style={[s.label, { color: colors.textSecondary }]}>{t('marketplace.photosLabel')}</Text>
            {photoUrls.map((url, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                <TextInput
                  style={[s.input, { flex: 1, color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
                  placeholder={`URL da foto ${i + 1}`}
                  placeholderTextColor={colors.textSecondary}
                  value={url}
                  onChangeText={v => setPhotoUrls(p => { const n = [...p]; n[i] = v; return n; })}
                  autoCapitalize="none"
                  keyboardType="url"
                />
                {photoUrls.length > 1 && (
                  <TouchableOpacity onPress={() => setPhotoUrls(p => p.filter((_, j) => j !== i))} style={{ marginLeft: 6 }}>
                    <IconX size={18} color={colors.textSecondary} />
                  </TouchableOpacity>
                )}
              </View>
            ))}
            {photoUrls.length < 5 && (
              <TouchableOpacity onPress={() => setPhotoUrls(p => [...p, ''])} style={[s.addPhotoBtn, { borderColor: colors.primary }]}>
                <IconPlus size={16} color={colors.primary} />
                <Text style={{ color: colors.primary, fontSize: 13, marginLeft: 4 }}>{t('marketplace.addPhoto')}</Text>
              </TouchableOpacity>
            )}

            <Text style={[s.label, { color: colors.textSecondary, marginTop: 16 }]}>{t('marketplace.titleLabel')}</Text>
            <TextInput
              style={[s.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
              placeholder={t('marketplace.titlePlaceholder')}
              placeholderTextColor={colors.textSecondary}
              value={title}
              onChangeText={setTitle}
              maxLength={120}
            />

            <Text style={[s.label, { color: colors.textSecondary, marginTop: 16 }]}>{t('marketplace.priceLabel')}</Text>
            <TextInput
              style={[s.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
              placeholder="0,00"
              placeholderTextColor={colors.textSecondary}
              value={price}
              onChangeText={setPrice}
              keyboardType="decimal-pad"
            />

            <Text style={[s.label, { color: colors.textSecondary, marginTop: 16 }]}>{t('marketplace.categoryLabel')}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
              {catList.map(c => (
                <TouchableOpacity
                  key={c.key}
                  onPress={() => setCategory(c.key)}
                  style={[s.catPill, { borderColor: category === c.key ? c.color : colors.border, backgroundColor: category === c.key ? c.color + '18' : colors.surface }]}
                  accessibilityLabel={t(c.labelKey)}
                >
                  <c.Icon size={14} color={category === c.key ? c.color : colors.textSecondary} />
                  <Text style={{ color: category === c.key ? c.color : colors.textSecondary, fontSize: 13, marginLeft: 4, fontWeight: category === c.key ? '700' : '400' }}>
                    {t(c.labelKey)}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <Text style={[s.label, { color: colors.textSecondary, marginTop: 16 }]}>{t('marketplace.locationLabel')}</Text>
            <TextInput
              style={[s.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
              placeholder={t('marketplace.locationPlaceholder')}
              placeholderTextColor={colors.textSecondary}
              value={location}
              onChangeText={setLocation}
              maxLength={100}
            />

            <Text style={[s.label, { color: colors.textSecondary, marginTop: 16 }]}>{t('marketplace.descriptionLabel')}</Text>
            <TextInput
              style={[s.input, s.textArea, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
              placeholder={t('marketplace.descriptionPlaceholder')}
              placeholderTextColor={colors.textSecondary}
              value={description}
              onChangeText={setDescription}
              multiline
              numberOfLines={5}
              maxLength={2000}
            />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Make offer modal ─────────────────────────────────────────────────────────
function OfferModal({ visible, listing, onClose, onSent }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSend = async () => {
    const cents = parseBRL(amount);
    if (cents <= 0) { safeAlert(t('marketplace.error'), t('marketplace.errPrice')); return; }
    setLoading(true);
    try {
      const res = await mktOffer(listing.id, cents, message.trim());
      if (res?.success) {
        setAmount(''); setMessage('');
        onSent?.();
        onClose();
      } else {
        safeAlert(t('marketplace.error'), res?.message || t('marketplace.errGeneric'));
      }
    } catch {
      safeAlert(t('marketplace.error'), t('marketplace.errGeneric'));
    } finally { setLoading(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose} transparent>
      <View style={s.offerOverlay}>
        <View style={[s.offerSheet, { backgroundColor: colors.surface }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 17 }}>{t('marketplace.makeOffer')}</Text>
            <TouchableOpacity onPress={onClose} accessibilityLabel={t('common.cancel')}>
              <IconX size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          {listing && (
            <Text style={{ color: colors.textSecondary, fontSize: 13, marginBottom: 12 }}>
              {listing.title} — {t('marketplace.asking')} {formatBRL(listing.price_cents)}
            </Text>
          )}
          <Text style={[s.label, { color: colors.textSecondary }]}>{t('marketplace.yourOffer')}</Text>
          <TextInput
            style={[s.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]}
            placeholder="0,00"
            placeholderTextColor={colors.textSecondary}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
          />
          <Text style={[s.label, { color: colors.textSecondary, marginTop: 12 }]}>{t('marketplace.offerMessage')}</Text>
          <TextInput
            style={[s.input, s.textArea, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]}
            placeholder={t('marketplace.offerMessagePlaceholder')}
            placeholderTextColor={colors.textSecondary}
            value={message}
            onChangeText={setMessage}
            multiline
            numberOfLines={3}
            maxLength={500}
          />
          <TouchableOpacity
            style={[s.primaryBtn, { backgroundColor: colors.primary, marginTop: 16 }]}
            onPress={handleSend}
            disabled={loading}
            accessibilityLabel={t('marketplace.sendOffer')}
          >
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>{t('marketplace.sendOffer')}</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── Listing detail screen ────────────────────────────────────────────────────
function ListingDetail({ listing: initial, onClose, savedIds, onToggleSave }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [listing, setListing] = useState(initial);
  const [offerVisible, setOfferVisible] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const isSaved = savedIds.has(listing?.id);

  useEffect(() => {
    if (!initial?.id) return;
    setLoadingDetail(true);
    mktDetail(initial.id).then(res => {
      if (res?.success && res.data) setListing(res.data);
    }).catch(() => {}).finally(() => setLoadingDetail(false));
  }, [initial?.id]);

  const handleChatSeller = useCallback(async () => {
    if (!listing?.seller_email) return;
    try {
      const res = await api.chatCreate([listing.seller_email]);
      if (res?.success && res.data?.id) {
        onClose();
        router.push(`/chat-conversation?id=${res.data.id}`);
      }
    } catch {
      safeAlert(t('marketplace.error'), t('marketplace.errChat'));
    }
  }, [listing, router, onClose, t]);

  if (!listing) return null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Sticky header */}
      <View style={[s.detailHeader, { paddingTop: insets.top + 8, backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={onClose} style={s.backBtn} accessibilityLabel={t('common.back')}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[s.detailHeaderTitle, { color: colors.text }]} numberOfLines={1}>{listing.title}</Text>
        <TouchableOpacity onPress={() => onToggleSave(listing.id)} accessibilityLabel={isSaved ? t('marketplace.unsave') : t('marketplace.save')}>
          {isSaved ? <IconHeartFilled size={22} /> : <IconHeart size={22} color={colors.text} />}
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        <PhotoCarousel photos={listing.photos} width={width} height={width * 0.75} />

        <View style={{ padding: 16 }}>
          {/* Price + title */}
          <Text style={{ color: colors.primary, fontSize: 26, fontWeight: '800' }}>
            {formatBRL(listing.price_cents)}
          </Text>
          <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700', marginTop: 4 }}>
            {listing.title}
          </Text>
          {listing.location ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
              <IconMapPin size={14} color={colors.textSecondary} />
              <Text style={{ color: colors.textSecondary, fontSize: 13, marginLeft: 4 }}>{listing.location}</Text>
            </View>
          ) : null}

          {/* Category badge */}
          {listing.category ? (
            <View style={{ marginTop: 8 }}>
              <View style={[s.catPill, { borderColor: colors.border, alignSelf: 'flex-start', backgroundColor: colors.surface }]}>
                <IconTag size={12} color={colors.textSecondary} />
                <Text style={{ color: colors.textSecondary, fontSize: 12, marginLeft: 4 }}>{listing.category}</Text>
              </View>
            </View>
          ) : null}

          {/* Description */}
          {listing.description ? (
            <>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 15, marginTop: 16, marginBottom: 6 }}>{t('marketplace.description')}</Text>
              <Text style={{ color: colors.textSecondary, fontSize: 14, lineHeight: 20 }}>{listing.description}</Text>
            </>
          ) : null}

          {/* Seller info */}
          <View style={[s.sellerCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <AvatarCircle email={listing.seller_email} name={listing.seller_name} size={44} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{ color: colors.text, fontWeight: '600', fontSize: 15 }}>
                {listing.seller_name || listing.seller_email}
              </Text>
              {listing.seller_rating != null && (
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                  <IconStar size={13} />
                  <Text style={{ color: colors.textSecondary, fontSize: 12, marginLeft: 3 }}>
                    {Number(listing.seller_rating).toFixed(1)} ({listing.seller_reviews || 0} {t('marketplace.reviews')})
                  </Text>
                </View>
              )}
              <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                {listing.created_at ? (_d => isNaN(_d.getTime()) ? '' : _d.toLocaleDateString('pt-BR'))(new Date(listing.created_at)) : ''}
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>

      {/* CTA buttons */}
      <View style={[s.detailFooter, { paddingBottom: insets.bottom + 8, borderTopColor: colors.border, backgroundColor: colors.background }]}>
        <TouchableOpacity
          style={[s.ctaBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={() => setOfferVisible(true)}
          accessibilityLabel={t('marketplace.makeOffer')}
        >
          <IconTag size={18} color={colors.primary} />
          <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 14, marginLeft: 6 }}>{t('marketplace.makeOffer')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.ctaBtn, { backgroundColor: colors.primary, flex: 1.2, marginLeft: 10 }]}
          onPress={handleChatSeller}
          accessibilityLabel={t('marketplace.chatSeller')}
        >
          <IconMessageSquare size={18} color="#fff" />
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14, marginLeft: 6 }}>{t('marketplace.chatSeller')}</Text>
        </TouchableOpacity>
      </View>

      <OfferModal
        visible={offerVisible}
        listing={listing}
        onClose={() => setOfferVisible(false)}
        onSent={() => {}}
      />
    </View>
  );
}

// ─── My Listings tab ─────────────────────────────────────────────────────────
function MyListingsTab({ onSelectListing }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await mktMyListings();
      if (res?.success) setListings(res.data?.listings || []);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = (id) => {
    safeAlert(t('marketplace.deleteTitle'), t('marketplace.deleteConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('marketplace.delete'), style: 'destructive', onPress: async () => {
        try {
          const res = await mktDelete(id);
          if (res?.success) setListings(l => l.filter(x => x.id !== id));
        } catch {}
      }},
    ]);
  };

  if (loading) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.primary} /></View>;

  if (!listings.length) return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <IconTag size={48} color={colors.textSecondary} />
      <Text style={{ color: colors.textSecondary, fontSize: 15, marginTop: 12, textAlign: 'center' }}>
        {t('marketplace.noMyListings')}
      </Text>
    </View>
  );

  return (
    <FlatList
      data={listings}
      keyExtractor={i => String(i.id)}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
      contentContainerStyle={{ padding: 12 }}
      renderItem={({ item }) => (
        <TouchableOpacity
          style={[s.myCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={() => onSelectListing(item)}
          activeOpacity={0.8}
          accessibilityLabel={item.title}
        >
          <View style={s.myCardThumb}>
            {item.photos?.[0]?.url ? (
              <Image source={{ uri: item.photos[0].url }} style={{ width: 80, height: 80, resizeMode: 'cover' }} />
            ) : (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.border }}>
                <IconCamera size={24} color={colors.textSecondary} />
              </View>
            )}
          </View>
          <View style={{ flex: 1, paddingHorizontal: 12 }}>
            <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={2}>{item.title}</Text>
            <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 16, marginTop: 4 }}>{formatBRL(item.price_cents)}</Text>
            {item.location ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                <IconMapPin size={11} color={colors.textSecondary} />
                <Text style={{ color: colors.textSecondary, fontSize: 11, marginLeft: 2 }} numberOfLines={1}>{item.location}</Text>
              </View>
            ) : null}
            <View style={[s.statusBadge, { backgroundColor: item.status === 'active' ? '#10B98122' : '#6B728022', marginTop: 6, alignSelf: 'flex-start' }]}>
              <Text style={{ color: item.status === 'active' ? '#10B981' : '#6B7280', fontSize: 11, fontWeight: '600' }}>
                {item.status === 'active' ? t('marketplace.statusActive') : t('marketplace.statusSold')}
              </Text>
            </View>
          </View>
          <TouchableOpacity onPress={() => handleDelete(item.id)} style={{ padding: 8 }} accessibilityLabel={t('marketplace.delete')}>
            <IconTrash size={18} color="#EF4444" />
          </TouchableOpacity>
        </TouchableOpacity>
      )}
    />
  );
}

// ─── Saved listings tab ───────────────────────────────────────────────────────
function SavedListingsTab({ savedIds, onToggleSave, onSelectListing }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { width } = useWindowDimensions();
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await mktSaved();
      if (res?.success) setListings(res.data?.listings || []);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Re-load when something gets un-saved from browse tab
  useEffect(() => {
    setListings(l => l.filter(x => savedIds.has(x.id)));
  }, [savedIds]);

  if (loading) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.primary} /></View>;

  if (!listings.length) return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <IconHeartFilled size={48} color={colors.textSecondary} />
      <Text style={{ color: colors.textSecondary, fontSize: 15, marginTop: 12, textAlign: 'center' }}>
        {t('marketplace.noSaved')}
      </Text>
    </View>
  );

  return (
    <FlatList
      data={listings}
      keyExtractor={i => String(i.id)}
      numColumns={2}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
      contentContainerStyle={{ padding: 12 }}
      columnWrapperStyle={{ justifyContent: 'space-between', marginBottom: 12 }}
      renderItem={({ item }) => (
        <ListingCard
          item={item}
          onPress={onSelectListing}
          onToggleSave={onToggleSave}
          isSaved={savedIds.has(item.id)}
        />
      )}
    />
  );
}

// ─── Browse tab ───────────────────────────────────────────────────────────────
function BrowseTab({ savedIds, onToggleSave, onSelectListing }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errored, setErrored] = useState(false);
  const [search, setSearch] = useState('');
  const [searchCommit, setSearchCommit] = useState('');
  const [category, setCategory] = useState('all');
  const searchTimer = useRef(null);

  const load = useCallback(async (q = searchCommit, cat = category) => {
    setLoading(true);
    setErrored(false);
    try {
      const params = {};
      if (q) params.search = q;
      if (cat && cat !== 'all') params.category = cat;
      const res = await mktList(params);
      if (res?.success) setListings(res.data?.listings || []);
      else { setListings([]); setErrored(true); }
    } catch {
      // Network/parse failure — surface a clean empty state instead of a
      // blank screen so the user knows to retry.
      setListings([]);
      setErrored(true);
    } finally { setLoading(false); setRefreshing(false); }
  }, [searchCommit, category]);

  useEffect(() => { load(searchCommit, category); }, [searchCommit, category]);

  const onSearchChange = (v) => {
    setSearch(v);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearchCommit(v), 400);
  };

  const onCatChange = (key) => { setCategory(key); };

  return (
    <View style={{ flex: 1 }}>
      {/* Search bar */}
      <View style={[s.searchBar, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <IconSearch size={16} color={colors.textSecondary} />
        <TextInput
          style={{ flex: 1, color: colors.text, fontSize: 14, marginLeft: 8, paddingVertical: 0 }}
          placeholder={t('marketplace.searchPlaceholder')}
          placeholderTextColor={colors.textSecondary}
          value={search}
          onChangeText={onSearchChange}
          returnKeyType="search"
          onSubmitEditing={() => setSearchCommit(search)}
        />
        {search ? (
          <TouchableOpacity onPress={() => { setSearch(''); setSearchCommit(''); }}>
            <IconX size={16} color={colors.textSecondary} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Category pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 0, maxHeight: 48 }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center' }}
      >
        {CATEGORIES.map(c => (
          <TouchableOpacity
            key={c.key}
            onPress={() => onCatChange(c.key)}
            style={[s.catPill, {
              borderColor: category === c.key ? c.color : colors.border,
              backgroundColor: category === c.key ? c.color + '18' : colors.surface,
              marginRight: 8,
            }]}
            accessibilityLabel={t(c.labelKey)}
          >
            <c.Icon size={14} color={category === c.key ? c.color : colors.textSecondary} />
            <Text style={{ color: category === c.key ? c.color : colors.textSecondary, fontSize: 13, marginLeft: 4, fontWeight: category === c.key ? '700' : '400' }}>
              {t(c.labelKey)}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Listings grid */}
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : listings.length === 0 ? (
        <View style={s.emptyState}>
          <View style={[s.emptyIconChip, { backgroundColor: colors.primaryLight }]}>
            {errored ? (
              <IconTag size={40} color={colors.primary} />
            ) : (
              <IconSearch size={40} color={colors.primary} />
            )}
          </View>
          <Text style={[s.emptyStateText, { color: colors.textSecondary }]}>
            {errored
              ? (t('marketplace.loadError') || t('marketplace.errGeneric') || 'Não foi possível carregar os anúncios.')
              : t('marketplace.noResults')}
          </Text>
          {errored ? (
            <TouchableOpacity
              onPress={() => { setRefreshing(true); load(); }}
              style={[s.emptyRetryBtn, { borderColor: colors.primary }]}
              accessibilityRole="button"
              accessibilityLabel={t('common.retry') || 'Tentar novamente'}
            >
              <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 14 }}>
                {t('common.retry') || 'Tentar novamente'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={listings}
          keyExtractor={i => String(i.id)}
          numColumns={2}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
          contentContainerStyle={{ padding: 12 }}
          columnWrapperStyle={{ justifyContent: 'space-between', marginBottom: 12 }}
          renderItem={({ item }) => (
            <ListingCard
              item={item}
              onPress={onSelectListing}
              onToggleSave={onToggleSave}
              isSaved={savedIds.has(item.id)}
            />
          )}
        />
      )}
    </View>
  );
}

// ─── Main Marketplace screen ─────────────────────────────────────────────────
export default function MarketplaceScreen() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Subscribe to the display currency so price labels (rendered via the
  // module-level formatBRL → formatMoneyActive) re-render when the user
  // switches currency in settings while this screen is mounted.
  useCurrency();

  const [activeTab, setActiveTab] = useState('browse');
  const [createVisible, setCreateVisible] = useState(false);
  const [detailListing, setDetailListing] = useState(null);
  const [savedIds, setSavedIds] = useState(new Set());
  const browseSavedLoadedRef = useRef(false);

  // Load initial saved IDs
  useEffect(() => {
    if (browseSavedLoadedRef.current) return;
    browseSavedLoadedRef.current = true;
    mktSaved().then(res => {
      if (res?.success) {
        setSavedIds(new Set((res.data?.listings || []).map(l => l.id)));
      }
    }).catch(() => {});
  }, []);

  const handleToggleSave = useCallback(async (id) => {
    setSavedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    try { await mktFavorite(id); } catch {}
  }, []);

  const tabLabels = {
    browse: t('marketplace.tabBrowse'),
    my: t('marketplace.tabMyListings'),
    saved: t('marketplace.tabSaved'),
  };

  // If viewing detail
  if (detailListing) {
    return (
      <ListingDetail
        listing={detailListing}
        onClose={() => setDetailListing(null)}
        savedIds={savedIds}
        onToggleSave={handleToggleSave}
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + 4, backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityLabel={t('common.back')}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]}>{t('marketplace.title')}</Text>
        <View style={{ width: 36 }} />
      </View>

      {/* Tab bar */}
      <View style={[s.tabBar, { backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        {TABS.map(tab => (
          <TouchableOpacity
            key={tab}
            style={[s.tabItem, activeTab === tab && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
            onPress={() => setActiveTab(tab)}
            accessibilityRole="tab"
            accessibilityLabel={tabLabels[tab]}
          >
            <Text style={{ color: activeTab === tab ? colors.primary : colors.textSecondary, fontWeight: activeTab === tab ? '700' : '400', fontSize: 14 }}>
              {tabLabels[tab]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Content */}
      {activeTab === 'browse' && (
        <BrowseTab
          savedIds={savedIds}
          onToggleSave={handleToggleSave}
          onSelectListing={setDetailListing}
        />
      )}
      {activeTab === 'my' && (
        <MyListingsTab onSelectListing={setDetailListing} />
      )}
      {activeTab === 'saved' && (
        <SavedListingsTab
          savedIds={savedIds}
          onToggleSave={handleToggleSave}
          onSelectListing={setDetailListing}
        />
      )}

      {/* FAB — Vender */}
      <TouchableOpacity
        style={[s.fab, { backgroundColor: colors.primary, bottom: insets.bottom + 16 }]}
        onPress={() => setCreateVisible(true)}
        accessibilityLabel={t('marketplace.sell')}
        accessibilityRole="button"
      >
        <IconPlus size={22} color="#fff" />
        <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14, marginLeft: 6 }}>{t('marketplace.sell')}</Text>
      </TouchableOpacity>

      <CreateListingModal
        visible={createVisible}
        onClose={() => setCreateVisible(false)}
        onCreated={() => {
          if (activeTab !== 'my') setActiveTab('my');
        }}
      />
    </View>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabItem: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 11,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  catPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
  card: {
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingVertical: 48,
  },
  emptyIconChip: {
    width: 84, height: 84, borderRadius: 42,
    alignItems: 'center', justifyContent: 'center',
  },
  emptyStateText: {
    fontSize: 15,
    marginTop: 16,
    textAlign: 'center',
    lineHeight: 21,
    fontWeight: '500',
  },
  emptyRetryBtn: {
    marginTop: 18,
    paddingHorizontal: 22,
    paddingVertical: 11,
    borderRadius: BorderRadius.lg,
    borderWidth: 1.5,
  },
  heartBtn: {
    position: 'absolute',
    top: 8, right: 8,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 16,
    padding: 5,
  },
  photoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  carouselBtn: {
    position: 'absolute',
    top: '50%',
    marginTop: -18,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 20,
    padding: 6,
  },
  carouselDots: {
    position: 'absolute',
    bottom: 8,
    left: 0, right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dot: {
    width: 6, height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.5)',
    marginHorizontal: 2,
  },
  dotActive: { backgroundColor: '#fff', width: 8, height: 8, borderRadius: 4 },
  fab: {
    position: 'absolute',
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 28,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  // Detail
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  detailHeaderTitle: { flex: 1, fontSize: 16, fontWeight: '700', marginHorizontal: 8 },
  sellerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 20,
  },
  detailFooter: {
    flexDirection: 'row',
    padding: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  ctaBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    borderRadius: BorderRadius.md,
    borderWidth: 1.5,
  },
  // My listings
  myCard: {
    flexDirection: 'row',
    borderRadius: BorderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    marginBottom: 10,
  },
  myCardThumb: { width: 80, height: 80 },
  statusBadge: {
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 10,
  },
  // Create modal
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: { fontSize: 17, fontWeight: '700' },
  modalCloseBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  modalSaveBtn: {
    paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: BorderRadius.sm,
  },
  label: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderRadius: BorderRadius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  textArea: { height: 100, textAlignVertical: 'top' },
  addPhotoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: BorderRadius.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignSelf: 'flex-start',
  },
  // Offer modal
  offerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  offerSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 34,
  },
  primaryBtn: {
    paddingVertical: 14,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
  },
});
