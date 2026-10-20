// [mural 2026-10-20 kb-fix v2] Espaço do teclado SEM medir posição na tela.
// v1 media measureInWindow dentro da folha nativa (formSheet) e errava: o
// conteúdo da folha tem a altura do detent médio mesmo quando o sistema sobe a
// folha para o grande → campo sumia atrás do teclado (prints 20/10, build 752).
// Agora a folha de comentários é um painel JS em tela cheia (fundo colado no
// fundo da tela) e o espaço = altura do teclado que o sistema informa:
//   iOS: pad = altura do teclado (keyboardWillChangeFrame/WillShow, mesma curva).
//   Android: pad = teclado − o quanto a janela já encolheu (adjustResize); com
//            edge-to-edge sem resize → pad = teclado inteiro.
// Teclado já aberto ao montar → Keyboard.metrics(). Uso: onLayout no View raiz
// (que vai até o fundo da tela) + <View style={{ height: pad }} /> após o campo.
import { useEffect, useRef, useState, useCallback } from 'react';
import { Keyboard, LayoutAnimation, Platform, Dimensions } from 'react-native';

function _anim(duration) {
  try {
    if (Platform.OS === 'ios') {
      LayoutAnimation.configureNext({ duration: Math.max(120, duration || 250), update: { type: LayoutAnimation.Types.keyboard }, create: { type: LayoutAnimation.Types.keyboard, property: LayoutAnimation.Properties.opacity } });
    } else {
      LayoutAnimation.configureNext(LayoutAnimation.create(160, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
    }
  } catch {}
}

function _initialKb() {
  try {
    if (Keyboard.isVisible && Keyboard.isVisible()) {
      const m = Keyboard.metrics && Keyboard.metrics();
      return m && m.height > 0 ? m.height : 0;
    }
  } catch {}
  return 0;
}

export default function useKeyboardSpacer({ enabled = true } = {}) {
  const [kb, setKb] = useState(_initialKb);
  const [rootH, setRootH] = useState(0);
  const restH = useRef(0); // altura da raiz sem teclado (Android: detectar adjustResize)
  const kbRef = useRef(kb);
  kbRef.current = kb;
  useEffect(() => {
    if (!enabled || Platform.OS === 'web') return undefined;
    const subs = [];
    const add = (ev, fn) => { try { subs.push(Keyboard.addListener(ev, fn)); } catch {} };
    const show = (e) => {
      const h = e && e.endCoordinates ? Math.round(e.endCoordinates.height) : 0;
      if (!(h > 0) || Math.abs(h - kbRef.current) < 1) return;
      _anim(e.duration);
      setKb(h);
    };
    const hide = (e) => { if (kbRef.current === 0) return; _anim(e && e.duration); setKb(0); };
    if (Platform.OS === 'ios') {
      add('keyboardWillShow', show);
      add('keyboardWillChangeFrame', (e) => {
        // só quadro NA tela (no fechar o quadro final fica abaixo da tela: sy + h > altura)
        const sy = e?.endCoordinates?.screenY; const h = e?.endCoordinates?.height;
        let H = 0; try { H = Dimensions.get('screen').height; } catch {}
        if (h > 0 && sy > 0 && (!H || sy + h <= H + 2)) show(e);
      });
      add('keyboardWillHide', hide);
    } else {
      add('keyboardDidShow', show);
      add('keyboardDidHide', hide);
    }
    return () => subs.forEach((s) => { try { s.remove(); } catch {} });
  }, [enabled]);
  const onLayout = useCallback((e) => {
    const h = Math.round(e?.nativeEvent?.layout?.height || 0);
    if (!h) return;
    if (kbRef.current === 0 && h > restH.current) restH.current = h;
    if (!restH.current) restH.current = h;
    setRootH(h);
  }, []);
  let pad = 0;
  if (enabled && Platform.OS !== 'web' && kb > 0) {
    if (Platform.OS === 'ios') pad = kb;
    else {
      const shrunk = restH.current && rootH ? Math.max(0, restH.current - rootH) : 0;
      pad = Math.max(0, kb - shrunk);
    }
  }
  return { pad, kb, onLayout };
}
