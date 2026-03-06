import { useState, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, ScrollView, Modal } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useLanguage } from '../../context/LanguageContext';
import { IconChevronDown, IconSearch } from '../Icons';

const COUNTRIES = [
  { code: 'BR', dial: '+55', flag: '\u{1F1E7}\u{1F1F7}', name: 'Brazil', mask: '(##) #####-####', maxDigits: 11 },
  { code: 'US', dial: '+1', flag: '\u{1F1FA}\u{1F1F8}', name: 'United States', mask: '(###) ###-####', maxDigits: 10 },
  { code: 'PT', dial: '+351', flag: '\u{1F1F5}\u{1F1F9}', name: 'Portugal', mask: '### ### ###', maxDigits: 9 },
  { code: 'AR', dial: '+54', flag: '\u{1F1E6}\u{1F1F7}', name: 'Argentina', mask: '## ####-####', maxDigits: 10 },
  { code: 'CL', dial: '+56', flag: '\u{1F1E8}\u{1F1F1}', name: 'Chile', mask: '# #### ####', maxDigits: 9 },
  { code: 'CO', dial: '+57', flag: '\u{1F1E8}\u{1F1F4}', name: 'Colombia', mask: '### ### ####', maxDigits: 10 },
  { code: 'MX', dial: '+52', flag: '\u{1F1F2}\u{1F1FD}', name: 'Mexico', mask: '## #### ####', maxDigits: 10 },
  { code: 'PE', dial: '+51', flag: '\u{1F1F5}\u{1F1EA}', name: 'Peru', mask: '### ### ###', maxDigits: 9 },
  { code: 'UY', dial: '+598', flag: '\u{1F1FA}\u{1F1FE}', name: 'Uruguay', mask: '## ### ###', maxDigits: 8 },
  { code: 'PY', dial: '+595', flag: '\u{1F1F5}\u{1F1FE}', name: 'Paraguay', mask: '### ### ###', maxDigits: 9 },
  { code: 'BO', dial: '+591', flag: '\u{1F1E7}\u{1F1F4}', name: 'Bolivia', mask: '#### ####', maxDigits: 8 },
  { code: 'EC', dial: '+593', flag: '\u{1F1EA}\u{1F1E8}', name: 'Ecuador', mask: '## ### ####', maxDigits: 9 },
  { code: 'VE', dial: '+58', flag: '\u{1F1FB}\u{1F1EA}', name: 'Venezuela', mask: '### ### ####', maxDigits: 10 },
  { code: 'GB', dial: '+44', flag: '\u{1F1EC}\u{1F1E7}', name: 'United Kingdom', mask: '#### ### ###', maxDigits: 10 },
  { code: 'DE', dial: '+49', flag: '\u{1F1E9}\u{1F1EA}', name: 'Germany', mask: '#### #######', maxDigits: 11 },
  { code: 'FR', dial: '+33', flag: '\u{1F1EB}\u{1F1F7}', name: 'France', mask: '# ## ## ## ##', maxDigits: 9 },
  { code: 'ES', dial: '+34', flag: '\u{1F1EA}\u{1F1F8}', name: 'Spain', mask: '### ### ###', maxDigits: 9 },
  { code: 'IT', dial: '+39', flag: '\u{1F1EE}\u{1F1F9}', name: 'Italy', mask: '### ### ####', maxDigits: 10 },
  { code: 'JP', dial: '+81', flag: '\u{1F1EF}\u{1F1F5}', name: 'Japan', mask: '##-####-####', maxDigits: 10 },
  { code: 'CN', dial: '+86', flag: '\u{1F1E8}\u{1F1F3}', name: 'China', mask: '### #### ####', maxDigits: 11 },
  { code: 'IN', dial: '+91', flag: '\u{1F1EE}\u{1F1F3}', name: 'India', mask: '##### #####', maxDigits: 10 },
  { code: 'AU', dial: '+61', flag: '\u{1F1E6}\u{1F1FA}', name: 'Australia', mask: '### ### ###', maxDigits: 9 },
  { code: 'CA', dial: '+1', flag: '\u{1F1E8}\u{1F1E6}', name: 'Canada', mask: '(###) ###-####', maxDigits: 10 },
  { code: 'KR', dial: '+82', flag: '\u{1F1F0}\u{1F1F7}', name: 'South Korea', mask: '##-####-####', maxDigits: 10 },
  { code: 'ZA', dial: '+27', flag: '\u{1F1FF}\u{1F1E6}', name: 'South Africa', mask: '## ### ####', maxDigits: 9 },
  { code: 'NG', dial: '+234', flag: '\u{1F1F3}\u{1F1EC}', name: 'Nigeria', mask: '### ### ####', maxDigits: 10 },
  { code: 'EG', dial: '+20', flag: '\u{1F1EA}\u{1F1EC}', name: 'Egypt', mask: '### ### ####', maxDigits: 10 },
  { code: 'AE', dial: '+971', flag: '\u{1F1E6}\u{1F1EA}', name: 'UAE', mask: '## ### ####', maxDigits: 9 },
  { code: 'IL', dial: '+972', flag: '\u{1F1EE}\u{1F1F1}', name: 'Israel', mask: '##-###-####', maxDigits: 9 },
  { code: 'TR', dial: '+90', flag: '\u{1F1F9}\u{1F1F7}', name: 'Turkey', mask: '### ### ## ##', maxDigits: 10 },
  { code: 'RU', dial: '+7', flag: '\u{1F1F7}\u{1F1FA}', name: 'Russia', mask: '### ###-##-##', maxDigits: 10 },
  { code: 'PL', dial: '+48', flag: '\u{1F1F5}\u{1F1F1}', name: 'Poland', mask: '### ### ###', maxDigits: 9 },
  { code: 'NL', dial: '+31', flag: '\u{1F1F3}\u{1F1F1}', name: 'Netherlands', mask: '# ########', maxDigits: 9 },
  { code: 'SE', dial: '+46', flag: '\u{1F1F8}\u{1F1EA}', name: 'Sweden', mask: '##-### ## ##', maxDigits: 9 },
  { code: 'CH', dial: '+41', flag: '\u{1F1E8}\u{1F1ED}', name: 'Switzerland', mask: '## ### ## ##', maxDigits: 9 },
  { code: 'NO', dial: '+47', flag: '\u{1F1F3}\u{1F1F4}', name: 'Norway', mask: '### ## ###', maxDigits: 8 },
  { code: 'DK', dial: '+45', flag: '\u{1F1E9}\u{1F1F0}', name: 'Denmark', mask: '## ## ## ##', maxDigits: 8 },
  { code: 'FI', dial: '+358', flag: '\u{1F1EB}\u{1F1EE}', name: 'Finland', mask: '## ### ####', maxDigits: 9 },
  { code: 'AT', dial: '+43', flag: '\u{1F1E6}\u{1F1F9}', name: 'Austria', mask: '### #######', maxDigits: 10 },
  { code: 'BE', dial: '+32', flag: '\u{1F1E7}\u{1F1EA}', name: 'Belgium', mask: '### ## ## ##', maxDigits: 9 },
  { code: 'IE', dial: '+353', flag: '\u{1F1EE}\u{1F1EA}', name: 'Ireland', mask: '## ### ####', maxDigits: 9 },
  { code: 'NZ', dial: '+64', flag: '\u{1F1F3}\u{1F1FF}', name: 'New Zealand', mask: '## ### ####', maxDigits: 9 },
  { code: 'SG', dial: '+65', flag: '\u{1F1F8}\u{1F1EC}', name: 'Singapore', mask: '#### ####', maxDigits: 8 },
  { code: 'TH', dial: '+66', flag: '\u{1F1F9}\u{1F1ED}', name: 'Thailand', mask: '## ### ####', maxDigits: 9 },
  { code: 'PH', dial: '+63', flag: '\u{1F1F5}\u{1F1ED}', name: 'Philippines', mask: '### ### ####', maxDigits: 10 },
  { code: 'MY', dial: '+60', flag: '\u{1F1F2}\u{1F1FE}', name: 'Malaysia', mask: '##-### ####', maxDigits: 9 },
  { code: 'ID', dial: '+62', flag: '\u{1F1EE}\u{1F1E9}', name: 'Indonesia', mask: '###-####-####', maxDigits: 11 },
  { code: 'AO', dial: '+244', flag: '\u{1F1E6}\u{1F1F4}', name: 'Angola', mask: '### ### ###', maxDigits: 9 },
  { code: 'MZ', dial: '+258', flag: '\u{1F1F2}\u{1F1FF}', name: 'Mozambique', mask: '## ### ####', maxDigits: 9 },
  { code: 'CV', dial: '+238', flag: '\u{1F1E8}\u{1F1FB}', name: 'Cabo Verde', mask: '### ## ##', maxDigits: 7 },
  { code: 'GW', dial: '+245', flag: '\u{1F1EC}\u{1F1FC}', name: 'Guinea-Bissau', mask: '### ####', maxDigits: 7 },
  { code: 'TL', dial: '+670', flag: '\u{1F1F9}\u{1F1F1}', name: 'Timor-Leste', mask: '#### ####', maxDigits: 8 },
];

