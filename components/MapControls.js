// MapControls — [2026-10-07 native-maps] small shared RN controls drawn on top
// of the native ChatyyMapView: floating round button, "locate me" glyph (SVG,
// no emoji), and an OSM/Nominatim place-search bar with a results dropdown.
// Used by LocationPickerSheet, LocationViewerModal and snap-map (native path).

import React from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Keyboard } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { IconSearch, IconX, IconMapPin } from './Icons';
import { searchPlaces } from './NativeMap';

export function IconLocate({ size = 20, color = '#111' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="7" stroke={color} strokeWidth="2" />
      <Circle cx="12" cy="12" r="2.6" fill={color} />
      <Path d="M12 1.8v3.2M12 19v3.2M1.8 12h3.2M19 12h3.2" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function MapFab({ onPress, isDark, children, size = 48, style, accessibilityLabel, disabled }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={[{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: isDark ? 'rgba(20,21,26,0.9)' : 'rgba(255,255,255,0.96)',
        alignItems: 'center', justifyContent: 'center',
        shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
        elevation: 6,
        borderWidth: 1, borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)',
        opacity: disabled ? 0.5 : 1,
      }, style]}
    >
      {children}
    </TouchableOpacity>
  );
}

/**
 * Place search bar (debounced Nominatim). onSelect(place) gets
 * { id, latitude, longitude, title, subtitle, displayName }.
 */
export function MapSearchBar({ isDark, colors, placeholder, onSelect, onClear, style, t }) {
  const [q, setQ] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [results, setResults] = React.useState(null); // null = closed
  const timerRef = React.useRef(null);
  const abortRef = React.useRef(null);
  const seqRef = React.useRef(0);

  const run = React.useCallback((text) => {
    const seq = ++seqRef.current;
    try { abortRef.current?.abort?.(); } catch {}
    if (String(text || '').trim().length < 3) { setResults(null); setBusy(false); return; }
    let ctrl = null;
    try { ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null; } catch { ctrl = null; }
    abortRef.current = ctrl;
    setBusy(true);
    searchPlaces(text, { signal: ctrl?.signal })
      .then((list) => { if (seq === seqRef.current) setResults(list); })
      .catch(() => { if (seq === seqRef.current) setResults([]); })
      .finally(() => { if (seq === seqRef.current) setBusy(false); });
  }, []);

  React.useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    try { abortRef.current?.abort?.(); } catch {}
  }, []);

  const onChange = (text) => {
    setQ(text);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => run(text), 420);
  };

  const clear = () => {
    setQ('');
    setResults(null);
    seqRef.current++;
    try { abortRef.current?.abort?.(); } catch {}
    onClear?.();
  };

  const fg = colors?.text || (isDark ? '#fff' : '#111');
  const sub = colors?.textSecondary || (isDark ? 'rgba(255,255,255,0.6)' : '#6b7280');
  const bg = isDark ? 'rgba(20,21,26,0.94)' : 'rgba(255,255,255,0.97)';

  return (
    <View style={style} pointerEvents="box-none">
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: 8,
        backgroundColor: bg, borderRadius: 14, paddingHorizontal: 12, height: 44,
        shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 5,
        borderWidth: 1, borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
      }}>
        <IconSearch size={17} color={sub} />
        <TextInput
          value={q}
          onChangeText={onChange}
          onSubmitEditing={() => { if (timerRef.current) clearTimeout(timerRef.current); run(q); }}
          placeholder={placeholder || (t?.('maps.searchPlaceholder') || 'Buscar endereço ou lugar')}
          placeholderTextColor={sub}
          returnKeyType="search"
          autoCorrect={false}
          style={{ flex: 1, color: fg, fontSize: 15, paddingVertical: 0 }}
        />
        {busy ? <ActivityIndicator size="small" color={sub} /> : null}
        {q ? (
          <TouchableOpacity onPress={clear} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityLabel={t?.('common.clear') || 'Limpar'}>
            <IconX size={16} color={sub} />
          </TouchableOpacity>
        ) : null}
      </View>
      {results ? (
        <View style={{
          marginTop: 6, backgroundColor: bg, borderRadius: 14, overflow: 'hidden',
          borderWidth: 1, borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
          shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 5,
        }}>
          {results.length === 0 ? (
            <Text style={{ color: sub, fontSize: 13, padding: 12 }}>
              {t?.('maps.noResults') || 'Nenhum resultado'}
            </Text>
          ) : results.map((p, i) => (
            <TouchableOpacity
              key={p.id}
              onPress={() => {
                Keyboard.dismiss();
                setResults(null);
                setQ(p.title || p.displayName);
                onSelect?.(p);
              }}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10,
                borderTopWidth: i ? 1 : 0, borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
              }}
            >
              <IconMapPin size={16} color="#7C3AED" />
              <View style={{ flex: 1 }}>
                <Text style={{ color: fg, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>{p.title}</Text>
                {p.subtitle ? <Text style={{ color: sub, fontSize: 12 }} numberOfLines={1}>{p.subtitle}</Text> : null}
              </View>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
    </View>
  );
}
