import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Dimensions,
  ActivityIndicator, Alert, StatusBar, ScrollView, Animated, Easing,
  PanResponder,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import { IconArrowLeft, IconPlus, IconTrash, IconDownload, IconMail, IconCheck } from '../components/Icons';
import * as api from '../services/api';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const isDesktop = Platform.OS === 'web' && SCREEN_W > 768;

// ---- Notebook Editor HTML (Canvas + Text Layer) ----
function getNotebookHTML(isDark) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; -webkit-user-select: none; user-select: none; }
html, body { width: 100%; height: 100%; overflow: hidden; background: ${isDark ? '#1a1a1a' : '#f5f0e8'}; touch-action: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }

#notebook-container {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

#page-wrapper {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  overflow: auto;
  -webkit-overflow-scrolling: touch;
}

#page {
  position: relative;
  width: 100%;
  max-width: 800px;
  min-height: 100%;
  background: ${isDark ? '#2a2a2a' : '#fffef9'};
  box-shadow: 0 2px 30px rgba(0,0,0,0.1), 0 0 0 1px ${isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)'};
}

/* Paper texture overlay */
#page::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  background: ${isDark ? 'none' : 'url("data:image/svg+xml,%3Csvg width=\'100\' height=\'100\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence baseFrequency=\'0.7\' numOctaves=\'3\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100\' height=\'100\' filter=\'url(%23n)\' opacity=\'0.02\'/%3E%3C/svg%3E")'};
  pointer-events: none;
  z-index: 0;
  opacity: 0.5;
}

/* Page curl hint */
#page::after {
  content: '';
  position: absolute;
  bottom: 0; right: 0;
  width: 30px; height: 30px;
  background: linear-gradient(135deg, transparent 50%, ${isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.04)'} 50%);
  pointer-events: none;
  z-index: 50;
}

#bg-canvas {
  position: absolute;
  top: 0; left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
}

#drawing-canvas {
  position: absolute;
  top: 0; left: 0;
  width: 100%;
  height: 100%;
  z-index: 2;
  touch-action: none;
  cursor: crosshair;
}

#text-layer {
  position: absolute;
  top: 0; left: 0;
  width: 100%;
  min-height: 100%;
  padding: 60px 40px 80px 80px;
  z-index: 3;
  font-family: 'Georgia', 'Times New Roman', serif;
  font-size: 18px;
  line-height: 32px;
  color: ${isDark ? '#e0e0e0' : '#333'};
  outline: none;
  white-space: pre-wrap;
  word-wrap: break-word;
  -webkit-user-select: text;
  user-select: text;
  pointer-events: none;
  opacity: 0.9;
}

#text-layer.active {
  pointer-events: auto;
  cursor: text;
  opacity: 1;
}

#text-layer:empty::before {
  content: attr(data-placeholder);
  color: ${isDark ? '#555' : '#bbb'};
  font-style: italic;
}

/* Red margin line */
#margin-line {
  position: absolute;
  top: 0; bottom: 0;
  left: 72px;
  width: 2px;
  background: ${isDark ? 'rgba(220,60,60,0.2)' : 'rgba(220,60,60,0.3)'};
  z-index: 4;
  pointer-events: none;
}

/* Floating Toolbar */
#toolbar {
  position: fixed;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  background: ${isDark ? 'rgba(30,30,35,0.96)' : 'rgba(255,255,255,0.97)'};
  border: 1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'};
  display: flex;
  align-items: center;
  padding: 6px 10px;
  gap: 3px;
  z-index: 100;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border-radius: 16px;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 4px 24px rgba(0,0,0,0.12), 0 0 0 0.5px ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'};
  max-width: calc(100% - 24px);
}

.tool-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 38px;
  height: 38px;
  padding: 0 8px;
  border-radius: 10px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: ${isDark ? '#999' : '#666'};
  transition: all 0.2s cubic-bezier(0.4,0,0.2,1);
  white-space: nowrap;
  flex-shrink: 0;
  position: relative;
}

.tool-btn:hover {
  background: ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'};
  color: ${isDark ? '#ccc' : '#333'};
}
.tool-btn.active {
  background: ${isDark ? 'rgba(100,160,255,0.18)' : 'rgba(37,99,235,0.12)'};
  color: ${isDark ? '#6aa0ff' : '#2563eb'};
  box-shadow: 0 0 12px ${isDark ? 'rgba(100,160,255,0.15)' : 'rgba(37,99,235,0.1)'};
}
.tool-btn:active {
  transform: scale(0.92);
}

.tool-btn svg {
  transition: transform 0.15s;
}
.tool-btn:hover svg {
  transform: scale(1.08);
}

.separator {
  width: 1px;
  height: 24px;
  background: ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'};
  margin: 0 4px;
  flex-shrink: 0;
  border-radius: 1px;
}

.color-dot {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2.5px solid transparent;
  cursor: pointer;
  transition: transform 0.2s cubic-bezier(0.34,1.56,0.64,1), border-color 0.2s, box-shadow 0.2s;
  flex-shrink: 0;
}
.color-dot:hover { transform: scale(1.2); }
.color-dot.active {
  border-color: ${isDark ? '#fff' : '#333'};
  transform: scale(1.2);
  box-shadow: 0 0 8px rgba(0,0,0,0.2);
}

.width-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  border: none;
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s;
}
.width-btn:hover { background: ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'}; }
.width-btn.active {
  background: ${isDark ? 'rgba(100,160,255,0.18)' : 'rgba(37,99,235,0.12)'};
  box-shadow: 0 0 8px ${isDark ? 'rgba(100,160,255,0.1)' : 'rgba(37,99,235,0.08)'};
}

.width-dot {
  border-radius: 50%;
  background: ${isDark ? '#aaa' : '#333'};
  transition: transform 0.15s;
}
.width-btn:hover .width-dot { transform: scale(1.15); }

/* Page info bar */
#page-info {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: 44px;
  background: ${isDark ? 'rgba(26,26,26,0.95)' : 'rgba(255,255,255,0.95)'};
  border-bottom: 1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'};
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  z-index: 100;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

#page-info .info-text {
  font-size: 13px;
  color: ${isDark ? '#888' : '#999'};
  font-weight: 500;
}

