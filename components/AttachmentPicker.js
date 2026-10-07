import { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, ActivityIndicator, Image, Modal, FlatList } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconPaperclip, IconX, IconFileText, IconImage, IconMusic, IconFilm, IconAlertTriangle, IconFolder, IconCheckCircle, IconRotateCw, IconWifiOff } from './Icons';
import Svg, { Circle as SvgCircle } from 'react-native-svg';
import { formatBytes } from '../services/format';
import { fileListAll, BASE_URL } from '../services/api';
import { subscribeAttachUploads, getAttachUpload, retryAttachUpload } from '../services/emailAttachUploads';
import LocalAttachmentPreview from './LocalAttachmentPreview';

const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_SIZE = 55 * 1024 * 1024; // 55 MB

// ── Helpers ──────────────────────────────────────────────────────────────

function iconForType(type, size, color) {
  if (!type) return <IconFileText size={size} color={color} />;
  if (type.startsWith('image/')) return <IconImage size={size} color={color} />;
  if (type.startsWith('audio/')) return <IconMusic size={size} color={color} />;
  if (type.startsWith('video/')) return <IconFilm size={size} color={color} />;
  return <IconFileText size={size} color={color} />;
}

// [2026-10-08 email-outbox] Gmail-style per-attachment upload ring. The
// upload itself runs in services/emailAttachUploads (module-level, survives
// the composer closing); this ring just mirrors its state for `file._akey`.
function UploadRing({ progress, color, track, size = 26 }) {
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0.03, Math.min(1, progress || 0));
  return (
    <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
      <SvgCircle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
      <SvgCircle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none"
        strokeDasharray={`${c} ${c}`} strokeDashoffset={c * (1 - p)} strokeLinecap="round" />
    </Svg>
  );
}

function useUploadStates(attachments) {
  const [, setTick] = useState(0);
  const keysRef = useRef(new Set());
  keysRef.current = new Set(attachments.map((a) => a && a._akey).filter(Boolean));
  useEffect(() => subscribeAttachUploads((key) => {
    if (!key || keysRef.current.has(key)) setTick((n) => n + 1);
  }), []);
}

// ── Component ────────────────────────────────────────────────────────────

