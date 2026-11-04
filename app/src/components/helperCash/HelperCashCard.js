/**
 * HelperCashCard — "Cash with helpers" on the counter dashboard (bag mode
 * only, spec §12). Amounts are masked (₹5,xxx); sale counts are not.
 *
 *   Cash with helpers  ₹5,xxx
 *     Raju   ₹3,xxx · 14 sales            [ Receive ]
 *     Priya  ₹1,xxx · 9 sales             [ Receive ]
 *     tap a name to see the exact amount or collect
 *     [ Give change ]
 *
 * Tapping a name asks the server for the exact amount (audited) and shows it
 * for 15 seconds with Receive cash and Give float, then masks it again.
 * Receive on the row opens the blind count straight away (no reveal first,
 * so the count is not steered by a number on screen).
 *
 * Nothing shows in register mode. With no helper holding cash or selling
 * today the card is hidden; a single "Give change to a helper" row stays so
 * the first float of the day can be given.
 *
 * Props: locationId, onChanged() (optional: cash moved, e.g. the register
 *        was opened from a sheet, so the screen can refresh its own figures)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { showAlert } from '../../utils/alert';
import { REVEAL_MS, rupees, handoverDoneText } from '../../utils/helperCash';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import ReceiveCashSheet from './ReceiveCashSheet';
import GiveFloatSheet from './GiveFloatSheet';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

const NOTE_MS = 20000;

export default function HelperCashCard({ locationId, onChanged }) {
  const { locked } = useAuth();
  const [data, setData] = useState(null);
  const [revealed, setRevealed] = useState(null); // { staff_id, held, floats, cash_sales, settled, last_float }
  const [revealing, setRevealing] = useState(null);
  const [receiveFor, setReceiveFor] = useState(null); // { staff_id, name }
  const [floatOpen, setFloatOpen] = useState(null); // { helpers, initialStaffId }
  const [note, setNote] = useState('');
  const revealTimer = useRef(null);
  const noteTimer = useRef(null);
  const alive = useRef(true);
  const guard = useSubmitGuard();

  const hide = useCallback(() => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = null;
    setRevealed(null);
  }, []);

  const load = useCallback(async () => {
    if (!locationId) return;
    try {
      const res = await api.getHelperBags(locationId, { includeIdle: true });
      if (alive.current) setData(res && res.data ? res.data : null);
    } catch {
      // Card is extra information: keep what was shown, try again on the next visit.
    }
  }, [locationId]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setData(null); hide(); }, [locationId, hide]);

  // Refresh on every visit; leaving the screen hides any revealed amount.
  useFocusEffect(useCallback(() => {
    load();
    return () => hide();
  }, [load, hide]));

  // The PIN lock no longer blurs the screen: hide on lock, refresh on unlock.
  const wasLocked = useRef(locked);
  useEffect(() => {
    if (locked) hide();
    if (wasLocked.current && !locked) load();
    wasLocked.current = locked;
  }, [locked, load, hide]);

  useEffect(() => () => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    if (noteTimer.current) clearTimeout(noteTimer.current);
  }, []);

  const showNote = (text) => {
    setNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), NOTE_MS);
  };

  // One tap = one reveal (one audit row): the ref guard stops a fast double tap.
  const reveal = guard(async (bag) => {
    if (revealed && revealed.staff_id === bag.staff_id) { hide(); return; }
    setRevealing(bag.staff_id);
    try {
      const res = await api.revealHelperBag(bag.staff_id, locationId);
      if (!alive.current) return;
      if (revealTimer.current) clearTimeout(revealTimer.current);
      setRevealed({ staff_id: bag.staff_id, ...(res && res.data) });
      revealTimer.current = setTimeout(() => { revealTimer.current = null; setRevealed(null); }, REVEAL_MS);
    } catch (err) {
      showAlert("Couldn't show the amount", err && err.status ? err.message : 'Check the internet and tap the name again.');
    } finally {
      if (alive.current) setRevealing(null);
    }
  });

  const openReceive = (bag) => { hide(); setReceiveFor({ staff_id: bag.staff_id, name: bag.name }); };

  const helpers = (data && data.helpers) || [];
  const openFloat = (bag) => {
    if (bag) {
      const known = helpers.find((h) => h.staff_id === bag.staff_id);
      const last = revealed && revealed.staff_id === bag.staff_id && revealed.last_float ? revealed.last_float.amount : (known ? known.last_float : null);
      hide();
      setFloatOpen({ helpers: [{ staff_id: bag.staff_id, name: bag.name, last_float: last }], initialStaffId: bag.staff_id });
    } else {
      setFloatOpen({ helpers, initialStaffId: null });
    }
  };

  const sheets = (
    <>
      <ReceiveCashSheet
        visible={!!receiveFor}
        helper={receiveFor}
        locationId={locationId}
        onClose={() => setReceiveFor(null)}
        onDone={(r) => { showNote(handoverDoneText(r)); load(); onChanged && onChanged(); }}
        onStale={load}
      />
      <GiveFloatSheet
        visible={!!floatOpen}
        locationId={locationId}
        helpers={floatOpen ? floatOpen.helpers : []}
        initialStaffId={floatOpen ? floatOpen.initialStaffId : null}
        onClose={() => setFloatOpen(null)}
        onDone={(r) => { showNote(r.message); load(); onChanged && onChanged(); }}
      />
    </>
  );

  if (!data || data.mode !== 'bag') return null;
  const bags = data.bags || [];

  const noteView = note ? (
    <View style={styles.note} accessibilityLiveRegion="polite">
      <Ionicons name="checkmark-circle" size={20} color={Colors.success} />
      <Text style={styles.noteText}>{note}</Text>
    </View>
  ) : null;

  if (bags.length === 0) {
    if (helpers.length === 0 && !note) return null;
    return (
      <View>
        {noteView}
        {helpers.length > 0 && (
          <TouchableOpacity style={styles.compactRow} onPress={() => openFloat(null)} accessibilityRole="button">
            <Ionicons name="cash-outline" size={20} color={Colors.text} />
            <Text style={styles.compactText}>Give change to a helper</Text>
            <Ionicons name="chevron-forward" size={16} color={Colors.text} />
          </TouchableOpacity>
        )}
        {sheets}
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <Ionicons name="wallet-outline" size={22} color={Colors.text} />
        <Text style={styles.title}>Cash with helpers</Text>
        <Text style={styles.total}>{data.total_masked}</Text>
      </View>

      {bags.map((b) => {
        const open = revealed && revealed.staff_id === b.staff_id ? revealed : null;
        return (
          <View key={b.staff_id} style={[styles.row, open && styles.rowOpen]}>
            <View style={styles.rowTop}>
              <TouchableOpacity
                style={styles.nameArea}
                onPress={() => reveal(b)}
                accessibilityRole="button"
                accessibilityLabel={open ? `${b.name} has ${rupees(open.held)}. Tap to hide.` : `${b.name}, amount hidden. Tap to see it.`}
              >
                <Text style={styles.name}>{b.name}{b.access_ended ? '  ' : ''}{b.access_ended ? <Text style={styles.ended}>(access ended)</Text> : null}</Text>
                <Text style={styles.meta}>
                  {revealing === b.staff_id ? 'Getting the amount…' : `${open ? rupees(open.held) : b.held_masked} · ${b.sale_count} sale${b.sale_count === 1 ? '' : 's'}`}
                </Text>
              </TouchableOpacity>
              {!open && b.has_cash !== false && (
                <TouchableOpacity style={styles.receiveSmall} onPress={() => openReceive(b)} accessibilityRole="button" accessibilityLabel={`Receive cash from ${b.name}`}>
                  <Text style={styles.receiveSmallText}>Receive</Text>
                </TouchableOpacity>
              )}
            </View>
            {open && (
              <View style={styles.reveal}>
                <Text style={styles.exact}>{rupees(open.held)}</Text>
                <Text style={styles.breakdown}>
                  Change given {rupees(open.floats)} · Cash sales {rupees(open.cash_sales)} · Handed over {rupees(open.settled)}
                </Text>
                <Text style={styles.hidesSoon}>Hides again in 15 seconds</Text>
                <View style={styles.actions}>
                  <TouchableOpacity style={styles.primary} onPress={() => openReceive(b)} accessibilityRole="button">
                    <Ionicons name="arrow-down-circle-outline" size={20} color={Colors.white} />
                    <Text style={styles.primaryText}>Receive cash</Text>
                  </TouchableOpacity>
                  {!b.access_ended && (
                    <TouchableOpacity style={styles.secondary} onPress={() => openFloat(b)} accessibilityRole="button">
                      <Ionicons name="arrow-up-circle-outline" size={20} color={Colors.primary} />
                      <Text style={styles.secondaryText}>Give float</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}
          </View>
        );
      })}

      <Text style={styles.hint}>tap a name to see the exact amount or collect</Text>
      {noteView}
      {helpers.length > 0 && (
        <TouchableOpacity style={styles.giveRow} onPress={() => openFloat(null)} accessibilityRole="button">
          <Ionicons name="cash-outline" size={20} color={Colors.primary} />
          <Text style={styles.giveText}>Give change to a helper</Text>
        </TouchableOpacity>
      )}
      {sheets}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md, marginBottom: Spacing.sm,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.sm },
  title: { flex: 1, fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  total: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] },
  row: { borderTopWidth: 1, borderTopColor: Colors.border, paddingVertical: Spacing.sm },
  rowOpen: { backgroundColor: Colors.surfaceAlt },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  nameArea: { flex: 1, minHeight: 48, justifyContent: 'center' },
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  ended: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary },
  meta: { fontSize: FontSize.md, color: Colors.textSecondary, fontVariant: ['tabular-nums'], marginTop: 2 },
  receiveSmall: {
    minHeight: 48, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.md, backgroundColor: Colors.success,
    alignItems: 'center', justifyContent: 'center',
  },
  receiveSmallText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '800' },
  reveal: { paddingTop: Spacing.xs },
  exact: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] },
  breakdown: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2, fontVariant: ['tabular-nums'] },
  hidesSoon: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.sm },
  primary: {
    flexGrow: 1, minHeight: 52, flexDirection: 'row', gap: Spacing.xs, alignItems: 'center', justifyContent: 'center',
    borderRadius: BorderRadius.md, backgroundColor: Colors.success, paddingHorizontal: Spacing.md,
  },
  primaryText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '800' },
  secondary: {
    flexGrow: 1, minHeight: 52, flexDirection: 'row', gap: Spacing.xs, alignItems: 'center', justifyContent: 'center',
    borderRadius: BorderRadius.md, borderWidth: 2, borderColor: Colors.primary, paddingHorizontal: Spacing.md,
  },
  secondaryText: { color: Colors.primary, fontSize: FontSize.md, fontWeight: '700' },
  hint: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.xs },
  giveRow: {
    marginTop: Spacing.sm, minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
  },
  giveText: { color: Colors.primary, fontSize: FontSize.md, fontWeight: '700' },
  note: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs, marginTop: Spacing.sm, padding: Spacing.sm,
    borderRadius: BorderRadius.md, backgroundColor: Colors.successLight,
  },
  noteText: { flex: 1, fontSize: FontSize.md, color: Colors.text, lineHeight: 22 },
  compactRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 48, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, backgroundColor: Colors.warningLight, marginBottom: Spacing.sm,
  },
  compactText: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
});
