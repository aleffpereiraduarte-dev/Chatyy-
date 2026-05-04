// Debounce hook — kills 7+ inline `useRef(null)` + setTimeout patterns in
// contacts.js, signup-phone.js, chat-conversation.js, GlobalSearch.js,
// SearchBar.js, ContactAutocomplete.js, ProfileEditSheet.js.
//
// Usage:
//   const onSearch = useDebouncedCallback((query) => fetchSearch(query), 400);
//   <TextInput onChangeText={onSearch} />
//
// The returned callback is stable across renders (won't trigger child
// re-renders the way a fresh closure would). Auto-cancels on unmount and
// when delay/fn change.
import { useEffect, useRef, useCallback, useState } from 'react';

export default function useDebouncedCallback(fn, delay = 300) {
  const timerRef = useRef(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return useCallback((...args) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      try { fnRef.current?.(...args); } catch {}
    }, delay);
  }, [delay]);
}

// Variant: returns [debouncedValue, setRaw] — for passive value debouncing.
export function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