function formatPhone(raw, mask) {
  if (!mask || !raw) return raw;
  let i = 0;
  let result = '';
  for (const char of mask) {
    if (i >= raw.length) break;
    if (char === '#') { result += raw[i]; i++; }
    else { result += char; }
  }
  return result;
}

export default function PhoneInput({ value, onChange, countryCode, onCountryChange, error }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState('');

  const country = COUNTRIES.find(c => c.code === countryCode) || COUNTRIES[0];

  const handleChange = (text) => {
    const raw = text.replace(/\D/g, '').slice(0, country.maxDigits);
    onChange(raw);
  };

  const getCountryName = (c) => t(`country.${c.code}`) || c.name;

  const filtered = search
    ? COUNTRIES.filter(c =>
        getCountryName(c).toLowerCase().includes(search.toLowerCase()) ||
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.dial.includes(search) ||
        c.code.toLowerCase().includes(search.toLowerCase())
      )
    : COUNTRIES;

  const displayValue = value ? formatPhone(value, country.mask) : '';

  const pickerContent = (
    <View style={[s.pickerOverlay, { backgroundColor: 'rgba(0,0,0,0.45)' }]}>
      <View style={[s.pickerCard, { backgroundColor: colors.authCardBg, borderColor: colors.authCardBorder }]}>
        <Text style={[s.pickerTitle, { color: colors.text }]}>{t('signup.stepPhone.selectCountry')}</Text>

        <View style={[s.searchBox, { backgroundColor: colors.authInputBg, borderColor: colors.authInputBorder }]}>
          <IconSearch size={14} color={colors.textTertiary} />
          <TextInput
            style={[s.searchInput, { color: colors.text }]}
            value={search}
            onChangeText={setSearch}
            placeholder={t('signup.stepPhone.searchCountry')}
            placeholderTextColor={colors.textTertiary}
            autoFocus={Platform.OS === 'web'}
          />
        </View>

        <ScrollView style={s.pickerList} keyboardShouldPersistTaps="handled">
          {filtered.map(c => (
            <TouchableOpacity
              key={c.code + c.dial}
              style={[
                s.pickerItem,
                { borderColor: colors.authDividerColor },
                c.code === country.code && { backgroundColor: colors.primary + '0d' },
              ]}
              onPress={() => {
                onCountryChange(c.code);
                onChange('');
                setShowPicker(false);
                setSearch('');
              }}
              activeOpacity={0.6}
            >
              <Text style={s.pickerFlag}>{c.flag}</Text>
              <Text style={[s.pickerName, { color: colors.text }]} numberOfLines={1}>{getCountryName(c)}</Text>
              <Text style={[s.pickerDial, { color: colors.textSecondary }]}>{c.dial}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <TouchableOpacity
          style={[s.pickerClose, { borderColor: colors.authInputBorder }]}
          onPress={() => { setShowPicker(false); setSearch(''); }}
          activeOpacity={0.7}
        >
          <Text style={[s.pickerCloseText, { color: colors.textSecondary }]}>{t('signup.stepPhone.cancel')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <View style={s.container}>
      <View style={s.row}>
        <TouchableOpacity
          style={[s.ddi, { backgroundColor: colors.authInputBg, borderColor: colors.authInputBorder }]}
          onPress={() => setShowPicker(true)}
          activeOpacity={0.7}
        >
          <Text style={s.flag}>{country.flag}</Text>
          <Text style={[s.ddiText, { color: colors.text }]}>{country.dial}</Text>
          <IconChevronDown size={12} color={colors.textTertiary} />
        </TouchableOpacity>
        <TextInput
          style={[
            s.input,
            { color: colors.text, backgroundColor: colors.authInputBg, borderColor: error ? colors.error : colors.authInputBorder },
          ]}
          value={displayValue}
          onChangeText={handleChange}
          placeholder={country.mask.replace(/#/g, '0')}
          placeholderTextColor={colors.textTertiary}
          keyboardType="phone-pad"
          maxLength={country.mask.length + 2}
        />
      </View>
      {!!error && <Text style={[s.error, { color: colors.error }]}>{error}</Text>}

      {showPicker && (
        Platform.OS === 'web' ? (
          <View style={s.webPickerWrapper}>{pickerContent}</View>
        ) : (
          <Modal visible transparent animationType="slide" onRequestClose={() => { setShowPicker(false); setSearch(''); }}>
            {pickerContent}
          </Modal>
        )
      )}
    </View>
  );
}

export { COUNTRIES, formatPhone };

const s = StyleSheet.create({
  container: { marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ddi: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 12, borderRadius: 10, borderWidth: 1,
    ...Platform.select({ web: { cursor: 'pointer', transition: 'all 0.15s ease' }, default: {} }),
  },
  flag: { fontSize: 18 },
  ddiText: { fontSize: 14, fontWeight: '600' },
  input: {
    flex: 1, borderWidth: 1, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 15,
    ...Platform.select({ web: { outlineStyle: 'none', transition: 'all 0.15s ease' }, default: {} }),
  },
  error: { fontSize: 11, marginTop: 5 },

  // Picker
  webPickerWrapper: {
    ...Platform.select({
      web: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999 },
      default: {},
    }),
  },
  pickerOverlay: {
    flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20,
    ...Platform.select({ web: { minHeight: '100vh' }, default: {} }),
  },
  pickerCard: {
    width: '100%', maxWidth: 400, maxHeight: '80%', borderRadius: 16,
    padding: 20, borderWidth: 1,
    ...Platform.select({
      web: { boxShadow: '0 20px 60px rgba(0,0,0,0.15)' },
      default: { shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 24, elevation: 10 },
    }),
  },
  pickerTitle: { fontSize: 17, fontWeight: '700', marginBottom: 14, textAlign: 'center' },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, marginBottom: 10,
  },
  searchInput: {
    flex: 1, fontSize: 14, padding: 0,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  pickerList: { maxHeight: 320 },
  pickerItem: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 11, paddingHorizontal: 10, borderBottomWidth: 0.5,
  },
  pickerFlag: { fontSize: 20 },
  pickerName: { flex: 1, fontSize: 14, fontWeight: '500' },
  pickerDial: { fontSize: 13, fontWeight: '600' },
  pickerClose: {
    marginTop: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, alignItems: 'center',
    ...Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  },
  pickerCloseText: { fontSize: 14, fontWeight: '500' },
});
