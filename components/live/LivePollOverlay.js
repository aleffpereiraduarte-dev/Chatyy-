/**
 * LivePollOverlay — live poll card surfaced over the video.
 *
 * Used on BOTH host (live-broadcast) and viewer (live-viewer) screens:
 *   - Host always sees vote tallies, never votes; gets an "Encerrar enquete"
 *     button to close the poll early.
 *   - Viewer can tap an option to vote (once); after voting (or after the
 *     poll is closed) the card switches to a results-only view with bars.
 *
 * Pure presentation. Parent owns the `poll` shape:
 *   {
 *     id, question,
 *     options: [{ text, votes }],
 *     total_votes,
 *     closed,
 *     viewer_voted_index,  // viewer-only, undefined for host
 *   }
 *
 * Card sits in the top-center area of the screen above the chat overlay.
 */

import { useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform,
} from 'react-native';

export default function LivePollOverlay({
  poll,
  isHost = false,
  myVoteIndex = null,
  onVote,
  onClose,
  i18n = {},
}) {
  const t = useMemo(() => ({
    closeLabel: i18n.closeLabel || 'Encerrar enquete',
    closedLabel: i18n.closedLabel || 'Enquete encerrada',
    votedLabel: i18n.votedLabel || 'Você votou',
    votes: i18n.votes || 'votos',
    poll: i18n.poll || 'Enquete',
    dismiss: i18n.dismiss || 'Dispensar',
  }), [i18n]);

  if (!poll || !poll.question || !Array.isArray(poll.options)) return null;

  const total = Number(poll.total_votes) || poll.options.reduce((s, o) => s + (o.votes || 0), 0);
  const closed = !!poll.closed;
  const hasVoted = typeof myVoteIndex === 'number' && myVoteIndex >= 0;
  // Results-only view = host always, OR viewer who already voted, OR closed.
  const showResults = isHost || hasVoted || closed;

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={styles.card}>
        <View style={styles.header}>
          <View style={styles.pollBadge}>
            <Text style={styles.pollBadgeText}>{t.poll.toUpperCase()}</Text>
          </View>
          {closed ? (
            <Text style={styles.closedText} numberOfLines={1}>{t.closedLabel}</Text>
          ) : null}
          {!isHost && closed ? (
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 6, left: 6, right: 6, bottom: 6 }} style={styles.dismissBtn}>
              <Text style={styles.dismissText}>×</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <Text style={styles.question} numberOfLines={3}>{poll.question}</Text>

        <View style={{ gap: 8 }}>
          {poll.options.map((opt, idx) => {
            const votes = Number(opt.votes) || 0;
            const pct = total > 0 ? Math.round((votes / total) * 100) : 0;
            const isMyVote = hasVoted && myVoteIndex === idx;

            if (showResults) {
              // Result row — bar fills the row from left, label on top.
              return (
                <View key={idx} style={styles.resultRow}>
                  <View style={[styles.resultBar, { width: `${Math.max(2, pct)}%` }, isMyVote && styles.resultBarMine]} />
                  <View style={styles.resultRowInner}>
                    <Text style={styles.resultOptText} numberOfLines={1}>
                      {opt.text}{isMyVote ? `  · ${t.votedLabel}` : ''}
                    </Text>
                    <Text style={styles.resultPct}>{pct}%</Text>
                  </View>
                </View>
              );
            }
            // Vote row (viewer, not yet voted, poll open).
            return (
              <TouchableOpacity
                key={idx}
                onPress={() => onVote?.(idx)}
                style={styles.voteRow}
                activeOpacity={0.75}
                accessibilityRole="button"
              >
                <Text style={styles.voteOptText} numberOfLines={1}>{opt.text}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.footer}>
          <Text style={styles.totalText}>{total} {t.votes}</Text>
          {isHost && !closed ? (
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} activeOpacity={0.8}>
              <Text style={styles.closeBtnText}>{t.closeLabel}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  card: {
    backgroundColor: 'rgba(0,0,0,0.62)',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    width: '100%',
    maxWidth: 360,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(14px)',
      WebkitBackdropFilter: 'blur(14px)',
      boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
    } : {}),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  pollBadge: {
    backgroundColor: '#7C3AED',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  pollBadgeText: {
    color: '#fff', fontWeight: '900', fontSize: 10, letterSpacing: 1,
  },
  closedText: {
    color: '#facc15', fontSize: 11, fontWeight: '700', flex: 1,
  },
  dismissBtn: { marginLeft: 'auto', paddingHorizontal: 6, paddingVertical: 0 },
  dismissText: { color: 'rgba(255,255,255,0.7)', fontSize: 22, lineHeight: 22, fontWeight: '300' },
  question: {
    color: '#fff', fontSize: 15, fontWeight: '700', marginBottom: 10, lineHeight: 19,
  },
  voteRow: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  voteOptText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  resultRow: {
    position: 'relative',
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.08)',
    minHeight: 38,
    justifyContent: 'center',
  },
  resultBar: {
    position: 'absolute',
    left: 0, top: 0, bottom: 0,
    backgroundColor: 'rgba(124,58,237,0.55)',
  },
  resultBarMine: {
    backgroundColor: 'rgba(34,197,94,0.65)',
  },
  resultRowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  resultOptText: { color: '#fff', fontSize: 13, fontWeight: '600', flex: 1 },
  resultPct: { color: '#fff', fontSize: 13, fontWeight: '800', marginLeft: 8 },

  footer: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  totalText: { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '600' },
  closeBtn: {
    backgroundColor: 'rgba(239,68,68,0.85)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  closeBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
