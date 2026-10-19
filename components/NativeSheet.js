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
import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, LayoutAnimation, Modal, Platform, View } from 'react-native';
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

// [2026-10-16 wave7] Altura limitada ao detent no formSheet iOS (app/native-sheet.js):
// desarma a "caça ao ScrollView" do react-native-screens 4.23 que esticava a
// lista p/ o sheet inteiro. Ligado por padrão no binário da wave 7+ (marcador:
// composer nativo apiVersion >= 2 — mesmo binário em que isto foi validado);
// globalThis.__chatyy_sheet_bounded = true/false força (OTA). Só iOS.
let _boundedBin = null;
export function nativeSheetBoundedOn() {
  if (Platform.OS !== 'ios') return false;
  try {
    const g = globalThis.__chatyy_sheet_bounded;
    if (g === true) return true;
    if (g === false) return false;
  } catch {}
  // [2026-10-16 hotfix] build 697: folha "bounded" cortava o conteúdo no meio (painel Apps) → opt-in.
  // [2026-10-19 sheet-layout] LIGADO de novo p/ detents numéricos: sem altura real
  // o conteúdo fica do tamanho natural (lista não rola) e a "caça ao ScrollView"
  // do rn-screens jogava a lista p/ (0,0)/fora da folha (Notificações em branco,
  // Estatísticas). Calibração agora só aceita medida coerente (nunca encolhe >40 pt).
  // Kill: globalThis.__chatyy_sheet_bounded = false. Painel Apps segue no modal próprio.
  if (_boundedBin == null) {
    try {
      const m = require('../modules/expo-chat-composer');
      const f = m && (m.apiVersion || (m.default && m.default.apiVersion));
      _boundedBin = typeof f !== 'function' || Number(f()) >= 2;
    } catch { _boundedBin = true; }
  }
  return _boundedBin;
}

// [2026-10-19 sheet-layout] iOS: a rota embrulha TODO conteúdo num container
// não-achatável cujo 1º filho é vazio → o react-native-screens 4.23 não acha
// ScrollView nenhum (nem filho direto do wrapper/SafeArea, nem pela cadeia de
// 1º filhos) e não força frame = folha em (0,0). Era isso que punha o cabeçalho
// por cima da 1ª opção (Exportar conversa), o título sobre o texto e o texto
// atrás da alça (Privacidade avançada) e a lista fora da tela (Notificações).
// Kill: globalThis.__chatyy_sheet_hunt_stop = false (conteúdo cru, como antes).
export function nativeSheetHuntStopOn() {
  if (Platform.OS !== 'ios') return false;
  try { if (globalThis.__chatyy_sheet_hunt_stop === false) return false; } catch {}
  return true;
}

// [2026-10-17 p2] quantas folhas nativas estão abertas/abrindo agora (hosts
// globais esperam 0 antes de abrir a sua — nunca folha sobre folha).
export function nativeSheetsOpenCount() {
  let n = 0;
  _entries.forEach((e) => { if (e && !e.closeRequested) n += 1; });
  return n;
}
export function nativeSheetRecentlyClosed(ms = 600) { return Date.now() - _lastCloseAt < ms; }

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
    sheetCornerRadius: 24, // [2026-10-15 native-sheets-v2] cantos 24 (Telegram/WhatsApp)
    sheetExpandsWhenScrolledToEdge: e?.expandsOnScroll !== false,
    sheetInitialDetentIndex: Array.isArray(detents) ? Math.max(0, Math.min(detents.length - 1, e?.initialDetent || 0)) : 0,
    animation: 'default',
  };
  // [2026-10-15 native-sheets-v2] Fundo SEM escurecer até o detent indicado
  // (ex.: figurinhas/local no meio → a conversa continua visível e viva).
  if (e && e.undimmedDetent != null) opts.sheetLargestUndimmedDetentIndex = e.undimmedDetent;
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
  undimmedDetent,
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
      undimmedDetent,
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

// ─────────────────────────────────────────────────────────────────────────────
// [2026-10-15 native-sheets-v2] Peças p/ migrar <Modal> → sheet do sistema.

// Abrir um sheet nativo vindo de um <Modal> RN (menu de contexto JS, visualizador
// de mídia, outro diálogo): no iOS o UIKit não apresenta enquanto o Modal ainda
// está descendo. Fora do iOS / kill-switch → imediato.
export const RN_MODAL_DISMISS_MS = 380;
export function afterRNModal(fn, fromModal = true) {
  if (typeof fn !== 'function') return;
  if (fromModal && nativeSheetsEnabled() && Platform.OS === 'ios') setTimeout(fn, RN_MODAL_DISMISS_MS);
  else fn();
}

