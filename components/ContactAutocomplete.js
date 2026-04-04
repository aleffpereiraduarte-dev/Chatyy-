import { useState, useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList,
  Platform, ActivityIndicator,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { apiCall } from '../services/api';
import { IconX, IconUser, IconMail, IconSend, IconInbox } from './Icons';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEBOUNCE_MS = 300;

// Auto-correct common domain typos (chatyy.com → chatyy.com.br, onemundo.com → onemundo.com.br)
function fixEmail(email) {
  if (!email) return email;
  const lower = email.toLowerCase().trim();
  if (lower.endsWith('@chatyy.com')) return lower.replace(/@chatyy\.com$/, '@chatyy.com.br');
  if (lower.endsWith('@onemundo.com')) return lower.replace(/@onemundo\.com$/, '@onemundo.com.br');
  if (lower.endsWith('@superbora.com')) return lower.replace(/@superbora\.com$/, '@superbora.com.br');
  return email.trim();
}

function ContactAutocompleteInner({ value = [], onChange, placeholder, label }, ref) {
  const { colors } = useTheme();
  const [inputText, setInputText] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);
  const debounceRef = useRef(null);
  const inputRef = useRef(null);

  // Domain suggestions when user types username without @
  const DOMAINS = ['chatyy.com.br', 'onemundo.com.br', 'superbora.com.br', 'boraum.com.br'];

  // Fetch contacts with debounce
  const fetchContacts = useCallback((query) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query || query.length < 2) {
      setSuggestions([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const selectedEmails = new Set(value.map(c => c.email.toLowerCase()));
        let filtered = [];

        // Check if query looks like a phone number
        const isPhone = /^\+?[0-9\s\-()]{8,}$/.test(query.replace(/\s/g, ''));

        if (isPhone) {
          // Search by phone number → returns email
          try {
            const phoneResult = await apiCall('find_by_phone', { phone: query }, 'POST');
            if (phoneResult.success && Array.isArray(phoneResult.data)) {
              filtered = phoneResult.data
                .filter(c => c.email && !selectedEmails.has(c.email.toLowerCase()))
                .map(c => ({ email: c.email, name: c.display_name || c.email, phone: c.phone }));
            }
          } catch {}
        }

        // Also search by name/email (always)
        const result = await apiCall('contacts', { q: query });
        if (result.success && Array.isArray(result.data)) {
          const emailResults = result.data.filter(
            c => !selectedEmails.has((c.email || '').toLowerCase()) &&
                 !filtered.some(f => f.email.toLowerCase() === (c.email || '').toLowerCase())
          );
          filtered = [...filtered, ...emailResults];
        }

        // Add domain suggestions if user typed text without @
        if (!query.includes('@') && query.length >= 2 && !isPhone) {
          const domainSuggestions = DOMAINS
            .map(d => ({ email: `${query.toLowerCase()}@${d}`, name: '' }))
            .filter(s => !selectedEmails.has(s.email) && !filtered.some(f => f.email.toLowerCase() === s.email));
          filtered = [...filtered, ...domainSuggestions];
        }
        setSuggestions(filtered);
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);
  }, [value]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleChangeText = (text) => {
    setInputText(text);
    fetchContacts(text.trim());
  };

  const addContact = (contact) => {
    const fixed = { ...contact, email: fixEmail(contact.email) };
    const already = value.some(c => c.email.toLowerCase() === fixed.email.toLowerCase());
    if (!already) {
      onChange([...value, fixed]);
    }
    setInputText('');
    setSuggestions([]);
    inputRef.current?.focus();
  };

  const removeContact = (email) => {
    onChange(value.filter(c => c.email.toLowerCase() !== email.toLowerCase()));
  };

  const handleSubmitEditing = () => {
    const trimmed = fixEmail(inputText);
    if (!trimmed) return;

    // If valid email, add directly
    if (EMAIL_REGEX.test(trimmed)) {
      addContact({ email: trimmed, name: '' });
      return;
    }

    // If there is exactly one suggestion, select it
    if (suggestions.length === 1) {
      addContact(suggestions[0]);
      return;
    }
  };

  // Expose flush method so parent can commit pending input before send
  useImperativeHandle(ref, () => ({
    flush: () => {
      const trimmed = fixEmail(inputText);
      if (trimmed && EMAIL_REGEX.test(trimmed)) {
        addContact({ email: trimmed, name: '' });
      }
    },
  }), [inputText, addContact]);

  // Handle comma or semicolon as separator (web typing)
  const handleKeyPress = (e) => {
    const key = e.nativeEvent?.key;

    if (key === 'Backspace' && inputText === '' && value.length > 0) {
      // Remove last chip on backspace when input is empty
      removeContact(value[value.length - 1].email);
      return;
    }

    if (key === ',' || key === ';') {
      e.preventDefault?.();
      const trimmed = fixEmail(inputText);
      if (trimmed && EMAIL_REGEX.test(trimmed)) {
        addContact({ email: trimmed, name: '' });
      }
    }
  };

  const showDropdown = focused && (suggestions.length > 0 || loading);

  const getInitials = (name, email) => {
    if (name) {
      const parts = name.trim().split(/\s+/);
      return parts.length >= 2
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : parts[0].substring(0, 2).toUpperCase();
    }
    return email ? email.substring(0, 2).toUpperCase() : '?';
  };

  const SourceIcon = ({ source }) => {
    if (source === 'contact') return <IconUser size={12} color={colors.primary} />;
    if (source === 'sent') return <IconSend size={12} color={colors.textTertiary} />;
    if (source === 'received') return <IconInbox size={12} color={colors.textTertiary} />;
    return null;
  };

  const renderSuggestion = ({ item }) => (
    <TouchableOpacity
      style={[styles.suggestion, { borderBottomColor: colors.borderLight }]}
      onPress={() => addContact(item)}
      activeOpacity={0.6}
    >
      <View style={[styles.avatar, { backgroundColor: colors.primaryLight }]}>
        <Text style={[styles.avatarText, { color: colors.primary }]}>
          {getInitials(item.name, item.email)}
        </Text>
      </View>
      <View style={styles.suggestionInfo}>
        {!!item.name && (
          <Text style={[styles.suggestionName, { color: colors.text }]} numberOfLines={1}>
            {item.name}
          </Text>
        )}
        <Text style={[styles.suggestionEmail, { color: item.name ? colors.textSecondary : colors.text }]} numberOfLines={1}>
          {item.email}
        </Text>
        {!!item.phone && (
          <Text style={[styles.suggestionEmail, { color: colors.textSecondary, fontSize: 11 }]} numberOfLines={1}>
            {item.phone}
          </Text>
        )}
      </View>
      {!!item.phone && <Text style={{ fontSize: 10, color: '#34C759', fontWeight: '600', marginRight: 4 }}>TEL</Text>}
      {!!item.source && <SourceIcon source={item.source} />}
    </TouchableOpacity>
  );

  return (
    <View style={styles.wrapper}>
      <View style={styles.labelRow}>
        {/* Label */}
        {!!label && (
          <Text style={[styles.label, { color: colors.textTertiary }]}>{label}</Text>
        )}

        {/* Chips + Input row */}
        <View style={styles.inputRow}>
        {/* Chips */}
        {value.map((contact) => (
          <View key={contact.email} style={[styles.chip, { backgroundColor: colors.primaryLight }]}>
            <Text style={[styles.chipText, { color: colors.primary }]} numberOfLines={1}>
              {contact.name || contact.email}
            </Text>
            <TouchableOpacity
              onPress={() => removeContact(contact.email)}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              style={styles.chipRemove}
            >
              <IconX size={12} color={colors.primary} />
            </TouchableOpacity>
          </View>
        ))}

        {/* Text Input */}
        <TextInput
          ref={inputRef}
          style={[
            styles.input,
            { color: colors.text },
            value.length === 0 && styles.inputFull,
          ]}
          value={inputText}
          onChangeText={handleChangeText}
          onSubmitEditing={handleSubmitEditing}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            // Auto-add valid email on blur (e.g. user typed email then clicked Send)
            const trimmed = fixEmail(inputText);
            if (trimmed && EMAIL_REGEX.test(trimmed)) {
              addContact({ email: trimmed, name: '' });
            }
            // Delay blur to allow suggestion tap to register
            setTimeout(() => setFocused(false), 200);
          }}
          onKeyPress={handleKeyPress}
          placeholder={value.length === 0 ? (placeholder || 'Digite um email...') : ''}
          placeholderTextColor={colors.textTertiary}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          returnKeyType="done"
          blurOnSubmit={false}
        />
      </View>
      </View>

      {/* Dropdown */}
      {showDropdown && (
        <View style={[
          styles.dropdown,
          Shadow.lg,
          { backgroundColor: colors.surface, borderColor: colors.border },
          Platform.OS === 'web' && styles.dropdownWeb,
        ]}>
          {loading && suggestions.length === 0 ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.loadingText, { color: colors.textSecondary }]}>Buscando contatos...</Text>
            </View>
          ) : (
            <FlatList
              data={suggestions}
              renderItem={renderSuggestion}
              keyExtractor={(item) => item.email}
              keyboardShouldPersistTaps="handled"
              style={styles.list}
              nestedScrollEnabled
            />
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'relative',
    zIndex: 10,
  },
  label: {
    fontSize: FontSize.base,
    width: 50,
    flexShrink: 0,
    paddingTop: 10,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  inputRow: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    minHeight: 40,
    gap: 6,
  },
  // Chips
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: BorderRadius.lg,
    paddingLeft: Spacing.sm,
    paddingRight: 8,
    paddingVertical: 6,
    maxWidth: 240,
    gap: 5,
  },
  chipText: {
    fontSize: FontSize.sm,
    fontWeight: '500',
    flexShrink: 1,
  },
  chipRemove: {
    padding: 2,
    borderRadius: BorderRadius.full,
  },
  // Input
  input: {
    fontSize: FontSize.base,
    minWidth: 120,
    flexShrink: 1,
    flexGrow: 1,
    paddingVertical: Platform.OS === 'web' ? 8 : 6,
    ...Platform.select({ web: { outlineStyle: 'none' }, default: {} }),
  },
  inputFull: {
    flex: 1,
  },
  // Dropdown
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    borderRadius: BorderRadius.lg,
    borderWidth: 0,
    maxHeight: 240,
    overflow: 'hidden',
    zIndex: 100,
    marginTop: 6,
  },
  dropdownWeb: Platform.OS === 'web' ? {
    boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
  } : {},
  list: {
    maxHeight: 220,
  },
  // Suggestion item
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: Spacing.sm,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: FontSize.xs,
    fontWeight: '700',
  },
  suggestionInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  suggestionName: {
    fontSize: FontSize.base,
    fontWeight: '500',
    lineHeight: 18,
  },
  suggestionEmail: {
    fontSize: FontSize.sm,
    lineHeight: 16,
  },
  // Loading
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.lg,
    gap: Spacing.sm,
  },
  loadingText: {
    fontSize: FontSize.sm,
  },
});

const ContactAutocomplete = forwardRef(ContactAutocompleteInner);
export default ContactAutocomplete;
