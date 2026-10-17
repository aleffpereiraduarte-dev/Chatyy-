/**
 * CallQualityPrompt — "Como foi a qualidade da ligação?" after a call.
 *
 * [2026-10-12 call-review] WhatsApp-parity feedback sheet. Shown by
 * services/callQualityPrompt (sampled, ≥ 20 s, max once every 3 days); the
 * answer goes to voip_diag as `js_call_rating` next to the call's native
 * CallDiag events. 1–5 stars (SVG, no emoji); ≤ 3 stars asks what went wrong.
 * P&B like the rest of the call UI. Mounted once in app/_layout.js.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, DeviceEventEmitter, Platform } from 'react-native';
import { IconStar, IconStarFilled } from './Icons';
import { useLanguage } from '../context/LanguageContext';
import {
  CALL_RATING_EVENT,
  submitCallRating,
  dismissCallRating,
  installCalleeHooks,
} from '../services/callQualityPrompt';
import useDragToDismiss, { DragSheetRoot, DragPanel, DragBackdrop } from './ui/useDragToDismiss';

let _useTheme = null;
try { _useTheme = require('../context/ThemeContext').useTheme; } catch {}

const ISSUES = [
  ['echo', 'callRating.issueEcho', 'Eco'],
  ['choppy', 'callRating.issueChoppy', 'Som cortando'],
  ['delay', 'callRating.issueDelay', 'Atraso'],
  ['video', 'callRating.issueVideo', 'Vídeo travando'],
  ['dropped', 'callRating.issueDropped', 'A ligação caiu'],
];

export default function CallQualityPrompt() {
  // [2026-10-17 drag-dismiss] folha desce arrastando de qualquer ponto (components/ui/useDragToDismiss).
  const _drag88 = useDragToDismiss({ onDismiss: () => { const f = onDismiss; if (typeof f === 'function') f(); } });
  const { t } = useLanguage();
  const theme = _useTheme ? _useTheme() : null;
  const c = theme?.colors || {};
  const ink = c.text || '#111b21';
  const muted = c.textSecondary || '#667781';
  const bg = c.surface || c.background || '#ffffff';
  const line = c.border || c.headerBorder || '#e5e7eb';

  const [req, setReq] = useState(null);
  const [stars, setStars] = useState(0);
  const [issues, setIssues] = useState([]);

  const tr = useCallback((k, fb) => {
    try { const v = t(k); return v && v !== k ? v : fb; } catch { return fb; }
  }, [t]);

  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const unhook = installCalleeHooks();
    const sub = DeviceEventEmitter.addListener(CALL_RATING_EVENT, (p) => {
      setStars(0);
      setIssues([]);
      setReq(p || null);
    });
    return () => { try { sub.remove(); } catch {} try { unhook && unhook(); } catch {} };
  }, []);

  const close = useCallback(() => setReq(null), []);

  const onDismiss = useCallback(() => {
    if (req) dismissCallRating(req);
    close();
  }, [req, close]);

  const onStar = useCallback((n) => {
    setStars(n);
    if (n >= 4 && req) {
      submitCallRating(req, n, []);
      setTimeout(close, 250);
    }
  }, [req, close]);

  const toggleIssue = useCallback((k) => {
    setIssues((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  }, []);

  const onSend = useCallback(() => {
    if (req && stars > 0) submitCallRating(req, stars, issues);
    close();
  }, [req, stars, issues, close]);

  if (!req) return null;
  const showIssues = stars > 0 && stars <= 3;

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onDismiss} statusBarTranslucent>
      <DragSheetRoot>
      <Pressable style={[styles.backdrop, { backgroundColor: 'transparent' }]} onPress={onDismiss} accessibilityRole="button" accessibilityLabel={tr('callRating.notNow', 'Agora não')}>
        <DragBackdrop drag={_drag88} color="rgba(0,0,0,0.35)" />
        <DragPanel drag={_drag88} onStartShouldSetResponder={() => true} style={[styles.card, { backgroundColor: bg, borderColor: line }]} >
          <Text style={[styles.title, { color: ink }]} accessibilityRole="header">
            {tr('callRating.title', 'Como foi a qualidade da ligação?')}
          </Text>
          <View style={styles.starsRow}>
            {[1, 2, 3, 4, 5].map((n) => {
              const on = n <= stars;
              const Icon = on ? IconStarFilled : IconStar;
              return (
                <Pressable
                  key={n}
                  onPress={() => onStar(n)}
                  hitSlop={6}
                  style={styles.starBtn}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={tr('callRating.starsA11y', '{n} de 5').replace('{n}', String(n))}
                >
                  <Icon size={34} color={on ? ink : muted} />
                </Pressable>
              );
            })}
          </View>
          {showIssues ? (
            <>
              <Text style={[styles.sub, { color: muted }]}>{tr('callRating.whatWrong', 'O que deu errado?')}</Text>
              <View style={styles.chips}>
                {ISSUES.map(([k, key, fb]) => {
                  const sel = issues.includes(k);
                  return (
                    <Pressable
                      key={k}
                      onPress={() => toggleIssue(k)}
                      style={[styles.chip, { borderColor: sel ? ink : line, backgroundColor: sel ? ink : 'transparent' }]}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: sel }}
                    >
                      <Text style={[styles.chipText, { color: sel ? bg : ink }]}>{tr(key, fb)}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <Pressable onPress={onSend} style={[styles.primary, { backgroundColor: ink }]} accessibilityRole="button">
                <Text style={[styles.primaryText, { color: bg }]}>{tr('callRating.send', 'Enviar')}</Text>
              </Pressable>
            </>
          ) : null}
          <Pressable onPress={onDismiss} style={styles.later} accessibilityRole="button" hitSlop={8}>
            <Text style={[styles.laterText, { color: muted }]}>{tr('callRating.notNow', 'Agora não')}</Text>
          </Pressable>
        </DragPanel>
      </Pressable>
      </DragSheetRoot>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end', padding: 12 },
  card: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 20, paddingTop: 22, paddingBottom: 10, marginBottom: 18 },
  title: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  starsRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 16, marginBottom: 6 },
  starBtn: { paddingHorizontal: 6, paddingVertical: 4, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  sub: { fontSize: 14, textAlign: 'center', marginTop: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 10 },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7, margin: 4, minHeight: 34, justifyContent: 'center' },
  chipText: { fontSize: 14 },
  primary: { marginTop: 14, borderRadius: 12, minHeight: 46, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: 16, fontWeight: '600' },
  later: { alignSelf: 'center', paddingVertical: 12, minHeight: 44, justifyContent: 'center' },
  laterText: { fontSize: 15 },
});
