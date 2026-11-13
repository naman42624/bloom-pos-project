// One expense line. Used by the staff 7-day list, the owner/manager
// "See all entries" list and the item screen.
//
// Props:
//   expense    a row from GET /api/expenses
//   canChange  show the Change button
//   onChange   (expense) => void, opens the sheet in change mode
//   onReturn   optional (expense) => void, "Money back" on a cash expense
//   showDate   show the date (lists that span several days)
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';
import { formatTime } from '../../utils/datetime';
import { givenToText } from '../../utils/expenseBook';
import { getApiOrigin } from '../../services/api';
import ImageModal from '../ImageModal';
import { EXPENSE_CATEGORIES, rupees } from './AddExpenseSheet';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const METHOD_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card' };

export function shortDate(str) {
  const [y, m, d] = String(str || '').slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${d} ${MONTHS[m - 1]}`;
}

function catInfo(key) {
  return EXPENSE_CATEGORIES.find((c) => c.key === key) || { label: key || 'Other', icon: 'ellipsis-horizontal' };
}

export default function ExpenseRow({ expense, canChange, onChange, onReturn, showDate = false }) {
  const [photoOpen, setPhotoOpen] = useState(false);
  const e = expense || {};
  const cat = catInfo(e.category);
  const title = e.item_name || e.description || cat.label;
  const method = METHOD_LABEL[String(e.payment_method || '').toLowerCase()] || String(e.payment_method || '').toUpperCase();
  const given = givenToText(e);
  const parts = [method, given, e.created_by_name ? `added by ${e.created_by_name}` : null].filter(Boolean);
  const photoUri = e.photo_url ? (/^https?:/.test(e.photo_url) ? e.photo_url : `${getApiOrigin()}${e.photo_url}`) : null;
  const showReturn = !!onReturn && !e.is_return && String(e.payment_method).toLowerCase() === 'cash';

  return (
    <View style={[styles.card, e.is_return && styles.cardReturn]}>
      <View style={styles.top}>
        <View style={[styles.icon, e.is_return && styles.iconReturn]}>
          <Ionicons name={e.is_return ? 'arrow-undo' : cat.icon} size={22} color={e.is_return ? Colors.success : Colors.primary} />
        </View>
        <View style={styles.center}>
          <Text style={styles.title}>
            {e.is_return ? 'Money back: ' : ''}{title}
          </Text>
          <Text style={styles.meta}>
            {showDate && e.expense_date ? `${shortDate(e.expense_date)} · ` : ''}{cat.label}
          </Text>
          <Text style={styles.meta}>{parts.join(' · ')}</Text>
          {!!e.note && <Text style={styles.note} numberOfLines={2}>{e.note}</Text>}
          {String(e.payment_method).toLowerCase() === 'cash' && !!e.register_opened_at && (
            <Text style={styles.session}>Register opened {formatTime(e.register_opened_at)}</Text>
          )}
        </View>
        <View style={styles.right}>
          <Text style={[styles.amount, e.is_return && styles.amountReturn]}>
            {e.is_return ? '+' : '−'}{rupees(e.amount)}
          </Text>
          {photoUri && (
            <TouchableOpacity
              onPress={() => setPhotoOpen(true)}
              style={styles.photoBtn}
              accessibilityRole="button"
              accessibilityLabel={`See the bill photo for ${title}`}
            >
              <Ionicons name="camera" size={20} color={Colors.textSecondary} />
              <Text style={styles.photoText}>Bill</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {(canChange || showReturn) && (
        <View style={styles.actions}>
          {showReturn && (
            <TouchableOpacity
              onPress={() => onReturn(e)}
              style={styles.secondaryBtn}
              accessibilityRole="button"
              accessibilityLabel={`Record money coming back for ${title}`}
            >
              <Ionicons name="arrow-undo-outline" size={18} color={Colors.textSecondary} />
              <Text style={styles.secondaryText}>Money back</Text>
            </TouchableOpacity>
          )}
          {canChange && (
            <TouchableOpacity
              onPress={() => onChange && onChange(e)}
              style={styles.changeBtn}
              accessibilityRole="button"
              accessibilityLabel={`Change expense ${title}`}
            >
              <Ionicons name="create-outline" size={18} color={Colors.primary} />
              <Text style={styles.changeText}>Change</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {photoUri && <ImageModal visible={photoOpen} imageUrl={photoUri} onClose={() => setPhotoOpen(false)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border,
  },
  cardReturn: { borderColor: Colors.success + '40', backgroundColor: Colors.successLight },
  top: { flexDirection: 'row', alignItems: 'flex-start' },
  icon: {
    width: 40, height: 40, borderRadius: BorderRadius.md,
    backgroundColor: Colors.primaryGlow, justifyContent: 'center', alignItems: 'center',
    marginRight: Spacing.sm,
  },
  iconReturn: { backgroundColor: Colors.surface },
  center: { flex: 1 },
  title: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  meta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  note: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2, fontStyle: 'italic' },
  session: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  right: { alignItems: 'flex-end', marginLeft: Spacing.sm, gap: Spacing.xs },
  amount: { fontSize: FontSize.md, fontWeight: '700', color: Colors.error, fontVariant: ['tabular-nums'] },
  amountReturn: { color: Colors.success },
  photoBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    minHeight: 44, minWidth: 44, paddingHorizontal: Spacing.xs, justifyContent: 'center',
  },
  photoText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.sm, marginTop: Spacing.sm },
  secondaryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
  },
  secondaryText: { color: Colors.textSecondary, fontWeight: '600', fontSize: FontSize.sm },
  changeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary,
  },
  changeText: { color: Colors.primary, fontWeight: '700', fontSize: FontSize.sm },
});
