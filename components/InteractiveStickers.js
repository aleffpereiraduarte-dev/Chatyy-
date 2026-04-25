/**
 * InteractiveStickers.js
 *
 * Renders interactive status stickers (poll, question, quiz, countdown) that
 * viewers can actually interact with.  Each sticker is a self-contained
 * component that manages its own optimistic local state so UI feels instant
 * while the network call happens in the background.
 *
 * Usage inside the Status Viewer (ChatListTab.js):
 *
 *   import { renderInteractiveStickers } from './InteractiveStickers';
 *
 *   // Inside the status-item render block, after the main content:
 *   {renderInteractiveStickers(item, currentUserEmail)}
 *
 * The helper tries to JSON-parse `item.content` (or `item.sticker_data` if the
 * backend starts returning it as a dedicated column). If the content contains a
 * `stickers` array with typed interactive entries they are rendered in-place at
 * their stored (x, y) positions.  For the simplified ChatListTab viewer where
 * stickers should appear stacked at the bottom, pass `stacked={true}` to each
 * component directly.
 *
 * Sticker data shapes (set by ChatStatusTab editor):
 *   poll      : { type:'poll',      question, optionA, optionB, x, y }
 *   question  : { type:'question',  prompt, x, y }
 *   quiz      : { type:'quiz',      question, options:string[], correct:number, x, y }
 *   countdown : { type:'countdown', label, targetDate:ISO-string, x, y }
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Keyboard,
  Platform,
} from 'react-native';
import * as api from '../services/api';

// ─── Utility ────────────────────────────────────────────────────────────────

/**
 * Parse the stickers array out of a raw status item object.
 * Sticker data may live in:
 *   1. item.sticker_data  — dedicated JSON column (future backend support)
 *   2. item.content       — JSON string with a top-level `stickers` array
 * Returns [] if no interactive stickers are found.
 */
export function parseStickerData(item) {
  if (!item) return [];

  // 1. Dedicated column (preferred once backend adds it)
  if (item.sticker_data) {
    try {
      const parsed = typeof item.sticker_data === 'string'
        ? JSON.parse(item.sticker_data)
        : item.sticker_data;
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.stickers)) return parsed.stickers;
    } catch { /* fall through */ }
  }

  // 2. content field encoded as JSON (extraMeta pattern from ChatStatusTab)
  if (item.content) {
    try {
      const parsed = JSON.parse(item.content);
      if (Array.isArray(parsed?.stickers)) return parsed.stickers;
    } catch { /* content is plain text — no stickers */ }
  }

  return [];
}

/**
 * Convenience renderer — call this from inside the Status Viewer modal after
 * the main content View.  Returns null when there are no interactive stickers.
 *
 * @param {object} item           - A single status item from statusList()
 * @param {string} currentEmail   - Email of the logged-in viewer
 * @param {object} [opts]
 * @param {boolean} [opts.stacked] - Stack stickers vertically at the bottom
 *                                   instead of using absolute x/y positions
 */
export function renderInteractiveStickers(item, currentEmail, opts = {}) {
  const stickers = parseStickerData(item);
  const interactive = stickers.filter(s =>
    ['poll', 'question', 'quiz', 'countdown'].includes(s.type)
  );
  if (interactive.length === 0) return null;

  const { stacked = false } = opts;

  if (stacked) {
    return (
      <View style={styles.stackedContainer}>
        {interactive.map((sticker, idx) => (
          <StickerSwitch
            key={sticker.id ?? idx}
            sticker={sticker}
            statusId={item.id}
            currentEmail={currentEmail}
            stacked
          />
        ))}
      </View>
    );
  }

  return (
    <>
      {interactive.map((sticker, idx) => (
        <View
          key={sticker.id ?? idx}
          style={[styles.absoluteSticker, { left: sticker.x ?? 40, top: sticker.y ?? 200 }]}
          pointerEvents="box-none"
        >
          <StickerSwitch
            sticker={sticker}
            statusId={item.id}
            currentEmail={currentEmail}
          />
        </View>
      ))}
    </>
  );
}

// ─── Router ─────────────────────────────────────────────────────────────────

