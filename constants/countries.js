// Phone country list — used by login, signup, dialer.
//
// Why this lives here: COUNTRIES + formatPhone used to live inside
// components/signup/PhoneInput.js. Importing a UI component just for a data
// table created a leaky dep (the rest of PhoneInput.js was dead). Lifted to
// constants/ so screens can import the data without dragging UI in.

export const COUNTRIES = [
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

// Apply mask to digit-only `raw`. Used for format-as-you-type.
export function formatPhone(raw, mask) {
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

// Find a country by ISO code, falling back to BR.
export function findCountry(code) {
  return COUNTRIES.find(c => c.code === code) || COUNTRIES[0];
}
