import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { FontSize, Spacing, BorderRadius, Shadow } from '../constants/theme';
import { IconCalendar, IconClock, IconUser, IconCheck, IconX, IconInfo } from './Icons';

function formatEventDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const days = ['Domingo', 'Segunda', 'Terca', 'Quarta', 'Quinta', 'Sexta', 'Sabado'];
    const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    const day = days[d.getDay()];
    const date = d.getDate();
    const month = months[d.getMonth()];
    const hours = d.getHours().toString().padStart(2, '0');
    const mins = d.getMinutes().toString().padStart(2, '0');
    return `${day}, ${date} ${month} as ${hours}:${mins}`;
  } catch {
    return dateStr;
  }
}

function formatTimeRange(start, end) {
  if (!start) return '';
  const startStr = formatEventDate(start);
  if (!end) return startStr;
  try {
    const d = new Date(end);
    if (isNaN(d.getTime())) return startStr;
    const hours = d.getHours().toString().padStart(2, '0');
    const mins = d.getMinutes().toString().padStart(2, '0');
    return `${startStr} - ${hours}:${mins}`;
  } catch {
    return startStr;
  }
}

export default function CalendarEventCard({ event }) {
  const { colors } = useTheme();

  if (!event) return null;

  return (
    <View style={[s.card, Shadow.sm, { backgroundColor: colors.surface, borderColor: colors.primaryLight, borderLeftColor: colors.primary }]}>
      {/* Header */}
      <View style={s.headerRow}>
        <View style={[s.iconWrap, { backgroundColor: colors.primaryLight }]}>
          <IconCalendar size={18} color={colors.primary} />
        </View>
        <View style={s.headerInfo}>
          <Text style={[s.eventTitle, { color: colors.text }]} numberOfLines={2}>
            {event.title || 'Evento sem titulo'}
          </Text>
          <Text style={[s.inviteLabel, { color: colors.primary }]}>Convite de calendario</Text>
        </View>
      </View>

      {/* Details */}
      <View style={s.details}>
        {/* Date/Time */}
        <View style={s.detailRow}>
          <IconClock size={15} color={colors.textSecondary} style={{ marginRight: Spacing.sm }} />
          <Text style={[s.detailText, { color: colors.text }]}>
            {formatTimeRange(event.start, event.end)}
          </Text>
        </View>

        {/* Location */}
        {event.location ? (
          <View style={s.detailRow}>
            <IconInfo size={15} color={colors.textSecondary} style={{ marginRight: Spacing.sm }} />
            <Text style={[s.detailText, { color: colors.text }]} numberOfLines={2}>
              {event.location}
            </Text>
          </View>
        ) : null}

        {/* Organizer */}
        {event.organizer ? (
          <View style={s.detailRow}>
            <IconUser size={15} color={colors.textSecondary} style={{ marginRight: Spacing.sm }} />
            <Text style={[s.detailText, { color: colors.textSecondary }]}>
              Organizado por {event.organizer}
            </Text>
          </View>
        ) : null}

        {/* Description */}
        {event.description ? (
          <Text style={[s.description, { color: colors.textSecondary }]} numberOfLines={3}>
            {event.description}
          </Text>
        ) : null}
      </View>

      {/* Action buttons */}
      <View style={[s.actions, { borderTopColor: colors.borderLight }]}>
        <TouchableOpacity
          style={[s.actionBtn, { backgroundColor: colors.success + '15', borderColor: colors.success + '30' }]}
          activeOpacity={0.7}
        >
          <IconCheck size={15} color={colors.success} style={{ marginRight: 4 }} />
          <Text style={[s.actionText, { color: colors.success }]}>Aceitar</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.actionBtn, { backgroundColor: colors.error + '15', borderColor: colors.error + '30' }]}
          activeOpacity={0.7}
        >
          <IconX size={15} color={colors.error} style={{ marginRight: 4 }} />
          <Text style={[s.actionText, { color: colors.error }]}>Recusar</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.actionBtn, { backgroundColor: colors.surfaceVariant, borderColor: colors.border }]}
          activeOpacity={0.7}
        >
          <Text style={[s.actionText, { color: colors.textSecondary }]}>Talvez</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    borderRadius: BorderRadius.lg, borderWidth: 1,
    borderLeftWidth: 4, overflow: 'hidden',
    marginVertical: Spacing.md,
  },
  // Header
  headerRow: {
    flexDirection: 'row', alignItems: 'center',
    padding: Spacing.lg,
  },
  iconWrap: {
    width: 40, height: 40, borderRadius: BorderRadius.md,
    justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md,
  },
  headerInfo: { flex: 1 },
  eventTitle: { fontSize: FontSize.lg, fontWeight: '600', lineHeight: 22 },
  inviteLabel: { fontSize: FontSize.xs, fontWeight: '500', marginTop: 2 },
  // Details
  details: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md },
  detailRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    marginBottom: Spacing.sm,
  },
  detailText: { fontSize: FontSize.base, flex: 1, lineHeight: 20 },
  description: { fontSize: FontSize.sm, lineHeight: 20, marginTop: Spacing.xs },
  // Actions
  actions: {
    flexDirection: 'row', gap: Spacing.sm,
    padding: Spacing.lg, borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderRadius: BorderRadius.md, borderWidth: 1,
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg,
    flex: 1,
  },
  actionText: { fontSize: FontSize.md, fontWeight: '600' },
});
