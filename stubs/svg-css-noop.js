// [2026-10-09 lighter-app] Stub de `react-native-svg/css` SÓ para o
// react-native-qrcode-svg (ver metro.config.js). O LogoSVG da lib importa
// `LocalSvg` de react-native-svg/css, que arrasta css-tree + css-select +
// domutils + entities + dom-serializer (~240 KB de JS) pra TODO bundle — mas
// ele só renderiza quando o QR recebe a prop `logoSVG`, que o app nunca passa
// (os QRs usam `logo` PNG ou nada). Se um dia usar `logoSVG` com asset local,
// remova o bloco do metro.config.js.
function Noop() { return null; }
module.exports = {
  __esModule: true,
  LocalSvg: Noop,
  WithLocalSvg: Noop,
  SvgCss: Noop,
  SvgCssUri: Noop,
  SvgWithCss: Noop,
  SvgWithCssUri: Noop,
  inlineStyles: (x) => x,
  default: Noop,
};
