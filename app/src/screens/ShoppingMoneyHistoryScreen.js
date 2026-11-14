/**
 * ShoppingMoneyHistoryScreen — "Shopping money history" (spec 4.7), owner
 * and manager, from the card's "See all". Every hand-out, newest first: who
 * got it, who gave it, who confirmed it, the bills, the change and the
 * status. Filter: All / Still out / Closed, and by person. An open line can
 * be settled from here ("Ramesh is back").
 *
 * Params: { locationId? }
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { historyStatus, shortDate, firstName, rupeesText } from '../utils/staffMoney';
import OptionList from '../components/expenses/OptionList';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'open', label: 'Still out' },
  { key: 'closed', label: 'Closed' },
];
const METHOD = { cash: 'Cash', upi: 'UPI' };

export default function ShoppingMoneyHistoryScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { user, activeLocation } = useAuth();
  const locationId = route.params?.locationId || activeLocation?.id || null;
  const isBoss = user?.role === 'owner' || user?.role === 'manager';

  const [status, setStatus] = useState('');
  const [person, setPerson] = useState(null); // { id, name }
  const [people, setPeople] = useState([]);
  const [showPeople, setShowPeople] = useState(false);
  const [rows, setRows] = useState([]);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [openId, setOpenId] = useState(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    if (!locationId) { setState('error'); return; }
    const rid = ++reqId.current;
    setState('loading');
    try {
      const params = { location_id: locationId };
      if (status) params.status = status;
      if (person) params.user_id = person.id;
      const res = await api.getStaffMoneyHistory(params);
      if (rid !== reqId.current) return;
      setRows((res && res.data) || []);
      setState('ready');
    } catch {
      if (rid === reqId.current) setState('error');
    }
  }, [locationId, status, person && person.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => {
    if (!locationId) return;
    api.getStaffMoneyPeople({ location_id: locationId })
      .then((res) => setPeople((res && res.data) || []))
      .catch(() => setPeople([]));
  }, [locationId]);

  if (!isBoss) {
    return (
      <View style={styles.center}>
        <Text style={styles.centerText}>Only the owner or a manager can see the shopping money history.</Text>
      </View>
    );
  }

  const personOptions = [{ key: 'all', label: 'Everyone', selected: !person }]
    .concat(people.map((p) => ({ key: String(p.id), label: p.name, selected: !!person && Number(person.id) === Number(p.id) })));

  const header = (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {FILTERS.map((f) => (
          <TouchableOpacity
            key={f.key || 'all'}
            style={[styles.chip, status === f.key && styles.chipActive]}
            onPress={() => setStatus(f.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: status === f.key }}
          >
            <Text style={[styles.chipText, status === f.key && styles.chipTextActive]}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <TouchableOpacity style={styles.personRow} onPress={() => setShowPeople(true)} accessibilityRole="button" accessibilityLabel={`Person: ${person ? person.name : 'Everyone'}`}>
        <Text style={styles.personLabel}>Person</Text>
        <Text style={styles.personValue} numberOfLines={1}>{person ? person.name : 'Everyone'}</Text>
        <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />
      </TouchableOpacity>
    </View>
  );

  const renderItem = ({ item: r }) => {
    const open = openId === r.id;
    const changeBack = (r.settles || []).filter((x) => Number(x.returned_amount) > 0);
    return (
      <View style={styles.row}>
        <TouchableOpacity
          style={styles.rowTop}
          onPress={() => setOpenId(open ? null : r.id)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`${r.user_name}, ${rupeesText(r.amount)}, ${historyStatus(r.status)}`}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.name} numberOfLines={1}>{r.user_name}</Text>
            <Text style={styles.meta}>
              {shortDate(r.created_at)}{r.given_by_name ? ` · given by ${firstName(r.given_by_name)}` : ''}
              {r.approved_by_name ? ` · confirmed by ${firstName(r.approved_by_name)}` : ''}
            </Text>
          </View>
          <View style={styles.right}>
            <Text style={styles.amount}>{rupeesText(r.amount)}</Text>
            <Text style={[styles.status, r.status === 'open' && styles.statusOpen]}>
              {r.status === 'open' ? `${rupeesText(r.remaining)} still out` : historyStatus(r.status)}
            </Text>
          </View>
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={Colors.textLight} />
        </TouchableOpacity>
        {open && (
          <View style={styles.detail}>
            <Text style={styles.detailLine}>Given {METHOD[r.payment_method] ? `in ${METHOD[r.payment_method]}` : ''}{r.note ? ` · ${r.note}` : ''}</Text>
            {(r.bills || []).length === 0 && changeBack.length === 0 && (
              <Text style={styles.detailMuted}>Nothing accounted for yet.</Text>
            )}
            {(r.bills || []).map((b) => (
              <View key={`b${b.id}`} style={styles.detailRow}>
                <Text style={styles.detailText} numberOfLines={2}>{b.description}</Text>
                <Text style={styles.detailAmount}>{rupeesText(b.amount)}</Text>
              </View>
            ))}
            {changeBack.map((x) => (
              <View key={`c${x.id}`} style={styles.detailRow}>
                <Text style={styles.detailText}>
                  Change back{x.returned_method ? ` (${METHOD[x.returned_method] || x.returned_method})` : ''} · {shortDate(x.created_at)}
                  {x.settled_by_name ? ` · ${firstName(x.settled_by_name)}` : ''}
                </Text>
                <Text style={styles.detailAmount}>{rupeesText(x.returned_amount)}</Text>
              </View>
            ))}
            {!!r.close_reason && r.status === 'written_off' && (
              <Text style={styles.detailMuted}>Why: {r.close_reason}</Text>
            )}
            {r.status === 'open' && (
              <TouchableOpacity
                style={styles.settleBtn}
                onPress={() => navigation.navigate('ShoppingMoneyBack', { id: r.id, locationId })}
                accessibilityRole="button"
              >
                <Text style={styles.settleText}>{firstName(r.user_name)} is back ›</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <FlatList
        data={state === 'ready' ? rows : []}
        keyExtractor={(r) => String(r.id)}
        renderItem={renderItem}
        ListHeaderComponent={header}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            {state === 'loading' ? <ActivityIndicator color={Colors.primary} /> : state === 'error' ? (
              <>
                <Text style={styles.centerText}>Couldn't load the history. Check the internet, then tap Try again.</Text>
                <TouchableOpacity style={styles.retryBtn} onPress={load} accessibilityRole="button">
                  <Text style={styles.retryText}>Try again</Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={styles.centerText}>No shopping money here yet.</Text>
            )}
          </View>
        }
      />
      <OptionList
        visible={showPeople}
        title="Whose shopping money?"
        options={personOptions}
        search={personOptions.length > 8}
        onClose={() => setShowPeople(false)}
        onPick={(o) => {
          setShowPeople(false);
          setOpenId(null);
          setPerson(o.key === 'all' ? null : { id: Number(o.key), name: o.label });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  list: { padding: Spacing.md, paddingBottom: Spacing.xxl, width: '100%', maxWidth: 720, alignSelf: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg, backgroundColor: Colors.background },
  centerText: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center' },
  empty: { alignItems: 'center', paddingTop: Spacing.xl, gap: Spacing.md },
  retryBtn: { minHeight: 48, justifyContent: 'center', paddingHorizontal: Spacing.lg, borderRadius: BorderRadius.md, backgroundColor: Colors.primary },
  retryText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.md },

  chipRow: { gap: Spacing.sm, paddingBottom: Spacing.sm },
  chip: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.full, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.md, color: Colors.textSecondary, fontWeight: '600' },
  chipTextActive: { color: Colors.white, fontWeight: '700' },
  personRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 52, marginBottom: Spacing.sm,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  personLabel: { fontSize: FontSize.md, color: Colors.textSecondary, minWidth: 80 },
  personValue: { flex: 1, textAlign: 'right', fontSize: FontSize.md, fontWeight: '600', color: Colors.text },

  row: { borderBottomWidth: 1, borderBottomColor: Colors.border },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 64, paddingVertical: Spacing.sm },
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  meta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  right: { alignItems: 'flex-end' },
  amount: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] },
  status: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  statusOpen: { color: Colors.text, fontWeight: '700' },
  detail: { paddingBottom: Spacing.md, paddingLeft: Spacing.sm },
  detailLine: { fontSize: FontSize.md, color: Colors.textSecondary, marginBottom: Spacing.xs },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 36 },
  detailText: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  detailAmount: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, fontVariant: ['tabular-nums'] },
  detailMuted: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.xs },
  settleBtn: {
    marginTop: Spacing.sm, minHeight: 48, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary,
  },
  settleText: { color: Colors.primary, fontSize: FontSize.md, fontWeight: '700' },
});
