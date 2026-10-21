// components/chat/MediaQualityPill.js — [2026-10-19 media-quality]
//
// WhatsApp-style "HD" pill for the media preview header (always on the black
// preview chrome): tap cycles Padrão → HD → Full HD for THIS send (every item
// of the album); the estimated size next to it opens a small sheet that
// explains each level with the estimated size of the current batch.
//
// Props: level ('standard'|'hd'|'full'), onChange(level), files (preview
// batch: { type, name, uri, size, width, height, duration }), t (i18n).
import { useMemo, useState } from 'react';
import { Modal, Pressable, Text, TouchableOpacity, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import {
  QUALITY_LEVELS, estimateBytes, formatBytes, nextLevel, normalizeLevel,
} from '../../services/mediaUploadQuality';

const VIDEO_RE = /\.(mp4|mov|webm|avi|mkv|m4v|3gp)$/i;

function _isVideo(f) {
  return String(f?.type || '').startsWith('video') || VIDEO_RE.test(f?.name || f?.uri || '');
}
function _isGif(f) {
  return /image\/gif/i.test(f?.type || '') || /\.gif$/i.test(f?.name || f?.uri || '');
}
/** Picker durations come in ms (expo-image-picker) or s (native attach sheet). */
function _durMs(f) {
  const d = Number(f?.duration) || 0;
  if (!(d > 0)) return 0;
  return d < 1000 ? d * 1000 : d;
}

export function estimateBatchBytes(files, level) {
  let total = 0;
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || f._asFile || _isGif(f)) { total += Number(f?.size) || 0; continue; }
    total += estimateBytes({
      isVideo: _isVideo(f), width: Number(f.width) || 0, height: Number(f.height) || 0,
      durationMs: _durMs(f), sizeBytes: Number(f.size) || 0,
    }, level);
  }
  return total;
}

function _label(t, lv) {
  if (lv === 'full') return t('mediaQuality.full') || 'Full HD';
  if (lv === 'hd') return t('mediaQuality.hd') || 'HD';
  return t('mediaQuality.standard') || 'Padrão';
}

function _desc(t, lv) {
  if (lv === 'full') return t('mediaQuality.fullDesc') || 'Fotos na resolução original e vídeos 1080p em alta qualidade. Arquivos bem maiores.';
  if (lv === 'hd') return t('mediaQuality.hdDesc') || 'Fotos até 2560 px e vídeos 1080p. Mais nítido, arquivos maiores.';
  return t('mediaQuality.standardDesc') || 'Fotos até 1600 px e vídeos 720p. Envio mais rápido, usa menos dados.';
}

function Check() {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Path d="M5 12.5l4.2 4.2L19 7" stroke="#fff" strokeWidth={2.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function InfoGlyph() {
  return (
    <Svg width={13} height={13} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={9.5} stroke="rgba(255,255,255,0.85)" strokeWidth={2} fill="none" />
      <Path d="M12 10.8v6M12 7.4v.2" stroke="rgba(255,255,255,0.85)" strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  );
}

export default function MediaQualityPill({ level, onChange, files, t }) {
  const lv = normalizeLevel(level) || 'standard';
  const [sheet, setSheet] = useState(false);
  const sizes = useMemo(() => {
    const o = {};
    for (const l of QUALITY_LEVELS) o[l] = estimateBatchBytes(files, l);
    return o;
  }, [files]);
  const on = lv !== 'standard';
  const pillText = lv === 'full' ? 'FULL HD' : 'HD';
  const est = sizes[lv] > 0 ? `~${formatBytes(sizes[lv])}` : '';

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {!!est && (
        <TouchableOpacity
          onPress={() => setSheet(true)}
          hitSlop={{ top: 10, bottom: 10, left: 6, right: 2 }}
          style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, height: 36 }}
          accessibilityRole="button"
          accessibilityLabel={(t('mediaQuality.a11yInfo') || 'Ver tamanhos de envio') + ', ' + est}
        >
          <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '600', marginRight: 4 }}>{est}</Text>
          <InfoGlyph />
        </TouchableOpacity>
      )}
      <TouchableOpacity
        onPress={() => onChange?.(nextLevel(lv))}
        onLongPress={() => setSheet(true)}
        hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
        style={{ height: 36, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' }}
        accessibilityRole="button"
        accessibilityLabel={t('mediaQuality.a11yPill', { level: _label(t, lv) }) || `Qualidade de envio: ${_label(t, lv)}`}
        accessibilityHint={t('mediaQuality.a11yHint') || 'Toque para trocar a qualidade. Toque e segure para ver os tamanhos.'}
      >
        <View style={{
          paddingHorizontal: 5, paddingVertical: 1.5, borderRadius: 5,
          borderWidth: 1.5, borderColor: on ? '#fff' : 'rgba(255,255,255,0.75)',
          backgroundColor: on ? '#fff' : 'transparent',
        }}>
          <Text style={{ color: on ? '#111111' : 'rgba(255,255,255,0.9)', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 }}>{pillText}</Text>
        </View>
      </TouchableOpacity>

      <Modal visible={sheet} transparent animationType="fade" onRequestClose={() => setSheet(false)} statusBarTranslucent>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }} onPress={() => setSheet(false)}>
          <Pressable style={{ backgroundColor: '#151517', borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 8, paddingBottom: 28, paddingHorizontal: 16 }} onPress={() => {}}>
            <View style={{ alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.25)', marginBottom: 12 }} />
            <Text style={{ color: '#fff', fontSize: 17, fontWeight: '700', marginBottom: 4 }}>
              {t('mediaQuality.sheetTitle') || 'Qualidade de envio'}
            </Text>
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginBottom: 10 }}>
              {t('mediaQuality.sheetFooter') || 'Vale para todas as fotos e vídeos deste envio. O padrão fica em Configurações > Armazenamento e dados.'}
            </Text>
            {QUALITY_LEVELS.map((l) => {
              const sel = l === lv;
              return (
                <TouchableOpacity
                  key={l}
                  onPress={() => { onChange?.(l); setSheet(false); }}
                  style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderTopWidth: l === 'standard' ? 0 : 0.5, borderTopColor: 'rgba(255,255,255,0.12)' }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: sel }}
                >
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: sel ? '700' : '500' }}>{_label(t, l)}</Text>
                      {sizes[l] > 0 && (
                        <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginLeft: 8 }}>
                          {t('mediaQuality.estimate', { size: formatBytes(sizes[l]) }) || `cerca de ${formatBytes(sizes[l])}`}
                        </Text>
                      )}
                    </View>
                    <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, marginTop: 2 }}>{_desc(t, l)}</Text>
                  </View>
                  <View style={{ width: 22, alignItems: 'center' }}>{sel ? <Check /> : null}</View>
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
