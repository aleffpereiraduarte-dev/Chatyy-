// [2026-10-07 app-feel-webview] Docs editor host. The editor itself stays web
// (CKEditor/jspreadsheet pages under /docs/ — native rewrite planned, see
// report), but the shell is native: native header showing the REAL document
// title (read from the page's #title input), native share button driving the
// page's share modal, thin native progress bar instead of a spinner, web
// chrome (emoji share button, desktop 96px page margins, wrapping toolbar)
// hidden/adapted via injected CSS, no pinch-zoom / tap-highlight / callout,
// normal deceleration, external links in the in-app browser sheet.
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Animated, Easing } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius } from '../constants/theme';
import { IconArrowLeft, IconRefresh, IconUserPlus } from '../components/Icons';
import { getToken } from '../services/api';
import { openInApp, isOwnHost, NATIVE_WEBVIEW_PROPS, nativeFeelInjectedJS } from '../utils/inAppBrowser';

// Mobile adaptation of the desktop docs pages. Selectors are shared by
// editor/spreadsheet/presentation/markdown/drawing (.topbar/.toolbar/.sheet).
const DOCS_MOBILE_CSS = [
  // native header owns the title + share → hide the web duplicates
  '.topbar .share-btn{display:none!important}',
  '.topbar{padding:6px 12px!important;flex-wrap:nowrap!important}',
  '.topbar input.title{font-size:16px!important;min-width:0!important}',
  // toolbar: one horizontally-scrolling row like a native formatting bar
  '.toolbar{flex-wrap:nowrap!important;overflow-x:auto!important;-webkit-overflow-scrolling:touch;scrollbar-width:none}',
  '.toolbar::-webkit-scrollbar{display:none}',
  '.toolbar button,.toolbar select{flex-shrink:0;min-height:36px}',
  // paper: no desktop margins/shadow on a phone
  '@media(max-width:820px){.sheet-wrap{padding:0!important}.sheet{width:100%!important;padding:20px 16px 80px!important;min-height:calc(100vh - 110px)!important;box-shadow:none!important;border-radius:0!important}.sheet:focus{box-shadow:none!important}}',
  // modals → bottom-sheet look
  '@media(max-width:820px){.modal-back{align-items:flex-end!important}.modal{width:100%!important;max-width:none!important;border-radius:16px 16px 0 0!important;padding-bottom:calc(20px + env(safe-area-inset-bottom))!important}}',
].join('');

// Reports the document's own title (input#title) so the native header can
// show it; re-posts on edit.
const TITLE_BRIDGE_JS = `(function(){try{
  var last=null;
  function post(){try{var el=document.getElementById('title');var v=el?(el.value||el.placeholder||''):(document.title||'');if(v!==last){last=v;window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'__docTitle',title:v}));}}catch(e){}}
  document.addEventListener('input',function(e){if(e&&e.target&&e.target.id==='title')post();},true);
  setInterval(post,1500);post();
}catch(e){}})();true;`;

export default function DocumentosViewerScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const webViewRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [error, setError] = useState(false);
  const [docTitle, setDocTitle] = useState(() => String((Array.isArray(params.title) ? params.title[0] : params.title) || ''));
  const [reloadKey, setReloadKey] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;
  const url = (Array.isArray(params.url) ? params.url[0] : params.url) || 'https://chatyy.com.br/docs/';

  useEffect(() => {
    if (Platform.OS === 'web') router.back();
  }, []);

  const injectedBefore = useMemo(
    () => `try{localStorage.setItem('mail_token', ${JSON.stringify(getToken() || '')});}catch(e){}\n` +
      // docs pages own their (light) palette → don't force bg / color-scheme.
      nativeFeelInjectedJS(null, false, DOCS_MOBILE_CSS, { background: false, colorScheme: false }),
    [],
  );

  const setProgress = useCallback((p) => {
    Animated.timing(progress, { toValue: p, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
  }, [progress]);

  if (Platform.OS === 'web') return null;

  const WebView = require('react-native-webview').WebView;

  const handleBack = () => {
    if (canGoBack && webViewRef.current) webViewRef.current.goBack();
    else router.back();
  };

  const openShare = () => {
    try {
      webViewRef.current?.injectJavaScript(`(function(){try{var b=document.getElementById('share-btn');if(b)b.click();}catch(e){}})();true;`);
    } catch {}
  };

  const barWidth = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <View style={[s.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[s.header, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={handleBack} style={s.headerBtn} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.back') || 'Voltar'}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {docTitle || t('sidebar.documents')}
        </Text>
        <TouchableOpacity onPress={openShare} style={s.headerBtn} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('docs.share') || 'Compartilhar'}>
          <IconUserPlus size={20} color={colors.primary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => webViewRef.current?.reload()} style={s.headerBtn} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.retry') || 'Recarregar'}>
          <IconRefresh size={20} color={colors.textSecondary} />
        </TouchableOpacity>
        {loading && (
          <Animated.View pointerEvents="none" style={[s.progress, { width: barWidth, backgroundColor: colors.primary }]} />
        )}
      </View>
      {error ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 }}>
          <Text style={{ fontSize: FontSize.lg, fontWeight: '600', color: colors.text, marginBottom: 12 }}>
            {t('common.error')}
          </Text>
          <TouchableOpacity
            onPress={() => { setError(false); setLoading(true); setReloadKey((k) => k + 1); }}
            style={{ paddingHorizontal: 24, paddingVertical: 10, backgroundColor: colors.primary, borderRadius: BorderRadius.md }}
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: FontSize.md }}>
              {t('common.retry') || 'Retry'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <WebView
          key={reloadKey}
          ref={webViewRef}
          source={{ uri: url }}
          // Docs paper is light (like Google Docs); match its page bg so there
          // is no white/black flash between native header and content.
          style={{ flex: 1, backgroundColor: '#f7f8fa' }}
          {...NATIVE_WEBVIEW_PROPS}
          sharedCookiesEnabled={true}
          thirdPartyCookiesEnabled={true}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          injectedJavaScriptBeforeContentLoaded={injectedBefore}
          injectedJavaScript={TITLE_BRIDGE_JS}
          bounces={false}
          scrollEnabled={true}
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView={false}
          onLoadStart={() => { setLoading(true); progress.setValue(0.05); }}
          onLoadProgress={({ nativeEvent }) => setProgress(Math.max(0.05, nativeEvent?.progress || 0))}
          onLoadEnd={() => { setProgress(1); setTimeout(() => setLoading(false), 200); }}
          onError={() => { setError(true); setLoading(false); }}
          onNavigationStateChange={(navState) => setCanGoBack(navState.canGoBack)}
          onMessage={(e) => {
            try {
              const msg = JSON.parse(e.nativeEvent.data);
              if (msg?.type === '__docTitle' && typeof msg.title === 'string') setDocTitle(msg.title.trim());
            } catch {}
          }}
          onShouldStartLoadWithRequest={(request) => {
            // Strict hostname check (no evilchatyy.com.br).
            if (request.url === 'about:blank' || isOwnHost(request.url)) return true;
            if (/^https?:\/\//.test(request.url)) openInApp(request.url, { colors, isDark });
            else { try { require('react-native').Linking.openURL(request.url); } catch {} }
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
    height: 52,
    paddingHorizontal: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { padding: Spacing.sm },
  headerTitle: { flex: 1, fontSize: FontSize.lg, fontWeight: '600', marginLeft: 4 },
  progress: { position: 'absolute', left: 0, bottom: -1, height: 2, borderRadius: 1 },
});
