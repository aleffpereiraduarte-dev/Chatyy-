// [mural 2026-10-20 kb-fix] Espaçador de teclado por MEDIDA REAL: mede o fundo do
// campo (measureInWindow) contra o topo do teclado (screenY) e cresce o espaço
// abaixo dele até o campo encostar no teclado. Idempotente (pad novo = pad +
// sobreposição), então vale dentro da folha nativa (formSheet sobe p/ o detent
// grande e o teclado cobria o campo — print 20/10 build 752), em tela cheia e no
// Android com ou sem adjustResize. Uso: ref no View que embrulha o campo;
// <View style={{ height: pad }} /> logo depois dele, dentro do mesmo flex.
import { useEffect, useRef, useState, useCallback } from 'react';
import { Keyboard, LayoutAnimation, Platform } from 'react-native';

export default function useKeyboardSpacer(targetRef, { enabled = true, gap = 0 } = {}) {
  const [pad, setPad] = useState(0);
  const padRef = useRef(0);
  const kbYRef = useRef(0);
  const apply = useCallback((v, duration) => {
    const n = Math.max(0, Math.round(v));
    if (Math.abs(n - padRef.current) < 2) return;
    try {
      if (Platform.OS === 'ios') {
        LayoutAnimation.configureNext({ duration: Math.max(120, duration || 250), update: { type: LayoutAnimation.Types.keyboard }, create: { type: LayoutAnimation.Types.keyboard, property: LayoutAnimation.Properties.opacity } });
      } else {
        LayoutAnimation.configureNext(LayoutAnimation.create(160, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
      }
    } catch {}
    padRef.current = n;
    setPad(n);
  }, []);
  const correct = useCallback((duration) => {
    const node = targetRef.current;
    const kbY = kbYRef.current;
    if (!node || !kbY || typeof node.measureInWindow !== 'function') return;
    try {
      node.measureInWindow((x, y, w, h) => {
        if (!(h > 0) || !kbYRef.current) return;
        const overlap = y + h + gap - kbYRef.current;
        if (Math.abs(overlap) >= 2) apply(padRef.current + overlap, duration);
      });
    } catch {}
  }, [targetRef, apply, gap]);
  useEffect(() => {
    if (!enabled || Platform.OS === 'web') return undefined;
    const subs = [];
    const timers = [];
    const later = (ms) => timers.push(setTimeout(() => correct(160), ms));
    const add = (ev, fn) => { try { subs.push(Keyboard.addListener(ev, fn)); } catch {} };
    const onShow = (e) => {
      const y = e && e.endCoordinates ? e.endCoordinates.screenY : 0;
      if (!y) return;
      kbYRef.current = y;
      correct(e.duration);
      // a folha ainda pode estar subindo p/ o detent grande → confere de novo
      later(320); later(650);
    };
    const onHide = (e) => { kbYRef.current = 0; timers.forEach(clearTimeout); apply(0, e && e.duration); };
    if (Platform.OS === 'ios') {
      add('keyboardWillChangeFrame', (e) => { const y = e?.endCoordinates?.screenY || 0; if (y && e.endCoordinates.height > 0) onShow(e); });
      add('keyboardDidShow', onShow);
      add('keyboardWillHide', onHide);
    } else {
      add('keyboardDidShow', onShow);
      add('keyboardDidHide', onHide);
    }
    return () => { subs.forEach((s) => { try { s.remove(); } catch {} }); timers.forEach(clearTimeout); };
  }, [enabled, correct, apply]);
  return { pad, recheck: () => correct(120) };
}
