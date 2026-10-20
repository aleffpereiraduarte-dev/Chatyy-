// components/chat/NativeComposerBridge.js — [2026-10-14 native-composer]
//
// Ponte entre o composer JS da conversa (app/chat-conversation.js) e a view
// NATIVA `ChatyyComposer` (modules/expo-chat-composer). O nativo só captura e
// entrega (texto, seleção, colar imagem, toques, envio, áudio gravado); TODA a
// lógica de envio / fila / rascunho / menções / digitando continua nas mesmas
// funções JS de antes, recebidas aqui como callbacks.
//
// Uso (só no componente do composer):
//   if (shouldUseNativeComposer()) → <NativeComposerBridge … fallback={jsBar} />
//   senão → jsBar() (composer JS atual, idêntico ao binário antigo).
//
// Segurança:
//   • Binário sem o módulo / web / Expo Go → shouldUseNativeComposer() = false.
//   • Kill switch OTA/console: globalThis.__chatyy_native_composer = false.
//   • Erro de render no nativo → ErrorBoundary troca para o composer JS (e o
//     resto da sessão segue no JS).
//
// O `ref` expõe a mesma API do TextInput que a tela usa no inputRef: focus,
// blur, isFocused, setSelection, clear, setNativeProps({ selection, text }).

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Platform, processColor } from 'react-native';
import { kbResumeGuardOn } from '../../utils/kbResumeGuard';
import { threadKbNoteComposerBlur, threadKbNoteComposerFocus, threadKbAttachFreezeOn, composerNativeDockOn } from '../../utils/threadKeyboard'; // [2026-10-19 kb-heal] · [2026-10-19 attach-hold]
import { kbNativeTransitionsOn, reportKeyboardSync, attachInstantOn, attachRestoreMode, kbRestoreGuardOn, nativeComposerApi, androidAttachInstantOn, attachLegacyNoneActive, attachHoldOn, attachOverKeyboardOn, attachInputPanelOn, androidAttachPanelOn, attachInWindowOn } from '../../utils/kbNativeTransitions'; // [2026-10-19 kb-native] · [2026-10-19 attach-instant]

let _failed = false;

function _nativeModule() {
  if (Platform.OS === 'web') return null;
  try {
    return require('../../modules/expo-chat-composer');
  } catch {
    return null;
  }
}

/** true quando o binário instalado tem o composer nativo e ele não foi desligado. */
export function shouldUseNativeComposer() {
  if (Platform.OS === 'web' || _failed) return false;
  try { if (globalThis.__chatyy_native_composer === false) return false; } catch {}
  const m = _nativeModule();
  try { return !!(m && m.isAvailable && m.isAvailable()); } catch { return false; }
}

// [2026-10-16 motion-composer] Movimento nativo do compositor (campo crescendo
// com mola, halo da gravação suavizado + anel externo, seta "deslize p/
// cancelar" cutucando). Kill switch OTA: globalThis.__chatyy_motion_composer =
// false (ou __chatyy_motion = false) → prop motion=false = movimento antigo.
// Ligado = prop omitida (binários antigos não recebem nada novo).
function _motionOff() {
  try { if (globalThis.__chatyy_motion_composer === false) return true; } catch {}
  try { if (globalThis.__chatyy_motion === false) return true; } catch {}
  return false;
}