#page-info .save-status {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 12px;
  background: ${isDark ? 'rgba(80,200,120,0.15)' : 'rgba(34,197,94,0.1)'};
  color: ${isDark ? '#50c878' : '#16a34a'};
  font-weight: 600;
  transition: opacity 0.3s;
}

/* Action buttons in page info */
.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: ${isDark ? '#999' : '#666'};
  transition: all 0.15s;
}
.action-btn:hover {
  background: ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'};
  color: ${isDark ? '#ccc' : '#333'};
}

/* Sub-toolbar (colors/widths panel) */
#sub-toolbar {
  position: fixed;
  bottom: 70px;
  left: 50%;
  transform: translateX(-50%);
  background: ${isDark ? 'rgba(30,30,35,0.96)' : 'rgba(255,255,255,0.97)'};
  border: 1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'};
  padding: 10px 14px;
  display: none;
  align-items: center;
  gap: 10px;
  z-index: 99;
  justify-content: center;
  flex-wrap: wrap;
  border-radius: 14px;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 4px 20px rgba(0,0,0,0.12);
  max-width: calc(100% - 24px);
}
#sub-toolbar.visible { display: flex; }

/* Background picker panel */
#bg-panel {
  position: fixed;
  bottom: 70px;
  left: 50%;
  transform: translateX(-50%);
  background: ${isDark ? 'rgba(30,30,35,0.96)' : 'rgba(255,255,255,0.97)'};
  border: 1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'};
  padding: 12px 14px;
  display: none;
  align-items: center;
  gap: 12px;
  z-index: 99;
  justify-content: center;
  border-radius: 14px;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 4px 20px rgba(0,0,0,0.12);
}
#bg-panel.visible { display: flex; }

.bg-option {
  width: 56px;
  height: 56px;
  border-radius: 12px;
  border: 2px solid ${isDark ? '#444' : '#ddd'};
  background: ${isDark ? '#2a2a2a' : '#fff'};
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: border-color 0.2s, transform 0.2s;
}
.bg-option:hover { border-color: ${isDark ? '#666' : '#999'}; transform: scale(1.06); }
.bg-option.active { border-color: ${isDark ? '#6aa0ff' : '#2563eb'}; border-width: 2.5px; }
.bg-option canvas { width: 100%; height: 100%; }

.bg-label {
  font-size: 10px;
  color: ${isDark ? '#888' : '#999'};
  text-align: center;
  margin-top: 4px;
  font-weight: 500;
}

/* Page thumbnails bar */
#thumbnail-bar {
  position: fixed;
  bottom: 70px;
  left: 0; right: 0;
  height: 72px;
  background: ${isDark ? 'rgba(26,26,26,0.95)' : 'rgba(255,255,255,0.95)'};
  border-top: 1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'};
  display: none;
  align-items: center;
  padding: 6px 12px;
  gap: 8px;
  z-index: 98;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
#thumbnail-bar.visible { display: flex; }

.thumb-item {
  flex-shrink: 0;
  width: 48px;
  height: 56px;
  border-radius: 6px;
  border: 2px solid ${isDark ? '#444' : '#ddd'};
  background: ${isDark ? '#2a2a2a' : '#fff'};
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: border-color 0.2s, transform 0.15s;
}
.thumb-item:hover { transform: scale(1.08); }
.thumb-item.active { border-color: ${isDark ? '#6aa0ff' : '#2563eb'}; border-width: 2.5px; }
.thumb-item canvas { width: 100%; height: 100%; }
.thumb-num {
  position: absolute;
  bottom: 2px;
  right: 3px;
  font-size: 8px;
  font-weight: 700;
  color: ${isDark ? '#888' : '#999'};
}

/* Print-friendly styles */
@media print {
  #toolbar, #sub-toolbar, #bg-panel, #page-info, #thumbnail-bar { display: none !important; }
  #page-wrapper { padding: 0 !important; overflow: visible !important; }
  #page { box-shadow: none !important; max-width: 100% !important; }
  body { background: white !important; }
  #notebook-container { overflow: visible !important; }
}
</style>
</head>
<body>
<div id="notebook-container">
  <!-- Top bar with page info -->
  <div id="page-info">
    <span class="info-text" id="page-indicator">Page 1 of 1</span>
    <div style="display:flex;align-items:center;gap:4px">
      <button class="action-btn" onclick="exportPdf()" title="Export PDF">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
      <button class="action-btn" id="btn-thumbs" onclick="toggleThumbnails()" title="Pages">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/></svg>
      </button>
      <span class="save-status" id="save-status" style="opacity:0">Saved</span>
    </div>
  </div>

  <div id="page-wrapper" style="padding-top: 44px; padding-bottom: 70px;">
    <div id="page">
      <canvas id="bg-canvas"></canvas>
      <canvas id="drawing-canvas"></canvas>
      <div id="text-layer" contenteditable="false" data-placeholder=""></div>
      <div id="margin-line"></div>
    </div>
  </div>

  <!-- Page thumbnails bar -->
  <div id="thumbnail-bar"></div>

  <!-- Sub-toolbar (colors / widths) -->
  <div id="sub-toolbar"></div>

  <!-- Background picker -->
  <div id="bg-panel"></div>

  <!-- Main toolbar (floating) -->
  <div id="toolbar">
    <button class="tool-btn active" id="btn-pen" onclick="selectTool('pen')" title="Pen">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>
    </button>
    <button class="tool-btn" id="btn-highlighter" onclick="selectTool('highlighter')" title="Highlighter">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l-6 6v3h9l3-3"/><path d="M22 12l-4.6 4.6a2 2 0 01-2.8 0l-5.2-5.2a2 2 0 010-2.8L14 4"/></svg>
    </button>
    <button class="tool-btn" id="btn-eraser" onclick="selectTool('eraser')" title="Eraser">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20H7L3 16a1 1 0 010-1.4l9.6-9.6a2 2 0 012.8 0l5.2 5.2a2 2 0 010 2.8L13 20"/><path d="M6 12l6 6"/></svg>
    </button>
    <button class="tool-btn" id="btn-text" onclick="selectTool('text')" title="Text">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>
    </button>

    <div class="separator"></div>

    <button class="tool-btn" id="btn-colors" onclick="togglePanel('colors')" title="Colors">
      <div style="width:22px;height:22px;border-radius:50%;border:2.5px solid ${isDark ? '#555' : '#ccc'};transition:all 0.2s" id="color-indicator"></div>
    </button>

    <button class="tool-btn" id="btn-widths" onclick="togglePanel('widths')" title="Width">
      <div style="display:flex;flex-direction:column;gap:3px;align-items:center">
        <div style="width:14px;height:2px;background:currentColor;border-radius:1px"></div>
        <div style="width:14px;height:3px;background:currentColor;border-radius:2px"></div>
        <div style="width:14px;height:5px;background:currentColor;border-radius:3px"></div>
      </div>
    </button>

    <div class="separator"></div>

    <button class="tool-btn" id="btn-undo" onclick="undoStroke()" title="Undo">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
    </button>
    <button class="tool-btn" id="btn-redo" onclick="redoStroke()" title="Redo">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.13-9.36L23 10"/></svg>
    </button>

    <div class="separator"></div>

    <button class="tool-btn" id="btn-bg" onclick="togglePanel('bg')" title="Background">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
    </button>

    <button class="tool-btn" id="btn-clear" onclick="clearAll()" title="Clear">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
    </button>
  </div>
