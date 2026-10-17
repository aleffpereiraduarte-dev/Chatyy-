// components/ui/inputStyle.js — campo de UMA linha com texto CENTRADO (2026-10-17).
// ─────────────────────────────────────────────────────────────────────────────
// Prints iOS do founder (encaminhar, bloquear chat, busca na conversa, nova
// conversa): placeholder/texto "colado embaixo" ou cortado pela metade. Os 4
// campos tinham o mesmo desenho: o PRÓPRIO <TextInput> sem altura explícita
// (altura intrínseca = medida do placeholder) e/ou com paddingVertical/borda no
// TextInput. No iOS (UITextField sob Fabric) o texto não é recentrado nesse caso
// e desce ~8pt. O único campo do mesmo aparelho que saía certo (busca da folha
// Apps) usa: altura FIXA no TextInput + paddingVertical 0 + fundo/borda num
// <View> em volta. Este helper padroniza essa geometria p/ campos de 1 linha.
//
//   <View style={[fieldBoxStyle(s, 44), …]}><TextInput style={singleLineInputStyle(44, 16)} …/></View>
//
// NÃO usar em multiline (compositor, notas) — lá o texto ancora no topo.
import { Platform } from 'react-native';

export function singleLineInputStyle(height = 44, fontSize = 16) {
  return {
    height,
    minHeight: height,
    fontSize,
    paddingTop: 0,
    paddingBottom: 0,
    paddingVertical: 0,
    borderWidth: 0,
    // iOS: sem lineHeight (lineHeight em campo de 1 linha joga o texto p/ baixo).
    ...(Platform.OS === 'android' ? { textAlignVertical: 'center', includeFontPadding: false } : null),
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
  };
}

// Caixa do campo (fundo/borda/raio ficam AQUI, não no TextInput).
export function fieldBoxStyle({ fill, border } = {}, height = 44, radius = 10) {
  return {
    height,
    borderRadius: radius,
    backgroundColor: fill,
    ...(border ? { borderWidth: 1, borderColor: border } : null),
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    ...(Platform.OS === 'ios' ? { borderCurve: 'continuous' } : null),
  };
}
