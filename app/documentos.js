import { useState, useRef, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, ActivityIndicator, Modal, Pressable } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import { IconArrowLeft, IconRefresh, IconGlobe, IconPlus, IconFileText } from '../components/Icons';
import { getToken } from '../services/api';

const DOCS_URL = 'https://chatyy.com.br/docs/';

export default function DocumentosScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const webViewRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const initialUrl = params.url || DOCS_URL;
  const [canGoBack, setCanGoBack] = useState(false);
  const [error, setError] = useState(false);
  const [showCreateMenu, setShowCreateMenu] = useState(false);

  const handleBack = () => {
    if (canGoBack && webViewRef.current) {
      webViewRef.current.goBack();
    } else {
      router.back();
    }
  };

  const handleCreateDoc = useCallback((type) => {
    setShowCreateMenu(false);
    const url = type === 'spreadsheet'
      ? `${DOCS_URL}spreadsheet.html?new=1`
      : `${DOCS_URL}editor.html?new=1`;
    if (Platform.OS === 'web') {
      window.open(url, '_blank');
    } else if (webViewRef.current) {
      webViewRef.current.injectJavaScript(`window.location.href='${url}'; true;`);
    }
  }, []);

  const CreateFAB = () => (
    <>
      <TouchableOpacity
        style={[s.fab, {
          backgroundColor: '#4285f4',
          ...(Platform.OS === 'web' ? { boxShadow: '0 4px 14px rgba(66,133,244,0.4)' } : {}),
        }]}
        onPress={() => setShowCreateMenu(true)}
        activeOpacity={0.8}
        accessibilityLabel={t('docs.createNew') || 'Create new'}
        accessibilityRole="button"
      >
        <IconPlus size={24} color="#fff" />
      </TouchableOpacity>

      <Modal visible={showCreateMenu} animationType="fade" transparent onRequestClose={() => setShowCreateMenu(false)}>
        <Pressable style={s.menuOverlay} onPress={() => setShowCreateMenu(false)}>
          <View style={[s.menuCard, {
            backgroundColor: colors.surface,
            ...(Platform.OS === 'web' ? { boxShadow: '0 8px 32px rgba(0,0,0,0.15)' } : {}),
          }]}>
            <Text style={[s.menuTitle, { color: colors.text }]}>{t('docs.createNew') || 'Create new'}</Text>
            <TouchableOpacity
              style={[s.menuItem, { borderBottomColor: colors.border }]}
              onPress={() => handleCreateDoc('document')}
              activeOpacity={0.7}
            >
              <View style={[s.menuIcon, { backgroundColor: '#4285f4' + '15' }]}>
                <IconFileText size={20} color="#4285f4" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[s.menuItemTitle, { color: colors.text }]}>{t('docs.newDocument') || 'New Document'}</Text>
                <Text style={[s.menuItemSub, { color: colors.textSecondary }]}>{t('docs.newDocumentDesc') || 'Word-like text editor'}</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.menuItem}
              onPress={() => handleCreateDoc('spreadsheet')}
              activeOpacity={0.7}
            >
              <View style={[s.menuIcon, { backgroundColor: '#34a853' + '15' }]}>
                <IconGlobe size={20} color="#34a853" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[s.menuItemTitle, { color: colors.text }]}>{t('docs.newSpreadsheet') || 'New Spreadsheet'}</Text>
                <Text style={[s.menuItemSub, { color: colors.textSecondary }]}>{t('docs.newSpreadsheetDesc') || 'Excel-like spreadsheet'}</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.menuCancel, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f5f5f5' }]}
              onPress={() => setShowCreateMenu(false)}
              activeOpacity={0.7}
            >
              <Text style={{ color: colors.textSecondary, fontSize: 15, fontWeight: '600' }}>{t('common.cancel') || 'Cancel'}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </>
  );

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
          src={initialUrl}
          style={{ flex: 1, border: 'none', width: '100%', height: '100%' }}
          title="Documentos"
        />
        <CreateFAB />
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
      {error ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 }}>
          <Text style={{ fontSize: FontSize.lg, fontWeight: '600', color: colors.text, marginBottom: 12 }}>
            {t('common.error')}
          </Text>
          <Text style={{ fontSize: FontSize.md, color: colors.textSecondary, textAlign: 'center', marginBottom: 20 }}>
            {t('eventDetail.loadError') || 'Failed to load page.'}
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
          source={{ uri: initialUrl }}
          style={{ flex: 1 }}
          sharedCookiesEnabled={true}
          thirdPartyCookiesEnabled={true}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          injectedJavaScriptBeforeContentLoaded={`try{localStorage.setItem('mail_token','${getToken() || ''}');}catch{}true;`}
          startInLoadingState={true}
          allowsInlineMediaPlayback={true}
          mediaPlaybackRequiresUserAction={false}
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
            // Allow docs domain navigation
            if (request.url.includes('chatyy.com.br') || request.url.includes('mail.onemundo.com.br')) return true;
            // Open external links in browser
            try { require('expo-web-browser').openBrowserAsync(request.url); } catch {}
            return false;
          }}
        />
      )}
      <CreateFAB />
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
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 16,
    width: 56,
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 8 },
      android: { elevation: 6 },
      default: {},
    }),
  },
  menuOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
    padding: 16,
  },
  menuCard: {
    borderRadius: 20,
    overflow: 'hidden',
    paddingTop: 20,
    paddingBottom: 8,
  },
  menuTitle: {
    fontSize: 18,
    fontWeight: '700',
    paddingHorizontal: 20,
    marginBottom: 16,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
    gap: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  menuIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuItemTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  menuItemSub: {
    fontSize: 13,
    marginTop: 2,
  },
  menuCancel: {
    marginTop: 8,
    marginHorizontal: 12,
    marginBottom: 8,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
});
