// [2026-10-15 native-attach] Ponte JS ↔ modules/expo-chat-attach.
//
// • <NativeAttachSheet/>: quando o AttachmentMenu (app/chat-conversation.js)
//   fica visível, abre a folha NATIVA (grade de recentes + câmera ao vivo +
//   seleção numerada + legenda/HD/arquivo) e traduz o resultado para os MESMOS
//   handlers do sheet JS: onPick(key) (Arquivo, Localização, Contato, Enquete,
//   Música, Câmera…), onSendMedia(files) (toque longo → MediaPreview) e
//   onSendDirect(files, { caption, hd, asFile }) (Enviar direto da folha →
//   mesmo envio do MediaPreview → uploadAndSendFile → mediaSendQueue).
//   Erro / não apresentou → onFail() e o chamador mostra o sheet JS.
// • openNativeCamera(): câmera nativa (foto/vídeo segurando/zoom/flash/flip/
//   recentes). null = indisponível ou falhou → chamador usa a câmera JS.
//
// Binário sem o módulo / web / globalThis.__chatyy_native_attach === false →
// nativeAttachUsable() === false e nada aqui é usado (comportamento idêntico).
import { useEffect, useRef } from 'react';
import { DeviceEventEmitter, Platform } from 'react-native';

let _na; // undefined = não tentou, null = indisponível
function getNA() {
  if (_na !== undefined) return _na;
  _na = null;
  if (Platform.OS === 'web') return _na;
  try {
    // eslint-disable-next-line global-require
    const m = require('../../modules/expo-chat-attach');
    if (m && typeof m.isAvailable === 'function') _na = m;
  } catch { _na = null; }
  return _na;
}

export function nativeAttachUsable() {
  try {
    if (globalThis.__chatyy_native_attach === false) return false;
    const m = getNA();
    return !!(m && m.isAvailable());
  } catch { return false; }
}

// [2026-10-21 attach-cam] Quadro de câmera AO VIVO na grade do "+" e pré-aquecimento da sessão ao abrir a
// conversa ligavam/desligavam a câmera (bolinha verde piscando) e travavam a folha (print do founder 21/10).
// Desligados por padrão; a câmera segue no ícone do composer e no botão Câmera. Religar:
// globalThis.__chatyy_attach_cam_tile = true (quadro) / __chatyy_cam_prewarm = true (pré-aquecer).
function _camTileOn() { try { return globalThis.__chatyy_attach_cam_tile === true; } catch { return false; } }
function _camPrewarmOn() { try { return globalThis.__chatyy_cam_prewarm === true; } catch { return false; } }
export function nativeCameraUsable() {
  try {
    if (globalThis.__chatyy_native_attach === false || globalThis.__chatyy_native_camera === false) return false;
    const m = getNA();
    return !!(m && m.isCameraAvailable());
  } catch { return false; }
}

function tt(t, key, fallback) {
  try {
    const v = typeof t === 'function' ? t(key) : null;
    return (typeof v === 'string' && v && v !== key) ? v : fallback;
  } catch { return fallback; }
}

function isInCall() {
  try {
    if (globalThis.__chatyyNativeCallActive) return true;
    // eslint-disable-next-line global-require
    const cs = require('../../services/callState');
    const s = cs.getCallState && cs.getCallState();
    return s === 'active' || s === 'answered' || s === 'ringing';
  } catch { return false; }
}

function isDarkColors(colors) {
  const bg = String((colors && (colors.background || colors.surface)) || '#ffffff').replace('#', '');
  if (bg.length < 6) return false;
  const r = parseInt(bg.slice(0, 2), 16), g = parseInt(bg.slice(2, 4), 16), b = parseInt(bg.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) < 96;
}

function hex(c, fallback) {
  const s = typeof c === 'string' ? c.trim() : '';
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s) ? s : fallback;
}

