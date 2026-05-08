import { useEffect, useState, useRef } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform, Animated, Easing, Alert } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getMessage, deleteEmail as apiDelete, starEmail, unstarEmail, addLabel, removeLabel, getThread, archiveEmail } from '../services/api';
import { useMail } from '../context/MailContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Shadow, Spacing, FontSize, BorderRadius, AnimTiming } from '../constants/theme';
import EmailReader from '../components/EmailReader';
import ThreadView from '../components/ThreadView';
import { IconChevronLeft, IconChevronRight, IconReply, IconArchive, IconTrash, IconForward } from '../components/Icons';
import { MessageSkeleton } from '../components/SkeletonLoader';

export default function ReadScreen() {
  const { uid, folder = 'INBOX', prevUid, nextUid } = useLocalSearchParams();
  const [email, setEmail] = useState(null);
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(true);
  const { refresh, markAsRead } = useMail();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Reading progress indicator
  const scrollProgress = useRef(new Animated.Value(0)).current;

  // Entrance animation
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(15)).current;

  useEffect(() => {
    if (!loading && email) {
      const nd = Platform.OS !== 'web';
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: AnimTiming.slow,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: AnimTiming.entrance,
          easing: Easing.out(Easing.exp),
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [loading, email]);

  const navigateToEmail = (targetUid) => {
    if (!targetUid) return;
    router.replace(`/read?uid=${targetUid}&folder=${encodeURIComponent(folder)}`);
  };

  // Keyboard shortcuts (web only)
  useEffect(() => {
    if (Platform.OS !== 'web' || !email) return;
    const handleKey = (e) => {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA' || e.target?.isContentEditable) return;
      switch (e.key) {
        case 'r': handleReply(email); break;
        case 'a': handleReplyAll(email); break;
        case 'f': handleForward(); break;
        case 'e': handleArchive(); break;
        case '#': handleDelete(); break;
        case 'Escape': router.back(); break;
        case 'ArrowLeft':
        case 'j':
          if (prevUid) navigateToEmail(prevUid);
          break;
        case 'ArrowRight':
        case 'k':
          if (nextUid) navigateToEmail(nextUid);
          break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [email]);

  useEffect(() => {
    if (!uid) { router.back(); return; }
    let cancelled = false;

    // Load the single message first, then try to get thread
    Promise.all([
      getMessage(uid, folder),
      getThread(uid, folder).catch(() => null),
    ]).then(([msgResult, threadResult]) => {
      if (cancelled) return;
      // Sempre seta email/thread baseado no resultado atual — antes deixava
      // estado anterior "vazar" ao falhar carga ou ao trocar de uid.
      setEmail(msgResult?.success ? msgResult.data : null);
      if (msgResult?.success) markAsRead(uid, folder);
      setThread(threadResult?.success && threadResult.data?.length > 1 ? threadResult.data : null);
    }).finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [uid, folder]);

  const handleReply = (emailData) => {
    const replyEmail = emailData || email;
    let url = `/compose?reply_uid=${uid}&folder=${encodeURIComponent(folder)}&to=${encodeURIComponent(replyEmail?.from || '')}&subject=${encodeURIComponent('Re: ' + (replyEmail?.subject || ''))}`;
    if (replyEmail?.smartReply) {
      url += `&smart_reply=${encodeURIComponent(replyEmail.smartReply)}`;
    }
    router.push(url);
  };

  const handleReplyAll = (emailData) => {
    const replyEmail = emailData || email;
    const allRecipients = [replyEmail?.to, replyEmail?.cc].filter(Boolean).join(',');
    let url = `/compose?reply_uid=${uid}&reply_all=1&folder=${encodeURIComponent(folder)}&to=${encodeURIComponent(replyEmail?.from || '')}&cc=${encodeURIComponent(allRecipients)}&subject=${encodeURIComponent('Re: ' + (replyEmail?.subject || ''))}`;
    router.push(url);
  };

  const handleForward = () => {
    router.push(`/compose?forward_uid=${uid}&folder=${encodeURIComponent(folder)}&subject=${encodeURIComponent('Fwd: ' + (email?.subject || ''))}`);
  };

  const handleDelete = async () => {
    const doDelete = async () => {
      await apiDelete(uid, folder);
      refresh();
      router.back();
    };
    const title = t('read.confirmDeleteTitle');
    const msg = t('read.confirmDeleteMsg');
    if (Platform.OS === 'web') {
      // Web: use Alert.alert which renders as modal in this codebase. Fallback
      // to window.confirm if Alert isn't available.
      try {
        Alert.alert(title, msg, [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('reader.delete'), style: 'destructive', onPress: doDelete },
        ]);
      } catch {
        if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${msg}`)) doDelete();
      }
    } else {
      Alert.alert(title, msg, [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('reader.delete'), style: 'destructive', onPress: doDelete },
      ]);
    }
  };

  const handleArchive = async () => {
    await archiveEmail(uid, folder);
    refresh();
    router.back();
  };

  const handleStar = async (e) => {
    if (e.flagged) {
      await unstarEmail(uid, folder);
    } else {
      await starEmail(uid, folder);
    }
    setEmail(prev => prev ? { ...prev, flagged: !prev.flagged } : prev);
  };

  const handleAddLabel = async (emailUid, label) => {
    await addLabel(emailUid || uid, label, folder);
    setEmail(prev => prev ? { ...prev, labels: [...(prev.labels || []).filter(l => l !== label), label] } : prev);
  };

  const handleRemoveLabel = async (emailUid, label) => {
    await removeLabel(emailUid || uid, label, folder);
    setEmail(prev => prev ? { ...prev, labels: (prev.labels || []).filter(l => l !== label) } : prev);
  };

  const handleReportSpam = async (e) => {
    const { reportSpam } = await import('../services/api');
    await reportSpam(uid, folder);
    refresh();
    router.back();
  };

  const handleReportHam = async (e) => {
    const { reportHam } = await import('../services/api');
    await reportHam(uid, folder);
    refresh();
    router.back();
  };

  if (loading) {
    return (
      <View style={[s.container, { paddingTop: insets.top, backgroundColor: colors.surface }]}>
        {Platform.OS !== 'web' && (
          <View style={[s.navBar, { backgroundColor: isDark ? '#0d0a14' : '#6D28D9', borderBottomColor: 'transparent', borderBottomWidth: 0 }]}>
            <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={{ top: 12, bottom: 12, left: 16, right: 12 }}>
              <IconChevronLeft size={22} color="#fff" />
              <Text style={[s.backText, { color: '#fff' }]}>{t('reader.back')}</Text>
            </TouchableOpacity>
          </View>
        )}
        <MessageSkeleton />
      </View>
    );
  }

  // Back nav bar (mobile) — gradient roxo igual ao /chat e /inbox.
  // Wave 3 consolidação 2026-05-08: header não muda mais a paleta visual
  // entre Conversas/Inbox/Read — todas usam o mesmo brand purple gradient.
  const navBar = Platform.OS !== 'web' ? (
    <View style={[s.navBar, {
      backgroundColor: isDark ? '#0d0a14' : '#6D28D9',
      borderBottomColor: 'transparent',
      borderBottomWidth: 0,
    }]}>
      <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={{ top: 12, bottom: 12, left: 16, right: 12 }} accessibilityLabel={t('reader.back')} accessibilityRole="button">
        <IconChevronLeft size={22} color="#fff" />
        <Text style={[s.backText, { color: '#fff' }]}>{t('reader.back')}</Text>
      </TouchableOpacity>
      <View style={{ flex: 1 }} />
      <View style={s.navArrows}>
        <TouchableOpacity
          onPress={() => navigateToEmail(prevUid)}
          style={[s.navArrowBtn, !prevUid && { opacity: 0.3 }]}
          disabled={!prevUid}
          hitSlop={{ top: 12, bottom: 12, left: 16, right: 12 }}
          accessibilityLabel={t('reader.prevEmail')}
          accessibilityRole="button"
        >
          <IconChevronLeft size={20} color="rgba(255,255,255,0.85)" />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => navigateToEmail(nextUid)}
          style={[s.navArrowBtn, !nextUid && { opacity: 0.3 }]}
          disabled={!nextUid}
          hitSlop={{ top: 12, bottom: 12, left: 16, right: 12 }}
          accessibilityLabel={t('reader.nextEmail')}
          accessibilityRole="button"
        >
          <IconChevronRight size={20} color="rgba(255,255,255,0.85)" />
        </TouchableOpacity>
      </View>
    </View>
  ) : null;

  // Floating action bar (mobile only) with press animations
  const actionBar = Platform.OS !== 'web' && email ? (
    <View style={[s.actionBar, Shadow.lg, { backgroundColor: colors.surface, paddingBottom: insets.bottom + 8, borderTopColor: colors.borderLight }]}>
      <ActionBarButton icon={IconReply} label={t('reader.reply')} color={colors.primary} onPress={() => handleReply(email)} accessibilityLabel={t('reader.reply')} />
      <ActionBarButton icon={IconForward} label={t('reader.forward')} color={colors.textSecondary} onPress={handleForward} accessibilityLabel={t('reader.forward')} />
      <ActionBarButton icon={IconArchive} label={t('reader.archive')} color={colors.textSecondary} onPress={handleArchive} accessibilityLabel={t('reader.archive')} />
      <ActionBarButton icon={IconTrash} label={t('reader.delete')} color={colors.error} onPress={handleDelete} accessibilityLabel={t('reader.delete')} />
    </View>
  ) : null;

  // Reading progress bar component
  const progressBar = (
    <Animated.View
      style={[
        s.progressBar,
        {
          backgroundColor: colors.primary,
          transform: [{
            scaleX: scrollProgress,
          }],
          opacity: scrollProgress.interpolate({
            inputRange: [0, 0.02, 0.98, 1],
            outputRange: [0, 1, 1, 0],
          }),
        },
      ]}
    />
  );

  // Show thread view if we have multiple messages in the conversation
  if (thread && thread.length > 1) {
    return (
      <View style={[s.container, { paddingTop: insets.top, backgroundColor: colors.surface }]}>
        {navBar}
        {progressBar}
        <ThreadView
          thread={thread}
          onReply={handleReply}
          onReplyAll={handleReplyAll}
          onForward={handleForward}
          onClose={() => router.back()}
        />
        {actionBar}
      </View>
    );
  }

  return (
    <View style={[s.container, { paddingTop: insets.top, backgroundColor: colors.surface }]}>
      {navBar}
      {progressBar}
      <Animated.View style={{ flex: 1, opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}>
        <EmailReader
          email={email}
          folder={folder}
          onReply={handleReply}
          onReplyAll={handleReplyAll}
          onForward={handleForward}
          onDelete={handleDelete}
          onStar={handleStar}
          onAddLabel={handleAddLabel}
          onRemoveLabel={handleRemoveLabel}
          onReportSpam={handleReportSpam}
          onReportHam={handleReportHam}
          onMarkUnread={async (e) => {
            const { markUnread } = await import('../services/api');
            await markUnread(uid, folder);
            refresh();
            router.back();
          }}
          onClose={() => router.back()}
          onScrollProgress={(progress) => {
            scrollProgress.setValue(progress);
          }}
        />
      </Animated.View>
      {actionBar}
    </View>
  );
}

// Action bar button with press scale animation
function ActionBarButton({ icon: Icon, label, color, onPress, accessibilityLabel }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const nd = Platform.OS !== 'web';

  return (
    <TouchableOpacity
      style={s.actionBarBtn}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel || label}
      accessibilityRole="button"
      onPressIn={() => {
        Animated.spring(scaleAnim, {
          toValue: 0.85,
          tension: 300,
          friction: 10,
          useNativeDriver: true,
        }).start();
      }}
      onPressOut={() => {
        Animated.spring(scaleAnim, {
          toValue: 1,
          tension: 160,
          friction: 10,
          useNativeDriver: true,
        }).start();
      }}
      activeOpacity={1}
    >
      <Animated.View style={{ transform: [{ scale: scaleAnim }], alignItems: 'center' }}>
        <Icon size={22} color={color} />
        <Text style={[s.actionBarLabel, { color }]}>{label}</Text>
      </Animated.View>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  loader: { marginTop: 60 },
  progressBar: {
    height: 3,
    // Brand purple instead of #7C3AED blue — matches the tab bar glow,
    // send button, and chat header pulse so the reading-progress strip
    // reads as part of the app instead of a foreign accent.
    backgroundColor: '#7C3AED',
    ...Platform.select({
      web: {
        transformOrigin: 'left',
        transition: 'opacity 0.3s ease',
        background: 'linear-gradient(90deg, #7C3AED 0%, #a78bfa 100%)',
      },
      default: {},
    }),
  },
  navBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // Why: back button hit area was thin (paddingVertical 6, padLeft 4) which
  // is below the 44pt iOS tap target threshold. Bumped to 10/10 + cursor on
  // web so the hit zone matches Apple HIG and the button doesn't feel
  // crammed against the edge.
  backBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingRight: Spacing.md, paddingLeft: 8,
    borderRadius: 12,
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 160ms ease' } : {}),
  },
  backText: { fontSize: FontSize.lg, fontWeight: '700', marginLeft: 4, letterSpacing: -0.2 },
  navArrows: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  navArrowBtn: {
    padding: 10, borderRadius: 22,
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 160ms ease' } : {}),
  },
  actionBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around',
    paddingTop: 8, paddingBottom: 4, borderTopWidth: StyleSheet.hairlineWidth,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
      },
      default: {},
    }),
  },
  actionBarBtn: {
    alignItems: 'center', paddingVertical: 6, paddingHorizontal: 16,
    borderRadius: 12,
  },
  actionBarLabel: { fontSize: 11, marginTop: 4, fontWeight: '600', letterSpacing: 0.1 },
});
