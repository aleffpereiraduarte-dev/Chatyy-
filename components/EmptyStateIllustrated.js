import { useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Animated, Easing } from 'react-native';
import Svg, { Path, Circle, Rect, G, Defs, LinearGradient, Stop } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';

// ---------- Illustrations ----------

function ChatsIllustration({ color = '#7C3AED' }) {
  // Two outlined speech bubbles, primary purple
  return (
    <Svg width={120} height={120} viewBox="0 0 120 120" fill="none">
      <Path
        d="M22 38 C22 30, 28 24, 36 24 L74 24 C82 24, 88 30, 88 38 L88 60 C88 68, 82 74, 74 74 L46 74 L32 86 L32 74 L36 74 C28 74, 22 68, 22 60 Z"
        stroke={color}
        strokeWidth={3}
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx={42} cy={49} r={3} fill={color} />
      <Circle cx={55} cy={49} r={3} fill={color} />
      <Circle cx={68} cy={49} r={3} fill={color} />
      <Path
        d="M58 64 C58 58, 62 54, 68 54 L94 54 C100 54, 104 58, 104 64 L104 80 C104 86, 100 90, 94 90 L82 90 L74 98 L74 90 L68 90 C62 90, 58 86, 58 80 Z"
        stroke={color}
        strokeOpacity={0.45}
        strokeWidth={2.5}
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

function CallsIllustration({ color = '#7C3AED' }) {
  // Phone handset with sound waves
  return (
    <Svg width={120} height={120} viewBox="0 0 120 120" fill="none">
      <Path
        d="M28 32 C28 28, 31 25, 35 25 L46 25 C49 25, 52 27, 53 30 L56 41 C57 44, 56 47, 53 49 L47 53 C50 61, 56 67, 64 70 L68 64 C70 61, 73 60, 76 61 L87 64 C90 65, 92 68, 92 71 L92 82 C92 86, 89 89, 85 89 C53 89, 28 64, 28 32 Z"
        fill={color}
        fillOpacity={0.12}
        stroke={color}
        strokeWidth={3}
        strokeLinejoin="round"
      />
      <Path d="M74 26 Q82 30, 82 38" stroke={color} strokeWidth={2.5} strokeLinecap="round" fill="none" />
      <Path d="M78 18 Q92 24, 92 38" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeOpacity={0.7} fill="none" />
      <Path d="M82 10 Q102 18, 102 38" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeOpacity={0.4} fill="none" />
    </Svg>
  );
}

function StatusIllustration({ color = '#7C3AED' }) {
  // Gradient ring with camera in center
  return (
    <Svg width={120} height={120} viewBox="0 0 120 120" fill="none">
      <Defs>
        <LinearGradient id="statusRing" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#7C3AED" />
          <Stop offset="0.5" stopColor="#EC4899" />
          <Stop offset="1" stopColor="#F59E0B" />
        </LinearGradient>
      </Defs>
      <Circle cx={60} cy={60} r={44} stroke="url(#statusRing)" strokeWidth={4} fill="none" />
      <Circle cx={60} cy={60} r={36} fill={color} fillOpacity={0.06} />
      <Path
        d="M44 56 C44 52, 47 49, 51 49 L54 49 L57 45 L63 45 L66 49 L69 49 C73 49, 76 52, 76 56 L76 70 C76 73, 73 76, 70 76 L50 76 C47 76, 44 73, 44 70 Z"
        stroke={color}
        strokeWidth={2.5}
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx={60} cy={62} r={6} stroke={color} strokeWidth={2.5} fill="none" />
      <Circle cx={70} cy={55} r={1.5} fill={color} />
    </Svg>
  );
}

function NotificationsIllustration({ color = '#7C3AED' }) {
  // Bell with sleeping Z's
  return (
    <Svg width={120} height={120} viewBox="0 0 120 120" fill="none">
      <Path
        d="M44 76 L44 56 C44 46, 51 38, 60 38 C69 38, 76 46, 76 56 L76 76 L80 80 L40 80 Z"
        fill={color}
        fillOpacity={0.12}
        stroke={color}
        strokeWidth={3}
        strokeLinejoin="round"
      />
      <Path d="M60 32 L60 38" stroke={color} strokeWidth={3} strokeLinecap="round" />
      <Path
        d="M54 84 C54 87, 57 90, 60 90 C63 90, 66 87, 66 84"
        stroke={color}
        strokeWidth={3}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M82 30 L92 30 L82 42 L92 42"
        stroke={color}
        strokeWidth={2.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M90 16 L98 16 L90 25 L98 25"
        stroke={color}
        strokeWidth={2}
        strokeOpacity={0.6}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

function SearchIllustration({ color = '#7C3AED' }) {
  // Magnifier with sparkle
  return (
    <Svg width={120} height={120} viewBox="0 0 120 120" fill="none">
      <Circle cx={52} cy={52} r={26} stroke={color} strokeWidth={3.5} fill={color} fillOpacity={0.08} />
      <Circle cx={52} cy={52} r={26} stroke={color} strokeWidth={3.5} fill="none" />
      <Path d="M72 72 L92 92" stroke={color} strokeWidth={4.5} strokeLinecap="round" />
      <Path d="M44 48 Q48 44, 52 44" stroke={color} strokeWidth={2.5} strokeLinecap="round" fill="none" strokeOpacity={0.6} />
      <G>
        <Path d="M86 24 L86 36 M80 30 L92 30" stroke={color} strokeWidth={2.5} strokeLinecap="round" />
        <Circle cx={86} cy={30} r={1.5} fill={color} />
      </G>
      <Path d="M30 28 L30 36 M26 32 L34 32" stroke={color} strokeWidth={2} strokeLinecap="round" strokeOpacity={0.5} />
    </Svg>
  );
}

function FilesIllustration({ color = '#7C3AED' }) {
  // Folder with floating documents
  return (
    <Svg width={120} height={120} viewBox="0 0 120 120" fill="none">
      <Rect x={32} y={28} width={28} height={36} rx={3} stroke={color} strokeWidth={2.5} strokeOpacity={0.5} fill={color} fillOpacity={0.05} />
      <Path d="M38 38 L54 38 M38 46 L54 46 M38 54 L48 54" stroke={color} strokeWidth={2} strokeOpacity={0.5} strokeLinecap="round" />
      <Rect x={62} y={20} width={26} height={32} rx={3} stroke={color} strokeWidth={2.5} strokeOpacity={0.7} fill={color} fillOpacity={0.08} />
      <Path d="M68 30 L82 30 M68 38 L82 38 M68 46 L78 46" stroke={color} strokeWidth={2} strokeOpacity={0.7} strokeLinecap="round" />
      <Path
        d="M22 70 C22 66, 25 63, 29 63 L46 63 L52 69 L91 69 C95 69, 98 72, 98 76 L98 96 C98 100, 95 103, 91 103 L29 103 C25 103, 22 100, 22 96 Z"
        fill={color}
        fillOpacity={0.15}
        stroke={color}
        strokeWidth={3}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function ContactsIllustration({ color = '#7C3AED' }) {
  // Two connected silhouettes
  return (
    <Svg width={120} height={120} viewBox="0 0 120 120" fill="none">
      <Path d="M44 60 Q60 56, 76 60" stroke={color} strokeWidth={2.5} strokeOpacity={0.4} strokeDasharray="3 4" strokeLinecap="round" fill="none" />
      <Circle cx={40} cy={48} r={12} stroke={color} strokeWidth={3} fill={color} fillOpacity={0.12} />
      <Path
        d="M22 90 C22 80, 30 72, 40 72 C50 72, 58 80, 58 90 L58 96 L22 96 Z"
        stroke={color}
        strokeWidth={3}
        strokeLinejoin="round"
        fill={color}
        fillOpacity={0.12}
      />
      <Circle cx={80} cy={48} r={12} stroke={color} strokeWidth={3} fill={color} fillOpacity={0.18} />
      <Path
        d="M62 90 C62 80, 70 72, 80 72 C90 72, 98 80, 98 90 L98 96 L62 96 Z"
        stroke={color}
        strokeWidth={3}
        strokeLinejoin="round"
        fill={color}
        fillOpacity={0.18}
      />
    </Svg>
  );
}

const VARIANT_MAP = {
  chats: { Illustration: ChatsIllustration, titleKey: 'empty.chats.title', subtitleKey: 'empty.chats.subtitle', actionKey: 'empty.chats.action' },
  calls: { Illustration: CallsIllustration, titleKey: 'empty.calls.title', subtitleKey: 'empty.calls.subtitle', actionKey: 'empty.calls.action' },
  status: { Illustration: StatusIllustration, titleKey: 'empty.status.title', subtitleKey: 'empty.status.subtitle', actionKey: 'empty.status.action' },
  notifications: { Illustration: NotificationsIllustration, titleKey: 'empty.notifications.title', subtitleKey: 'empty.notifications.subtitle', actionKey: 'empty.notifications.action' },
  search: { Illustration: SearchIllustration, titleKey: 'empty.search.title', subtitleKey: 'empty.search.subtitle', actionKey: null },
  files: { Illustration: FilesIllustration, titleKey: 'empty.files.title', subtitleKey: 'empty.files.subtitle', actionKey: 'empty.files.action' },
  contacts: { Illustration: ContactsIllustration, titleKey: 'empty.contacts.title', subtitleKey: 'empty.contacts.subtitle', actionKey: 'empty.contacts.action' },
};

export default function EmptyStateIllustrated({
  variant = 'chats',
  title,
  subtitle,
  actionLabel,
  onActionPress,
}) {
  const { colors } = useTheme();
  const { t } = useLanguage();

  const config = VARIANT_MAP[variant] || VARIANT_MAP.chats;
  const Illustration = config.Illustration;

  const resolvedTitle = title != null ? title : t(config.titleKey);
  const resolvedSubtitle = subtitle != null ? subtitle : t(config.subtitleKey);
  const resolvedAction = actionLabel != null
    ? actionLabel
    : (config.actionKey ? t(config.actionKey) : null);

  // Entrance animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.95)).current;
  // Floating animation on illustration
  const floatAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(scaleAnim, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();

    const float = Animated.loop(
      Animated.sequence([
        Animated.timing(floatAnim, {
          toValue: 1,
          duration: 1500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(floatAnim, {
          toValue: 0,
          duration: 1500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    float.start();
    return () => float.stop();
  }, []);

  const translateY = floatAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-4, 4],
  });

  const primary = colors?.primary || '#7C3AED';

  return (
    <Animated.View
      style={[
        styles.container,
        { opacity: fadeAnim, transform: [{ scale: scaleAnim }] },
      ]}
    >
      <Animated.View style={[styles.illustrationWrap, { transform: [{ translateY }] }]}>
        <Illustration color={primary} />
      </Animated.View>

      <Text style={[styles.title, { color: colors?.text || '#0f172a' }]}>
        {resolvedTitle}
      </Text>

      {!!resolvedSubtitle && (
        <Text style={[styles.subtitle, { color: colors?.textSecondary || '#64748b' }]}>
          {resolvedSubtitle}
        </Text>
      )}

      {!!resolvedAction && typeof onActionPress === 'function' && (
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={onActionPress}
          style={[
            styles.actionBtn,
            { backgroundColor: primary },
          ]}
          accessibilityRole="button"
          accessibilityLabel={resolvedAction}
        >
          <Text style={styles.actionText}>{resolvedAction}</Text>
        </TouchableOpacity>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingVertical: 40,
  },
  illustrationWrap: {
    width: 120,
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginTop: 6,
    maxWidth: 300,
  },
  actionBtn: {
    marginTop: 20,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 999,
    ...Platform.select({
      web: {
        cursor: 'pointer',
        transition: 'transform 0.15s ease, opacity 0.15s ease',
      },
      default: {},
    }),
  },
  actionText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
});
