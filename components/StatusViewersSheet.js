/**
 * StatusViewersSheet.js
 *
 * Instagram-style "Seen by" bottom sheet for Chatyy statuses.
 *
 * Props:
 *   visible        {boolean}   — show/hide the sheet
 *   onClose        {function}  — called when sheet is dismissed
 *   statusId       {number}    — ID of the status whose viewers to show
 *   viewCount      {number}    — total view count (used on the badge before data loads)
 *   t              {function}  — i18n translate function
 *   colors         {object}    — theme colors from useTheme()
 *   isDark         {boolean}
 *
 * The component fetches viewers itself via api.statusViewers() when shown.
 * The parent only needs to decide WHEN to show it (swipe-up on own status).
 */

import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Animated,
  PanResponder,
  Platform,
  Dimensions,
} from 'react-native';
import AvatarCircle from './AvatarCircle';
import { IconEye } from './Icons';
import { statusViewers } from '../services/api';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SHEET_MAX_HEIGHT = SCREEN_HEIGHT * 0.65;
const DISMISS_THRESHOLD = 80;

// ─── time ago helper (mirrors ChatStatusTab.js) ─────────────────────────────
function timeAgo(dateStr, t) {
  if (!dateStr) return '';
  let str = String(dateStr);
  if (!str.includes('T')) str = str.replace(' ', 'T');
  if (!str.endsWith('Z') && !str.includes('+')) str += 'Z';
  if (str.match(/\+\d{2}$/)) str += ':00';
  const diffMs = Date.now() - new Date(str).getTime();
  if (isNaN(diffMs)) return '';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return t?.('time.now') || 'now';
  if (mins < 60) return (t?.('time.min') || '{n} min').replace('{n}', mins);
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return (t?.('time.hours') || '{n}h').replace('{n}', hrs);
  return `${Math.floor(hrs / 24)}d`;
}

// ─── Single viewer row ────────────────────────────────────────────────────────
const ViewerRow = memo(function ViewerRow({ item, colors, t }) {
  const displayName = item.name || item.viewer_email?.split('@')[0] || item.viewer_email || '';
  return (
    <View style={styles.row}>
      <AvatarCircle
        name={displayName}
        email={item.viewer_email}
        size={42}
        style={styles.rowAvatar}
      />
      <View style={styles.rowInfo}>
        <Text
          style={[styles.rowName, { color: colors?.text || '#111' }]}
          numberOfLines={1}
        >
          {displayName}
        </Text>
        <Text style={[styles.rowTime, { color: colors?.textSecondary || '#888' }]}>
          {timeAgo(item.viewed_at, t)}
        </Text>
      </View>
      {/* Eye icon */}
      <View style={styles.rowEye}>
        <IconEye size={16} color={colors?.textSecondary || '#888'} />
      </View>
    </View>
  );
});

// ─── View count badge (exported for use in story row) ────────────────────────
export const ViewCountBadge = memo(function ViewCountBadge({ count, colors }) {
  if (!count || count <= 0) return null;
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: colors?.primary || '#7C3AED' },
      ]}
      accessibilityLabel={`${count} views`}
    >
      <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
    </View>
  );
});