</div>

<script>
// ---- State ----
let currentTool = 'pen';
let currentColor = '#333333';
let currentWidth = 2;
let background = 'lined';
let strokes = [];
let redoStack = [];
let isDrawing = false;
let currentStroke = null;
let textContent = '';
let isDark = ${isDark ? 'true' : 'false'};
let openPanel = null;
let pageHeight = 1200;
let showThumbs = false;

const COLORS = ['#333333', '#1a73e8', '#d32f2f', '#2e7d32', '#7b1fa2', '#f57c00', '#00838f', '#c2185b', '#455a64', '#e65100'];
const WIDTHS = [
  { label: 'thin', size: 1.5 },
  { label: 'medium', size: 3 },
  { label: 'thick', size: 6 },
  { label: 'extra', size: 10 },
];

// ---- Elements ----
const page = document.getElementById('page');
const bgCanvas = document.getElementById('bg-canvas');
const drawCanvas = document.getElementById('drawing-canvas');
const textLayer = document.getElementById('text-layer');
const bgCtx = bgCanvas.getContext('2d');
const drawCtx = drawCanvas.getContext('2d');
const pageIndicator = document.getElementById('page-indicator');
const saveStatusEl = document.getElementById('save-status');
const colorIndicator = document.getElementById('color-indicator');
const marginLine = document.getElementById('margin-line');

// ---- Resize ----
function resizePage() {
  const w = Math.min(page.clientWidth, 800);
  const h = Math.max(pageHeight, window.innerHeight - 98);
  page.style.height = h + 'px';

  const dpr = window.devicePixelRatio || 1;
  bgCanvas.width = w * dpr;
  bgCanvas.height = h * dpr;
  bgCanvas.style.width = w + 'px';
  bgCanvas.style.height = h + 'px';
  bgCtx.scale(dpr, dpr);

  drawCanvas.width = w * dpr;
  drawCanvas.height = h * dpr;
  drawCanvas.style.width = w + 'px';
  drawCanvas.style.height = h + 'px';
  drawCtx.scale(dpr, dpr);

  drawBackground();
  redrawStrokes();
}

// ---- Draw Background ----
function drawBackground() {
  const w = bgCanvas.width / (window.devicePixelRatio || 1);
  const h = bgCanvas.height / (window.devicePixelRatio || 1);
  bgCtx.clearRect(0, 0, w, h);

  const lineColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,100,200,0.08)';
  const dotColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,100,200,0.15)';

  if (background === 'lined') {
    bgCtx.strokeStyle = lineColor;
    bgCtx.lineWidth = 1;
    for (let y = 60; y < h; y += 32) {
      bgCtx.beginPath();
      bgCtx.moveTo(40, y);
      bgCtx.lineTo(w - 20, y);
      bgCtx.stroke();
    }
    marginLine.style.display = 'block';
  } else if (background === 'grid') {
    bgCtx.strokeStyle = lineColor;
    bgCtx.lineWidth = 0.5;
    const gridSize = 24;
    for (let x = 24; x < w; x += gridSize) {
      bgCtx.beginPath(); bgCtx.moveTo(x, 0); bgCtx.lineTo(x, h); bgCtx.stroke();
    }
    for (let y = 24; y < h; y += gridSize) {
      bgCtx.beginPath(); bgCtx.moveTo(0, y); bgCtx.lineTo(w, y); bgCtx.stroke();
    }
    marginLine.style.display = 'none';
  } else if (background === 'dotted') {
    bgCtx.fillStyle = dotColor;
    const dotSpacing = 24;
    for (let x = 24; x < w; x += dotSpacing) {
      for (let y = 24; y < h; y += dotSpacing) {
        bgCtx.beginPath();
        bgCtx.arc(x, y, 1.2, 0, Math.PI * 2);
        bgCtx.fill();
      }
    }
    marginLine.style.display = 'none';
  } else {
    marginLine.style.display = 'none';
  }
}

// ---- Draw Strokes ----
function redrawStrokes() {
  const w = drawCanvas.width / (window.devicePixelRatio || 1);
  const h = drawCanvas.height / (window.devicePixelRatio || 1);
  drawCtx.clearRect(0, 0, w, h);
  for (const stroke of strokes) {
    drawStroke(stroke);
  }
}

function drawStroke(stroke) {
  if (!stroke.points || stroke.points.length < 2) return;
  const ctx = drawCtx;
  ctx.save();

  if (stroke.tool === 'highlighter') {
    ctx.globalAlpha = 0.3;
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';
  } else {
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  ctx.strokeStyle = stroke.color || '#333';
  ctx.lineWidth = stroke.width || 2;

  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x, stroke.points[0].y);

  for (let i = 1; i < stroke.points.length - 1; i++) {
    const p = stroke.points[i];
    const np = stroke.points[i + 1];
    const midX = (p.x + np.x) / 2;
    const midY = (p.y + np.y) / 2;

    if (p.pressure !== undefined && p.pressure > 0) {
      ctx.lineWidth = (stroke.width || 2) * (0.5 + p.pressure);
    }

    ctx.quadraticCurveTo(p.x, p.y, midX, midY);
  }

  const lastPt = stroke.points[stroke.points.length - 1];
  ctx.lineTo(lastPt.x, lastPt.y);
  ctx.stroke();
  ctx.restore();
}

