// [2026-10-16 wave12-B pastas] Ícone SVG opcional de uma lista de conversas
// (chave de 2 letras gravada no campo `icon`, ver chatFoldersStore).
import React from 'react';
import {
  IconStar, IconHeart, IconBriefcase, IconHome, IconUsers, IconMessageSquare, IconBookmark,
  IconFlame, IconZap, IconGlobe, IconMusic, IconCamera, IconGiftBox, IconBell, IconAward,
  IconShield, IconTag, IconCalendar, IconBuilding, IconFolder,
} from '../Icons';
import { parseFolderIcon } from './chatFoldersStore';

export const FOLDER_ICONS = {
  st: IconStar, hr: IconHeart, wk: IconBriefcase, hm: IconHome, us: IconUsers, ms: IconMessageSquare,
  bk: IconBookmark, fl: IconFlame, zp: IconZap, gl: IconGlobe, mc: IconMusic, ca: IconCamera,
  gf: IconGiftBox, bl: IconBell, aw: IconAward, sh: IconShield, tg: IconTag, cl: IconCalendar,
  bd: IconBuilding, fd: IconFolder,
};

export function FolderIconByKey({ iconKey, size = 14, color }) {
  const C = FOLDER_ICONS[iconKey] || IconFolder;
  return <C size={size} color={color} />;
}

export default function FolderGlyph({ folder, size = 14, color }) {
  const { iconKey } = parseFolderIcon(folder?.icon);
  return <FolderIconByKey iconKey={iconKey} size={size} color={color} />;
}
