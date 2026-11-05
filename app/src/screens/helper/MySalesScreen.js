// Helper's My sales tab (spec §9.3): today's own sales at this shop — time,
// items, amount, method — with the count, the UPI total, and the cash total
// hidden like the counter's (§12: first digit kept, rest x) until tapped,
// then shown for 15 seconds. A sale made in the last 2 minutes can be undone
// here (server decides: GET /quick-sale/my-sales can_undo, POST undo).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import { showAlert, showConfirm } from '../../utils/alert';
import { formatRupees } from '../../utils/scanAddLine';
import { maskAmount } from '../../utils/helperBasket';
import useHelperSession from '../../components/helper/useHelperSession';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

const REVEAL_MS = 15000;
const UNDO_WINDOW_MS = 2 * 60 * 1000;
const TICK_MS = 15000;
const LOAD_FAILED = "Couldn't load your sales. Check the internet and tap Try again.";
const METHOD_LABEL = { cash: 'Cash', upi: 'UPI' };

function timeText(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

export default function MySalesScreen() {
  const { locked } = useAuth();
  const { locationId, handleAccessEnded } = useHelperSession();
  const guard = useSubmitGuard();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [undoingId, setUndoingId] = useState(null);
  const [now, setNow] = useState(Date.now());
  const revealTimer = useRef(null);

  const load = useCallback(async (pull = false) => {
    if (!locationId) return;
    if (pull) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const res = await api.getMySales(locationId);
      setData(res?.data || { sales: [], count: 0, totals: { cash: 0, upi: 0 } });
    } catch (err) {
      if (!handleAccessEnded(err)) setError(LOAD_FAILED);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [locationId, handleAccessEnded]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // The lock no longer blurs the screen: refetch when the PIN pad closes.
  const wasLocked = useRef(locked);
  useEffect(() => {
    if (wasLocked.current && !locked) load();
    wasLocked.current = locked;
  }, [locked, load]);

  useEffect(() => () => { if (revealTimer.current) clearTimeout(revealTimer.current); }, []);

  // Undo hides once a sale is over 2 minutes old (the server decides too).
  useFocusEffect(useCallback(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []));
  const undoOpen = (sale) => {
    if (!sale.can_undo) return false;
    const made = Date.parse(sale.created_at);
    return Number.isNaN(made) || now - made < UNDO_WINDOW_MS;
  };

  const reveal = () => {
    setRevealed(true);
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => setRevealed(false), REVEAL_MS);
  };

  const doUndo = guard(async (sale) => {
    setUndoingId(sale.id);
    try {
      await api.undoQuickSale(sale.id);
      await load();
    } catch (err) {
      if (!handleAccessEnded(err)) {
        showAlert("Couldn't undo", err?.status ? err.message : 'Check the internet and try again.');
        load();
      }
    } finally {
      setUndoingId(null);
    }
  });

  const askUndo = (sale) => {
    showConfirm(
      'Undo this sale?',
      `${formatRupees(sale.grand_total)} · ${(sale.items || []).join(', ')}\nGive the money back to the customer. The items go back on the shelf.`,
      () => doUndo(sale),
      { confirmLabel: 'Undo sale', cancelLabel: 'Keep it', destructive: true },
    );
  };

  const sales = data?.sales || [];
  const cash = Number(data?.totals?.cash) || 0;
  const upi = Number(data?.totals?.upi) || 0;

  const header = (
    <View style={styles.summary}>
      <View style={styles.summaryRow}>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Sales today</Text>
          <Text style={styles.statValue}>{data ? Number(data.count) || 0 : '—'}</Text>
        </View>
        <TouchableOpacity
          style={[styles.stat, styles.statTap]}
          onPress={reveal}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={revealed ? `Cash ${formatRupees(cash)}` : 'Cash total hidden, tap to see'}
        >
          <Text style={styles.statLabel}>Cash</Text>
          <Text style={styles.statValue}>{data ? (revealed ? formatRupees(cash) : maskAmount(cash)) : '—'}</Text>
          <Text style={styles.statHint}>{revealed ? 'Hides again soon' : 'Tap to see'}</Text>
        </TouchableOpacity>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>UPI</Text>
          <Text style={styles.statValue}>{data ? formatRupees(upi) : '—'}</Text>
        </View>
      </View>
    </View>
  );

  const renderSale = ({ item }) => {
    const methods = (item.payment_methods || []).map((m) => METHOD_LABEL[m] || m).join(' + ');
    return (
      <View style={[styles.card, item.undone && styles.cardUndone]}>
        <View style={styles.cardTop}>
          <Text style={styles.time}>{timeText(item.created_at)}</Text>
          <Text style={[styles.amount, item.undone && styles.amountUndone]}>{formatRupees(item.grand_total)}</Text>
        </View>
        <Text style={styles.items}>{(item.items || []).join(', ') || 'Items'}</Text>
        <View style={styles.cardBottom}>
          {item.undone ? (
            <View style={[styles.chip, styles.chipUndone]}>
              <Ionicons name="arrow-undo" size={16} color={Colors.text} />
              <Text style={styles.chipText}>Undone</Text>
            </View>
          ) : (
            <View style={styles.chip}>
              <Ionicons name={methods.includes('UPI') && !methods.includes('Cash') ? 'qr-code-outline' : 'cash-outline'} size={16} color={Colors.text} />
              <Text style={styles.chipText}>{methods || '—'}</Text>
            </View>
          )}
          {undoOpen(item) ? (
            <TouchableOpacity
              style={styles.undoBtn}
              onPress={() => askUndo(item)}
              disabled={undoingId != null}
              accessibilityRole="button"
              accessibilityLabel={`Undo the ${formatRupees(item.grand_total)} sale`}
            >
              {undoingId === item.id ? <ActivityIndicator color={Colors.error} /> : <Ionicons name="arrow-undo" size={20} color={Colors.error} />}
              <Text style={styles.undoText}>Undo</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  };

  let empty = null;
  if (error) {
    empty = (
      <View style={styles.center}>
        <Ionicons name="cloud-offline-outline" size={44} color={Colors.textSecondary} />
        <Text style={styles.centerText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => load()} accessibilityRole="button" accessibilityLabel="Try again">
          <Ionicons name="refresh" size={22} color={Colors.white} />
          <Text style={styles.retryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (loading && !data) {
    empty = <ActivityIndicator color={Colors.primary} style={{ marginTop: Spacing.xl }} />;
  } else {
    empty = (
      <View style={styles.center}>
        <Ionicons name="receipt-outline" size={44} color={Colors.textLight} />
        <Text style={styles.centerText}>No sales yet today. Your sales show here after you take payment.</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <FlatList
        data={error ? [] : sales}
        keyExtractor={(s) => String(s.id)}
        renderItem={renderSale}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  listContent: { padding: Spacing.md, paddingBottom: Spacing.xl, width: '100%', maxWidth: 720, alignSelf: 'center' },
  summary: { marginBottom: Spacing.md },
  summaryRow: { flexDirection: 'row', gap: Spacing.sm },
  stat: {
    flex: 1, backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border, alignItems: 'center', minHeight: 88, justifyContent: 'center',
  },
  statTap: { borderWidth: 2, borderColor: Colors.primary },
  statLabel: { fontSize: FontSize.md, fontWeight: '600', color: Colors.textSecondary },
  statValue: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] },
  statHint: { fontSize: FontSize.sm, color: Colors.primaryDark, fontWeight: '600' },
  card: { backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md, borderWidth: 1, borderColor: Colors.border },
  cardUndone: { backgroundColor: Colors.surfaceAlt },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  time: { fontSize: FontSize.md, fontWeight: '600', color: Colors.textSecondary },
  amount: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] },
  amountUndone: { textDecorationLine: 'line-through', color: Colors.textSecondary },
  items: { fontSize: FontSize.md, color: Colors.text, marginTop: Spacing.xs, lineHeight: 22 },
  cardBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full, backgroundColor: Colors.secondaryLight,
  },
  chipUndone: { backgroundColor: Colors.border },
  chipText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  undoBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 48, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 2, borderColor: Colors.error,
  },
  undoText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.error },
  center: { alignItems: 'center', padding: Spacing.lg, gap: Spacing.md },
  centerText: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', maxWidth: 360, lineHeight: 22 },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 52, paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md, backgroundColor: Colors.primary,
  },
  retryText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '700' },
});
