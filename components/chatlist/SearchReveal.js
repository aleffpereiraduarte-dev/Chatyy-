// components/chatlist/SearchReveal.js — [2026-10-16 motion-nav] WEB/fallback:
// a web mantém o Animated antigo do app/chat.js (searchRevealEnabled = false).
import React from 'react';
import { View } from 'react-native';

export function searchRevealEnabled() { return false; }

export function SearchReveal({ style, children }) { return <View style={style}>{children}</View>; }
