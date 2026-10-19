// services/a11yGlobalPatch.js — [2026-10-19 a11y-complete] "Texto em negrito" e
// "Áreas de toque maiores" valendo no APP INTEIRO, sem tocar em centenas de telas.
//
// Como: o `react-native` exporta Text/Pressable/TouchableOpacity por GETTERS
// (index.js) e o Babel compila `import { Text } from 'react-native'` para um
// acesso `_reactNative.Text` a CADA render. Redefinimos esses getters para
// devolver um invólucro fino SÓ enquanto a flag está ligada; desligada, o
// getter devolve o componente original (custo zero p/ quem não usa).
//   • Text: sobe o peso (normal→600, 500→700, 600→700, 700→800). Texto aninhado
//     sem peso próprio herda do pai (não mexe).
//   • Pressable/TouchableOpacity: hitSlop + 8 pt (não muda layout).
// Web (react-native-web) e binários onde o getter não é configurável: no-op.
// Kill switch OTA: globalThis.__chatyy_a11y_patch = false.
import React from 'react';
import { Platform } from 'react-native';
import { getA11y, boldWeight, growHitSlop } from './a11yPrefs';

let _installed = false;

function _flatWeight(style, flatten) {
  try { const f = flatten(style); return f ? f.fontWeight : undefined; } catch { return undefined; }
}

export function installA11yGlobalPatch() {
  if (_installed || Platform.OS === 'web') return;
  _installed = true;
  let RN;
  try { RN = require('react-native'); } catch { return; }
  const off = () => { try { return globalThis.__chatyy_a11y_patch === false; } catch { return false; } };

  const wrap = (name, make) => {
    try {
      const desc = Object.getOwnPropertyDescriptor(RN, name);
      if (!desc || !desc.configurable || typeof desc.get !== 'function') return;
      const origGet = desc.get;
      let Orig = null;
      let Wrapped = null;
      Object.defineProperty(RN, name, {
        configurable: true,
        enumerable: desc.enumerable,
        get() {
          if (!Orig) Orig = origGet.call(RN);
          if (off()) return Orig;
          // Depois de ligado uma vez, o invólucro fica (ele mesmo checa a flag a
          // cada render) → desligar não troca o tipo de novo (sem remontar telas).
          if (!Wrapped) {
            const s = getA11y();
            const want = name === 'Text' ? s.boldText : s.largeTargets;
            if (!want) return Orig;
            Wrapped = make(Orig);
            try { Wrapped.displayName = Orig.displayName || name; } catch {}
          }
          return Wrapped;
        },
      });
    } catch {}
  };

  wrap('Text', (OrigText) => {
    const flatten = (RN.StyleSheet && RN.StyleSheet.flatten) || ((x) => x);
    let Ancestor = null;
    try { Ancestor = RN.unstable_TextAncestorContext || require('react-native/Libraries/Text/TextAncestorContext').default; } catch { Ancestor = null; }
    function A11yBoldText(props) {
      // hook SEMPRE chamado (mesma ordem em todo render, ligado ou não)
      const nested = Ancestor ? React.useContext(Ancestor) : false;
      if (!getA11y().boldText) return React.createElement(OrigText, props);
      const fw = _flatWeight(props.style, flatten);
      if (nested && fw == null) return React.createElement(OrigText, props);
      return React.createElement(OrigText, { ...props, style: [props.style, { fontWeight: boldWeight(fw) }] });
    }
    return A11yBoldText;
  });

  const tap = (Orig) => {
    function A11yLargeTarget(props) {
      if (!getA11y().largeTargets) return React.createElement(Orig, props);
      return React.createElement(Orig, { ...props, hitSlop: growHitSlop(props.hitSlop) });
    }
    return A11yLargeTarget;
  };
  wrap('Pressable', tap);
  wrap('TouchableOpacity', tap);
}

installA11yGlobalPatch();
