import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Platform } from 'react-native';
import { useLanguage } from '../context/LanguageContext';
import { IconX } from './Icons';

export default function MeetPollPanel({ visible, onClose, polls = [], onCreatePoll, onVote, isHost }) {
  const { t } = useLanguage();
  const [creating, setCreating] = useState(false);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);

  if (!visible) return null;

  const handleSubmit = () => {
    const q = question.trim();
    const opts = options.map(o => o.trim()).filter(Boolean);
    if (!q || opts.length < 2) return;
    onCreatePoll?.(q, opts);
    setQuestion('');
    setOptions(['', '']);
    setCreating(false);
  };

  const addOption = () => {
    if (options.length < 4) setOptions([...options, '']);
  };

  const updateOption = (i, val) => {
    const next = [...options];
    next[i] = val;
    setOptions(next);
  };

  const totalVotes = (poll) => poll.options.reduce((s, o) => s + (o.votes || 0), 0);

  const maxVotes = (poll) => Math.max(1, ...poll.options.map(o => o.votes || 0));

  return (
    <View style={[s.panel, Platform.OS === 'web' && s.panelGlass]}>
      <View style={s.header}>
        <Text style={s.headerTitle}>{t('meetPoll.title')}</Text>
        <TouchableOpacity onPress={onClose} style={s.closeBtn}>
          <IconX size={18} color="#94a3b8" />
        </TouchableOpacity>
      </View>

      <ScrollView style={s.body} contentContainerStyle={{ paddingBottom: 20 }}>
        {isHost && !creating && (
          <TouchableOpacity style={s.createBtn} onPress={() => setCreating(true)}>
            <Text style={s.createBtnText}>+ {t('meetPoll.create')}</Text>
          </TouchableOpacity>
        )}

        {creating && (
          <View style={s.form}>
            <TextInput
              style={s.input}
              placeholder={t('meetPoll.askQuestion')}
              placeholderTextColor="#64748b"
              value={question}
              onChangeText={setQuestion}
            />
            {options.map((opt, i) => (
              <TextInput
                key={i}
                style={s.input}
                placeholder={t('meetPoll.option', { n: i + 1 })}
                placeholderTextColor="#64748b"
                value={opt}
                onChangeText={(v) => updateOption(i, v)}
              />
            ))}
            <View style={s.formRow}>
              {options.length < 4 && (
                <TouchableOpacity onPress={addOption}>
                  <Text style={s.addOptText}>+ {t('meetPoll.addOption')}</Text>
                </TouchableOpacity>
              )}
              <View style={{ flex: 1 }} />
              <TouchableOpacity style={s.cancelBtn} onPress={() => setCreating(false)}>
                <Text style={s.cancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.submitBtn} onPress={handleSubmit}>
                <Text style={s.submitText}>{t('compose.send')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {polls.map((poll) => {
          const total = totalVotes(poll);
          const mx = maxVotes(poll);
          const isActive = poll.active !== false;
          return (
            <View key={poll.id} style={[s.pollCard, !isActive && s.pollInactive]}>
              <Text style={[s.pollQ, !isActive && { color: '#64748b' }]}>{poll.question}</Text>
              <Text style={s.pollMeta}>{t('meetPoll.voteCount', { count: total })}{!isActive ? ' - ' + t('meetPoll.closed') : ''}</Text>
              {poll.options.map((opt, i) => {
                const pct = total > 0 ? Math.round((opt.votes / total) * 100) : 0;
                const barW = mx > 0 ? ((opt.votes || 0) / mx) * 100 : 0;
                const voted = poll.myVote === i;
                return (
                  <TouchableOpacity
                    key={i}
                    style={[s.optionRow, voted && s.optionVoted]}
                    onPress={() => isActive && poll.myVote == null && onVote?.(poll.id, i)}
                    disabled={!isActive || poll.myVote != null}
                    activeOpacity={0.7}
                  >
                    <View style={[s.optionBar, { width: `${barW}%` }]} />
                    <Text style={s.optionText}>{opt.text}</Text>
                    <Text style={s.optionPct}>{pct}%</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          );
        })}

        {polls.length === 0 && !creating && (
          <Text style={s.empty}>{t('meetPoll.empty')}{isHost ? ' ' + t('meetPoll.createHint') : ''}</Text>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  panel: {
    position: 'absolute', top: 0, right: 0, bottom: 0, width: 340, maxWidth: '40%',
    backgroundColor: '#0f172a', borderLeftWidth: 1, borderLeftColor: '#1e293b', zIndex: 50,
  },
  panelGlass: { backgroundColor: 'rgba(15,23,42,0.95)', backdropFilter: 'blur(12px)' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1e293b',
  },
  headerTitle: { color: '#f1f5f9', fontSize: 16, fontWeight: '600' },
  closeBtn: { padding: 4 },
  body: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  createBtn: {
    backgroundColor: '#7C3AED', borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginBottom: 16,
  },
  createBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  form: { marginBottom: 16 },
  input: {
    backgroundColor: '#1e293b', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
    color: '#e2e8f0', fontSize: 14, marginBottom: 8,
  },
  formRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 8 },
  addOptText: { color: '#60a5fa', fontSize: 13 },
  cancelBtn: { paddingHorizontal: 12, paddingVertical: 8 },
  cancelText: { color: '#94a3b8', fontSize: 13 },
  submitBtn: { backgroundColor: '#7C3AED', borderRadius: 6, paddingHorizontal: 16, paddingVertical: 8 },
  submitText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  pollCard: {
    backgroundColor: '#1e293b', borderRadius: 10, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#334155',
  },
  pollInactive: { opacity: 0.55 },
  pollQ: { color: '#f1f5f9', fontSize: 15, fontWeight: '600', marginBottom: 4 },
  pollMeta: { color: '#64748b', fontSize: 12, marginBottom: 10 },
  optionRow: {
    position: 'relative', borderRadius: 6, paddingVertical: 10, paddingHorizontal: 12,
    marginBottom: 6, backgroundColor: '#0f172a', flexDirection: 'row', alignItems: 'center', overflow: 'hidden',
  },
  optionVoted: { borderWidth: 1, borderColor: '#7C3AED' },
  optionBar: {
    position: 'absolute', left: 0, top: 0, bottom: 0,
    backgroundColor: 'rgba(37,99,235,0.2)', borderRadius: 6,
  },
  optionText: { color: '#e2e8f0', fontSize: 14, flex: 1, zIndex: 1 },
  optionPct: { color: '#94a3b8', fontSize: 13, fontWeight: '600', zIndex: 1, marginLeft: 8 },
  empty: { color: '#64748b', textAlign: 'center', marginTop: 40, fontSize: 14 },
});
