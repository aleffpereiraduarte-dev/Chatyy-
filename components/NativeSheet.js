// [2026-10-09 native-sheets] Sheet NATIVO do sistema p/ o que antes era
// <Modal transparent> + backdrop + "alça" desenhada em JS.
//
// iOS: UISheetPresentationController (detents, grabber, arrastar do sistema,
// fundo escurecido nativo). Android: BottomSheetBehavior do react-native-screens.
// Tudo JS (OTA): usa a apresentação 'formSheet' do react-native-screens 4.23,
// que JÁ está no binário 2.6.0 — só que formSheet exige ser uma ROTA. Este
// componente faz a ponte: quando `visible` vira true ele registra o conteúdo
// num store e empurra a rota /native-sheet (app/native-sheet.js), que renderiza
// os MESMOS children (re-render a cada render do dono → estado/dados vivos).
//
//  - Fechar pelo dono (visible=false / unmount) → a rota se remove pela própria
//    key (POP com source → nunca tira outra tela do stack).
//  - Fechar pelo gesto/back do sistema → a rota desmonta e chama onClose.
//  - Web (e kill-switch globalThis.__chatyy_native_sheets === false): o
//    componente dono continua renderizando o <Modal> original (ver uso).
//
// Uso (mantém o Modal original como fallback):
//   if (USE_NATIVE_SHEETS) return <NativeSheet visible={v} onClose={c} detents="fitToContents">{body}</NativeSheet>;
//   return <Modal ...>{...}{body}</Modal>;
//
// Regras p/ o conteúdo (body):
//  - sem backdrop, sem alça, sem borderRadius de topo, sem position absolute
//    no fundo: o sistema desenha tudo isso.
//  - detents 'fitToContents' → body SEM flex:1 (altura vem do conteúdo;
//    ScrollView interno com maxHeight). Detents numéricos ([0.5, 1]) → body
//    pode usar flex:1.
//  - contextos: o body é renderizado sob a rota do sheet (fora da árvore do
//    dono). Providers globais (tema, idioma, auth, safe-area) existem; um
//    Provider LOCAL da tela dona não alcança o sheet.
//  - navegar a partir do sheet: feche (onClose) antes/junto do router.push —
//    o card novo entra atrás e o sheet desce revelando-o.
import React, { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';

const _entries = new Map(); // id -> { content, detents, backgroundColor, initialDetent, onDismiss, close, closeRequested }
const _listeners = new Map(); // id -> Set<fn>
let _seq = 0;
let _lastCloseAt = 0;
const SHEET_DISMISS_MS = 480; // animação de saída do sheet do sistema (~0.35 s) + folga

// Abrir um <Modal> RN / outra apresentação DEPOIS que um sheet nativo saiu.
// O <Modal> do RN apresenta a partir do VC da tela dona; enquanto o sheet está
// na tela (ou descendo) o UIKit ignora a apresentação ("already presenting").
// Use em handlers que fecham o sheet e em seguida abrem um Modal irmão.
export function runAfterNativeSheet(fn) {
  if (typeof fn !== 'function') return;
  const open = _entries.size > 0;
  const since = Date.now() - _lastCloseAt;
  if (!nativeSheetsEnabled() || (!open && since >= SHEET_DISMISS_MS)) { fn(); return; }
  setTimeout(fn, open ? SHEET_DISMISS_MS : Math.max(0, SHEET_DISMISS_MS - since));
}

export function nativeSheetsEnabled() {
  if (Platform.OS === 'web') return false;
  try { if (globalThis.__chatyy_native_sheets === false) return false; } catch {}
  return true;
}
// Lido no render do componente dono (constante por sessão; kill-switch vale no próximo boot/OTA).
export const USE_NATIVE_SHEETS = nativeSheetsEnabled();

function _notify(id) {
  const ls = _listeners.get(id);
  if (ls) ls.forEach((fn) => { try { fn(); } catch {} });
}

// Respiro inferior do conteúdo DENTRO do sheet nativo. iOS: o sheet do sistema
// já desconta o home indicator (fitToContents soma o inset) → só o extra.
// Android: edge-to-edge, o BottomSheet vai até a borda → soma a barra de navegação.
export function nativeSheetBottomPad(insets, extra = 12) {
  if (Platform.OS === 'ios') return extra;
  return Math.max(0, (insets && insets.bottom) || 0) + extra;
}

export function getNativeSheetEntry(id) {
  return _entries.get(String(id || '')) || null;
}

export function subscribeNativeSheet(id, fn) {
  const k = String(id || '');
  let s = _listeners.get(k);
  if (!s) { s = new Set(); _listeners.set(k, s); }
  s.add(fn);
  return () => { s.delete(fn); if (!s.size) _listeners.delete(k); };
}

// Chamado pela rota quando ela monta: registra como fechar a si mesma.
// Retorna false se o dono já pediu p/ fechar antes da rota montar.
export function attachNativeSheetRoute(id, close) {
  const e = _entries.get(String(id || ''));
  if (!e || e.closeRequested) return false;
  e.close = close;
  return true;
}

// Chamado pela rota ao desmontar (gesto, back do Android, ou pop pelo dono).
export function detachNativeSheetRoute(id) {
  const k = String(id || '');
  const e = _entries.get(k);
  if (!e) return;
  _entries.delete(k);
  _listeners.delete(k);
  _lastCloseAt = Date.now();
  if (!e.closeRequested && typeof e.onDismiss === 'function') {
    try { e.onDismiss(); } catch {}
  }
}

// Opções da rota (app/_layout.js: <Stack.Screen name="native-sheet" options={nativeSheetScreenOptions} />).
export function nativeSheetScreenOptions({ route } = {}) {
  const e = getNativeSheetEntry(route?.params?.id);
  const detents = e?.detents || 'fitToContents';
  const opts = {
    headerShown: false,
    presentation: 'formSheet',
    gestureEnabled: true,
    sheetAllowedDetents: detents,
    sheetGrabberVisible: true,
    sheetCornerRadius: 20,
    sheetExpandsWhenScrolledToEdge: e?.expandsOnScroll !== false,
    sheetInitialDetentIndex: Array.isArray(detents) ? Math.max(0, Math.min(detents.length - 1, e?.initialDetent || 0)) : 0,
    animation: 'default',
  };
  if (e?.backgroundColor) opts.contentStyle = { backgroundColor: e.backgroundColor };
  return opts;
}

export function NativeSheet({
  visible,
  onClose,
  children,
  detents = 'fitToContents',
  initialDetent = 0,
  backgroundColor,
  expandsOnScroll = true,
}) {
  const idRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const bgRef = useRef(backgroundColor);
  bgRef.current = backgroundColor;

  useEffect(() => {
    if (!visible) return undefined;
    const id = 'sh' + (++_seq) + Date.now().toString(36);
    idRef.current = id;
    _entries.set(id, {
      content: childrenRef.current,
      detents,
      initialDetent,
      expandsOnScroll,
      backgroundColor: bgRef.current,
      closeRequested: false,
      close: null,
      onDismiss: () => {
        if (idRef.current === id) idRef.current = null;
        try { onCloseRef.current && onCloseRef.current(); } catch {}
      },
    });
    try {
      router.push({ pathname: '/native-sheet', params: { id } });
    } catch {
      // Sem navegador (não deveria acontecer) → fecha p/ não travar o estado do dono.
      _entries.delete(id);
      idRef.current = null;
      setTimeout(() => { try { onCloseRef.current && onCloseRef.current(); } catch {} }, 0);
    }
    return () => {
      if (idRef.current === id) idRef.current = null;
      const e = _entries.get(id);
      if (!e) return; // a rota já saiu (gesto) e já avisou o dono
      e.closeRequested = true;
      _lastCloseAt = Date.now();
      if (typeof e.close === 'function') { try { e.close(); } catch {} }
      // Se a rota ainda não montou, ela vê closeRequested e se remove ao montar.
    };
    // detents/initialDetent: só valem na apresentação (o sistema não troca no meio).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!visible]);

  // Conteúdo sempre fresco: cada render do dono republica os children.
  useEffect(() => {
    const id = idRef.current;
    if (!id) return;
    const e = _entries.get(id);
    if (!e) return;
    if (e.content !== children || e.backgroundColor !== backgroundColor) {
      e.content = children;
      e.backgroundColor = backgroundColor;
      _notify(id);
    }
  });

  return null;
}

export default NativeSheet;
