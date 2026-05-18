// PremiumSearchBar — pill-shaped search input inspired by WhatsApp/Telegram.
//
// Why: the existing SearchBar.js is a modal-trigger pattern with operator
// suggestions, advanced filters and overlay. That's the right UX for the inbox
// power-search, but it's heavy for surfaces that just want a pretty inline
// input ("filter this list", "search contacts", "find a chat") — those screens
// were hand-rolling lightweight pills with inconsistent radius / shadow / focus
// state, which made the home tabs feel mismatched. PremiumSearchBar is the
// shared primitive so every consumer gets the same focus animation, the same
// clear button, and the same dark-mode treatment without duplicating styles.
//
// Animation choices:
//   - Uses Animated (not Reanimated) on purpose. The project mixes both and the
//     animations here are simple value interpolations, so the lighter runtime
//     keeps bundle size down and avoids the Reanimated worklet babel plumbing
//     for surfaces that may not need it (web especially).
//   - Background color is animated via interpolation between muted/surface so
//     the focus transition feels like a real "lift" instead of a hard swap.
//   - useNativeDriver=false because we're animating backgroundColor and
//     borderColor (layout-thread props). Scale uses a separate Animated.Value
//     with useNativeDriver=true so the tactile pulse stays on the UI thread.
import { useRef, useState, useCallback, useEffect } from 'react';
import {
  View, TextInput, TouchableOpacity, Animated, StyleSheet, Platform,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { IconSearch, IconX, IconFilter } from './Icons';

const FOCUS_DURATION = 180;

// Default placeholders — used only when t('search.placeholder') doesn't
// resolve (e.g. a consumer mounts this before LanguageProvider). The spec
// explicitly asks for the short verbs, so we keep these terse on purpose.
const DEFAULT_PLACEHOLDER = {
  'pt-BR': 'Pesquisar',
  en: 'Search',
  es: 'Buscar',
};

export default function PremiumSearchBar({
  value,
  onChangeText,
  placeholder,
  autoFocus = false,
  onFocus,
  onBlur,
  onClear,
  onSubmit,
  showFilter = false,
  onFilterPress,
  // Bonus: lets callers slot custom leading/trailing nodes. When provided
  // they completely replace the default search/filter icons so the consumer
  // can render anything (e.g. avatar, scoped chip, AI sparkle).
  leadingIcon,
  trailingIcon,
  style,
  inputStyle,
  testID,
}) {
  const { colors, isDark } = useTheme();
  const { t, locale } = useLanguage() || {};
  const [focused, setFocused] = useState(false);

  // Two separate animated values so we can split native-driver (transform)
  // from layout-thread (color). Combining them into one Animated.Value would
  // force useNativeDriver:false on the scale too, which feels janky on Android.
  const focusAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const clearRotateAnim = useRef(new Animated.Value(0)).current;
  const inputRef = useRef(null);

  // autoFocus handled manually so we can also trigger the focus animation
  // (TextInput's built-in autoFocus fires before onFocus on some platforms).
  useEffect(() => {
    if (autoFocus) {
      // Defer one tick so the ref is wired up on web.
      const id = setTimeout(() => inputRef.current?.focus?.(), 0);
      return () => clearTimeout(id);
    }
  }, [autoFocus]);

  const handleFocus = useCallback((e) => {
    setFocused(true);
    Animated.parallel([
      Animated.timing(focusAnim, {
        toValue: 1, duration: FOCUS_DURATION, useNativeDriver: false,
      }),
      Animated.timing(scaleAnim, {
        toValue: 1.02, duration: FOCUS_DURATION, useNativeDriver: true,
      }),
    ]).start();
    onFocus?.(e);
  }, [focusAnim, scaleAnim, onFocus]);

  const handleBlur = useCallback((e) => {
    setFocused(false);
    Animated.parallel([
      Animated.timing(focusAnim, {
        toValue: 0, duration: FOCUS_DURATION, useNativeDriver: false,
      }),
      Animated.timing(scaleAnim, {
        toValue: 1, duration: FOCUS_DURATION, useNativeDriver: true,
      }),
    ]).start();
    onBlur?.(e);
  }, [focusAnim, scaleAnim, onBlur]);

  const handleClear = useCallback(() => {
    // Rotate-and-reset gives the X a satisfying spin when tapped. Reset back
    // to 0 instantly so the next tap starts fresh (no accumulated rotation).
    Animated.sequence([
      Animated.timing(clearRotateAnim, {
        toValue: 1, duration: 180, useNativeDriver: true,
      }),
    ]).start(() => {
      clearRotateAnim.setValue(0);
    });
    onChangeText?.('');
    onClear?.();
    // Keep focus on input so the keyboard stays open — matches WhatsApp.
    inputRef.current?.focus?.();
  }, [clearRotateAnim, onChangeText, onClear]);

  const handleSubmit = useCallback(() => {
    onSubmit?.(value);
  }, [onSubmit, value]);

  // Resolve placeholder: explicit prop > i18n key > locale-default verb.
  // The third fallback exists because consumers occasionally mount this
  // outside LanguageProvider in stories/snapshots.
  let resolvedPlaceholder = placeholder;
  if (resolvedPlaceholder == null) {
    const translated = t ? t('search.placeholder') : null;
    if (translated && translated !== 'search.placeholder') {
      resolvedPlaceholder = translated;
    } else {
      resolvedPlaceholder = DEFAULT_PLACEHOLDER[locale] || DEFAULT_PLACEHOLDER.en;
    }
  }

  // Spec colors: muted gray-ish background unfocused, surface (white/dark)
  // when focused. We interpolate so the swap animates instead of jumping.
  const mutedBg = colors.surfaceMuted || (isDark ? '#1f2937' : '#f3f4f6');
  const focusedBg = colors.surface || (isDark ? '#0d0d0d' : '#ffffff');
  const bgColor = focusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [mutedBg, focusedBg],
  });
  const borderColor = focusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(0,0,0,0)', colors.primary],
  });
  // Shadow opacity stays gentle so the bar doesn't compete with primary CTAs.
  const shadowOpacity = focusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.04, 0.08],
  });

  const clearRotate = clearRotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '90deg'],
  });

  // Spec says 44 web / 40 mobile. Web includes desktop + responsive cases.
  const height = Platform.OS === 'web' ? 44 : 40;
  const hasValue = !!(value && value.length > 0);
  const subtleColor = colors.subtle || colors.textTertiary || '#7c8ba0';

  return (
    <Animated.View
      testID={testID}
      style={[
        styles.container,
        {
          height,
          backgroundColor: bgColor,
          borderColor,
          shadowColor: '#000',
          shadowOpacity,
          transform: [{ scale: scaleAnim }],
        },
        Platform.OS === 'web' && styles.containerWeb,
        style,
      ]}
    >
      {leadingIcon != null ? (
        <View style={styles.iconSlot}>{leadingIcon}</View>
      ) : (
        <View style={styles.iconSlot}>
          <IconSearch size={16} color={focused ? colors.primary : subtleColor} />
        </View>
      )}

      <TextInput
        ref={inputRef}
        style={[
          styles.input,
          { color: colors.text },
          Platform.OS === 'web' && styles.inputWeb,
          inputStyle,
        ]}
        value={value}
        onChangeText={onChangeText}
        placeholder={resolvedPlaceholder}
        placeholderTextColor={subtleColor}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onSubmitEditing={handleSubmit}
        returnKeyType="search"
        // Disable the underline on Android — the pill is the visual frame.
        underlineColorAndroid="transparent"
        // Avoid forcing autoFocus prop on the native input because some
        // platforms (web) double-fire onFocus when used together with a
        // manual focus() call from the effect above.
      />

      {hasValue ? (
        <TouchableOpacity
          onPress={handleClear}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.trailingBtn}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
        >
          <Animated.View style={{ transform: [{ rotate: clearRotate }] }}>
            <IconX size={14} color={subtleColor} />
          </Animated.View>
        </TouchableOpacity>
      ) : null}

      {trailingIcon != null ? (
        <View style={styles.trailingBtn}>{trailingIcon}</View>
      ) : showFilter ? (
        <TouchableOpacity
          onPress={onFilterPress}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.trailingBtn}
          accessibilityRole="button"
          accessibilityLabel="Open filters"
        >
          <IconFilter size={16} color={focused ? colors.primary : subtleColor} />
        </TouchableOpacity>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    borderRadius: 24,
    borderWidth: 1,
    // Soft drop shadow that gets nudged up on focus via shadowOpacity above.
    // Offsets stay constant — animating offset.y on iOS triggers a layout
    // recompute every frame which jitters on lower-end devices.
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 4,
    // Android elevation kept low so the bar doesn't fight nested cards.
    elevation: 1,
  },
  containerWeb: Platform.OS === 'web' ? {
    // Box-shadow on web mirrors the iOS shadow stack; transition kept short
    // so it lines up with the JS-driven focus animation (180ms).
    transition: 'box-shadow 180ms ease',
  } : {},
  iconSlot: {
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0, // RN Android adds default padding that breaks vertical centering.
    margin: 0,
  },
  inputWeb: Platform.OS === 'web' ? {
    outlineStyle: 'none',
    outlineWidth: 0,
  } : {},
  trailingBtn: {
    marginLeft: 8,
    padding: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
