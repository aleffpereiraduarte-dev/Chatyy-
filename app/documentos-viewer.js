import { useState, useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconArrowLeft, IconRefresh } from '../components/Icons';
import { getToken } from '../services/api';

export default function DocumentosViewerScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { t } = useLanguage();
  const webViewRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [error, setError] = useState(false);
  const url = params.url || (Platform.OS === 'web' ? 'https://chatyy.com.br/docs/' : 'https://mail.onemundo.com.br/docs/');

  useEffect(() => {
    if (Platform.OS === 'web') {
      router.back();
    }
  }, []);
  if (Platform.OS === 'web') return null;

  const WebView = require('react-native-webview').WebView;

  const handleBack = () => {
    if (canGoBack && webViewRef.current) {
      webViewRef.current.goBack();
    } else {
      router.back();
    }
  };

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={handleBack} style={s.headerBtn}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]}>{t('sidebar.documents')}</Text>
        <View style={{ flex: 1 }} />
        {loading && <ActivityIndicator size="small" color={colors.primary} style={{ marginRight: 8 }} />}
        <TouchableOpacity onPress={() => webViewRef.current?.reload()} style={s.headerBtn}>
          <IconRefresh size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
      {error ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 }}>
          <Text style={{ fontSize: FontSize.lg, fontWeight: '600', color: colors.text, marginBottom: 12 }}>
            {t('common.error')}
          </Text>
          <TouchableOpacity
            onPress={() => { setError(false); setLoading(true); }}
            style={{ paddingHorizontal: 24, paddingVertical: 10, backgroundColor: colors.primary, borderRadius: BorderRadius.md }}
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: FontSize.md }}>
              {t('common.retry') || 'Retry'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <WebView
          ref={webViewRef}
          source={{ uri: url }}
          style={{ flex: 1 }}
          sharedCookiesEnabled={true}
          thirdPartyCookiesEnabled={true}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          injectedJavaScriptBeforeContentLoaded={`try{localStorage.setItem('mail_token','${getToken() || ''}');}catch{}true;`}
          startInLoadingState={true}
          allowsInlineMediaPlayback={true}
          bounces={false}
          scrollEnabled={true}
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView={false}
          automaticallyAdjustContentInsets={false}
          onLoadStart={() => setLoading(true)}
          onLoadEnd={() => setLoading(false)}
          onError={() => { setError(true); setLoading(false); }}
          onNavigationStateChange={(navState) => setCanGoBack(navState.canGoBack)}
          allowsBackForwardNavigationGestures={true}
          onShouldStartLoadWithRequest={(request) => {
            if (request.url.includes('chatyy.com.br') || request.url.includes('onemundo.com.br')) return true;
            try { require('expo-web-browser').openBrowserAsync(request.url); } catch {}
            return false;
          }}
        />
      )}
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
  headerTitle: { fontSize: FontSize.lg, fontWeight: '600', marginLeft: 4 },
});
