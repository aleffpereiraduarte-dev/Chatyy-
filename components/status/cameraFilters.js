// [2026-10-11 boot-split] FILTERS + FilterOverlay split out of StatusCamera.js
// so ChatListTab's status editor can use them without statically importing the
// whole camera (2.3k LOC, expo-camera, music trim...) into the boot bundle.
// StatusCamera re-exports both — existing imports keep working.
import React from 'react';
import { View, StyleSheet } from 'react-native';

// ─── Instagram-style filters ───
// Each filter has: overlay layers (tint color + opacity + blendMode) that stack
// on top of the image on native. On confirm, the filter key is passed to parent.
export const FILTERS = [
  { key: 'normal',    label: 'Normal',    layers: [] },
  { key: 'clarendon', label: 'Clarendon', layers: [
    { color: 'rgba(127,187,227,0.2)', blend: 'overlay' },
    { color: 'rgba(0,0,0,0.05)', blend: 'multiply' },
  ], adjust: { contrast: 1.2, saturate: 1.35 } },
  { key: 'gingham',   label: 'Gingham',   layers: [
    { color: 'rgba(230,230,250,0.2)', blend: 'soft-light' },
  ], adjust: { brightness: 1.05, hueRotate: -10 } },
  { key: 'moon',      label: 'Moon',      layers: [
    { color: 'rgba(160,160,186,0.35)', blend: 'overlay' },
  ], adjust: { grayscale: 1, contrast: 1.1, brightness: 1.1 } },
  { key: 'lark',      label: 'Lark',      layers: [
    { color: 'rgba(242,242,220,0.15)', blend: 'soft-light' },
  ], adjust: { contrast: 0.9, brightness: 1.15, saturate: 1.2 } },
  { key: 'reyes',     label: 'Reyes',     layers: [
    { color: 'rgba(239,205,173,0.25)', blend: 'overlay' },
  ], adjust: { sepia: 0.22, brightness: 1.1, contrast: 0.85, saturate: 0.75 } },
  { key: 'juno',      label: 'Juno',      layers: [
    { color: 'rgba(127,140,200,0.12)', blend: 'overlay' },
  ], adjust: { contrast: 1.15, brightness: 1.05, saturate: 1.7, sepia: 0.1 } },
  { key: 'slumber',   label: 'Slumber',   layers: [
    { color: 'rgba(125,105,24,0.2)', blend: 'overlay' },
  ], adjust: { saturate: 0.66, brightness: 1.05 } },
  { key: 'aden',      label: 'Aden',      layers: [
    { color: 'rgba(66,10,14,0.12)', blend: 'soft-light' },
    { color: 'rgba(230,193,165,0.1)', blend: 'overlay' },
  ], adjust: { hueRotate: -20, contrast: 0.9, saturate: 0.85, brightness: 1.2 } },
  { key: 'valencia',  label: 'Valencia',  layers: [
    { color: 'rgba(58,3,3,0.12)', blend: 'overlay' },
  ], adjust: { contrast: 1.08, brightness: 1.08, sepia: 0.08 } },
  { key: 'nashville', label: 'Nashville', layers: [
    { color: 'rgba(247,176,59,0.18)', blend: 'overlay' },
    { color: 'rgba(0,70,150,0.08)', blend: 'multiply' },
  ], adjust: { contrast: 1.2, brightness: 1.05, saturate: 1.2, sepia: 0.15 } },
  { key: 'perpetua',  label: 'Perpetua',  layers: [
    { color: 'rgba(0,91,154,0.12)', blend: 'soft-light' },
    { color: 'rgba(230,193,61,0.08)', blend: 'overlay' },
  ], adjust: { saturate: 1.25, brightness: 1.05 } },
  { key: 'toaster',   label: 'Toaster',   layers: [
    { color: 'rgba(128,78,15,0.2)', blend: 'overlay' },
  ], adjust: { contrast: 1.5, brightness: 0.9, saturate: 1.3 } },
  { key: 'walden',    label: 'Walden',    layers: [
    { color: 'rgba(0,68,204,0.12)', blend: 'soft-light' },
    { color: 'rgba(204,204,0,0.06)', blend: 'overlay' },
  ], adjust: { brightness: 1.1, saturate: 1.6, hueRotate: 10 } },
  { key: 'hudson',    label: 'Hudson',    layers: [
    { color: 'rgba(166,177,255,0.18)', blend: 'overlay' },
  ], adjust: { brightness: 1.2, contrast: 0.9, saturate: 1.1 } },
  { key: 'xpro2',     label: 'X-Pro II',  layers: [
    { color: 'rgba(230,97,0,0.15)', blend: 'overlay' },
    { color: 'rgba(0,0,80,0.12)', blend: 'multiply' },
  ], adjust: { contrast: 1.3, saturate: 1.4, sepia: 0.1 } },
  { key: 'rise',      label: 'Rise',      layers: [
    { color: 'rgba(236,205,169,0.15)', blend: 'overlay' },
    { color: 'rgba(50,30,7,0.08)', blend: 'multiply' },
  ], adjust: { brightness: 1.05, contrast: 0.9, saturate: 0.9, sepia: 0.05 } },
  { key: 'sierra',    label: 'Sierra',    layers: [
    { color: 'rgba(128,78,15,0.15)', blend: 'overlay' },
  ], adjust: { contrast: 0.85, saturate: 0.75, brightness: 1.15 } },
  { key: 'inkwell',   label: 'Inkwell',   layers: [
    { color: 'rgba(0,0,0,0.08)', blend: 'multiply' },
  ], adjust: { grayscale: 1, contrast: 1.25, brightness: 1.05 } },
  { key: 'lofi',      label: 'Lo-Fi',     layers: [
    { color: 'rgba(34,34,34,0.1)', blend: 'multiply' },
  ], adjust: { contrast: 1.5, saturate: 1.1, brightness: 1.0 } },
  { key: 'earlybird', label: 'Earlybird', layers: [
    { color: 'rgba(208,186,142,0.2)', blend: 'overlay' },
    { color: 'rgba(100,50,10,0.1)', blend: 'multiply' },
  ], adjust: { contrast: 0.9, sepia: 0.25, saturate: 1.3, brightness: 1.05 } },
];

// ─── Filter overlay component (native) ───
export function FilterOverlay({ filter, style }) {
  if (!filter?.layers?.length) return null;
  return filter.layers.map((layer, i) => (
    <View
      key={i}
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, style, { backgroundColor: layer.color }]}
    />
  ));
}
