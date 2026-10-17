// components/chatlist/ChipRail.js — [2026-10-16 motion-nav] WEB/fallback.
// O trilho com pílula deslizante é só nativo (ChipRail.native.js, Reanimated);
// na web o ChatListTab mantém os chips de sempre (transição CSS de fundo).
import React from 'react';

export function chipRailEnabled() { return false; }

export function ChipRail({ children }) { return <>{children}</>; }

export function RailChip() { return null; }
