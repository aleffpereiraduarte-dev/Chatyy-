// i18n — carregamento de idioma sob demanda (lazy locale loading).
//
// [2026-06-13 PERF] ANTES: os 63 idiomas (~26MB) eram TODOS importados de forma
// estática aqui → iam pro entrypoint web (bundle de 44MB cru / 8MB brotli) →
// o navegador tinha que parsear+executar 26MB de traduções no 1º load, mesmo o
// usuário usando 1 idioma só. Em celular de entrada isso travava 10-30s.
//
// AGORA: só pt-BR/en/es carregam na entrada (cobrem ~99% dos usuários + a cadeia
// de fallback en→pt-BR do t(), então NUNCA vaza chave crua). Os outros 60 viram
// chunks separados via import() dinâmico, baixados só quando o idioma é
// escolhido/detectado. O LanguageContext chama loadLocale() e re-renderiza.
import ptBR from './pt-BR';
import en from './en';
import es from './es';

// Idiomas carregados na entrada (disponíveis sincronamente p/ o t()).
export const translations = {
  'pt-BR': ptBR,
  'en': en,
  'es': es,
};

// Loaders dinâmicos — cada import() vira um chunk próprio no bundle, baixado
// só na primeira vez que o idioma é usado.
const lazyLoaders = {
  'ja': () => import('./ja'),
  'fr': () => import('./fr'),
  'de': () => import('./de'),
  'it': () => import('./it'),
  'zh-CN': () => import('./zh-CN'),
  'ko': () => import('./ko'),
  'ar': () => import('./ar'),
  'ru': () => import('./ru'),
  'hi': () => import('./hi'),
  'pt-PT': () => import('./pt-PT'),
  'tr': () => import('./tr'),
  'nl': () => import('./nl'),
  'pl': () => import('./pl'),
  'sv': () => import('./sv'),
  'nb': () => import('./nb'),
  'da': () => import('./da'),
  'fi': () => import('./fi'),
  'cs': () => import('./cs'),
  'ro': () => import('./ro'),
  'hu': () => import('./hu'),
  'el': () => import('./el'),
  'uk': () => import('./uk'),
  'th': () => import('./th'),
  'vi': () => import('./vi'),
  'id': () => import('./id'),
  'ms': () => import('./ms'),
  'fil': () => import('./fil'),
  'he': () => import('./he'),
  'fa': () => import('./fa'),
  'bn': () => import('./bn'),
  'sw': () => import('./sw'),
  'ur': () => import('./ur'),
  'ta': () => import('./ta'),
  'te': () => import('./te'),
  'mr': () => import('./mr'),
  'gu': () => import('./gu'),
  'kn': () => import('./kn'),
  'ml': () => import('./ml'),
  'pa': () => import('./pa'),
  'my': () => import('./my'),
  'km': () => import('./km'),
  'am': () => import('./am'),
  'ne': () => import('./ne'),
  'si': () => import('./si'),
  'ka': () => import('./ka'),
  'hy': () => import('./hy'),
  'az': () => import('./az'),
  'kk': () => import('./kk'),
  'uz': () => import('./uz'),
  'mn': () => import('./mn'),
  'lo': () => import('./lo'),
  'hr': () => import('./hr'),
  'sk': () => import('./sk'),
  'bg': () => import('./bg'),
  'sr': () => import('./sr'),
  'sl': () => import('./sl'),
  'lt': () => import('./lt'),
  'lv': () => import('./lv'),
  'et': () => import('./et'),
  'ca': () => import('./ca'),
};

// Carrega um idioma sob demanda e injeta em `translations` (idempotente).
// Retorna true quando o idioma fica disponível (já estava ou acabou de carregar),
// false se o código não existe ou o import falhou. NÃO lança.
export async function loadLocale(code) {
  if (!code) return false;
  if (translations[code]) return true;
  const loader = lazyLoaders[code];
  if (!loader) return false;
  try {
    const mod = await loader();
    translations[code] = (mod && mod.default) ? mod.default : mod;
    return true;
  } catch (e) {
    return false;
  }
}

// True se o código é um idioma suportado (mesmo que ainda não carregado).
export function isLocaleSupported(code) {
  return !!code && (!!translations[code] || !!lazyLoaders[code]);
}