// ---- Pointer Events (Drawing) - using rAF for smoothness ----
let pendingPoints = [];
let rafId = null;

function getCanvasPos(e) {
  const rect = drawCanvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
    pressure: e.pressure || 0.5,
  };
}

function processPoints() {
  if (!currentStroke || pendingPoints.length === 0) { rafId = null; return; }

  for (const pos of pendingPoints) {
    currentStroke.points.push(pos);
    const pts = currentStroke.points;
    if (pts.length >= 3) {
      const p1 = pts[pts.length - 3];
      const p2 = pts[pts.length - 2];
      const p3 = pts[pts.length - 1];
      drawCtx.save();
      if (currentTool === 'highlighter') {
        drawCtx.globalAlpha = 0.3;
        drawCtx.lineCap = 'square';
        drawCtx.lineJoin = 'miter';
      } else {
        drawCtx.globalAlpha = 1;
        drawCtx.lineCap = 'round';
        drawCtx.lineJoin = 'round';
      }
      drawCtx.strokeStyle = currentStroke.color;
      drawCtx.lineWidth = currentStroke.width * (0.5 + (pos.pressure || 0.5));
      drawCtx.beginPath();
      drawCtx.moveTo(p1.x, p1.y);
      const midX = (p2.x + p3.x) / 2;
      const midY = (p2.y + p3.y) / 2;
      drawCtx.quadraticCurveTo(p2.x, p2.y, midX, midY);
      drawCtx.stroke();
      drawCtx.restore();
    }
  }
  pendingPoints = [];
  rafId = null;
}

drawCanvas.addEventListener('pointerdown', (e) => {
  if (currentTool === 'text') return;
  e.preventDefault();
  isDrawing = true;
  const pos = getCanvasPos(e);
  if (currentTool === 'eraser') { eraseAt(pos.x, pos.y); return; }
  currentStroke = { points: [pos], color: currentColor, width: currentWidth, tool: currentTool };
  drawCanvas.setPointerCapture(e.pointerId);
});

drawCanvas.addEventListener('pointermove', (e) => {
  if (!isDrawing) return;
  e.preventDefault();
  const pos = getCanvasPos(e);
  if (currentTool === 'eraser') { eraseAt(pos.x, pos.y); return; }
  if (currentStroke) {
    pendingPoints.push(pos);
    if (!rafId) rafId = requestAnimationFrame(processPoints);
  }
});

drawCanvas.addEventListener('pointerup', (e) => {
  if (!isDrawing) return;
  isDrawing = false;
  if (currentTool === 'eraser') { notifyChange(); return; }
  // Process remaining points
  if (pendingPoints.length > 0 && currentStroke) {
    for (const p of pendingPoints) currentStroke.points.push(p);
    pendingPoints = [];
  }
  if (currentStroke && currentStroke.points.length >= 2) {
    strokes.push(currentStroke);
    redoStack = [];
    notifyChange();
  }
  currentStroke = null;
});

drawCanvas.addEventListener('pointerleave', (e) => {
  if (isDrawing && currentTool !== 'eraser' && currentStroke) {
    if (pendingPoints.length > 0) {
      for (const p of pendingPoints) currentStroke.points.push(p);
      pendingPoints = [];
    }
    if (currentStroke.points.length >= 2) {
      strokes.push(currentStroke);
      redoStack = [];
      notifyChange();
    }
  }
  isDrawing = false;
  currentStroke = null;
});

drawCanvas.addEventListener('touchstart', (e) => { if (currentTool !== 'text') e.preventDefault(); }, { passive: false });
drawCanvas.addEventListener('touchmove', (e) => { if (currentTool !== 'text') e.preventDefault(); }, { passive: false });

// ---- Eraser ----
function eraseAt(x, y) {
  const radius = 20;
  const before = strokes.length;
  strokes = strokes.filter(stroke => {
    return !stroke.points.some(p => {
      const dx = p.x - x;
      const dy = p.y - y;
      return (dx * dx + dy * dy) < (radius * radius);
    });
  });
  if (strokes.length !== before) redrawStrokes();
}

// ---- Tool Selection ----
function selectTool(tool) {
  currentTool = tool;
  document.querySelectorAll('#toolbar .tool-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('btn-' + tool);
  if (btn) btn.classList.add('active');

  if (tool === 'text') {
    textLayer.classList.add('active');
    textLayer.contentEditable = 'true';
    drawCanvas.style.pointerEvents = 'none';
    textLayer.focus();
  } else {
    textLayer.classList.remove('active');
    textLayer.contentEditable = 'false';
    drawCanvas.style.pointerEvents = 'auto';
  }

  closeAllPanels();

  if (tool === 'eraser') drawCanvas.style.cursor = 'cell';
  else if (tool === 'text') drawCanvas.style.cursor = 'text';
  else drawCanvas.style.cursor = 'crosshair';
}

// ---- Undo / Redo ----
function undoStroke() {
  if (strokes.length === 0) return;
  redoStack.push(strokes.pop());
  redrawStrokes();
  notifyChange();
}

function redoStroke() {
  if (redoStack.length === 0) return;
  strokes.push(redoStack.pop());
  redrawStrokes();
  notifyChange();
}

// ---- Clear All ----
function clearAll() {
  if (strokes.length === 0) return;
  if (confirm('Clear all drawings?')) {
    redoStack = redoStack.concat(strokes.reverse());
    strokes = [];
    redrawStrokes();
    notifyChange();
  }
}

// ---- Export PDF ----
function exportPdf() {
  window.print();
}

// ---- Thumbnails ----
function toggleThumbnails() {
  showThumbs = !showThumbs;
  const bar = document.getElementById('thumbnail-bar');
  if (showThumbs) {
    bar.classList.add('visible');
    renderThumbnails();
  } else {
    bar.classList.remove('visible');
  }
}

function renderThumbnails() {
  // Send message to React Native to get page list for thumbnails
  const msg = { type: 'getThumbnails' };
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  } else {
    window.parent.postMessage(msg, '*');
  }
}

