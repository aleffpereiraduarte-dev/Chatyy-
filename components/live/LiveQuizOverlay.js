/**
 * LiveQuizOverlay — single-question quiz card surfaced over the live video.
 *
 * Like LivePollOverlay but with a `correct_idx` reveal stage:
 *   1. Question + 2-6 options shown (correct option is HIDDEN until close).
 *   2. Viewer taps an option → API call → card switches to "waiting" state.
 *   3. Host (or auto-timer) closes the quiz → backend broadcasts
 *      `live_quiz_result` with per-option tallies + total + correct_idx.
 *      Card now reveals: correct option highlighted green, viewer's answer
 *      marked with a check/x depending on correctness.
 *
 * Parent owns the `quiz` shape:
 *   {
 *     quiz_id, question,
 *     options: [{ text, answers? }],  // answers only present post-close
 *     correct_idx?,                   // only present post-close
 *     closed,                         // viewer "results" state
 *     total?,                         // total answers (post-close)
 *     my_answer_idx?,                 // local: which option the viewer picked
 *   }
 */

import { useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
} from 'react-native';

export default function LiveQuizOverlay({
  quiz,
  isHost = false,
  myAnswerIdx = null,
  onAnswer,
  onClose,
  i18n = {},
}) {
  const t = useMemo(() => ({
    quiz: i18n.quiz || 'Quiz',
    closeLabel: i18n.closeLabel || 'Encerrar quiz',
    closedLabel: i18n.closedLabel || 'Quiz encerrado',
    correct: i18n.correct || 'Resposta correta',
    yourAnswer: i18n.yourAnswer || 'Sua resposta',
    answers: i18n.answers || 'respostas',
    waiting: i18n.waiting || 'Aguardando resultado…',
  }), [i18n]);

  if (!quiz || !quiz.question || !Array.isArray(quiz.options)) return null;

  const closed = !!quiz.closed;
  const correctIdx = closed && typeof quiz.correct_idx === 'number' ? quiz.correct_idx : -1;
  const hasAnswered = typeof myAnswerIdx === 'number' && myAnswerIdx >= 0;
  const showResults = closed; // hide tallies until close, even for host
  const total = Number(quiz.total) || quiz.options.reduce((s, o) => s + (o.answers || 0), 0);

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={styles.card}>
        <View style={styles.header}>
          <View style={styles.quizBadge}>
            <Text style={styles.quizBadgeText}>{t.quiz.toUpperCase()}</Text>
          </View>
          {closed ? (
            <Text style={styles.closedText} numberOfLines={1}>{t.closedLabel}</Text>
          ) : null}
        </View>
        <Text style={styles.question} numberOfLines={3}>{quiz.question}</Text>

        {quiz.options.map((opt, idx) => {
          const isMine = myAnswerIdx === idx;
          const isCorrect = correctIdx === idx;
          // Bar fill width when showing results.
          const pct = total > 0 ? Math.round(((opt.answers || 0) / total) * 100) : 0;
          // Active bar color: correct=green, my-wrong=red, otherwise muted.
          let barColor = 'rgba(255,255,255,0.18)';
          if (closed) {
            if (isCorrect) barColor = '#10B981';
            else if (isMine && !isCorrect) barColor = '#DC2626';
          }
          const disabled = closed || hasAnswered || isHost;
          return (
            <TouchableOpacity
              key={idx}
              activeOpacity={disabled ? 1 : 0.85}
              disabled={disabled}
              onPress={() => !disabled && onAnswer && onAnswer(idx)}
              accessibilityRole="button"
              accessibilityState={{ selected: isMine, disabled }}
              style={styles.optionRow}
            >
              {/* Bar fill */}
              {closed ? (
                <View style={[styles.bar, { width: pct + '%', backgroundColor: barColor }]} />
              ) : null}
              <View style={styles.optionContent}>
                <Text style={[styles.optionText, isCorrect && { color: '#10B981', fontWeight: '800' }]} numberOfLines={2}>
                  {opt.text}
                </Text>
                {closed ? (
                  <Text style={styles.optionStat}>{opt.answers || 0} ({pct}%)</Text>
                ) : null}
                {!closed && isMine ? (
                  <Text style={styles.optionStat}>{t.waiting}</Text>
                ) : null}
              </View>
            </TouchableOpacity>
          );
        })}

        {isHost && !closed ? (
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityRole="button">
            <Text style={styles.closeBtnText}>{t.closeLabel}</Text>
          </TouchableOpacity>
        ) : null}
        {closed ? (
          <Text style={styles.summary}>
            {total} {t.answers}
            {hasAnswered && correctIdx >= 0 ? (
              myAnswerIdx === correctIdx
                ? '   ·   ✓ ' + t.yourAnswer
                : '   ·   ✗ ' + t.yourAnswer
            ) : ''}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 110, left: 12, right: 12,
    alignItems: 'center',
  },
  card: {
    width: '100%',
    backgroundColor: 'rgba(15,23,42,0.92)',
    borderRadius: 14,
    paddingHorizontal: 12, paddingVertical: 10,
    gap: 8,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  quizBadge: { backgroundColor: '#EC4899', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  quizBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  closedText: { color: '#9CA3AF', fontSize: 11 },
  question: { color: '#fff', fontSize: 14, fontWeight: '700' },
  optionRow: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    paddingVertical: 8, paddingHorizontal: 10,
  },
  bar: {
    position: 'absolute',
    top: 0, bottom: 0, left: 0,
    borderRadius: 10,
    opacity: 0.5,
  },
  optionContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  optionText: { color: '#fff', fontSize: 13, fontWeight: '600', flex: 1 },
  optionStat: { color: 'rgba(255,255,255,0.65)', fontSize: 11 },
  closeBtn: {
    alignSelf: 'flex-end', marginTop: 4,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  closeBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  summary: { color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 4 },
});