export default function AttachmentPicker({
  attachments = [],
  onAdd,
  onRemove,
  maxFiles = DEFAULT_MAX_FILES,
  maxSize = DEFAULT_MAX_SIZE,
  uploadProgress,   // optional: { [index]: 0-100 }  (for future use)
  disabled = false,
}) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);
  const objectUrlsRef = useRef([]);
  // Drive picker — fetched on open from the existing drive_list_all endpoint.
  // Selections become "reference" attachments (no bytes transferred): the
  // outgoing email carries a drive URL + filename + size in metadata so the
  // recipient downloads from CDN instead of having a 50 MB MIME inline.
  const [showDrive, setShowDrive] = useState(false);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveError, setDriveError] = useState(null);
  const [driveFiles, setDriveFiles] = useState([]);
  const [driveSelection, setDriveSelection] = useState({});
  // [2026-10-07 compose-attach-preview] tap a picked file to check it before sending (Gmail-style).
  const [previewIndex, setPreviewIndex] = useState(-1);
  useUploadStates(attachments);

  // Revoke all created object URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (Platform.OS === 'web') {
        objectUrlsRef.current.forEach(url => { try { URL.revokeObjectURL(url); } catch {} });
        objectUrlsRef.current = [];
      }
    };
  }, []);

  const totalSize = attachments.reduce((sum, f) => sum + (f.size || 0), 0);
  const canAdd = attachments.length < maxFiles && !disabled;

  // ── Validation ────────────────────────────────────────────────────────

  // `batch` = files already accepted in the SAME picker session. The
  // `attachments` prop is frozen for the whole loop (parent state hasn't
  // re-rendered yet), so without it a multi-select bypasses maxFiles and
  // the duplicate check.
  const validate = useCallback((file, batch = []) => {
    if (attachments.length + batch.length >= maxFiles) {
      setError(t('attachment.maxFiles', { count: maxFiles }));
      return false;
    }
    if (file.size > maxSize) {
      setError(t('attachment.tooLarge', { name: file.name, limit: formatBytes(maxSize) }));
      return false;
    }
    // reject duplicates by name + size
    if (attachments.some(a => a.name === file.name && a.size === file.size) ||
        batch.some(a => a.name === file.name && a.size === file.size)) {
      setError(t('attachment.duplicate', { name: file.name }));
      return false;
    }
    setError(null);
    return true;
  }, [attachments, maxFiles, maxSize]);

  // ── Web: hidden <input> flow ──────────────────────────────────────────

  const handleWebFiles = useCallback((e) => {
    const fileList = e.target.files;
    if (!fileList) return;
    const batch = [];
    for (let i = 0; i < fileList.length; i++) {
      const raw = fileList[i];
      const objUrl = URL.createObjectURL(raw);
      objectUrlsRef.current.push(objUrl);
      const file = {
        name: raw.name,
        size: raw.size,
        type: raw.type,
        uri: objUrl,
        _raw: raw,  // keep the original File object for FormData uploads
      };
      if (validate(file, batch)) {
        onAdd && onAdd(file);
        batch.push(file);
      }
    }
    // reset so re-selecting the same file triggers onChange again
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [validate, onAdd]);

  const triggerWebPicker = useCallback(() => {
    if (!canAdd) return;
    setError(null);
    fileInputRef.current?.click();
  }, [canAdd]);

  // ── Mobile: expo-document-picker flow ─────────────────────────────────

  const triggerMobilePicker = useCallback(async () => {
    if (!canAdd) return;
    setError(null);
    try {
      const DocumentPicker = require('expo-document-picker');
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const assets = result.assets || (result.uri ? [result] : []);
      const batch = [];
      assets.forEach((asset) => {
        const file = {
          name: asset.name,
          size: asset.size,
          type: asset.mimeType || asset.type || 'application/octet-stream',
          uri: asset.uri,
        };
        if (validate(file, batch)) {
          onAdd && onAdd(file);
          batch.push(file);
        }
      });
    } catch (err) {
      setError(t('attachment.pickerError'));
    }
  }, [canAdd, validate, onAdd]);

  const handlePress = Platform.OS === 'web' ? triggerWebPicker : triggerMobilePicker;

  // ── Drive picker ────────────────────────────────────────────────────
  const openDrivePicker = useCallback(async () => {
    if (!canAdd) return;
    setShowDrive(true);
    setDriveSelection({});
    setDriveError(null);
    setDriveLoading(true);
    try {
      const r = await fileListAll();
      // drive_list_all returns { folders, files, trash, total }. We only
      // want non-trashed user files (folders excluded so the user doesn't
      // accidentally attach a directory).
      const items = Array.isArray(r?.data?.files) ? r.data.files
                  : Array.isArray(r?.data) ? r.data
                  : [];
      const files = items.filter(f => f && f.is_folder !== true && f.is_folder !== 1 && f.type !== 'folder');
      setDriveFiles(files);
    } catch (e) {
      setDriveError(t('attachment.driveError') || 'Falha ao carregar Drive');
    } finally {
      setDriveLoading(false);
    }
  }, [canAdd, t]);

  const confirmDriveSelection = useCallback(() => {
    const picked = driveFiles.filter(f => driveSelection[String(f.id)]);
    const batch = [];
    for (const f of picked) {
      if (attachments.length + batch.length >= maxFiles) break;
      // Build a "reference" attachment carrying the authenticated Drive
      // download URL. sendEmail() materializes the bytes right before the
      // multipart upload (the backend `send` only reads real attachment_N
      // parts — it has no drive_url stitching).
      const id = String(f.id);
      const downloadUrl = (BASE_URL || '') + '/api/email.php?action=drive_download&id=' + encodeURIComponent(id);
      const ref = {
        name: f.name || f.filename || 'file',
        size: Number(f.size || f.size_bytes || 0),
        type: f.mime_type || f.mime || 'application/octet-stream',
        // Marker fields — composer sends these as drive refs (no bytes).
        drive_id: id,
        drive_url: downloadUrl,
        uri: downloadUrl,
        is_drive_ref: true,
      };
      if (validate(ref, batch)) {
        onAdd && onAdd(ref);
        batch.push(ref);
      }
    }
    setShowDrive(false);
  }, [driveFiles, driveSelection, attachments.length, maxFiles, validate, onAdd]);

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <View style={s.container}>
      {/* Add-file + Drive picker row — two equal-width pills */}
      <View style={{ flexDirection: 'row', gap: Spacing.md }}>
        <TouchableOpacity
          style={[
            s.addBtn,
            { flex: 1, backgroundColor: colors.surfaceVariant, borderColor: colors.border, opacity: canAdd ? 1 : 0.5 },
          ]}
          onPress={handlePress}
          disabled={!canAdd}
          activeOpacity={0.7}
        >
          <IconPaperclip size={18} color={colors.primary} />
          <Text style={[s.addBtnText, { color: colors.primary }]}>
            {t('attachment.attachFiles')}
          </Text>
          <Text style={[s.addBtnHint, { color: colors.textTertiary }]}>
            {attachments.length}/{maxFiles}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            s.addBtn,
            { flex: 1, backgroundColor: colors.surfaceVariant, borderColor: colors.border, opacity: canAdd ? 1 : 0.5 },
          ]}
          onPress={openDrivePicker}
          disabled={!canAdd}
          activeOpacity={0.7}
          accessibilityLabel={t('attachment.attachFromDrive') || 'Anexar do Drive'}
          accessibilityRole="button"
        >
          <IconFolder size={18} color={colors.primary} />
          <Text style={[s.addBtnText, { color: colors.primary }]}>
            {t('attachment.attachFromDrive') || 'Anexar do Drive'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Hidden file input (web only) */}
      {Platform.OS === 'web' && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleWebFiles}
          style={{ display: 'none' }}
        />
      )}

      {/* Error banner */}
      {error && (
        <View style={[s.errorRow, { backgroundColor: colors.errorBg }]}>
          <IconAlertTriangle size={14} color={colors.error} />
          <Text style={[s.errorText, { color: colors.error }]} numberOfLines={2}>
            {error}
          </Text>
          <TouchableOpacity onPress={() => setError(null)} hitSlop={8}>
            <IconX size={14} color={colors.error} />
          </TouchableOpacity>
        </View>
      )}

      {/* File list */}
      {attachments.length > 0 && (
        <View style={[s.list, { borderColor: colors.borderLight }]}>
          {attachments.map((file, index) => {
            const progress = uploadProgress?.[index];
            const up = file && file._akey ? getAttachUpload(file._akey) : null;
            const upState = up ? up.state : null;
            return (
              <View
                key={`${file.name}-${index}`}
                style={[
                  s.fileRow,
                  index < attachments.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight },
                ]}
              >
                <TouchableOpacity
                  style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}
                  onPress={() => setPreviewIndex(index)}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityLabel={(t('attachment.preview') || 'Ver anexo') + ': ' + (file.name || '')}
                >
                  {file.type?.startsWith('image/') && file.uri ? (
                    <Image source={{ uri: file.uri }} style={s.fileThumb} resizeMode="cover" />
                  ) : (
                    <View style={[s.fileIcon, { backgroundColor: colors.primaryLight }]}>
                      {iconForType(file.type, 16, colors.primary)}
                    </View>
                  )}

                  <View style={s.fileMeta}>
                    <Text style={[s.fileName, { color: colors.text }]} numberOfLines={1}>
                      {file.name}
                    </Text>
                    <Text style={[s.fileSize, { color: upState === 'error' ? colors.error : colors.textTertiary }]} numberOfLines={1}>
                      {formatBytes(file.size)} · {upState === 'uploading' ? `${t('emailOutbox.uploading')} ${Math.round((up.progress || 0) * 100)}%`
                        : upState === 'waiting' ? t('emailOutbox.uploadWaiting')
                        : upState === 'error' ? t('emailOutbox.uploadFailed')
                        : t('attachment.tapToPreview')}
                    </Text>
                  </View>
                </TouchableOpacity>

                {/* Upload progress (future use) */}
                {progress != null && progress < 100 && (
                  <View style={s.progressWrap}>
                    <View style={[s.progressTrack, { backgroundColor: colors.borderLight }]}>
                      <View
                        style={[
                          s.progressBar,
                          { width: `${progress}%`, backgroundColor: colors.primary },
                        ]}
                      />
                    </View>
                    <Text style={[s.progressText, { color: colors.textTertiary }]}>
                      {Math.round(progress)}%
                    </Text>
                  </View>
                )}

                {upState === 'uploading' ? (
                  <View style={s.ringWrap} accessibilityLabel={`${t('emailOutbox.uploading')} ${Math.round((up.progress || 0) * 100)}%`}>
                    <UploadRing progress={up.progress} color={colors.primary} track={colors.borderLight} />
                  </View>
                ) : upState === 'waiting' ? (
                  <View style={s.ringWrap}>
                    <IconWifiOff size={16} color={colors.textTertiary} />
                  </View>
                ) : upState === 'error' ? (
                  <TouchableOpacity
                    onPress={() => retryAttachUpload(file._akey)}
                    style={[s.removeBtn, { backgroundColor: colors.primaryLight }]}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={t('emailOutbox.retryUpload')}
                  >
                    <IconRotateCw size={14} color={colors.primary} />
                  </TouchableOpacity>
                ) : null}

                {progress != null && progress < 100 ? (
                  <ActivityIndicator size="small" color={colors.primary} style={{ marginLeft: Spacing.sm }} />
                ) : (
                  <TouchableOpacity
                    onPress={() => onRemove && onRemove(index)}
                    style={[s.removeBtn, { backgroundColor: colors.errorBg }]}
                    hitSlop={6}
                    disabled={disabled}
                    accessibilityRole="button"
                    accessibilityLabel={upState === 'uploading' ? t('emailOutbox.cancelUpload') : (t('common.remove') || 'Remover')}
                  >
                    <IconX size={14} color={colors.error} />
                  </TouchableOpacity>
                )}
              </View>
            );
          })}

          {/* Total size footer */}
          <View style={[s.totalRow, { borderTopWidth: 1, borderTopColor: colors.borderLight }]}>
            <Text style={[s.totalLabel, { color: colors.textSecondary }]}>
              {t('attachment.totalSize')}
            </Text>
            <Text
              style={[
                s.totalValue,
                { color: totalSize > maxSize * 0.8 ? colors.warning : colors.textSecondary },
              ]}
            >
              {formatBytes(totalSize)} / {formatBytes(maxSize)}
            </Text>
          </View>
        </View>
      )}

      <LocalAttachmentPreview
        visible={previewIndex >= 0 && !!attachments[previewIndex]}
        file={attachments[previewIndex]}
        onClose={() => setPreviewIndex(-1)}
        onRemove={onRemove && !disabled ? () => { const i = previewIndex; setPreviewIndex(-1); onRemove(i); } : undefined}
      />

      {/* Drive picker modal — slide-up sheet listing the user's Drive files. */}
      <Modal visible={showDrive} animationType="slide" transparent onRequestClose={() => setShowDrive(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: colors.background, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 24, maxHeight: '80%' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight }}>
              <IconFolder size={20} color={colors.primary} />
              <Text style={{ flex: 1, marginLeft: 10, fontSize: 17, fontWeight: '700', color: colors.text }}>
                {t('attachment.driveTitle') || 'Anexar do Drive'}
              </Text>
              <TouchableOpacity onPress={() => setShowDrive(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <IconX size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            {driveLoading ? (
              <View style={{ padding: 32, alignItems: 'center' }}>
                <ActivityIndicator color={colors.primary} />
                <Text style={{ marginTop: 10, color: colors.textSecondary, fontSize: 13 }}>
                  {t('attachment.driveLoading') || 'Carregando Drive...'}
                </Text>
              </View>
            ) : driveError ? (
              <View style={{ padding: 32, alignItems: 'center' }}>
                <IconAlertTriangle size={20} color={colors.error} />
                <Text style={{ marginTop: 8, color: colors.error, fontSize: 13 }}>{driveError}</Text>
              </View>
            ) : driveFiles.length === 0 ? (
              <View style={{ padding: 32, alignItems: 'center' }}>
                <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
                  {t('attachment.driveEmpty') || 'Nenhum arquivo no Drive'}
                </Text>
              </View>
            ) : (
              <FlatList
                data={driveFiles}
                keyExtractor={(item) => String(item.id)}
                style={{ maxHeight: 480 }}
                renderItem={({ item }) => {
                  const id = String(item.id);
                  const picked = !!driveSelection[id];
                  return (
                    <TouchableOpacity
                      onPress={() => setDriveSelection(prev => ({ ...prev, [id]: !prev[id] }))}
                      style={{ flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight, backgroundColor: picked ? colors.primaryLight : 'transparent' }}
                    >
                      <View style={{ width: 36, height: 36, borderRadius: 8, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                        {iconForType(item.mime_type || item.mime, 18, colors.primary)}
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '500', color: colors.text }}>{item.name || item.filename}</Text>
                        <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 2 }}>{formatBytes(Number(item.size || item.size_bytes || 0))}</Text>
                      </View>
                      {picked && <IconCheckCircle size={20} color={colors.primary} />}
                    </TouchableOpacity>
                  );
                }}
              />
            )}
            <View style={{ flexDirection: 'row', padding: 12, gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderLight }}>
              <TouchableOpacity
                onPress={() => setShowDrive(false)}
                style={{ flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: colors.surfaceVariant }}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>
                  {t('common.cancel') || 'Cancelar'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={confirmDriveSelection}
                disabled={Object.values(driveSelection).filter(Boolean).length === 0}
                style={{ flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: colors.primary, opacity: Object.values(driveSelection).filter(Boolean).length === 0 ? 0.5 : 1 }}
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>
                  {t('attachment.attachSelected') || 'Anexar selecionados'} ({Object.values(driveSelection).filter(Boolean).length})
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: {
    gap: Spacing.sm,
  },

  // Add button
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    gap: Spacing.sm,
  },
  addBtnText: {
    flex: 1,
    fontSize: FontSize.base,
    fontWeight: '500',
  },
  addBtnHint: {
    fontSize: FontSize.sm,
  },

  // Error
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.sm,
    gap: Spacing.sm,
  },
  errorText: {
    flex: 1,
    fontSize: FontSize.sm,
  },

  // File list
  list: {
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
  },
  fileIcon: {
    width: 32,
    height: 32,
    borderRadius: BorderRadius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileThumb: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.sm,
  },
  fileMeta: {
    flex: 1,
    minWidth: 0,
  },
  fileName: {
    fontSize: FontSize.base,
    fontWeight: '500',
  },
  fileSize: {
    fontSize: FontSize.xs,
    marginTop: 1,
  },

  // Progress
  progressWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    width: 80,
  },
  progressTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBar: {
    height: 4,
    borderRadius: 2,
  },
  progressText: {
    fontSize: FontSize.xs,
    width: 30,
    textAlign: 'right',
  },

  ringWrap: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Remove
  removeBtn: {
    width: 26,
    height: 26,
    borderRadius: BorderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Total footer
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  totalLabel: {
    fontSize: FontSize.sm,
  },
  totalValue: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
});
