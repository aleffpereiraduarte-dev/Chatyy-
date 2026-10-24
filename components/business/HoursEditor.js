// [conta-empresarial 2026-10-24] Editor de horário semanal (perfil comercial e "Bia responde por mim").
// Um intervalo por dia (aberto/fechado + abre/fecha HH:MM). Sem modal: tudo inline no cartão.
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { SettingsGroup, SettingsSwitchRow, SettingsCardContent, useGroupedColors, useSettingsInputStyle } from '../settings/SettingsKit';
import { BIZ_DAYS, normalizeHours, fixTime, TIME_RE } from '../../services/business';

export function dayLabel(t, d) {
  const fb = { mon: 'Segunda', tue: 'Terça', wed: 'Quarta', thu: 'Quinta', fri: 'Sexta', sat: 'Sábado', sun: 'Domingo' }[d];
  return t(`biz.day.${d}`, fb);
}

export function hoursValid(h) {
  const n = normalizeHours(h);
  return BIZ_DAYS.every((d) => n.days[d].every((iv) => TIME_RE.test(iv[0]) && TIME_RE.test(iv[1]) && iv[0] !== iv[1]));
}

export default function HoursEditor({ value, onChange, t, header, footer }) {
  const g = useGroupedColors();
  const input = useSettingsInputStyle();
  const h = normalizeHours(value);
  const setDay = (d, iv) => onChange({ ...h, days: { ...h.days, [d]: iv } });
  return (
    <SettingsGroup header={header} footer={footer}>
      {BIZ_DAYS.map((d) => {
        const iv = h.days[d][0] || null;
        return (
          <View key={d}>
            <SettingsSwitchRow
              title={dayLabel(t, d)}
              subtitle={iv ? `${iv[0]} – ${iv[1]}` : t('biz.hours.closed', 'Fechado')}
              value={!!iv}
              onValueChange={(on) => setDay(d, on ? [['09:00', '18:00']] : [])}
            />
            {iv ? (
              <SettingsCardContent style={s.row}>
                <Text style={[s.lbl, { color: g.secondary }]}>{t('biz.hours.opens', 'Abre')}</Text>
                <TextInput
                  style={[input, s.time]} value={iv[0]} keyboardType="numbers-and-punctuation" maxLength={5}
                  accessibilityLabel={`${dayLabel(t, d)} ${t('biz.hours.opens', 'Abre')}`}
                  onChangeText={(v) => setDay(d, [[v, iv[1]]])} onEndEditing={() => setDay(d, [[fixTime(iv[0]), iv[1]]])}
                />
                <Text style={[s.lbl, { color: g.secondary }]}>{t('biz.hours.closes', 'Fecha')}</Text>
                <TextInput
                  style={[input, s.time]} value={iv[1]} keyboardType="numbers-and-punctuation" maxLength={5}
                  accessibilityLabel={`${dayLabel(t, d)} ${t('biz.hours.closes', 'Fecha')}`}
                  onChangeText={(v) => setDay(d, [[iv[0], v]])} onEndEditing={() => setDay(d, [[iv[0], fixTime(iv[1])]])}
                />
              </SettingsCardContent>
            ) : null}
          </View>
        );
      })}
    </SettingsGroup>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 0 },
  lbl: { fontSize: 14 },
  time: { flex: 1, textAlign: 'center' },
});
