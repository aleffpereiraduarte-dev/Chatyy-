// Photo drawing tool — SVG-based overlay for annotating photos before sending
import { useState, useRef } from 'react';
import { View, Text, TouchableOpacity, PanResponder, Platform, Image } from 'react-native';
import Svg, { Path } from 'react-native-svg';

const COLORS = ['#FFFFFF', '#000000', '#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6', '#EC4899'];
const STROKE_WIDTHS = [3, 6, 10];

export default function PhotoDrawTool({ imageUri, width, height, onDone, onCancel, t }) {
  const [paths, setPaths] = useState([]); // Array of { d, color, width }
  const [currentPath, setCurrentPath] = useState('');
  const [color, setColor] = useState('#EF4444');
  const [strokeWidth, setStrokeWidth] = useState(6);
  const currentPathRef = useRef('');

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (evt) => {
      const { locationX, locationY } = evt.nativeEvent;
      currentPathRef.current = `M${locationX.toFixed(1)},${locationY.toFixed(1)}`;
      setCurrentPath(currentPathRef.current);
    },
    onPanResponderMove: (evt) => {
      const { locationX, locationY } = evt.nativeEvent;
      currentPathRef.current += ` L${locationX.toFixed(1)},${locationY.toFixed(1)}`;
      setCurrentPath(currentPathRef.current);
    },
    onPanResponderRelease: () => {
      if (currentPathRef.current) {
        setPaths(prev => [...prev, { d: currentPathRef.current, color, width: strokeWidth }]);
      }
      currentPathRef.current = '';
      setCurrentPath('');
    },
  })).current;

  const handleUndo = () => setPaths(prev => prev.slice(0, -1));
  const handleClear = () => { setPaths([]); setCurrentPath(''); };

  const handleDone = () => {
    // Return the SVG paths data — caller flattens into image if needed
    onDone?.({ paths, color, strokeWidth });
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {/* Canvas area */}
      <View style={{ flex: 1, position: 'relative' }}>
        <CachedImage source={{ uri: imageUri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
        <View
          {...pan.panHandlers}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        >
          <Svg width="100%" height="100%">
            {paths.map((p, i) => (
              <Path key={i} d={p.d} stroke={p.color} strokeWidth={p.width} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            ))}
            {currentPath ? (
              <Path d={currentPath} stroke={color} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            ) : null}
          </Svg>
        </View>
      </View>

      {/* Tools bar */}
      <View style={{ backgroundColor: 'rgba(0,0,0,0.9)', padding: 12, gap: 10 }}>
        {/* Colors */}
        <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'center' }}>
          {COLORS.map(c => (
            <TouchableOpacity key={c} onPress={() => setColor(c)}
              style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: c, borderWidth: color === c ? 3 : 1, borderColor: color === c ? '#fff' : 'rgba(255,255,255,0.3)' }}
            />
          ))}
        </View>
        {/* Stroke widths */}
        <View style={{ flexDirection: 'row', gap: 14, justifyContent: 'center', alignItems: 'center' }}>
          {STROKE_WIDTHS.map(w => (
            <TouchableOpacity key={w} onPress={() => setStrokeWidth(w)}
              style={{ alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 18, backgroundColor: strokeWidth === w ? 'rgba(124,58,237,0.3)' : 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' }}
            >
              <View style={{ width: w, height: w, borderRadius: w / 2, backgroundColor: color }} />
            </TouchableOpacity>
          ))}
        </View>
        {/* Actions */}
        <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'space-between', marginTop: 6 }}>
          <TouchableOpacity onPress={onCancel} style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '600' }}>{t?.('common.cancel') || 'Cancelar'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleUndo} disabled={paths.length === 0} style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', opacity: paths.length === 0 ? 0.4 : 1 }}>
            <Text style={{ color: '#fff', fontWeight: '600' }}>{t?.('common.undo') || 'Desfazer'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleClear} disabled={paths.length === 0} style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', opacity: paths.length === 0 ? 0.4 : 1 }}>
            <Text style={{ color: '#fff', fontWeight: '600' }}>{t?.('common.clear') || 'Limpar'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleDone} style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: '#7C3AED', alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>{t?.('common.done') || 'Pronto'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}