/** Textos já traduzidos para o nativo (chaves = as que o Swift/Kotlin leem). */
export function nativeAttachLabels(t) {
  return {
    close: tt(t, 'common.close', 'Fechar'),
    recents: tt(t, 'chat.nattach.recents', 'Recentes'),
    selectedCount: tt(t, 'chat.nattach.selectedCount', '{count} selecionados'),
    limited: tt(t, 'chat.nattach.limited', 'Você permitiu acesso a algumas fotos.'),
    manage: tt(t, 'chat.nattach.manage', 'Gerenciar'),
    permPrompt: tt(t, 'chat.nattach.permPrompt', 'Permita o acesso às fotos para enviar as mais recentes com um toque.'),
    permAllow: tt(t, 'chat.nattach.permAllow', 'Permitir acesso'),
    permDenied: tt(t, 'chat.nattach.permDenied', 'O acesso às fotos está desativado. Ative nos Ajustes para ver suas fotos aqui.'),
    permSettings: tt(t, 'chat.nattach.permSettings', 'Abrir Ajustes'),
    hd: 'HD',
    asFile: tt(t, 'chat.nattach.asFile', 'Enviar como arquivo'),
    caption: tt(t, 'chatConv.addCaption', 'Adicionar legenda...'),
    send: tt(t, 'common.send', 'Enviar'),
    camera: tt(t, 'chatConv.camera', 'Câmera'),
    photos: tt(t, 'chatConv.photos', 'Fotos'), // [2026-10-20 attach-freeze] galleryMode
    albums: tt(t, 'chatConv.albums', 'Álbuns'),
    allPhotos: tt(t, 'chatConv.recents', 'Recentes'),
    gallery: tt(t, 'chatConv.gallery', 'Galeria'),
    photo: tt(t, 'chat.nattach.photo', 'Foto'),
    video: tt(t, 'chat.nattach.video', 'Vídeo'),
    flashOn: tt(t, 'chat.nattach.flashOn', 'Flash ligado'),
    flashOff: tt(t, 'chat.nattach.flashOff', 'Flash desligado'),
    flashAuto: tt(t, 'chat.nattach.flashAuto', 'Flash automático'),
    flip: tt(t, 'chat.nattach.flip', 'Trocar câmera'),
    hint: tt(t, 'chat.nattach.hint', 'Segure para vídeo, toque para foto'),
    shutter: tt(t, 'chat.nattach.hint', 'Segure para vídeo, toque para foto'),
    permCamTitle: tt(t, 'chat.nattach.permCamTitle', 'Permita o acesso à câmera'),
    permCamBody: tt(t, 'chat.nattach.permCamBody', 'Para tirar fotos e gravar vídeos no chat, ative a câmera nos Ajustes.'),
  };
}

function themeFor(colors) {
  const dark = isDarkColors(colors);
  const c = colors || {};
  return {
    dark,
    colors: {
      // Mesmo fundo do sheet JS (overlayColors.sheetBg) — P&B.
      bg: dark ? '#1c1c1e' : '#ffffff',
      surface: dark ? '#2c2c2e' : '#f4f4f5',
      text: hex(c.text, dark ? '#F5F5F7' : '#111111'),
      textSecondary: hex(c.textSecondary, dark ? '#8E8E93' : '#667781'),
      border: dark ? '#FFFFFF1A' : '#00000014',
      chip: dark ? '#2c2c2e' : '#f2f2f4',
    },
  };
}

/** Item nativo → descritor de arquivo igual ao do handleGallery. */
function toFiles(items, extra) {
  return (Array.isArray(items) ? items : []).filter((it) => it && it.uri).map((it) => ({
    uri: it.uri,
    name: it.name || `media_${Date.now()}.${it.mediaType === 'video' ? 'mp4' : 'jpg'}`,
    type: it.type || (it.mediaType === 'video' ? 'video/mp4' : 'image/jpeg'),
    size: Number(it.size) || 0,
    blob: null,
    width: Number(it.width) || undefined,
    height: Number(it.height) || undefined,
    duration: it.duration != null ? Number(it.duration) : undefined,
    ...(extra || null),
  }));
}

