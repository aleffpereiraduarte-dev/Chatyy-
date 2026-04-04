import React, { useState, useRef, useCallback, useEffect, memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Animated, Easing } from 'react-native';
import { useTheme, DENSITY_CONFIG } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Colors } from '../constants/theme';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconStar, IconStarFilled, IconCheckbox, IconCheckboxChecked, IconArchive, IconTrash, IconClock, IconPaperclip, IconVolume2 } from './Icons';
import SwipeableRow from './SwipeableRow';
import { fadeIn, scalePop, starSpin } from '../utils/animations';
import AvatarCircle from './AvatarCircle';

function getAvatarColor(name) {
  if (!name) return Colors.avatarBg;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const idx = Math.abs(hash) % Colors.avatarColors.length;
  return Colors.avatarColors[idx];
}

function formatRelativeDate(dateStr, t) {
  if (!dateStr) return '';
  const now = new Date();
  // Ensure UTC dates without timezone indicator are treated as UTC
  let str = dateStr;
  if (!str.includes('T') && !str.includes('+') && !str.endsWith('Z') && str.includes(' ')) {
    str = str.replace(' ', 'T') + 'Z';
  }
  const date = new Date(str);
  if (isNaN(date.getTime())) return dateStr;

  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);

  if (diffMin < 1) return t('time.now');
  if (diffMin < 60) return t('time.min', { n: diffMin });
  if (diffHrs < 24) return t('time.hours', { n: diffHrs });

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return t('time.yesterday');

  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays < 7) {
    const days = t('time.days');
    return days[date.getDay()];
  }

  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getDate()}/${date.getMonth() + 1}`;
  }

  return `${date.getDate()}/${date.getMonth() + 1}/${String(date.getFullYear()).slice(2)}`;
}

function highlightText(text, query) {
  if (!query || !text) return text;
  const q = query.trim();
  if (!q) return text;
  try {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    const parts = text.split(regex);
    if (parts.length <= 1) return text;
    return parts.map((part, i) =>
      regex.test(part)
        ? <Text key={i} style={{ backgroundColor: '#fef08a', color: '#000', borderRadius: 2 }}>{part}</Text>
        : part
    );
  } catch {
    return text;
  }
}

function EmailRow({
  email, isSelected, onPress, onStar, selectMode, isChecked,
  onToggleSelect, onArchive, onDelete, onSnooze,
  onDragStart, onDragEnter, currentFolder, onContextMenu, index,
  isMuted, searchQuery,
}) {
  const { colors, densityConfig } = useTheme();
  const { t } = useLanguage();
  const dc = densityConfig || DENSITY_CONFIG.comfortable;
  const [hovered, setHovered] = useState(false);
  const isUnread = !email.seen;
  const isStarred = email.flagged;

  const nativeDriver = Platform.OS !== 'web';

  // Entrance animation: staggered fade-in based on index (capped at 400ms total)
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const entranceAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const delay = Math.min((index || 0) * 30, 400);
    fadeIn(fadeAnim, 280, delay).start();
    Animated.timing(entranceAnim, {
      toValue: 1,
      duration: 250,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: nativeDriver,
    }).start();
  }, []);

  // Press scale animation
  const pressScale = useRef(new Animated.Value(1)).current;
  const handlePressIn = useCallback(() => {
    Animated.spring(pressScale, {
      toValue: 0.97,
      useNativeDriver: nativeDriver,
      friction: 10,
      tension: 400,
    }).start();
  }, []);
  const handlePressOut = useCallback(() => {
    Animated.spring(pressScale, {
      toValue: 1,
      useNativeDriver: nativeDriver,
      friction: 8,
      tension: 200,
    }).start();
  }, []);

  // Star spin + scale animation
  const starScale = useRef(new Animated.Value(1)).current;
  const starRotate = useRef(new Animated.Value(0)).current;
  const starRotateInterp = starRotate.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const handleStar = useCallback((e) => {
    e?.stopPropagation?.();
    if (Platform.OS !== 'web') {
      import('expo-haptics').then(h => h.impactAsync(h.ImpactFeedbackStyle.Light)).catch(() => {});
    }
    starSpin(starScale, starRotate).start();
    onStar?.(email);
  }, [email, onStar]);

  const handleArchive = useCallback((e) => {
    e?.stopPropagation?.();
    if (Platform.OS !== 'web') {
      import('expo-haptics').then(h => h.impactAsync(h.ImpactFeedbackStyle.Medium)).catch(() => {});
    }
    onArchive?.(email);
  }, [email, onArchive]);

  const handleDelete = useCallback((e) => {
    e?.stopPropagation?.();
    if (Platform.OS !== 'web') {
      import('expo-haptics').then(h => h.notificationAsync(h.NotificationFeedbackType.Warning)).catch(() => {});
    }
    onDelete?.(email);
  }, [email, onDelete]);

  const handleSnooze = useCallback((e) => {
    e?.stopPropagation?.();
    onSnooze?.(email);
  }, [email, onSnooze]);

  const hasAttachments = email.has_attachments || email.attachments?.length > 0;
  const relativeDate = formatRelativeDate(email.date, t);

  // Nudge: show chip for old unread INBOX emails
  let nudgeDays = 0;
  if (currentFolder === 'INBOX' && isUnread && email.date) {
    const d = new Date(email.date);
    if (!isNaN(d.getTime())) {
      nudgeDays = Math.floor((Date.now() - d.getTime()) / 86400000);
    }
  }

  const bgColor = isChecked
    ? colors.selectedBg
    : isSelected
    ? colors.selectedBg
    : isUnread
    ? colors.unreadBg
    : hovered
    ? colors.surfaceHover
    : colors.surface;

  const handleContextMenu = useCallback((e) => {
    if (Platform.OS === 'web') {
      e?.preventDefault?.();
      onContextMenu?.(email, { x: e?.nativeEvent?.pageX || e?.pageX || 0, y: e?.nativeEvent?.pageY || e?.pageY || 0 });
    }
  }, [email, onContextMenu]);

  const webHover = Platform.OS === 'web' ? {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  } : {};

  const row = (
    <Animated.View style={{ opacity: fadeAnim }}>
    <Animated.View style={{
      opacity: entranceAnim,
      transform: [{ translateY: entranceAnim.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
    }}>
    <TouchableOpacity
      style={[
        s.row,
        { backgroundColor: bgColor, borderBottomColor: colors.borderLight, paddingVertical: dc.paddingV, minHeight: dc.rowMinHeight },
        Platform.OS === 'web' && s.rowTransition,
      ]}
      onPress={() => onPress(email)}
      onLongPress={() => onContextMenu?.(email, { x: 0, y: 0 })}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      activeOpacity={0.6}
      accessibilityLabel={`${isUnread ? t('a11y.unread') || 'Unread' : ''} ${email.from_name || email.from}, ${email.subject || t('reader.noSubject')}`}
      accessibilityRole="button"
      {...webHover}
      {...(Platform.OS === 'web' ? {
        onContextMenu: handleContextMenu,
        draggable: true,
        onDragStart: (e) => {
          e.dataTransfer?.setData('text/plain', JSON.stringify({ uid: email.uid, subject: email.subject }));
        },
      } : {})}
    >
    {/* Unread dot indicator — positioned absolutely on the left edge of the row */}
    {isUnread && !selectMode && !hovered && (
      <View style={[s.unreadDotLeft, { backgroundColor: colors.primary }]} />
    )}
    <Animated.View style={[s.rowInner, { transform: [{ scale: pressScale }] }]}>
      {/* Checkbox / Avatar */}
      <TouchableOpacity
        style={s.leftArea}
        onPress={(e) => { e.stopPropagation?.(); onToggleSelect?.(email.uid); }}
        onMouseDown={(e) => { if (onDragStart) { e.preventDefault(); onDragStart(email.uid); } }}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        accessibilityLabel={isChecked ? t('a11y.deselect') || 'Deselect' : t('a11y.select') || 'Select'}
        accessibilityRole="button"
      >
        {selectMode || hovered ? (
          isChecked ? (
            <IconCheckboxChecked size={22} color={colors.selectedCheckbox || colors.primary} />
          ) : (
            <IconCheckbox size={22} color={colors.checkboxColor || colors.textSecondary} />
          )
        ) : (
          <AvatarCircle name={email.from_name || email.from} email={email.from} size={dc.avatarSize} />
        )}
      </TouchableOpacity>

      {/* Content — 3-line layout: sender+date, subject, preview */}
      <View
        style={s.content}
        onMouseEnter={() => { if (onDragEnter) onDragEnter(email.uid); }}
      >
        {/* Line 1: Sender name (left) + date (right) */}
        <View style={s.topRow}>
          <View style={s.senderRow}>
            <Text
              style={[s.from, { color: colors.text }, isUnread && s.unreadText]}
              numberOfLines={1}
            >
              {email.from_name || email.from}
            </Text>
            {email.thread_count > 1 && (
              <View style={[s.threadBadge, { backgroundColor: colors.surfaceVariant }]}>
                <Text style={[s.threadBadgeText, { color: colors.textSecondary }]}>
                  {email.thread_count}
                </Text>
              </View>
            )}
            {isMuted && (
              <View style={s.mutedIcon}>
                <IconVolume2 size={12} color={colors.textTertiary} />
              </View>
            )}
          </View>
          {!hovered && (
            <View style={s.dateRow}>
              {hasAttachments && (
                <IconPaperclip size={13} color={colors.textTertiary} style={{ marginRight: 5, opacity: 0.7 }} />
              )}
              <Text style={[s.date, { color: isUnread ? colors.primary : colors.textTertiary }]}>
                {relativeDate || email.date_short || email.date}
              </Text>
            </View>
          )}
        </View>

        {/* Line 2: Subject + preview (Gmail-style: subject — preview on same line) */}
        <Text numberOfLines={1} style={s.subjectLine}>
          <Text style={[s.subject, { color: isUnread ? colors.text : colors.textSecondary }, isUnread && s.unreadSubject]}>
            {searchQuery ? highlightText(email.subject || t('reader.noSubject'), searchQuery) : (email.subject || t('reader.noSubject'))}
          </Text>
          {dc.showPreview && email.preview ? (
            <Text style={[s.preview, { color: colors.textTertiary }]}>
              {' \u2014 '}{searchQuery ? highlightText(email.preview, searchQuery) : email.preview}
            </Text>
          ) : null}
        </Text>

        {nudgeDays >= 3 && (
          <View style={[s.nudgeChip, { backgroundColor: colors.warningBg || '#fef3cd' }]}>
            <Text style={[s.nudgeText, { color: colors.warningText || '#856404' }]}>
              {t('nudge.reply', { n: nudgeDays })}
            </Text>
          </View>
        )}
        {/* Snoozed indicator */}
        {currentFolder === 'Snoozed' && (
          <View style={[s.snoozedChip, { backgroundColor: colors.primaryLight || '#e8f0fe' }]}>
            <IconClock size={12} color={colors.primary} style={{ marginRight: 4 }} />
            <Text style={[s.snoozedText, { color: colors.primary }]}>
              {t('snooze.snoozed')}
            </Text>
          </View>
        )}
      </View>

      {/* Right side: hover actions or star */}
      {hovered && Platform.OS === 'web' ? (
        <View style={s.hoverActions}>
          <TouchableOpacity
            style={[s.hoverBtn, { backgroundColor: colors.hoverActionBg }]}
            onPress={handleArchive}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Archive"
            accessibilityRole="button"
          >
            <IconArchive size={18} color={colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.hoverBtn, { backgroundColor: colors.hoverActionBg }]}
            onPress={handleSnooze}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Snooze"
            accessibilityRole="button"
          >
            <IconClock size={18} color={colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.hoverBtn, { backgroundColor: colors.hoverActionBg }]}
            onPress={handleDelete}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Delete"
            accessibilityRole="button"
          >
            <IconTrash size={18} color={colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.hoverBtn, { backgroundColor: colors.hoverActionBg }]}
            onPress={handleStar}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel={isStarred ? 'Remove star' : 'Add star'}
            accessibilityRole="button"
          >
            <Animated.View style={{ transform: [{ scale: starScale }, { rotate: starRotateInterp }] }}>
              {isStarred ? (
                <IconStarFilled size={18} color={colors.starColor} />
              ) : (
                <IconStar size={18} color={colors.textSecondary} />
              )}
            </Animated.View>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={s.starBtn}
          onPress={handleStar}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel={isStarred ? t('a11y.removeStar') || 'Remove star' : t('a11y.addStar') || 'Add star'}
          accessibilityRole="button"
        >
          <Animated.View style={{ transform: [{ scale: starScale }, { rotate: starRotateInterp }] }}>
            {isStarred ? (
              <IconStarFilled size={20} color={colors.starColor} />
            ) : (
              <IconStar size={20} color={colors.starEmpty} />
            )}
          </Animated.View>
        </TouchableOpacity>
      )}
    </Animated.View>
    </TouchableOpacity>
    </Animated.View>
    </Animated.View>
  );

  // Wrap with swipe on mobile
  return (
    <SwipeableRow
      onSwipeRight={() => onArchive?.(email)}
      onSwipeLeft={() => onDelete?.(email)}
      onSnooze={() => onSnooze?.(email)}
    >
      {row}
    </SwipeableRow>
  );
}

export default memo(EmailRow);

const s = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: Spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 64,
    position: 'relative',
  },
  rowInner: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  rowTransition: Platform.OS === 'web' ? {
    transition: 'background-color 0.18s ease, box-shadow 0.2s ease, transform 0.18s ease',
    animation: 'emailRowIn 0.25s ease-out both',
  } : {},
  unreadDotLeft: {
    width: 6, height: 6, borderRadius: 3,
    position: 'absolute', left: 6,
    ...Platform.select({
      web: {
        top: '50%', marginTop: -3,
        boxShadow: '0 0 4px rgba(37, 99, 235, 0.3)',
      },
      default: { top: '47%' },
    }),
  },
  leftArea: { marginRight: 12 },
  content: { flex: 1, minWidth: 0 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  senderRow: { flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0, marginRight: Spacing.sm },
  dateRow: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  from: { fontSize: FontSize.md, flexShrink: 1, letterSpacing: -0.1 },
  date: { fontSize: 11, letterSpacing: 0.1, fontWeight: '400', opacity: 0.7 },
  subjectLine: { marginTop: 1 },
  subject: { fontSize: FontSize.sm, lineHeight: 18, letterSpacing: -0.05 },
  unreadSubject: { fontWeight: '600' },
  preview: { fontSize: FontSize.sm, lineHeight: 18, letterSpacing: 0 },
  unreadText: { fontWeight: '700', letterSpacing: -0.15 },
  starBtn: {
    padding: Spacing.xs, marginLeft: Spacing.sm,
    ...Platform.select({
      web: { transition: 'transform 0.2s ease', cursor: 'pointer' },
      default: {},
    }),
  },
  // Thread badge
  threadBadge: {
    borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2, marginLeft: 6, marginRight: 2,
  },
  threadBadgeText: { fontSize: 11, fontWeight: '800' },
  mutedIcon: { marginLeft: 4, opacity: 0.5 },
  // Nudge
  nudgeChip: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, marginTop: 4 },
  nudgeText: { fontSize: FontSize.xs, fontWeight: '600' },
  // Snoozed indicator
  snoozedChip: { flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, marginTop: 4 },
  snoozedText: { fontSize: FontSize.xs, fontWeight: '600' },
  // Hover actions
  hoverActions: { flexDirection: 'row', gap: 4, marginLeft: Spacing.sm },
  hoverBtn: {
    width: 34, height: 34, borderRadius: 12,
    justifyContent: 'center', alignItems: 'center',
    ...Platform.select({
      web: {
        transition: 'all 0.18s cubic-bezier(0.34, 1.56, 0.64, 1)',
        cursor: 'pointer',
      },
      default: {},
    }),
  },
});
