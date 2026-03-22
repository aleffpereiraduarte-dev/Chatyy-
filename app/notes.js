import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet, Platform, ScrollView,
  Modal, Alert, Animated, Dimensions, FlatList, Pressable, ActivityIndicator,
  KeyboardAvoidingView, Linking, PanResponder, Easing,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing, Shadow, AnimTiming } from '../constants/theme';
import {
  IconArrowLeft, IconPlus, IconSearch, IconX, IconCheck,
  IconStickyNote, IconPin, IconTrash, IconArchive, IconEdit, IconFolder,
  IconMail, IconCopy, IconDownload, IconSend, IconMenu, IconZap,
} from '../components/Icons';
import * as api from '../services/api';
import { getCached, setCache } from '../services/cache';
import { ListSkeleton } from '../components/SkeletonLoader';

// ---- Note Color Definitions with Gradients ----
const NOTE_COLORS = [
  { id: '#FFF9C4', label: 'Yellow', dark: '#F9A825', gradient: ['#FFF9C4', '#FFF176'], shadowColor: 'rgba(255,241,118,0.4)', darkGradient: ['#3E3A1E', '#4A4520'], darkShadow: 'rgba(249,168,37,0.25)' },
  { id: '#F8BBD0', label: 'Pink', dark: '#E91E63', gradient: ['#F8BBD0', '#F48FB1'], shadowColor: 'rgba(244,143,177,0.4)', darkGradient: ['#3E1E2A', '#4A2535'], darkShadow: 'rgba(233,30,99,0.25)' },
  { id: '#C8E6C9', label: 'Green', dark: '#388E3C', gradient: ['#C8E6C9', '#A5D6A7'], shadowColor: 'rgba(165,214,167,0.4)', darkGradient: ['#1E3E20', '#254A28'], darkShadow: 'rgba(56,142,60,0.25)' },
  { id: '#BBDEFB', label: 'Blue', dark: '#1976D2', gradient: ['#BBDEFB', '#90CAF9'], shadowColor: 'rgba(144,202,249,0.4)', darkGradient: ['#1E2A3E', '#25354A'], darkShadow: 'rgba(25,118,210,0.25)' },
  { id: '#D1C4E9', label: 'Purple', dark: '#7B1FA2', gradient: ['#D1C4E9', '#B39DDB'], shadowColor: 'rgba(179,157,219,0.4)', darkGradient: ['#2E1E3E', '#38254A'], darkShadow: 'rgba(123,31,162,0.25)' },
  { id: '#FFE0B2', label: 'Orange', dark: '#F57C00', gradient: ['#FFE0B2', '#FFCC80'], shadowColor: 'rgba(255,204,128,0.4)', darkGradient: ['#3E2E1E', '#4A3825'], darkShadow: 'rgba(245,124,0,0.25)' },
  { id: '#FFFFFF', label: 'White', dark: '#9E9E9E', gradient: ['#FFFFFF', '#F5F5F5'], shadowColor: 'rgba(0,0,0,0.12)', darkGradient: ['#2A2A2A', '#333333'], darkShadow: 'rgba(255,255,255,0.08)' },
  { id: '#E0E0E0', label: 'Gray', dark: '#616161', gradient: ['#E0E0E0', '#BDBDBD'], shadowColor: 'rgba(0,0,0,0.15)', darkGradient: ['#353535', '#404040'], darkShadow: 'rgba(255,255,255,0.06)' },
];

// Tag colors for visual pills
const TAG_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#c026d3', '#4f46e5',
];

// Dark mode equivalents for note colors
const DARK_NOTE_COLORS = {
  '#FFF9C4': '#3E3A1E',
  '#F8BBD0': '#3E1E2A',
  '#C8E6C9': '#1E3E20',
  '#BBDEFB': '#1E2A3E',
  '#D1C4E9': '#2E1E3E',
  '#FFE0B2': '#3E2E1E',
  '#FFFFFF': '#2A2A2A',
  '#E0E0E0': '#353535',
};

// Text colors for dark mode note backgrounds
const DARK_NOTE_TEXT = {
  '#FFF9C4': '#FFF9C4',
  '#F8BBD0': '#F8BBD0',
  '#C8E6C9': '#C8E6C9',
  '#BBDEFB': '#BBDEFB',
  '#D1C4E9': '#D1C4E9',
  '#FFE0B2': '#FFE0B2',
  '#FFFFFF': '#E0E0E0',
  '#E0E0E0': '#BDBDBD',
};

// Helper to get gradient/shadow info for a color
function getColorMeta(colorId) {
  return NOTE_COLORS.find(c => c.id === colorId) || NOTE_COLORS[0];
}

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const isDesktop = Platform.OS === 'web' && SCREEN_WIDTH > 768;