function updateThumbnails(pages, currentIdx) {
  const bar = document.getElementById('thumbnail-bar');
  if (!bar) return;
  bar.innerHTML = '';

  pages.forEach((pg, i) => {
    const item = document.createElement('div');
    item.className = 'thumb-item' + (i === currentIdx ? ' active' : '');
    item.onclick = () => {
      const msg = { type: 'goToPage', pageIndex: i };
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      } else {
        window.parent.postMessage(msg, '*');
      }
    };

    // Mini canvas for thumbnail
    const c = document.createElement('canvas');
    c.width = 48;
    c.height = 56;
    item.appendChild(c);

    // Page number
    const num = document.createElement('span');
    num.className = 'thumb-num';
    num.textContent = (i + 1);
    item.appendChild(num);

    bar.appendChild(item);

    // Draw mini preview
    const ctx = c.getContext('2d');
    ctx.fillStyle = isDark ? '#2a2a2a' : '#fffef9';
    ctx.fillRect(0, 0, 48, 56);

    // Draw mini lines
    const lc = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,100,200,0.08)';
    ctx.strokeStyle = lc;
    ctx.lineWidth = 0.3;
    for (let y = 8; y < 56; y += 6) {
      ctx.beginPath(); ctx.moveTo(8, y); ctx.lineTo(40, y); ctx.stroke();
    }

    // Draw mini strokes if available
    if (pg.content_drawing) {
      try {
        const drw = typeof pg.content_drawing === 'string' ? JSON.parse(pg.content_drawing) : pg.content_drawing;
        if (Array.isArray(drw)) {
          const scale = 48 / 800;
          ctx.save();
          ctx.scale(scale, scale * (56/1200));
          for (const s of drw.slice(0, 20)) {
            if (!s.points || s.points.length < 2) continue;
            ctx.strokeStyle = s.color || '#333';
            ctx.lineWidth = Math.max(1, (s.width || 2) / scale);
            ctx.globalAlpha = s.tool === 'highlighter' ? 0.3 : 0.8;
            ctx.beginPath();
            ctx.moveTo(s.points[0].x, s.points[0].y);
            for (let j = 1; j < s.points.length; j++) {
              ctx.lineTo(s.points[j].x, s.points[j].y);
            }
            ctx.stroke();
          }
          ctx.restore();
        }
      } catch(e) {}
    }

    // Draw mini text indicator
    if (pg.content_text && pg.content_text.trim()) {
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)';
      ctx.fillRect(10, 8, 28, 3);
      ctx.fillRect(10, 14, 20, 3);
    }
  });
}

// ---- Panels (Colors, Widths, Background) ----
function togglePanel(panel) {
  const subToolbar = document.getElementById('sub-toolbar');
  const bgPanel = document.getElementById('bg-panel');

  if (openPanel === panel) { closeAllPanels(); return; }

  closeAllPanels();
  openPanel = panel;

  if (panel === 'colors') {
    subToolbar.innerHTML = COLORS.map(c =>
      '<div class="color-dot' + (c === currentColor ? ' active' : '') + '" style="background:' + c + '" onclick="setColor(\\'' + c + '\\')"></div>'
    ).join('');
    subToolbar.classList.add('visible');
  } else if (panel === 'widths') {
    subToolbar.innerHTML = WIDTHS.map((w, i) =>
      '<button class="width-btn' + (w.size === currentWidth ? ' active' : '') + '" onclick="setWidth(' + w.size + ')">' +
      '<div class="width-dot" style="width:' + (6 + i * 5) + 'px;height:' + (6 + i * 5) + 'px"></div>' +
      '</button>'
    ).join('');
    subToolbar.classList.add('visible');
  } else if (panel === 'bg') {
    showBgPanel();
  }
}

function closeAllPanels() {
  document.getElementById('sub-toolbar').classList.remove('visible');
  document.getElementById('bg-panel').classList.remove('visible');
  openPanel = null;
}

function setColor(color) {
  currentColor = color;
  colorIndicator.style.background = color;
  document.querySelectorAll('.color-dot').forEach(d => {
    d.classList.toggle('active', d.style.background === color || d.style.backgroundColor === color);
  });
  if (currentTool === 'eraser') selectTool('pen');
}

function setWidth(w) {
  currentWidth = w;
  document.querySelectorAll('.width-btn').forEach((b, i) => {
    b.classList.toggle('active', WIDTHS[i].size === w);
  });
}

function showBgPanel() {
  const bgPanel = document.getElementById('bg-panel');
  const bgs = ['lined', 'grid', 'dotted', 'blank'];
  const labels = { lined: 'Lined', grid: 'Grid', dotted: 'Dotted', blank: 'Blank' };

  bgPanel.innerHTML = bgs.map(bg =>
    '<div style="text-align:center">' +
    '<div class="bg-option' + (bg === background ? ' active' : '') + '" onclick="setBackground(\\'' + bg + '\\')" id="bg-opt-' + bg + '"><canvas width="52" height="52"></canvas></div>' +
    '<div class="bg-label">' + labels[bg] + '</div></div>'
  ).join('');
  bgPanel.classList.add('visible');

  setTimeout(() => {
    bgs.forEach(bg => {
      const opt = document.getElementById('bg-opt-' + bg);
      if (!opt) return;
      const c = opt.querySelector('canvas');
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, 52, 52);
      const lc = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,100,200,0.15)';

      if (bg === 'lined') {
        ctx.strokeStyle = lc; ctx.lineWidth = 0.5;
        for (let y = 8; y < 52; y += 8) { ctx.beginPath(); ctx.moveTo(4, y); ctx.lineTo(48, y); ctx.stroke(); }
        ctx.strokeStyle = isDark ? 'rgba(220,60,60,0.3)' : 'rgba(220,60,60,0.4)';
        ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(12, 52); ctx.stroke();
      } else if (bg === 'grid') {
        ctx.strokeStyle = lc; ctx.lineWidth = 0.3;
        for (let x = 6; x < 52; x += 6) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 52); ctx.stroke(); }
        for (let y = 6; y < 52; y += 6) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(52, y); ctx.stroke(); }
      } else if (bg === 'dotted') {
        ctx.fillStyle = lc;
        for (let x = 6; x < 52; x += 6) { for (let y = 6; y < 52; y += 6) { ctx.beginPath(); ctx.arc(x, y, 0.8, 0, Math.PI * 2); ctx.fill(); } }
      }
    });
  }, 10);
}

function setBackground(bg) {
  background = bg;
  drawBackground();
  document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('active'));
  const opt = document.getElementById('bg-opt-' + bg);
  if (opt) opt.classList.add('active');
  notifyChange();
}

