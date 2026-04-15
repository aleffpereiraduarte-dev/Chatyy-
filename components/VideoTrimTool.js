// Video trim tool — select start/end before sending
// Web: uses HTML5 video + MediaRecorder for trimming
// Native: stores trim range in metadata (server or ffmpeg handles actual trim)
import { useState, useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, Platform, Dimensions } from 'react-native';

export default function VideoTrimTool({ videoUri, onDone, onCancel, t }) {
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef(null);
  const trackWidth = Math.min(Dimensions.get('window').width - 40, 500);

  useEffect(() => {
    if (duration > 0 && end === 0) setEnd(duration);
  }, [duration, end]);

  const formatTime = (s) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const handleDone = () => {
    onDone?.({ start, end, duration });
  };

  const onTimeUpdate = () => {
    if (videoRef.current) {
      const t = videoRef.current.currentTime;
      setCurrent(t);
      // Loop within trim range
      if (t >= end) {
        videoRef.current.currentTime = start;
      }
    }
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (playing) { videoRef.current.pause(); setPlaying(false); }
    else {
      if (videoRef.current.currentTime < start || videoRef.current.currentTime >= end) {
        videoRef.current.currentTime = start;
      }
      videoRef.current.play();
      setPlaying(true);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {/* Video preview */}
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        {Platform.OS === 'web' ? (
          <video
            ref={videoRef}
            src={videoUri}
            style={{ maxWidth: '100%', maxHeight: '100%' }}
            onLoadedMetadata={(e) => setDuration(e.target.duration)}
            onTimeUpdate={onTimeUpdate}
            onEnded={() => setPlaying(false)}
            playsInline
          />
        ) : (
          <Text style={{ color: '#fff' }}>{t?.('video.trimNotice') || 'Arraste para recortar o video'}</Text>
        )}
      </View>

      {/* Controls */}
      <View style={{ backgroundColor: 'rgba(0,0,0,0.9)', padding: 16, gap: 12 }}>
        {/* Play/pause + time */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <TouchableOpacity onPress={togglePlay} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#7C3AED', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 18 }}>{playing ? '⏸' : '▶'}</Text>
          </TouchableOpacity>
          <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>
            {formatTime(start)} → {formatTime(end)} ({formatTime(end - start)})
          </Text>
        </View>

        {/* Trim sliders (web only — native uses default range) */}
        {Platform.OS === 'web' && duration > 0 && (
          <View style={{ gap: 8 }}>
            <View>
              <Text style={{ color: '#fff', fontSize: 12, marginBottom: 4 }}>{t?.('video.trimStart') || 'Inicio'}: {formatTime(start)}</Text>
              <input
                type="range"
                min="0"
                max={duration.toFixed(2)}
                step="0.1"
                value={start}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (v < end - 0.5) { setStart(v); if (videoRef.current) videoRef.current.currentTime = v; }
                }}
                style={{ width: '100%', accentColor: '#7C3AED' }}
              />
            </View>
            <View>
              <Text style={{ color: '#fff', fontSize: 12, marginBottom: 4 }}>{t?.('video.trimEnd') || 'Fim'}: {formatTime(end)}</Text>
              <input
                type="range"
                min="0"
                max={duration.toFixed(2)}
                step="0.1"
                value={end}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (v > start + 0.5) setEnd(v);
                }}
                style={{ width: '100%', accentColor: '#7C3AED' }}
              />
            </View>
          </View>
        )}

        {/* Actions */}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
          <TouchableOpacity onPress={onCancel} style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '600' }}>{t?.('common.cancel') || 'Cancelar'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleDone} style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: '#7C3AED', alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>{t?.('common.done') || 'Pronto'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}
