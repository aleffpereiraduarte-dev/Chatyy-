// [2026-10-07 app-feel-webview] Shared helpers to make web content feel native.
//
// 1. openInApp(url, opts) — opens http(s) links in the system in-app browser
//    sheet (SFSafariViewController on iOS / Chrome Custom Tabs on Android)
//    instead of kicking the user out to Safari/Chrome via Linking.openURL.
//    Themed toolbar, "Fechar" button, page-sheet on iOS. mailto:/tel:/custom
//    schemes still go through Linking. Never throws.
//
// 2. NATIVE_WEBVIEW_PROPS — the props every embedded <WebView> of OUR pages
//    should carry so it scrolls/zooms like a native view (normal deceleration,
//    no pinch zoom, no extra windows, no Android overscroll glow, no font
//    scaling surprises).
//
// 3. nativeFeelCss(colors, isDark) / nativeFeelInjectedJS(...) — CSS injected
//    before content load: system font, no tap highlight, no callout, no
//    double-tap zoom, color-scheme matching the app theme, safe-area padding
//    off (the native header owns the top inset).
import { Platform, Linking, Appearance } from 'react-native';

const OWN_HOSTS = ['chatyy.com.br', 'onemundo.com.br'];

export function isOwnHost(url) {
  try {
    const h = new URL(String(url)).hostname;
    return OWN_HOSTS.some((d) => h === d || h.endsWith('.' + d));
  } catch { return false; }
}

export async function openInApp(url, opts = {}) {
  if (!url) return;
  let u = String(url).trim();
  if (/^www\./i.test(u)) u = 'https://' + u;
  if (!/^https?:\/\//i.test(u) || Platform.OS === 'web') {
    try { await Linking.openURL(u); } catch {}
    return;
  }
  const colors = opts.colors || null;
  const isDark = opts.isDark != null ? !!opts.isDark : Appearance.getColorScheme() === 'dark';
  try {
    const WB = require('expo-web-browser');
    const bg = colors?.surface || colors?.background || (isDark ? '#111111' : '#ffffff');
    const fg = colors?.primary || (isDark ? '#ffffff' : '#111111');
    await WB.openBrowserAsync(u, {
      toolbarColor: bg,
      secondaryToolbarColor: bg,
      controlsColor: fg,
      enableBarCollapsing: true,
      showTitle: true,
      dismissButtonStyle: 'close',
      enableDefaultShareMenuItem: true,
      readerMode: false,
      // iOS: card-style sheet over the app (swipe down to dismiss) — feels
      // like part of the app, not a context switch to Safari.
      presentationStyle: WB.WebBrowserPresentationStyle?.PAGE_SHEET || 'pageSheet',
      createTask: false,
    });
  } catch {
    try { await Linking.openURL(u); } catch {}
  }
}

export const NATIVE_WEBVIEW_PROPS = {
  decelerationRate: 'normal',
  setSupportMultipleWindows: false,
  javaScriptCanOpenWindowsAutomatically: false,
  overScrollMode: 'never',
  textZoom: 100,
  allowsLinkPreview: false,
  setBuiltInZoomControls: false,
  setDisplayZoomControls: false,
  contentInsetAdjustmentBehavior: 'never',
  automaticallyAdjustContentInsets: false,
  pullToRefreshEnabled: false,
  allowsBackForwardNavigationGestures: true,
  mediaPlaybackRequiresUserAction: false,
  allowsInlineMediaPlayback: true,
};

export function nativeFeelCss(colors, isDark, { selectable = true, background = true, colorScheme = true } = {}) {
  const bg = colors?.background || (isDark ? '#000000' : '#ffffff');
  return [
    colorScheme ? `:root{color-scheme:${isDark ? 'dark' : 'light'};}` : '',
    `html,body{-webkit-text-size-adjust:100%;text-size-adjust:100%;overscroll-behavior:none;}`,
    `html,body{font-family:-apple-system,BlinkMacSystemFont,system-ui,Roboto,"Segoe UI",sans-serif;}`,
    background ? `body{background:${bg};}` : '',
    `*{-webkit-tap-highlight-color:transparent;}`,
    `a,button,img{-webkit-touch-callout:none;}`,
    `button,[role=button],a{touch-action:manipulation;}`,
    selectable ? '' : `body{-webkit-user-select:none;user-select:none;}input,textarea,[contenteditable]{-webkit-user-select:text;user-select:text;}`,
  ].join('');
}

// Injected before content load: locks the viewport (no pinch / double-tap
// zoom), adds the CSS above as early as possible, and reports title + theme.
export function nativeFeelInjectedJS(colors, isDark, extraCss = '', opts = {}) {
  const css = JSON.stringify(nativeFeelCss(colors, isDark, opts) + (extraCss || ''));
  return `(function(){try{
    var css=${css};
    function apply(){
      try{
        var m=document.querySelector('meta[name=viewport]');
        if(!m){m=document.createElement('meta');m.name='viewport';(document.head||document.documentElement).appendChild(m);}
        m.setAttribute('content','width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover');
        if(!document.getElementById('__chatyy_native_css')){
          var s=document.createElement('style');s.id='__chatyy_native_css';s.textContent=css;
          (document.head||document.documentElement).appendChild(s);
        }
        try{document.documentElement.setAttribute('data-theme','${isDark ? 'dark' : 'light'}');document.documentElement.setAttribute('data-native-app','1');}catch(e){}
      }catch(e){}
    }
    apply();
    document.addEventListener('DOMContentLoaded',function(){
      apply();
      try{window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'__title',title:document.title||''}));}catch(e){}
    });
  }catch(e){}})();true;`;
}