// ─── Main sheet component ────────────────────────────────────────────────────
function StatusViewersSheet({ visible, onClose, statusId, viewCount = 0, t, colors, isDark }) {
  const [viewers, setViewers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Sheet slide-up animation
  const slideAnim = useRef(new Animated.Value(SHEET_MAX_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const dragY = useRef(new Animated.Value(0)).current;

  // Pan responder for swipe-down-to-dismiss
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gs) => gs.dy > 8 && Math.abs(gs.dy) > Math.abs(gs.dx) * 1.5,
      onPanResponderMove: (_, gs) => {
        if (gs.dy > 0) dragY.setValue(gs.dy);
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy > DISMISS_THRESHOLD) {
          _animateOut();
        } else {
          Animated.spring(dragY, { toValue: 0, useNativeDriver: true, tension: 40, friction: 8 }).start();
        }
      },
    })
  ).current;

  const _animateIn = useCallback(() => {
    dragY.setValue(0);
    Animated.parallel([
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 65,
        friction: 11,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0.55,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start();
  }, [slideAnim, backdropOpacity, dragY]);

  const _animateOut = useCallback(() => {
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: SHEET_MAX_HEIGHT,
        duration: 220,
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onClose?.();
    });
  }, [slideAnim, backdropOpacity, onClose]);

  // Load viewers when sheet opens
  useEffect(() => {
    if (!visible || !statusId) return;
    _animateIn();
    setViewers([]);
    setError(null);
    setLoading(true);
    statusViewers(statusId)
      .then((r) => {
        if (r?.success && Array.isArray(r.data?.viewers)) {
          setViewers(r.data.viewers);
        } else {
          setViewers([]);
        }
      })
      .catch(() => {
        setError(t?.('status.viewersError') || 'Could not load viewers.');
      })
      .finally(() => setLoading(false));
  }, [visible, statusId, _animateIn, t]);

  // Reset animation when hidden
  useEffect(() => {
    if (!visible) {
      slideAnim.setValue(SHEET_MAX_HEIGHT);
      backdropOpacity.setValue(0);
      dragY.setValue(0);
    }
  }, [visible, slideAnim, backdropOpacity, dragY]);

  if (!visible) return null;

  const bg = isDark ? '#1a1a2e' : '#fff';
  const handleColor = isDark ? '#444' : '#ddd';
  const headerText = colors?.text || '#111';
  const subText = colors?.textSecondary || '#888';
  const dividerColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';

  const totalCount = viewers.length || viewCount || 0;
  const headerLabel =
    totalCount === 0
      ? (t?.('status.noViewers') || 'No one has viewed yet')
      : `${totalCount} ${totalCount === 1 ? (t?.('status.viewer') || 'view') : (t?.('status.viewers') || 'views')}`;

  const renderItem = ({ item }) => <ViewerRow item={item} colors={colors} t={t} />;
  const keyExtractor = (item, idx) => item.viewer_email || String(idx);

  return (
    <Modal
      transparent
      visible={visible}
      animationType="none"
      statusBarTranslucent
      onRequestClose={_animateOut}
      accessibilityViewIsModal
    >
      {/* Backdrop */}
      <Animated.View
        style={[styles.backdrop, { opacity: backdropOpacity }]}
        accessibilityElementsHidden
      >
        <TouchableOpacity style={StyleSheet.absoluteFill} onPress={_animateOut} activeOpacity={1} />
      </Animated.View>

      {/* Sheet */}
      <Animated.View
        style={[
          styles.sheet,
          {
            backgroundColor: bg,
            maxHeight: SHEET_MAX_HEIGHT,
            transform: [
              { translateY: slideAnim },
              { translateY: dragY },
            ],
          },
        ]}
        {...panResponder.panHandlers}
        accessibilityLabel={t?.('status.viewersList') || 'Status viewers list'}
        accessibilityRole="none"
      >
        {/* Handle bar */}
        <View style={styles.handleBar}>
          <View style={[styles.handle, { backgroundColor: handleColor }]} />
        </View>

        {/* Header */}
        <View style={[styles.header, { borderBottomColor: dividerColor }]}>
          <Text style={[styles.headerTitle, { color: headerText }]} accessibilityRole="header">
            {headerLabel}
          </Text>
          <TouchableOpacity
            onPress={_animateOut}
            style={styles.closeBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel={t?.('common.close') || 'Close'}
            accessibilityRole="button"
          >
            <Text style={[styles.closeBtnText, { color: subText }]}>✕</Text>
          </TouchableOpacity>
        </View>

        {/* Content */}
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors?.primary || '#7C3AED'} />
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={[styles.emptyText, { color: subText }]}>{error}</Text>
          </View>
        ) : viewers.length === 0 ? (
          <View style={styles.center}>
            <View style={{ marginBottom: 10 }}>
              <IconEye size={40} color={subText} />
            </View>
            <Text style={[styles.emptyText, { color: subText }]}>
              {t?.('status.noViewers') || 'No one has viewed yet'}
            </Text>
            <Text style={[styles.emptySubText, { color: subText }]}>
              {t?.('status.viewersHint') || 'When someone views your status it appears here.'}
            </Text>
          </View>
        ) : (
          <FlatList
            data={viewers}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            ItemSeparatorComponent={() => (
              <View style={[styles.separator, { backgroundColor: dividerColor }]} />
            )}
            // Stop swipe-down pan from conflicting with list scroll
            onScrollBeginDrag={() => dragY.setValue(0)}
            accessibilityLabel={t?.('status.viewersList') || 'Viewers list'}
          />
        )}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    // Shadow
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: -3 }, shadowOpacity: 0.15, shadowRadius: 12 },
      android: { elevation: 16 },
      web: { boxShadow: '0 -4px 24px rgba(0,0,0,0.18)' },
    }),
  },
  handleBar: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 4,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
  },
  closeBtn: {
    padding: 4,
  },
  closeBtnText: {
    fontSize: 16,
    fontWeight: '600',
  },
  center: {
    flex: 1,
    minHeight: 160,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emptyText: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 6,
  },
  emptySubText: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  listContent: {
    paddingBottom: Platform.OS === 'ios' ? 32 : 16,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 72,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowAvatar: {
    marginRight: 12,
  },
  rowInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  rowName: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  rowTime: {
    fontSize: 12,
  },
  rowEye: {
    marginLeft: 8,
  },
  // ─── View count badge (for story ring) ─────────────────────────────────────
  badge: {
    position: 'absolute',
    bottom: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: '#fff',
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
  },
});

export default memo(StatusViewersSheet);