// ---- Text Layer ----
textLayer.addEventListener('input', () => {
  textContent = textLayer.innerHTML;
  const scrollH = textLayer.scrollHeight + 80;
  if (scrollH > pageHeight) {
    pageHeight = scrollH;
    resizePage();
  }
  notifyChange();
});

// ---- Communication with React Native ----
let saveTimer = null;

function notifyChange() {
  if (saveTimer) clearTimeout(saveTimer);
  showSaveStatus('saving');
  saveTimer = setTimeout(() => {
    const data = {
      type: 'save',
      content_text: textLayer.innerHTML,
      content_drawing: JSON.stringify(strokes),
      background: background,
    };
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(data));
    } else {
      window.parent.postMessage(data, '*');
    }
    showSaveStatus('saved');
  }, 2000);
}

function showSaveStatus(status) {
  if (status === 'saving') {
    saveStatusEl.textContent = '...';
    saveStatusEl.style.opacity = '1';
    saveStatusEl.style.background = isDark ? 'rgba(255,180,0,0.15)' : 'rgba(245,158,11,0.1)';
    saveStatusEl.style.color = isDark ? '#ffb400' : '#d97706';
  } else {
    saveStatusEl.textContent = 'Saved';
    saveStatusEl.style.opacity = '1';
    saveStatusEl.style.background = isDark ? 'rgba(80,200,120,0.15)' : 'rgba(34,197,94,0.1)';
    saveStatusEl.style.color = isDark ? '#50c878' : '#16a34a';
    setTimeout(() => { saveStatusEl.style.opacity = '0'; }, 2000);
  }
}

// ---- Load Page Data ----
function loadPageData(data) {
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;

    if (parsed.content_text !== undefined) {
      textLayer.innerHTML = parsed.content_text || '';
      textContent = parsed.content_text || '';
    }

    if (parsed.content_drawing) {
      const drawing = typeof parsed.content_drawing === 'string' ? JSON.parse(parsed.content_drawing) : parsed.content_drawing;
      strokes = Array.isArray(drawing) ? drawing : [];
    } else {
      strokes = [];
    }

    if (parsed.background) {
      background = parsed.background;
    }

    redoStack = [];

    const textH = textLayer.scrollHeight + 80;
    let maxStrokeY = 0;
    for (const s of strokes) {
      for (const p of (s.points || [])) {
        if (p.y > maxStrokeY) maxStrokeY = p.y;
      }
    }
    pageHeight = Math.max(1200, textH, maxStrokeY + 200);

    resizePage();
  } catch (e) {
    console.error('loadPageData error:', e);
  }
}

function updatePageIndicator(current, total) {
  pageIndicator.textContent = 'Page ' + current + ' of ' + total;
}

function updateLabels(labels) {
  try {
    const l = typeof labels === 'string' ? JSON.parse(labels) : labels;
    if (l.saved) saveStatusEl.textContent = l.saved;
  } catch(e) {}
}

// ---- Initialize ----
window.addEventListener('resize', () => { resizePage(); });

colorIndicator.style.background = currentColor;
resizePage();

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undoStroke(); }
    if (e.key === 'z' && e.shiftKey) { e.preventDefault(); redoStroke(); }
    if (e.key === 'y') { e.preventDefault(); redoStroke(); }
    if (e.key === 'p') { e.preventDefault(); exportPdf(); }
  }
});