function StickerSwitch({ sticker, statusId, currentEmail, stacked }) {
  switch (sticker.type) {
    case 'poll':
      return <PollSticker sticker={sticker} statusId={statusId} currentEmail={currentEmail} stacked={stacked} />;
    case 'question':
      return <QuestionSticker sticker={sticker} statusId={statusId} currentEmail={currentEmail} stacked={stacked} />;
    case 'quiz':
      return <QuizSticker sticker={sticker} statusId={statusId} currentEmail={currentEmail} stacked={stacked} />;
    case 'countdown':
      return <CountdownSticker sticker={sticker} stacked={stacked} />;
    default:
      return null;
  }
}

// ─── PollSticker ─────────────────────────────────────────────────────────────

/**
 * Shows question + 2 options.  Tap to vote; after voting reveals percentage
 * bars for each option.  Voting is idempotent (backend uses ON CONFLICT … DO
 * UPDATE) so tapping again switches your vote.
 */
export function PollSticker({ sticker, statusId, currentEmail, stacked }) {
  const [votedOption, setVotedOption] = useState(null); // null | 0 | 1
  const [votes, setVotes] = useState([0, 0]);           // [countA, countB]
  const [loading, setLoading] = useState(false);

  const hasVoted = votedOption !== null;
  const total = votes[0] + votes[1] || 1; // avoid division by zero

  const handleVote = useCallback(async (optionIdx) => {
    if (loading) return;
    // Optimistic update
    setVotedOption(optionIdx);
    setVotes(prev => {
      const next = [...prev];
      if (votedOption !== null) next[votedOption] = Math.max(0, next[votedOption] - 1);
      next[optionIdx] = next[optionIdx] + 1;
      return next;
    });
    setLoading(true);
    try {
      await api.statusPollVote(statusId, optionIdx);
    } catch {
      // Revert optimistic update on error
      setVotedOption(null);
      setVotes(prev => {
        const next = [...prev];
        next[optionIdx] = Math.max(0, next[optionIdx] - 1);
        return next;
      });
    } finally {
      setLoading(false);
    }
  }, [loading, votedOption, statusId]);

  const options = [sticker.optionA || 'Sim', sticker.optionB || 'Não'];

  return (
    <View style={[styles.pollContainer, stacked && styles.stackedCard]}>
      <Text style={styles.pollQuestion}>{sticker.question || 'Qual a sua opinião?'}</Text>

      {options.map((label, idx) => {
        const pct = hasVoted ? Math.round((votes[idx] / total) * 100) : 0;
        const isSelected = votedOption === idx;

        return (
          <TouchableOpacity
            key={idx}
            onPress={() => !hasVoted && handleVote(idx)}
            activeOpacity={hasVoted ? 1 : 0.7}
            style={[
              styles.pollOption,
              isSelected && styles.pollOptionSelected,
            ]}
            accessibilityLabel={`Opção ${label}`}
            accessibilityRole="button"
          >
            {hasVoted && (
              <View
                style={[
                  styles.pollBar,
                  { width: `${pct}%` },
                  isSelected && styles.pollBarSelected,
                ]}
              />
            )}
            <Text style={[styles.pollOptionText, isSelected && styles.pollOptionTextSelected]}>
              {label}
            </Text>
            {hasVoted && (
              <Text style={styles.pollPct}>{pct}%</Text>
            )}
          </TouchableOpacity>
        );
      })}

      {hasVoted && (
        <Text style={styles.pollTotalVotes}>
          {votes[0] + votes[1]} voto{votes[0] + votes[1] !== 1 ? 's' : ''}
        </Text>
      )}
    </View>
  );
}

// ─── QuestionSticker ─────────────────────────────────────────────────────────

/**
 * Shows a text prompt.  Viewer can type and submit a free-text answer.
 * After submitting, shows a thank-you confirmation.
 */
