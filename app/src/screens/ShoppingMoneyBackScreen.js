/**
 * ShoppingMoneyBackScreen — "Ramesh is back — what was bought?" (spec 3, 4.4).
 *
 *   Ramesh is back — what was bought?
 *   Had ₹500 · given 12 Nov by Priya
 *   ─────────────────────────────────
 *   Roses            ₹300            ✕
 *   What was bought?  [Roses     ] ₹ [300]  (Usual now / Often rows, type-ahead)
 *   + Add another
 *   Change back       ₹ [ 200 ]   [ Cash | UPI ]
 *   ─────────────────────────────────
 *   Still with Ramesh  ₹0
 *   [               Done               ]
 *   Save, rest later
 *
 * The line being typed counts as soon as it has a name and an amount, so the
 * common case is: tap the card line → tap Roses → Done. Change back is
 * pre-filled with what is left until it is typed over. Bills beyond what he
 * had become Shop owes (the server makes the line); after Done the screen
 * offers Pay back now / Later. Owner: Write off with a reason.
 *
 * Params: { id, locationId? }
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import useSubmitGuard from '../hooks/useSubmitGuard';
import useRegisterStatus from '../hooks/useRegisterStatus';
import { showConfirm } from '../utils/alert';
import { suggestionSections, pickDefaults } from '../utils/expenseBook';
import {
  isBackTitle, hadLine, isBackSums, isBackError, overspendText, settleBody, billCheck,
  defaultChange, firstName, rupeesText, changeMethodDefault, canOfferRemove, removeConfirmText,
} from '../utils/staffMoney';
import MethodSwitch from '../components/expenses/MethodSwitch';
import PayBackSheet from '../components/expenses/PayBackSheet';
import OpenRegisterSheet from '../components/OpenRegisterSheet';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const METHODS = [{ key: 'cash', label: 'Cash' }, { key: 'upi', label: 'UPI' }];
const CHANGE_CLOSED_COPY = 'Open the register to put the change in the drawer — or pick UPI.';
const LOST_ERROR = 'No answer from the shop computer. Go back and check the card before trying again.';
const SUGGEST_MAX = 6;
const nameKey = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
let billSeq = 0;

export default function ShoppingMoneyBackScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { user, activeLocation } = useAuth();
  const id = Number(route.params?.id);
  const locationId = route.params?.locationId || activeLocation?.id || null;
  const isOwner = user?.role === 'owner';
  const register = useRegisterStatus(locationId);
  const guard = useSubmitGuard();

  // ── The line ──
  const [line, setLine] = useState(null);
  const [loadState, setLoadState] = useState('loading'); // loading | ready | gone | noshop | error
  const load = async () => {
    if (!locationId) { setLoadState('noshop'); return; }
    if (!id) { setLoadState('gone'); return; }
    setLoadState('loading');
    try {
      const res = await api.getOpenStaffMoney({ location_id: locationId });
      const found = ((res && res.data && res.data.shopping) || []).find((s) => Number(s.id) === id);
      setLine(found || null);
      setLoadState(found ? 'ready' : 'gone');
    } catch {
      setLoadState('error');
    }
  };
  useEffect(() => { load(); }, [id, locationId]);

  const left = line ? Number(line.remaining) || 0 : 0;
  const name = line ? firstName(line.user_name) : '';

  // ── Bills ──
  const [bills, setBills] = useState([]);
  const [pName, setPName] = useState('');
  const [pItem, setPItem] = useState(null); // { id, name, category } when picked from the list
  const [pAmount, setPAmount] = useState('');
  const [pError, setPError] = useState(null); // { field, error }
  const amountRef = useRef(null);
  const pendingTyped = pName.trim() !== '' || pAmount.trim() !== '';
  const pendingCheck = billCheck(pName, pAmount);
  const pendingBill = pendingTyped && !pendingCheck.error
    ? { key: 'pending', item_id: pItem && nameKey(pItem.name) === nameKey(pName) ? pItem.id : null, name: pName.trim(), category: pItem ? pItem.category : null, amount: pendingCheck.amount }
    : null;
  const allBills = pendingBill ? bills.concat(pendingBill) : bills;

  // Suggestions: Usual now / Often while the name box is empty, type-ahead after.
  const [sections, setSections] = useState({ usualNow: [], often: [] });
  const [typed, setTyped] = useState([]);
  const reqId = useRef(0);
  useEffect(() => {
    if (!locationId) return;
    api.getExpenseSuggestions({ location_id: locationId })
      .then((res) => setSections(suggestionSections(res, { hideSalary: true })))
      .catch(() => setSections({ usualNow: [], often: [] }));
  }, [locationId]);
  useEffect(() => {
    const q = pName.trim();
    const rid = ++reqId.current;
    if (!q || !locationId || (pItem && nameKey(pItem.name) === nameKey(q))) { setTyped([]); return undefined; }
    const t = setTimeout(() => {
      api.getExpenseSuggestions({ location_id: locationId, q })
        .then((res) => {
          if (rid !== reqId.current) return;
          const rows = (res.data || []).filter((r) => r.category !== 'salary');
          setTyped(rows.slice(0, SUGGEST_MAX));
          const exact = rows.find((r) => nameKey(r.name) === nameKey(q));
          if (exact) setPItem({ id: exact.id, name: exact.name, category: exact.category });
        })
        .catch(() => { if (rid === reqId.current) setTyped([]); });
    }, 250);
    return () => clearTimeout(t);
  }, [pName, locationId]);

  const pick = (s) => {
    reqId.current += 1;
    const d = pickDefaults(s);
    setPName(s.name);
    setPItem({ id: s.id, name: s.name, category: s.category });
    if (d.amount && !pAmount.trim()) setPAmount(String(d.amount));
    setTyped([]);
    setPError(null);
    setError('');
    if (!d.amount) setTimeout(() => amountRef.current?.focus(), 50);
  };
  const clearPending = () => { setPName(''); setPItem(null); setPAmount(''); setPError(null); setTyped([]); };
  const addPending = () => {
    if (pendingCheck.error) { setPError(pendingCheck); return; }
    setBills((b) => b.concat({ ...pendingBill, key: `b${++billSeq}` }));
    clearPending();
  };
  const removeBill = (key) => setBills((b) => b.filter((x) => x.key !== key));

  // ── Change back ──
  const [change, setChange] = useState('');
  const [changeTouched, setChangeTouched] = useState(false);
  // Cash while the register is open, UPI while it is closed, until picked.
  const [method, setMethod] = useState('cash');
  const methodTouched = useRef(false);
  useEffect(() => {
    if (!methodTouched.current && !register.loading) setMethod(changeMethodDefault(register.isOpen));
  }, [register.loading, register.isOpen]);
  const prefill = line ? String(defaultChange(left, allBills)) : '';
  useEffect(() => { if (!changeTouched) setChange(prefill); }, [prefill, changeTouched]);

  const sums = isBackSums(left, allBills, change);
  const changeCash = method === 'cash' && (sums.change || 0) > 0;
  const changeClosed = changeCash && !register.loading && !register.isOpen;

  // ── Save ──
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needRegister, setNeedRegister] = useState(null); // null | { final } | 'open'
  const [result, setResult] = useState(null); // { over, owes } after an overspent save
  const [payFor, setPayFor] = useState(null);
  const saved = useRef(false);

  const dirty = bills.length > 0 || pendingTyped || changeTouched;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty && !saved.current;
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      showConfirm('Leave without saving?', 'What you typed here will be lost.', () => navigation.dispatch(e.data.action),
        { confirmLabel: 'Leave', cancelLabel: 'Stay', destructive: true });
    });
    return unsub;
  }, [navigation]);

  const leave = () => { saved.current = true; dirtyRef.current = false; navigation.goBack(); };

  const send = async (final) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.settleShoppingMoney(id, settleBody(allBills, sums, method, final));
      saved.current = true;
      dirtyRef.current = false;
      const data = (res && res.data) || {};
      if (data.owes_id) {
        let owes = null;
        try {
          const open = await api.getOpenStaffMoney({ location_id: locationId });
          owes = ((open && open.data && open.data.owes) || []).find((o) => Number(o.id) === Number(data.owes_id)) || null;
        } catch {}
        setBusy(false);
        setResult({ over: sums.over, owes, remaining: data.remaining, status: data.status });
        return;
      }
      setBusy(false);
      leave();
    } catch (err) {
      setBusy(false);
      if (err && err.status === 400 && /open the register/i.test(err.message || '')) {
        register.refetch();
        setError(CHANGE_CLOSED_COPY);
        return;
      }
      if (err && err.status === 409) { setError(err.message || 'Already done — refresh.'); load(); return; }
      if (!err || !err.status || err.status >= 500) { setError(LOST_ERROR); return; }
      setError(err.message);
    }
  };

  const submit = (final) => guard(async () => {
    if (pendingTyped && pendingCheck.error) { setPError(pendingCheck); return; }
    const msg = isBackError(line ? line.user_name : '', sums, final);
    if (msg) { setError(msg); return; }
    if (changeClosed) { setNeedRegister({ final }); return; }
    await send(final);
  });

  // ── Owner: write off ──
  const [writeOff, setWriteOff] = useState(false);
  const [reason, setReason] = useState('');
  const doWriteOff = guard(async () => {
    const why = reason.trim();
    if (!why) { setError('Type why this money is written off.'); return; }
    setBusy(true);
    setError('');
    try {
      await api.writeOffShoppingMoney(id, { reason: why });
      setBusy(false);
      leave();
    } catch (err) {
      setBusy(false);
      setError(err && err.status && err.status < 500 ? err.message : LOST_ERROR);
    }
  });

  // ── Remove a hand-out typed by mistake (spec 5.4). The server decides who
  // and when (the giver in the same open session, or owner/manager). ──
  const doRemove = guard(async () => {
    setBusy(true);
    setError('');
    try {
      await api.cancelShoppingMoney(id);
      setBusy(false);
      leave();
    } catch (err) {
      setBusy(false);
      if (err && err.status === 409) load();
      setError(err && err.status && err.status < 500 ? err.message : LOST_ERROR);
    }
  });
  const askRemove = () => showConfirm('Remove this shopping money?', removeConfirmText(line), doRemove,
    { confirmLabel: 'Remove', cancelLabel: 'Keep it', destructive: true });

  // ── Render ──
  if (loadState !== 'ready' && !result) {
    return (
      <View style={styles.center}>
        {loadState === 'loading' ? <ActivityIndicator color={Colors.primary} /> : (
          <>
            <Text style={styles.centerText}>
              {loadState === 'error'
                ? "Couldn't load this. Check the internet, then tap Try again."
                : loadState === 'noshop'
                  ? "Couldn't tell which shop this is from. Go back and tap it on the Shopping money out card."
                  : 'This shopping money is already accounted for. Go back to see what is still out.'}
            </Text>
            <TouchableOpacity style={styles.retryBtn} onPress={loadState === 'error' ? load : () => navigation.goBack()} accessibilityRole="button">
              <Text style={styles.retryText}>{loadState === 'error' ? 'Try again' : 'Go back'}</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    );
  }

  if (result) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <View style={styles.doneHead}>
          <Ionicons name="checkmark-circle" size={28} color={Colors.success} />
          <Text style={styles.title}>Saved</Text>
        </View>
        <Text style={styles.body}>{overspendText(line ? line.user_name : '', result.over)}</Text>
        {result.owes ? (
          <TouchableOpacity style={styles.primary} onPress={() => setPayFor(result.owes)} accessibilityRole="button">
            <Text style={styles.primaryText}>Pay back now</Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.hint}>Pay it back from Shop owes on the card.</Text>
        )}
        <TouchableOpacity style={styles.secondary} onPress={leave} accessibilityRole="button">
          <Text style={styles.secondaryText}>Later</Text>
        </TouchableOpacity>
        <Text style={styles.hint}>Later keeps it under Shop owes on the card.</Text>
        <PayBackSheet
          visible={!!payFor}
          line={payFor}
          locationId={locationId}
          onClose={() => setPayFor(null)}
          onDone={leave}
        />
      </ScrollView>
    );
  }

  const suggestRows = pName.trim()
    ? typed
    : sections.usualNow.concat(sections.often).slice(0, SUGGEST_MAX);
  const showSuggest = suggestRows.length > 0 && !(pItem && nameKey(pItem.name) === nameKey(pName));

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{isBackTitle(line.user_name)}</Text>
        <Text style={styles.sub}>{hadLine(left, line.created_at, line.given_by_name)}</Text>
        {line.late && <Text style={styles.lateText}>Out for {line.days} days — later than usual.</Text>}

        <View style={styles.divider} />

        {bills.map((b) => (
          <View key={b.key} style={styles.billRow}>
            <Text style={styles.billName} numberOfLines={2}>{b.name}</Text>
            <Text style={styles.billAmount}>{rupeesText(b.amount)}</Text>
            <TouchableOpacity style={styles.removeBtn} onPress={() => removeBill(b.key)} accessibilityRole="button" accessibilityLabel={`Remove ${b.name}`}>
              <Ionicons name="close" size={22} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
        ))}

        {/* The thing being typed (counts once it has a name and an amount) */}
        <Text style={styles.label}>{bills.length ? 'Anything else bought?' : 'What was bought?'}</Text>
        <View style={styles.adderRow}>
          <TextInput
            style={[styles.input, styles.nameInput, pError?.field === 'name' && styles.inputError]}
            value={pName}
            onChangeText={(t) => { setPName(t); setPError(null); setError(''); }}
            placeholder="Like Roses"
            placeholderTextColor={Colors.textLight}
            maxLength={80}
            returnKeyType="next"
            onSubmitEditing={() => amountRef.current?.focus()}
            accessibilityLabel="What was bought?"
          />
          <View style={[styles.input, styles.amountBox, pError?.field === 'amount' && styles.inputError]}>
            <Text style={styles.rupee}>₹</Text>
            <TextInput
              ref={amountRef}
              style={styles.amountInput}
              value={pAmount}
              onChangeText={(t) => { setPAmount(t.replace(/[^0-9.]/g, '')); setPError(null); setError(''); }}
              placeholder="0"
              placeholderTextColor={Colors.textLight}
              keyboardType="decimal-pad"
              accessibilityLabel="How much it cost in rupees"
            />
          </View>
        </View>
        {!!pError && <Text style={styles.error}>{pError.error}</Text>}
        {showSuggest && (
          <View style={styles.suggestList}>
            {suggestRows.map((s) => {
              const d = pickDefaults(s);
              return (
                <TouchableOpacity key={s.id} style={styles.suggestRow} onPress={() => pick(s)} accessibilityRole="button"
                  accessibilityLabel={`${s.name}${d.amount ? `, ${rupeesText(d.amount)}` : ''}`}>
                  <Text style={styles.suggestName} numberOfLines={1}>{s.name}</Text>
                  {!!d.amount && <Text style={styles.suggestAmount}>{rupeesText(d.amount)}</Text>}
                </TouchableOpacity>
              );
            })}
          </View>
        )}
        <TouchableOpacity style={styles.addRow} onPress={pendingTyped ? addPending : () => setPError({ field: 'name', error: 'Type what was bought, like Roses.' })} accessibilityRole="button">
          <Ionicons name="add" size={22} color={Colors.primary} />
          <Text style={styles.addText}>Add another</Text>
        </TouchableOpacity>

        {sums.over > 0 && (
          <View style={styles.overBox}>
            <Ionicons name="information-circle-outline" size={20} color={Colors.text} />
            <Text style={styles.overText}>{overspendText(line.user_name, sums.over)} You can pay it back after Done.</Text>
          </View>
        )}

        {/* Change back */}
        <Text style={styles.label}>Change back</Text>
        <View style={styles.changeRow}>
          <View style={[styles.input, styles.amountBox, styles.changeBox, sums.changeError && styles.inputError]}>
            <Text style={styles.rupee}>₹</Text>
            <TextInput
              style={styles.amountInput}
              value={change}
              onChangeText={(t) => { setChange(t.replace(/[^0-9.]/g, '')); setChangeTouched(true); setError(''); }}
              placeholder="0"
              placeholderTextColor={Colors.textLight}
              keyboardType="decimal-pad"
              selectTextOnFocus
              accessibilityLabel="Change brought back in rupees"
            />
          </View>
          <View style={styles.changeMethod}>
            <MethodSwitch value={method} options={METHODS} onChange={(k) => { methodTouched.current = true; setMethod(k); setError(''); }} />
          </View>
        </View>
        {changeClosed && (
          <View style={styles.closedRow}>
            <Text style={styles.closedText}>{CHANGE_CLOSED_COPY}</Text>
            <TouchableOpacity style={styles.openRegBtn} onPress={() => setNeedRegister('open')} accessibilityRole="button">
              <Ionicons name="lock-open-outline" size={18} color={Colors.primary} />
              <Text style={styles.openRegText}>Open Register</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.divider} />
        <View style={styles.stillRow}>
          <Text style={styles.stillLabel}>Still with {name}</Text>
          <Text style={styles.stillAmount}>{rupeesText(sums.still)}</Text>
        </View>

        {!!error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity
          style={[styles.primary, (busy || !sums.canDone) && styles.primaryOff]}
          onPress={submit(true)}
          disabled={busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy || !sums.canDone }}
        >
          {busy ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.primaryText}>Done</Text>}
        </TouchableOpacity>
        <TouchableOpacity style={styles.linkRow} onPress={submit(false)} disabled={busy} accessibilityRole="button">
          <Text style={styles.linkText}>Save, rest later</Text>
        </TouchableOpacity>

        {canOfferRemove(line) && !writeOff && bills.length === 0 && (
          <TouchableOpacity style={styles.linkRow} onPress={askRemove} disabled={busy} accessibilityRole="button">
            <Text style={styles.mutedLink}>Remove (typed by mistake)</Text>
          </TouchableOpacity>
        )}
        {isOwner && !writeOff && (
          <TouchableOpacity style={styles.linkRow} onPress={() => { setWriteOff(true); setError(''); }} disabled={busy} accessibilityRole="button">
            <Text style={styles.mutedLink}>Write off</Text>
            <Ionicons name="chevron-forward" size={18} color={Colors.textSecondary} />
          </TouchableOpacity>
        )}
        {isOwner && writeOff && (
          <View style={styles.writeOff}>
            <Text style={styles.hint}>
              The {rupeesText(left)} still with {name} becomes an expense "Shopping money written off — {line.user_name}". The drawer does not change.
            </Text>
            <Text style={styles.label}>Why?</Text>
            <TextInput
              style={styles.input}
              value={reason}
              onChangeText={(t) => { setReason(t); setError(''); }}
              placeholder="Like: lost the bills"
              placeholderTextColor={Colors.textLight}
              maxLength={300}
              accessibilityLabel="Why it is written off"
            />
            <TouchableOpacity style={styles.danger} onPress={doWriteOff} disabled={busy} accessibilityRole="button">
              <Text style={styles.dangerText}>Write off {rupeesText(left)}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.linkRow} onPress={() => setWriteOff(false)} disabled={busy} accessibilityRole="button">
              <Text style={styles.mutedLink}>Don't write off</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <OpenRegisterSheet
        visible={!!needRegister}
        locationId={locationId}
        actionLabel="take the change"
        onClose={() => setNeedRegister(null)}
        onOpened={() => {
          const then = needRegister;
          setNeedRegister(null);
          register.refetch();
          setError('');
          if (then && typeof then === 'object') send(then.final);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: Spacing.xxl, width: '100%', maxWidth: 640, alignSelf: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg, gap: Spacing.md, backgroundColor: Colors.background },
  centerText: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center' },
  retryBtn: { minHeight: 48, justifyContent: 'center', paddingHorizontal: Spacing.lg, borderRadius: BorderRadius.md, backgroundColor: Colors.primary },
  retryText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.md },

  title: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  sub: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.xs },
  lateText: { fontSize: FontSize.md, color: Colors.error, fontWeight: '700', marginTop: Spacing.xs },
  divider: { height: 1, backgroundColor: Colors.border, marginVertical: Spacing.md },

  billRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 52, borderBottomWidth: 1, borderBottomColor: Colors.border },
  billName: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  billAmount: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] },
  removeBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },

  label: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.md, marginBottom: Spacing.xs },
  adderRow: { flexDirection: 'row', gap: Spacing.sm },
  input: {
    minHeight: 52, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, fontSize: FontSize.md, color: Colors.text, backgroundColor: Colors.surface,
  },
  inputError: { borderColor: Colors.error },
  nameInput: { flex: 1, minWidth: 0 },
  amountBox: { flexDirection: 'row', alignItems: 'center', width: 120 },
  rupee: { fontSize: FontSize.md, fontWeight: '700', color: Colors.textSecondary, marginRight: Spacing.xs },
  amountInput: { flex: 1, minWidth: 0, minHeight: 50, fontSize: FontSize.md, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] },

  suggestList: { marginTop: Spacing.xs },
  suggestRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 48, borderBottomWidth: 1, borderBottomColor: Colors.border },
  suggestName: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  suggestAmount: { fontSize: FontSize.md, color: Colors.textSecondary, fontVariant: ['tabular-nums'] },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 48, alignSelf: 'flex-start', marginTop: Spacing.xs },
  addText: { color: Colors.primary, fontSize: FontSize.md, fontWeight: '700' },

  overBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs, marginTop: Spacing.sm, padding: Spacing.sm,
    borderRadius: BorderRadius.md, backgroundColor: Colors.warningLight,
  },
  overText: { flex: 1, fontSize: FontSize.md, color: Colors.text },

  changeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, alignItems: 'center' },
  changeBox: { width: 140 },
  changeMethod: { flexGrow: 1, minWidth: 160 },
  closedRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.sm },
  closedText: { flex: 1, minWidth: 180, fontSize: FontSize.md, color: Colors.text },
  openRegBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 44, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary,
  },
  openRegText: { color: Colors.primary, fontWeight: '700', fontSize: FontSize.md },

  stillRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stillLabel: { fontSize: FontSize.md, color: Colors.textSecondary, fontWeight: '600' },
  stillAmount: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] },

  error: { color: Colors.error, fontSize: FontSize.md, marginTop: Spacing.sm },
  hint: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.sm },
  body: { fontSize: FontSize.md, color: Colors.text, marginTop: Spacing.sm, lineHeight: 22 },
  doneHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },

  primary: {
    marginTop: Spacing.lg, minHeight: 56, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.primary, paddingHorizontal: Spacing.md,
  },
  primaryOff: { opacity: 0.5 },
  primaryText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '800' },
  secondary: {
    marginTop: Spacing.sm, minHeight: 52, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  secondaryText: { color: Colors.text, fontSize: FontSize.md, fontWeight: '700' },
  linkRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs, minHeight: 48, marginTop: Spacing.xs },
  linkText: { color: Colors.primary, fontSize: FontSize.md, fontWeight: '700' },
  mutedLink: { color: Colors.textSecondary, fontSize: FontSize.md, fontWeight: '600' },
  writeOff: { marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border },
  danger: {
    marginTop: Spacing.md, minHeight: 52, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.error,
  },
  dangerText: { color: Colors.error, fontSize: FontSize.md, fontWeight: '800' },
});
