/**
 * AIVoiceCommand — Floating mic button that records audio,
 * transcribes via Groq Whisper, parses intent via aiVoiceCommand,
 * and dispatches the appropriate action.
 *
 * Usage: <AIVoiceCommand /> from any screen.
 */
import React, { useState, useRef } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import * as api from '../services/api';
import { useTheme } from '../context/ThemeContext';

export default function AIVoiceCommand() {
  const { colors } = useTheme();
  const router = useRouter();
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState(null);
  const recordingRef = useRef(null);

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
      const rec = new AudioMod.AudioRecorder(RecordingPresets.HIGH_QUALITY);
      await rec.prepareToRecordAsync();
      rec.record();
      recordingRef.current = rec;
      setRecording(true);
    } catch (e) {
      setResult({ error: 'Microfone indisponível: ' + (e?.message || 'erro desconhecido') });
    }
  }

  async function stopAndTranscribe() {
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

      // Transcribe via Groq Whisper
      const transRes = await api.aiTranscribeAudio(uri);
      if (!transRes?.success || !transRes.data?.text) {
        setResult({ error: 'Transcription failed' });
        setProcessing(false);
        return;
      }
      const text = transRes.data.text.trim();

      // Parse intent
      const intentRes = await api.aiVoiceCommand(text);
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
