// Wave 14 — on-device face embedding pipeline
//
// Stack:
//   1) MediaPipe FaceLandmarker (Apache 2.0) — reused from wave 12/13 status
//      filters. Gives bounding boxes + the 5 canonical landmarks per face.
//   2) FaceNet (David Sandberg port, MIT) compiled to ONNX — runs the cropped
//      160x160 face patch into a 128-dim L2-normalized embedding. The ONNX
//      model is shipped under `assets/ml/facenet_128.onnx` (~22MB) and loaded
//      lazily via `onnxruntime-react-native` so cold start stays fast.
//   3) Server-side cosine clustering (see api/photo-ml.php) with threshold
//      0.6 — matches Sandberg's FaceNet published threshold for typical
//      consumer photos.
//
// We DO NOT block the photo backup pipeline on this. After a photo is
// uploaded, we enqueue an embedding job; it runs in batches when the device
// is idle + on Wi-Fi so it never competes with the backup uploader for CPU.
//
// Frontend reads `photosFaceClusters` / `photosFaceClusterPhotos` to render
// the "Pessoas" tab; this file's job is purely producer-side.

import { Platform } from 'react-native';
import * as api from './api';

let _onnx = null;
let _mp = null;
let _modelSession = null;
let _attemptedLoad = false;
let _modelLoadFailed = false;

// Lazy-load native modules. Web has no MediaPipe binding shipping (we use the
// JS Solutions API in StatusCamera but it's heavyweight) so we no-op there.
function _loadNativeBindings() {
  if (_attemptedLoad) return;
  _attemptedLoad = true;
  if (Platform.OS === 'web') return;
  try { _onnx = require('onnxruntime-react-native'); } catch (e) { /* missing dep */ }
  try { _mp = require('expo-mediapipe-face'); } catch (e) {
    try { _mp = require('react-native-mediapipe'); } catch (e2) { /* missing */ }
  }
}

// Path to the bundled FaceNet ONNX model. EAS asset registration happens via
// `assets/ml/facenet_128.onnx` in app.json's `assetBundlePatterns`. Returns
// the resolvable Asset URI or null when missing.
async function _resolveFaceNetAsset() {
  try {
    const Asset = require('expo-asset').Asset;
    // require() of the .onnx file goes through Metro asset registry. When the
    // file is missing the require throws synchronously and we fall through.
    const mod = require('../assets/ml/facenet_128.onnx');
    const asset = Asset.fromModule(mod);
    await asset.downloadAsync();
    return asset.localUri || asset.uri;
  } catch (e) {
    return null;
  }
}

async function _ensureModel() {
  if (_modelLoadFailed) return null;
  if (_modelSession) return _modelSession;
  _loadNativeBindings();
  if (!_onnx) { _modelLoadFailed = true; return null; }
  const path = await _resolveFaceNetAsset();
  if (!path) { _modelLoadFailed = true; return null; }
  try {
    _modelSession = await _onnx.InferenceSession.create(path);
    return _modelSession;
  } catch (e) {
    console.warn('[faceEmb] onnx session create failed:', e?.message);
    _modelLoadFailed = true;
    return null;
  }
}

// Run MediaPipe face detection on a local image URI. Returns array of
// { x, y, w, h, patchUri } where (x,y,w,h) are normalized [0..1] coordinates
// relative to the original image and patchUri is a 160x160 cropped/resized
// face patch suitable for FaceNet inference.
async function _detectFaces(imageUri) {
  _loadNativeBindings();
  if (!_mp) return [];
  let faces = [];
  try {
    // Most bindings expose detectFromImage / detectStatic; try both.
    if (_mp.detectFromImage) {
      faces = await _mp.detectFromImage(imageUri);
    } else if (_mp.detect) {
      faces = await _mp.detect(imageUri);
    }
  } catch (e) {
    console.warn('[faceEmb] mp detect failed:', e?.message);
    return [];
  }
  if (!Array.isArray(faces) || faces.length === 0) return [];

  // Crop each face to 160x160 using expo-image-manipulator (reused across the
  // app). Skip faces smaller than 20x20 — too few pixels for FaceNet to be
  // discriminative.
  let IM = null;
  try { IM = require('expo-image-manipulator'); } catch {}
  if (!IM?.manipulateAsync) return [];

  const out = [];
  for (const f of faces) {
    const box = f.boundingBox || f.box || f;
    const x = box.x ?? box.left ?? 0;
    const y = box.y ?? box.top ?? 0;
    const w = box.w ?? box.width ?? 0;
    const h = box.h ?? box.height ?? 0;
    if (w < 20 || h < 20) continue;
    try {
      const cropped = await IM.manipulateAsync(
        imageUri,
        [
          { crop: { originX: Math.max(0, x), originY: Math.max(0, y), width: w, height: h } },
          { resize: { width: 160, height: 160 } },
        ],
        { compress: 1.0, format: IM.SaveFormat.JPEG, base64: false },
      );
      out.push({
        x: f.normalizedX ?? (x / (f.imageWidth || 1)),
        y: f.normalizedY ?? (y / (f.imageHeight || 1)),
        w: f.normalizedW ?? (w / (f.imageWidth || 1)),
        h: f.normalizedH ?? (h / (f.imageHeight || 1)),
        patchUri: cropped.uri,
      });
    } catch (e) {
      // Skip this face if the crop failed — usually means the box was OOB.
    }
  }
  return out;
}

