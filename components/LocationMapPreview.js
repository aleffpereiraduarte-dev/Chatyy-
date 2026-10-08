// LocationMapPreview — chat location-bubble thumbnail.
//
// [2026-10-08 location-bubble-fast] Founder: "demora carregar o mapa no chat".
// Antes: native `lite` ChatyyMapView (só binários novos, cinza até o MapKit
// terminar) ou WebView MapLibre por balão (segundos numa lista). Agora: UMA
// imagem estática gerada no servidor (static-map.php → renderizador MapLibre
// headless no edge BR, mesmos styles BoraUm do app) servida do CDN
// media.chatyy.com.br com cache imutável + cache memória/disco do expo-image.
// Igual em todo binário e na web. Mapa vivo/nativo SÓ no viewer de tela cheia.
//
// Ordem das fontes: CDN (chave estável) → onError → static-map.php (gera na
// hora e devolve o JPEG; depois redireciona p/ o CDN). Placeholder = cinza
// neutro (nada de pin colorido) enquanto carrega.
//
// Props: lat, lng, isDark, showPin (default true; o balão "ao vivo" desenha o
// próprio pulso e passa false), zoom (15), warmOther (pré-gera a variante do
// OUTRO tema — usado no balão recém-enviado pelo próprio usuário p/ o
// destinatário abrir instantâneo em qualquer tema), style. `fallback` é aceito
// e ignorado (compat com chamadores antigos).

import React from 'react';
import { View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { chatyyStaticMap } from './BoraMap';

const _warmed = new Set();
function warm(url) {
  if (!url || _warmed.has(url)) return;
  _warmed.add(url);
  try { fetch(url + '&warm=1').catch(() => {}); } catch {}
}

function LocationMapPreview({ lat, lng, isDark, showPin = true, zoom = 15, warmOther = false, style }) {
  const urls = React.useMemo(
    () => chatyyStaticMap(lat, lng, { zoom, dark: !!isDark, pin: showPin }),
    [lat, lng, zoom, isDark, showPin],
  );
  // 0 = CDN, 1 = API (gera), 2 = falhou tudo → só placeholder
  const [stage, setStage] = React.useState(0);
  React.useEffect(() => { setStage(0); }, [urls && urls.key]);
  React.useEffect(() => {
    if (!warmOther) return;
    const other = chatyyStaticMap(lat, lng, { zoom, dark: !isDark, pin: showPin });
    if (other) warm(other.api);
  }, [warmOther, lat, lng, zoom, isDark, showPin]);

  const placeholderBg = isDark ? '#2C2C2E' : '#E5E5EA';
  const uri = urls ? (stage === 0 ? urls.cdn : stage === 1 ? urls.api : null) : null;
  return (
    <View pointerEvents="none" style={[{ width: '100%', height: '100%', backgroundColor: placeholderBg, overflow: 'hidden' }, style]}>
      {uri ? (
        <ExpoImage
          source={{ uri }}
          recyclingKey={uri}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          contentPosition="center"
          cachePolicy="memory-disk"
          transition={120}
          priority="high"
          accessibilityIgnoresInvertColors
          onError={() => setStage((s) => (s < 2 ? s + 1 : s))}
        />
      ) : null}
    </View>
  );
}

export default React.memo(LocationMapPreview);
