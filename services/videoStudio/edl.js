// [2026-10-13 video-studio] CONTRATO EDL v1 — compartilhado por câmera, editor e servidor.
//
// NÃO mude o formato. Campo novo = OPCIONAL + documentado aqui (seção "Extensões").
//
// {
//   "v": 1,
//   "canvas": { "w": 1080, "h": 1920, "fps": 30 },
//   "clips": [ { "uri": "file://… | https://…", "in": 0.0, "out": 4.2, "speed": 1.0, "mirror": false } ],
//   "audio": {
//     "original_volume": 1.0,
//     "music": { "id": "…", "url": "…", "start": 12.0, "volume": 0.6 } | null,
//     "voiceover": { "uri": "…", "volume": 1.0 } | null
//   },
//   "filter": { "id": "none|mono|noir|warm|cool|vivid|fade|…", "intensity": 1.0 },
//   "overlays": [ { "type": "text|sticker", "text": "…", "sticker_url": "…", "start": 0, "end": 3,
//                   "x": 0.5, "y": 0.4, "scale": 1, "rotation": 0,
//                   "style": { "font": "…", "color": "#fff", "bg": "none|box|outline", "align": "center" } } ],
//   "captions": { "enabled": false, "style": "…", "lang": "pt" },
//   "cover": { "t": 1.5, "text": "…" },
//   "meta": { "duet_of": null, "stitch_of": null, "source": "camera|gallery" }
// }
//
// Semântica:
//   - clip.in/out em SEGUNDOS da mídia de origem (tempo-fonte, antes da velocidade).
//   - clip.speed: 0.3/0.5/1/2/3… O render aplica (setpts/atempo). Duração na timeline = (out-in)/speed.
//   - clip.mirror: espelhar horizontalmente (câmera frontal grava espelhada no preview, não no arquivo).
//   - x/y de overlays normalizados 0..1 no canvas.
//
// Extensões OPCIONAIS (aceitas por validate; servidor/editor podem ignorar):
//   clip.kind: "video" | "image"   — "image" = foto estática; in=0, out=duração desejada (padrão 3 s).
//   clip.w, clip.h: dimensões da mídia de origem (px) se conhecidas.
//   clip.camera: "front" | "back"   — de qual câmera veio (informativo).
//   clip.thumb: uri de miniatura local (só cliente, não enviar ao servidor obrigatório).
//   meta.limit_s: limite de gravação escolhido na câmera (15|60|180).
//   meta.created_at: epoch ms.
//   [editor] overlay.id: id estável p/ UI (o editor REMOVE antes de enviar; servidor ignora).
//   [editor] overlay.kind: "gif" quando sticker_url é GIF animado (informativo).
//   [editor] audio.music.title/artist/cover/duration: só exibição.
//   [editor] captions.segments: [{start,end,text}] em tempo de TIMELINE (s), já revisados pelo usuário
//            → se presente e captions.enabled, o render queima ESTES textos (não re-transcreve).
//            captions.style: "classic" | "box" | "outline".
//   [editor] meta.publish: último {caption,hashtags,visibility,…} digitado (rascunho; servidor ignora).
//   Convenção de tamanho dos overlays (prévia = render): x/y = CENTRO do item;
//     texto: fonte = 0.065·canvas.w·scale (padding ~0.1·fonte; caixa = fundo na cor, texto em contraste);
//     sticker: largura = 0.32·canvas.w·scale (quadrado, contain); rotation em GRAUS (horário).
//   Clip "contain": se clip.w/clip.h > 0.75 (paisagem) a prévia usa letterbox (contain), senão cover.

export const EDL_VERSION = 1;
export const DEFAULT_CANVAS = { w: 1080, h: 1920, fps: 30 };
export const SPEEDS = [0.3, 0.5, 1, 2, 3];
export const FILTER_IDS = ['none', 'mono', 'noir', 'warm', 'cool', 'vivid', 'fade'];
export const IMAGE_CLIP_SECONDS = 3;
export const MAX_DURATION_S = 600; // teto duro (10 min) p/ validação

const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const clone = (o) => JSON.parse(JSON.stringify(o));

export function newEdl(opts = {}) {
  return {
    v: EDL_VERSION,
    canvas: { ...DEFAULT_CANVAS, ...(opts.canvas || {}) },
    clips: [],
    audio: {
      original_volume: 1.0,
      music: opts.music || null,
      voiceover: null,
    },
    filter: { id: 'none', intensity: 1.0, ...(opts.filter || {}) },
    overlays: [],
    captions: { enabled: false, style: 'classic', lang: opts.lang || 'pt' },
    cover: { t: 0, text: '' },
    meta: {
      duet_of: null,
      stitch_of: null,
      source: opts.source || 'camera',
      ...(opts.meta || {}),
      created_at: Date.now(),
    },
  };
}

