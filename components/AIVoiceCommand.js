/**
 * AIVoiceCommand — Floating mic button that records audio,
 * transcribes via Groq Whisper, parses intent via aiVoiceCommand,
 * and dispatches the appropriate action.
 *
 * VAD (voice activity detection): while recording, we poll the recorder's
 * metering every 150ms. After ~1.4s of silence below SILENCE_DB we
 * auto-stop and transcribe. A hard cap of 30s protects against stuck
 * recordings. Tap the mic once to start, speak, and it stops itself.
 *
 * Usage: <AIVoiceCommand /> from any screen.
 */
import React, { useState, useRef } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import * as api from '../services/api';
import { useTheme } from '../context/ThemeContext';

// VAD tuning — expo-audio / iOS AVAudioRecorder report metering in dBFS
// where 0 = max, -160 ≈ silence. Typical speech runs -30..-5, quiet rooms
// floor around -50..-60. The initial -42 threshold was too aggressive —
// it cut off mid-word during natural pauses ("cannot understand"). Now
// we use -55 (quieter rooms fine) and require a longer silence window
// (2.0s) and longer minimum speech (800ms) so users don't get clipped.
const SILENCE_DB = -55;
const SILENCE_MS = 2000;      // stop after 2s of continuous silence
const MIN_SPEECH_MS = 800;    // require ≥800ms of real speech before auto-stopping
const MAX_RECORDING_MS = 60000; // hard cap 60s
const POLL_MS = 120;

