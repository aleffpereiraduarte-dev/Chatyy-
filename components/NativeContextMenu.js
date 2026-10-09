// [2026-10-09 more-native] <NativeContextMenu> — menu de contexto NATIVO do iOS
// (UIContextMenuInteraction: a linha "levanta" com o fundo desfocado e o
// UIMenu do sistema com SF Symbols — igual Mail/Mensagens/WhatsApp iOS).
//
// Native: modules/expo-native-toolkit/ios/ChatyyContextMenuView.swift
// (view `ChatyyContextMenuView`). Só existe a partir do PRÓXIMO build iOS.
//
// OTA-safe: a view é detectada com nativeViewCaps (globalThis.expo
// .getViewConfig — síncrono, não lança, null quando a view não está no
// binário). Sem a view (binário 2.6.0 atual, Android, web) o componente só
// devolve os filhos e o chamador mantém o long-press JS de sempre — use
// isNativeContextMenuAvailable() para decidir se desliga o onLongPress JS.
//
// Android: sem view nativa de propósito — o padrão do WhatsApp Android é o
// modo de seleção/sheet, e um long-click nativo numa view hospedada pelo RN
// disputa o toque com o responder JS.
//
// Kill switch OTA: NATIVE_CONTEXT_MENU_ENABLED = false.
import React from 'react';
import { Platform } from 'react-native';
import { nativeViewCaps } from '../modules/expo-native-toolkit/src/viewCaps';

export const NATIVE_CONTEXT_MENU_ENABLED = true;

let _checked = false;
let _available = false;
let _View = null;

export function isNativeContextMenuAvailable() {
  if (_checked) return _available;
  _checked = true;
  _available = false;
  if (!NATIVE_CONTEXT_MENU_ENABLED || Platform.OS !== 'ios') return false;
  try {
    const caps = nativeViewCaps('ChatyyContextMenuView');
    _available = !!(caps && caps.events.has('onMenuAction') && caps.props.has('actions'));
  } catch { _available = false; }
  return _available;
}

function _nativeView() {
  if (_View) return _View;
  if (!isNativeContextMenuAvailable()) return null;
  try {
    const { requireNativeView } = require('expo');
    _View = requireNativeView('ChatyyContextMenuView');
  } catch { _View = null; }
  return _View;
}

/**
 * actions: [{ id, title, systemImage?, destructive?, disabled?, checked? }]
 * onAction(id) · onPreviewTap() · onWillShow()
 */
export default function NativeContextMenu({
  actions, title, onAction, onPreviewTap, onWillShow, enabled = true,
  cornerRadius = 12, style, children,
}) {
  const Native = _nativeView();
  const onActionRef = React.useRef(onAction);
  onActionRef.current = onAction;
  const onPreviewRef = React.useRef(onPreviewTap);
  onPreviewRef.current = onPreviewTap;
  const onWillShowRef = React.useRef(onWillShow);
  onWillShowRef.current = onWillShow;

  const handleAction = React.useCallback((e) => {
    const id = e?.nativeEvent?.id;
    if (!id) return;
    // UIKit fecha o menu e só então roda a ação (deixa a animação de saída
    // terminar antes de navegar/abrir alertas).
    setTimeout(() => { try { onActionRef.current?.(id); } catch {} }, 0);
  }, []);
  const handlePreview = React.useCallback(() => { try { onPreviewRef.current?.(); } catch {} }, []);
  const handleWillShow = React.useCallback(() => {
    try { onWillShowRef.current?.(); } catch {}
  }, []);

  const cleanActions = React.useMemo(() => (Array.isArray(actions) ? actions : [])
    .filter((a) => a && a.id && a.title)
    .map((a) => ({
      id: String(a.id),
      title: String(a.title),
      systemImage: a.systemImage ? String(a.systemImage) : null,
      destructive: !!a.destructive,
      disabled: !!a.disabled,
      checked: !!a.checked,
    })), [actions]);

  if (!Native) return children;
  return (
    <Native
      style={style}
      actions={cleanActions}
      menuTitle={title || ''}
      menuEnabled={!!enabled}
      previewCornerRadius={cornerRadius}
      onMenuAction={handleAction}
      onPreviewTap={handlePreview}
      onMenuWillShow={handleWillShow}
    >
      {children}
    </Native>
  );
}