/** Normaliza um clip (não muta a entrada). */
export function makeClip(c = {}) {
  const kind = c.kind === 'image' ? 'image' : 'video';
  const inS = Math.max(0, num(c.in, 0));
  let outS = num(c.out, kind === 'image' ? inS + IMAGE_CLIP_SECONDS : inS);
  if (outS < inS) outS = inS;
  const clip = {
    uri: String(c.uri || ''),
    in: round3(inS),
    out: round3(outS),
    speed: num(c.speed, 1) > 0 ? num(c.speed, 1) : 1,
    mirror: !!c.mirror,
  };
  if (kind === 'image') clip.kind = 'image';
  if (c.w) clip.w = c.w;
  if (c.h) clip.h = c.h;
  if (c.camera) clip.camera = c.camera;
  if (c.thumb) clip.thumb = c.thumb;
  return clip;
}

/** Retorna NOVA EDL com o clip anexado (imutável — seguro p/ setState). */
export function addClip(edl, clip) {
  const next = edl ? { ...edl, clips: [...(edl.clips || [])] } : newEdl();
  next.clips.push(makeClip(clip));
  return next;
}

/** Duração de um clip na timeline (segundos, já com velocidade). */
export function clipDuration(c) {
  if (!c) return 0;
  const sp = num(c.speed, 1) > 0 ? num(c.speed, 1) : 1;
  return Math.max(0, (num(c.out, 0) - num(c.in, 0)) / sp);
}

/** Duração total da EDL (segundos). */
export function duration(edl) {
  if (!edl || !Array.isArray(edl.clips)) return 0;
  return round3(edl.clips.reduce((a, c) => a + clipDuration(c), 0));
}

/** Valida. Retorna { ok, errors: string[] }. Não lança. */
export function validate(edl) {
  const errors = [];
  const e = (m) => errors.push(m);
  if (!edl || typeof edl !== 'object') return { ok: false, errors: ['edl: not an object'] };
  if (edl.v !== EDL_VERSION) e('v: must be 1');
  const cv = edl.canvas || {};
  if (!(cv.w > 0 && cv.h > 0 && cv.fps > 0)) e('canvas: w/h/fps must be > 0');
  if (!Array.isArray(edl.clips) || edl.clips.length === 0) e('clips: at least one clip');
  (edl.clips || []).forEach((c, i) => {
    if (!c || typeof c.uri !== 'string' || !/^(file|https?|content|ph|assets-library|blob|data):/i.test(c.uri)) e(`clips[${i}].uri invalid`);
    if (!(typeof c.in === 'number' && c.in >= 0)) e(`clips[${i}].in invalid`);
    if (!(typeof c.out === 'number' && c.out > c.in)) e(`clips[${i}].out must be > in`);
    if (!(typeof c.speed === 'number' && c.speed >= 0.1 && c.speed <= 4)) e(`clips[${i}].speed out of range`);
    if (typeof c.mirror !== 'boolean') e(`clips[${i}].mirror must be boolean`);
  });
  const a = edl.audio;
  if (!a || typeof a !== 'object') e('audio: missing');
  else {
    if (!(typeof a.original_volume === 'number' && a.original_volume >= 0 && a.original_volume <= 2)) e('audio.original_volume invalid');
    if (a.music != null) {
      if (!a.music.url && !a.music.id) e('audio.music: id or url required');
      if (typeof a.music.start !== 'number' || a.music.start < 0) e('audio.music.start invalid');
    }
    if (a.voiceover != null && !a.voiceover.uri) e('audio.voiceover.uri required');
  }
  if (!edl.filter || typeof edl.filter.id !== 'string') e('filter.id missing');
  if (!Array.isArray(edl.overlays)) e('overlays: must be array');
  else edl.overlays.forEach((o, i) => {
    if (o.type !== 'text' && o.type !== 'sticker') e(`overlays[${i}].type invalid`);
    if (!(o.end > o.start)) e(`overlays[${i}] end must be > start`);
  });
  if (!edl.captions || typeof edl.captions.enabled !== 'boolean') e('captions.enabled missing');
  if (!edl.meta || typeof edl.meta !== 'object') e('meta missing');
  const d = duration(edl);
  if (d > MAX_DURATION_S) e(`duration ${d}s exceeds ${MAX_DURATION_S}s`);
  return { ok: errors.length === 0, errors };
}

/** Cópia profunda segura. */
export function cloneEdl(edl) { return clone(edl); }

function round3(n) { return Math.round(n * 1000) / 1000; }

export default { newEdl, addClip, makeClip, validate, duration, clipDuration, cloneEdl, EDL_VERSION, SPEEDS, FILTER_IDS };
