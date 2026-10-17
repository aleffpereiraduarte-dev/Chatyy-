// [2026-10-17 freeze] Guarda GLOBAL do <Modal> RN no iOS (Fabric) — "o app
// trava e tenho que fechar e abrir".
//
// Causa (RCTModalHostViewComponentView.mm, RN 0.83): `visible` vira um
// present/dismiss do UIKit SEM fila. O UIKit IGNORA (só loga "Attempt to
// present/dismiss … while a presentation or dismiss is in progress"):
//   • fechar um Modal ENQUANTO ele ainda está subindo (abrir/fechar rápido,
//     toque no fundo logo após abrir, estado dessincronizado) → o RN marca
//     _isPresented=NO, mas o VC transparente fica na tela → camada invisível
//     por cima de tudo, nenhum toque passa = "travou" (a classe do gift freeze);
//   • abrir o Modal B no mesmo tick em que o A desce (troca de folha) → B é
//     recusado / A pode ficar órfão.
// O JS não tem como dispensar um VC órfão depois — a correção é NUNCA criar
// a corrida: este wrapper serializa as transições de TODOS os <Modal>:
//   - fechar antes do onShow → espera o onShow (≤ PRESENT_MAX_MS) e só então fecha;
//   - abrir enquanto outro Modal sobe/desce (ou o próprio ainda desce) → espera
//     ele terminar (≤ WAIT_MAX_MS) e então abre;
//   - timeouts nunca deixam a tela presa: passam adiante e mandam push_diag
//     (modal_present_timeout / modal_dismiss_timeout = assinatura do órfão).
// Android/web: intocado. Kill switch (antes do import, via OTA):
//   globalThis.__chatyy_modal_guard = false.
// Mesmo padrão do services/disableLayoutAnimationIOS (import no topo do _layout).
import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

const PRESENT_MAX_MS = 900; // onShow não veio (apresentação recusada / fora da janela)
const DISMISS_MAX_MS = 1000; // onDismiss não veio (dismiss ignorado pelo UIKit)
const WAIT_MAX_MS = 700; // espera máxima por OUTRO Modal em transição
const UNMOUNT_BUSY_MS = 420; // desmontou visível → o UIKit está descendo o VC

const _busy = new Map(); // id -> until (ms)
const _waiters = new Set();
const _open = new Map(); // id -> { label, phase, since }
let _seq = 0;
let _diagLeft = 12;

function _notify() {
  _waiters.forEach((fn) => { try { fn(); } catch {} });
}
function _busyOther(selfId) {
  const now = Date.now();
  let until = 0;
  _busy.forEach((u, id) => {
    if (u <= now) { _busy.delete(id); return; }
    if (id !== selfId && u > until) until = u;
  });
  return until; // 0 = livre
}
function _setBusy(id, ms) { _busy.set(id, Date.now() + ms); }
function _clearBusy(id) { if (_busy.delete(id)) _notify(); }

function _diag(step, info) {
  if (_diagLeft <= 0) return;
  _diagLeft -= 1;
  try { require('./crashReporter').reportStep(step, String(info || '').slice(0, 200)); } catch {}
}

// Modais abertos agora (p/ freezeWatch: o que estava na tela quando travou).
export function getOpenModals() {
  const now = Date.now();
  const out = [];
  _open.forEach((v) => { out.push(`${v.label}:${v.phase}:${Math.round((now - v.since) / 1000)}s`); });
  return out;
}

function _label(p) {
  if (p.testID) return String(p.testID).slice(0, 24);
  // t/o = transparent/opaco · animação (n/s/f) · estilo (pageSheet/formSheet = 'p'/'f')
  const ps = p.presentationStyle ? String(p.presentationStyle).charAt(0) : '';
  return `${p.transparent ? 't' : 'o'}${String(p.animationType || 'none').charAt(0)}${ps}`;
}

