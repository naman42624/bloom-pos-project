/**
 * KmRateCard: the owner's "Km rate" row in Settings (rider km account spec
 * §6, §8). Shows the rate now and the date it counts from; a new rate is
 * typed with its "From" date (today unless picked) and saved on its own.
 * It also lists the items that count as Rider petrol, with a way to change
 * them (each item's page has the Rider petrol switch).
 *
 *   Km rate                         ₹3 a km · from 1 Nov
 *   New rate  [ ₹ 3.50 ]   From [ Today ▾ ]
 *   [ Save rate ]
 *   Counts as Rider petrol: Petrol ›
 *
 * Owner only (the parent shows it only to the owner).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../services/api';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import { showAlert } from '../../utils/alert';
import { kmRateProblem, dayLabel, shopToday, rateFromText } from '../../utils/riderKm';
import DateTimePickerModal from '../DateTimePickerModal';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromYmd = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : new Date();
};
const rateText = (r) => `₹${Number(r).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export default function KmRateCard({ navigation }) {
  const [rate, setRate] = useState(null); // { rate, effective_from }
  const [state, setState] = useState('loading'); // loading | ready | error
  const [items, setItems] = useState(null); // Rider petrol items, or null if not loaded
  const [text, setText] = useState('');
  const [from, setFrom] = useState(null); // 'YYYY-MM-DD' or null = today
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const res = await api.getKmRate();
      if (!alive.current) return;
      setRate(res.data || null);
      setState('ready');
    } catch {
      if (alive.current) setState('error');
    }
    try {
      const res = await api.getExpenseItems();
      if (alive.current) setItems((res.data || []).filter((i) => i.is_rider_petrol));
    } catch {
      if (alive.current) setItems(null);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const guard = useSubmitGuard();
  const save = guard(async () => {
    const t = text.trim();
    const problem = kmRateProblem(t);
    if (problem) { setError(problem); return; }
    setSaving(true);
    try {
      const body = { rate: t };
      if (from) body.effective_from = from;
      const res = await api.setKmRate(body);
      if (!alive.current) return;
      const d = res.data || {};
      setText('');
      setFrom(null);
      setNote(`Saved · ${rateText(d.rate)} a km ${rateFromText(d.effective_from)}`);
      load();
    } catch (err) {
      showAlert('Not saved', err?.message || 'The rate was not saved. Check the connection and try again.');
    } finally {
      if (alive.current) setSaving(false);
    }
  });

  const today = shopToday();
  const pastPicked = !!from && from < today;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title}>Km rate</Text>
        {state === 'ready' && rate && rate.effective_from && (
          <Text style={styles.now}>{`${rateText(rate.rate)} a km · ${rateFromText(rate.effective_from)}`}</Text>
        )}
      </View>
      {state === 'loading' && <ActivityIndicator color={Colors.primary} style={{ marginVertical: Spacing.sm }} />}
      {state === 'error' && (
        <TouchableOpacity style={styles.retry} onPress={() => { setState('loading'); load(); }} accessibilityRole="button">
          <Text style={styles.hint}>Couldn't load the km rate. Tap to try again.</Text>
        </TouchableOpacity>
      )}
      <Text style={styles.hint}>What a rider gets for each km of work. Their ride home is not paid.</Text>

      {!!note && (
        <View style={styles.note} accessibilityLiveRegion="polite">
          <Ionicons name="checkmark-circle" size={20} color={Colors.success} />
          <Text style={styles.noteText}>{note}</Text>
        </View>
      )}

      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>New rate</Text>
          <View style={[styles.inputWrap, !!error && styles.inputError]}>
            <Text style={styles.unit}>₹</Text>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={(t) => { setText(t.replace(/[^0-9.]/g, '')); setError(''); setNote(''); }}
              keyboardType="decimal-pad"
              placeholder={rate ? String(rate.rate) : '3'}
              placeholderTextColor={Colors.textLight}
              accessibilityLabel="New km rate in rupees"
            />
          </View>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>From</Text>
          <TouchableOpacity
            style={styles.dateBtn}
            onPress={() => setPicking(true)}
            accessibilityRole="button"
            accessibilityLabel={`Rate counts from ${from ? dayLabel(from) : 'today'}. Tap to pick a day.`}
          >
            <Text style={styles.dateText}>{from && from !== today ? dayLabel(from) : 'Today'}</Text>
            <Ionicons name="calendar-outline" size={20} color={Colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>
      {!!error && <Text style={styles.error}>{error}</Text>}
      {pastPicked && (
        <Text style={styles.hint}>An earlier day changes only km not settled yet. Settled km keep their old rate.</Text>
      )}
      <TouchableOpacity
        style={[styles.saveBtn, (saving || !text.trim()) && styles.btnOff]}
        onPress={save}
        disabled={saving || !text.trim()}
        accessibilityRole="button"
        accessibilityState={{ disabled: saving || !text.trim() }}
      >
        {saving ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.saveText}>Save rate</Text>}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.itemsRow}
        onPress={() => navigation.navigate('ExpenseItems')}
        accessibilityRole="button"
        accessibilityLabel="Items that count as Rider petrol. Tap to change."
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Counts as Rider petrol</Text>
          <Text style={styles.hint}>
            {items === null
              ? 'Open an item and turn on Rider petrol.'
              : items.length
                ? items.map((i) => i.name).join(', ')
                : 'No item yet. Open the Petrol item and turn on Rider petrol.'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={22} color={Colors.textSecondary} />
      </TouchableOpacity>

      <DateTimePickerModal
        visible={picking}
        mode="date"
        value={fromYmd(from || today)}
        title="The new rate counts from"
        onCancel={() => setPicking(false)}
        onConfirm={(d) => { setPicking(false); setFrom(ymd(d)); }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.sm, gap: Spacing.sm },
  head: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: Spacing.sm },
  title: { flex: 1, fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  now: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] },
  hint: { fontSize: FontSize.md, color: Colors.textSecondary },
  retry: { minHeight: 48, justifyContent: 'center' },
  note: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs, padding: Spacing.sm,
    borderRadius: BorderRadius.md, backgroundColor: Colors.successLight,
  },
  noteText: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  row: { flexDirection: 'row', gap: Spacing.sm },
  label: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginBottom: Spacing.xs },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: Spacing.md,
    backgroundColor: Colors.background, borderRadius: BorderRadius.sm, borderWidth: 1, borderColor: Colors.border,
  },
  inputError: { borderColor: Colors.error },
  unit: { fontSize: FontSize.md, color: Colors.textSecondary, marginRight: Spacing.xs },
  input: { flex: 1, minWidth: 0, fontSize: FontSize.md, color: Colors.text, paddingVertical: Spacing.sm },
  dateBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, paddingHorizontal: Spacing.md,
    backgroundColor: Colors.background, borderRadius: BorderRadius.sm, borderWidth: 1, borderColor: Colors.border,
  },
  dateText: { fontSize: FontSize.md, color: Colors.text },
  error: { fontSize: FontSize.md, color: Colors.error },
  saveBtn: {
    minHeight: 48, borderRadius: BorderRadius.md, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.md,
  },
  saveText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '700' },
  btnOff: { opacity: 0.5 },
  itemsRow: {
    flexDirection: 'row', alignItems: 'center', minHeight: 56, gap: Spacing.sm,
    borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: Spacing.sm,
  },
});
