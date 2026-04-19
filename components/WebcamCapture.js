// Minimal webcam capture overlay for desktop web — getUserMedia preview
// with Snap (photo) and Record (video) controls. Used by the chat
// attachment menu's "Camera" option when the user is on desktop; mobile
// web and native have their own native camera flows so this component
// only activates when Platform.OS === 'web' AND the device is non-touch.

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Platform } from 'react-native';
import { IconX } from './Icons';

export default function WebcamCapture({ visible, onClose, onCapture, colors, t }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const [mode, setMode] = useState('photo'); // 'photo' | 'video'
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [facing, setFacing] = useState('user'); // 'user' or 'environment' (external cams)

  // Start stream on open. Clean up on unmount / close so the camera LED
  // always turns off — a lot of web cameras leak the green light when a
  // component unmounts without stopping the tracks.
  useEffect(() => {
    if (!visible || Platform.OS !== 'web') return;
    setError('');
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: mode === 'video',
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      } catch (e) {
        setError(e?.message || 'Camera not available');
      }
    })();
    return () => {
      cancelled = true;
      try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch {}
      streamRef.current = null;
      try { if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop(); } catch {}
    };
  }, [visible, mode, facing]);

  // Elapsed seconds while recording
  useEffect(() => {
    if (!recording) { setElapsed(0); return; }
    const id = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const snap = () => {
    const video = videoRef.current;
    if (!video || !streamRef.current) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `photo_${Date.now()}.jpg`, { type: 'image/jpeg' });
      onCapture?.({
        uri: URL.createObjectURL(file),
        blob: file,
        name: file.name,
        type: 'image/jpeg',
        size: file.size,
      });
      onClose?.();
    }, 'image/jpeg', 0.92);
  };

  const startRecord = () => {
    const stream = streamRef.current;
    if (!stream) return;
    // Prefer MP4-over-H264 when supported (Safari); otherwise let the
    // browser pick (usually WebM on Chrome/Firefox). The PHP upload + R2
    // pipeline accepts both.
    let mime = '';
    const candidates = ['video/mp4;codecs=h264', 'video/webm;codecs=vp9', 'video/webm'];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) { mime = c; break; }
    }
    chunksRef.current = [];
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'video/webm' });
      const ext = (rec.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
      const file = new File([blob], `video_${Date.now()}.${ext}`, { type: blob.type });
      onCapture?.({
        uri: URL.createObjectURL(file),
        blob: file,
        name: file.name,
        type: blob.type,
        size: file.size,
      });
      onClose?.();
    };
    recorderRef.current = rec;
    rec.start();
    setRecording(true);
  };

  const stopRecord = () => {
    try { recorderRef.current?.stop(); } catch {}
    setRecording(false);
  };

  const toggleFacing = () => setFacing(f => (f === 'user' ? 'environment' : 'user'));

  if (!visible || Platform.OS !== 'web') return null;

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;

  return (
    <View style={{
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.92)', zIndex: 10000,
      alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      {/* Close */}
      <TouchableOpacity
        onPress={() => { stopRecord(); onClose?.(); }}
        style={{ position: 'absolute', top: 16, right: 16, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}
      >
        <IconX size={22} color="#fff" />
      </TouchableOpacity>

      {/* Video preview */}
      <View style={{ width: '100%', maxWidth: 900, aspectRatio: 16/9, borderRadius: 18, overflow: 'hidden', backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
        {error ? (
          <Text style={{ color: '#fff', fontSize: 14, padding: 16, textAlign: 'center' }}>
            {t?.('chatConv.webcamError') || 'Não foi possível abrir a câmera. Verifique as permissões do navegador.'}
            {'\n'}{error}
          </Text>
        ) : (
          <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: facing === 'user' ? 'scaleX(-1)' : 'none' }} />
        )}
        {recording && (
          <View style={{ position: 'absolute', top: 12, left: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(220,38,38,0.9)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, gap: 6 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' }} />
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>REC {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}</Text>
          </View>
        )}
      </View>

      {/* Mode toggle */}
      <View style={{ flexDirection: 'row', marginTop: 16, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 20, padding: 4 }}>
        {['photo', 'video'].map(m => (
          <TouchableOpacity
            key={m}
            onPress={() => !recording && setMode(m)}
            style={{ paddingHorizontal: 18, paddingVertical: 8, borderRadius: 16, backgroundColor: mode === m ? '#7C3AED' : 'transparent' }}
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>
              {m === 'photo' ? (t?.('chatConv.photo') || 'Foto') : (t?.('chatConv.video') || 'Vídeo')}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Controls */}
      <View style={{ flexDirection: 'row', gap: 20, marginTop: 18, alignItems: 'center' }}>
        <TouchableOpacity
          onPress={toggleFacing}
          style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontSize: 20, color: '#fff' }}>↺</Text>
        </TouchableOpacity>

        {/* Shutter */}
        <TouchableOpacity
          onPress={() => {
            if (mode === 'photo') return snap();
            if (recording) stopRecord(); else startRecord();
          }}
          disabled={!!error}
          style={{
            width: 76, height: 76, borderRadius: 38,
            backgroundColor: recording ? '#DC2626' : '#fff',
            alignItems: 'center', justifyContent: 'center',
            borderWidth: 4, borderColor: '#7C3AED',
          }}
        >
          {mode === 'video' && (
            <View style={{ width: recording ? 24 : 50, height: recording ? 24 : 50, borderRadius: recording ? 4 : 25, backgroundColor: recording ? '#fff' : '#DC2626' }} />
          )}
        </TouchableOpacity>

        {/* Placeholder to keep shutter centered */}
        <View style={{ width: 48 }} />
      </View>
    </View>
  );
}