// [2026-10-19 attach-instant] iOS (apiVersion >= 5): props só quando fogem do
// padrão nativo (attachInstant=true). [2026-10-19 kb-restore] attachRestore vai
// SEMPRE explícito: binários api 5 (build 734) nasceram com padrão 'will'
// (sobe-desce-sobe ao cancelar o "+"); o JS agora manda 'did' por OTA.
// restoreGuard só vai quando desligado (api >= 6 nasce ligado).
function _attachInstantProps() {
  const o = {};
  const api = nativeComposerApi();
  if (!attachInstantOn()) o.attachInstant = false;
  // [2026-10-19 attach-hold] api 5/6: 'none' = sem devolução nativa do foco
  // (attachInstant=false); a conversa abre a folha na hora mesmo assim.
  else if (attachLegacyNoneActive()) o.attachInstant = false;
  else {
    o.attachRestore = attachRestoreMode();
    if (api >= 8 && attachHoldOn()) o.attachDeferResign = true; // [2026-10-19 attach-hold]
    // [2026-10-19 attach-over-kb] api 9 + folha api 6: teclado fica sob a folha.
    // [2026-10-20 attach-freeze] api >= 9 também segura o teclado/painel até a
    // folha ser apresentada (o JS congela a conversa antes) — vale no 744.
    // [2026-10-20 kb-glued] só segura o painel quando a folha entra NA janela
    // dele (api 12/8, nada se mexe) ou por opt-in; senão o painel/teclado desce
    // animado e o composer desce grudado (sem stash instantâneo do present).
    if (attachOverKeyboardOn() || attachInWindowOn() || (api >= 9 && threadKbAttachFreezeOn())) o.attachKeepKeyboard = true;
    // [2026-10-20 attach-inputview] api 10: painel no lugar do teclado.
    if (attachInputPanelOn()) o.attachPanel = true;
  }
  if (!kbRestoreGuardOn() && api >= 6) o.restoreGuard = false;
  return o;
}
// [2026-10-19 android-parity] Android: props só quando desligadas (api 5 =
// attachInstant, api 6 = restoreGuard; binário antigo ignora prop desconhecida).
function _androidAttachProps() {
  const api = nativeComposerApi();
  const o = {};
  if (api >= 5 && !androidAttachInstantOn()) o.attachInstant = false;
  if (api >= 6 && !kbRestoreGuardOn()) o.restoreGuard = false;
  if (androidAttachPanelOn()) o.attachPanel = true; // [2026-10-20 attach-inputview] api 7
  return o;
}

function _tr(t, key, fb, vars) {
  try {
    const v = t ? t(key, vars) : null;
    if (typeof v === 'string' && v && v !== key) return v;
  } catch {}
  return fb;
}

function _pc(c) {
  if (c == null) return null;
  try {
    const v = processColor(c);
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

/** Shape que handleSendAudio já espera do AudioRecorder JS. */
export function voicePayloadToAudioData(e) {
  const ms = Math.max(0, Number(e?.durationMs) || 0);
  const wf = Array.isArray(e?.waveform) ? e.waveform.map((v) => Math.max(0, Math.min(1, Number(v) || 0))) : [];
  return {
    uri: e?.uri,
    name: e?.name || `audio_${Date.now()}.m4a`,
    type: e?.mimeType || 'audio/mp4',
    duration: Math.max(1, Math.round(ms / 1000)),
    durationMs: ms,
    waveform: wf,
    viewOnce: false,
  };
}

class NativeComposerBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err) {
    _failed = true;
    try { console.warn('[native-composer] fallback to JS composer:', err?.message || err); } catch {}
    try { require('../../services/crashReporter').reportNativeFallback('native_composer', err); } catch {}
    try { this.props.onFatal?.(err); } catch {}
  }

  render() {
    if (this.state.failed) {
      try { return this.props.fallback ? this.props.fallback() : null; } catch { return null; }
    }
    return this.props.children;
  }
}