function makeGuarded(Orig) {
  function GuardedModal(props) {
    // RN: Modal.defaultProps = { visible: true } → sem a prop = visível.
    const want = props.visible === undefined ? true : props.visible === true;
    const [id] = useState(() => ++_seq);
    // Sempre nasce fechado: a decisão de apresentar sai num microtask DEPOIS do
    // commit — assim um Modal irmão que fecha/desmonta NO MESMO commit (troca de
    // folha) já marcou "ocupado" quando este decide.
    const [nativeVisible, setNativeVisible] = useState(false);
    const phaseRef = useRef('hidden'); // hidden | presenting | shown | dismissing
    const [, setTick] = useState(0);
    const kick = useCallback(() => setTick((n) => (n + 1) % 1000000), []);
    const timerRef = useRef(null);
    const waitSinceRef = useRef(0);
    const scheduledRef = useRef(false);
    const aliveRef = useRef(true);
    const wantRef = useRef(want);
    wantRef.current = want;
    const labelRef = useRef('');
    labelRef.current = _label(props);
    const userRef = useRef(props);
    userRef.current = props;

    const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };
    const arm = (ms, fn) => { clearTimer(); timerRef.current = setTimeout(() => { timerRef.current = null; fn(); }, ms); };

    const markShown = useCallback((timedOut) => {
      if (phaseRef.current !== 'presenting') return;
      clearTimer();
      phaseRef.current = 'shown';
      const o = _open.get(id); if (o) o.phase = 'shown';
      _clearBusy(id);
      if (timedOut) _diag('modal_present_timeout', `l=${labelRef.current} open=${_open.size}`);
      if (aliveRef.current) kick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, kick]);
    const markHidden = useCallback((timedOut) => {
      if (phaseRef.current !== 'dismissing') return;
      clearTimer();
      phaseRef.current = 'hidden';
      _open.delete(id);
      _clearBusy(id);
      if (timedOut) _diag('modal_dismiss_timeout', `l=${labelRef.current} open=${_open.size}`);
      if (aliveRef.current) kick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, kick]);

    // Apresentar (fora do commit): espera outro Modal em transição (≤ WAIT_MAX_MS).
    const decide = () => {
      scheduledRef.current = false;
      if (!aliveRef.current || !wantRef.current || phaseRef.current !== 'hidden') return;
      const until = _busyOther(id);
      if (until) {
        if (!waitSinceRef.current) waitSinceRef.current = Date.now();
        const left = WAIT_MAX_MS - (Date.now() - waitSinceRef.current);
        if (left > 0) {
          _waiters.add(kick);
          arm(Math.max(16, Math.min(left, until - Date.now() + 16)), kick);
          return;
        }
      }
      _waiters.delete(kick);
      waitSinceRef.current = 0;
      phaseRef.current = 'presenting';
      _open.set(id, { label: labelRef.current, phase: 'presenting', since: Date.now() });
      _setBusy(id, PRESENT_MAX_MS);
      setNativeVisible(true);
      arm(PRESENT_MAX_MS, () => markShown(true));
    };

    // Máquina de estados: roda a cada commit (want muda / kick).
    useLayoutEffect(() => {
      const ph = phaseRef.current;
      if (want) {
        if (ph !== 'hidden') { waitSinceRef.current = 0; return; } // subindo/aberto, ou descendo (espera onDismiss)
        if (!scheduledRef.current) {
          scheduledRef.current = true;
          Promise.resolve().then(decide).catch(() => {});
        }
        return;
      }
      _waiters.delete(kick);
      waitSinceRef.current = 0;
      if (ph === 'shown') {
        phaseRef.current = 'dismissing';
        const o = _open.get(id); if (o) { o.phase = 'dismissing'; o.since = Date.now(); }
        // pageSheet/formSheet: o usuário pode já ter descido pelo gesto do sistema
        // (presentationControllerDidDismiss → onRequestClose) e aí o UIKit não
        // chama a conclusão do dismiss → espera curta e sem diag.
        const ps = userRef.current.presentationStyle;
        const sheetLike = ps === 'pageSheet' || ps === 'formSheet';
        const maxMs = sheetLike ? 450 : DISMISS_MAX_MS;
        _setBusy(id, maxMs);
        setNativeVisible(false);
        arm(maxMs, () => markHidden(!sheetLike));
      } else if (ph === 'hidden' && timerRef.current) {
        clearTimer(); // desistiu de abrir enquanto esperava
      }
      // 'presenting' → fecha no markShown (onShow/timeout) via kick.
    });

    // Desmontagem no commit (layout cleanup = síncrono, antes de qualquer decide()).
    useLayoutEffect(() => {
      aliveRef.current = true;
      return () => {
        aliveRef.current = false;
        clearTimer();
        _waiters.delete(kick);
        const ph = phaseRef.current;
        _open.delete(id);
        _busy.delete(id);
        // Desmontou com o VC na tela → o UIKit vai descer: segura os próximos.
        if (ph === 'presenting' || ph === 'shown' || ph === 'dismissing') {
          _setBusy(id, UNMOUNT_BUSY_MS);
          if (ph === 'presenting') _diag('modal_unmount_presenting', `l=${labelRef.current}`);
        }
        _notify();
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const onShow = useCallback((e) => {
      markShown(false);
      const f = userRef.current.onShow;
      if (typeof f === 'function') f(e);
    }, [markShown]);
    const onDismiss = useCallback(() => {
      markHidden(false);
      const f = userRef.current.onDismiss;
      if (typeof f === 'function') f();
    }, [markHidden]);

    return React.createElement(Orig, { ...props, visible: nativeVisible, onShow, onDismiss });
  }
  GuardedModal.displayName = 'Modal';
  try { if (Orig.Context) GuardedModal.Context = Orig.Context; } catch {}
  GuardedModal.__chatyyGuarded = true;
  return GuardedModal;
}

let _installed = false;
export function modalGuardInstalled() { return _installed; }

(function install() {
  if (Platform.OS !== 'ios') return;
  try { if (globalThis.__chatyy_modal_guard === false) return; } catch {}
  try {
    // react-native/index.js: `get Modal() { return require('./Libraries/Modal/Modal').default }`
    // → trocar o `default` do módulo vale p/ todo `import { Modal } from 'react-native'`
    // (Babel lê `_reactNative.Modal` no render).
    const mod = require('react-native/Libraries/Modal/Modal'); // eslint-disable-line global-require
    const Orig = mod && mod.default;
    if (typeof Orig !== 'function' || Orig.__chatyyGuarded) return;
    mod.default = makeGuarded(Orig);
    _installed = mod.default !== Orig;
  } catch {}
}());
