import { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Animated, Dimensions, FlatList, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';

const API = require('../services/api');
const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function GiftPicker({ visible, onClose, receiverEmail, sessionId, onGiftSent }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const [gifts, setGifts] = useState([]);
  const [balance, setBalance] = useState(0);
  const [sending, setSending] = useState(null);
  const [showAnimation, setShowAnimation] = useState(null);
  const slideAnim = useRef(new Animated.Value(400)).current;
  const floatAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      loadData();
      Animated.spring(slideAnim, { toValue: 0, useNativeDriver: Platform.OS !== 'web', tension: 65, friction: 11 }).start();
    } else {
      slideAnim.setValue(400);
    }
  }, [visible]);

  const loadData = async () => {
    try {
      const [catRes, balRes] = await Promise.all([
        API.default.giftsGetCatalog(),
        API.default.giftsGetBalance(),
      ]);
      if (catRes.success) setGifts(catRes.data?.gifts || []);
      if (balRes.success) setBalance(balRes.data?.coins || 0);
    } catch (e) {}
  };

  const sendGift = async (gift) => {
    if (balance < gift.coin_cost) return;
    setSending(gift.id);
    try {
      const r = await API.default.giftsSend({
        gift_id: gift.id,
        receiver_email: receiverEmail,
        session_id: sessionId || '',
      });
      if (r.success) {
        setBalance(prev => prev - gift.coin_cost);
        setShowAnimation(gift);
        // Floating emoji animation
        floatAnim.setValue(0);
        Animated.timing(floatAnim, {
          toValue: 1, duration: 2000, useNativeDriver: Platform.OS !== 'web',
        }).start(() => setShowAnimation(null));
        onGiftSent?.(gift, r.data);
      }
    } catch (e) {}
    setSending(null);
  };

  const renderGift = ({ item }) => {
    const canAfford = balance >= item.coin_cost;
    return (
      <TouchableOpacity
        style={[styles.giftItem, !canAfford && styles.giftDisabled]}
        onPress={() => canAfford && sendGift(item)}
        disabled={sending === item.id || !canAfford}
        activeOpacity={0.7}
      >
        <Text style={styles.giftEmoji}>{item.emoji}</Text>
        <Text style={[styles.giftName, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
        <View style={[styles.costBadge, { backgroundColor: canAfford ? colors.primary + '20' : colors.border }]}>
          <Text style={[styles.costText, { color: canAfford ? colors.primary : colors.textSecondary }]}>
            {item.coin_cost}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  if (!visible) return null;

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <Animated.View
          style={[styles.sheet, {
            backgroundColor: isDark ? '#1c1c1e' : '#fff',
            transform: [{ translateY: slideAnim }],
          }]}
        >
          <TouchableOpacity activeOpacity={1}>
            {/* Handle bar */}
            <View style={styles.handleRow}>
              <View style={[styles.handle, { backgroundColor: colors.border }]} />
            </View>

            {/* Balance */}
            <View style={[styles.balanceRow, { borderBottomColor: colors.border }]}>
              <Text style={[styles.balanceLabel, { color: colors.textSecondary }]}>
                {t('gifts.balance') || 'Saldo'}:
              </Text>
              <Text style={[styles.balanceValue, { color: colors.primary }]}>
                {balance.toLocaleString()} {t('gifts.coins') || 'moedas'}
              </Text>
            </View>

            {/* Gift grid */}
            <FlatList
              data={gifts}
              renderItem={renderGift}
              keyExtractor={(item) => String(item.id)}
              numColumns={4}
              contentContainerStyle={styles.grid}
              scrollEnabled={false}
            />

            {/* Recharge button */}
            <TouchableOpacity style={[styles.rechargeBtn, { backgroundColor: colors.primary }]}>
              <Text style={styles.rechargeText}>
                {t('gifts.recharge') || 'Recarregar Moedas'}
              </Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </Animated.View>
      </TouchableOpacity>

      {/* Floating gift animation */}
      {showAnimation && (
        <Animated.View style={[styles.floatingGift, {
          opacity: floatAnim.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 1, 0] }),
          transform: [{
            translateY: floatAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -300] }),
          }, {
            scale: floatAnim.interpolate({ inputRange: [0, 0.2, 0.5, 1], outputRange: [0.5, 1.5, 1.2, 0.8] }),
          }],
        }]}>
          <Text style={{ fontSize: 60 }}>{showAnimation.emoji}</Text>
        </Animated.View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingBottom: Platform.OS === 'ios' ? 34 : 16,
    maxHeight: 400,
  },
  handleRow: { alignItems: 'center', paddingVertical: 8 },
  handle: { width: 40, height: 4, borderRadius: 2 },
  balanceRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 10, borderBottomWidth: 1, gap: 6,
  },
  balanceLabel: { fontSize: FontSize.sm },
  balanceValue: { fontSize: FontSize.md, fontWeight: '700' },
  grid: { padding: 12 },
  giftItem: {
    flex: 1, alignItems: 'center', padding: 10,
    margin: 4, borderRadius: BorderRadius.md,
  },
  giftDisabled: { opacity: 0.4 },
  giftEmoji: { fontSize: 36, marginBottom: 4 },
  giftName: { fontSize: FontSize.xs, fontWeight: '500', marginBottom: 4 },
  costBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  costText: { fontSize: FontSize.xs, fontWeight: '600' },
  rechargeBtn: {
    marginHorizontal: 16, marginTop: 8, paddingVertical: 12,
    borderRadius: BorderRadius.lg, alignItems: 'center',
  },
  rechargeText: { color: '#fff', fontSize: FontSize.md, fontWeight: '700' },
  floatingGift: {
    position: 'absolute', bottom: '50%', alignSelf: 'center',
  },
});
