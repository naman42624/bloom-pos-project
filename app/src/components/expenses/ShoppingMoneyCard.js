/**
 * ShoppingMoneyCard — "Shopping money out" (spec 4.4), on the counter,
 * employee, manager and owner dashboards and at the top of Expenses.
 * Shown only while someone holds shopping money or the shop owes someone.
 *
 *   Shopping money out                      See all ›   (owner/manager)
 *     Ramesh     ₹500    2 days                     ›
 *     Tota Ram   ₹200    4 days · late (red)        ›
 *   Shop owes
 *     Owner      ₹850                     [Pay back]
 *
 * A shopping line opens "Ramesh is back" (ShoppingMoneyBack); Pay back opens
 * PayBackSheet. The card is quiet (no filled button): the screen it sits on
 * keeps its own primary action.
 *
 * Props: locationId, refreshKey? (bump to reload), onChanged?() (money moved)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { cardHasLines, daysText, rupeesText } from '../../utils/staffMoney';
import PayBackSheet from './PayBackSheet';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

export const IS_BACK_SCREEN = 'ShoppingMoneyBack';
export const HISTORY_SCREEN = 'ShoppingMoneyHistory';
const NOTE_MS = 6000;

export default function ShoppingMoneyCard({ locationId, refreshKey = 0, onChanged }) {
  const navigation = useNavigation();
  const { user, locked } = useAuth();
  const [data, setData] = useState(null);
  const [payFor, setPayFor] = useState(null);
  const [note, setNote] = useState('');
  const noteTimer = useRef(null);
  const alive = useRef(true);
  const isBoss = user?.role === 'owner' || user?.role === 'manager';

  const load = useCallback(async () => {
    if (!locationId) return;
    try {
      const res = await api.getOpenStaffMoney({ location_id: locationId });
      if (alive.current) setData(res && res.data ? res.data : null);
    } catch {
      // Extra information only: keep what was shown, try again on the next visit.
    }
  }, [locationId]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(noteTimer.current); }; }, []);
  useEffect(() => { setData(null); }, [locationId]);
  useEffect(() => { load(); }, [refreshKey]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // The PIN lock no longer blurs the screen: refresh on unlock.
  const wasLocked = useRef(locked);
  useEffect(() => {
    if (wasLocked.current && !locked) load();
    wasLocked.current = locked;
  }, [locked, load]);

  const showNote = (text) => {
    setNote(text);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), NOTE_MS);
  };

  const sheet = (
    <PayBackSheet
      visible={!!payFor}
      line={payFor}
      locationId={locationId}
      onClose={() => setPayFor(null)}
      onDone={(r) => { showNote(r.message); load(); onChanged && onChanged(); }}
    />
  );

  const noteView = note ? (
    <View style={styles.note} accessibilityLiveRegion="polite">
      <Ionicons name="checkmark-circle" size={20} color={Colors.success} />
      <Text style={styles.noteText}>{note}</Text>
    </View>
  ) : null;

  if (!cardHasLines(data)) {
    return note ? <View>{noteView}{sheet}</View> : sheet;
  }
  const shopping = data.shopping || [];
  const owes = data.owes || [];
  const routeExists = (() => {
    try { return (navigation.getState()?.routeNames || []).includes(IS_BACK_SCREEN); } catch { return false; }
  })();
  const historyExists = (() => {
    try { return (navigation.getState()?.routeNames || []).includes(HISTORY_SCREEN); } catch { return false; }
  })();
  const meId = Number(user?.id);

  return (
    <View style={styles.card}>
      {shopping.length > 0 && (
        <>
          <View style={styles.headRow}>
            <Text style={styles.title}>Shopping money out</Text>
            {isBoss && historyExists && (
              <TouchableOpacity
                style={styles.seeAll}
                onPress={() => navigation.navigate(HISTORY_SCREEN, { locationId })}
                accessibilityRole="button"
                accessibilityLabel="See all shopping money"
              >
                <Text style={styles.seeAllText}>See all</Text>
                <Ionicons name="chevron-forward" size={18} color={Colors.primary} />
              </TouchableOpacity>
            )}
          </View>
          {shopping.map((s) => (
            <TouchableOpacity
              key={`s${s.id}`}
              style={styles.row}
              disabled={!routeExists}
              onPress={() => navigation.navigate(IS_BACK_SCREEN, { id: s.id, locationId })}
              accessibilityRole="button"
              accessibilityLabel={`${s.user_name} has ${rupeesText(s.remaining)}, ${daysText(s.days)}${s.late ? ', late' : ''}. Tap when ${s.user_name} is back.`}
            >
              <Text style={styles.name} numberOfLines={1}>{Number(s.user_id) === meId ? 'You' : s.user_name}</Text>
              <Text style={styles.amount}>{rupeesText(s.remaining)}</Text>
              <Text style={[styles.age, s.late && styles.late]}>
                {daysText(s.days)}{s.late ? ' · late' : ''}
              </Text>
              {routeExists && <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />}
            </TouchableOpacity>
          ))}
        </>
      )}

      {owes.length > 0 && (
        <>
          <View style={[styles.headRow, shopping.length > 0 && styles.subHead]}>
            <Text style={shopping.length > 0 ? styles.subTitle : styles.title}>Shop owes</Text>
            {isBoss && historyExists && shopping.length === 0 && (
              <TouchableOpacity
                style={styles.seeAll}
                onPress={() => navigation.navigate(HISTORY_SCREEN, { locationId })}
                accessibilityRole="button"
                accessibilityLabel="See all shopping money"
              >
                <Text style={styles.seeAllText}>See all</Text>
                <Ionicons name="chevron-forward" size={18} color={Colors.primary} />
              </TouchableOpacity>
            )}
          </View>
          {owes.map((o) => (
            <View key={`o${o.id}`} style={styles.row}>
              <Text style={styles.name} numberOfLines={1}>{Number(o.user_id) === meId ? 'You' : o.user_name}</Text>
              <Text style={styles.amount}>{rupeesText(o.remaining)}</Text>
              <TouchableOpacity
                style={styles.payBtn}
                onPress={() => setPayFor(o)}
                accessibilityRole="button"
                accessibilityLabel={`Pay back ${rupeesText(o.remaining)} to ${o.user_name}`}
              >
                <Text style={styles.payText}>Pay back</Text>
              </TouchableOpacity>
            </View>
          ))}
        </>
      )}
      {noteView}
      {sheet}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, marginBottom: Spacing.sm,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  subHead: { marginTop: Spacing.sm },
  title: { flex: 1, fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  subTitle: { flex: 1, fontSize: FontSize.md, fontWeight: '700', color: Colors.textSecondary },
  seeAll: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingLeft: Spacing.md },
  seeAllText: { color: Colors.primary, fontSize: FontSize.md, fontWeight: '700' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 52,
    borderTopWidth: 1, borderTopColor: Colors.border,
  },
  name: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  amount: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] },
  age: { minWidth: 64, textAlign: 'right', fontSize: FontSize.md, color: Colors.textSecondary },
  late: { color: Colors.error, fontWeight: '700' },
  payBtn: {
    minHeight: 44, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  payText: { color: Colors.primary, fontSize: FontSize.md, fontWeight: '700' },
  note: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs, marginTop: Spacing.sm, padding: Spacing.sm,
    borderRadius: BorderRadius.md, backgroundColor: Colors.successLight,
  },
  noteText: { flex: 1, fontSize: FontSize.md, color: Colors.text },
});
