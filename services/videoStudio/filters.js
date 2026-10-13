// [2026-10-13 video-studio] Catálogo de filtros (ids = EDL filter.id).
// O filtro DE VERDADE é aplicado no RENDER do servidor (ffmpeg). Aqui só há prévias:
//   - css:  web (CSS filter no <video>, fiel).
//   - tint: nativo (overlay de cor sobre o preview da câmera — APROXIMADO, sem processar pixels).
// Caminho nativo p/ tempo real fiel: ver docs no topo de components/videoStudio/CameraStudio.js.
export const STUDIO_FILTERS = [
  { id: 'none',  labelKey: 'videoStudio.filter.none',  css: '',                                              tint: null },
  { id: 'mono',  labelKey: 'videoStudio.filter.mono',  css: 'grayscale(1)',                                  tint: 'rgba(120,120,120,0.30)' },
  { id: 'noir',  labelKey: 'videoStudio.filter.noir',  css: 'grayscale(1) contrast(1.35) brightness(0.9)',   tint: 'rgba(10,10,10,0.34)' },
  { id: 'warm',  labelKey: 'videoStudio.filter.warm',  css: 'sepia(0.25) saturate(1.2) brightness(1.03)',    tint: 'rgba(255,150,40,0.14)' },
  { id: 'cool',  labelKey: 'videoStudio.filter.cool',  css: 'hue-rotate(-12deg) saturate(1.05) brightness(1.03)', tint: 'rgba(40,120,255,0.14)' },
  { id: 'vivid', labelKey: 'videoStudio.filter.vivid', css: 'saturate(1.6) contrast(1.12)',                  tint: 'rgba(255,40,110,0.07)' },
  { id: 'fade',  labelKey: 'videoStudio.filter.fade',  css: 'contrast(0.85) brightness(1.1) saturate(0.8)',  tint: 'rgba(255,255,255,0.16)' },
];

export function getStudioFilter(id) {
  return STUDIO_FILTERS.find((f) => f.id === id) || STUDIO_FILTERS[0];
}
