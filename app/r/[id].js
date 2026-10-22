// [guest-reels 2026-10-22] /r/<id> — link público de um reel (abre sem login; OG no servidor:
// api/reels-share-page.php). Com conta: o mesmo reel no viewer normal.
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import GuestReelsScreen from '../../components/reels/GuestReelsScreen';

export default function ReelLinkRoute() {
  const { id } = useLocalSearchParams();
  const raw = Array.isArray(id) ? id[0] : id;
  const n = /^\d{1,12}$/.test(String(raw || '')) ? String(raw) : null;
  return <GuestReelsScreen startId={n} />;
}