// Notify ready
setTimeout(() => {
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
  }
}, 100);
// Handle postMessage exec from parent (replaces eval)
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'exec' && e.data.js) {
    try { (new Function(e.data.js))(); } catch(err) { console.warn('exec error:', err); }
  }
});
</script>
</body>
</html>`;
}

// ---- WebView Component (used on native) ----
let WebView = null;
try {
  WebView = require('react-native-webview').WebView;
} catch (e) {}

// ---- Web iframe fallback ----
function WebNotebookEditor({ html, onMessage, webviewRef }) {
  const iframeRef = useRef(null);

  useEffect(() => {
    const handleMsg = (e) => {
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (data && data.type) {
          onMessage({ nativeEvent: { data: JSON.stringify(data) } });
        }
      } catch {}
    };
    window.addEventListener('message', handleMsg);
    return () => window.removeEventListener('message', handleMsg);
  }, [onMessage]);

  useEffect(() => {
    if (webviewRef) {
      webviewRef.current = {
        injectJavaScript: (js) => {
          try {
            if (iframeRef.current && iframeRef.current.contentWindow) {
              iframeRef.current.contentWindow.postMessage({ type: 'exec', js }, '*');
            }
          } catch (e) {
            console.warn('inject error:', e);
          }
        },
      };
    }
  }, [webviewRef]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={html}
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        flex: 1,
      }}
      sandbox="allow-scripts allow-same-origin"
    />
  );
}

// ---- Main Screen ----
export default function NotebookEditorScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();

  const notebookId = parseInt(params.notebook_id) || 0;
  const notebookName = params.notebook_name ? decodeURIComponent(params.notebook_name) : t('notes.notebook');
  const notebookColor = params.notebook_color ? decodeURIComponent(params.notebook_color) : '#4285F4';

  const [pages, setPages] = useState([]);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const webviewRef = useRef(null);
  const saveTimeoutRef = useRef(null);
  const pagesRef = useRef([]);

  // Load pages
  const loadPages = useCallback(async () => {
    if (!notebookId) return;
    try {
      setLoading(true);
      const res = await api.notebookPagesList(notebookId);
      if (res?.success && res.data?.pages) {
        setPages(res.data.pages);
        pagesRef.current = res.data.pages;
      }
    } catch (e) {
      console.warn('Failed to load pages:', e);
    } finally {
      setLoading(false);
    }
  }, [notebookId]);

  useEffect(() => { loadPages(); }, [loadPages]);

  // Load page data into WebView when page changes
  useEffect(() => {
    if (pages.length > 0 && webviewRef.current) {
      const page = pages[currentPageIndex];
      if (page) {
        const pageData = JSON.stringify({
          content_text: page.content_text || '',
          content_drawing: page.content_drawing || '[]',
          background: page.background || 'lined',
        }).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

        webviewRef.current.injectJavaScript(`
          loadPageData('${pageData}');
          updatePageIndicator(${currentPageIndex + 1}, ${pages.length});
          true;
        `);
      }
    }
  }, [currentPageIndex, pages]);

  // Handle messages from WebView
  const handleMessage = useCallback(async (event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.type === 'ready') {
        // WebView is ready, load first page
        if (pagesRef.current.length > 0) {
          const page = pagesRef.current[0];
          const pageData = JSON.stringify({
            content_text: page.content_text || '',
            content_drawing: page.content_drawing || '[]',
            background: page.background || 'lined',
          }).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

          webviewRef.current?.injectJavaScript(`
            loadPageData('${pageData}');
            updatePageIndicator(1, ${pagesRef.current.length});
            true;
          `);
        }
      } else if (data.type === 'save') {
        // Save page data
        const pageId = pagesRef.current[currentPageIndex]?.id;
        if (!pageId) return;

        try {
          setSaving(true);
          await api.notebookPageSave(pageId, {
            content_text: data.content_text || '',
            content_drawing: data.content_drawing || '[]',
            background: data.background || 'lined',
          });

          // Update local state
          setPages(prev => {
            const updated = [...prev];
            if (updated[currentPageIndex]) {
              updated[currentPageIndex] = {
                ...updated[currentPageIndex],
                content_text: data.content_text || '',
                content_drawing: data.content_drawing || '[]',
                background: data.background || 'lined',
              };
            }
            pagesRef.current = updated;
            return updated;
          });
        } catch (e) {
          console.warn('Save failed:', e);
        } finally {
          setSaving(false);
        }
      } else if (data.type === 'getThumbnails') {
        // Send page data back for thumbnails
        const thumbData = JSON.stringify(pagesRef.current.map(p => ({
          content_text: p.content_text || '',
          content_drawing: p.content_drawing || '[]',
        }))).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

        webviewRef.current?.injectJavaScript(`
          updateThumbnails(JSON.parse('${thumbData}'), ${currentPageIndex});
          true;
        `);
      } else if (data.type === 'goToPage') {
        const idx = data.pageIndex;
        if (idx >= 0 && idx < pagesRef.current.length) {
          setCurrentPageIndex(idx);
        }
      }
    } catch (e) {
      console.warn('Message parse error:', e);
    }
  }, [currentPageIndex]);

  // Navigate pages
  const goToPage = useCallback((index) => {
    if (index < 0 || index >= pages.length) return;
    setCurrentPageIndex(index);
  }, [pages.length]);

  // Add new page
  const addPage = useCallback(async () => {
    if (!notebookId) return;
    try {
      const currentBg = pages[currentPageIndex]?.background || 'lined';
      const res = await api.notebookPageCreate(notebookId, currentBg);
      if (res?.success && res.data?.page) {
        const newPages = [...pages, res.data.page];
        setPages(newPages);
        pagesRef.current = newPages;
        setCurrentPageIndex(newPages.length - 1);
      }
    } catch (e) {
      console.warn('Add page failed:', e);
    }
  }, [notebookId, pages, currentPageIndex]);

  // Delete current page
  const deletePage = useCallback(async () => {
    if (pages.length <= 1) return;
    const page = pages[currentPageIndex];
    if (!page) return;

    const doDelete = async () => {
      try {
        const res = await api.notebookPageDelete(page.id);
        if (res?.success) {
          const newPages = pages.filter((_, i) => i !== currentPageIndex);
          setPages(newPages);
          pagesRef.current = newPages;
          const newIndex = Math.min(currentPageIndex, newPages.length - 1);
          setCurrentPageIndex(newIndex);
        }
      } catch (e) {
        console.warn('Delete page failed:', e);
      }
    };

    if (Platform.OS === 'web') {
      if (confirm(t('notebook.deletePageConfirm'))) doDelete();
    } else {
      Alert.alert(t('notebook.deletePage'), t('notebook.deletePageConfirm'), [
        { text: t('notebook.undo'), style: 'cancel' },
        { text: t('notebook.deletePage'), style: 'destructive', onPress: doDelete },
      ]);
    }
  }, [pages, currentPageIndex, t]);

  const html = useMemo(() => getNotebookHTML(isDark), [isDark]);

  // Page swipe gesture for mobile
  const swipeAnim = useRef(new Animated.Value(0)).current;
  const [swiping, setSwiping] = useState(false);

  const pageSwipeResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => !isDesktop && Math.abs(g.dx) > 20 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
      onPanResponderGrant: () => {
        setSwiping(true);
      },
      onPanResponderMove: (_, g) => {
        // Restrict swiping at boundaries
        if (g.dx > 0 && currentPageIndex === 0) {
          swipeAnim.setValue(g.dx * 0.2); // rubber band
        } else if (g.dx < 0 && currentPageIndex >= pages.length - 1) {
          swipeAnim.setValue(g.dx * 0.2); // rubber band
        } else {
          swipeAnim.setValue(g.dx);
        }
      },
      onPanResponderRelease: (_, g) => {
        setSwiping(false);
        const threshold = SCREEN_W * 0.25;
        if (g.dx < -threshold && currentPageIndex < pages.length - 1) {
          // Swipe left -> next page
          Animated.timing(swipeAnim, { toValue: -SCREEN_W, duration: 200, useNativeDriver: true }).start(() => {
            setCurrentPageIndex(prev => prev + 1);
            swipeAnim.setValue(0);
          });
        } else if (g.dx > threshold && currentPageIndex > 0) {
          // Swipe right -> previous page
          Animated.timing(swipeAnim, { toValue: SCREEN_W, duration: 200, useNativeDriver: true }).start(() => {
            setCurrentPageIndex(prev => prev - 1);
            swipeAnim.setValue(0);
          });
        } else {
          Animated.spring(swipeAnim, { toValue: 0, tension: 120, friction: 14, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  // Auto-save indicator
  const [saveIndicator, setSaveIndicator] = useState('');
  const saveIndicatorAnim = useRef(new Animated.Value(0)).current;

  const showSaveIndicator = useCallback((status) => {
    setSaveIndicator(status);
    saveIndicatorAnim.setValue(1);
    if (status === 'saved') {
      setTimeout(() => {
        Animated.timing(saveIndicatorAnim, { toValue: 0, duration: 500, useNativeDriver: true }).start();
      }, 1500);
    }
  }, []);

  // Wrap handleMessage to show save indicator
  const handleMessageWithIndicator = useCallback(async (event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'save') {
        showSaveIndicator('saving');
      }
    } catch {}
    await handleMessage(event);
    showSaveIndicator('saved');
  }, [handleMessage, showSaveIndicator]);

  if (!notebookId) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ color: colors.textSecondary }}>No notebook selected</Text>
      </View>
    );
  }

  // Darken color helper
  const darkenColor = (hex, amount) => {
    try {
      const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount);
      const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount);
      const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount);
      return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    } catch { return hex; }
  };

  return (
    <View style={[styles.container, { backgroundColor: isDark ? '#1a1a1a' : '#f5f0e8' }]}>
      {/* Header - Noteshelf style with notebook color */}
      <View style={[styles.header, {
        backgroundColor: notebookColor,
        ...(Platform.OS === 'web' ? {
          background: `linear-gradient(135deg, ${notebookColor}, ${darkenColor(notebookColor, 20)})`,
          boxShadow: `0 2px 12px ${notebookColor}44`,
        } : {}),
      }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <IconArrowLeft size={22} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {notebookName}
          </Text>
          {/* Save indicator */}
          <Animated.View style={[styles.saveIndicator, { opacity: saveIndicatorAnim }]}>
            {saveIndicator === 'saving' ? (
              <Text style={styles.saveIndicatorText}>{t('notebook.saving')}</Text>
            ) : (
              <View style={styles.saveIndicatorRow}>
                <IconCheck size={12} color="rgba(255,255,255,0.8)" />
                <Text style={styles.saveIndicatorText}>{t('notebook.autoSaved')}</Text>
              </View>
            )}
          </Animated.View>
        </View>
        <View style={styles.headerActions}>
          {pages.length > 1 && (
            <TouchableOpacity onPress={deletePage} style={styles.headerBtn}>
              <IconTrash size={18} color="rgba(255,255,255,0.8)" />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={addPage} style={[styles.headerBtn, styles.addPageBtn]}>
            <IconPlus size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Page navigation bar - always visible */}
      <View style={[styles.pageNav, {
        backgroundColor: isDark ? '#222' : '#fff',
        borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        ...(Platform.OS === 'web' ? {
          boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
        } : {}),
      }]}>
        <TouchableOpacity
          onPress={() => goToPage(currentPageIndex - 1)}
          disabled={currentPageIndex === 0}
          style={[styles.pageNavBtn, currentPageIndex === 0 && { opacity: 0.3 }]}
        >
          <Text style={[styles.pageNavArrow, { color: notebookColor }]}>{'<'}</Text>
        </TouchableOpacity>

        {/* Page indicator text */}
        <View style={styles.pageIndicatorCenter}>
          <Text style={[styles.pageIndicatorText, { color: isDark ? '#aaa' : '#666' }]}>
            {t('notebook.page')} {currentPageIndex + 1} {t('notebook.of')} {pages.length}
          </Text>
        </View>

        {/* Dot indicators (scrollable for many pages) */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pageDotsContainer}>
          {pages.map((_, i) => (
            <TouchableOpacity
              key={i}
              onPress={() => goToPage(i)}
              style={[
                styles.pageDot,
                {
                  backgroundColor: i === currentPageIndex ? notebookColor : (isDark ? '#444' : '#ddd'),
                  width: i === currentPageIndex ? 20 : 8,
                },
              ]}
            />
          ))}
        </ScrollView>

        <TouchableOpacity
          onPress={() => goToPage(currentPageIndex + 1)}
          disabled={currentPageIndex >= pages.length - 1}
          style={[styles.pageNavBtn, currentPageIndex >= pages.length - 1 && { opacity: 0.3 }]}
        >
          <Text style={[styles.pageNavArrow, { color: notebookColor }]}>{'>'}</Text>
        </TouchableOpacity>
      </View>

      {/* WebView / Content with swipe gesture overlay */}
      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={notebookColor} />
        </View>
      ) : (
        <Animated.View
          style={[
            { flex: 1 },
            !isDesktop && swiping && { transform: [{ translateX: swipeAnim }] },
          ]}
          {...(!isDesktop ? pageSwipeResponder.panHandlers : {})}
        >
          {Platform.OS === 'web' ? (
            <WebNotebookEditor
              html={html}
              onMessage={handleMessageWithIndicator}
              webviewRef={webviewRef}
            />
          ) : WebView ? (
            <WebView
              ref={webviewRef}
              source={{ html }}
              style={{ flex: 1, backgroundColor: 'transparent' }}
              onMessage={handleMessageWithIndicator}
              javaScriptEnabled
              domStorageEnabled
              allowsInlineMediaPlayback
              scrollEnabled={false}
              bounces={false}
              overScrollMode="never"
              showsVerticalScrollIndicator={false}
              showsHorizontalScrollIndicator={false}
              contentMode="mobile"
              scalesPageToFit={false}
              originWhitelist={['*']}
              mixedContentMode="always"
              allowFileAccess
              allowsBackForwardNavigationGestures={false}
            />
          ) : (
            <View style={styles.loadingContainer}>
              <Text style={{ color: colors.textSecondary }}>WebView not available</Text>
            </View>
          )}
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 54 : Platform.OS === 'web' ? 12 : 10,
    paddingBottom: 10,
    paddingHorizontal: 8,
    zIndex: 10,
  },
  headerBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerCenter: {
    flex: 1,
    marginHorizontal: 8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
    ...(Platform.OS === 'web' ? {
      fontFamily: 'Georgia, "Times New Roman", serif',
      letterSpacing: 0.3,
    } : {}),
  },
  saveIndicator: {
    marginTop: 2,
  },
  saveIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  saveIndicatorText: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.7)',
    fontWeight: '500',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  addPageBtn: {
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  pageNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    gap: 8,
    paddingHorizontal: 8,
  },
  pageNavBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pageNavArrow: {
    fontSize: 22,
    fontWeight: '700',
  },
  pageIndicatorCenter: {
    paddingHorizontal: 8,
  },
  pageIndicatorText: {
    fontSize: 13,
    fontWeight: '600',
  },
  pageDotsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 160,
    justifyContent: 'center',
  },
  pageDot: {
    height: 8,
    borderRadius: 4,
    ...(Platform.OS === 'web' ? { transition: 'all 0.25s cubic-bezier(0.4,0,0.2,1)' } : {}),
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