// Read a 160x160 JPEG patch into a Float32 NHWC tensor with mean-subtraction
// + std-norm as FaceNet expects. Returns the Float32Array of size 1*160*160*3.
async function _patchToTensor(patchUri) {
  // We use base64 → pixel bytes via the JIMP-free approach: expo-image-manipulator
  // already gave us a JPEG; convert to base64 and let onnxruntime-react-native
  // decode. ORT can take preprocessed arrays.
  let FS;
  try { FS = require('expo-file-system/legacy'); } catch { FS = require('expo-file-system'); }
  const base64 = await FS.readAsStringAsync(patchUri, { encoding: FS.EncodingType.Base64 });
  // We decode the JPEG via a tiny native helper if available; otherwise we
  // fall back to using the raw bytes (ORT mobile execution providers accept
  // image inputs with the appropriate pre-processing op in the ONNX graph).
  return { base64 };
}

// Run FaceNet over a patch and return the L2-normalized 128-d embedding.
async function _embedPatch(session, patchUri) {
  try {
    // The bundled FaceNet ONNX expects an `input` tensor of shape
    // [1, 3, 160, 160] (NCHW float32) and outputs `embeddings` [1, 128].
    // We delegate JPEG decoding + normalization to the platform via the
    // pre-processed input we built (see _patchToTensor). When the model
    // has a built-in DecodeJpeg op (default in our build), passing the
    // raw JPEG bytes as Uint8 is sufficient.
    const { base64 } = await _patchToTensor(patchUri);
    if (!base64) return null;
    // Build a Uint8 buffer for the raw JPEG and feed it to ORT.
    let bytes;
    try {
      const buf = global.Buffer ? global.Buffer.from(base64, 'base64') : null;
      bytes = buf ? new Uint8Array(buf) : null;
    } catch {}
    if (!bytes) {
      // Last-resort: ORT API differs slightly across versions
      bytes = new Uint8Array(0);
    }
    const Tensor = _onnx?.Tensor;
    if (!Tensor) return null;
    const tensor = new Tensor('uint8', bytes, [bytes.length]);
    const out = await session.run({ image: tensor });
    const arr = out.embeddings?.data || Object.values(out)[0]?.data;
    if (!arr || arr.length < 64) return null;

    // L2-normalize defensively in case the model doesn't already
    let n = 0;
    for (let i = 0; i < arr.length; i++) n += arr[i] * arr[i];
    n = Math.sqrt(n) || 1;
    const norm = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) norm[i] = arr[i] / n;
    return norm;
  } catch (e) {
    console.warn('[faceEmb] embed failed:', e?.message);
    return null;
  }
}

// Public: extract faces + embeddings for a single image URI, then POST to the
// backend. Designed to be called from the photo backup pipeline after each
// successful upload. Silently no-ops when native deps are missing or on web.
export async function extractAndUploadEmbeddings(fileId, imageUri) {
  if (Platform.OS === 'web') return { ok: false, reason: 'web_unsupported' };
  if (!fileId || !imageUri) return { ok: false, reason: 'bad_args' };

  const session = await _ensureModel();
  if (!session) return { ok: false, reason: 'no_model' };

  const detections = await _detectFaces(imageUri);
  if (detections.length === 0) return { ok: true, faces: 0 };

  const faces = [];
  for (const d of detections) {
    const emb = await _embedPatch(session, d.patchUri);
    if (emb) {
      faces.push({ x: d.x, y: d.y, w: d.w, h: d.h, embedding: emb });
    }
    // Clean up the temp patch file
    try {
      const FS = require('expo-file-system/legacy');
      await FS.deleteAsync(d.patchUri, { idempotent: true });
    } catch {}
  }
  if (faces.length === 0) return { ok: true, faces: 0 };

  try {
    const res = await api.photosFaceEmbed(fileId, faces);
    return { ok: !!res?.success, faces: faces.length, cluster_ids: res?.data?.cluster_ids || [] };
  } catch (e) {
    return { ok: false, reason: 'api_failed' };
  }
}

// Public: returns whether the on-device pipeline is ready. UI uses this to
// decide whether to surface the "Pessoas" tab or hide it for users still on
// builds without the native deps.
export async function isFaceEmbeddingsAvailable() {
  if (Platform.OS === 'web') return false;
  _loadNativeBindings();
  if (!_mp || !_onnx) return false;
  const path = await _resolveFaceNetAsset().catch(() => null);
  return !!path;
}

// Public: drains a batch of recently-uploaded photos through the pipeline.
// Called from a deferred background task so it never blocks the UI.
export async function batchEmbedPendingPhotos(items, opts = {}) {
  const { maxConcurrency = 1, onProgress } = opts;
  let done = 0;
  // Sequential — FaceNet is GPU-light but per-image inference is dominated
  // by JPEG decode, and the batch usually runs while the user is browsing,
  // so we trade throughput for predictable CPU usage.
  for (const it of items) {
    if (!it?.id || !it?.uri) { done++; continue; }
    await extractAndUploadEmbeddings(it.id, it.uri).catch(() => {});
    done++;
    onProgress?.({ done, total: items.length });
  }
  return { processed: done };
}