export default function AIVoiceCommand() {
  const { colors } = useTheme();
  const router = useRouter();
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState(null);
  const recordingRef = useRef(null);
  const vadIntervalRef = useRef(null);
  const vadStateRef = useRef({ startedAt: 0, lastVoiceAt: 0 });

  function clearVad() {
    if (vadIntervalRef.current) {
      clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }
  }

  async function startRecording() {
    try {
      const expoAudio = require('expo-audio');
      const perm = await expoAudio.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setResult({ error: 'Permissão de microfone negada' });
        return;
      }
      await expoAudio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      const AudioMod = require('expo-audio/build/AudioModule').default;
      const { RecordingPresets } = expoAudio;
      // Enable metering so we can poll the current input level for VAD.
      const preset = {
        ...(RecordingPresets.HIGH_QUALITY || {}),
        isMeteringEnabled: true,
      };
      const rec = new AudioMod.AudioRecorder(preset);
      await rec.prepareToRecordAsync();
      rec.record();
      recordingRef.current = rec;
      setRecording(true);

      const now = Date.now();
      vadStateRef.current = { startedAt: now, lastVoiceAt: now };
      clearVad();
      vadIntervalRef.current = setInterval(() => {
        const r = recordingRef.current;
        if (!r) { clearVad(); return; }
        // Pull the latest meter sample. API surface varies across
        // expo-audio versions — try both shapes.
        let level = null;
        try {
          const status = typeof r.getStatus === 'function' ? r.getStatus() : null;
          if (status && typeof status.metering === 'number') level = status.metering;
          else if (typeof r.metering === 'number') level = r.metering;
        } catch {}
        const t = Date.now();
        const state = vadStateRef.current;
        const elapsed = t - state.startedAt;
        // Hard cap: 30s max
        if (elapsed >= MAX_RECORDING_MS) { stopAndTranscribe(); return; }
        if (level == null) return; // no metering available — wait for manual stop
        if (level > SILENCE_DB) {
          state.lastVoiceAt = t;
        } else if (elapsed > MIN_SPEECH_MS && (t - state.lastVoiceAt) > SILENCE_MS) {
          // Silence long enough after real speech — auto-stop.
          stopAndTranscribe();
        }
      }, POLL_MS);
    } catch (e) {
      setResult({ error: 'Microfone indisponível: ' + (e?.message || 'erro desconhecido') });
    }
  }

  async function stopAndTranscribe() {
    clearVad();
    if (!recordingRef.current) {
      setRecording(false);
      return;
    }
    setRecording(false);
    setProcessing(true);
    try {
      const rec = recordingRef.current;
      await rec.stop();
      const uri = rec.uri;
      recordingRef.current = null;
      if (!uri) throw new Error('No audio file');

      // Transcribe via Groq Whisper. Whisper auto-detects language and
      // returns it in `data.language` — we pipe that into every downstream
      // call so the intent parser / One reply use the user's actual spoken
      // language (fixes: "spoke Portuguese but One replied in English").
      const transRes = await api.aiTranscribeAudio(uri);
      if (!transRes?.success || !transRes.data?.text) {
        setResult({ error: 'Transcription failed' });
        setProcessing(false);
        return;
      }
      const text = transRes.data.text.trim();
      const detectedLang = (transRes.data.language || '').toLowerCase().slice(0, 2);

      // Parse intent (pass detected language so the reply — if any — is in
      // the same language the user spoke).
      const intentRes = await api.aiVoiceCommand(text, { language: detectedLang });
      const intent = intentRes?.data || {};
      setResult({ text, intent });
      setProcessing(false);

      // Auto-dispatch some intents after 1.5s
      setTimeout(() => {
        if (!intent || !intent.intent) return;
        const p = intent.params || {};
        switch (intent.intent) {
          case 'send_email':
            router.push({ pathname: '/compose', params: { to: p.to || '', subject: p.subject || '', body: p.body || '' } });
            setResult(null);
            break;
          case 'send_message':
            router.push({ pathname: '/chat-new', params: { prefillBody: p.body || '' } });
            setResult(null);
            break;
          case 'create_event':
            router.push({ pathname: '/event-detail', params: { mode: 'create', title: p.subject || p.body || '', start: p.date || '' } });
            setResult(null);
            break;
          case 'search':
            router.push({ pathname: '/inbox', params: { query: p.query || text } });
            setResult(null);
            break;
        }
      }, 1500);
    } catch (e) {
      setResult({ error: e?.message || 'Unknown error' });
      setProcessing(false);
    }
  }

  return (
    <>
      {/* Floating mic button */}
      <TouchableOpacity
        onPress={recording ? stopAndTranscribe : startRecording}
        style={{
          position: 'absolute', right: 16, bottom: 90,
          width: 56, height: 56, borderRadius: 28,
          backgroundColor: recording ? '#ef4444' : colors.primary,
          justifyContent: 'center', alignItems: 'center',
          shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.3, shadowRadius: 8, elevation: 6,
          zIndex: 9000,
        }}
      >
        {processing ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={{ fontSize: 28 }}>{recording ? '⏹️' : '🎙️'}</Text>
        )}
      </TouchableOpacity>

      {/* Result modal */}
      {result && (
        <View style={{ position: 'absolute', left: 16, right: 16, bottom: 160, zIndex: 9001 }}>
          <View style={{ backgroundColor: colors.surface, borderRadius: 12, padding: 16, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, elevation: 6 }}>
            {result.error ? (
              <>
                <Text style={{ color: '#ef4444', fontWeight: '600', marginBottom: 4 }}>Erro</Text>
                <Text style={{ color: colors.text, fontSize: 13 }}>{result.error}</Text>
              </>
            ) : (
              <>
                <Text style={{ color: colors.textSecondary, fontSize: 11, marginBottom: 4 }}>VOCE DISSE</Text>
                <Text style={{ color: colors.text, fontSize: 14, marginBottom: 8 }}>"{result.text}"</Text>
                {result.intent?.intent && result.intent.intent !== 'other' && (
                  <Text style={{ color: colors.primary, fontSize: 12 }}>
                    Acao detectada: {result.intent.intent} — executando...
                  </Text>
                )}
              </>
            )}
            <TouchableOpacity onPress={() => setResult(null)} style={{ marginTop: 8, alignSelf: 'flex-end' }}>
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>Fechar</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </>
  );
}