const NativeComposerInner = forwardRef(function NativeComposerInner(props, ref) {
  const {
    text = '',
    t,
    isDark,
    colors = {},
    placeholder,
    replyPreview = null,
    mentionCandidates,
    sendMenu,
    bottomInset = 0,
    sending = false,
    uploading = false,
    enterSends = false,
    autocorrect = true,
    maxLength = 5000,
    showVideoNote = false,
    showCamera = true,
    showEmoji = true,
    emojiActive = false,
    voiceBlocked = false,
    disabled = false,
    keyboardTracking = 'none',
    onChangeText,
    onSend,
    onAttach,
    onCamera,
    onEmoji,
    onVideoNote,
    onVoiceRecorded,
    onVoiceState,
    onSelectionChange,
    onFocus,
    onBlur,
    onPasteImage,
    onReplyCancel,
    onSendMenu,
    onHeightChange,
    onKeyboardFrame,
    attachPanelItems, // [2026-10-20 attach-inputview] [{key,label}]
    onAttachPanel, // [2026-10-20 attach-inputview] ({key, keep}) => void
    attachPanelOpen = false, // [2026-10-20 attach-inputview] Android: "+" vira teclado
  } = props;

  const NativeView = useMemo(() => {
    // [2026-10-19 core-chat] Android: gravação travada pausa ao ir p/ 2º plano (nativo).
    // Kill switch OTA: globalThis.__chatyy_voice_bg_pause = false (binário antigo ignora).
    if (globalThis.__chatyy_voice_bg_pause === false) {
      try { require('expo').requireOptionalNativeModule('ChatyyComposer')?.setVoiceBgPause?.(false); } catch {}
    }
    const m = _nativeModule();
    return m && m.getNativeComposerView ? m.getNativeComposerView() : null;
  }, []);
  if (!NativeView) throw new Error('ChatyyComposer view unavailable');

  const nativeRef = useRef(null);
  const lastNativeText = useRef(text);
  const focusedRef = useRef(false);
  const mountedText = useRef(text);
  const [height, setHeight] = useState(0);

  // JS mudou o texto por conta própria (envio limpou, menção inserida, rascunho
  // restaurado, edição, barra de formatação) → empurra para o nativo. Texto
  // que veio do próprio nativo não volta (sem eco / sem pular cursor).
  useEffect(() => {
    if (text === lastNativeText.current) return;
    lastNativeText.current = text;
    try { nativeRef.current?.setText?.(text)?.catch?.(() => {}); } catch {}
  }, [text]);

  useImperativeHandle(ref, () => ({
    focus: () => { try { nativeRef.current?.focus?.()?.catch?.(() => {}); } catch {} },
    blur: () => { try { nativeRef.current?.blur?.()?.catch?.(() => {}); } catch {} },
    // [2026-10-20 attach-freeze] iOS api >= 11: painel de anexos de volta SEM animação.
    showAttachPanel: () => {
      try {
        const f = nativeRef.current?.showAttachPanel;
        if (typeof f !== 'function') return false;
        f.call(nativeRef.current)?.catch?.(() => {});
        return true;
      } catch { return false; }
    },
    // [2026-10-20 attach-inputview] Android api 7: desce o IME sem tirar o foco.
    hideImeKeepFocus: () => {
      try {
        const f = nativeRef.current?.hideImeKeepFocus;
        if (typeof f !== 'function') return false;
        f.call(nativeRef.current)?.catch?.(() => {});
        return true;
      } catch { return false; }
    },
    // [2026-10-19 attach-hold] iOS api >= 8: solta o teclado adiado pelo "+".
    releaseForAttach: () => {
      try {
        const f = nativeRef.current?.releaseForAttach;
        if (typeof f !== 'function') return false;
        f.call(nativeRef.current)?.catch?.(() => {});
        return true;
      } catch { return false; }
    },
    isFocused: () => focusedRef.current,
    clear: () => {
      lastNativeText.current = '';
      try { nativeRef.current?.clear?.()?.catch?.(() => {}); } catch {}
    },
    setSelection: (start, end) => {
      try { nativeRef.current?.setSelection?.(Number(start) || 0, Number(end ?? start) || 0)?.catch?.(() => {}); } catch {}
    },
    setNativeProps: (p) => {
      if (!p) return;
      if (typeof p.text === 'string') {
        lastNativeText.current = p.text;
        try { nativeRef.current?.setText?.(p.text)?.catch?.(() => {}); } catch {}
      }
      if (p.selection && typeof p.selection.start === 'number') {
        const s = p.selection.start;
        const e = typeof p.selection.end === 'number' ? p.selection.end : s;
        try { nativeRef.current?.setSelection?.(s, e)?.catch?.(() => {}); } catch {}
      }
    },
    cancelVoice: () => { try { nativeRef.current?.cancelVoice?.()?.catch?.(() => {}); } catch {} },
  }), []);

  // Props "objeto" estáveis por conteúdo: o host do composer re-renderiza a
  // cada tecla; sem isso o Fabric reenviaria tema/labels/listas toda vez.
  const themeKey = JSON.stringify([isDark, colors?.text, colors?.textSecondary, colors?.primary, colors?.accentOn ? colors.accent : 0]);
  const theme = useMemo(() => {
    const chrome = isDark ? '#a1a1a6' : '#6e6e73';
    return {
      dark: !!isDark,
      surface: _pc(isDark ? '#0b0b0b' : '#ffffff'),
      pill: _pc(isDark ? '#1c1c1e' : '#ffffff'),
      pillBorder: _pc(isDark ? '#1c1c1e' : 'rgba(0,0,0,0.14)'),
      text: _pc(isDark ? '#e5e7eb' : '#111111'),
      secondaryText: _pc(colors?.textSecondary || chrome),
      placeholder: _pc(chrome),
      icon: _pc(chrome),
      iconActive: _pc(colors?.text || (isDark ? '#ffffff' : '#111111')),
      // [2026-10-19 accent-real] botão enviar/gravar na cor de destaque (Grafite = P&B)
      action: _pc(colors?.accentOn ? colors.accent : (isDark ? '#ffffff' : '#111111')),
      actionIcon: _pc(colors?.accentOn ? (colors.onAccent || '#ffffff') : (isDark ? '#111111' : '#ffffff')),
      hairline: _pc(isDark ? '#262628' : 'rgba(0,0,0,0.10)'),
      accent: _pc(colors?.primary || (isDark ? '#ffffff' : '#111111')),
      mention: _pc(isDark ? '#7cb7ff' : '#1e6fd9'),
      replyCard: _pc(isDark ? '#1c1c1e' : '#ffffff'),
      replyCardBorder: _pc(isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.10)'),
      recording: _pc('#ff3b30'),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeKey]);

  const labelsKey = t ? 'L' + (placeholder || '') : '';
  const labels = useMemo(() => ({
    attach: _tr(t, 'chatConv.attach', 'Anexar'),
    emoji: _tr(t, 'chatConv.stickers', 'Figurinhas'),
    camera: _tr(t, 'chatConv.camera', 'Câmera'),
    videoNote: _tr(t, 'videoNote.button', 'Vídeo'),
    cancel: _tr(t, 'common.cancel', 'Cancelar'),
    send: _tr(t, 'chatConv.send', 'Enviar'),
    sendVoice: _tr(t, 'chatConv.send', 'Enviar'),
    record: _tr(t, 'chatConv.recordAudio', 'Gravar áudio'),
    holdToRecord: _tr(t, 'chatConv.holdToRecordHint', 'Segure para gravar, solte para enviar'),
    sendMenuTitle: _tr(t, 'w12e.sendOptions', _tr(t, 'chat.schedule', '')), // [2026-10-16 w12e] menu = sem som + efeito + agendar
    slideToCancel: _tr(t, 'chatConv.slideToCancel', 'Deslize para cancelar'),
    deleteRecording: _tr(t, 'nativeComposer.deleteRecording', 'Apagar gravação'),
    cancelRecording: _tr(t, 'chatConv.cancelRecording', 'Cancelar gravação'),
    recording: _tr(t, 'nativeComposer.recording', 'Gravando áudio'),
    // [2026-10-18 voz-pausa] composer apiVersion >= 3 (binário antigo ignora)
    pauseRecording: _tr(t, 'nativeComposer.pauseRecording', 'Pausar gravação'),
    resumeRecording: _tr(t, 'nativeComposer.resumeRecording', 'Continuar gravação'),
    playPreview: _tr(t, 'nativeComposer.playPreview', 'Ouvir gravação'),
    pausePreview: _tr(t, 'nativeComposer.pausePreview', 'Pausar'),
    keyboard: _tr(t, 'chatConv.keyboard', 'Teclado'), // [2026-10-20 attach-inputview] "+" virou teclado
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [labelsKey, t]);

  const mentionsKey = JSON.stringify(mentionCandidates || []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mentions = useMemo(() => (Array.isArray(mentionCandidates) ? mentionCandidates : []), [mentionsKey]);
  const menuKey = JSON.stringify(sendMenu || []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const menu = useMemo(() => (Array.isArray(sendMenu) ? sendMenu : []), [menuKey]);
  const replyKey = replyPreview ? JSON.stringify(replyPreview) : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reply = useMemo(() => replyPreview || null, [replyKey]);

  // Callbacks sempre frescos (a tela recria closures a cada render) sem trocar
  // os handlers da view nativa.
  const cbRef = useRef(props);
  cbRef.current = props;

  const _onChangeText = useCallback((e) => {
    const v = String(e?.nativeEvent?.text ?? '');
    lastNativeText.current = v;
    try { cbRef.current.onChangeText?.(v); } catch {}
  }, []);
  const _onSend = useCallback((e) => {
    const v = String(e?.nativeEvent?.text ?? '');
    // Garante que o store tem o texto final antes do handleSend (debounce).
    if (v !== lastNativeText.current) {
      lastNativeText.current = v;
      try { cbRef.current.onChangeText?.(v); } catch {}
    }
    try { cbRef.current.onSend?.({ text: v, mentions: e?.nativeEvent?.mentions || [] }); } catch {}
  }, []);
  const _onHeight = useCallback((e) => {
    const h = Number(e?.nativeEvent?.height) || 0;
    if (h > 0) setHeight((prev) => (Math.abs(prev - h) < 0.5 ? prev : h));
    try { cbRef.current.onHeightChange?.(h); } catch {}
  }, []);
  const _onSelection = useCallback((e) => {
    const s = e?.nativeEvent || {};
    try { cbRef.current.onSelectionChange?.({ nativeEvent: { selection: { start: Number(s.start) || 0, end: Number(s.end) || 0 } } }); } catch {}
  }, []);
  const _onFocusChange = useCallback((e) => {
    const f = !!e?.nativeEvent?.focused;
    focusedRef.current = f;
    try { (f ? cbRef.current.onFocus : cbRef.current.onBlur)?.(); } catch {}
    if (!f) { try { threadKbNoteComposerBlur(); } catch {} } // [2026-10-19 kb-heal] sem foco + sem teclado ⇒ lift 0
    else { try { threadKbNoteComposerFocus(); } catch {} } // [2026-10-19 attach-hold] foco real solta a trava
  }, []);
  const _onVoiceRecorded = useCallback((e) => {
    const d = voicePayloadToAudioData(e?.nativeEvent || {});
    if (!d.uri) return;
    try { cbRef.current.onVoiceRecorded?.(d); } catch {}
  }, []);
  const _onVoiceState = useCallback((e) => {
    const s = e?.nativeEvent || {};
    try { cbRef.current.onVoiceState?.(String(s.state || ''), s.reason ? String(s.reason) : undefined); } catch {}
  }, []);
  const _onPasteImage = useCallback((e) => {
    const p = e?.nativeEvent || {};
    if (!p.uri) return;
    try {
      cbRef.current.onPasteImage?.({
        uri: p.uri,
        name: p.name || 'paste.jpg',
        type: p.mimeType || 'image/jpeg',
        mimeType: p.mimeType || 'image/jpeg',
        width: Number(p.width) || undefined,
        height: Number(p.height) || undefined,
        size: Number(p.size) || undefined,
      });
    } catch {}
  }, []);
  const _simple = (name) => () => { try { cbRef.current[name]?.(); } catch {} };
  // [2026-10-19 attach-instant] api >= 5 manda { hadKeyboard, instant }.
  const _onAttach = useCallback((e) => { try { cbRef.current.onAttach?.(e?.nativeEvent || null); } catch {} }, []);
  // [2026-10-20 attach-inputview] botão do painel de anexos (api 10).
  const _onAttachPanel = useCallback((e) => {
    const ne = e?.nativeEvent || null;
    if (!ne || ne.key == null) return;
    try { cbRef.current.onAttachPanel?.({ key: String(ne.key), keep: ne.keep === true }); } catch {}
  }, []);
  const panelItemsKey = JSON.stringify(Array.isArray(attachPanelItems) ? attachPanelItems.map((it) => [it && it.key, it && it.label]) : []);
  const panelItems = useMemo(() => (Array.isArray(attachPanelItems) ? attachPanelItems : [])
    .filter((it) => it && it.key)
    .map((it) => ({ key: String(it.key), label: String(it.label || it.key) })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [panelItemsKey]);
  const _onCamera = useMemo(() => _simple('onCamera'), []);
  const _onEmoji = useMemo(() => _simple('onEmoji'), []);
  const _onVideoNote = useMemo(() => _simple('onVideoNote'), []);
  const _onReplyCancel = useMemo(() => _simple('onReplyCancel'), []);
  const _onSendMenu = useCallback((e) => {
    const k = e?.nativeEvent?.key;
    if (k == null) return;
    try { cbRef.current.onSendMenu?.(String(k)); } catch {}
  }, []);
  const _onKeyboardFrame = useCallback((e) => {
    try { cbRef.current.onKeyboardFrame?.(e?.nativeEvent || {}); } catch {}
  }, []);
  // [2026-10-19 kb-native] quadro REAL do teclado → ThreadKeyboardAvoider.
  const _onKeyboardSync = useCallback((e) => {
    const ne = e?.nativeEvent || null;
    // [2026-10-20 dock-fix] trava de sanidade do dock nativo desligou-o na sessão → telemetria.
    if (ne && typeof ne.reason === 'string' && ne.reason.indexOf('dock_sanity') === 0) {
      try { require('../../services/crashReporter').reportNativeFallback('native_dock', ne.reason); } catch {}
      return;
    }
    try { reportKeyboardSync(ne); } catch {}
  }, []);

  // Altura inicial estimada (o nativo corrige no 1º layout via onHeightChange
  // + setStyleSize síncrono): linha 44 + respiro 6 + inset inferior.
  const estimate = 6 + 44 + Math.max(8, bottomInset || 0) + (reply ? 62 : 0);
  const h = height > 0 ? height : estimate;

  return (
    <NativeView
      ref={nativeRef}
      style={{ height: h, width: '100%' }}
      placeholder={placeholder || ''}
      labels={labels}
      theme={theme}
      replyPreview={reply}
      mentionCandidates={mentions}
      sendMenu={menu}
      defaultText={mountedText.current || ''}
      bottomInset={bottomInset || 0}
      sending={!!sending}
      uploading={!!uploading}
      enterSends={!!enterSends}
      autocorrect={autocorrect !== false}
      maxLength={maxLength}
      maxLines={6}
      showEmoji={!!showEmoji}
      emojiActive={!!emojiActive}
      showCamera={showCamera !== false}
      showVideoNote={!!showVideoNote}
      voiceEnabled
      voiceBlocked={!!voiceBlocked}
      disabled={!!disabled}
      changeDebounceMs={40}
      keyboardTracking={keyboardTracking}
      motion={_motionOff() ? false : undefined}
      focusGuard={kbResumeGuardOn() ? undefined : false /* [2026-10-18 kb-resume] kill __chatyy_kb_resume_guard */}
      nativeTransitions={kbNativeTransitionsOn() ? undefined : false /* [2026-10-19 kb-native] kill __chatyy_kb_native_transitions */}
      {...(composerNativeDockOn() ? { nativeDock: true } : null) /* [2026-10-20 native-dock] api 13 */}
      {...(Platform.OS === 'ios' ? _attachInstantProps() : (Platform.OS === 'android' ? _androidAttachProps() : null)) /* [2026-10-19 attach-instant] · [2026-10-19 android-parity] */}
      onChangeText={_onChangeText}
      onSend={_onSend}
      onAttach={_onAttach}
      onCamera={_onCamera}
      onEmoji={_onEmoji}
      onVideoNote={_onVideoNote}
      onVoiceRecorded={_onVoiceRecorded}
      onVoiceState={_onVoiceState}
      onHeightChange={_onHeight}
      onSelectionChange={_onSelection}
      onPasteImage={_onPasteImage}
      onFocusChange={_onFocusChange}
      onReplyCancel={_onReplyCancel}
      onSendMenu={_onSendMenu}
      onKeyboardFrame={_onKeyboardFrame}
      onKeyboardSync={_onKeyboardSync}
      {...(Platform.OS === 'ios' && panelItems.length ? { attachPanelItems: panelItems, onAttachPanel: _onAttachPanel } : null) /* [2026-10-20 attach-inputview] */}
      {...(Platform.OS === 'android' && androidAttachPanelOn() ? { attachPanelOpen: !!attachPanelOpen } : null)}
    />
  );
});

/**
 * <NativeComposerBridge ref={inputRef} fallback={() => jsComposer} … />
 * `fallback` é obrigatório: renderiza o composer JS se o nativo falhar.
 */
const NativeComposerBridge = forwardRef(function NativeComposerBridge(props, ref) {
  const { fallback, onFatal } = props;
  return (
    <NativeComposerBoundary fallback={fallback} onFatal={onFatal}>
      <NativeComposerInner {...props} ref={ref} />
    </NativeComposerBoundary>
  );
});

export default NativeComposerBridge;