export function QuestionSticker({ sticker, statusId, currentEmail, stacked }) {
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    Keyboard.dismiss();
    setLoading(true);
    setError(null);
    try {
      const result = await api.statusQuestionAnswer(statusId, trimmed);
      if (result?.success) {
        setSubmitted(true);
      } else {
        setError(result?.message || 'Erro ao enviar. Tente novamente.');
      }
    } catch {
      setError('Erro de conexão. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }, [text, loading, statusId]);

  return (
    <View style={[styles.questionContainer, stacked && styles.stackedCard]}>
      {/* Header */}
      <View style={styles.questionHeader}>
        <Text style={styles.questionIcon}>❓</Text>
        <Text style={styles.questionLabel}>Pergunta</Text>
      </View>

      <Text style={styles.questionPrompt}>{sticker.prompt || 'Me pergunte algo...'}</Text>

      {submitted ? (
        <View style={styles.questionThanks}>
          <Text style={styles.questionThanksIcon}>🙌</Text>
          <Text style={styles.questionThanksText}>Resposta enviada!</Text>
        </View>
      ) : (
        <View style={styles.questionInputRow}>
          <TextInput
            ref={inputRef}
            style={styles.questionInput}
            placeholder="Digite sua resposta..."
            placeholderTextColor="rgba(255,255,255,0.5)"
            value={text}
            onChangeText={t => { setText(t); setError(null); }}
            maxLength={500}
            returnKeyType="send"
            onSubmitEditing={handleSubmit}
            editable={!loading}
            accessibilityLabel="Campo de resposta"
          />
          <TouchableOpacity
            onPress={handleSubmit}
            disabled={!text.trim() || loading}
            style={[styles.questionSendBtn, (!text.trim() || loading) && styles.questionSendBtnDisabled]}
            accessibilityLabel="Enviar resposta"
            accessibilityRole="button"
          >
            <Text style={styles.questionSendIcon}>➤</Text>
          </TouchableOpacity>
        </View>
      )}

      {error ? <Text style={styles.questionError}>{error}</Text> : null}
    </View>
  );
}

// ─── QuizSticker ─────────────────────────────────────────────────────────────

/**
 * Shows question + multiple-choice options.  On tap: correct answer turns
 * green, wrong answer turns red with the correct one highlighted.
 * Calls api.statusQuizAnswer(statusId, selectedIdx).
 */
export function QuizSticker({ sticker, statusId, currentEmail, stacked }) {
  const [selected, setSelected] = useState(null); // null | number
  const [loading, setLoading] = useState(false);
  const shakeAnim = useRef(new Animated.Value(0)).current;

  const correctIdx = sticker.correct ?? 0;
  const options = sticker.options ?? [];
  const hasAnswered = selected !== null;

  const shake = useCallback(() => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 6, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -6, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  }, [shakeAnim]);

  const handleSelect = useCallback(async (idx) => {
    if (hasAnswered || loading) return;
    setSelected(idx);
    if (idx !== correctIdx) shake();
    setLoading(true);
    try {
      // statusQuizAnswer is a new endpoint — see BACKEND_CHANGES.md for the
      // api.js addition.  Optional-chain guards against the function not yet
      // being present during staged rollout.
      await api.statusQuizAnswer?.(statusId, idx, correctIdx);
    } catch { /* non-critical — local state is already set */ }
    finally { setLoading(false); }
  }, [hasAnswered, loading, correctIdx, shake, statusId]);

  function optionStyle(idx) {
    if (!hasAnswered) return styles.quizOptionDefault;
    if (idx === correctIdx) return styles.quizOptionCorrect;
    if (idx === selected) return styles.quizOptionWrong;
    return styles.quizOptionDimmed;
  }

  function optionTextStyle(idx) {
    if (!hasAnswered) return styles.quizOptionTextDefault;
    if (idx === correctIdx || idx === selected) return styles.quizOptionTextActive;
    return styles.quizOptionTextDimmed;
  }

  return (
    <Animated.View
      style={[
        styles.quizContainer,
        stacked && styles.stackedCard,
        { transform: [{ translateX: shakeAnim }] },
      ]}
    >
      {/* Header */}
      <View style={styles.quizHeader}>
        <Text style={styles.quizHeaderIcon}>🧠</Text>
        <Text style={styles.quizHeaderLabel}>Quiz</Text>
      </View>

      <Text style={styles.quizQuestion}>{sticker.question || 'Qual a resposta certa?'}</Text>

      {options.map((opt, idx) => (
        <TouchableOpacity
          key={idx}
          onPress={() => handleSelect(idx)}
          activeOpacity={hasAnswered ? 1 : 0.75}
          style={[styles.quizOption, optionStyle(idx)]}
          accessibilityLabel={`Opção ${opt}`}
          accessibilityRole="button"
          disabled={hasAnswered || loading}
        >
          <Text style={[styles.quizOptionText, optionTextStyle(idx)]}>{opt}</Text>
          {hasAnswered && idx === correctIdx && (
            <Text style={styles.quizCheckmark}>✓</Text>
          )}
          {hasAnswered && idx === selected && idx !== correctIdx && (
            <Text style={styles.quizCross}>✗</Text>
          )}
        </TouchableOpacity>
      ))}

      {hasAnswered && (
        <Text style={[styles.quizResult, selected === correctIdx ? styles.quizResultCorrect : styles.quizResultWrong]}>
          {selected === correctIdx ? '🎉 Correto!' : '😬 Errou! A certa era: ' + (options[correctIdx] || '')}
        </Text>
      )}
    </Animated.View>
  );
}

// ─── CountdownSticker ────────────────────────────────────────────────────────

/**
 * Shows a live countdown timer that ticks every second.
 * Pure display — no API call needed.
 */
export function CountdownSticker({ sticker, stacked }) {
  const [timeLeft, setTimeLeft] = useState(calcTimeLeft(sticker.targetDate));

  useEffect(() => {
    const interval = setInterval(() => {
      setTimeLeft(calcTimeLeft(sticker.targetDate));
    }, 1000);
    return () => clearInterval(interval);
  }, [sticker.targetDate]);

  const expired = timeLeft.total <= 0;

  return (
    <View style={[styles.countdownContainer, stacked && styles.stackedCard]}>
      {/* Header */}
      <View style={styles.countdownHeader}>
        <Text style={styles.countdownHeaderIcon}>⏳</Text>
        <Text style={styles.countdownLabel}>{sticker.label || 'Evento'}</Text>
      </View>

      {expired ? (
        <Text style={styles.countdownExpired}>Encerrado</Text>
      ) : (
        <View style={styles.countdownUnitsRow}>
          {timeLeft.days > 0 && (
            <CountdownUnit value={timeLeft.days} unit="d" />
          )}
          <CountdownUnit value={timeLeft.hours} unit="h" />
          <CountdownUnit value={timeLeft.minutes} unit="m" />
          <CountdownUnit value={timeLeft.seconds} unit="s" />
        </View>
      )}

      <Text style={styles.countdownDate}>
        {formatTargetDate(sticker.targetDate)}
      </Text>
    </View>
  );
}

function CountdownUnit({ value, unit }) {
  return (
    <View style={styles.countdownUnit}>
      <Text style={styles.countdownValue}>{String(value).padStart(2, '0')}</Text>
      <Text style={styles.countdownUnitLabel}>{unit}</Text>
    </View>
  );
}

function calcTimeLeft(targetDate) {
  try {
    const diff = new Date(targetDate).getTime() - Date.now();
    if (diff <= 0) return { total: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
    const total = diff;
    const seconds = Math.floor((diff / 1000) % 60);
    const minutes = Math.floor((diff / 1000 / 60) % 60);
    const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    return { total, days, hours, minutes, seconds };
  } catch {
    return { total: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
  }
}

function formatTargetDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const CARD_RADIUS = 16;
const SHADOW = Platform.OS === 'web'
  ? { boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }
  : { shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 8 };

const styles = StyleSheet.create({
  // ── Positioning helpers ────────────────────────────────────────────────────
  absoluteSticker: {
    position: 'absolute',
    zIndex: 20,
  },
  stackedContainer: {
    position: 'absolute',
    bottom: 90,
    left: 16,
    right: 16,
    gap: 10,
    zIndex: 20,
  },
  stackedCard: {
    width: '100%',
    marginBottom: 0,
  },

  // ── Poll ───────────────────────────────────────────────────────────────────
  pollContainer: {
    backgroundColor: 'rgba(124,58,237,0.92)',
    borderRadius: CARD_RADIUS,
    padding: 14,
    width: 240,
    ...SHADOW,
  },
  pollQuestion: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  pollOption: {
    position: 'relative',
    borderRadius: 24,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 8,
    backgroundColor: 'rgba(255,255,255,0.18)',
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
  },
  pollOptionSelected: {
    borderWidth: 2,
    borderColor: '#fff',
  },
  pollBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.22)',
    borderRadius: 24,
  },
  pollBarSelected: {
    backgroundColor: 'rgba(255,255,255,0.38)',
  },
  pollOptionText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
    flex: 1,
    zIndex: 1,
  },
  pollOptionTextSelected: {
    fontWeight: '700',
  },
  pollPct: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
    zIndex: 1,
    minWidth: 36,
    textAlign: 'right',
  },
  pollTotalVotes: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 2,
  },

  // ── Question ───────────────────────────────────────────────────────────────
  questionContainer: {
    backgroundColor: 'rgba(239,68,68,0.92)',
    borderRadius: CARD_RADIUS,
    padding: 14,
    width: 240,
    ...SHADOW,
  },
  questionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  questionIcon: {
    fontSize: 16,
  },
  questionLabel: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  questionPrompt: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 12,
    lineHeight: 20,
  },
  questionInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  questionInput: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 14,
    color: '#fff',
    fontSize: 14,
  },
  questionSendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  questionSendBtnDisabled: {
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  questionSendIcon: {
    color: '#ef4444',
    fontSize: 16,
    fontWeight: '700',
  },
  questionThanks: {
    alignItems: 'center',
    paddingVertical: 8,
    gap: 4,
  },
  questionThanksIcon: {
    fontSize: 24,
  },
  questionThanksText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
  },
  questionError: {
    color: 'rgba(255,230,230,0.9)',
    fontSize: 11,
    marginTop: 6,
    textAlign: 'center',
  },

  // ── Quiz ───────────────────────────────────────────────────────────────────
  quizContainer: {
    backgroundColor: 'rgba(245,158,11,0.92)',
    borderRadius: CARD_RADIUS,
    padding: 14,
    width: 240,
    ...SHADOW,
  },
  quizHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  quizHeaderIcon: {
    fontSize: 16,
  },
  quizHeaderLabel: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  quizQuestion: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 10,
    lineHeight: 20,
  },
  quizOption: {
    borderRadius: 20,
    paddingVertical: 9,
    paddingHorizontal: 14,
    marginBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
  },
  quizOptionDefault: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  quizOptionCorrect: {
    backgroundColor: 'rgba(16,185,129,0.85)',
  },
  quizOptionWrong: {
    backgroundColor: 'rgba(239,68,68,0.85)',
  },
  quizOptionDimmed: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  quizOptionText: {
    flex: 1,
    fontWeight: '600',
    fontSize: 14,
  },
  quizOptionTextDefault: {
    color: '#fff',
  },
  quizOptionTextActive: {
    color: '#fff',
    fontWeight: '700',
  },
  quizOptionTextDimmed: {
    color: 'rgba(255,255,255,0.4)',
  },
  quizCheckmark: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  quizCross: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  quizResult: {
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 6,
  },
  quizResultCorrect: {
    color: '#d1fae5',
  },
  quizResultWrong: {
    color: '#fee2e2',
  },

  // ── Countdown ─────────────────────────────────────────────────────────────
  countdownContainer: {
    backgroundColor: 'rgba(16,185,129,0.92)',
    borderRadius: CARD_RADIUS,
    padding: 14,
    width: 220,
    alignItems: 'center',
    ...SHADOW,
  },
  countdownHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  countdownHeaderIcon: {
    fontSize: 16,
  },
  countdownLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  countdownUnitsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  countdownUnit: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.22)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 44,
  },
  countdownValue: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  countdownUnitLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  countdownDate: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 11,
    textAlign: 'center',
  },
  countdownExpired: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 6,
  },
});
