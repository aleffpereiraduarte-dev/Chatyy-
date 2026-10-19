// [call-link 2026-10-19] chatyy.com.br/c/<código> (link curto de chamada) e
// onemundomail://c/<código> → o lobby do link (app/call/[id].js). Universal links
// já passam por app/+native-intent (utils/universalLinks 'c'); esta rota cobre o
// esquema próprio e a SPA web quando o nginx não manda /c/ para a página PHP.
import { useEffect } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

export default function CallLinkShortRedirect() {
  const router = useRouter();
  const { code } = useLocalSearchParams();
  useEffect(() => {
    const c = String(Array.isArray(code) ? code[0] : code || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 80);
    try { router.replace(c ? `/call/${c}` : '/chat'); } catch {}
  }, [code, router]);
  return <View style={{ flex: 1 }} />;
}
