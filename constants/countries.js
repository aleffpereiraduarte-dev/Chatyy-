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
  { code: 'GH', dial: '+233', flag: '\u{1F1EC}\u{1F1ED}', name: 'Ghana', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'CI', dial: '+225', flag: '\u{1F1E8}\u{1F1EE}', name: 'Cote d\'Ivoire', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'SN', dial: '+221', flag: '\u{1F1F8}\u{1F1F3}', name: 'Senegal', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'CM', dial: '+237', flag: '\u{1F1E8}\u{1F1F2}', name: 'Cameroon', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'KE', dial: '+254', flag: '\u{1F1F0}\u{1F1EA}', name: 'Kenya', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'TZ', dial: '+255', flag: '\u{1F1F9}\u{1F1FF}', name: 'Tanzania', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'UG', dial: '+256', flag: '\u{1F1FA}\u{1F1EC}', name: 'Uganda', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'ET', dial: '+251', flag: '\u{1F1EA}\u{1F1F9}', name: 'Ethiopia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'DZ', dial: '+213', flag: '\u{1F1E9}\u{1F1FF}', name: 'Algeria', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'TN', dial: '+216', flag: '\u{1F1F9}\u{1F1F3}', name: 'Tunisia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'MA', dial: '+212', flag: '\u{1F1F2}\u{1F1E6}', name: 'Morocco', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'LY', dial: '+218', flag: '\u{1F1F1}\u{1F1FE}', name: 'Libya', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'SD', dial: '+249', flag: '\u{1F1F8}\u{1F1E9}', name: 'Sudan', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'ZW', dial: '+263', flag: '\u{1F1FF}\u{1F1FC}', name: 'Zimbabwe', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'ZM', dial: '+260', flag: '\u{1F1FF}\u{1F1F2}', name: 'Zambia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'BW', dial: '+267', flag: '\u{1F1E7}\u{1F1FC}', name: 'Botswana', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'NA', dial: '+264', flag: '\u{1F1F3}\u{1F1E6}', name: 'Namibia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'MW', dial: '+265', flag: '\u{1F1F2}\u{1F1FC}', name: 'Malawi', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'RW', dial: '+250', flag: '\u{1F1F7}\u{1F1FC}', name: 'Rwanda', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'CD', dial: '+243', flag: '\u{1F1E8}\u{1F1E9}', name: 'DR Congo', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'CG', dial: '+242', flag: '\u{1F1E8}\u{1F1EC}', name: 'Congo', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'GA', dial: '+241', flag: '\u{1F1EC}\u{1F1E6}', name: 'Gabon', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'ML', dial: '+223', flag: '\u{1F1F2}\u{1F1F1}', name: 'Mali', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'BF', dial: '+226', flag: '\u{1F1E7}\u{1F1EB}', name: 'Burkina Faso', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'NE', dial: '+227', flag: '\u{1F1F3}\u{1F1EA}', name: 'Niger', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'TG', dial: '+228', flag: '\u{1F1F9}\u{1F1EC}', name: 'Togo', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'BJ', dial: '+229', flag: '\u{1F1E7}\u{1F1EF}', name: 'Benin', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'GN', dial: '+224', flag: '\u{1F1EC}\u{1F1F3}', name: 'Guinea', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'SL', dial: '+232', flag: '\u{1F1F8}\u{1F1F1}', name: 'Sierra Leone', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'LR', dial: '+231', flag: '\u{1F1F1}\u{1F1F7}', name: 'Liberia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'GM', dial: '+220', flag: '\u{1F1EC}\u{1F1F2}', name: 'Gambia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'MR', dial: '+222', flag: '\u{1F1F2}\u{1F1F7}', name: 'Mauritania', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'MG', dial: '+261', flag: '\u{1F1F2}\u{1F1EC}', name: 'Madagascar', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'MU', dial: '+230', flag: '\u{1F1F2}\u{1F1FA}', name: 'Mauritius', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'ST', dial: '+239', flag: '\u{1F1F8}\u{1F1F9}', name: 'Sao Tome and Principe', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'SO', dial: '+252', flag: '\u{1F1F8}\u{1F1F4}', name: 'Somalia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'SS', dial: '+211', flag: '\u{1F1F8}\u{1F1F8}', name: 'South Sudan', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'SA', dial: '+966', flag: '\u{1F1F8}\u{1F1E6}', name: 'Saudi Arabia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'QA', dial: '+974', flag: '\u{1F1F6}\u{1F1E6}', name: 'Qatar', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'KW', dial: '+965', flag: '\u{1F1F0}\u{1F1FC}', name: 'Kuwait', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'BH', dial: '+973', flag: '\u{1F1E7}\u{1F1ED}', name: 'Bahrain', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'OM', dial: '+968', flag: '\u{1F1F4}\u{1F1F2}', name: 'Oman', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'JO', dial: '+962', flag: '\u{1F1EF}\u{1F1F4}', name: 'Jordan', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'LB', dial: '+961', flag: '\u{1F1F1}\u{1F1E7}', name: 'Lebanon', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'IQ', dial: '+964', flag: '\u{1F1EE}\u{1F1F6}', name: 'Iraq', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'IR', dial: '+98', flag: '\u{1F1EE}\u{1F1F7}', name: 'Iran', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'SY', dial: '+963', flag: '\u{1F1F8}\u{1F1FE}', name: 'Syria', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'YE', dial: '+967', flag: '\u{1F1FE}\u{1F1EA}', name: 'Yemen', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'PS', dial: '+970', flag: '\u{1F1F5}\u{1F1F8}', name: 'Palestine', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'PK', dial: '+92', flag: '\u{1F1F5}\u{1F1F0}', name: 'Pakistan', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'BD', dial: '+880', flag: '\u{1F1E7}\u{1F1E9}', name: 'Bangladesh', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'LK', dial: '+94', flag: '\u{1F1F1}\u{1F1F0}', name: 'Sri Lanka', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'NP', dial: '+977', flag: '\u{1F1F3}\u{1F1F5}', name: 'Nepal', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'AF', dial: '+93', flag: '\u{1F1E6}\u{1F1EB}', name: 'Afghanistan', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'KZ', dial: '+7', flag: '\u{1F1F0}\u{1F1FF}', name: 'Kazakhstan', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'UZ', dial: '+998', flag: '\u{1F1FA}\u{1F1FF}', name: 'Uzbekistan', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'AZ', dial: '+994', flag: '\u{1F1E6}\u{1F1FF}', name: 'Azerbaijan', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'GE', dial: '+995', flag: '\u{1F1EC}\u{1F1EA}', name: 'Georgia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'AM', dial: '+374', flag: '\u{1F1E6}\u{1F1F2}', name: 'Armenia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'UA', dial: '+380', flag: '\u{1F1FA}\u{1F1E6}', name: 'Ukraine', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'BY', dial: '+375', flag: '\u{1F1E7}\u{1F1FE}', name: 'Belarus', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'MD', dial: '+373', flag: '\u{1F1F2}\u{1F1E9}', name: 'Moldova', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'RO', dial: '+40', flag: '\u{1F1F7}\u{1F1F4}', name: 'Romania', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'BG', dial: '+359', flag: '\u{1F1E7}\u{1F1EC}', name: 'Bulgaria', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'GR', dial: '+30', flag: '\u{1F1EC}\u{1F1F7}', name: 'Greece', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'HU', dial: '+36', flag: '\u{1F1ED}\u{1F1FA}', name: 'Hungary', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'CZ', dial: '+420', flag: '\u{1F1E8}\u{1F1FF}', name: 'Czechia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'SK', dial: '+421', flag: '\u{1F1F8}\u{1F1F0}', name: 'Slovakia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'HR', dial: '+385', flag: '\u{1F1ED}\u{1F1F7}', name: 'Croatia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'RS', dial: '+381', flag: '\u{1F1F7}\u{1F1F8}', name: 'Serbia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'BA', dial: '+387', flag: '\u{1F1E7}\u{1F1E6}', name: 'Bosnia and Herzegovina', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'SI', dial: '+386', flag: '\u{1F1F8}\u{1F1EE}', name: 'Slovenia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'AL', dial: '+355', flag: '\u{1F1E6}\u{1F1F1}', name: 'Albania', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'MK', dial: '+389', flag: '\u{1F1F2}\u{1F1F0}', name: 'North Macedonia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'ME', dial: '+382', flag: '\u{1F1F2}\u{1F1EA}', name: 'Montenegro', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'LT', dial: '+370', flag: '\u{1F1F1}\u{1F1F9}', name: 'Lithuania', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'LV', dial: '+371', flag: '\u{1F1F1}\u{1F1FB}', name: 'Latvia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'EE', dial: '+372', flag: '\u{1F1EA}\u{1F1EA}', name: 'Estonia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'IS', dial: '+354', flag: '\u{1F1EE}\u{1F1F8}', name: 'Iceland', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'LU', dial: '+352', flag: '\u{1F1F1}\u{1F1FA}', name: 'Luxembourg', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'MT', dial: '+356', flag: '\u{1F1F2}\u{1F1F9}', name: 'Malta', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'CY', dial: '+357', flag: '\u{1F1E8}\u{1F1FE}', name: 'Cyprus', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'VN', dial: '+84', flag: '\u{1F1FB}\u{1F1F3}', name: 'Vietnam', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'KH', dial: '+855', flag: '\u{1F1F0}\u{1F1ED}', name: 'Cambodia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'LA', dial: '+856', flag: '\u{1F1F1}\u{1F1E6}', name: 'Laos', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'MM', dial: '+95', flag: '\u{1F1F2}\u{1F1F2}', name: 'Myanmar', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'HK', dial: '+852', flag: '\u{1F1ED}\u{1F1F0}', name: 'Hong Kong', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'MO', dial: '+853', flag: '\u{1F1F2}\u{1F1F4}', name: 'Macao', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'TW', dial: '+886', flag: '\u{1F1F9}\u{1F1FC}', name: 'Taiwan', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'MN', dial: '+976', flag: '\u{1F1F2}\u{1F1F3}', name: 'Mongolia', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'DO', dial: '+1809', flag: '\u{1F1E9}\u{1F1F4}', name: 'Dominican Republic', mask: '### ####', maxDigits: 7 },
  { code: 'CU', dial: '+53', flag: '\u{1F1E8}\u{1F1FA}', name: 'Cuba', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'GT', dial: '+502', flag: '\u{1F1EC}\u{1F1F9}', name: 'Guatemala', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'SV', dial: '+503', flag: '\u{1F1F8}\u{1F1FB}', name: 'El Salvador', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'HN', dial: '+504', flag: '\u{1F1ED}\u{1F1F3}', name: 'Honduras', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'NI', dial: '+505', flag: '\u{1F1F3}\u{1F1EE}', name: 'Nicaragua', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'CR', dial: '+506', flag: '\u{1F1E8}\u{1F1F7}', name: 'Costa Rica', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'PA', dial: '+507', flag: '\u{1F1F5}\u{1F1E6}', name: 'Panama', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'HT', dial: '+509', flag: '\u{1F1ED}\u{1F1F9}', name: 'Haiti', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'JM', dial: '+1876', flag: '\u{1F1EF}\u{1F1F2}', name: 'Jamaica', mask: '### ####', maxDigits: 7 },
  { code: 'TT', dial: '+1868', flag: '\u{1F1F9}\u{1F1F9}', name: 'Trinidad and Tobago', mask: '### ####', maxDigits: 7 },
  { code: 'PR', dial: '+1787', flag: '\u{1F1F5}\u{1F1F7}', name: 'Puerto Rico', mask: '### ####', maxDigits: 7 },
  { code: 'GY', dial: '+592', flag: '\u{1F1EC}\u{1F1FE}', name: 'Guyana', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'SR', dial: '+597', flag: '\u{1F1F8}\u{1F1F7}', name: 'Suriname', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'FJ', dial: '+679', flag: '\u{1F1EB}\u{1F1EF}', name: 'Fiji', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'PG', dial: '+675', flag: '\u{1F1F5}\u{1F1EC}', name: 'Papua New Guinea', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'MV', dial: '+960', flag: '\u{1F1F2}\u{1F1FB}', name: 'Maldives', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'BT', dial: '+975', flag: '\u{1F1E7}\u{1F1F9}', name: 'Bhutan', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'BN', dial: '+673', flag: '\u{1F1E7}\u{1F1F3}', name: 'Brunei', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'AD', dial: '+376', flag: '\u{1F1E6}\u{1F1E9}', name: 'Andorra', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'MC', dial: '+377', flag: '\u{1F1F2}\u{1F1E8}', name: 'Monaco', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'SM', dial: '+378', flag: '\u{1F1F8}\u{1F1F2}', name: 'San Marino', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'LI', dial: '+423', flag: '\u{1F1F1}\u{1F1EE}', name: 'Liechtenstein', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'XK', dial: '+383', flag: '\u{1F1FD}\u{1F1F0}', name: 'Kosovo', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'GQ', dial: '+240', flag: '\u{1F1EC}\u{1F1F6}', name: 'Equatorial Guinea', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'CF', dial: '+236', flag: '\u{1F1E8}\u{1F1EB}', name: 'Central African Republic', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'TD', dial: '+235', flag: '\u{1F1F9}\u{1F1E9}', name: 'Chad', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'BI', dial: '+257', flag: '\u{1F1E7}\u{1F1EE}', name: 'Burundi', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'DJ', dial: '+253', flag: '\u{1F1E9}\u{1F1EF}', name: 'Djibouti', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'ER', dial: '+291', flag: '\u{1F1EA}\u{1F1F7}', name: 'Eritrea', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'KM', dial: '+269', flag: '\u{1F1F0}\u{1F1F2}', name: 'Comoros', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'SC', dial: '+248', flag: '\u{1F1F8}\u{1F1E8}', name: 'Seychelles', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'LS', dial: '+266', flag: '\u{1F1F1}\u{1F1F8}', name: 'Lesotho', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'SZ', dial: '+268', flag: '\u{1F1F8}\u{1F1FF}', name: 'Eswatini', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'KG', dial: '+996', flag: '\u{1F1F0}\u{1F1EC}', name: 'Kyrgyzstan', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'TJ', dial: '+992', flag: '\u{1F1F9}\u{1F1EF}', name: 'Tajikistan', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'TM', dial: '+993', flag: '\u{1F1F9}\u{1F1F2}', name: 'Turkmenistan', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'BS', dial: '+1242', flag: '\u{1F1E7}\u{1F1F8}', name: 'Bahamas', mask: '### ####', maxDigits: 7 },
  { code: 'BB', dial: '+1246', flag: '\u{1F1E7}\u{1F1E7}', name: 'Barbados', mask: '### ####', maxDigits: 7 },
  { code: 'BZ', dial: '+501', flag: '\u{1F1E7}\u{1F1FF}', name: 'Belize', mask: '### ### ### ###', maxDigits: 12 },
  { code: 'MP', dial: '+1670', flag: '\u{1F1F2}\u{1F1F5}', name: 'Northern Mariana', mask: '### ####', maxDigits: 7 },
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

// E.164 builder: dial + national digits, dropping the national trunk "0"
// (UK 07911..., NG 0803...) so we never emit +4407911... Safe for BR/US.
export function toE164(dial, rawDigits) {
  const digits = String(rawDigits || '').replace(/\D/g, '').replace(/^0+/, '');
  return `${dial}${digits}`;
}
export const E164_RE = /^\+[1-9]\d{7,14}$/;

// [2026-10-06 UX2] Localized country name for pickers. COUNTRIES keeps English
// `name` as the canonical/searchable value; this prefers the OS/JS-engine
// translation via Intl.DisplayNames (region) for the active app locale and
// falls back to the English name when the API is missing (Hermes on some
// Android builds) or throws. One DisplayNames instance is cached per locale.
const _displayNamesCache = {};
export function countryDisplayName(c, locale) {
  if (!c) return '';
  const code = typeof c.code === 'string' ? c.code.toUpperCase() : '';
  const loc = String(locale || 'en').replace('_', '-');
  try {
    if (code && typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function') {
      let dn = _displayNamesCache[loc];
      if (dn === undefined) {
        try { dn = new Intl.DisplayNames([loc], { type: 'region' }); } catch { dn = null; }
        _displayNamesCache[loc] = dn;
      }
      if (dn) {
        const n = dn.of(code);
        if (typeof n === 'string' && n && n !== code) return n;
      }
    }
  } catch {}
  return c.name || code || '';
}
