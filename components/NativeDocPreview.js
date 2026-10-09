// [2026-10-07 app-feel-webview] Native document (PDF / Office) preview.
//
// Before: Drive (FileViewer) and chat previews pointed a WebView at
// https://chatyy.com.br/preview.html — that file is NOT deployed in prod, so
// nginx's SPA fallback served the whole web app (index.html) INSIDE the native
// viewer: the "looks like a web page" bug in its purest form.
//
// Now, with no extra native code (OTA-safe):
//   - iOS PDF  → WKWebView loads the PDF as the document root = PDFKit-backed
//                native renderer (pinch zoom, native scroll, page indicator).
//   - Android PDF / any Office doc → Google Docs embedded viewer directly
//                (what preview.html used to iframe), no wrapper page.
//   - native loading spinner + native error state with "Abrir" (in-app
//     browser sheet) instead of WebView's white/blank error page.
//
// [2026-10-07 native-docs-mail] PDFs now render with a NATIVE viewer when the
// installed binary has it (expo-native-toolkit ExpoNativePdfView with onLoad):
//   - iOS     → PDFKit PDFView (download to Caches, file-backed document)
//   - Android → PdfRenderer pages in a RecyclerView (download to cacheDir)
// so attachment URLs (which carry the auth token) are no longer handed to
// docs.google.com on Android. [2026-10-09 native-docs] Google viewer REMOVED
// entirely: Office docs (and PDFs on binaries without the native view) go
// through LocalDocPreview (download + WKWebView-local on iOS / "Abrir com…"
// on Android, utils/openDocument.js).
import { useState, useMemo, useEffect } from 'react';
import { View, Text, ActivityIndicator, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { openInApp } from '../utils/inAppBrowser';
import { useLanguage } from '../context/LanguageContext';
import { ensureLocalDocument, openDocumentWithSystem, docExt, docMime, iosWebViewCanRender } from '../utils/openDocument';

const BASE = 'https://chatyy.com.br';

export function absoluteFileUrl(url) {
  if (!url) return '';
  const u = String(url);
  if (/^(https?:|file:|content:)/i.test(u)) return u;
  return BASE + (u.charAt(0) === '/' ? u : '/' + u);
}

// [2026-10-09 native-docs] No third-party viewer anymore (the attachment URL —
// Drive's carries the auth token — used to be handed to docs.google.com).
// PDFs load directly (browser / WKWebView render them natively); everything
// else returns null and goes through LocalDocPreview (download + on-device).
export function docPreviewSource(url, filename, kind) {
  const abs = absoluteFileUrl(url);
  const ext = String(filename || '').split('.').pop().toLowerCase();
  const isPdf = kind === 'pdf' || ext === 'pdf' || /\.pdf(\?|#|$)/i.test(abs);
  if (isPdf) return { uri: abs };
  return null;
}

export function isPdfDoc(url, filename, kind) {
  const abs = absoluteFileUrl(url);
  const ext = String(filename || '').split('.').pop().toLowerCase();
  return kind === 'pdf' || ext === 'pdf' || /\.pdf(\?|#|$)/i.test(abs);
}

// Native PDF view of the installed binary, or null (old binary / web).
// Lazy: only evaluated when a PDF preview actually renders.
function nativePdfView() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    const { nativeViewHas } = require('../modules/expo-native-toolkit/src/viewCaps');
    if (!nativeViewHas('ExpoNativePdfView', { props: ['uri'], events: ['onLoad', 'onError'] })) return null;
    return require('../modules/expo-native-toolkit/src/PdfView').default || null;
  } catch { return null; }
}

function NativePdfPreview({ PdfView, url, headers, bg, fg, dark, openLabel, errorLabel }) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState({ page: 0, count: 0 });
  const abs = absoluteFileUrl(url);

  if (failed) {
    return (
      <View style={[st.center, { backgroundColor: bg }]}>
        <Text style={[st.err, { color: fg }]}>{errorLabel}</Text>
        <TouchableOpacity style={st.btn} onPress={() => openInApp(abs)} accessibilityRole="button">
          <Text style={st.btnText}>{openLabel}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <PdfView
        style={{ flex: 1, backgroundColor: bg }}
        uri={abs}
        headers={headers || undefined}
        onLoad={(e) => {
          setLoading(false);
          const n = e?.nativeEvent?.pageCount || 0;
          setPage((p) => ({ page: p.page, count: n }));
        }}
        onError={() => { setLoading(false); setFailed(true); }}
        onPageChange={(e) => {
          const ne = e?.nativeEvent || {};
          setPage({ page: ne.page || 0, count: ne.pageCount || 0 });
        }}
      />
      {!loading && page.count > 1 && (
        <View pointerEvents="none" style={st.pageBadge}>
          <Text style={st.pageBadgeText}>{(page.page + 1) + ' / ' + page.count}</Text>
        </View>
      )}
      {loading && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, st.center, { backgroundColor: bg }]}>
          <ActivityIndicator size="large" color={dark ? '#fff' : '#666'} />
        </View>
      )}
    </View>
  );
}

