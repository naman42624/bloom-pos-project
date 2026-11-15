// "Sorted earlier" tab of Sort older entries. Owner only.
//
// Every entry put into an item by Sort older entries, newest sort first, with
// what was typed next to the item it went into. Take out puts one back in
// "To sort" (POST /assign-items/undo, only if it is still in that item).
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../services/api';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import { showAlert } from '../../utils/alert';
import { entriesText } from '../../utils/expenseBook';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';
import Button from '../Button';
import { shortDate } from './ExpenseRow';
import { categoryLabel, rupees } from './AddExpenseSheet';

const PAGE = 50;
const LOAD_FAILED = "Couldn't load the sorted entries. Check the internet, then tap Try again.";

export default function SortedEarlierList({ onTakenOut }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [nextAfter, setNextAfter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [moreError, setMoreError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [note, setNote] = useState('');
  const seq = useRef(0);
  const guardSubmit = useSubmitGuard();

  const load = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    setError('');
    setMoreError('');
    try {
      const res = await api.getSortedEarlierExpenses({ limit: PAGE });
      if (id !== seq.current) return;
      setRows(res.data || []);
      setTotal(Number.isFinite(Number(res.total)) ? Number(res.total) : (res.data || []).length);
      setNextAfter(res.next_after || null);
    } catch {
      if (id === seq.current) setError(LOAD_FAILED);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadMore = useCallback(async () => {
    if (!nextAfter || loadingMore || loading) return;
    const id = ++seq.current;
    setLoadingMore(true);
    setMoreError('');
    try {
      const res = await api.getSortedEarlierExpenses({ limit: PAGE, after: nextAfter });
      if (id !== seq.current) return;
      setRows((prev) => {
        const have = new Set(prev.map((r) => r.id));
        return prev.concat((res.data || []).filter((r) => !have.has(r.id)));
      });
      if (Number.isFinite(Number(res.total))) setTotal(Number(res.total));
      setNextAfter(res.next_after || null);
    } catch {
      if (id === seq.current) setMoreError('Could not load more. Check the internet, then tap Show more.');
    } finally {
      if (id === seq.current) setLoadingMore(false);
    }
  }, [nextAfter, loadingMore, loading]);

  const takeOut = guardSubmit(async (row) => {
    setBusyId(row.id);
    try {
      const res = await api.undoAssignExpenseItems([{ expense_id: row.id, item_id: row.sorted_item_id }]);
      const undone = Number(res.data?.undone) || 0;
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      setTotal((t) => Math.max(0, t - 1));
      setNote(undone
        ? `"${row.description || 'Entry'}" is out of ${row.item_name}. Find it in To sort to pick the right item.`
        : `"${row.description || 'Entry'}" had already changed, so it was left as is.`);
      if (undone && onTakenOut) onTakenOut();
    } catch (err) {
      showAlert('Could not take it out', err?.message || 'Nothing was changed. Check the internet, then tap Take out again.');
    } finally {
      setBusyId(null);
    }
  });

  const header = (
    <View>
      <Text style={styles.intro}>
        Entries you sorted, newest first. If one is in the wrong item, tap Take out. It goes back to To sort, where you can pick the right item.
      </Text>
      {total > 0 && <Text style={styles.totalLine}>{`${entriesText(total)} sorted`}</Text>}
      {!!note && (
        <View style={styles.note} accessibilityLiveRegion="polite">
          <Ionicons name="checkmark-circle" size={20} color={Colors.success} />
          <Text style={styles.noteText}>{note}</Text>
        </View>
      )}
      {!!error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Button title="Try again" onPress={load} size="sm" style={styles.retry} />
        </View>
      )}
    </View>
  );

  const renderRow = ({ item: row }) => (
    <View style={styles.card}>
      <View style={styles.rowTop}>
        <View style={styles.flex}>
          <Text style={styles.desc}>{row.description || 'No description'}</Text>
          <View style={styles.inLine}>
            <Ionicons name="arrow-forward" size={16} color={Colors.primary} />
            <Text style={styles.itemName}>{row.item_name}</Text>
          </View>
          <Text style={styles.meta}>
            {shortDate(row.expense_date)} · {categoryLabel(row.category)}{row.is_return ? ' · money back' : ''}
          </Text>
        </View>
        <Text style={styles.amount}>{rupees(row.amount)}</Text>
      </View>
      <TouchableOpacity
        style={styles.outBtn}
        onPress={() => takeOut(row)}
        disabled={busyId !== null}
        accessibilityRole="button"
        accessibilityLabel={`Take ${row.description || 'this entry'} out of ${row.item_name}`}
      >
        {busyId === row.id ? <ActivityIndicator color={Colors.primary} /> : (
          <>
            <Ionicons name="arrow-undo" size={18} color={Colors.primary} />
            <Text style={styles.outText}>Take out</Text>
          </>
        )}
      </TouchableOpacity>
    </View>
  );

  return (
    <FlatList
      data={error ? [] : rows}
      keyExtractor={(r) => String(r.id)}
      renderItem={renderRow}
      extraData={busyId}
      ListHeaderComponent={header}
      contentContainerStyle={styles.content}
      onEndReached={loadMore}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={!error && (
        <View style={styles.empty}>
          {loading ? <ActivityIndicator color={Colors.primary} /> : (
            <Text style={styles.muted}>Nothing sorted yet. Entries you sort show up here.</Text>
          )}
        </View>
      )}
      ListFooterComponent={!error && rows.length > 0 && (nextAfter || moreError) ? (
        <View style={styles.moreBox}>
          {!!moreError && <Text style={styles.errorText}>{moreError}</Text>}
          <TouchableOpacity style={styles.moreBtn} onPress={loadMore} disabled={loadingMore} accessibilityRole="button">
            {loadingMore ? <ActivityIndicator color={Colors.primary} /> : (
              <Text style={styles.outText}>
                {total > rows.length ? `Show more (${total - rows.length} more)` : 'Show more'}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      ) : null}
    />
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.md, paddingBottom: Spacing.xxl, width: '100%', maxWidth: 800, alignSelf: 'center' },
  flex: { flex: 1 },
  intro: { fontSize: FontSize.md, color: Colors.textSecondary, marginBottom: Spacing.md },
  totalLine: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.md },
  note: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, padding: Spacing.md, marginBottom: Spacing.md,
    borderRadius: BorderRadius.md, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.success,
  },
  noteText: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  errorBox: { padding: Spacing.md, marginBottom: Spacing.md, borderRadius: BorderRadius.md, backgroundColor: Colors.surface },
  errorText: { fontSize: FontSize.md, color: Colors.error, textAlign: 'center' },
  retry: { marginTop: Spacing.sm, alignSelf: 'center' },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border,
  },
  rowTop: { flexDirection: 'row', gap: Spacing.sm },
  desc: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  inLine: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  itemName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.primary },
  meta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  amount: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  outBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, alignSelf: 'flex-start',
    minHeight: 44, minWidth: 120, paddingHorizontal: Spacing.md, marginTop: Spacing.sm,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary,
  },
  outText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  empty: { alignItems: 'center', padding: Spacing.xl },
  muted: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center' },
  moreBox: { paddingVertical: Spacing.md, gap: Spacing.sm },
  moreBtn: {
    minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.primary, backgroundColor: Colors.surface,
  },
});
