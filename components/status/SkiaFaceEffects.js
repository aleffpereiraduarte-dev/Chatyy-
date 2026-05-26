// SkiaFaceEffects — worklet drawing routines for the single-camera AR
// status filters. Replaces the MediaPipe second-camera overlay: instead of
// running a separate AVCaptureSession/CameraX session for landmarks and
// painting <Image> overlays on top of the expo-camera preview, we use ONE
// react-native-vision-camera feed, detect faces inside a
// `useSkiaFrameProcessor` worklet, and draw the effect directly into the
// frame's Skia canvas every frame (`frame.render()`). The composited result
// is what the user sees AND what `takePhoto()`/`takeSnapshot()` captures —
// no competing camera session, so no freeze (the MediaPipe single-camera
// contention documented in StatusCamera.takePhoto is gone).
//
// IMPORTANT: every function in this file is a WORKLET (`'worklet'` first
// line) so it can run on Vision Camera's frame-processor thread. They must
// only call other worklets / Skia primitives — no React, no JS-thread state.
//
// The face detector (react-native-vision-camera-face-detector) gives us, per
// face:
//   bounds:        { x, y, width, height }   (pixels, frame space)
//   leftEyePosition / rightEyePosition       { x, y } when landmarks on
//   noseBasePosition                         { x, y }
//   mouthPosition / bottomMouthPosition      { x, y }
//   pitchAngle / yawAngle / rollAngle        degrees (rollAngle = Z/roll)
//
// We anchor each preset to these (mirroring the MediaPipe-era anchor intent):
//   dog_ears     → two ears above bounds top, + nose dot on noseBase
//   cat_whiskers → ears + whiskers from noseBase
//   sunglasses   → bar across leftEye↔rightEye, sized by eye distance
//   heart_eyes   → a heart centered on each eye
//   party_hat    → cone above bounds top-center
//   vampire      → two fangs hanging below mouthPosition
//
// Effect ids are STABLE INTEGERS shared with the JS side via a Skia mutable
// value (see StatusCamera). The frame processor reads the int and switches —
// it NEVER gets recreated when the user changes filter (that recreate is the
// VisionCamera v4 + Skia frameProcessor crash, issue #3606). 0 = none.

import { Skia, PaintStyle } from '@shopify/react-native-skia';

// Stable effect ids — index-aligned with FACE_FILTER_PRESETS in FaceFilters.js.
// Keep in sync. 0 = none (no draw).
export const EFFECT_NONE = 0;
export const EFFECT_DOG = 1;
export const EFFECT_CAT = 2;
export const EFFECT_SUNGLASSES = 3;
export const EFFECT_HEART = 4;
export const EFFECT_PARTY = 5;
export const EFFECT_VAMPIRE = 6;

// Map a preset key (string, from FACE_FILTER_PRESETS) → stable int id.
// Runs on the JS thread (used to set the shared value); not a worklet.
export function effectIdForKey(key) {
  switch (key) {
    case 'dog_ears': return EFFECT_DOG;
    case 'cat_whiskers': return EFFECT_CAT;
    case 'sunglasses': return EFFECT_SUNGLASSES;
    case 'heart_eyes': return EFFECT_HEART;
    case 'party_hat': return EFFECT_PARTY;
    case 'vampire': return EFFECT_VAMPIRE;
    default: return EFFECT_NONE;
  }
}

// ─── color helpers (worklet) ───
function rgb(r, g, b, a) {
  'worklet';
  return Skia.Color(`rgba(${r},${g},${b},${a == null ? 1 : a})`);
}

// Draw a filled triangle (used for ears + party hat) on the canvas.
function fillTriangle(canvas, ax, ay, bx, by, cx, cy, paint) {
  'worklet';
  const path = Skia.Path.Make();
  path.moveTo(ax, ay);
  path.lineTo(bx, by);
  path.lineTo(cx, cy);
  path.close();
  canvas.drawPath(path, paint);
}

// Draw a heart centered at (cx,cy) with the given radius r. Built from two
// circles + a downward triangle — cheap, no asset, mirror-safe.
function drawHeart(canvas, cx, cy, r, paint) {
  'worklet';
  const lobe = r * 0.5;
  canvas.drawCircle(cx - lobe * 0.6, cy - lobe * 0.4, lobe, paint);
  canvas.drawCircle(cx + lobe * 0.6, cy - lobe * 0.4, lobe, paint);
  const path = Skia.Path.Make();
  path.moveTo(cx - r * 0.95, cy - r * 0.05);
  path.lineTo(cx + r * 0.95, cy - r * 0.05);
  path.lineTo(cx, cy + r * 1.05);
  path.close();
  canvas.drawPath(path, paint);
}

// ─── per-effect worklet draws ───
// Each takes the Skia canvas + a single detected face object (detector shape)
// and paints the effect into the live frame. All coordinates are in FRAME
// pixel space (the same space the detector reports), so the effect composites
// 1:1 into the captured snapshot.