/**
 * Câmera nativa. Resolve { action, files } ou null (indisponível / erro →
 * o chamador usa a câmera JS). action: 'capture' | 'pick' | 'gallery' | 'cancel'.
 */
export async function openNativeCamera(t, opts = {}) {
  const m = getNA();
  if (!m || !nativeCameraUsable()) return null;
  try {
    const r = await m.openCamera({
      labels: nativeAttachLabels(t),
      dark: true,
      maxVideoSec: opts.maxVideoSec || 60,
      maxSelect: 30,
      withAudio: opts.withAudio != null ? !!opts.withAudio : !isInCall(),
      ...(opts.inKeyboardWindow ? { inKeyboardWindow: true } : null), // [2026-10-20 attach-inwindow]
    });
    if (!r || !r.action) return null;
    return { action: r.action, files: toFiles(r.items) };
  } catch (e) {
    if (__DEV__) console.warn('[native-camera] failed', e?.message || e);
    return null;
  }
}

// [2026-10-21 attach-instant-tg] 1 beacon por abertura da folha armada:
// "attach_open tgwin js=<toque JS→onArmedShown> imm=0|1 wait=<espera do
// teclado> show=… anim=… fetch=… assets=… n=<balde da biblioteca>" (ms).
// [2026-10-21 attach-recents-cache] REGRESSÃO 759 (attach api 12): a folha entra
// no toque mas a grade fica só com o tile da câmera por 1,1-1,6 s na 1ª/2ª
// abertura (beacon attach_open fetch=1601/688 → 95 quente): PhotoKit frio no
// processo. api 12 (sem cache nativo): aquece o PhotoKit pelo expo-media-library
// (mesma ordenação/filtro, first 1, fora do main, sem prompt) quando a conversa
// arma a folha. api >= 13 aquece no nativo (armSheet). Kill switch OTA:
// globalThis.__chatyy_attach_gallery_prewarm = false.
let _galleryWarmAt = 0;
// [2026-10-21 attach-first-frame] OTA p/ 759 (api 12): mesmo com o fetch
// quente (beacon 12:07Z fetch=81 assets=109) o print do founder segue com a
// grade VAZIA (só o tile da câmera; pixels 100% brancos = nenhuma célula) — o
// reload assíncrono da api 12 não chega à tela de forma confiável. Com o
// PhotoKit comprovadamente quente (2ª consulta < 150 ms) a folha volta ao
// fetch NO MAIN dentro do viewDidLoad (caminho da api 11: grade montada antes
// do 1º quadro; custo ~0,05-0,1 s no toque). Frio = continua assíncrono (não
// trava o toque 1,6 s). Kill: __chatyy_attach_sync_fetch = false (nunca) /
// true (sempre).
let _galleryWarmMs = -1;
let _galleryWarmOkAt = 0;
let _lastArmSync = 0;
function galleryWarm() { return _galleryWarmMs >= 0 && _galleryWarmMs < 150 && Date.now() - _galleryWarmOkAt < 5 * 60000; }
function prewarmGalleryJS(onWarm) {
  try { if (globalThis.__chatyy_attach_gallery_prewarm === false) return; } catch {}
  const now = Date.now();
  if (now - _galleryWarmAt < 60000) { if (onWarm && galleryWarm()) onWarm(); return; }
  _galleryWarmAt = now;
  (async () => {
    try {
      // eslint-disable-next-line global-require
      const ML = require('expo-media-library');
      if (!ML || typeof ML.getAssetsAsync !== 'function' || typeof ML.getPermissionsAsync !== 'function') return;
      const p = await ML.getPermissionsAsync();
      if (!p || (!p.granted && p.accessPrivileges !== 'limited')) { _galleryWarmAt = 0; return; }
      const q = {
        first: 1,
        sortBy: [[(ML.SortBy && ML.SortBy.creationTime) || 'creationTime', false]],
        mediaType: [(ML.MediaType && ML.MediaType.photo) || 'photo', (ML.MediaType && ML.MediaType.video) || 'video'],
      };
      await ML.getAssetsAsync(q); // 1ª: paga o PhotoKit frio
      const t0 = Date.now();
      await ML.getAssetsAsync(q); // 2ª: mede o custo quente (fetch ordenado + .count)
      _galleryWarmMs = Date.now() - t0;
      _galleryWarmOkAt = Date.now();
      if (onWarm && galleryWarm()) onWarm();
    } catch { _galleryWarmAt = 0; }
  })();
}