// Troca drop-in de <Modal>: mesmas props do Modal (visible/onRequestClose/
// transparent/animationType...) + config do sheet. Nativo → <NativeSheet> com
// `nativeContent` (ou os mesmos children); web/kill-switch → o <Modal> original
// intacto. onClose do gesto/back do sistema = onDismiss ?? onRequestClose.
export function NativeSheetModal({
  visible,
  onRequestClose,
  onDismiss,
  detents = 'fitToContents',
  initialDetent = 0,
  backgroundColor,
  expandsOnScroll = true,
  undimmedDetent,
  nativeContent,
  disableNative = false,
  children,
  ...modalProps
}) {
  if (USE_NATIVE_SHEETS && !disableNative) {
    return (
      <NativeSheet
        visible={!!visible}
        onClose={onDismiss || onRequestClose}
        detents={detents}
        initialDetent={initialDetent}
        backgroundColor={backgroundColor}
        expandsOnScroll={expandsOnScroll}
        undimmedDetent={undimmedDetent}
      >
        {typeof nativeContent === 'function' ? nativeContent() : (nativeContent || children)}
      </NativeSheet>
    );
  }
  return <Modal visible={!!visible} onRequestClose={onRequestClose} {...modalProps}>{children}</Modal>;
}

// Teclado DENTRO do sheet nativo, sem pulo:
//  - sheet abaixo do topo (detent médio / fitToContents): o PRÓPRIO sistema
//    sobe o sheet junto com o teclado (UISheetPresentationController / Bottom
//    Sheet do rn-screens) → aqui não faz nada (só corrige resto no didShow).
//  - sheet no detent grande (topo colado em cima): o sistema não tem p/ onde
//    subir e o teclado cobre o rodapé → um espaçador cresce com a MESMA curva/
//    duração do teclado (iOS keyboardWillChangeFrame + LayoutAnimation 'keyboard').
// A conta usa measureInWindow (KeyboardAvoidingView do RN mede relativo ao pai
// e erra dentro de sheet). Idempotente: overlap = fundo do container − topo do
// teclado; o espaçador fica DENTRO do container, então não muda a medida.
// Use como raiz do conteúdo (flex:1) em sheets com TextInput.
const _LARGE_TOP_MAX = 110; // topo do sheet acima disso ⇒ está no detent grande
const _SHEET_HUNT_STOP = { height: 0, width: 0 };
// `absorb`: padding inferior que o conteúdo JÁ tem (ex.: home indicator) e que o
// teclado pode cobrir sem esconder nada → descontado do espaçador.
export function NativeSheetKeyboardView({ style, children, enabled = true, extraPad = 0, absorb = 0 }) {
  const ref = useRef(null);
  const [pad, setPad] = useState(0);
  const padRef = useRef(0);
  useEffect(() => {
    if (!enabled || Platform.OS === 'web') return undefined;
    let alive = true;
    const apply = (next, duration) => {
      const v = Math.max(0, Math.round(next));
      if (!alive || Math.abs(v - padRef.current) < 2) return;
      try {
        if (Platform.OS === 'ios') {
          LayoutAnimation.configureNext({
            duration: Math.max(120, duration || 250),
            update: { type: LayoutAnimation.Types.keyboard },
            create: { type: LayoutAnimation.Types.keyboard, property: LayoutAnimation.Properties.opacity },
          });
        } else {
          LayoutAnimation.configureNext(LayoutAnimation.create(160, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
        }
      } catch {}
      padRef.current = v;
      setPad(v);
    };
    const measure = (e, onlyIfLarge) => {
      const kbY = e && e.endCoordinates ? e.endCoordinates.screenY : 0;
      const node = ref.current;
      if (!kbY || !node || typeof node.measureInWindow !== 'function') return;
      try {
        node.measureInWindow((x, y, w, h) => {
          if (!alive || !(h > 0)) return;
          if (onlyIfLarge && y > _LARGE_TOP_MAX) return; // o sistema vai subir o sheet
          const ov = y + h - kbY;
          apply(ov > 0 ? ov - absorb + extraPad : 0, e.duration);
        });
      } catch {}
    };
    const subs = [];
    const add = (ev, fn) => { try { subs.push(Keyboard.addListener(ev, fn)); } catch {} };
    if (Platform.OS === 'ios') {
      add('keyboardWillChangeFrame', (e) => measure(e, true));
      add('keyboardDidShow', (e) => measure(e, false));
      add('keyboardWillHide', (e) => apply(0, e && e.duration));
    } else {
      add('keyboardDidShow', (e) => measure(e, false));
      add('keyboardDidHide', () => apply(0, 160));
    }
    return () => { alive = false; subs.forEach((s) => { try { s.remove(); } catch {} }); };
  }, [enabled, extraPad, absorb]);
  return (
    <View ref={ref} style={[{ flex: 1 }, style]}>
      {/* [2026-10-17 sheet-blank] 1º filho vazio: desarma a "caça ao ScrollView" do
          react-native-screens 4.23 (formSheet c/ detents numéricos procura um
          ScrollView pela cadeia de 1º filhos e força o frame dele = frame do
          SHEET, origem incluída → lista jogada p/ fora da área visível = sheet
          em branco só com a alça: "Idioma do app", painel Apps). Com a lista
          como 2º filho ela fica no layout Yoga normal (flex:1) — o mesmo
          caminho que já funciona nos sheets com cabeçalho antes da lista. */}
      <View collapsable={false} pointerEvents="none" style={_SHEET_HUNT_STOP} />
      {children}
      {pad > 0 ? <View style={{ height: pad }} /> : null}
    </View>
  );
}

export default NativeSheet;
