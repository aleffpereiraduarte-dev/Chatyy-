// app/live/[id].js — Smart deep link entry for shared live URLs.
//
// User mandate (2026-05-21): "quanbdo manda o link se a pessoa tem chatyy o
// video comeca a tocar dentrod o app se ela n tem abre web e passa la tambem"
//
// On mobile (iOS/Android): open the native live-viewer screen in-app.
// On web: route into the JS live-viewer (which itself decides between
// HLS / LK pipeline). Previously the URL `chatyy.com.br/live/<id>` hit no
// matching route and showed the generic "Unmatched Route" page — viewers
// who tapped a shared link saw nothing.
//
// The dynamic param is the chat_live_sessions row id (session_id).

import { useEffect } from 'react';
import { View, ActivityIndicator, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

export default function LiveDeepLinkEntry() {
  const { id } = useLocalSearchParams();
  const router = useRouter();

  useEffect(() => {
    if (!id) return;
    // Use replace so the user can navigate "back" out of the viewer to
    // wherever they came from (web tab, app stack) without an intermediate
    // landing screen in their history.
    router.replace({ pathname: '/live-viewer', params: { sessionId: String(id) } });
  }, [id, router]);

  return (
    <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="large" color="#7C3AED" />
    </View>
  );
}