// Random rotation for sticky note feel (-3 to 3 degrees)
function getRandomRotation(noteId) {
  const seed = typeof noteId === 'number' ? noteId : (noteId?.toString() || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return ((seed % 7) - 3);
}

// Board canvas dimensions
const BOARD_WIDTH = 4000;
const BOARD_HEIGHT = 4000;
const DEFAULT_NOTE_W = 220;
const DEFAULT_NOTE_H = 200;
const MIN_NOTE_W = 140;
const MIN_NOTE_H = 100;
const GRID_SIZE = 20;

function snapToGrid(val) {
  return Math.round(val / GRID_SIZE) * GRID_SIZE;
}

// Highlight search matches in text
function HighlightText({ text, highlight, style, numberOfLines }) {
  if (!highlight || !text) {
    return <Text style={style} numberOfLines={numberOfLines}>{text}</Text>;
  }
  const parts = text.split(new RegExp(`(${highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {parts.map((part, i) =>
        part.toLowerCase() === highlight.toLowerCase() ? (
          <Text key={i} style={{ backgroundColor: 'rgba(250, 204, 21, 0.4)', borderRadius: 2, fontWeight: '700' }}>{part}</Text>
        ) : (
          <Text key={i}>{part}</Text>
        )
      )}
    </Text>
  );
}

// Animated Note Card with staggered entrance (smoother spring)
function AnimatedNoteCard({ children, index, style }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(anim, {
      toValue: 1,
      delay: Math.min(index * 50, 500),
      tension: 80,
      friction: 10,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, []);

  return (
    <Animated.View style={[style, {
      opacity: anim,
      transform: [
        { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [30, 0] }) },
        { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) },
      ],
    }]}>
      {children}
    </Animated.View>
  );
}

// Delete animation wrapper
function DeletableNoteCard({ children, index, style, isDeleting }) {
  const anim = useRef(new Animated.Value(0)).current;
  const deleteAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.spring(anim, {
      toValue: 1,
      delay: Math.min(index * 50, 500),
      tension: 80,
      friction: 10,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, []);

  useEffect(() => {
    if (isDeleting) {
      Animated.parallel([
        Animated.timing(deleteAnim, { toValue: 0, duration: 300, easing: Easing.in(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
      ]).start();
    }
  }, [isDeleting]);

  return (
    <Animated.View style={[style, {
      opacity: Animated.multiply(anim, deleteAnim),
      transform: [
        { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [30, 0] }) },
        { scale: Animated.multiply(
          anim.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }),
          deleteAnim.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] })
        )},
      ],
    }]}>
      {children}
    </Animated.View>
  );
}


// ---- Draggable Sticky Note on Board ----
function BoardStickyNote({
  note, isDark, colors, onEdit, onContextMenu, onPositionChange, onResize,
  boardScale, snapEnabled,
}) {
  const colorMeta = getColorMeta(note.color);
  const bgColor = isDark ? (DARK_NOTE_COLORS[note.color] || '#2A2A2A') : (note.color || '#FFF9C4');
  const textColor = isDark ? (DARK_NOTE_TEXT[note.color] || '#E0E0E0') : '#212121';
  const secondaryColor = isDark ? ((DARK_NOTE_TEXT[note.color] || '#E0E0E0') + 'B3') : '#616161';
  const rotation = getRandomRotation(note.id);
  const shadowCol = isDark ? colorMeta.darkShadow : colorMeta.shadowColor;

  const noteW = note.width || DEFAULT_NOTE_W;
  const noteH = note.height || DEFAULT_NOTE_H;
  const posX = note.position_x || 0;
  const posY = note.position_y || 0;

  const pan = useRef(new Animated.ValueXY({ x: posX, y: posY })).current;
  const sizeAnim = useRef({ w: noteW, h: noteH }).current;
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [currentSize, setCurrentSize] = useState({ w: noteW, h: noteH });
  const lastTapRef = useRef(0);

  useEffect(() => {
    pan.setValue({ x: note.position_x || 0, y: note.position_y || 0 });
  }, [note.position_x, note.position_y]);

  useEffect(() => {
    setCurrentSize({ w: note.width || DEFAULT_NOTE_W, h: note.height || DEFAULT_NOTE_H });
  }, [note.width, note.height]);

  const dragResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 3 || Math.abs(g.dy) > 3,
      onPanResponderGrant: () => {
        pan.setOffset({ x: pan.x._value, y: pan.y._value });
        pan.setValue({ x: 0, y: 0 });
        setDragging(true);
      },
      onPanResponderMove: Animated.event(
        [null, { dx: pan.x, dy: pan.y }],
        { useNativeDriver: false }
      ),
      onPanResponderRelease: (_, g) => {
        pan.flattenOffset();
        setDragging(false);
        let finalX = pan.x._value;
        let finalY = pan.y._value;
        if (snapEnabled) {
          finalX = snapToGrid(finalX);
          finalY = snapToGrid(finalY);
          pan.setValue({ x: finalX, y: finalY });
        }
        finalX = Math.max(0, Math.min(BOARD_WIDTH - currentSize.w, finalX));
        finalY = Math.max(0, Math.min(BOARD_HEIGHT - currentSize.h, finalY));
        pan.setValue({ x: finalX, y: finalY });
        if (Math.abs(g.dx) > 3 || Math.abs(g.dy) > 3) {
          onPositionChange(note.id, finalX, finalY);
        }
      },
    })
  ).current;

  const resizeStartSize = useRef({ w: noteW, h: noteH });
  const currentSizeRef = useRef(currentSize);
  currentSizeRef.current = currentSize;
  const resizeResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        resizeStartSize.current = { ...currentSizeRef.current };
        setResizing(true);
      },
      onPanResponderMove: (_, g) => {
        const newW = Math.max(MIN_NOTE_W, resizeStartSize.current.w + g.dx / (boardScale || 1));
        const newH = Math.max(MIN_NOTE_H, resizeStartSize.current.h + g.dy / (boardScale || 1));
        setCurrentSize({ w: newW, h: newH });
      },
      onPanResponderRelease: () => {
        setResizing(false);
        let finalW = currentSizeRef.current.w;
        let finalH = currentSizeRef.current.h;
        if (snapEnabled) {
          finalW = snapToGrid(finalW);
          finalH = snapToGrid(finalH);
        }
        finalW = Math.max(MIN_NOTE_W, finalW);
        finalH = Math.max(MIN_NOTE_H, finalH);
        setCurrentSize({ w: finalW, h: finalH });
        onResize(note.id, finalW, finalH);
      },
    })
  ).current;

  const handleTap = () => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      onEdit(note);
    }
    lastTapRef.current = now;
  };

  const foldSize = Math.min(18, currentSize.w * 0.08);

  // Build gradient background for web
  const gradientBg = Platform.OS === 'web'
    ? (isDark
      ? `linear-gradient(135deg, ${colorMeta.darkGradient[0]}, ${colorMeta.darkGradient[1]})`
      : `linear-gradient(135deg, ${colorMeta.gradient[0]}, ${colorMeta.gradient[1]})`)
    : undefined;

  return (
    <Animated.View
      style={[
        boardStyles.stickyNote,
        {
          width: currentSize.w,
          height: currentSize.h,
          backgroundColor: bgColor,
          transform: [
            { translateX: pan.x },
            { translateY: pan.y },
            { rotate: `${rotation}deg` },
            ...(dragging ? [{ scale: 1.06 }] : []),
          ],
          zIndex: dragging || resizing ? 999 : 1,
          ...(Platform.OS === 'web' ? {
            background: gradientBg,
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            boxShadow: dragging
              ? `0 12px 32px ${shadowCol}, 0 4px 12px rgba(0,0,0,0.15)`
              : `0 6px 20px ${shadowCol}, 0 2px 8px rgba(0,0,0,0.08)`,
            transition: 'box-shadow 0.3s cubic-bezier(0.4,0,0.2,1), transform 0.2s cubic-bezier(0.4,0,0.2,1)',
          } : {
            ...Shadow.md,
          }),
        },
      ]}
      {...dragResponder.panHandlers}
    >
      {/* Thumbtack pin icon at top */}
      <View style={boardStyles.thumbtack}>
        <View style={[boardStyles.thumbtackHead, {
          backgroundColor: note.is_pinned ? '#FFD54F' : (isDark ? '#666' : '#bbb'),
          ...(Platform.OS === 'web' && note.is_pinned ? {
            boxShadow: '0 0 8px rgba(255,213,79,0.6)',
          } : {}),
        }]} />
        <View style={[boardStyles.thumbtackPin, {
          backgroundColor: isDark ? '#555' : '#999',
        }]} />
      </View>

      {/* Folded corner */}
      <View style={[boardStyles.foldedCorner, {
        width: foldSize,
        height: foldSize,
        borderBottomColor: isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.08)',
        borderRightColor: isDark ? 'rgba(255,255,255,0.05)' : '#fff',
      }]} />

      {/* Content area */}
      <Pressable
        onPress={handleTap}
        onLongPress={() => onContextMenu(note)}
        style={boardStyles.stickyContent}
      >
        {note.title ? (
          <Text style={[boardStyles.stickyTitle, { color: textColor }]} numberOfLines={2}>
            {note.title}
          </Text>
        ) : null}
        {note.content ? (
          <Text style={[boardStyles.stickyBody, { color: secondaryColor }]} numberOfLines={8}>
            {note.content}
          </Text>
        ) : null}
        {!note.title && !note.content && (
          <Text style={[boardStyles.stickyBody, { color: secondaryColor, fontStyle: 'italic' }]}>
            ...
          </Text>
        )}
      </Pressable>

      {/* Tags */}
      {note.tags && note.tags.length > 0 && (
        <View style={boardStyles.stickyTags}>
          {note.tags.slice(0, 2).map((tag, i) => (
            <View key={i} style={[boardStyles.stickyTagPill, { backgroundColor: (TAG_COLORS[i % TAG_COLORS.length]) + '22' }]}>
              <Text style={[boardStyles.stickyTagText, { color: TAG_COLORS[i % TAG_COLORS.length] }]} numberOfLines={1}>{tag}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Notebook tag at bottom */}
      {note.notebook_name ? (
        <View style={[boardStyles.stickyNotebook, { backgroundColor: (note.notebook_color || '#4285F4') + '22' }]}>
          <Text style={[boardStyles.stickyNotebookText, { color: note.notebook_color || '#4285F4' }]} numberOfLines={1}>
            {note.notebook_name}
          </Text>
        </View>
      ) : null}

      {/* Resize handle */}
      <View
        style={boardStyles.resizeHandle}
        {...resizeResponder.panHandlers}
      >
        <View style={[boardStyles.resizeDots, { borderColor: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.2)' }]} />
      </View>
    </Animated.View>
  );
}


// ---- Minimap Component ----
function BoardMinimap({ notes, isDark, colors, boardScale, scrollOffset, viewportSize }) {
  const MINIMAP_W = 120;
  const MINIMAP_H = 90;
  const scaleX = MINIMAP_W / BOARD_WIDTH;
  const scaleY = MINIMAP_H / BOARD_HEIGHT;

  const vpW = (viewportSize.w / boardScale) * scaleX;
  const vpH = (viewportSize.h / boardScale) * scaleY;
  const vpX = (scrollOffset.x / boardScale) * scaleX;
  const vpY = (scrollOffset.y / boardScale) * scaleY;

  if (!notes || notes.length === 0) return null;

  return (
    <View style={[boardStyles.minimap, {
      backgroundColor: isDark ? 'rgba(20,20,35,0.85)' : 'rgba(255,255,255,0.88)',
      borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
      ...(Platform.OS === 'web' ? {
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      } : {}),
    }]}>
      {notes.map(note => {
        const nx = (note.position_x || 0) * scaleX;
        const ny = (note.position_y || 0) * scaleY;
        const nw = Math.max(3, (note.width || DEFAULT_NOTE_W) * scaleX);
        const nh = Math.max(2, (note.height || DEFAULT_NOTE_H) * scaleY);
        const colorMeta = getColorMeta(note.color);
        return (
          <View key={note.id} style={{
            position: 'absolute',
            left: nx, top: ny, width: nw, height: nh,
            backgroundColor: isDark ? (DARK_NOTE_COLORS[note.color] || '#444') : (note.color || '#FFF9C4'),
            borderRadius: 1,
            opacity: 0.85,
          }} />
        );
      })}
      {/* Viewport indicator */}
      <View style={{
        position: 'absolute',
        left: vpX, top: vpY,
        width: Math.min(vpW, MINIMAP_W), height: Math.min(vpH, MINIMAP_H),
        borderWidth: 1.5,
        borderColor: colors.primary,
        borderRadius: 2,
        backgroundColor: colors.primary + '12',
      }} />
    </View>
  );
}


// ---- Board View (Canvas with Draggable Notes) ----
function BoardView({
  notes, isDark, colors, t, onEdit, onContextMenu, onPositionChange, onResize,
  onCreateAtPosition, snapEnabled,
}) {
  const scrollViewRef = useRef(null);
  const [boardScale, setBoardScale] = useState(1);
  const lastDoubleTapRef = useRef({ time: 0, x: 0, y: 0 });
  const scrollOffsetRef = useRef({ x: 0, y: 0 });
  const [scrollPos, setScrollPos] = useState({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState({ w: SCREEN_WIDTH, h: SCREEN_HEIGHT });

  const handleCanvasPress = useCallback((evt) => {
    const now = Date.now();
    const ne = evt.nativeEvent;
    const locationX = ne.locationX ?? ne.offsetX ?? ne.pageX ?? 0;
    const locationY = ne.locationY ?? ne.offsetY ?? ne.pageY ?? 0;
    const last = lastDoubleTapRef.current;

    if (now - last.time < 400 && Math.abs(locationX - last.x) < 40 && Math.abs(locationY - last.y) < 40) {
      const noteX = (locationX + scrollOffsetRef.current.x) / boardScale;
      const noteY = (locationY + scrollOffsetRef.current.y) / boardScale;
      onCreateAtPosition(
        snapEnabled ? snapToGrid(noteX) : noteX,
        snapEnabled ? snapToGrid(noteY) : noteY
      );
      lastDoubleTapRef.current = { time: 0, x: 0, y: 0 };
    } else {
      lastDoubleTapRef.current = { time: now, x: locationX, y: locationY };
    }
  }, [boardScale, onCreateAtPosition, snapEnabled]);

  const handleScroll = useCallback((evt) => {
    const newPos = {
      x: evt.nativeEvent.contentOffset.x,
      y: evt.nativeEvent.contentOffset.y,
    };
    scrollOffsetRef.current = newPos;
    setScrollPos(newPos);
  }, []);

  const zoomIn = useCallback(() => setBoardScale(s => Math.min(2, s + 0.15)), []);
  const zoomOut = useCallback(() => setBoardScale(s => Math.max(0.3, s - 0.15)), []);
  const zoomReset = useCallback(() => setBoardScale(1), []);

  return (
    <View style={{ flex: 1 }} onLayout={(e) => {
      const { width, height } = e.nativeEvent.layout;
      setViewportSize({ w: width, h: height });
    }}>
      <ScrollView
        ref={scrollViewRef}
        horizontal
        style={{ flex: 1 }}
        contentContainerStyle={{
          width: BOARD_WIDTH * boardScale,
          height: BOARD_HEIGHT * boardScale,
        }}
        scrollEnabled
        onScroll={handleScroll}
        scrollEventThrottle={16}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
      >
        <ScrollView
          contentContainerStyle={{
            width: BOARD_WIDTH * boardScale,
            height: BOARD_HEIGHT * boardScale,
          }}
          scrollEnabled
          showsVerticalScrollIndicator={false}
          nestedScrollEnabled
          onScroll={handleScroll}
          scrollEventThrottle={16}
        >
          <Pressable
            onPress={handleCanvasPress}
            style={[boardStyles.canvas, {
              width: BOARD_WIDTH * boardScale,
              height: BOARD_HEIGHT * boardScale,
              backgroundColor: isDark ? '#12121e' : '#f0ebe3',
            }]}
          >
            {Platform.OS === 'web' && (
              <View style={[boardStyles.gridPattern, {
                backgroundImage: isDark
                  ? `radial-gradient(circle, rgba(255,255,255,0.08) 1.2px, transparent 1.2px)`
                  : `radial-gradient(circle, rgba(0,0,0,0.08) 1.2px, transparent 1.2px)`,
                backgroundSize: `${GRID_SIZE * boardScale}px ${GRID_SIZE * boardScale}px`,
              }]} />
            )}

            <View style={{ transform: [{ scale: boardScale }], transformOrigin: 'top left' }}>
              {notes.map(note => (
                <BoardStickyNote
                  key={note.id}
                  note={note}
                  isDark={isDark}
                  colors={colors}
                  onEdit={onEdit}
                  onContextMenu={onContextMenu}
                  onPositionChange={onPositionChange}
                  onResize={onResize}
                  boardScale={boardScale}
                  snapEnabled={snapEnabled}
                />
              ))}
            </View>
          </Pressable>
        </ScrollView>
      </ScrollView>

      {/* Minimap */}
      <BoardMinimap
        notes={notes}
        isDark={isDark}
        colors={colors}
        boardScale={boardScale}
        scrollOffset={scrollPos}
        viewportSize={viewportSize}
      />

      {/* Zoom controls */}
      <View style={[boardStyles.zoomControls, {
        backgroundColor: isDark ? 'rgba(20,20,35,0.9)' : 'rgba(255,255,255,0.92)',
        borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
        ...(Platform.OS === 'web' ? {
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
        } : {}),
      }]}>
        <TouchableOpacity onPress={zoomIn} style={boardStyles.zoomBtn}>
          <Text style={[boardStyles.zoomText, { color: colors.text }]}>+</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={zoomReset} style={boardStyles.zoomBtn}>
          <Text style={[boardStyles.zoomPercent, { color: colors.textSecondary }]}>{Math.round(boardScale * 100)}%</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={zoomOut} style={boardStyles.zoomBtn}>
          <Text style={[boardStyles.zoomText, { color: colors.text }]}>-</Text>
        </TouchableOpacity>
      </View>

      {/* Empty hint */}
      {notes.length === 0 && (
        <View style={boardStyles.boardHint}>
          <Text style={[boardStyles.boardHintText, { color: colors.textTertiary }]}>
            {t('notes.doubleTapCreate')}
          </Text>
        </View>
      )}

      {/* FAB to create note */}
      <TouchableOpacity
        onPress={() => {
          const cx = (scrollOffsetRef.current.x + 150) / boardScale;
          const cy = (scrollOffsetRef.current.y + 150) / boardScale;
          onCreateAtPosition(snapEnabled ? snapToGrid(cx) : cx, snapEnabled ? snapToGrid(cy) : cy);
        }}
        style={[boardStyles.fab, {
          backgroundColor: colors.primary,
          ...(Platform.OS === 'web' ? {
            background: `linear-gradient(135deg, ${colors.primary}, ${colors.primary}dd)`,
            boxShadow: `0 6px 20px ${colors.primary}55`,
          } : {}),
        }]}
        activeOpacity={0.8}
      >
        <Text style={boardStyles.fabText}>+</Text>
      </TouchableOpacity>
    </View>
  );
}


export default function NotesScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const [notes, setNotes] = useState([]);
  const [notebooks, setNotebooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [activeTab, setActiveTab] = useState('all'); // all, notebooks, archived
  const [activeFilter, setActiveFilter] = useState('all'); // all, pinned, recent
  const [selectedNotebook, setSelectedNotebook] = useState(null);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editingNote, setEditingNote] = useState(null);
  const [colorPickerVisible, setColorPickerVisible] = useState(false);
  const [colorPickerNote, setColorPickerNote] = useState(null);
  const [notebookModalVisible, setNotebookModalVisible] = useState(false);
  const [notebookName, setNotebookName] = useState('');
  const [notebookColor, setNotebookColor] = useState('#4285F4');
  const [editingNotebook, setEditingNotebook] = useState(null);
  const [contextNote, setContextNote] = useState(null);
  const [contextMenuVisible, setContextMenuVisible] = useState(false);
  const [emailModalVisible, setEmailModalVisible] = useState(false);
  const [emailModalNote, setEmailModalNote] = useState(null);
  const [emailAddress, setEmailAddress] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [viewMode, setViewMode] = useState(isDesktop ? 'board' : 'list'); // 'board' or 'list' - mobile defaults to list
  const [snapEnabled, setSnapEnabled] = useState(false);
  const [quickNoteLoading, setQuickNoteLoading] = useState(false);
  const [deletingNoteId, setDeletingNoteId] = useState(null);
  const [recentSearches, setRecentSearches] = useState([]);

  // Search bar animation
  const searchExpandAnim = useRef(new Animated.Value(0)).current;
  // View toggle slide animation
  const viewToggleAnim = useRef(new Animated.Value(0)).current;

  // Auto-save refs
  const saveTimerRef = useRef(null);
  const editorTitleRef = useRef('');
  const editorContentRef = useRef('');
  const editorColorRef = useRef('#FFF9C4');
  const editorPinnedRef = useRef(false);
  const editorStickyRef = useRef(false);
  const editorNotebookRef = useRef(null);
  const editorTagsRef = useRef([]);

  // Animation refs
  const emptyAnim = useRef(new Animated.Value(0)).current;
  const quickNoteAnim = useRef(new Animated.Value(1)).current;
  // Floating notes animation for empty state
  const floatAnim1 = useRef(new Animated.Value(0)).current;
  const floatAnim2 = useRef(new Animated.Value(0)).current;
  const floatAnim3 = useRef(new Animated.Value(0)).current;

  // Animate view toggle
  useEffect(() => {
    Animated.spring(viewToggleAnim, {
      toValue: viewMode === 'board' ? 0 : 1,
      tension: 120,
      friction: 14,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [viewMode]);

  // Load notes
  const loadNotes = useCallback(async (showLoading = true) => {
    const isDefaultView = activeTab !== 'archived' && !selectedNotebook && !searchQuery.trim();
    const cacheKey = 'notes';
    if (showLoading && isDefaultView) {
      const cached = await getCached(cacheKey);
      if (cached?.data?.notes) {
        setNotes(cached.data.notes);
        setLoading(false);
        showLoading = false;
      } else {
        setLoading(true);
      }
    } else if (showLoading) {
      setLoading(true);
    }
    try {
      const filters = {};
      if (activeTab === 'archived') filters.archived = 1;
      if (selectedNotebook) filters.notebook_id = selectedNotebook;
      if (searchQuery.trim()) filters.search = searchQuery.trim();
      const res = await api.notesList(filters);
      if (res?.success) {
        setNotes(res.data?.notes || []);
        if (isDefaultView) setCache(cacheKey, res, 600000).catch(() => {});
      }
    } catch (e) {
      console.warn('Failed to load notes:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeTab, selectedNotebook, searchQuery]);

  const loadNotebooks = useCallback(async () => {
    const cached = await getCached('notebooks');
    if (cached?.data?.notebooks) setNotebooks(cached.data.notebooks);
    try {
      const res = await api.notebooksList();
      if (res?.success) {
        setNotebooks(res.data?.notebooks || []);
        setCache('notebooks', res, 600000).catch(() => {});
      }
    } catch (e) {
      console.warn('Failed to load notebooks:', e);
    }
  }, []);

  useEffect(() => { loadNotes(); }, [loadNotes]);
  useEffect(() => { loadNotebooks(); }, [loadNotebooks]);

  // Empty state animation with floating notes
  useEffect(() => {
    if (!loading && notes.length === 0 && activeTab !== 'notebooks') {
      emptyAnim.setValue(0);
      Animated.spring(emptyAnim, {
        toValue: 1,
        tension: 60,
        friction: 8,
        useNativeDriver: Platform.OS !== 'web',
      }).start();

      // Start floating animation loop
      const createFloat = (anim, dur) => {
        return Animated.loop(
          Animated.sequence([
            Animated.timing(anim, { toValue: 1, duration: dur, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
            Animated.timing(anim, { toValue: 0, duration: dur, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
          ])
        );
      };
      const a1 = createFloat(floatAnim1, 3000);
      const a2 = createFloat(floatAnim2, 3500);
      const a3 = createFloat(floatAnim3, 2800);
      a1.start();
      setTimeout(() => a2.start(), 500);
      setTimeout(() => a3.start(), 1000);
      return () => { a1.stop(); a2.stop(); a3.stop(); };
    }
  }, [loading, notes.length, activeTab]);

  // Search debounce
  const searchTimerRef = useRef(null);
  const handleSearch = useCallback((text) => {
    setSearchQuery(text);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => loadNotes(false), 400);
  }, [loadNotes]);

  // Track recent searches
  const commitSearch = useCallback((q) => {
    if (!q.trim()) return;
    setRecentSearches(prev => {
      const filtered = prev.filter(s => s !== q.trim());
      return [q.trim(), ...filtered].slice(0, 5);
    });
  }, []);

  // Search expand animation
  useEffect(() => {
    Animated.spring(searchExpandAnim, {
      toValue: showSearch ? 1 : 0,
      tension: 120,
      friction: 14,
      useNativeDriver: false,
    }).start();
  }, [showSearch]);

  // Quick Note - creates and opens immediately
  const handleQuickNote = useCallback(async () => {
    setQuickNoteLoading(true);
    Animated.sequence([
      Animated.timing(quickNoteAnim, { toValue: 0.85, duration: 100, useNativeDriver: Platform.OS !== 'web' }),
      Animated.spring(quickNoteAnim, { toValue: 1, tension: 200, friction: 10, useNativeDriver: Platform.OS !== 'web' }),
    ]).start();
    try {
      const randomColors = ['#FFF9C4', '#F8BBD0', '#C8E6C9', '#BBDEFB', '#D1C4E9', '#FFE0B2'];
      const color = randomColors[Math.floor(Math.random() * randomColors.length)];
      const res = await api.notesCreate({
        title: '', content: '', color,
        is_pinned: 0, is_sticky: 0,
        notebook_id: selectedNotebook,
      });
      if (res?.success && res.data?.id) {
        const newNote = {
          id: res.data.id, title: '', content: '', color,
          notebook_id: selectedNotebook,
        };
        openEditor(newNote);
        loadNotes(false);
      }
    } catch (e) {
      console.warn('Quick note failed:', e);
    } finally {
      setQuickNoteLoading(false);
    }
  }, [selectedNotebook, loadNotes]);

  // Create/Edit note
  const openEditor = useCallback((note = null) => {
    if (note) {
      setEditingNote(note);
      editorTitleRef.current = note.title;
      editorContentRef.current = note.content;
      editorColorRef.current = note.color || '#FFF9C4';
      editorPinnedRef.current = note.is_pinned;
      editorStickyRef.current = note.is_sticky;
      editorNotebookRef.current = note.notebook_id;
      editorTagsRef.current = note.tags || [];
    } else {
      setEditingNote(null);
      editorTitleRef.current = '';
      editorContentRef.current = '';
      editorColorRef.current = '#FFF9C4';
      editorPinnedRef.current = false;
      editorStickyRef.current = false;
      editorNotebookRef.current = selectedNotebook;
      editorTagsRef.current = [];
    }
    setEditorVisible(true);
  }, [selectedNotebook]);

  // Create note at specific board position
  const createNoteAtPosition = useCallback(async (x, y) => {
    try {
      const randomColors = ['#FFF9C4', '#F8BBD0', '#C8E6C9', '#BBDEFB', '#D1C4E9', '#FFE0B2'];
      const color = randomColors[Math.floor(Math.random() * randomColors.length)];
      const res = await api.notesCreate({
        title: '', content: '', color,
        is_pinned: 0, is_sticky: 0,
        notebook_id: selectedNotebook,
        position_x: x, position_y: y,
        width: DEFAULT_NOTE_W, height: DEFAULT_NOTE_H,
      });
      if (res?.success && res.data?.id) {
        loadNotes(false);
        const newNote = {
          id: res.data.id, title: '', content: '', color,
          position_x: x, position_y: y, width: DEFAULT_NOTE_W, height: DEFAULT_NOTE_H,
          notebook_id: selectedNotebook,
        };
        openEditor(newNote);
      }
    } catch (e) {
      console.warn('Failed to create note at position:', e);
    }
  }, [selectedNotebook, loadNotes, openEditor]);

  // Auto-save
  const saveNote = useCallback(async () => {
    const title = editorTitleRef.current;
    const content = editorContentRef.current;
    const color = editorColorRef.current;
    const is_pinned = editorPinnedRef.current ? 1 : 0;
    const is_sticky = editorStickyRef.current ? 1 : 0;
    const notebook_id = editorNotebookRef.current;
    const tags = editorTagsRef.current;

    if (!title.trim() && !content.trim()) return;

    try {
      if (editingNote?.id) {
        await api.notesUpdate(editingNote.id, { title, content, color, is_pinned, is_sticky, notebook_id, tags });
      } else {
        const res = await api.notesCreate({ title, content, color, is_pinned, is_sticky, notebook_id, tags });
        if (res?.success && res.data?.id) {
          setEditingNote(prev => prev ? { ...prev, id: res.data.id } : { id: res.data.id });
        }
      }
    } catch (e) {
      console.warn('Failed to save note:', e);
    }
  }, [editingNote]);

  const triggerAutoSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(saveNote, 2000);
  }, [saveNote]);

  const closeEditor = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    await saveNote();
    setEditorVisible(false);
    setEditingNote(null);
    loadNotes(false);
  }, [saveNote, loadNotes]);

  // Delete note with animation
  const deleteNote = useCallback(async (note) => {
    const doDelete = async () => {
      setDeletingNoteId(note.id);
      // Wait for animation
      setTimeout(async () => {
        try {
          await api.notesDelete(note.id);
          loadNotes(false);
        } catch (e) {
          console.warn('Failed to delete note:', e);
        }
        setDeletingNoteId(null);
      }, 320);
    };
    if (Platform.OS === 'web') {
      if (confirm(t('notes.deleteConfirm'))) doDelete();
    } else {
      Alert.alert(t('notes.deleteNote'), t('notes.deleteConfirm'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.delete'), style: 'destructive', onPress: doDelete },
      ]);
    }
  }, [loadNotes, t]);

  // Toggle pin
  const togglePin = useCallback(async (note) => {
    try {
      await api.notesUpdate(note.id, { is_pinned: note.is_pinned ? 0 : 1 });
      loadNotes(false);
    } catch (e) {}
  }, [loadNotes]);

  // Toggle archive
  const toggleArchive = useCallback(async (note) => {
    try {
      await api.notesUpdate(note.id, { is_archived: note.is_archived ? 0 : 1 });
      loadNotes(false);
    } catch (e) {}
  }, [loadNotes]);

  // Change color
  const changeColor = useCallback(async (note, color) => {
    try {
      await api.notesUpdate(note.id, { color });
      loadNotes(false);
      setColorPickerVisible(false);
    } catch (e) {}
  }, [loadNotes]);

  // Update note position on board
  const updateNotePosition = useCallback(async (noteId, x, y) => {
    try {
      await api.notesUpdate(noteId, { position_x: x, position_y: y });
    } catch (e) {
      console.warn('Failed to update note position:', e);
    }
  }, []);

  // Update note size on board
  const updateNoteSize = useCallback(async (noteId, w, h) => {
    try {
      await api.notesUpdate(noteId, { width: w, height: h });
    } catch (e) {
      console.warn('Failed to update note size:', e);
    }
  }, []);

  // Notebook CRUD
  const saveNotebook = useCallback(async () => {
    if (!notebookName.trim()) return;
    try {
      if (editingNotebook) {
        await api.notebooksUpdate(editingNotebook.id, { name: notebookName, color: notebookColor });
      } else {
        await api.notebooksCreate({ name: notebookName, color: notebookColor });
      }
      setNotebookModalVisible(false);
      setNotebookName('');
      setEditingNotebook(null);
      loadNotebooks();
    } catch (e) {}
  }, [notebookName, notebookColor, editingNotebook, loadNotebooks]);

  const deleteNotebook = useCallback(async (nb) => {
    const doDelete = async () => {
      try {
        await api.notebooksDelete(nb.id);
        if (selectedNotebook === nb.id) setSelectedNotebook(null);
        loadNotebooks();
        loadNotes(false);
      } catch (e) {}
    };
    if (Platform.OS === 'web') {
      if (confirm(t('notes.deleteNotebookConfirm'))) doDelete();
    } else {
      Alert.alert(t('notes.deleteNotebook'), t('notes.deleteNotebookConfirm'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.delete'), style: 'destructive', onPress: doDelete },
      ]);
    }
  }, [selectedNotebook, loadNotebooks, loadNotes, t]);

  // Send note by email
  const sendNoteByEmail = useCallback(async () => {
    if (!emailModalNote || !emailAddress.trim()) return;
    setEmailSending(true);
    try {
      const res = await api.notesSendEmail(emailModalNote.id, emailAddress.trim());
      if (res?.success) {
        if (Platform.OS === 'web') { alert(t('notes.sentSuccess')); }
        else { Alert.alert('', t('notes.sentSuccess')); }
        setEmailModalVisible(false);
        setEmailAddress('');
        setEmailModalNote(null);
      } else {
        const msg = res?.message || t('notes.sentError');
        if (Platform.OS === 'web') { alert(msg); }
        else { Alert.alert('', msg); }
      }
    } catch (e) {
      if (Platform.OS === 'web') { alert(t('notes.sentError')); }
      else { Alert.alert('', t('notes.sentError')); }
    } finally {
      setEmailSending(false);
    }
  }, [emailModalNote, emailAddress, t]);

  // Export note as PDF
  const exportNotePdf = useCallback(async (note) => {
    if (!note?.id) return;
    try {
      const url = `${api.BASE_URL}/api/email.php?action=notes_export_pdf&id=${note.id}&token=${encodeURIComponent(await api.getToken())}`;
      if (Platform.OS === 'web') {
        window.open(url, '_blank');
      } else {
        Linking.openURL(url);
      }
    } catch (e) {
      console.warn('Export PDF failed:', e);
    }
  }, []);

  // Copy note text to clipboard
  const copyNoteText = useCallback(async (note) => {
    const text = [note.title, note.content].filter(Boolean).join('\n\n');
    if (!text) {
      if (Platform.OS === 'web') { alert(t('notes.nothingToCopy')); }
      else { Alert.alert('', t('notes.nothingToCopy')); }
      return;
    }
    try {
      if (Platform.OS === 'web') {
        await navigator.clipboard.writeText(text);
      } else {
        await Clipboard.setStringAsync(text);
      }
      if (Platform.OS === 'web') { alert(t('notes.copied')); }
      else { Alert.alert('', t('notes.copied')); }
    } catch (e) {
      console.warn('Copy failed:', e);
    }
  }, [t]);

  // Filter notes based on active filter
  const filteredNotes = useMemo(() => {
    let filtered = notes;
    if (activeFilter === 'pinned') {
      filtered = notes.filter(n => n.is_pinned);
    } else if (activeFilter === 'recent') {
      filtered = [...notes].sort((a, b) => {
        const da = new Date(a.updated_at || a.created_at || 0).getTime();
        const db = new Date(b.updated_at || b.created_at || 0).getTime();
        return db - da;
      }).slice(0, 20);
    }
    return filtered;
  }, [notes, activeFilter]);

  // Separated pinned and unpinned notes
  const pinnedNotes = useMemo(() => filteredNotes.filter(n => n.is_pinned), [filteredNotes]);
  const unpinnedNotes = useMemo(() => filteredNotes.filter(n => !n.is_pinned), [filteredNotes]);

  const getNoteBg = (color) => isDark ? (DARK_NOTE_COLORS[color] || '#2A2A2A') : (color || '#FFF9C4');
  const getNoteText = (color) => isDark ? (DARK_NOTE_TEXT[color] || '#E0E0E0') : '#212121';
  const getNoteSecondary = (color) => isDark ? ((DARK_NOTE_TEXT[color] || '#BDBDBD') + 'B3') : '#616161';

  // ---- Note Card (List View) with premium Google Keep-like design ----
  const NoteCard = ({ note, index }) => {
    const colorMeta = getColorMeta(note.color);
    const bgColor = getNoteBg(note.color);
    const textColor = getNoteText(note.color);
    const secondaryColor = getNoteSecondary(note.color);
    const shadowCol = isDark ? colorMeta.darkShadow : colorMeta.shadowColor;
    const [hovered, setHovered] = useState(false);
    const webHover = Platform.OS === 'web' ? {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
    } : {};

    // Gradient background for web
    const gradientBg = Platform.OS === 'web'
      ? (isDark
        ? `linear-gradient(135deg, ${colorMeta.darkGradient[0]}, ${colorMeta.darkGradient[1]})`
        : `linear-gradient(135deg, ${colorMeta.gradient[0]}, ${colorMeta.gradient[1]})`)
      : undefined;

    const isDeleting = deletingNoteId === note.id;

    // Swipe to delete on mobile
    const swipeX = useRef(new Animated.Value(0)).current;
    const swipeResponder = useRef(
      !isDesktop ? PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 15 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderMove: (_, g) => {
          if (g.dx < 0) { // Only allow swipe left
            swipeX.setValue(g.dx);
          }
        },
        onPanResponderRelease: (_, g) => {
          if (g.dx < -100) {
            // Swipe far enough -> delete
            Animated.timing(swipeX, { toValue: -SCREEN_WIDTH, duration: 250, useNativeDriver: Platform.OS !== 'web' }).start(() => {
              deleteNote(note);
              swipeX.setValue(0);
            });
          } else {
            Animated.spring(swipeX, { toValue: 0, tension: 120, friction: 14, useNativeDriver: Platform.OS !== 'web' }).start();
          }
        },
      }) : { panHandlers: {} }
    ).current;

    return (
      <DeletableNoteCard index={index} style={{}} isDeleting={isDeleting}>
        {/* Delete background indicator (mobile swipe) */}
        {!isDesktop && (
          <View style={s.swipeDeleteBg}>
            <View style={[s.swipeDeleteInner, { backgroundColor: colors.error }]}>
              <IconTrash size={20} color="#fff" />
              <Text style={s.swipeDeleteText}>{t('notes.deleteNote')}</Text>
            </View>
          </View>
        )}
        <Animated.View
          style={[
            !isDesktop && { transform: [{ translateX: swipeX }] },
          ]}
          {...(isDesktop ? {} : swipeResponder.panHandlers)}
        >
          <Pressable
            onPress={() => openEditor(note)}
            onLongPress={() => {
              setContextNote(note);
              setContextMenuVisible(true);
            }}
            style={[
              s.noteCard,
              {
                backgroundColor: isDark ? colors.surface : '#fff',
                borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
              },
              Platform.OS === 'web' && {
                boxShadow: hovered
                  ? `0 8px 28px ${shadowCol}, 0 2px 8px rgba(0,0,0,0.1)`
                  : `0 2px 8px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)`,
                transform: hovered ? [{ translateY: -3 }, { scale: 1.01 }] : [],
              },
              isDark && Platform.OS === 'web' && {
                boxShadow: hovered
                  ? `0 8px 28px ${shadowCol}, 0 0 16px ${shadowCol}`
                  : `0 2px 8px ${shadowCol}`,
              },
            ]}
            {...webHover}
          >
            {/* Color strip on left */}
            <View style={[s.noteColorStrip, { backgroundColor: note.color || '#FFF9C4' }]} />

            {/* Pin icon - golden with rotation */}
            {note.is_pinned ? (
              <View style={s.pinBadge}>
                <View style={[s.pinBadgeInner, {
                  ...(Platform.OS === 'web' ? {
                    filter: 'drop-shadow(0 1px 3px rgba(249,168,37,0.5))',
                  } : {}),
                }]}>
                  <IconPin size={15} color={isDark ? '#FFD54F' : '#F9A825'} />
                </View>
              </View>
            ) : null}

            <View style={s.noteCardContent}>
              {note.title ? (
                <HighlightText
                  text={note.title}
                  highlight={searchQuery}
                  style={[s.noteTitle, { color: textColor }]}
                  numberOfLines={2}
                />
              ) : null}
              {note.content ? (
                <View style={s.noteContentWrap}>
                  <HighlightText
                    text={note.content}
                    highlight={searchQuery}
                    style={[s.noteContent, { color: secondaryColor }]}
                    numberOfLines={isDesktop ? 4 : 3}
                  />
                  {/* Fade-out gradient at bottom (web only) */}
                  {Platform.OS === 'web' && note.content && note.content.length > 100 && (
                    <View style={[s.contentFadeOut, {
                      background: isDark
                        ? `linear-gradient(transparent, ${colors.surface})`
                        : `linear-gradient(transparent, #fff)`,
                    }]} />
                  )}
                </View>
              ) : null}
              {!note.title && !note.content && (
                <Text style={[s.noteContent, { color: secondaryColor, fontStyle: 'italic' }]}>
                  {t('notes.untitled')}
                </Text>
              )}
              {/* Tags pills */}
              {note.tags && note.tags.length > 0 && (
                <View style={s.tagRow}>
                  {note.tags.map((tag, i) => (
                    <View key={i} style={[s.tagPill, {
                      backgroundColor: (TAG_COLORS[i % TAG_COLORS.length]) + '18',
                    }]}>
                      <Text style={[s.tagPillText, { color: TAG_COLORS[i % TAG_COLORS.length] }]} numberOfLines={1}>#{tag}</Text>
                    </View>
                  ))}
                </View>
              )}
              <View style={s.noteFooter}>
                {note.notebook_name && (
                  <View style={[s.notebookTag, { backgroundColor: (note.notebook_color || '#4285F4') + '22' }]}>
                    <Text style={[s.notebookTagText, { color: note.notebook_color || '#4285F4' }]} numberOfLines={1}>
                      {note.notebook_name}
                    </Text>
                  </View>
                )}
                <View style={{ flex: 1 }} />
                {note.updated_at && (
                  <Text style={[s.noteDate, { color: secondaryColor }]}>
                    {new Date(note.updated_at).toLocaleDateString()}
                  </Text>
                )}
              </View>
            </View>
          </Pressable>
        </Animated.View>
      </DeletableNoteCard>
    );
  };

  // ---- Notebook Card (Realistic Book Cover) ----
  const NotebookCard = ({ notebook, index }) => {
    const isActive = selectedNotebook === notebook.id;
    const [hovered, setHovered] = useState(false);
    const webHover = Platform.OS === 'web' ? {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
    } : {};

    const nbColor = notebook.color || '#4285F4';
    const nbCount = notebook.note_count || 0;
    // Darken color for spine
    const darkenColor = (hex, amount) => {
      const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount);
      const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount);
      const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount);
      return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    };
    const spineColor = darkenColor(nbColor, 40);

    return (
      <AnimatedNoteCard index={index} style={{}}>
        <Pressable
          onPress={() => {
            router.push(`/notebook-editor?notebook_id=${notebook.id}&notebook_name=${encodeURIComponent(notebook.name)}&notebook_color=${encodeURIComponent(notebook.color || '#4285F4')}`);
          }}
          onLongPress={() => {
            setEditingNotebook(notebook);
            setNotebookName(notebook.name);
            setNotebookColor(notebook.color || '#4285F4');
            setNotebookModalVisible(true);
          }}
          style={[
            s.notebookCard,
            {
              backgroundColor: nbColor,
            },
            Platform.OS === 'web' && {
              transform: hovered
                ? [{ perspective: 800 }, { rotateY: '-5deg' }, { translateY: -6 }]
                : [{ perspective: 800 }, { rotateY: '-2deg' }],
              background: `linear-gradient(145deg, ${nbColor}, ${darkenColor(nbColor, 20)})`,
              boxShadow: hovered
                ? `8px 8px 24px rgba(0,0,0,0.25), -2px 0 0 ${spineColor}, -4px 0 0 ${darkenColor(nbColor, 60)}, inset 0 0 30px rgba(255,255,255,0.1)`
                : `4px 6px 16px rgba(0,0,0,0.15), -2px 0 0 ${spineColor}, -4px 0 0 ${darkenColor(nbColor, 60)}, inset 0 0 20px rgba(255,255,255,0.05)`,
              transition: 'transform 0.35s cubic-bezier(0.4,0,0.2,1), box-shadow 0.35s ease',
            },
            !Platform.OS !== 'web' && {
              ...Shadow.md,
            },
          ]}
          {...webHover}
        >
          {/* Book spine - realistic thick left border with texture */}
          <View style={[s.notebookSpine, { backgroundColor: spineColor }]}>
            {/* Spine lines for texture */}
            <View style={[s.spineLine, { top: '20%' }]} />
            <View style={[s.spineLine, { top: '80%' }]} />
          </View>

          {/* Page edges visible from side */}
          <View style={s.notebookPageEdges} />

          {/* Cover area - elegant with centered title */}
          <View style={s.notebookCoverArea}>
            {/* Decorative top band */}
            <View style={[s.notebookBand, { backgroundColor: 'rgba(255,255,255,0.15)' }]} />

            {/* Title - elegant serif font */}
            <Text style={[s.notebookCoverTitle, {
              color: '#fff',
              textShadowColor: 'rgba(0,0,0,0.3)',
              textShadowOffset: { width: 0, height: 1 },
              textShadowRadius: 3,
            }]} numberOfLines={2}>
              {notebook.name}
            </Text>

            {/* Page count in elegant circle */}
            <View style={[s.notebookPageCount, {
              borderColor: 'rgba(255,255,255,0.3)',
            }]}>
              <Text style={s.notebookPageCountText}>
                {nbCount}
              </Text>
              <Text style={s.notebookPageCountLabel}>
                {nbCount === 1 ? t('notes.noteCount1') : t('notes.noteCountN')}
              </Text>
            </View>

            {/* Decorative bottom band */}
            <View style={[s.notebookBand, { backgroundColor: 'rgba(255,255,255,0.1)' }]} />
          </View>

          {/* Action buttons row */}
          <View style={s.notebookActionsRow}>
            <TouchableOpacity
              onPress={(e) => {
                e.stopPropagation();
                setSelectedNotebook(isActive ? null : notebook.id);
                setActiveTab('all');
              }}
              style={s.notebookActionBtn}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <IconSearch size={14} color="rgba(255,255,255,0.7)" />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={(e) => {
                e.stopPropagation();
                setEditingNotebook(notebook);
                setNotebookName(notebook.name);
                setNotebookColor(notebook.color || '#4285F4');
                setNotebookModalVisible(true);
              }}
              style={s.notebookActionBtn}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <IconEdit size={14} color="rgba(255,255,255,0.7)" />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={(e) => {
                e.stopPropagation();
                deleteNotebook(notebook);
              }}
              style={s.notebookActionBtn}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <IconTrash size={14} color="rgba(255,255,255,0.7)" />
            </TouchableOpacity>
          </View>
        </Pressable>
      </AnimatedNoteCard>
    );
  };

  // Column count - single column list on mobile for clean card layout
  const numColumns = isDesktop ? (SCREEN_WIDTH > 1200 ? 4 : 3) : 1;
  const notebookColumns = isDesktop ? (SCREEN_WIDTH > 1200 ? 4 : 3) : 2;

  // ---- View mode icons ----
  const BoardIcon = () => (
    <View style={{ width: 20, height: 20, justifyContent: 'center', alignItems: 'center' }}>
      <View style={{ flexDirection: 'row', gap: 2 }}>
        <View style={{ width: 7, height: 7, backgroundColor: viewMode === 'board' ? '#fff' : colors.textSecondary, borderRadius: 1, transform: [{ rotate: '-3deg' }] }} />
        <View style={{ width: 7, height: 7, backgroundColor: viewMode === 'board' ? '#fff' : colors.textSecondary, borderRadius: 1, transform: [{ rotate: '2deg' }], marginTop: 3 }} />
      </View>
      <View style={{ flexDirection: 'row', gap: 2, marginTop: 1 }}>
        <View style={{ width: 7, height: 7, backgroundColor: viewMode === 'board' ? '#fff' : colors.textSecondary, borderRadius: 1, transform: [{ rotate: '1deg' }] }} />
        <View style={{ width: 7, height: 7, backgroundColor: viewMode === 'board' ? '#fff' : colors.textSecondary, borderRadius: 1, transform: [{ rotate: '-2deg' }], marginTop: -2 }} />
      </View>
    </View>
  );

  // ---- Filter chips data ----
  const filterChips = [
    { key: 'all', label: t('notes.allNotes') },
    { key: 'pinned', label: t('notes.pinned') },
    { key: 'recent', label: t('notes.recent') || 'Recentes' },
    ...notebooks.slice(0, 4).map(nb => ({
      key: `nb_${nb.id}`,
      label: nb.name,
      color: nb.color,
      notebookId: nb.id,
    })),
  ];

  // ---- Render ----
  return (
    <View style={[s.container, { backgroundColor: colors.background }]}>
      {/* ---- Header (Frosted Glass) ---- */}
      <View style={[s.header, {
        backgroundColor: isDark ? 'rgba(18,18,30,0.88)' : 'rgba(255,255,255,0.88)',
        borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        ...(Platform.OS === 'web' ? {
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
        } : {}),
      }]}>
        <TouchableOpacity onPress={() => {
          // If inside iframe (side panel), close by posting message to parent
          if (Platform.OS === 'web' && window.parent !== window) {
            try { window.parent.postMessage({ type: 'close-side-panel', route: '/notes' }, '*'); } catch {}
          } else {
            router.back();
          }
        }} style={s.headerBtn}>
          <IconArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>

        {showSearch ? (
          <Animated.View style={[s.searchBar, {
            backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)',
            ...(Platform.OS === 'web' ? {
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
            } : {}),
          }]}>
            <IconSearch size={18} color={colors.textTertiary} />
            <TextInput
              style={[s.searchInput, { color: colors.text }]}
              placeholder={t('notes.searchPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={searchQuery}
              onChangeText={handleSearch}
              onBlur={() => commitSearch(searchQuery)}
              autoFocus
            />
            {searchQuery.length > 0 && (
              <View style={[s.searchCount, { backgroundColor: colors.primary + '22' }]}>
                <Text style={[s.searchCountText, { color: colors.primary }]}>
                  {filteredNotes.length}
                </Text>
              </View>
            )}
            <TouchableOpacity onPress={() => { setShowSearch(false); setSearchQuery(''); handleSearch(''); }}
              style={s.searchCloseBtn}
            >
              <IconX size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          </Animated.View>
        ) : (
          <Text style={[s.headerTitle, { color: colors.text }]}>{t('notes.title')}</Text>
        )}

        <View style={s.headerActions}>
          {!showSearch && (
            <TouchableOpacity onPress={() => setShowSearch(true)} style={[s.headerBtn, s.headerSearchBtn, {
              backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
            }]}>
              <IconSearch size={20} color={colors.text} />
            </TouchableOpacity>
          )}

          {/* View mode toggle with sliding indicator */}
          {activeTab !== 'notebooks' && (
            <View style={[s.viewToggle, {
              backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
            }]}>
              {/* Sliding indicator */}
              <Animated.View style={[s.viewToggleIndicator, {
                backgroundColor: colors.primary,
                transform: [{
                  translateX: viewToggleAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [2, 30],
                  }),
                }],
              }]} />
              <TouchableOpacity
                onPress={() => setViewMode('board')}
                style={s.viewToggleBtn}
              >
                <BoardIcon />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setViewMode('list')}
                style={s.viewToggleBtn}
              >
                <IconMenu size={16} color={viewMode === 'list' ? '#fff' : colors.textSecondary} />
              </TouchableOpacity>
            </View>
          )}

          {/* Snap toggle (board mode only) */}
          {viewMode === 'board' && activeTab !== 'notebooks' && (
            <TouchableOpacity
              onPress={() => setSnapEnabled(!snapEnabled)}
              style={[s.headerBtn, snapEnabled && { backgroundColor: colors.primary + '22' }]}
            >
              <Text style={{ fontSize: 11, fontWeight: '700', color: snapEnabled ? colors.primary : colors.textSecondary }}>
                {t('notes.snapGrid')}
              </Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity onPress={() => openEditor()} style={[s.headerBtn, s.addBtn, {
            backgroundColor: colors.primary,
            ...(Platform.OS === 'web' ? {
              background: `linear-gradient(135deg, ${colors.primary}, ${colors.primary}cc)`,
              boxShadow: `0 3px 12px ${colors.primary}44`,
            } : {}),
          }]}>
            <IconPlus size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

      {/* ---- Tabs ---- */}
      <View style={[s.tabRow, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : colors.borderLight }]}>
        {[
          { key: 'all', label: t('notes.allNotes') },
          { key: 'notebooks', label: t('notes.notebooks') },
          { key: 'archived', label: t('notes.archived') },
        ].map(tab => (
          <TouchableOpacity
            key={tab.key}
            onPress={() => { setActiveTab(tab.key); setSelectedNotebook(null); setActiveFilter('all'); }}
            style={[s.tab, activeTab === tab.key && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
          >
            <Text style={[
              s.tabText,
              { color: activeTab === tab.key ? colors.primary : colors.textSecondary },
              activeTab === tab.key && s.tabTextActive,
            ]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ---- Filter Chips (horizontal scroll) ---- */}
      {activeTab === 'all' && viewMode === 'list' && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={s.filterChipsContainer}
          contentContainerStyle={s.filterChipsContent}
        >
          {filterChips.map(chip => {
            const isActive = chip.notebookId
              ? selectedNotebook === chip.notebookId
              : activeFilter === chip.key;
            return (
              <TouchableOpacity
                key={chip.key}
                onPress={() => {
                  if (chip.notebookId) {
                    setSelectedNotebook(isActive ? null : chip.notebookId);
                    setActiveFilter('all');
                  } else {
                    setActiveFilter(chip.key);
                    setSelectedNotebook(null);
                  }
                }}
                style={[
                  s.filterChip,
                  {
                    backgroundColor: isActive
                      ? (chip.color || colors.primary) + '22'
                      : isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                    borderColor: isActive
                      ? (chip.color || colors.primary) + '44'
                      : 'transparent',
                  },
                ]}
              >
                {chip.color && (
                  <View style={[s.filterChipDot, { backgroundColor: chip.color }]} />
                )}
                <Text style={[s.filterChipText, {
                  color: isActive ? (chip.color || colors.primary) : colors.textSecondary,
                  fontWeight: isActive ? '600' : '500',
                }]}>
                  {chip.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {/* ---- Selected Notebook Banner ---- */}
      {selectedNotebook && activeTab === 'all' && viewMode !== 'list' && (
        <View style={[s.selectedNbBanner, { backgroundColor: isDark ? colors.surfaceVariant : '#EEF2FF' }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={[s.selectedNbDot, { backgroundColor: notebooks.find(n => n.id === selectedNotebook)?.color || '#4285F4' }]} />
            <Text style={[s.selectedNbText, { color: colors.text }]}>
              {notebooks.find(n => n.id === selectedNotebook)?.name || ''}
            </Text>
          </View>
          <TouchableOpacity onPress={() => setSelectedNotebook(null)}>
            <IconX size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      {/* ---- Content ---- */}
      {loading && notes.length === 0 ? (
        <ListSkeleton count={6} />
      ) : activeTab === 'notebooks' ? (
        // ---- Notebooks Grid ----
        <ScrollView style={s.scrollContent} contentContainerStyle={s.notebooksContainer}>
          <TouchableOpacity
            onPress={() => {
              setEditingNotebook(null);
              setNotebookName('');
              setNotebookColor('#4285F4');
              setNotebookModalVisible(true);
            }}
            style={[s.createNotebookBtn, {
              borderColor: colors.primary + '44',
              ...(Platform.OS === 'web' ? {
                background: `linear-gradient(135deg, ${colors.primary}08, ${colors.primary}04)`,
              } : {}),
            }]}
          >
            <IconPlus size={20} color={colors.primary} />
            <Text style={[s.createNotebookText, { color: colors.primary }]}>{t('notes.createNotebook')}</Text>
          </TouchableOpacity>
          <View style={s.notebooksGrid}>
            {notebooks.map((nb, i) => (
              <View key={nb.id} style={[s.notebookGridItem, { width: `${100 / notebookColumns}%` }]}>
                <NotebookCard notebook={nb} index={i} />
              </View>
            ))}
          </View>
          {notebooks.length === 0 && (
            <View style={s.emptyNotebooks}>
              <IconFolder size={48} color={colors.textTertiary} />
              <Text style={[s.emptyText, { color: colors.textTertiary }]}>{t('notes.noNotebooksYet')}</Text>
            </View>
          )}
        </ScrollView>
      ) : filteredNotes.length === 0 && viewMode === 'list' ? (
        // ---- Enhanced Empty State with animated floating notes ----
        <Animated.View style={[s.emptyContainer, {
          opacity: emptyAnim,
          transform: [{
            scale: emptyAnim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }),
          }],
        }]}>
          {/* Decorative floating notes illustration */}
          <View style={s.emptyIllustration}>
            <Animated.View style={[s.floatingNote, s.floatingNote1, {
              backgroundColor: isDark ? '#3E3A1E' : '#FFF9C4',
              ...(Platform.OS === 'web' ? {
                background: isDark
                  ? 'linear-gradient(135deg, #3E3A1E, #4A4520)'
                  : 'linear-gradient(135deg, #FFF9C4, #FFF176)',
                boxShadow: isDark
                  ? '0 4px 16px rgba(249,168,37,0.15)'
                  : '0 4px 16px rgba(255,241,118,0.3)',
              } : {}),
              transform: [
                { rotate: '-8deg' },
                { translateY: floatAnim1.interpolate({ inputRange: [0, 1], outputRange: [0, -10] }) },
              ],
            }]}>
              <View style={[s.floatingNoteLine, { backgroundColor: isDark ? 'rgba(255,249,196,0.3)' : 'rgba(0,0,0,0.1)', width: '80%' }]} />
              <View style={[s.floatingNoteLine, { backgroundColor: isDark ? 'rgba(255,249,196,0.2)' : 'rgba(0,0,0,0.06)', width: '60%' }]} />
              <View style={[s.floatingNoteLine, { backgroundColor: isDark ? 'rgba(255,249,196,0.15)' : 'rgba(0,0,0,0.04)', width: '40%' }]} />
            </Animated.View>
            <Animated.View style={[s.floatingNote, s.floatingNote2, {
              backgroundColor: isDark ? '#1E2A3E' : '#BBDEFB',
              ...(Platform.OS === 'web' ? {
                background: isDark
                  ? 'linear-gradient(135deg, #1E2A3E, #25354A)'
                  : 'linear-gradient(135deg, #BBDEFB, #90CAF9)',
                boxShadow: isDark
                  ? '0 4px 16px rgba(25,118,210,0.15)'
                  : '0 4px 16px rgba(144,202,249,0.3)',
              } : {}),
              transform: [
                { rotate: '5deg' },
                { translateY: floatAnim2.interpolate({ inputRange: [0, 1], outputRange: [0, -12] }) },
              ],
            }]}>
              <View style={[s.floatingNoteLine, { backgroundColor: isDark ? 'rgba(187,222,251,0.3)' : 'rgba(0,0,0,0.1)', width: '70%' }]} />
              <View style={[s.floatingNoteLine, { backgroundColor: isDark ? 'rgba(187,222,251,0.2)' : 'rgba(0,0,0,0.06)', width: '50%' }]} />
            </Animated.View>
            <Animated.View style={[s.floatingNote, s.floatingNote3, {
              backgroundColor: isDark ? '#3E1E2A' : '#F8BBD0',
              ...(Platform.OS === 'web' ? {
                background: isDark
                  ? 'linear-gradient(135deg, #3E1E2A, #4A2535)'
                  : 'linear-gradient(135deg, #F8BBD0, #F48FB1)',
                boxShadow: isDark
                  ? '0 4px 16px rgba(233,30,99,0.15)'
                  : '0 4px 16px rgba(244,143,177,0.3)',
              } : {}),
              transform: [
                { rotate: '-3deg' },
                { translateY: floatAnim3.interpolate({ inputRange: [0, 1], outputRange: [0, -8] }) },
              ],
            }]}>
              <View style={[s.floatingNoteLine, { backgroundColor: isDark ? 'rgba(248,187,208,0.3)' : 'rgba(0,0,0,0.1)', width: '75%' }]} />
              <View style={[s.floatingNoteLine, { backgroundColor: isDark ? 'rgba(248,187,208,0.2)' : 'rgba(0,0,0,0.06)', width: '55%' }]} />
              <View style={[s.floatingNoteLine, { backgroundColor: isDark ? 'rgba(248,187,208,0.15)' : 'rgba(0,0,0,0.04)', width: '35%' }]} />
            </Animated.View>
            <View style={[s.emptyIconCircle, {
              backgroundColor: isDark ? 'rgba(249,168,37,0.15)' : 'rgba(249,168,37,0.12)',
              ...(Platform.OS === 'web' && isDark ? {
                boxShadow: '0 0 32px rgba(255,213,79,0.15)',
              } : {}),
            }]}>
              <IconStickyNote size={40} color={isDark ? '#FFD54F' : '#F9A825'} />
            </View>
          </View>
          <Text style={[s.emptyTitle, {
            color: colors.text,
            ...(Platform.OS === 'web' ? {
              backgroundImage: isDark
                ? 'linear-gradient(135deg, #FFD54F, #F9A825)'
                : 'linear-gradient(135deg, #F9A825, #FF8F00)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            } : {}),
          }]}>
            {t('notes.emptyTitle')}
          </Text>
          <Text style={[s.emptyDesc, { color: colors.textSecondary }]}>{t('notes.emptyDesc')}</Text>
          <TouchableOpacity
            onPress={() => openEditor()}
            style={[s.emptyBtn, {
              backgroundColor: colors.primary,
              ...(Platform.OS === 'web' ? {
                background: `linear-gradient(135deg, ${colors.primary}, ${colors.primary}cc)`,
                boxShadow: `0 6px 20px ${colors.primary}44`,
              } : {}),
            }]}
          >
            <IconPlus size={18} color="#fff" />
            <Text style={s.emptyBtnText}>{t('notes.newNote')}</Text>
          </TouchableOpacity>
        </Animated.View>
      ) : viewMode === 'board' ? (
        // ---- Board View (Draggable Sticky Notes) ----
        <BoardView
          notes={filteredNotes}
          isDark={isDark}
          colors={colors}
          t={t}
          onEdit={openEditor}
          onContextMenu={(note) => {
            setContextNote(note);
            setContextMenuVisible(true);
          }}
          onPositionChange={updateNotePosition}
          onResize={updateNoteSize}
          onCreateAtPosition={createNoteAtPosition}
          snapEnabled={snapEnabled}
        />
      ) : (
        // ---- Notes Grid (List View) ----
        <ScrollView
          style={s.scrollContent}
          contentContainerStyle={s.gridContainer}
          showsVerticalScrollIndicator={false}
        >
          {pinnedNotes.length > 0 && activeFilter !== 'pinned' && (
            <>
              <Text style={[s.sectionLabel, { color: colors.textTertiary }]}>{t('notes.pinned')}</Text>
              <View style={[s.grid, { columnGap: 10 }]}>
                {pinnedNotes.map((note, i) => (
                  <View key={note.id} style={[s.gridItem, { width: `${100 / numColumns}%` }]}>
                    <NoteCard note={note} index={i} />
                  </View>
                ))}
              </View>
            </>
          )}
          {pinnedNotes.length > 0 && unpinnedNotes.length > 0 && activeFilter !== 'pinned' && (
            <Text style={[s.sectionLabel, { color: colors.textTertiary, marginTop: 12 }]}>
              {activeTab === 'archived' ? t('notes.archived') : ''}
            </Text>
          )}
          <View style={[s.grid, { columnGap: 10 }]}>
            {(activeFilter === 'pinned' ? pinnedNotes : unpinnedNotes).map((note, i) => (
              <View key={note.id} style={[s.gridItem, { width: `${100 / numColumns}%` }]}>
                <NoteCard note={note} index={(activeFilter === 'pinned' ? 0 : pinnedNotes.length) + i} />
              </View>
            ))}
          </View>
        </ScrollView>
      )}

      {/* ---- Quick Note FAB ---- */}
      {!editorVisible && viewMode === 'list' && (
        <Animated.View style={[s.quickNoteFab, { transform: [{ scale: quickNoteAnim }] }]}>
          <TouchableOpacity
            onPress={handleQuickNote}
            disabled={quickNoteLoading}
            style={[s.quickNoteFabBtn, {
              backgroundColor: isDark ? 'rgba(30,30,50,0.9)' : 'rgba(255,255,255,0.95)',
              borderColor: colors.primary + '33',
              ...(Platform.OS === 'web' ? {
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                boxShadow: `0 4px 16px rgba(0,0,0,0.12), 0 0 1px ${colors.primary}44`,
              } : {}),
            }]}
            activeOpacity={0.8}
          >
            {quickNoteLoading ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <>
                <IconZap size={16} color={colors.primary} />
                <Text style={[s.quickNoteFabText, { color: colors.primary }]}>{t('notes.quickNote')}</Text>
              </>
            )}
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* ---- Main FAB ---- */}
      {!isDesktop && !editorVisible && viewMode === 'list' && (
        <TouchableOpacity
          onPress={() => openEditor()}
          style={[s.fab, {
            backgroundColor: colors.primary,
            ...(Platform.OS === 'web' ? {
              background: `linear-gradient(135deg, ${colors.primary}, ${colors.primary}cc)`,
              boxShadow: `0 6px 20px ${colors.primary}55`,
            } : {}),
          }]}
          activeOpacity={0.8}
        >
          <IconPlus size={28} color="#fff" />
        </TouchableOpacity>
      )}

      {viewMode === 'board' && !editorVisible && (
        <TouchableOpacity
          onPress={() => openEditor()}
          style={[s.fab, {
            backgroundColor: colors.primary,
            ...(Platform.OS === 'web' ? {
              background: `linear-gradient(135deg, ${colors.primary}, ${colors.primary}cc)`,
              boxShadow: `0 6px 20px ${colors.primary}55`,
            } : {}),
          }]}
          activeOpacity={0.8}
        >
          <IconPlus size={28} color="#fff" />
        </TouchableOpacity>
      )}

      {/* ---- Note Editor Modal ---- */}
      <Modal visible={editorVisible} animationType="slide" transparent={false} onRequestClose={closeEditor}>
        <NoteEditor
          note={editingNote}
          colors={colors}
          isDark={isDark}
          t={t}
          notebooks={notebooks}
          titleRef={editorTitleRef}
          contentRef={editorContentRef}
          colorRef={editorColorRef}
          pinnedRef={editorPinnedRef}
          stickyRef={editorStickyRef}
          notebookRef={editorNotebookRef}
          tagsRef={editorTagsRef}
          onClose={closeEditor}
          onAutoSave={triggerAutoSave}
          onDelete={editingNote ? () => { setEditorVisible(false); deleteNote(editingNote); } : null}
          onSendEmail={editingNote ? () => {
            setEmailModalNote(editingNote);
            setEmailAddress('');
            setEmailModalVisible(true);
          } : null}
          onExportPdf={editingNote ? () => exportNotePdf(editingNote) : null}
          onCopyText={() => copyNoteText({
            title: editorTitleRef.current,
            content: editorContentRef.current,
          })}
          allTags={[...new Set(notes.flatMap(n => n.tags || []))]}
        />
      </Modal>

      {/* ---- Context Menu (long press) - frosted glass ---- */}
      <Modal visible={contextMenuVisible} transparent animationType="fade" onRequestClose={() => setContextMenuVisible(false)}>
        <Pressable style={s.contextOverlay} onPress={() => setContextMenuVisible(false)}>
          <View style={[s.contextMenu, {
            backgroundColor: isDark ? 'rgba(30,30,48,0.92)' : 'rgba(255,255,255,0.95)',
            borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
            ...(Platform.OS === 'web' ? {
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              boxShadow: isDark
                ? '0 16px 48px rgba(0,0,0,0.5), 0 0 1px rgba(255,255,255,0.1)'
                : '0 16px 48px rgba(0,0,0,0.15), 0 0 1px rgba(0,0,0,0.08)',
            } : {}),
          }]}>
            {contextNote && (
              <>
                <TouchableOpacity
                  style={[s.contextItem, Platform.OS === 'web' && s.contextItemHoverable]}
                  onPress={() => { setContextMenuVisible(false); openEditor(contextNote); }}
                >
                  <IconEdit size={18} color={colors.text} />
                  <Text style={[s.contextText, { color: colors.text }]}>{t('notes.editNote')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.contextItem, Platform.OS === 'web' && s.contextItemHoverable]}
                  onPress={() => { setContextMenuVisible(false); togglePin(contextNote); }}
                >
                  <IconPin size={18} color={colors.text} />
                  <Text style={[s.contextText, { color: colors.text }]}>
                    {contextNote.is_pinned ? t('notes.unpin') : t('notes.pin')}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.contextItem, Platform.OS === 'web' && s.contextItemHoverable]}
                  onPress={() => { setContextMenuVisible(false); toggleArchive(contextNote); }}
                >
                  <IconArchive size={18} color={colors.text} />
                  <Text style={[s.contextText, { color: colors.text }]}>
                    {contextNote.is_archived ? t('notes.unarchive') : t('notes.archive')}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.contextItem, Platform.OS === 'web' && s.contextItemHoverable]}
                  onPress={() => {
                    setContextMenuVisible(false);
                    setColorPickerNote(contextNote);
                    setColorPickerVisible(true);
                  }}
                >
                  <View style={[s.colorDot, { backgroundColor: contextNote.color || '#FFF9C4' }]} />
                  <Text style={[s.contextText, { color: colors.text }]}>{t('notes.changeColor')}</Text>
                </TouchableOpacity>
                <View style={[s.contextDivider, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]} />
                <TouchableOpacity
                  style={[s.contextItem, Platform.OS === 'web' && s.contextItemHoverable]}
                  onPress={() => {
                    setContextMenuVisible(false);
                    setEmailModalNote(contextNote);
                    setEmailAddress('');
                    setEmailModalVisible(true);
                  }}
                >
                  <IconMail size={18} color={colors.text} />
                  <Text style={[s.contextText, { color: colors.text }]}>{t('notes.sendByEmail')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.contextItem, Platform.OS === 'web' && s.contextItemHoverable]}
                  onPress={() => { setContextMenuVisible(false); exportNotePdf(contextNote); }}
                >
                  <IconDownload size={18} color={colors.text} />
                  <Text style={[s.contextText, { color: colors.text }]}>{t('notes.exportPdf')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.contextItem, Platform.OS === 'web' && s.contextItemHoverable]}
                  onPress={() => { setContextMenuVisible(false); copyNoteText(contextNote); }}
                >
                  <IconCopy size={18} color={colors.text} />
                  <Text style={[s.contextText, { color: colors.text }]}>{t('notes.copyText')}</Text>
                </TouchableOpacity>
                <View style={[s.contextDivider, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]} />
                <TouchableOpacity
                  style={[s.contextItem, Platform.OS === 'web' && s.contextItemHoverable]}
                  onPress={() => { setContextMenuVisible(false); deleteNote(contextNote); }}
                >
                  <IconTrash size={18} color={colors.error} />
                  <Text style={[s.contextText, { color: colors.error }]}>{t('notes.deleteNote')}</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </Pressable>
      </Modal>

      {/* ---- Color Picker Modal ---- */}
      <Modal visible={colorPickerVisible} transparent animationType="fade" onRequestClose={() => setColorPickerVisible(false)}>
        <Pressable style={s.contextOverlay} onPress={() => setColorPickerVisible(false)}>
          <View style={[s.colorPickerSheet, {
            backgroundColor: isDark ? 'rgba(30,30,48,0.92)' : 'rgba(255,255,255,0.96)',
            ...(Platform.OS === 'web' ? {
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              boxShadow: isDark
                ? '0 20px 48px rgba(0,0,0,0.5)'
                : '0 20px 48px rgba(0,0,0,0.12)',
            } : {}),
          }]}>
            <Text style={[s.colorPickerTitle, { color: colors.text }]}>{t('notes.colorPicker')}</Text>
            <View style={s.colorPickerRow}>
              {NOTE_COLORS.map(c => {
                const isSelected = colorPickerNote?.color === c.id;
                return (
                  <TouchableOpacity
                    key={c.id}
                    onPress={() => colorPickerNote && changeColor(colorPickerNote, c.id)}
                    style={[
                      s.colorPickerCircle,
                      {
                        backgroundColor: isDark ? DARK_NOTE_COLORS[c.id] : c.id,
                        borderColor: isSelected ? c.dark : isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)',
                        borderWidth: isSelected ? 3 : 1,
                        ...(Platform.OS === 'web' ? {
                          background: isDark
                            ? `linear-gradient(135deg, ${c.darkGradient[0]}, ${c.darkGradient[1]})`
                            : `linear-gradient(135deg, ${c.gradient[0]}, ${c.gradient[1]})`,
                          boxShadow: isSelected ? `0 0 12px ${c.shadowColor}` : 'none',
                          transition: 'transform 0.2s ease, box-shadow 0.2s ease',
                          transform: isSelected ? 'scale(1.15)' : 'scale(1)',
                        } : {}),
                      },
                    ]}
                  >
                    {isSelected && <IconCheck size={16} color={c.dark} />}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* ---- Notebook Create/Edit Modal ---- */}
      <Modal visible={notebookModalVisible} transparent animationType="fade" onRequestClose={() => setNotebookModalVisible(false)}>
        <Pressable style={s.contextOverlay} onPress={() => setNotebookModalVisible(false)}>
          <Pressable style={[s.notebookModal, {
            backgroundColor: isDark ? 'rgba(30,30,48,0.95)' : 'rgba(255,255,255,0.98)',
            ...(Platform.OS === 'web' ? {
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              boxShadow: '0 24px 48px rgba(0,0,0,0.2)',
            } : {}),
          }]} onPress={e => e.stopPropagation()}>
            <Text style={[s.notebookModalTitle, { color: colors.text }]}>
              {editingNotebook ? t('notes.editNotebook') : t('notes.createNotebook')}
            </Text>
            <TextInput
              style={[s.notebookInput, {
                color: colors.text,
                backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f8fafc',
                borderColor: isDark ? 'rgba(255,255,255,0.1)' : colors.border,
              }]}
              placeholder={t('notes.notebookName')}
              placeholderTextColor={colors.textTertiary}
              value={notebookName}
              onChangeText={setNotebookName}
              autoFocus
            />
            <View style={s.notebookColorRow}>
              {['#4285F4','#EA4335','#FBBC04','#34A853','#FF6D01','#46BDC6','#7B1FA2','#E91E63'].map(c => (
                <TouchableOpacity
                  key={c}
                  onPress={() => setNotebookColor(c)}
                  style={[s.notebookColorCircle, {
                    backgroundColor: c,
                    borderWidth: notebookColor === c ? 3 : 0,
                    borderColor: '#fff',
                    ...(Platform.OS === 'web' ? {
                      boxShadow: notebookColor === c ? `0 0 12px ${c}88` : 'none',
                      transform: notebookColor === c ? 'scale(1.2)' : 'scale(1)',
                      transition: 'transform 0.2s ease, box-shadow 0.2s ease',
                    } : {}),
                  }]}
                />
              ))}
            </View>
            <View style={s.notebookModalActions}>
              <TouchableOpacity onPress={() => setNotebookModalVisible(false)} style={s.notebookCancelBtn}>
                <Text style={{ color: colors.textSecondary }}>{t('common.cancel') || 'Cancel'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={saveNotebook} style={[s.notebookSaveBtn, {
                backgroundColor: colors.primary,
                ...(Platform.OS === 'web' ? {
                  background: `linear-gradient(135deg, ${colors.primary}, ${colors.primary}cc)`,
                  boxShadow: `0 4px 12px ${colors.primary}44`,
                } : {}),
              }]}>
                <Text style={{ color: '#fff', fontWeight: '600' }}>{t('common.save') || 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ---- Send Email Modal ---- */}
      <Modal visible={emailModalVisible} transparent animationType="fade" onRequestClose={() => setEmailModalVisible(false)}>
        <Pressable style={s.contextOverlay} onPress={() => setEmailModalVisible(false)}>
          <Pressable style={[s.notebookModal, {
            backgroundColor: isDark ? 'rgba(30,30,48,0.95)' : 'rgba(255,255,255,0.98)',
            ...(Platform.OS === 'web' ? {
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              boxShadow: '0 24px 48px rgba(0,0,0,0.2)',
            } : {}),
          }]} onPress={e => e.stopPropagation()}>
            <Text style={[s.notebookModalTitle, { color: colors.text }]}>{t('notes.sendEmailTitle')}</Text>
            <TextInput
              style={[s.notebookInput, {
                color: colors.text,
                backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : '#f8fafc',
                borderColor: isDark ? 'rgba(255,255,255,0.1)' : colors.border,
              }]}
              placeholder={t('notes.emailPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              value={emailAddress}
              onChangeText={setEmailAddress}
              autoFocus
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={s.notebookModalActions}>
              <TouchableOpacity onPress={() => { setEmailModalVisible(false); setEmailAddress(''); }} style={s.notebookCancelBtn}>
                <Text style={{ color: colors.textSecondary }}>{t('common.cancel') || 'Cancel'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={sendNoteByEmail}
                disabled={emailSending || !emailAddress.trim()}
                style={[s.notebookSaveBtn, {
                  backgroundColor: emailSending || !emailAddress.trim() ? colors.textTertiary : colors.primary,
                  ...(Platform.OS === 'web' && !emailSending && emailAddress.trim() ? {
                    background: `linear-gradient(135deg, ${colors.primary}, ${colors.primary}cc)`,
                  } : {}),
                }]}
              >
                {emailSending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={{ color: '#fff', fontWeight: '600' }}>{t('notes.send')}</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// ---- Note Editor (Full Screen - Premium) ----
function NoteEditor({ note, colors, isDark, t, notebooks, titleRef, contentRef, colorRef, pinnedRef, stickyRef, notebookRef, tagsRef, onClose, onAutoSave, onDelete, onSendEmail, onExportPdf, onCopyText, allTags = [] }) {
  const [title, setTitle] = useState(titleRef.current);
  const [content, setContent] = useState(contentRef.current);
  const [selectedColor, setSelectedColor] = useState(colorRef.current);
  const [isPinned, setIsPinned] = useState(pinnedRef.current);
  const [isSticky, setIsSticky] = useState(stickyRef.current);
  const [selectedNotebookId, setSelectedNotebookId] = useState(notebookRef.current);
  const [showColorBar, setShowColorBar] = useState(false);
  const [showNotebookPicker, setShowNotebookPicker] = useState(false);
  const [tags, setTags] = useState(tagsRef?.current || []);
  const [tagInput, setTagInput] = useState('');
  const [showTagInput, setShowTagInput] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [tagSuggestions, setTagSuggestions] = useState([]);

  // Color transition animation
  const colorAnim = useRef(new Animated.Value(0)).current;
  // Color picker selection indicator animation
  const colorSelectAnim = useRef(new Animated.Value(0)).current;

  const colorMeta = getColorMeta(selectedColor);
  const bgColor = isDark ? (DARK_NOTE_COLORS[selectedColor] || '#2A2A2A') : (selectedColor || '#FFF9C4');
  const textColor = isDark ? (DARK_NOTE_TEXT[selectedColor] || '#E0E0E0') : '#212121';
  const secondaryText = isDark ? '#BDBDBD' : '#757575';

  const gradientBg = Platform.OS === 'web'
    ? (isDark
      ? `linear-gradient(135deg, ${colorMeta.darkGradient[0]}, ${colorMeta.darkGradient[1]})`
      : `linear-gradient(135deg, ${colorMeta.gradient[0]}, ${colorMeta.gradient[1]})`)
    : undefined;

  const charCount = (content || '').length;

  const updateAndSave = useCallback((field, value) => {
    if (field === 'title') { titleRef.current = value; setTitle(value); }
    else if (field === 'content') { contentRef.current = value; setContent(value); }
    else if (field === 'color') {
      colorRef.current = value;
      setSelectedColor(value);
      // Animate color transition
      colorAnim.setValue(0);
      Animated.timing(colorAnim, { toValue: 1, duration: 300, useNativeDriver: false }).start();
    }
    else if (field === 'pinned') { pinnedRef.current = value; setIsPinned(value); }
    else if (field === 'sticky') { stickyRef.current = value; setIsSticky(value); }
    else if (field === 'notebook') { notebookRef.current = value; setSelectedNotebookId(value); }
    else if (field === 'tags') { if (tagsRef) tagsRef.current = value; setTags(value); }
    onAutoSave();
  }, [onAutoSave]);

  const addTag = useCallback(() => {
    const tag = tagInput.trim().replace(/^#/, '');
    if (tag && !tags.includes(tag)) {
      const newTags = [...tags, tag];
      updateAndSave('tags', newTags);
    }
    setTagInput('');
    setShowTagInput(false);
    setTagSuggestions([]);
  }, [tagInput, tags, updateAndSave]);

  const removeTag = useCallback((tagToRemove) => {
    const newTags = tags.filter(t => t !== tagToRemove);
    updateAndSave('tags', newTags);
  }, [tags, updateAndSave]);

  // Tag autocomplete
  const handleTagInput = useCallback((text) => {
    setTagInput(text);
    const q = text.trim().replace(/^#/, '').toLowerCase();
    if (q.length > 0) {
      const suggestions = allTags
        .filter(t => t.toLowerCase().includes(q) && !tags.includes(t))
        .slice(0, 5);
      setTagSuggestions(suggestions);
    } else {
      setTagSuggestions([]);
    }
  }, [allTags, tags]);

  // Process content for checklist
  const processContentForChecklist = useCallback((text) => {
    // Replace [] with unchecked, [x] with checked
    return text;
  }, []);

  // Handle content input with checklist detection
  const handleContentChange = useCallback((text) => {
    updateAndSave('content', text);
  }, [updateAndSave]);

  // Render markdown preview
  const renderPreview = useCallback(() => {
    if (!content) return null;
    const lines = content.split('\n');
    return lines.map((line, i) => {
      // Checklist items
      if (line.match(/^\s*\[\s*\]\s*/)) {
        const text = line.replace(/^\s*\[\s*\]\s*/, '');
        return (
          <TouchableOpacity key={i} style={editorStyles.checkItem} onPress={() => {
            const newContent = content.split('\n');
            newContent[i] = line.replace(/\[\s*\]/, '[x]');
            updateAndSave('content', newContent.join('\n'));
          }}>
            <View style={[editorStyles.checkbox, { borderColor: secondaryText + '66' }]} />
            <Text style={[editorStyles.checkText, { color: textColor }]}>{text}</Text>
          </TouchableOpacity>
        );
      }
      if (line.match(/^\s*\[x\]\s*/i)) {
        const text = line.replace(/^\s*\[x\]\s*/i, '');
        return (
          <TouchableOpacity key={i} style={editorStyles.checkItem} onPress={() => {
            const newContent = content.split('\n');
            newContent[i] = line.replace(/\[x\]/i, '[]');
            updateAndSave('content', newContent.join('\n'));
          }}>
            <View style={[editorStyles.checkbox, editorStyles.checkboxChecked, { backgroundColor: colors.primary, borderColor: colors.primary }]}>
              <IconCheck size={10} color="#fff" />
            </View>
            <Text style={[editorStyles.checkText, editorStyles.checkTextDone, { color: secondaryText }]}>{text}</Text>
          </TouchableOpacity>
        );
      }
      // Bold
      let formatted = line;
      const isBold = /\*\*(.+?)\*\*/.test(formatted);
      const isItalic = /\*(.+?)\*/.test(formatted) && !isBold;
      return (
        <Text key={i} style={[editorStyles.previewLine, {
          color: textColor,
          fontWeight: isBold ? '700' : '400',
          fontStyle: isItalic ? 'italic' : 'normal',
        }]}>
          {formatted.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1')}
        </Text>
      );
    });
  }, [content, textColor, secondaryText, colors.primary, updateAndSave]);

  const selectedNotebook = notebooks.find(n => n.id === selectedNotebookId);

  return (
    <KeyboardAvoidingView
      style={[s.editorContainer, {
        backgroundColor: bgColor,
        ...(Platform.OS === 'web' ? { background: gradientBg } : {}),
      }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Editor Header */}
      <View style={[s.editorHeader, {
        borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
        ...(Platform.OS === 'web' ? {
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        } : {}),
      }]}>
        <TouchableOpacity onPress={onClose} style={s.editorHeaderBtn}>
          <IconArrowLeft size={24} color={textColor} />
        </TouchableOpacity>
        <View style={s.editorHeaderActions}>
          {/* Preview toggle */}
          <TouchableOpacity
            onPress={() => setShowPreview(!showPreview)}
            style={[s.editorHeaderBtn, showPreview && {
              backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)',
            }]}
          >
            <Text style={{ fontSize: 12, fontWeight: '600', color: showPreview ? textColor : secondaryText }}>
              {showPreview ? t('common.edit') : t('common.preview')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => updateAndSave('pinned', !isPinned)}
            style={[s.editorHeaderBtn, isPinned && { backgroundColor: isDark ? 'rgba(255,213,79,0.2)' : 'rgba(249,168,37,0.15)' }]}
          >
            <IconPin size={20} color={isPinned ? (isDark ? '#FFD54F' : '#F9A825') : secondaryText} />
          </TouchableOpacity>
          {onCopyText && (
            <TouchableOpacity onPress={onCopyText} style={s.editorHeaderBtn}>
              <IconCopy size={20} color={secondaryText} />
            </TouchableOpacity>
          )}
          {onSendEmail && (
            <TouchableOpacity onPress={onSendEmail} style={s.editorHeaderBtn}>
              <IconMail size={20} color={secondaryText} />
            </TouchableOpacity>
          )}
          {onExportPdf && (
            <TouchableOpacity onPress={onExportPdf} style={s.editorHeaderBtn}>
              <IconDownload size={20} color={secondaryText} />
            </TouchableOpacity>
          )}
          {onDelete && (
            <TouchableOpacity onPress={onDelete} style={s.editorHeaderBtn}>
              <IconTrash size={20} color={secondaryText} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Notebook tag */}
      <TouchableOpacity
        onPress={() => setShowNotebookPicker(!showNotebookPicker)}
        style={[s.editorNotebookTag, { borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)' }]}
      >
        <IconFolder size={14} color={selectedNotebook?.color || secondaryText} />
        <Text style={[s.editorNotebookText, { color: selectedNotebook ? (selectedNotebook.color || textColor) : secondaryText }]}>
          {selectedNotebook?.name || t('notes.noNotebook')}
        </Text>
      </TouchableOpacity>

      {/* Notebook picker dropdown */}
      {showNotebookPicker && (
        <View style={[s.notebookDropdown, {
          backgroundColor: isDark ? 'rgba(40,40,60,0.95)' : 'rgba(255,255,255,0.98)',
          borderColor: isDark ? 'rgba(255,255,255,0.1)' : colors.border,
          ...(Platform.OS === 'web' ? {
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
          } : {}),
        }]}>
          <TouchableOpacity
            onPress={() => { updateAndSave('notebook', null); setShowNotebookPicker(false); }}
            style={s.notebookDropdownItem}
          >
            <Text style={[s.notebookDropdownText, { color: secondaryText }]}>{t('notes.noNotebook')}</Text>
          </TouchableOpacity>
          {notebooks.map(nb => (
            <TouchableOpacity
              key={nb.id}
              onPress={() => { updateAndSave('notebook', nb.id); setShowNotebookPicker(false); }}
              style={s.notebookDropdownItem}
            >
              <View style={[s.notebookDropdownDot, { backgroundColor: nb.color || '#4285F4' }]} />
              <Text style={[s.notebookDropdownText, { color: textColor }]}>{nb.name}</Text>
              {selectedNotebookId === nb.id && <IconCheck size={16} color={nb.color || '#4285F4'} />}
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Tags row - pill-style with "+" button */}
      <View style={s.editorTagsRow}>
        {tags.map((tag, i) => (
          <TouchableOpacity key={tag} onPress={() => removeTag(tag)} style={[s.editorTagPill, {
            backgroundColor: (TAG_COLORS[i % TAG_COLORS.length]) + '18',
            ...(Platform.OS === 'web' ? {
              transition: 'transform 0.15s ease',
            } : {}),
          }]}>
            <Text style={[s.editorTagText, { color: TAG_COLORS[i % TAG_COLORS.length] }]}>#{tag}</Text>
            <IconX size={12} color={TAG_COLORS[i % TAG_COLORS.length]} />
          </TouchableOpacity>
        ))}
        {showTagInput ? (
          <View style={{ flexDirection: 'column' }}>
            <View style={[s.tagInputWrap, { borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)' }]}>
              <TextInput
                style={[s.tagInputField, { color: textColor }]}
                placeholder={t('notes.tagPlaceholder')}
                placeholderTextColor={secondaryText + '88'}
                value={tagInput}
                onChangeText={handleTagInput}
                onSubmitEditing={addTag}
                onBlur={() => { addTag(); setTagSuggestions([]); }}
                autoFocus
                autoCapitalize="none"
              />
            </View>
            {/* Tag autocomplete suggestions */}
            {tagSuggestions.length > 0 && (
              <View style={[s.tagSuggestions, {
                backgroundColor: isDark ? 'rgba(40,40,60,0.95)' : 'rgba(255,255,255,0.98)',
                borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
              }]}>
                {tagSuggestions.map(sug => (
                  <TouchableOpacity key={sug} onPress={() => {
                    setTagInput(sug);
                    setTimeout(() => addTag(), 50);
                  }} style={s.tagSuggestionItem}>
                    <Text style={[s.tagSuggestionText, { color: textColor }]}>#{sug}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        ) : (
          <TouchableOpacity onPress={() => setShowTagInput(true)} style={[s.addTagBtn, {
            borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)',
            ...(Platform.OS === 'web' ? {
              transition: 'background-color 0.15s ease',
            } : {}),
          }]}>
            <IconPlus size={12} color={secondaryText} />
            <Text style={[s.addTagText, { color: secondaryText }]}>{t('notes.addTag')}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Title & Content */}
      <ScrollView style={s.editorBody} keyboardShouldPersistTaps="handled">
        <TextInput
          style={[s.editorTitle, { color: textColor }]}
          placeholder={t('notes.untitled')}
          placeholderTextColor={secondaryText + '88'}
          value={title}
          onChangeText={(v) => updateAndSave('title', v)}
          multiline
          scrollEnabled={false}
        />
        {showPreview ? (
          <View style={editorStyles.previewContainer}>
            {renderPreview()}
          </View>
        ) : (
          <TextInput
            style={[s.editorContent, { color: textColor }]}
            placeholder={t('notes.contentPlaceholder') || '...'}
            placeholderTextColor={secondaryText + '66'}
            value={content}
            onChangeText={handleContentChange}
            multiline
            scrollEnabled={false}
            textAlignVertical="top"
          />
        )}
      </ScrollView>

      {/* Bottom bar: color picker + sticky toggle + char count */}
      <View style={[s.editorBottomBar, {
        backgroundColor: isDark ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.03)',
        borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
        ...(Platform.OS === 'web' ? {
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        } : {}),
      }]}>
        {showColorBar ? (
          <View style={s.colorBarRow}>
            {NOTE_COLORS.map(c => {
              const isSel = selectedColor === c.id;
              return (
                <TouchableOpacity
                  key={c.id}
                  onPress={() => { updateAndSave('color', c.id); setShowColorBar(false); }}
                  style={[
                    s.colorBarCircle,
                    {
                      backgroundColor: isDark ? DARK_NOTE_COLORS[c.id] : c.id,
                      borderColor: isSel ? c.dark : isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)',
                      borderWidth: isSel ? 2.5 : 1,
                      ...(Platform.OS === 'web' ? {
                        background: isDark
                          ? `linear-gradient(135deg, ${c.darkGradient[0]}, ${c.darkGradient[1]})`
                          : `linear-gradient(135deg, ${c.gradient[0]}, ${c.gradient[1]})`,
                        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
                        transform: isSel ? 'scale(1.2)' : 'scale(1)',
                        boxShadow: isSel ? `0 0 10px ${c.shadowColor}` : 'none',
                      } : {}),
                    },
                  ]}
                />
              );
            })}
          </View>
        ) : (
          <View style={s.bottomBarContent}>
            <TouchableOpacity onPress={() => setShowColorBar(true)} style={s.bottomBarBtn}>
              <View style={[s.colorPreview, {
                backgroundColor: isDark ? DARK_NOTE_COLORS[selectedColor] : selectedColor,
                borderColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)',
                ...(Platform.OS === 'web' ? {
                  background: gradientBg,
                } : {}),
              }]} />
              <Text style={[s.bottomBarBtnText, { color: textColor }]}>{t('notes.colorPicker')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => updateAndSave('sticky', !isSticky)}
              style={[s.bottomBarBtn, isSticky && { backgroundColor: isDark ? 'rgba(255,213,79,0.15)' : 'rgba(249,168,37,0.1)', borderRadius: 8 }]}
            >
              <IconStickyNote size={18} color={isSticky ? (isDark ? '#FFD54F' : '#F9A825') : secondaryText} />
              <Text style={[s.bottomBarBtnText, { color: isSticky ? (isDark ? '#FFD54F' : '#F9A825') : secondaryText }]}>
                {t('notes.sticky')}
              </Text>
            </TouchableOpacity>
            {/* Character count */}
            <Text style={[s.charCount, { color: secondaryText + '88' }]}>
              {charCount}
            </Text>
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

// ---- Editor-specific styles ----
const editorStyles = StyleSheet.create({
  previewContainer: {
    paddingTop: 8,
    paddingBottom: 24,
    minHeight: 200,
  },
  previewLine: {
    fontSize: 16,
    lineHeight: 26,
    marginBottom: 2,
  },
  checkItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxChecked: {
    borderWidth: 0,
  },
  checkText: {
    fontSize: 16,
    flex: 1,
  },
  checkTextDone: {
    textDecorationLine: 'line-through',
    opacity: 0.6,
  },
});

// ---- Board Styles ----
const boardStyles = StyleSheet.create({
  canvas: {
    position: 'relative',
  },
  gridPattern: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
  },
  stickyNote: {
    position: 'absolute',
    borderRadius: 6,
    padding: 0,
    overflow: 'visible',
    ...(Platform.OS === 'web' ? {
      cursor: 'grab',
      userSelect: 'none',
    } : {}),
  },
  thumbtack: {
    position: 'absolute',
    top: -8,
    left: '50%',
    marginLeft: -6,
    alignItems: 'center',
    zIndex: 10,
  },
  thumbtackHead: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
    ...Shadow.sm,
  },
  thumbtackPin: {
    width: 2,
    height: 6,
    marginTop: -1,
    borderRadius: 1,
  },
  foldedCorner: {
    position: 'absolute',
    top: 0,
    right: 0,
    zIndex: 5,
    borderBottomWidth: 0,
    borderRightWidth: 0,
    ...(Platform.OS === 'web' ? {
      background: 'linear-gradient(135deg, transparent 50%, rgba(0,0,0,0.06) 50%)',
    } : {
      backgroundColor: 'transparent',
      borderStyle: 'solid',
      borderBottomWidth: 18,
      borderRightWidth: 18,
    }),
  },
  stickyContent: {
    flex: 1,
    padding: 14,
    paddingTop: 12,
  },
  stickyTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 4,
    ...(Platform.OS === 'web' ? { fontFamily: '"Segoe UI", system-ui, sans-serif' } : {}),
  },
  stickyBody: {
    fontSize: 12,
    lineHeight: 17,
    ...(Platform.OS === 'web' ? { fontFamily: '"Segoe UI", system-ui, sans-serif' } : {}),
  },
  stickyTags: {
    position: 'absolute',
    bottom: 28,
    left: 10,
    right: 10,
    flexDirection: 'row',
    gap: 4,
    flexWrap: 'wrap',
  },
  stickyTagPill: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  stickyTagText: {
    fontSize: 9,
    fontWeight: '600',
  },
  stickyNotebook: {
    position: 'absolute',
    bottom: 8,
    left: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  stickyNotebookText: {
    fontSize: 10,
    fontWeight: '600',
  },
  resizeHandle: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 24,
    height: 24,
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
    ...(Platform.OS === 'web' ? { cursor: 'nwse-resize' } : {}),
  },
  resizeDots: {
    width: 10,
    height: 10,
    borderBottomWidth: 2,
    borderRightWidth: 2,
    borderBottomRightRadius: 2,
    marginBottom: 3,
    marginRight: 3,
    opacity: 0.5,
  },
  // Minimap
  minimap: {
    position: 'absolute',
    bottom: 100,
    left: 16,
    width: 120,
    height: 90,
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
    } : Shadow.md),
  },
  zoomControls: {
    position: 'absolute',
    bottom: 100,
    right: 16,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
    } : Shadow.md),
  },
  zoomBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomText: {
    fontSize: 20,
    fontWeight: '600',
  },
  zoomPercent: {
    fontSize: 11,
    fontWeight: '500',
  },
  boardHint: {
    position: 'absolute',
    top: '40%',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  boardHintText: {
    fontSize: 15,
    fontWeight: '500',
    textAlign: 'center',
    opacity: 0.6,
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: { cursor: 'pointer' },
      default: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 12, elevation: 8 },
    }),
  },
  fabText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '300',
    marginTop: -2,
  },
});

// ---- List View Styles ----
const s = StyleSheet.create({
  container: { flex: 1 },

  // Header - frosted glass
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
    paddingTop: Platform.OS === 'ios' ? 54 : Platform.OS === 'web' ? 16 : 12,
    paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth,
    zIndex: 10,
  },
  headerBtn: { padding: 8, borderRadius: 12 },
  headerSearchBtn: { borderRadius: 10 },
  headerTitle: {
    flex: 1, fontSize: 22, fontWeight: '800', marginLeft: 8,
    letterSpacing: -0.3,
    ...(Platform.OS === 'web' ? { fontFamily: '"Segoe UI", system-ui, sans-serif' } : {}),
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  addBtn: { borderRadius: 12, padding: 8 },

  // View toggle with sliding indicator
  viewToggle: {
    flexDirection: 'row', borderRadius: 10, padding: 2, gap: 0,
    position: 'relative',
  },
  viewToggleIndicator: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: 8,
    top: 2,
    left: 0,
    zIndex: 0,
  },
  viewToggleBtn: {
    padding: 6, borderRadius: 8, zIndex: 1, width: 28, alignItems: 'center',
  },

  // Search
  searchBar: {
    flex: 1, flexDirection: 'row', alignItems: 'center', marginHorizontal: 8,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14,
  },
  searchInput: {
    flex: 1, marginLeft: 8, fontSize: 15,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  searchCount: {
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, marginRight: 6,
  },
  searchCountText: { fontSize: 11, fontWeight: '700' },
  searchCloseBtn: {
    padding: 4, borderRadius: 8,
  },

  // Tabs
  tabRow: {
    flexDirection: 'row', paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: { paddingVertical: 12, paddingHorizontal: 16, marginRight: 4 },
  tabText: { fontSize: 14, fontWeight: '500' },
  tabTextActive: { fontWeight: '700' },

  // Filter chips
  filterChipsContainer: {
    maxHeight: 44,
    ...(Platform.OS === 'web' ? {} : {}),
  },
  filterChipsContent: {
    paddingHorizontal: 16, paddingVertical: 8, gap: 8,
    flexDirection: 'row', alignItems: 'center',
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  filterChipDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '500',
  },

  // Selected notebook banner
  selectedNbBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 8,
  },
  selectedNbDot: { width: 8, height: 8, borderRadius: 4 },
  selectedNbText: { fontSize: 14, fontWeight: '600' },

  // Grid
  scrollContent: { flex: 1 },
  gridContainer: { padding: 10, paddingBottom: 100 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  gridItem: { padding: 5 },
  sectionLabel: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: 5, paddingVertical: 8 },

  // Note Card - clean card with color strip (Google Keep style)
  noteCard: {
    borderRadius: 16, padding: 0, borderWidth: 1,
    minHeight: isDesktop ? 110 : 80, marginBottom: 2,
    position: 'relative',
    overflow: 'hidden',
    flexDirection: 'row',
    ...Platform.select({
      web: {
        transition: 'transform 0.25s cubic-bezier(0.4,0,0.2,1), box-shadow 0.25s ease',
        cursor: 'pointer',
      },
      default: {},
    }),
    ...Shadow.sm,
  },
  noteColorStrip: {
    width: 5,
    borderTopLeftRadius: 16,
    borderBottomLeftRadius: 16,
  },
  noteCardContent: {
    flex: 1,
    padding: 14,
    paddingLeft: 12,
  },
  pinBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    zIndex: 1,
  },
  pinBadgeInner: {
    transform: [{ rotate: '20deg' }],
  },
  noteTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
    paddingRight: 24,
    letterSpacing: -0.2,
    ...(Platform.OS === 'web' ? { fontFamily: '"Segoe UI", system-ui, sans-serif' } : {}),
  },
  noteContentWrap: {
    position: 'relative',
    overflow: 'hidden',
  },
  noteContent: {
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '400',
  },
  contentFadeOut: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 24,
  },
  noteFooter: { marginTop: 8, flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  noteDate: {
    fontSize: 11,
    fontWeight: '400',
    textAlign: 'right',
  },
  notebookTag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  notebookTagText: { fontSize: 11, fontWeight: '600' },

  // Swipe to delete background
  swipeDeleteBg: {
    position: 'absolute',
    top: 0, right: 0, bottom: 2,
    width: '100%',
    borderRadius: 16,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  swipeDeleteInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    height: '100%',
    borderRadius: 16,
    justifyContent: 'flex-end',
    width: '100%',
  },
  swipeDeleteText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
  },

  // Tag pills
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 8 },
  tagPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  tagPillText: { fontSize: 11, fontWeight: '600' },

  // Empty state
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyIllustration: {
    width: 200, height: 180, marginBottom: 28, position: 'relative',
    alignItems: 'center', justifyContent: 'center',
  },
  emptyIconCircle: {
    width: 80, height: 80, borderRadius: 40,
    justifyContent: 'center', alignItems: 'center',
    zIndex: 5,
  },
  floatingNote: {
    position: 'absolute',
    borderRadius: 8,
    padding: 10,
    gap: 4,
    ...Platform.select({
      web: {},
      default: Shadow.sm,
    }),
  },
  floatingNote1: {
    width: 75, height: 65,
    top: 8, left: 8,
  },
  floatingNote2: {
    width: 68, height: 52,
    top: 12, right: 12,
  },
  floatingNote3: {
    width: 62, height: 58,
    bottom: 12, left: 28,
  },
  floatingNoteLine: {
    height: 4,
    borderRadius: 2,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 8,
    letterSpacing: -0.3,
    textAlign: 'center',
  },
  emptyDesc: { fontSize: 15, textAlign: 'center', marginBottom: 28, lineHeight: 22 },
  emptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 16,
    gap: 8,
  },
  emptyBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },

  // Quick Note FAB
  quickNoteFab: {
    position: 'absolute',
    bottom: 90,
    right: 24,
    zIndex: 10,
  },
  quickNoteFabBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    ...Platform.select({
      web: { cursor: 'pointer' },
      default: Shadow.md,
    }),
  },
  quickNoteFabText: { fontSize: 13, fontWeight: '600' },

  // FAB
  fab: {
    position: 'absolute', bottom: 24, right: 24,
    width: 56, height: 56, borderRadius: 16,
    justifyContent: 'center', alignItems: 'center',
    ...Shadow.md,
  },

  // Context Menu - frosted glass
  contextOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', alignItems: 'center',
  },
  contextMenu: {
    width: 240, borderRadius: 18, padding: 8, borderWidth: 1,
    ...Shadow.lg,
  },
  contextItem: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 12, borderRadius: 12,
  },
  contextItemHoverable: {
    ...(Platform.OS === 'web' ? {
      transition: 'background-color 0.15s ease',
    } : {}),
  },
  contextText: { fontSize: 15, fontWeight: '500' },
  contextDivider: { height: 1, marginVertical: 4, marginHorizontal: 8 },
  colorDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 1, borderColor: 'rgba(0,0,0,0.1)' },

  // Color picker modal
  colorPickerSheet: { width: 320, borderRadius: 24, padding: 24, ...Shadow.lg },
  colorPickerTitle: { fontSize: 17, fontWeight: '700', marginBottom: 20, textAlign: 'center' },
  colorPickerRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 14 },
  colorPickerCircle: {
    width: 48, height: 48, borderRadius: 24, justifyContent: 'center', alignItems: 'center',
  },

  // Notebooks
  notebooksContainer: { padding: 16, gap: 10 },
  notebooksGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12 },
  notebookGridItem: { padding: 6 },
  createNotebookBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14, borderRadius: 14, borderWidth: 1.5, borderStyle: 'dashed', gap: 8,
  },
  createNotebookText: { fontSize: 15, fontWeight: '600' },
  notebookCard: {
    borderRadius: 8, borderWidth: 0, overflow: 'hidden',
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
      default: {},
    }),
    ...Shadow.md,
  },
  // Book spine - realistic
  notebookSpine: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 10,
    borderTopLeftRadius: 8,
    borderBottomLeftRadius: 8,
    zIndex: 2,
  },
  spineLine: {
    position: 'absolute',
    left: 2,
    right: 2,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  notebookPageEdges: {
    position: 'absolute',
    right: 0,
    top: 3,
    bottom: 3,
    width: 4,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderTopRightRadius: 2,
    borderBottomRightRadius: 2,
    zIndex: 1,
    ...(Platform.OS === 'web' ? {
      background: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.08), rgba(255,255,255,0.08) 1px, rgba(255,255,255,0.2) 1px, rgba(255,255,255,0.2) 2px)',
    } : {}),
  },
  notebookCoverArea: {
    paddingTop: 16, paddingBottom: 8, paddingHorizontal: 20, paddingLeft: 24,
    alignItems: 'center', justifyContent: 'center',
    minHeight: 140,
    gap: 8,
  },
  notebookBand: {
    height: 2,
    width: '80%',
    borderRadius: 1,
  },
  notebookCoverTitle: {
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: 0.5,
    lineHeight: 22,
    ...(Platform.OS === 'web' ? {
      fontFamily: 'Georgia, "Times New Roman", serif',
    } : {}),
  },
  notebookPageCount: {
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
    alignItems: 'center',
    marginTop: 4,
  },
  notebookPageCountText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  notebookPageCountLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 9,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  notebookActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
  notebookActionBtn: {
    padding: 6, borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  emptyNotebooks: { alignItems: 'center', justifyContent: 'center', paddingTop: 60, gap: 12 },
  emptyText: { fontSize: 15, fontWeight: '500' },

  // Notebook modal
  notebookModal: { width: 340, borderRadius: 24, padding: 28, ...Shadow.lg },
  notebookModalTitle: { fontSize: 19, fontWeight: '700', marginBottom: 18, letterSpacing: -0.2 },
  notebookInput: {
    borderWidth: 1, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, fontSize: 15, marginBottom: 16,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  notebookColorRow: { flexDirection: 'row', gap: 12, marginBottom: 22, flexWrap: 'wrap' },
  notebookColorCircle: { width: 34, height: 34, borderRadius: 17 },
  notebookModalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  notebookCancelBtn: { paddingVertical: 10, paddingHorizontal: 16 },
  notebookSaveBtn: { paddingVertical: 10, paddingHorizontal: 22, borderRadius: 12 },

  // ---- Editor ----
  editorContainer: { flex: 1 },
  editorHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingTop: Platform.OS === 'ios' ? 54 : Platform.OS === 'web' ? 16 : 12,
    paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  editorHeaderBtn: { padding: 10, borderRadius: 12 },
  editorHeaderActions: { flexDirection: 'row', gap: 4 },

  editorNotebookTag: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    marginLeft: 20, marginTop: 12, paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 10, borderWidth: 1, gap: 6,
  },
  editorNotebookText: { fontSize: 13, fontWeight: '500' },

  // Tags in editor
  editorTagsRow: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 8, gap: 6,
  },
  editorTagPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10,
  },
  editorTagText: { fontSize: 12, fontWeight: '600' },
  tagInputWrap: {
    borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4,
  },
  tagInputField: {
    fontSize: 12, minWidth: 70, padding: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  addTagBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, borderWidth: 1, borderStyle: 'dashed',
  },
  addTagText: { fontSize: 11, fontWeight: '500' },
  tagSuggestions: {
    position: 'absolute',
    top: 32,
    left: 0,
    minWidth: 120,
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
    zIndex: 100,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
    } : Shadow.md),
  },
  tagSuggestionItem: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  tagSuggestionText: {
    fontSize: 12,
    fontWeight: '500',
  },

  notebookDropdown: {
    marginHorizontal: 20, borderRadius: 14, borderWidth: 1, overflow: 'hidden',
    ...Shadow.md,
  },
  notebookDropdownItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 14, gap: 10 },
  notebookDropdownDot: { width: 12, height: 12, borderRadius: 6 },
  notebookDropdownText: { fontSize: 14, flex: 1 },

  editorBody: { flex: 1, paddingHorizontal: 20 },
  editorTitle: {
    fontSize: 26, fontWeight: '800', marginTop: 16, marginBottom: 8, padding: 0,
    letterSpacing: -0.4,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none', fontFamily: '"Segoe UI", system-ui, sans-serif' } : {}),
  },
  editorContent: {
    fontSize: 16, lineHeight: 26, minHeight: 200, padding: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },

  editorBottomBar: {
    paddingHorizontal: 16, paddingVertical: 10,
    paddingBottom: Platform.OS === 'ios' ? 34 : 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  bottomBarContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bottomBarBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingHorizontal: 10 },
  bottomBarBtnText: { fontSize: 13, fontWeight: '500' },
  colorPreview: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5 },
  colorBarRow: { flexDirection: 'row', justifyContent: 'center', gap: 10, paddingVertical: 4 },
  colorBarCircle: { width: 38, height: 38, borderRadius: 19 },
  charCount: {
    fontSize: 11,
    fontWeight: '400',
  },
});