function drawDogEars(canvas, face) {
  'worklet';
  const b = face.bounds;
  if (!b) return;
  const w = b.width, x = b.x, y = b.y;
  const earW = w * 0.42;
  const earH = w * 0.55;
  const brown = Skia.Paint(); brown.setColor(rgb(120, 78, 40, 1));
  const tan = Skia.Paint(); tan.setColor(rgb(196, 145, 92, 1));
  // Left ear (triangle pointing up-out)
  fillTriangle(canvas, x + w * 0.10, y + earH * 0.2, x + w * 0.10 + earW, y, x + w * 0.10 + earW * 0.5, y - earH * 0.7, brown);
  fillTriangle(canvas, x + w * 0.18, y + earH * 0.1, x + w * 0.18 + earW * 0.6, y, x + w * 0.18 + earW * 0.35, y - earH * 0.45, tan);
  // Right ear (mirrored)
  fillTriangle(canvas, x + w - (w * 0.10), y + earH * 0.2, x + w - (w * 0.10 + earW), y, x + w - (w * 0.10 + earW * 0.5), y - earH * 0.7, brown);
  fillTriangle(canvas, x + w - (w * 0.18), y + earH * 0.1, x + w - (w * 0.18 + earW * 0.6), y, x + w - (w * 0.18 + earW * 0.35), y - earH * 0.45, tan);
  // Nose dot on noseBase (or bounds center fallback)
  const nb = face.noseBasePosition;
  const nx = nb ? nb.x : x + w / 2;
  const ny = nb ? nb.y : y + b.height * 0.55;
  const noseP = Skia.Paint(); noseP.setColor(rgb(40, 30, 28, 1));
  canvas.drawCircle(nx, ny, w * 0.085, noseP);
}

function drawCatWhiskers(canvas, face) {
  'worklet';
  const b = face.bounds;
  if (!b) return;
  const w = b.width, x = b.x, y = b.y;
  const ear = w * 0.34;
  const grey = Skia.Paint(); grey.setColor(rgb(60, 60, 64, 1));
  const pink = Skia.Paint(); pink.setColor(rgb(240, 160, 170, 1));
  // Pointy cat ears
  fillTriangle(canvas, x + w * 0.12, y + ear * 0.3, x + w * 0.12 + ear, y + ear * 0.3, x + w * 0.12 + ear * 0.5, y - ear * 0.6, grey);
  fillTriangle(canvas, x + w - (w * 0.12), y + ear * 0.3, x + w - (w * 0.12 + ear), y + ear * 0.3, x + w - (w * 0.12 + ear * 0.5), y - ear * 0.6, grey);
  fillTriangle(canvas, x + w * 0.22, y + ear * 0.2, x + w * 0.22 + ear * 0.5, y + ear * 0.2, x + w * 0.22 + ear * 0.25, y - ear * 0.2, pink);
  fillTriangle(canvas, x + w - (w * 0.22), y + ear * 0.2, x + w - (w * 0.22 + ear * 0.5), y + ear * 0.2, x + w - (w * 0.22 + ear * 0.25), y - ear * 0.2, pink);
  // Nose + whiskers off noseBase
  const nb = face.noseBasePosition;
  const nx = nb ? nb.x : x + w / 2;
  const ny = nb ? nb.y : y + b.height * 0.55;
  const noseP = Skia.Paint(); noseP.setColor(rgb(240, 160, 170, 1));
  canvas.drawCircle(nx, ny, w * 0.06, noseP);
  const line = Skia.Paint();
  line.setColor(rgb(255, 255, 255, 0.92));
  line.setStyle(PaintStyle.Stroke); // stroke
  line.setStrokeWidth(Math.max(2, w * 0.012));
  const len = w * 0.42;
  for (let i = -1; i <= 1; i++) {
    const dy = i * w * 0.06;
    canvas.drawLine(nx - w * 0.08, ny + dy, nx - w * 0.08 - len, ny + dy - i * w * 0.04, line);
    canvas.drawLine(nx + w * 0.08, ny + dy, nx + w * 0.08 + len, ny + dy - i * w * 0.04, line);
  }
}

function drawSunglasses(canvas, face) {
  'worklet';
  const le = face.leftEyePosition;
  const re = face.rightEyePosition;
  const b = face.bounds;
  let cxL, cyL, cxR, cyR, lensR;
  if (le && re) {
    cxL = le.x; cyL = le.y; cxR = re.x; cyR = re.y;
    const dx = re.x - le.x, dy = re.y - le.y;
    const ipd = Math.sqrt(dx * dx + dy * dy) || (b ? b.width * 0.45 : 80);
    lensR = ipd * 0.42;
  } else if (b) {
    cxL = b.x + b.width * 0.32; cyL = b.y + b.height * 0.42;
    cxR = b.x + b.width * 0.68; cyR = cyL;
    lensR = b.width * 0.18;
  } else { return; }
  const lens = Skia.Paint(); lens.setColor(rgb(15, 15, 20, 0.88));
  const frame = Skia.Paint();
  frame.setColor(rgb(10, 10, 10, 1)); frame.setStyle(PaintStyle.Stroke);
  frame.setStrokeWidth(Math.max(3, lensR * 0.22));
  canvas.drawCircle(cxL, cyL, lensR, lens);
  canvas.drawCircle(cxR, cyR, lensR, lens);
  canvas.drawCircle(cxL, cyL, lensR, frame);
  canvas.drawCircle(cxR, cyR, lensR, frame);
  // Bridge
  canvas.drawLine(cxL + lensR, cyL, cxR - lensR, cyR, frame);
}

