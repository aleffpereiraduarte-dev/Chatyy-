import { useEffect, useState, useRef } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform, Animated, Easing } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getMessage, deleteEmail as apiDelete, starEmail, unstarEmail, addLabel, removeLabel, getThread, archiveEmail } from '../services/api';
import { useMail } from '../context/MailContext';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { Shadow, Spacing, FontSize, BorderRadius, AnimTiming } from '../constants/theme';
import EmailReader from '../components/EmailReader';
import ThreadView from '../components/ThreadView';
import { IconChevronLeft, IconReply, IconArchive, IconTrash, IconForward } from '../components/Icons';

export default function ReadScreen() {
  const { uid, folder = 'INBOX' } = useLocalSearchParams();
  const [email, setEmail] = useState(null);
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(true);
  const { refresh, markAsRead } = useMail();
  const { colors } = useTheme();
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
          useNativeDriver: nd,
        }),
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: AnimTiming.entrance,
          easing: Easing.out(Easing.exp),
          useNativeDriver: nd,
        }),
      ]).start();
    }
  }, [loading, email]);

  useEffect(() => {
    if (!uid) { setLoading(false); return; }
    let cancelled = false;

    // Load the single message first, then try to get thread
    Promise.all([
      getMessage(uid, folder),
      getThread(uid, folder).catch(() => null),
    ]).then(([msgResult, threadResult]) => {
      if (cancelled) return;
      if (msgResult.success) {
        setEmail(msgResult.data);
        markAsRead(uid, folder);
      }
      // Only use thread view if there are multiple messages
      if (threadResult?.success && threadResult.data?.length > 1) {
        setThread(threadResult.data);
      }
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
    await apiDelete(uid, folder);
    refresh();
    router.back();
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
          <View style={[s.navBar, { backgroundColor: colors.surface, borderBottomColor: colors.borderLight }]}>
            <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <IconChevronLeft size={22} color={colors.primary} />
              <Text style={[s.backText, { color: colors.primary }]}>{t('reader.back')}</Text>
            </TouchableOpacity>
          </View>
        )}
        <ActivityIndicator size="large" color={colors.primary} style={s.loader} />
      </View>
    );
  }

  // Back nav bar (mobile)
  const navBar = Platform.OS !== 'web' ? (
    <View style={[s.navBar, { backgroundColor: colors.surface, borderBottomColor: colors.borderLight }]}>
      <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <IconChevronLeft size={22} color={colors.primary} />
        <Text style={[s.backText, { color: colors.primary }]}>{t('reader.back')}</Text>
      </TouchableOpacity>
    </View>
  ) : null;

  // Floating action bar (mobile only) with press animations
  const actionBar = Platform.OS !== 'web' && email ? (
    <View style={[s.actionBar, Shadow.lg, { backgroundColor: colors.surface, paddingBottom: insets.bottom + 8, borderTopColor: colors.borderLight }]}>
      <ActionBarButton icon={IconReply} label={t('reader.reply')} color={colors.primary} onPress={() => handleReply(email)} />
      <ActionBarButton icon={IconForward} label={t('reader.forward')} color={colors.textSecondary} onPress={handleForward} />
      <ActionBarButton icon={IconArchive} label={t('reader.archive')} color={colors.textSecondary} onPress={handleArchive} />
      <ActionBarButton icon={IconTrash} label={t('reader.delete')} color={colors.error} onPress={handleDelete} />
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
function ActionBarButton({ icon: Icon, label, color, onPress }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const nd = Platform.OS !== 'web';

  return (
    <TouchableOpacity
      style={s.actionBarBtn}
      onPress={onPress}
      onPressIn={() => {
        Animated.spring(scaleAnim, {
          toValue: 0.85,
          tension: 300,
          friction: 10,
          useNativeDriver: nd,
        }).start();
      }}
      onPressOut={() => {
        Animated.spring(scaleAnim, {
          toValue: 1,
          tension: 160,
          friction: 10,
          useNativeDriver: nd,
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
    height: 2.5,
    backgroundColor: '#2563eb',
    ...Platform.select({
      web: { transformOrigin: 'left', transition: 'opacity 0.3s ease' },
      default: {},
    }),
  },
  navBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 4, paddingRight: Spacing.md,
  },
  backText: { fontSize: FontSize.lg, fontWeight: '500', marginLeft: 2 },
  actionBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around',
    paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionBarBtn: {
    alignItems: 'center', paddingVertical: 4, paddingHorizontal: 12,
  },
  actionBarLabel: { fontSize: 11, marginTop: 3, fontWeight: '500' },
});
