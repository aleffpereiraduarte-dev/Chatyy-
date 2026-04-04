import { useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, ActivityIndicator, Image } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconPaperclip, IconX, IconFileText, IconImage, IconMusic, IconFilm, IconAlertTriangle } from './Icons';

const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_SIZE = 55 * 1024 * 1024; // 55 MB

// ── Helpers ──────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function iconForType(type, size, color) {
  if (!type) return <IconFileText size={size} color={color} />;
  if (type.startsWith('image/')) return <IconImage size={size} color={color} />;
  if (type.startsWith('audio/')) return <IconMusic size={size} color={color} />;
  if (type.startsWith('video/')) return <IconFilm size={size} color={color} />;
  return <IconFileText size={size} color={color} />;
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

  const validate = useCallback((file) => {
    if (attachments.length >= maxFiles) {
      setError(t('attachment.maxFiles', { count: maxFiles }));
      return false;
    }
    if (file.size > maxSize) {
      setError(t('attachment.tooLarge', { name: file.name, limit: formatBytes(maxSize) }));
      return false;
    }
    // reject duplicates by name + size
    if (attachments.some(a => a.name === file.name && a.size === file.size)) {
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
      if (validate(file)) {
        onAdd && onAdd(file);
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
      assets.forEach((asset) => {
        const file = {
          name: asset.name,
          size: asset.size,
          type: asset.mimeType || asset.type || 'application/octet-stream',
          uri: asset.uri,
        };
        if (validate(file)) {
          onAdd && onAdd(file);
        }
      });
    } catch (err) {
      setError(t('attachment.pickerError'));
    }
  }, [canAdd, validate, onAdd]);

  const handlePress = Platform.OS === 'web' ? triggerWebPicker : triggerMobilePicker;

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <View style={s.container}>
      {/* Add-file button */}
      <TouchableOpacity
        style={[
          s.addBtn,
          {
            backgroundColor: colors.surfaceVariant,
            borderColor: colors.border,
            opacity: canAdd ? 1 : 0.5,
          },
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
            return (
              <View
                key={`${file.name}-${index}`}
                style={[
                  s.fileRow,
                  index < attachments.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight },
                ]}
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
                  <Text style={[s.fileSize, { color: colors.textTertiary }]}>
                    {formatBytes(file.size)}
                  </Text>
                </View>

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

                {progress != null && progress < 100 ? (
                  <ActivityIndicator size="small" color={colors.primary} style={{ marginLeft: Spacing.sm }} />
                ) : (
                  <TouchableOpacity
                    onPress={() => onRemove && onRemove(index)}
                    style={[s.removeBtn, { backgroundColor: colors.errorBg }]}
                    hitSlop={6}
                    disabled={disabled}
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