function reportArmMetric(mm, timing) {
  if (!mm) return;
  try { if (globalThis.__chatyy_attach_metric === false) return; } catch {}
  const parts = [];
  const sh = mm.shown;
  if (sh) {
    parts.push(`js=${Math.max(0, Math.round(sh.js))}`, `imm=${sh.imm}`);
    if (sh.waitMs != null) parts.push(`wait=${Number(sh.waitMs) || 0}`);
  } else {
    parts.push('js=-');
  }
  const tm = timing && typeof timing === 'object' ? timing : null;
  if (tm) ['show', 'anim', 'fetch', 'assets', 'n', 'cache', 'snap', 'fix', 'vis'].forEach((k) => { if (tm[k] != null) parts.push(`${k}=${Number(tm[k])}`); });
  let api = 0;
  try { api = Number(getNA().apiVersion()) || 0; } catch {}
  parts.push(`api=${api}`);
  if (api === 12) parts.push(`sf=${_lastArmSync}`, `gw=${_galleryWarmMs}`); // [2026-10-21 attach-first-frame]
  // eslint-disable-next-line global-require
  require('../../services/nativeTelemetry').nativeBeacon('attach_open', 'tgwin', parts.join(' '));
}

export default function NativeAttachSheet({
  visible, onClose, onPick, onSendMedia, onSendDirect, onFail, colors, items, t, instantRef,
}) {
  const openRef = useRef(false);
  const propsRef = useRef(null);
  propsRef.current = { onClose, onPick, onSendMedia, onSendDirect, onFail, colors, items, t };
  const openNowRef = useRef(null);
  const hdDefaultRef = useRef(false); // [2026-10-20 attach-armed]
  const handleResultRef = useRef(null);
  const armIdRef = useRef('arm_' + Math.random().toString(36).slice(2));
  // [2026-10-21 attach-instant-tg] medição em produção do "+" → folha (beacon
  // attach_open, teto 12/sessão): js = toque chegou no JS → onArmedShown
  // (api 11 = espera da descida do teclado antes de a folha entrar); api 12
  // manda show/anim/fetch/assets em ms desde o toque nativo.
  const armMetricRef = useRef(null);

  // Sessão de câmera pré-configurada: abrir a câmera/tile depois é "quente".
  useEffect(() => {
    const m = getNA();
    if (!m || !_camPrewarmOn()) return undefined;
    const id = setTimeout(() => { try { m.prewarmCamera(); } catch {} }, 1500);
    return () => {
      clearTimeout(id);
      try { m.releaseCamera(); } catch {}
    };
  }, []);

  // [2026-10-19 attach-instant] Abre a folha nativa JÁ (sem esperar o render da
  // conversa com visible=true): true = apresentação começou. O pai seta o
  // visible logo depois só para manter o estado; o efeito abaixo vê openRef.
  // [2026-10-19 attach-over-kb] opts.overKeyboard = folha numa janela acima do
  // teclado (composer api 9 mantém o teclado aberto por baixo).
  // [2026-10-20 attach-armed] opções da folha (mesmas p/ abrir pelo JS ou armar no nativo).
  const buildOptions = (opts) => {
    const p = propsRef.current;
    const th = themeFor(p.colors);
    let actions = (Array.isArray(p.items) ? p.items : [])
      .filter((it) => it && it.key)
      .map((it) => ({ key: String(it.key), label: String(it.label || it.key) }));
    // [2026-10-20 attach-tg] Folha do "+" no estilo Telegram: abas Galeria,
    // Arquivo, Localização, Contato, Enquete, Evento, Playlist, Jogos (câmera é
    // o 1º quadrado da grade; GIF fica no painel de emoji). Kill switch OTA:
    // globalThis.__chatyy_attach_tg = false (= ordem/rótulos antigos).
    let _tg = !(opts && opts.gallery);
    try { if (globalThis.__chatyy_attach_tg === false) _tg = false; } catch {}
    if (_tg) {
      const _ct = _camTileOn(); // [2026-10-21 attach-cam] sem o quadro ao vivo → botão Câmera volta à faixa
      const order = _ct ? ['gallery', 'file', 'location', 'contact', 'poll', 'meetup', 'playlist', 'games'] : ['gallery', 'camera', 'file', 'location', 'contact', 'poll', 'meetup', 'playlist', 'games'];
      const rename = { meetup: tt(p.t, 'chatConv.event', 'Evento') };
      const by = {};
      actions.forEach((a) => { by[a.key] = a; });
      const out = [];
      order.forEach((k) => { if (by[k]) out.push({ key: k, label: rename[k] || by[k].label }); });
      actions.forEach((a) => { if (!order.includes(a.key) && a.key !== 'gif' && (a.key !== 'camera' || !_ct)) out.push(a); });
      actions = out;
    }
    // [assistir-junto 2026-10-20] chaves sem ícone no binário → apelido que ele já desenha (ver watchTogether.attachAliasKey)
    try { const WTa = require('../../services/watchTogether'); actions = actions.map((x) => ({ ...x, key: WTa.attachAliasKey(x.key) })); } catch {}
    let _hdDefault = false;
    try { _hdDefault = require('../../services/mediaUploadQuality').defaultUploadLevel() !== 'standard'; } catch {}
    hdDefaultRef.current = _hdDefault;
    return {
      actions,
      labels: nativeAttachLabels(p.t),
      dark: th.dark,
      colors: th.colors,
      maxSelect: 30,
      // [2026-10-19 media-quality] chip HD começa no nível salvo (Wi-Fi/dados)
      hdDefault: _hdDefault,
      allowCamera: _camTileOn(),
      ...(opts && opts.overKeyboard ? { overKeyboard: true } : null),
      // [2026-10-20 attach-freeze] "Fotos" do painel = SÓ a galeria: sem
      // barra de ações e sem tile de câmera (vale no 744 por OTA);
      // attach api >= 7: galleryMode = cabeçalho X | Fotos/Álbuns | HD,
      // altura grande e sem a faixa vazia embaixo.
      ...(opts && opts.gallery ? { actions: [], allowCamera: false, galleryMode: true } : null),
      ...(opts && opts.inKeyboardWindow ? { inKeyboardWindow: true } : null), // [2026-10-20 attach-inwindow]
      ...(_tg ? { tgHeader: true } : null), // [2026-10-20 attach-tg] attach api >= 9
      // [2026-10-16 motion-attach] botões em cascata; kill switch OTA
      // globalThis.__chatyy_motion_attach = false (chave ausente = ligado).
      ...((() => { try { return globalThis.__chatyy_motion_attach === false || globalThis.__chatyy_motion === false; } catch { return false; } })() ? { motion: false } : null),
    };
  };

  // Resultado da folha (promessa do openSheet OU evento onArmedResult).
  const handleResult = (r) => {
    openRef.current = false;
    const cur = propsRef.current;
    const _hdDefault = hdDefaultRef.current;
    if (!r || !r.action) { try { cur.onFail && cur.onFail(); } catch {} return; }
    // [2026-10-19 attach-close] Cancelar: o setState que fecha o menu
    // re-renderiza a conversa inteira (JS + mount no main). Adiado 2 quadros
    // para nunca cair no último quadro do dismiss/esmaecer. Ação/Enviar
    // seguem na hora (abrem Galeria/Arquivo/envio). Kill switch OTA:
    // globalThis.__chatyy_attach_close_defer = false.
    const closeNow = () => {
      try { cur.onClose && cur.onClose(); } catch {}
      // [2026-10-18 kb-resume] folha já dispensada (promessa resolve no fim do
      // dismiss): a conversa devolve o teclado só se cancelou e ele estava aberto.
      try { DeviceEventEmitter.emit('chatyy:attachSheetClosed', { action: String(r.action) }); } catch {}
    };
    let _defer = r.action === 'cancel' && typeof requestAnimationFrame === 'function';
    try { if (globalThis.__chatyy_attach_close_defer === false) _defer = false; } catch {}
    if (_defer) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (openRef.current) return; // outra folha já abriu nesse meio-tempo
        closeNow();
      }));
      return;
    }
    closeNow();
    try {
      if (r.action === 'action' && r.key) {
        cur.onPick && cur.onPick(r.key);
      } else if (r.action === 'send') {
        // [2026-10-19 media-quality] chip intocado = nível salvo (Padrão/HD/Full HD
        // por rede); mexeu = _hd explícito (ligado = HD ou o Full HD salvo,
        // desligado = Padrão). "Como arquivo" = original, sem compressão.
        const _hdTouched = typeof r.hd === 'boolean' && r.hd !== _hdDefault;
        const files = toFiles(r.items, { ...(_hdTouched ? { _hd: !!r.hd } : null), ...(r.asFile ? { _asFile: true } : null) });
        if (typeof cur.onSendDirect === 'function') cur.onSendDirect(files, { caption: r.caption || '', hd: !!r.hd, asFile: !!r.asFile });
        else if (typeof cur.onSendMedia === 'function') cur.onSendMedia(files);
      } else if (r.action === 'preview') {
        const files = toFiles(r.items);
        if (files.length && typeof cur.onSendMedia === 'function') cur.onSendMedia(files);
      }
    } catch (e) {
      if (__DEV__) console.warn('[native-attach] result handler failed', e?.message || e);
    }
  };
  handleResultRef.current = handleResult;

  // [2026-10-19 attach-instant] Abre a folha nativa JÁ (sem esperar o render da
  // conversa com visible=true): true = apresentação começou. O pai seta o
  // visible logo depois só para manter o estado; o efeito abaixo vê openRef.
  // [2026-10-19 attach-over-kb] opts.overKeyboard = folha numa janela acima do
  // teclado (composer api 9 mantém o teclado aberto por baixo).
  // [2026-10-20 attach-armed] opts.alreadyOpen = o nativo já apresentou a folha
  // armada no toque do "+"; o resultado chega por onArmedResult.
  openNowRef.current = (opts) => {
    if (openRef.current) return true;
    // [2026-10-21 attach-android-armed] Android: o "+" do composer nativo (api 8)
    // já apresentou a folha armada no toque; a conversa (onAttach{nativeOpened})
    // chama open() sem saber — pergunta ao nativo (síncrono) e não abre outra.
    if (Platform.OS === 'android' && !(opts && opts.alreadyOpen)) {
      try {
        const m0 = getNA();
        if (m0 && typeof m0.isArmedOpen === 'function' && m0.isArmedOpen(armIdRef.current)) opts = { ...(opts || null), alreadyOpen: true };
      } catch {}
    }
    if (opts && opts.alreadyOpen) {
      openRef.current = true;
      // teclado fechado: onArmedShown chega ANTES do onAttach (mesmo toque) → já existe
      const cur0 = armMetricRef.current;
      if (!cur0 || Date.now() - cur0.at > 2000) armMetricRef.current = { at: Date.now(), shown: null };
      return true;
    }
    const m = getNA();
    if (!m) return false;
    openRef.current = true;
    const options = buildOptions(opts);
    (async () => {
      let r = null;
      try {
        r = await m.openSheet(options);
      } catch (e) {
        if (__DEV__) console.warn('[native-attach] openSheet failed', e?.message || e);
        r = null;
      }
      handleResult(r);
    })();
    return true;
  };

  // [2026-10-21 attach-android-armed] Android: attach api >= 4 + composer api >= 8
  // = o "+" apresenta a folha pré-montada NO MESMO QUADRO do toque (sem ida ao
  // JS), IME descendo em paralelo. Fora do painel de anexos (attachPanel) e do
  // "+" instantâneo desligado. Kill switches OTA:
  // globalThis.__chatyy_attach_android_armed = false (= onAttach → openSheet) ·
  // globalThis.__chatyy_attach_tgwin_wait = true (entra só após o IME descer) ·
  // globalThis.__chatyy_attach_android_prebuild = false (monta no toque).
  const armAndroid = (m) => {
    let on = true;
    try { if (globalThis.__chatyy_attach_android_armed === false || globalThis.__chatyy_attach_armed === false) on = false; } catch {}
    try { if (m.apiVersion() < 4) on = false; } catch { on = false; }
    try {
      const kn = require('../../utils/kbNativeTransitions');
      if (kn.nativeComposerApi() < 8) on = false;
      if (!kn.androidAttachInstantOn()) on = false;
      if (kn.androidAttachPanelOn && kn.androidAttachPanelOn()) on = false;
    } catch { on = false; }
    if (!on) return undefined;
    const id = armIdRef.current;
    const extra = {};
    try { if (globalThis.__chatyy_attach_tgwin_wait === true) extra.tgWaitKeyboard = true; } catch {}
    try { if (globalThis.__chatyy_attach_android_prebuild === false) extra.noPrebuild = true; } catch {}
    try { m.armSheet(id, { ...buildOptions(null), ...extra }); } catch {}
    return () => { try { m.armSheet(id, null); } catch {} };
  };

  // [2026-10-20 attach-armed] arma a folha no nativo (composer api 14 + attach
  // api 10): o "+" a apresenta no mesmo toque. Kill switch OTA:
  // globalThis.__chatyy_attach_armed = false.
  const armKey = JSON.stringify([
    (Array.isArray(items) ? items : []).map((it) => it && it.key),
    colors && colors.background, colors && colors.text,
  ]);
  useEffect(() => {
    const m = getNA();
    if (!m || typeof m.armSheet !== 'function') return undefined;
    if (Platform.OS === 'android') return armAndroid(m); // [2026-10-21 attach-android-armed]
    if (Platform.OS !== 'ios') return undefined;
    let on = true;
    try { if (globalThis.__chatyy_attach_armed === false) on = false; } catch {}
    try { if (m.apiVersion() < 10) on = false; } catch { on = false; }
    try { if (require('../../utils/kbNativeTransitions').nativeComposerApi() < 14) on = false; } catch { on = false; }
    if (!on) return undefined;
    const id = armIdRef.current;
    // [2026-10-20 attach-tgwin] attach api >= 11: folha na janela do app,
    // nasce do "+" depois de o teclado descer (Telegram). Kill switch OTA:
    // globalThis.__chatyy_attach_tgwin = false (= present da api 10).
    let tgw = false;
    try { tgw = m.apiVersion() >= 11 && globalThis.__chatyy_attach_tgwin !== false; } catch { tgw = false; }
    // [2026-10-21 attach-instant-tg] attach api >= 12: a folha entra no MESMO
    // toque (sem esperar o teclado descer). Kill switches OTA:
    // globalThis.__chatyy_attach_tgwin_wait = true (= espera antiga do 752) ·
    // globalThis.__chatyy_attach_sync_fetch = true (= fetch da galeria no main).
    let tgExtra = null;
    if (tgw) {
      tgExtra = { tgWindow: true };
      try { if (globalThis.__chatyy_attach_tgwin_wait === true) tgExtra.tgWaitKeyboard = true; } catch {}
    }
    let galleryOff = false;
    try { galleryOff = globalThis.__chatyy_attach_gallery_prewarm === false; } catch {}
    let api12 = false;
    try { api12 = m.apiVersion() === 12; } catch {}
    let syncMode = 'auto'; // [2026-10-21 attach-first-frame]
    try {
      if (globalThis.__chatyy_attach_sync_fetch === true) syncMode = 'on';
      else if (globalThis.__chatyy_attach_sync_fetch === false) syncMode = 'off';
    } catch {}
    const arm = (sync) => {
      const ex = { ...tgExtra };
      if (tgw && sync) ex.syncFetch = true;
      if (tgw && api12) _lastArmSync = ex.syncFetch ? 1 : 0;
      try { m.armSheet(id, { ...buildOptions(null), ...ex, ...(galleryOff ? { galleryPrewarm: false } : null) }); } catch {}
    };
    let alive = true;
    arm(syncMode === 'on' || (api12 && syncMode === 'auto' && galleryWarm()));
    // [2026-10-21 attach-recents-cache] api 12 = sem cache nativo → aquece pelo JS
    // (depois do 1º render da conversa); quente → rearma com o fetch síncrono.
    let warmT = null;
    if (api12) {
      warmT = setTimeout(() => prewarmGalleryJS(() => {
        if (alive && tgw && syncMode === 'auto' && !_lastArmSync) arm(true);
      }), 600);
    }
    return () => { alive = false; if (warmT) clearTimeout(warmT); try { m.armSheet(id, null); } catch {} };
  }, [armKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const m = getNA();
    if (!m || typeof m.addArmedListener !== 'function') return undefined;
    const sub = m.addArmedListener((e) => {
      if (!e || e.id !== armIdRef.current) return;
      // [2026-10-20 attach-tgwin] chat volta a seguir o teclado só depois que
      // ele (legenda da folha) terminou de descer.
      const release = () => { try { require('../../utils/threadKeyboard').threadKbIgnoreKeyboard(false); } catch {} };
      let vis = false;
      try { vis = !!require('react-native').Keyboard.isVisible(); } catch {}
      if (vis) {
        let sub2 = null;
        const tm = setTimeout(() => { try { sub2 && sub2.remove(); } catch {} release(); }, 700);
        try { sub2 = require('react-native').Keyboard.addListener('keyboardDidHide', () => { clearTimeout(tm); try { sub2.remove(); } catch {} release(); }); } catch {}
      } else {
        release();
      }
      try { reportArmMetric(armMetricRef.current, e.timing); } catch {}
      armMetricRef.current = null;
      try { handleResultRef.current && handleResultRef.current(e.result || null); } catch {}
    });
    const sub3 = typeof m.addArmedShownListener === 'function' ? m.addArmedShownListener((e) => {
      if (!e || e.id !== armIdRef.current) return;
      try {
        let mm = armMetricRef.current;
        if (!mm || Date.now() - mm.at > 2000) { mm = { at: Date.now(), shown: null }; armMetricRef.current = mm; }
        if (!mm.shown) mm.shown = { js: Date.now() - mm.at, imm: e.immediate === true ? 1 : 0, showMs: e.showMs, waitMs: e.waitMs };
      } catch {}
      try { require('../../utils/threadKeyboard').threadKbIgnoreKeyboard(true); } catch {}
    }) : null;
    return () => { try { sub && sub.remove && sub.remove(); } catch {} try { sub3 && sub3.remove && sub3.remove(); } catch {} };
  }, []);

  useEffect(() => {
    if (!instantRef || typeof instantRef !== 'object') return undefined;
    const fn = (opts) => { try { return !!(openNowRef.current && openNowRef.current(opts)); } catch { return false; } };
    instantRef.current = fn;
    return () => { if (instantRef.current === fn) instantRef.current = null; };
  }, [instantRef]);

  useEffect(() => {
    if (!visible || openRef.current) return;
    if (!getNA()) { try { propsRef.current.onFail && propsRef.current.onFail(); } catch {} return; }
    openNowRef.current();
  }, [visible]);

  // O pai fechou enquanto a folha nativa estava aberta (troca de tela etc.).
  useEffect(() => {
    if (visible || !openRef.current) return;
    const m = getNA();
    try { m && m.dismiss(); } catch {}
  }, [visible]);

  return null;
}