function drawHeartEyes(canvas, face) {
  'worklet';
  const le = face.leftEyePosition;
  const re = face.rightEyePosition;
  const b = face.bounds;
  let r;
  const heart = Skia.Paint(); heart.setColor(rgb(235, 30, 80, 0.92));
  if (le && re) {
    const dx = re.x - le.x, dy = re.y - le.y;
    const ipd = Math.sqrt(dx * dx + dy * dy) || (b ? b.width * 0.45 : 80);
    r = ipd * 0.32;
    drawHeart(canvas, le.x, le.y, r, heart);
    drawHeart(canvas, re.x, re.y, r, heart);
  } else if (b) {
    r = b.width * 0.14;
    drawHeart(canvas, b.x + b.width * 0.32, b.y + b.height * 0.42, r, heart);
    drawHeart(canvas, b.x + b.width * 0.68, b.y + b.height * 0.42, r, heart);
  }
}

function drawPartyHat(canvas, face) {
  'worklet';
  const b = face.bounds;
  if (!b) return;
  const cx = b.x + b.width / 2;
  const topY = b.y;
  const hatW = b.width * 0.7;
  const hatH = b.width * 0.95;
  const cone = Skia.Paint(); cone.setColor(rgb(124, 58, 237, 1)); // brand purple
  fillTriangle(canvas, cx - hatW / 2, topY, cx + hatW / 2, topY, cx, topY - hatH, cone);
  // pom-pom
  const pom = Skia.Paint(); pom.setColor(rgb(236, 72, 153, 1));
  canvas.drawCircle(cx, topY - hatH, hatW * 0.12, pom);
  // stripes
  const stripe = Skia.Paint(); stripe.setColor(rgb(255, 255, 255, 0.85));
  stripe.setStyle(PaintStyle.Stroke); stripe.setStrokeWidth(Math.max(2, hatW * 0.03));
  for (let i = 1; i <= 3; i++) {
    const f = i / 4;
    canvas.drawLine(cx - (hatW / 2) * (1 - f), topY - hatH * f, cx + (hatW / 2) * (1 - f), topY - hatH * f, stripe);
  }
}

function drawVampire(canvas, face) {
  'worklet';
  const mp = face.bottomMouthPosition || face.mouthPosition;
  const b = face.bounds;
  let mx, my, w;
  if (mp) {
    mx = mp.x; my = mp.y; w = b ? b.width : 120;
  } else if (b) {
    mx = b.x + b.width / 2; my = b.y + b.height * 0.78; w = b.width;
  } else { return; }
  const fang = Skia.Paint(); fang.setColor(rgb(255, 255, 255, 1));
  const fw = w * 0.07;
  const fh = w * 0.16;
  // left + right fang hanging from the mouth
  fillTriangle(canvas, mx - w * 0.12 - fw / 2, my, mx - w * 0.12 + fw / 2, my, mx - w * 0.12, my + fh, fang);
  fillTriangle(canvas, mx + w * 0.12 - fw / 2, my, mx + w * 0.12 + fw / 2, my, mx + w * 0.12, my + fh, fang);
  // subtle red lips line
  const lip = Skia.Paint(); lip.setColor(rgb(150, 10, 20, 0.55));
  lip.setStyle(PaintStyle.Stroke); lip.setStrokeWidth(Math.max(2, w * 0.02));
  canvas.drawLine(mx - w * 0.18, my - fh * 0.2, mx + w * 0.18, my - fh * 0.2, lip);
}

// Dispatch: draw the effect with the given int id for one face.
// WORKLET — called from the frame processor. Switching effect = passing a
// different `effectId` here, NOT recreating the frame processor.
export function drawEffect(canvas, face, effectId) {
  'worklet';
  if (!face || !effectId) return;
  if (effectId === EFFECT_DOG) drawDogEars(canvas, face);
  else if (effectId === EFFECT_CAT) drawCatWhiskers(canvas, face);
  else if (effectId === EFFECT_SUNGLASSES) drawSunglasses(canvas, face);
  else if (effectId === EFFECT_HEART) drawHeartEyes(canvas, face);
  else if (effectId === EFFECT_PARTY) drawPartyHat(canvas, face);
  else if (effectId === EFFECT_VAMPIRE) drawVampire(canvas, face);
}
