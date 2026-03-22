import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, TextInput,
  Image, ScrollView, Platform, ActivityIndicator, Dimensions,
  KeyboardAvoidingView, Animated, Pressable,
} from 'react-native';
import { IconX, IconImage, IconMapPin, IconCamera, IconChevronLeft, IconTrash, IconVideo } from './Icons';
import * as api from '../services/api';

const SCREEN_WIDTH = Dimensions.get('window').width;
const MAX_WIDTH = 600;
const ACCENT = '#25D366';
const MAX_CAPTION = 2200;
const MAX_MEDIA = 10;

export default function CreatePostModal({ visible, colors, isDark, t, user, onClose, onPostCreated }) {
  const [step, setStep] = useState(1); // 1 = select media, 2 = caption
  const [mediaFiles, setMediaFiles] = useState([]); // { uri, file, type, id }
  const [caption, setCaption] = useState('');
  const [location, setLocation] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [activePreviewIndex, setActivePreviewIndex] = useState(0);
  const [error, setError] = useState('');
  const scrollRef = useRef(null);

  const isWeb = Platform.OS === 'web';
  const cardWidth = Math.min(SCREEN_WIDTH, MAX_WIDTH);

  const reset = useCallback(() => {
    setStep(1);
    setMediaFiles([]);
    setCaption('');
    setLocation('');
    setPublishing(false);
    setActivePreviewIndex(0);
    setError('');
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const pickMedia = useCallback(() => {
    setError('');
    if (isWeb) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*,video/*';
      input.multiple = true;
      input.onchange = (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;
        const items = files.slice(0, MAX_MEDIA).map((file, idx) => ({
          uri: URL.createObjectURL(file),
          file,
          type: file.type.startsWith('video') ? 'video' : 'image',
          id: `${Date.now()}_${idx}`,
        }));
        setMediaFiles(prev => {
          const combined = [...prev, ...items].slice(0, MAX_MEDIA);
          return combined;
        });
        setStep(2);
      };
      input.click();
    } else {
      import('expo-image-picker').then(({ launchImageLibraryAsync, MediaTypeOptions }) => {
        launchImageLibraryAsync({
          mediaTypes: MediaTypeOptions.All,
          allowsMultipleSelection: true,
          quality: 0.8,
          selectionLimit: MAX_MEDIA,
        }).then((result) => {
          if (!result.canceled && result.assets?.length > 0) {
            const items = result.assets.map((asset, idx) => ({
              uri: asset.uri,
              file: {
                uri: asset.uri,
                name: asset.fileName || `media_${Date.now()}_${idx}.${asset.type === 'video' ? 'mp4' : 'jpg'}`,
                type: asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg'),
              },
              type: asset.type === 'video' ? 'video' : 'image',
              id: `${Date.now()}_${idx}`,
            }));
            setMediaFiles(prev => {
              const combined = [...prev, ...items].slice(0, MAX_MEDIA);
              return combined;
            });
            setStep(2);
          }
        });
      });
    }
  }, [isWeb]);

  const recordVideo = useCallback(() => {
    setError('');
    if (isWeb) {
      // On web, use file picker with video capture
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'video/*';
      input.capture = 'environment';
      input.onchange = (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;
        const file = files[0];
        const item = {
          uri: URL.createObjectURL(file),
          file,
          type: 'video',
          id: `${Date.now()}_rec`,
        };
        setMediaFiles(prev => [...prev, item].slice(0, MAX_MEDIA));
        setStep(2);
      };
      input.click();
    } else {
      import('expo-image-picker').then(({ launchCameraAsync, MediaTypeOptions }) => {
        launchCameraAsync({
          mediaTypes: MediaTypeOptions.Videos,
          quality: 0.7,
          videoMaxDuration: 60,
        }).then((result) => {
          if (!result.canceled && result.assets?.length > 0) {
            const asset = result.assets[0];
            // Derive extension from mimeType or URI
            const ext = (asset.mimeType === 'video/quicktime' ? 'mov' : 'mp4');
            const fileName = asset.fileName || `reel_${Date.now()}.${ext}`;
            const item = {
              uri: asset.uri,
              file: {
                uri: asset.uri,
                name: fileName,
                type: asset.mimeType || 'video/mp4',
              },
              type: 'video',
              id: `${Date.now()}_rec`,
            };
            setMediaFiles(prev => [...prev, item].slice(0, MAX_MEDIA));
            setStep(2);
          }
        }).catch((err) => {
          console.warn('Camera error:', err);
          setError(t('feed.cameraError') || 'Camera not available');
        });
      });
    }
  }, [isWeb]);

  const removeMedia = useCallback((id) => {
    setMediaFiles(prev => {
      const updated = prev.filter(m => m.id !== id);
      if (updated.length === 0) setStep(1);
      return updated;
    });
  }, []);

  const publish = useCallback(async () => {
    if (publishing || mediaFiles.length === 0) return;
    setPublishing(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('caption', caption.trim());
      if (location.trim()) formData.append('location', location.trim());

      const hasVideo = mediaFiles.some(m => m.type === 'video');
      formData.append('media_type', hasVideo ? 'video' : 'image');

      for (let i = 0; i < mediaFiles.length; i++) {
        const item = mediaFiles[i];
        if (isWeb) {
          formData.append('media[]', item.file, item.file.name);
        } else {
          formData.append('media[]', item.file);
        }
      }

      const r = await api.feedCreatePost(formData);
      if (r.success) {
        onPostCreated?.(r.data?.post || r.data);
        handleClose();
      } else {
        setError(r.error || t('feed.publishError') || 'Failed to publish');
        setPublishing(false);
      }
    } catch (err) {
      setError(t('feed.publishError') || 'Failed to publish');
      setPublishing(false);
    }
  }, [publishing, mediaFiles, caption, location, isWeb, handleClose, onPostCreated, t]);

  const bgColor = isDark ? '#0f172a' : '#ffffff';
  const surfaceColor = isDark ? '#1e293b' : '#f8fafc';
  const borderColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const captionRemaining = MAX_CAPTION - caption.length;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: bgColor }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: borderColor }]}>
          <TouchableOpacity
            onPress={step === 2 && mediaFiles.length > 0 ? () => setStep(1) : handleClose}
            style={styles.headerBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={step === 2 ? (t('common.back') || 'Back') : (t('common.close') || 'Close')}
            accessibilityRole="button"
          >
            {step === 2 && mediaFiles.length > 0 ? (
              <IconChevronLeft size={26} color={colors.text} />
            ) : (
              <IconX size={24} color={colors.text} />
            )}
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>
            {t('feed.createPost') || 'New Post'}
          </Text>
          {step === 2 ? (
            <TouchableOpacity
              onPress={publish}
              disabled={publishing || mediaFiles.length === 0}
              style={[styles.publishBtn, {
                backgroundColor: publishing || mediaFiles.length === 0 ? (isDark ? '#1a3a2a' : '#a8e6c1') : ACCENT,
              }]}
              accessibilityLabel={t('feed.publish') || 'Publish'}
              accessibilityRole="button"
            >
              {publishing ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.publishText}>{t('feed.publish') || 'Publish'}</Text>
              )}
            </TouchableOpacity>
          ) : (
            <View style={{ width: 80 }} />
          )}
        </View>

        {step === 1 ? (
          /* Step 1: Select media */
          <View style={styles.selectMediaWrap}>
            {mediaFiles.length > 0 ? (
              // Show thumbnail grid of already selected media
              <View style={styles.selectedGrid}>
                <ScrollView contentContainerStyle={styles.gridScroll} showsVerticalScrollIndicator={false}>
                  <View style={styles.gridContainer}>
                    {mediaFiles.map((item) => (
                      <View key={item.id} style={styles.gridItem}>
                        <Image
                          source={{ uri: item.uri }}
                          style={styles.gridImage}
                          resizeMode="cover"
                        />
                        {item.type === 'video' && (
                          <View style={styles.gridVideoBadge}>
                            <Text style={styles.gridVideoBadgeText}>VIDEO</Text>
                          </View>
                        )}
                        <TouchableOpacity
                          onPress={() => removeMedia(item.id)}
                          style={styles.gridRemoveBtn}
                          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                          accessibilityLabel={t('common.remove') || 'Remove'}
                          accessibilityRole="button"
                        >
                          <IconX size={14} color="#fff" />
                        </TouchableOpacity>
                      </View>
                    ))}
                    {mediaFiles.length < MAX_MEDIA && (
                      <TouchableOpacity
                        style={[styles.gridAddBtn, {
                          borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
                          backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
                        }]}
                        onPress={pickMedia}
                        activeOpacity={0.7}
                        accessibilityLabel={t('feed.addMore') || 'Add more'}
                        accessibilityRole="button"
                      >
                        <IconImage size={24} color={colors.textTertiary} />
                        <Text style={[styles.gridAddText, { color: colors.textTertiary }]}>
                          {t('feed.addMore') || 'Add'}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </ScrollView>
                <TouchableOpacity
                  style={styles.nextBtn}
                  onPress={() => setStep(2)}
                  activeOpacity={0.8}
                  accessibilityLabel={t('common.next') || 'Next'}
                  accessibilityRole="button"
                >
                  <Text style={styles.nextBtnText}>{t('common.next') || 'Next'}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              // Empty state - pick media
              <View style={styles.emptySelectWrap}>
                <View style={[styles.selectMediaCard, {
                  backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
                  borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
                }]}>
                  <View style={[styles.iconCircle, {
                    backgroundColor: isDark ? 'rgba(37,211,102,0.12)' : 'rgba(37,211,102,0.08)',
                  }]}>
                    <IconCamera size={44} color={ACCENT} />
                  </View>
                  <Text style={[styles.selectMediaTitle, { color: colors.text }]}>
                    {t('feed.selectMedia') || 'Select Photos & Videos'}
                  </Text>
                  <Text style={[styles.selectMediaSubtitle, { color: colors.textSecondary }]}>
                    {(t('feed.selectMediaHint') || 'Up to {max} items').replace('{max}', MAX_MEDIA)}
                  </Text>
                  <TouchableOpacity
                    style={styles.selectMediaBtn}
                    onPress={pickMedia}
                    activeOpacity={0.8}
                    accessibilityLabel={t('feed.selectMedia') || 'Select media'}
                    accessibilityRole="button"
                  >
                    <IconImage size={20} color="#fff" />
                    <Text style={styles.selectMediaBtnText}>
                      {t('feed.chooseFromGallery') || 'Choose from Gallery'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.selectMediaBtn, styles.recordVideoBtn]}
                    onPress={recordVideo}
                    activeOpacity={0.8}
                    accessibilityLabel={t('feed.recordVideo') || 'Record video'}
                    accessibilityRole="button"
                  >
                    <IconVideo size={20} color="#fff" />
                    <Text style={styles.selectMediaBtnText}>
                      {t('feed.recordVideo') || 'Record Video'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        ) : (
          /* Step 2: Preview + Caption */
          <ScrollView
            style={styles.step2Scroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Media preview */}
            <View style={styles.previewContainer}>
              {mediaFiles.length === 1 ? (
                mediaFiles[0].type === 'video' ? (
                  isWeb ? (
                    <View style={styles.previewImage}>
                      <video
                        src={mediaFiles[0].uri}
                        style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }}
                        controls
                        playsInline
                      />
                    </View>
                  ) : (
                    <View style={[styles.previewImage, { backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }]}>
                      {(() => {
                        try {
                          const { Video } = require('expo-av');
                          return (
                            <Video
                              source={{ uri: mediaFiles[0].uri }}
                              style={StyleSheet.absoluteFill}
                              resizeMode="contain"
                              useNativeControls
                              shouldPlay={false}
                            />
                          );
                        } catch {
                          return (
                            <>
                              <Image
                                source={{ uri: mediaFiles[0].uri }}
                                style={StyleSheet.absoluteFill}
                                resizeMode="contain"
                              />
                              <View style={styles.previewVideoBadge}>
                                <Text style={styles.previewVideoBadgeText}>VIDEO</Text>
                              </View>
                            </>
                          );
                        }
                      })()}
                    </View>
                  )
                ) : (
                  <Image
                    source={{ uri: mediaFiles[0].uri }}
                    style={styles.previewImage}
                    resizeMode="contain"
                    accessibilityLabel={t('feed.selectedMedia') || 'Selected media'}
                  />
                )
              ) : (
                <View>
                  <ScrollView
                    ref={scrollRef}
                    horizontal
                    pagingEnabled
                    showsHorizontalScrollIndicator={false}
                    decelerationRate="fast"
                    onScroll={(e) => {
                      const idx = Math.round(e.nativeEvent.contentOffset.x / cardWidth);
                      setActivePreviewIndex(idx);
                    }}
                    scrollEventThrottle={16}
                  >
                    {mediaFiles.map((item, idx) => (
                      <View key={item.id || idx} style={[styles.previewImage, { width: cardWidth }]}>
                        {item.type === 'video' ? (
                          isWeb ? (
                            <video
                              src={item.uri}
                              style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }}
                              controls
                              playsInline
                            />
                          ) : (() => {
                            try {
                              const { Video } = require('expo-av');
                              return (
                                <Video
                                  source={{ uri: item.uri }}
                                  style={StyleSheet.absoluteFill}
                                  resizeMode="contain"
                                  useNativeControls
                                  shouldPlay={false}
                                />
                              );
                            } catch {
                              return (
                                <>
                                  <Image
                                    source={{ uri: item.uri }}
                                    style={StyleSheet.absoluteFill}
                                    resizeMode="contain"
                                  />
                                  <View style={styles.previewVideoBadge}>
                                    <Text style={styles.previewVideoBadgeText}>VIDEO</Text>
                                  </View>
                                </>
                              );
                            }
                          })()
                        ) : (
                          <Image
                            source={{ uri: item.uri }}
                            style={StyleSheet.absoluteFill}
                            resizeMode="contain"
                            accessibilityLabel={`${t('feed.selectedMedia') || 'Media'} ${idx + 1}`}
                          />
                        )}
                      </View>
                    ))}
                  </ScrollView>
                  {/* Counter + dots */}
                  <View style={styles.previewCounter}>
                    <Text style={styles.previewCounterText}>
                      {activePreviewIndex + 1}/{mediaFiles.length}
                    </Text>
                  </View>
                  {mediaFiles.length <= 10 && (
                    <View style={styles.dotRow}>
                      {mediaFiles.map((_, idx) => (
                        <View
                          key={idx}
                          style={[styles.dot, {
                            width: idx === activePreviewIndex ? 8 : 6,
                            height: idx === activePreviewIndex ? 8 : 6,
                            borderRadius: 4,
                            backgroundColor: idx === activePreviewIndex ? ACCENT : 'rgba(255,255,255,0.5)',
                          }]}
                        />
                      ))}
                    </View>
                  )}
                </View>
              )}
            </View>

            {/* Caption */}
            <View style={[styles.captionSection, { borderTopColor: borderColor }]}>
              <TextInput
                style={[styles.captionInput, { color: colors.text }]}
                placeholder={t('feed.addCaption') || 'Write a caption...'}
                placeholderTextColor={colors.textTertiary}
                value={caption}
                onChangeText={setCaption}
                multiline
                maxLength={MAX_CAPTION}
                accessibilityLabel={t('feed.caption') || 'Caption'}
              />
              <Text style={[styles.charCount, {
                color: captionRemaining < 100
                  ? (captionRemaining < 20 ? '#ef4444' : '#f59e0b')
                  : colors.textTertiary,
              }]}>
                {captionRemaining}
              </Text>
            </View>

            {/* Location */}
            <View style={[styles.optionRow, { borderTopColor: borderColor }]}>
              <IconMapPin size={20} color={colors.textSecondary} />
              <TextInput
                style={[styles.locationInput, { color: colors.text }]}
                placeholder={t('feed.addLocation') || 'Add location'}
                placeholderTextColor={colors.textTertiary}
                value={location}
                onChangeText={setLocation}
                maxLength={100}
                accessibilityLabel={t('feed.location') || 'Location'}
              />
            </View>

            {/* Error message */}
            {error ? (
              <View style={styles.errorRow}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <View style={{ height: 120 }} />
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: Platform.OS === 'ios' ? 56 : Platform.OS === 'web' ? 16 : 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: {
    padding: 6,
    width: 80,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    flex: 1,
    letterSpacing: 0.1,
  },
  publishBtn: {
    paddingHorizontal: 22,
    paddingVertical: 9,
    borderRadius: 20,
    width: 80,
    alignItems: 'center',
  },
  publishText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  // Step 1 - empty state
  selectMediaWrap: {
    flex: 1,
  },
  emptySelectWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  selectMediaCard: {
    alignItems: 'center',
    padding: 44,
    borderRadius: 24,
    borderWidth: 2,
    borderStyle: 'dashed',
    width: '100%',
    maxWidth: 420,
  },
  iconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  selectMediaTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 6,
    textAlign: 'center',
  },
  selectMediaSubtitle: {
    fontSize: 14,
    marginBottom: 24,
    textAlign: 'center',
  },
  selectMediaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: ACCENT,
    paddingHorizontal: 28,
    paddingVertical: 13,
    borderRadius: 26,
  },
  selectMediaBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
  },
  recordVideoBtn: {
    backgroundColor: '#dc2626',
    marginTop: 12,
  },
  // Step 1 - grid with selected media
  selectedGrid: {
    flex: 1,
    paddingTop: 12,
  },
  gridScroll: {
    paddingHorizontal: 12,
    paddingBottom: 100,
  },
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  gridItem: {
    width: (SCREEN_WIDTH - 36) / 3,
    aspectRatio: 1,
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
  },
  gridImage: {
    width: '100%',
    height: '100%',
  },
  gridVideoBadge: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  gridVideoBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  gridRemoveBtn: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridAddBtn: {
    width: (SCREEN_WIDTH - 36) / 3,
    aspectRatio: 1,
    borderRadius: 8,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  gridAddText: {
    fontSize: 12,
    fontWeight: '600',
  },
  nextBtn: {
    position: 'absolute',
    bottom: 30,
    left: 20,
    right: 20,
    backgroundColor: ACCENT,
    paddingVertical: 14,
    borderRadius: 26,
    alignItems: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 12 },
      android: { elevation: 8 },
      default: {},
    }),
  },
  nextBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
    letterSpacing: 0.3,
  },
  // Step 2
  step2Scroll: {
    flex: 1,
  },
  previewContainer: {
    backgroundColor: '#000',
  },
  previewImage: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: '#000',
  },
  previewVideoBadge: {
    position: 'absolute',
    top: 14,
    left: 14,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  previewVideoBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  previewCounter: {
    position: 'absolute',
    top: 14,
    right: 14,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  previewCounterText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  dotRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 10,
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  dot: {
    // Dimensions set dynamically
  },
  captionSection: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  captionInput: {
    fontSize: 16,
    lineHeight: 22,
    minHeight: 80,
    maxHeight: 160,
    textAlignVertical: 'top',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  charCount: {
    fontSize: 12,
    textAlign: 'right',
    marginTop: 4,
    fontVariant: ['tabular-nums'],
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  locationInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  errorRow: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '500',
  },
});
