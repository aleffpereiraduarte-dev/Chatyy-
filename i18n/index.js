import ptBR from './pt-BR';
import en from './en';
import es from './es';

export const translations = {
  'pt-BR': ptBR,
  'en': en,
  'es': es,
};

export const LANGUAGES = [
  { code: 'pt-BR', label: 'Portugues', flag: '🇧🇷' },
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'es', label: 'Espanol', flag: '🇪🇸' },
];

export const DEFAULT_LANGUAGE = 'pt-BR';
