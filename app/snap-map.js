// Snap Map — friends locations on a map (Snapchat-style)
import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Image, ScrollView, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import * as api from '../services/api';
import AvatarCircle from '../components/AvatarCircle';
import { IconArrowLeft, IconMapPin } from '../components/Icons';

const { width: SW, height: SH } = Dimensions.get('window');

export default function SnapMapScreen() {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const { user } = useAuth();
  const router = useRouter();
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [myLocation, setMyLocation] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        // Share own location first
        if (Platform.OS !== 'web') {
          try {
            const Location = require('expo-location');
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status === 'granted') {
              const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
              if (alive) setMyLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
              try { await api.updateLocation?.(pos.coords.latitude, pos.coords.longitude); } catch {}
            }
          } catch {}
        } else if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition((pos) => {
            if (alive) setMyLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
            api.updateLocation?.(pos.coords.latitude, pos.coords.longitude).catch(() => {});
          });
        }

        const r = await api.getFriendsLocations?.();
        if (alive && r?.success && r.data) {
          const list = Array.isArray(r.data) ? r.data : (r.data.locations || []);
          setLocations(list);
        }
      } catch {}
      if (alive) setLoading(false);
    };
    load();
    const interval = setInterval(load, 60000);
    return () => { alive = false; clearInterval(interval); };
  }, []);

  // Compute map center from locations
  const center = myLocation || (locations[0] ? { lat: locations[0].latitude, lng: locations[0].longitude } : { lat: -15.77, lng: -47.92 });
  const mapUrl = `https://maps.geoapify.com/v1/staticmap?style=osm-bright&width=${Math.min(SW * 2, 1200)}&height=${Math.floor(SH * 1.3)}&center=lonlat:${center.lng},${center.lat}&zoom=12&apiKey=0457440ba1db4f5a80840e87a1a2fd60`;

  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#0d0d0d' : '#fff' }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 50 : 14, paddingBottom: 14, backgroundColor: isDark ? '#0d0d0d' : '#fff', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)', zIndex: 10 }}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 8 }}>
          <IconArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={{ flex: 1, fontSize: 18, fontWeight: '700', color: colors.text, marginLeft: 8 }}>
          {t?.('snapmap.title') || 'Mapa de amigos'}
        </Text>
        <Text style={{ fontSize: 13, color: colors.textSecondary }}>
          {locations.length} {t?.('snapmap.friends') || 'amigos'}
        </Text>
      </View>

      {/* Map + friends pins */}
      <View style={{ flex: 1, position: 'relative', backgroundColor: isDark ? '#1a1a1a' : '#e5e7eb' }}>
        <Image source={{ uri: mapUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />

        {/* Overlay with friends dots (simplified — in real app, would project lat/lng to screen coords) */}
        {locations.map((loc, i) => {
          // Simple projection — pins spread roughly across map
          const x = ((loc.longitude - (center.lng - 0.1)) / 0.2) * SW;
          const y = ((center.lat + 0.05 - loc.latitude) / 0.1) * (SH * 0.6) + 100;
          if (x < 0 || x > SW || y < 0 || y > SH - 100) return null;
          return (
            <TouchableOpacity
              key={`${loc.email}-${i}`}
              onPress={() => router.push(`/chat-conversation?email=${encodeURIComponent(loc.email)}`)}
              style={{ position: 'absolute', left: x - 24, top: y - 24 }}
            >
              <View style={{ borderWidth: 3, borderColor: '#7C3AED', borderRadius: 26, padding: 2, backgroundColor: '#fff' }}>
                <AvatarCircle name={loc.name || loc.email} email={loc.email} size={40} />
              </View>
              <View style={{ alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, marginTop: 2 }}>
                <Text style={{ color: '#fff', fontSize: 10, fontWeight: '600' }} numberOfLines={1}>
                  {(loc.name || loc.email?.split('@')[0] || '?').slice(0, 10)}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}

        {/* My location dot */}
        {myLocation && (
          <View style={{ position: 'absolute', left: SW / 2 - 18, top: SH * 0.35, alignItems: 'center' }}>
            <View style={{ borderWidth: 3, borderColor: '#3B82F6', borderRadius: 22, padding: 2, backgroundColor: '#fff',
              ...(Platform.OS === 'web' ? { boxShadow: '0 0 20px rgba(59,130,246,0.5)' } : {}),
            }}>
              <AvatarCircle name={user?.name} email={user?.email} size={32} />
            </View>
            <View style={{ backgroundColor: '#3B82F6', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, marginTop: 2 }}>
              <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{t?.('snapmap.you') || 'Você'}</Text>
            </View>
          </View>
        )}

        {/* Loading */}
        {loading && (
          <View style={{ position: 'absolute', top: 20, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 }}>
            <Text style={{ color: '#fff', fontSize: 13 }}>{t?.('common.loading') || 'Carregando...'}</Text>
          </View>
        )}

        {/* Empty state */}
        {!loading && locations.length === 0 && (
          <View style={{ position: 'absolute', top: SH * 0.3, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.75)', padding: 20, borderRadius: 16, maxWidth: 300 }}>
            <IconMapPin size={32} color="#fff" style={{ alignSelf: 'center' }} />
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700', textAlign: 'center', marginTop: 10 }}>
              {t?.('snapmap.empty') || 'Nenhum amigo no mapa'}
            </Text>
            <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, textAlign: 'center', marginTop: 4 }}>
              {t?.('snapmap.emptyHint') || 'Seus amigos aparecerão aqui quando compartilharem a localização'}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}
