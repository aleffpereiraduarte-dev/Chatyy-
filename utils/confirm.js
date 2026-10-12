// utils/confirm.js — confirmação/alerta IMPERATIVOS com o visual do design
// system (2026-10-12). Use em código novo (fora de componente ou sem hook):
//
//   import { confirmAsync, alertAsync, showDialog } from '../utils/confirm';
//   if (await confirmAsync({ title: 'Apagar?', message: '...', confirmLabel: 'Apagar', destructive: true })) { ... }
//   await alertAsync('Pronto', 'Arquivo salvo.');
//   showDialog(title, message, buttons);   // mesma assinatura do Alert.alert
//
// iOS/Android: diálogo NATIVO do sistema (Alert.alert — UIAlertController /
// Material), igual ao useConfirm(). Web: diálogo estilizado do app
// (ConfirmProvider em app/_layout.js registra o host aqui); sem host montado
// cai no window.confirm/alert (nunca fica mudo — RN-web Alert.alert é no-op).
import { Alert, Platform } from 'react-native';

let _host = null; // { show(opts) -> Promise<number>, t(key) }

export function registerDialogHost(host) {
  _host = host || null;
  return () => { if (_host === host) _host = null; };
}

export function hasDialogHost() { return !!(_host && typeof _host.show === 'function'); }

function tr(key, fb) {
  try { const v = _host && _host.t && _host.t(key); if (v && v !== key) return v; } catch {}
  return fb;
}

function webFallback(title, message, buttons) {
  if (typeof window === 'undefined') return -1;
  const text = (title ? title + (message ? '\n\n' + message : '') : message) || '';
  const list = buttons || [];
  if (list.length <= 1) {
    try { window.alert(text); } catch {}
    return 0;
  }
  let ok = true;
  try { ok = window.confirm(text); } catch {}
  const cancelIdx = list.findIndex((b) => b && b.style === 'cancel');
  const proceedIdx = list.findIndex((b) => b && b.style !== 'cancel');
  return ok ? proceedIdx : cancelIdx;
}

// Alert.alert-compatível. Retorna Promise<índice do botão | -1 (dispensado)>.
// O onPress do botão escolhido roda (como no Alert.alert).
export function showDialog(title, message, buttons, options) {
  const list = (Array.isArray(buttons) && buttons.length ? buttons : [{ text: tr('common.ok', 'OK') }]).filter(Boolean);
  const fire = (idx) => {
    const b = idx >= 0 ? list[idx] : list.find((x) => x && x.style === 'cancel');
    if (b && typeof b.onPress === 'function') { try { b.onPress(); } catch {} }
    return idx;
  };
  if (Platform.OS !== 'web') {
    return new Promise((resolve) => {
      let settled = false;
      const done = (i) => { if (settled) return; settled = true; resolve(i); };
      try {
        Alert.alert(
          title || '',
          message || undefined,
          list.map((b, i) => ({ ...b, onPress: () => { try { b.onPress && b.onPress(); } catch {} done(i); } })),
          { cancelable: options?.cancelable !== false, onDismiss: () => done(-1) },
        );
      } catch { done(-1); }
    });
  }
  if (hasDialogHost()) {
    return _host.show({ title, message, buttons: list, icon: options?.icon })
      .then((idx) => fire(typeof idx === 'number' ? idx : -1))
      .catch(() => -1);
  }
  return Promise.resolve(fire(webFallback(title, message, list)));
}

// Promise<boolean>.
export function confirmAsync(opts = {}) {
  const cancel = { text: opts.cancelLabel || tr('common.cancel', 'Cancelar'), style: 'cancel' };
  const ok = { text: opts.confirmLabel || tr('common.confirm', 'Confirmar'), style: opts.destructive ? 'destructive' : 'default' };
  return showDialog(opts.title || '', opts.message || '', [cancel, ok], { icon: opts.icon }).then((i) => i === 1);
}

// Promise<void>.
export function alertAsync(title, message, okLabel) {
  return showDialog(title || '', message || '', [{ text: okLabel || tr('common.ok', 'OK') }]).then(() => undefined);
}

export default confirmAsync;