export const LANGUAGES = [
  { code: 'pt-BR', label: 'Português (Brasil)', flag: '🇧🇷' },
  { code: 'pt-PT', label: 'Português (Portugal)', flag: '🇵🇹' },
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'it', label: 'Italiano', flag: '🇮🇹' },
  { code: 'ja', label: '日本語', flag: '🇯🇵' },
  { code: 'zh-CN', label: '中文 (简体)', flag: '🇨🇳' },
  { code: 'ko', label: '한국어', flag: '🇰🇷' },
  { code: 'ar', label: 'العربية', flag: '🇸🇦' },
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
  { code: 'hi', label: 'हिन्दी', flag: '🇮🇳' },
  { code: 'tr', label: 'Türkçe', flag: '🇹🇷' },
  { code: 'nl', label: 'Nederlands', flag: '🇳🇱' },
  { code: 'pl', label: 'Polski', flag: '🇵🇱' },
  { code: 'sv', label: 'Svenska', flag: '🇸🇪' },
  { code: 'nb', label: 'Norsk', flag: '🇳🇴' },
  { code: 'da', label: 'Dansk', flag: '🇩🇰' },
  { code: 'fi', label: 'Suomi', flag: '🇫🇮' },
  { code: 'cs', label: 'Čeština', flag: '🇨🇿' },
  { code: 'ro', label: 'Română', flag: '🇷🇴' },
  { code: 'hu', label: 'Magyar', flag: '🇭🇺' },
  { code: 'el', label: 'Ελληνικά', flag: '🇬🇷' },
  { code: 'uk', label: 'Українська', flag: '🇺🇦' },
  { code: 'th', label: 'ไทย', flag: '🇹🇭' },
  { code: 'vi', label: 'Tiếng Việt', flag: '🇻🇳' },
  { code: 'id', label: 'Bahasa Indonesia', flag: '🇮🇩' },
  { code: 'ms', label: 'Bahasa Melayu', flag: '🇲🇾' },
  { code: 'fil', label: 'Filipino', flag: '🇵🇭' },
  { code: 'he', label: 'עברית', flag: '🇮🇱' },
  { code: 'fa', label: 'فارسی', flag: '🇮🇷' },
  { code: 'bn', label: 'বাংলা', flag: '🇧🇩' },
  { code: 'sw', label: 'Kiswahili', flag: '🇰🇪' },
  { code: 'ur', label: 'اردو', flag: '🇵🇰' },
  { code: 'ta', label: 'தமிழ்', flag: '🇮🇳' },
  { code: 'te', label: 'తెలుగు', flag: '🇮🇳' },
  { code: 'mr', label: 'मराठी', flag: '🇮🇳' },
  { code: 'gu', label: 'ગુજરાતી', flag: '🇮🇳' },
  { code: 'kn', label: 'ಕನ್ನಡ', flag: '🇮🇳' },
  { code: 'ml', label: 'മലയാളം', flag: '🇮🇳' },
  { code: 'pa', label: 'ਪੰਜਾਬੀ', flag: '🇮🇳' },
  { code: 'my', label: 'မြန်မာ', flag: '🇲🇲' },
  { code: 'km', label: 'ខ្មែរ', flag: '🇰🇭' },
  { code: 'am', label: 'አማርኛ', flag: '🇪🇹' },
  { code: 'ne', label: 'नेपाली', flag: '🇳🇵' },
  { code: 'si', label: 'සිංහල', flag: '🇱🇰' },
  { code: 'ka', label: 'ქართული', flag: '🇬🇪' },
  { code: 'hy', label: 'Հայերեն', flag: '🇦🇲' },
  { code: 'az', label: 'Azərbaycan', flag: '🇦🇿' },
  { code: 'kk', label: 'Қазақ', flag: '🇰🇿' },
  { code: 'uz', label: "O'zbek", flag: '🇺🇿' },
  { code: 'mn', label: 'Монгол', flag: '🇲🇳' },
  { code: 'lo', label: 'ລາວ', flag: '🇱🇦' },
  { code: 'hr', label: 'Hrvatski', flag: '🇭🇷' },
  { code: 'sk', label: 'Slovenčina', flag: '🇸🇰' },
  { code: 'bg', label: 'Български', flag: '🇧🇬' },
  { code: 'sr', label: 'Srpski', flag: '🇷🇸' },
  { code: 'sl', label: 'Slovenščina', flag: '🇸🇮' },
  { code: 'lt', label: 'Lietuvių', flag: '🇱🇹' },
  { code: 'lv', label: 'Latviešu', flag: '🇱🇻' },
  { code: 'et', label: 'Eesti', flag: '🇪🇪' },
  { code: 'ca', label: 'Català', flag: '🇪🇸' },
];

export const DEFAULT_LANGUAGE = 'pt-BR';
