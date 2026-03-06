import { useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import { IconArrowLeft, IconRefresh, IconGlobe } from '../components/Icons';

const DOCS_URL = 'https://mail.onemundo.com.br/docs/';

export default function DocumentosScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const webViewRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);

  const handleBack = () => {
    if (canGoBack && webViewRef.current) {
      webViewRef.current.goBack();
    } else {
      router.back();
    }
  };

  if (Platform.OS === 'web') {
    return (
      <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={s.headerBtn}>
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
          <IconGlobe size={20} color="#4285f4" style={{ marginRight: 8 }} />
          <Text style={[s.headerTitle, { color: colors.text }]}>{t('sidebar.documents')}</Text>
          <View style={{ flex: 1 }} />
        </View>
        <iframe
          src={DOCS_URL}
          style={{ flex: 1, border: 'none', width: '100%', height: '100%' }}
          title="Documentos"
        />
      </View>
    );
  }

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={handleBack} style={s.headerBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <IconGlobe size={20} color="#4285f4" style={{ marginRight: 8 }} />
        <Text style={[s.headerTitle, { color: colors.text }]}>{t('sidebar.documents')}</Text>
        <View style={{ flex: 1 }} />
        {loading && <ActivityIndicator size="small" color={colors.primary} style={{ marginRight: 8 }} />}
        <TouchableOpacity onPress={() => webViewRef.current?.reload()} style={s.headerBtn}>
          <IconRefresh size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
      <WebView
        ref={webViewRef}
        source={{ uri: DOCS_URL }}
        style={{ flex: 1 }}
        sharedCookiesEnabled={true}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={false}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        onNavigationStateChange={(navState) => setCanGoBack(navState.canGoBack)}
        allowsBackForwardNavigationGestures={true}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 56,
    paddingHorizontal: Spacing.sm,
    borderBottomWidth: 1,
  },
  headerBtn: { padding: Spacing.sm },
  headerTitle: { fontSize: FontSize.lg, fontWeight: '600' },
});