// True when the installed binary renders PDFs natively (PDFKit / PdfRenderer).
export function hasNativePdfView() {
  return !!nativePdfView();
}

export default function NativeDocPreview({ url, filename, kind, headers, dark = true, openLabel = 'Abrir', errorLabel = 'Não foi possível abrir a pré-visualização' }) {
  const isPdf = isPdfDoc(url, filename, kind);
  const PdfView = useMemo(() => (isPdf ? nativePdfView() : null), [isPdf]);
  const bg0 = dark ? '#1a1a1a' : '#ffffff';
  const fg0 = dark ? 'rgba(255,255,255,0.75)' : '#444';
  if (PdfView && url) {
    return <NativePdfPreview key={String(url)} PdfView={PdfView} url={url} headers={headers} bg={bg0} fg={fg0} dark={dark} openLabel={openLabel} errorLabel={errorLabel} />;
  }
  if (Platform.OS === 'web' && isPdf) {
    return <WebDocPreview url={url} filename={filename} kind={kind} dark={dark} openLabel={openLabel} errorLabel={errorLabel} />;
  }
  return <LocalDocPreview key={String(url)} url={url} filename={filename} headers={headers} dark={dark} errorLabel={errorLabel} />;
}

// [2026-10-09 native-docs] Office / iWork / RTF / CSV (and PDF on binaries
// without ExpoNativePdfView): download to the cache, then
//   - iOS: WKWebView renders the LOCAL file natively (QuickLook engine) —
//     works on the current binary, offline after the first open.
//   - Android / other: card with "Abrir com…" → ExpoChatyyDocPreview
//     (ACTION_VIEW, next binary) or the share sheet (current binary).
// No URL ever leaves the device.
function LocalDocPreview({ url, filename, headers, dark, errorLabel }) {
  const { t } = useLanguage();
  const [local, setLocal] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const bg = dark ? '#1a1a1a' : '#ffffff';
  const fg = dark ? 'rgba(255,255,255,0.75)' : '#444';
  const fgStrong = dark ? '#fff' : '#111';
  const ext = docExt(filename, url);
  const inline = Platform.OS === 'ios' && iosWebViewCanRender(filename, url);
  const btnStyle = [st.btnMono, { backgroundColor: dark ? '#ffffff' : '#111111' }];
  const btnTextStyle = [st.btnMonoText, { color: dark ? '#111111' : '#ffffff' }];
  const btnSpin = dark ? '#111111' : '#ffffff';

  useEffect(() => {
    if (!url || Platform.OS === 'web') return undefined;
    let alive = true;
    setFailed(false);
    setLocal(null);
    ensureLocalDocument(absoluteFileUrl(url), filename, headers)
      .then((u) => { if (alive) setLocal(u); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, filename, attempt]);

  const openWith = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await openDocumentWithSystem({ url: local || absoluteFileUrl(url), filename, headers, mimeType: docMime(filename, url) });
      if (!r) setFailed(true);
    } finally { setBusy(false); }
  };

  let WebView = null;
  if (inline && local) { try { WebView = require('react-native-webview').WebView; } catch {} }

  if (WebView && local && !failed) {
    const dir = local.slice(0, local.lastIndexOf('/') + 1);
    return (
      <View style={{ flex: 1, backgroundColor: bg }}>
        <WebView
          source={{ uri: local }}
          style={{ flex: 1, backgroundColor: bg }}
          originWhitelist={['file://*', 'about:*']}
          allowingReadAccessToURL={dir}
          allowFileAccess
          javaScriptEnabled={false}
          decelerationRate="normal"
          allowsLinkPreview={false}
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          onError={() => setFailed(true)}
          onShouldStartLoadWithRequest={(req) => {
            if (!req.isTopFrame || /^(file|about):/i.test(req.url)) return true;
            if (/^https?:/i.test(req.url)) openInApp(req.url);
            return false;
          }}
        />
        <TouchableOpacity style={st.openWithPill} onPress={openWith} disabled={busy} accessibilityRole="button" accessibilityLabel={t('doc.openWith')}>
          {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={st.openWithPillText}>{t('doc.openWith')}</Text>}
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[st.center, { backgroundColor: bg }]}>
      <View style={[st.extBadge, { borderColor: dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)' }]}>
        <Text style={[st.extBadgeText, { color: fgStrong }]}>{(ext || 'doc').toUpperCase().slice(0, 5)}</Text>
      </View>
      {!!filename && <Text style={[st.docName, { color: fgStrong }]} numberOfLines={2}>{filename}</Text>}
      {failed ? (
        <>
          <Text style={[st.err, { color: fg }]}>{errorLabel || t('doc.openFailed')}</Text>
          <TouchableOpacity style={btnStyle} onPress={() => setAttempt((n) => n + 1)} accessibilityRole="button">
            <Text style={btnTextStyle}>{t('common.retry')}</Text>
          </TouchableOpacity>
        </>
      ) : !local ? (
        <View style={{ alignItems: 'center' }}>
          <ActivityIndicator size="large" color={dark ? '#fff' : '#666'} />
          <Text style={[st.hint, { color: fg }]}>{t('doc.preparing')}</Text>
        </View>
      ) : (
        <TouchableOpacity style={btnStyle} onPress={openWith} disabled={busy} accessibilityRole="button">
          {busy ? <ActivityIndicator size="small" color={btnSpin} /> : <Text style={btnTextStyle}>{t('doc.openWith')}</Text>}
        </TouchableOpacity>
      )}
    </View>
  );
}

function WebDocPreview({ url, filename, kind, dark, openLabel, errorLabel }) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const source = useMemo(() => docPreviewSource(url, filename, kind), [url, filename, kind]);
  let WebView = null;
  try { WebView = require('react-native-webview').WebView; } catch {}
  const bg = dark ? '#1a1a1a' : '#ffffff';
  const fg = dark ? 'rgba(255,255,255,0.75)' : '#444';

  if (!WebView || failed) {
    return (
      <View style={[st.center, { backgroundColor: bg }]}>
        <Text style={[st.err, { color: fg }]}>{errorLabel}</Text>
        <TouchableOpacity style={st.btn} onPress={() => openInApp(absoluteFileUrl(url))} accessibilityRole="button">
          <Text style={st.btnText}>{openLabel}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <WebView
        source={source}
        style={{ flex: 1, backgroundColor: bg }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        decelerationRate="normal"
        overScrollMode="never"
        textZoom={100}
        setSupportMultipleWindows={false}
        allowsLinkPreview={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        mixedContentMode="always"
        onLoadEnd={() => setLoading(false)}
        onError={() => { setLoading(false); setFailed(true); }}
        onHttpError={(e) => { if ((e?.nativeEvent?.statusCode || 0) >= 400) { setLoading(false); setFailed(true); } }}
        onShouldStartLoadWithRequest={(req) => {
          // Keep the viewer on the document; anything the user taps inside
          // (links in a PDF, "open in Drive" in the gview chrome) goes to the
          // in-app browser sheet instead of navigating this view away.
          if (req.url === source.uri || req.url === 'about:blank' || !req.isTopFrame) return true;
          if (/^https:\/\/docs\.google\.com\/viewer/i.test(req.url)) return true;
          if (Platform.OS === 'ios' && req.url.split('#')[0] === source.uri.split('#')[0]) return true;
          if (/^https?:/i.test(req.url)) openInApp(req.url);
          return false;
        }}
      />
      {loading && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, st.center, { backgroundColor: bg }]}>
          <ActivityIndicator size="large" color={dark ? '#fff' : '#666'} />
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  err: { fontSize: 15, textAlign: 'center', marginBottom: 16 },
  btn: { paddingHorizontal: 22, paddingVertical: 10, borderRadius: 10, backgroundColor: '#7c3aed' },
  btnMono: { paddingHorizontal: 22, paddingVertical: 11, borderRadius: 10, minWidth: 140, alignItems: 'center' },
  btnMonoText: { fontWeight: '600', fontSize: 15 },
  extBadge: { width: 72, height: 88, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  extBadgeText: { fontSize: 15, fontWeight: '700', letterSpacing: 0.5 },
  docName: { fontSize: 15, fontWeight: '600', textAlign: 'center', marginBottom: 18, maxWidth: 300 },
  hint: { fontSize: 13, marginTop: 10, textAlign: 'center' },
  openWithPill: { position: 'absolute', right: 16, bottom: 24, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.75)', minWidth: 96, alignItems: 'center' },
  openWithPillText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  pageBadge: { position: 'absolute', top: 12, alignSelf: 'center', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.55)' },
  pageBadgeText: { color: '#fff', fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
