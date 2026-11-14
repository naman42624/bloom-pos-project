/**
 * MoneyToStaffForm: Salary advance and Shopping money, shown inside the add
 * sheet (spec 4.2). Same plain look as the sheet.
 *
 *   ‹  Salary advance                               ✕
 *   Who                (Ramesh) (Asha) (Me)   More ›
 *   Amount             ₹ [ 300 ]
 *   Paid by            [ Cash | UPI ]
 *   Note               —                        ›
 *   Ramesh: ₹1,200 in advances not yet taken from pay
 *   [ A manager or owner must confirm … ]       only after a 409 needs_pin
 *   [         Give advance ₹300          ]
 *
 * ₹300 cash advance to a colleague: Add expense → Salary advance → Ramesh →
 * type 300 (the amount box takes focus after Who) → Give = 5 taps.
 *
 * The approver and PIN are sent only after the server asked for them (409
 * needs_pin); changing Who or the amount asks again from the start.
 *
 * Props:
 *   kind              'advance' | 'shopping'
 *   locationId, registerOpen, registerLoading?, register?
 *   onBack()          back to the expense form
 *   onClose()         close the whole sheet
 *   onDone(result)    { expense: null, removed: false, message }
 *   onRegisterOpened?
 *   closeRequest      bumps when Android back / the modal asks to close
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import { appAlert, showConfirm } from '../../utils/alert';
import {
  whoChips, unpaidAdvances, heldBy, moneyLine, parseGiveAmount, needsPinOf, pinMessage, firstName,
} from '../../utils/staffMoney';
import { OpenRegisterForm } from '../OpenRegisterSheet';
import MethodSwitch from './MethodSwitch';
import SheetRow from './SheetRow';
import OptionList from './OptionList';
import ApproverPin from './ApproverPin';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const CLOSED_CASH_MESSAGE = 'Open the register to give cash — or pick UPI.';
const PIN_MISSING_MESSAGE = 'Type the PIN, then tap Give again.';

const WORDS = {
  advance: { title: 'Salary advance', give: 'Give advance', done: 'salary advance', a11y: 'salary advance' },
  shopping: { title: 'Shopping money', give: 'Give shopping money', done: 'shopping money', a11y: 'shopping money' },
};

export default function MoneyToStaffForm({
  kind, locationId, registerOpen, registerLoading = false, register, onBack, onClose, onDone, onRegisterOpened, closeRequest,
}) {
  const w = WORDS[kind] || WORDS.advance;
  const { user } = useAuth();
  const meId = Number(user?.id);
  const isBoss = user?.role === 'owner' || user?.role === 'manager';

  // ── Who ──
  const [people, setPeople] = useState([]);
  const [peopleState, setPeopleState] = useState('loading');
  const [who, setWho] = useState(null); // { id, name }
  const [showMore, setShowMore] = useState(false);
  const loadPeople = () => {
    setPeopleState('loading');
    api.getStaffMoneyPeople({ location_id: locationId })
      .then((res) => { setPeople(res.data || []); setPeopleState('ready'); })
      .catch(() => setPeopleState('error'));
  };
  useEffect(() => { if (locationId) loadPeople(); }, [locationId]);

  // ── Form ──
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [errors, setErrors] = useState({});
  const [giving, setGiving] = useState(false);
  const amountRef = useRef(null);
  const scrollRef = useRef(null);

  // ── Register / method (Cash takes from the open drawer) ──
  const [openedHere, setOpenedHere] = useState(false);
  const [showOpenRegister, setShowOpenRegister] = useState(false);
  const isOpen = !!registerOpen || openedHere;
  const cashDisabled = !registerLoading && !isOpen;
  const [method, setMethod] = useState(registerOpen ? 'cash' : (registerLoading ? 'cash' : 'upi'));
  const autoMoved = useRef(false);
  useEffect(() => {
    if (registerLoading) return;
    if (cashDisabled && method === 'cash') { autoMoved.current = true; setMethod('upi'); }
    else if (!cashDisabled && autoMoved.current && method === 'upi') { autoMoved.current = false; setMethod('cash'); }
  }, [registerLoading, cashDisabled, method]);

  // ── PIN (only after the server asked) ──
  const [pinAsk, setPinAsk] = useState(null); // { reason, message }
  const [approverId, setApproverId] = useState(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinLocked, setPinLocked] = useState(false);
  const resetPin = () => { setPinAsk(null); setApproverId(null); setPin(''); setPinError(''); setPinLocked(false); };

  // ── The line under Note: advances not taken from pay / shopping money held ──
  const [figure, setFigure] = useState(null); // { userId, amount }
  const [openShopping, setOpenShopping] = useState([]);
  useEffect(() => {
    if (kind !== 'shopping' || !locationId) return;
    api.getOpenStaffMoney({ location_id: locationId })
      .then((res) => setOpenShopping(res.data?.shopping || []))
      .catch(() => setOpenShopping([]));
  }, [kind, locationId]);
  useEffect(() => {
    setFigure(null);
    if (!who || kind !== 'advance') return undefined;
    let cancelled = false;
    const id = Number(who.id);
    // Counter staff see only their own advances (spec 5.8), so the line is
    // shown to them for themselves only.
    const load = id === meId
      ? api.getMyStaffMoney().then((res) => Number(res.data?.advances_unpaid) || 0)
      : isBoss
        ? api.getSalaryAdvances({ user_id: id, status: 'approved' }).then((res) => unpaidAdvances(res.data, id))
        : null;
    if (load) load.then((amt) => { if (!cancelled) setFigure({ userId: id, amount: amt }); }).catch(() => {});
    return () => { cancelled = true; };
  }, [who?.id, kind]);
  const figureAmount = kind === 'shopping'
    ? (who ? heldBy(openShopping, who.id).amount : 0)
    : (figure && who && figure.userId === Number(who.id) ? figure.amount : 0);
  const line = who ? moneyLine(kind, who.name, figureAmount, { me: Number(who.id) === meId }) : null;

  const amt = parseGiveAmount(amount);
  const pickWho = (p) => {
    setWho(p ? { id: Number(p.id), name: p.name } : null);
    resetPin();
    setErrors((e) => ({ ...e, who: undefined }));
    if (p && !amount) setTimeout(() => amountRef.current?.focus(), 50);
  };

  // ── Close / back with unsaved input ──
  const dirty = !!who || amount !== '' || !!note.trim();
  const leave = (then) => {
    if (giving) return;
    if (!dirty) { then(); return; }
    showConfirm('Leave without saving?', 'What you typed here will be lost.', then,
      { confirmLabel: 'Leave', cancelLabel: 'Keep typing', destructive: true });
  };
  const firstClose = useRef(closeRequest);
  useEffect(() => {
    if (closeRequest !== firstClose.current) leave(onClose);
  }, [closeRequest]);

  // ── Give ──
  const guard = useSubmitGuard();
  const handleGive = async () => {
    const e = {};
    if (!who) e.who = 'Tap who gets the money.';
    if (amt === null) e.amount = 'Type an amount above ₹0, like 300.';
    if (pinAsk) {
      if (!approverId) e.pin = 'Tap the name of the person confirming.';
      else if (!/^\d{4}$/.test(pin)) e.pin = PIN_MISSING_MESSAGE;
    }
    setErrors(e);
    if (e.pin) setPinError(e.pin);
    if (Object.keys(e).length) {
      if (e.amount && !e.who) setTimeout(() => amountRef.current?.focus(), 50);
      return;
    }
    const body = {
      location_id: locationId, user_id: Number(who.id), amount: amt, payment_method: method,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    if (pinAsk) { body.approver_id = Number(approverId); body.approver_pin = pin; }
    setGiving(true);
    setPinError('');
    try {
      if (kind === 'shopping') await api.giveShoppingMoney(body);
      else await api.giveAdvance(body);
      setGiving(false);
      const toWhom = Number(who.id) === meId ? 'you' : firstName(who.name);
      onDone && onDone({ expense: null, removed: false, message: `Gave ${inr(amt)} ${w.done} to ${toWhom}` });
    } catch (err) {
      setGiving(false);
      setPin(''); // a PIN is never kept after an answer
      const reason = needsPinOf(err);
      if (reason) {
        setPinAsk({ reason, message: err.raw_message || pinMessage(reason, { name: firstName(who.name), kind }) });
        setPinLocked(false);
        // The box sits just above Give, at the end of the form: bring it into view.
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
        return;
      }
      const raw = String(err?.raw_message || '');
      if (pinAsk && [401, 403, 423].includes(Number(err?.status))) {
        setPinError(err.message);
        setPinLocked(Number(err.status) === 423);
        return;
      }
      if (method === 'cash' && /open the register|register isn.t open/i.test(raw)) {
        setOpenedHere(false);
        appAlert('Register is closed', CLOSED_CASH_MESSAGE, [
          { text: 'Open register', onPress: () => setShowOpenRegister(true) },
          { text: 'Pay by UPI', onPress: () => { autoMoved.current = false; setMethod('upi'); } },
        ]);
        return;
      }
      appAlert('Money not given', err?.message || 'Nothing was saved. Check the connection and try again.');
    }
  };

  if (showOpenRegister) {
    return (
      <OpenRegisterForm
        locationId={locationId}
        actionLabel="give cash"
        onClose={() => setShowOpenRegister(false)}
        onOpened={() => {
          setOpenedHere(true);
          setShowOpenRegister(false);
          autoMoved.current = false;
          setMethod('cash');
          onRegisterOpened && onRegisterOpened();
        }}
        onBack={() => setShowOpenRegister(false)}
        backLabel={`Back to ${w.title}`}
      />
    );
  }

  const chips = whoChips(people, meId, who ? who.id : null);
  const moreOptions = people.map((p) => ({
    key: `u${p.id}`, label: Number(p.id) === meId ? `Me (${p.name})` : p.name, selected: !!who && Number(who.id) === Number(p.id), person: p,
  }));
  const giveText = `${w.give}${amt !== null ? ` ${inr(amt)}` : ''}`;
  const noteText = note.trim();

  return (
    <>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => leave(onBack)} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Back to Add expense">
          <Ionicons name="chevron-back" size={26} color={Colors.textSecondary} />
        </TouchableOpacity>
        <Text style={styles.title}>{w.title}</Text>
        <TouchableOpacity onPress={() => leave(onClose)} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel="Close">
          <Ionicons name="close" size={26} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <ScrollView ref={scrollRef} style={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {kind === 'shopping' && (
          <Text style={styles.intro}>Cash to buy things. They come back later with the bills and the change.</Text>
        )}

        {/* Who */}
        <Text style={styles.label}>Who</Text>
        <View style={styles.chips}>
          {chips.map((c) => {
            const active = !!who && Number(who.id) === Number(c.id);
            return (
              <TouchableOpacity
                key={c.id}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => pickWho(c)}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${w.a11y} for ${c.me ? 'me' : c.name}`}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>{c.label}</Text>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity
            style={styles.more}
            onPress={() => (peopleState === 'error' ? loadPeople() : setShowMore(true))}
            accessibilityRole="button"
            accessibilityLabel="More people"
          >
            <Text style={styles.moreText}>More</Text>
            <Ionicons name="chevron-forward" size={18} color={Colors.primary} />
          </TouchableOpacity>
        </View>
        {peopleState === 'loading' && <ActivityIndicator color={Colors.primary} style={{ marginTop: Spacing.sm }} />}
        {peopleState === 'error' && (
          <TouchableOpacity onPress={loadPeople} style={styles.retry} accessibilityRole="button">
            <Text style={styles.error}>Could not load the names. Tap to try again.</Text>
          </TouchableOpacity>
        )}
        {peopleState === 'ready' && people.length === 0 && (
          <Text style={styles.hint}>No staff are linked to this shop yet. The owner can add them under Staff.</Text>
        )}
        {!!errors.who && <Text style={styles.error}>{errors.who}</Text>}

        {/* Amount */}
        <Text style={styles.label}>Amount</Text>
        <View style={[styles.amountBox, errors.amount && styles.inputError]}>
          <Text style={styles.rupee}>₹</Text>
          <TextInput
            ref={amountRef}
            style={styles.amountInput}
            value={amount}
            onChangeText={(t) => {
              setAmount(t.replace(/[^0-9.]/g, ''));
              setErrors((x) => ({ ...x, amount: undefined }));
              if (pinAsk) resetPin(); // a new amount may not need a PIN
            }}
            placeholder="0"
            placeholderTextColor={Colors.textLight}
            keyboardType="decimal-pad"
            returnKeyType="done"
            accessibilityLabel="Amount in rupees"
          />
        </View>
        {!!errors.amount && <Text style={styles.error}>{errors.amount}</Text>}

        {/* Paid by: Cash | UPI */}
        <Text style={styles.label}>Paid by</Text>
        <MethodSwitch
          value={method}
          options={[{ key: 'cash', label: 'Cash', disabled: cashDisabled }, { key: 'upi', label: 'UPI' }]}
          onChange={(k) => { autoMoved.current = false; setMethod(k); }}
        />
        {cashDisabled && (
          <View style={styles.closedRow}>
            <Text style={styles.closedText}>{CLOSED_CASH_MESSAGE}</Text>
            <TouchableOpacity style={styles.openRegBtn} onPress={() => setShowOpenRegister(true)} accessibilityRole="button">
              <Ionicons name="lock-open-outline" size={18} color={Colors.primary} />
              <Text style={styles.openRegText}>Open Register</Text>
            </TouchableOpacity>
          </View>
        )}
        {!cashDisabled && method === 'cash' && isOpen && (
          <Text style={styles.hint}>Cash comes out of the drawer that is open now.</Text>
        )}

        {/* Note, then the person's figure */}
        <View style={styles.rows}>
          <SheetRow
            label="Note"
            value={noteText}
            onPress={() => setShowNote((v) => !v)}
            accessibilityLabel={`Note: ${noteText || 'none'}. Tap to ${showNote ? 'hide' : 'add'}.`}
          />
          {showNote && (
            <TextInput
              style={[styles.input, { marginTop: Spacing.sm }]}
              value={note}
              onChangeText={setNote}
              placeholder="Note (optional)"
              placeholderTextColor={Colors.textLight}
              maxLength={200}
              accessibilityLabel="Note"
            />
          )}
        </View>
        {!!line && <Text style={styles.figure}>{line}</Text>}

        {kind === 'shopping' && (
          <TouchableOpacity style={styles.linkBtn} onPress={() => leave(onBack)} accessibilityRole="button">
            <Text style={styles.linkText}>Already spent with a bill? Add it as an expense instead</Text>
          </TouchableOpacity>
        )}

        {pinAsk && who && (
          <ApproverPin
            locationId={locationId}
            recipientId={who.id}
            reason={pinAsk.message}
            approverId={approverId}
            onApproverChange={(id) => { setApproverId(id); setPinError(''); setPinLocked(false); }}
            pin={pin}
            onPinChange={(t) => { setPin(t); if (pinError) setPinError(''); }}
            error={pinError}
            locked={pinLocked}
            onSubmit={guard(handleGive)}
          />
        )}
      </ScrollView>

      <TouchableOpacity
        style={[styles.giveBtn, giving && { opacity: 0.6 }]}
        onPress={guard(handleGive)}
        disabled={giving}
        accessibilityRole="button"
        accessibilityState={{ disabled: giving }}
      >
        {giving ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.giveText}>{giveText}</Text>}
      </TouchableOpacity>

      <OptionList
        visible={showMore}
        title="Who gets the money?"
        search
        searchPlaceholder="Search a name"
        emptyText="No one by that name."
        options={moreOptions}
        onPick={(o) => { setShowMore(false); pickWho(o.person); }}
        onClose={() => setShowMore(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.xs },
  backBtn: { minWidth: 48, minHeight: 48, alignItems: 'flex-start', justifyContent: 'center' },
  title: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, flex: 1 },
  closeBtn: { minWidth: 48, minHeight: 48, alignItems: 'flex-end', justifyContent: 'center' },
  scroll: { flexGrow: 0 },
  intro: { fontSize: FontSize.md, color: Colors.textSecondary, marginBottom: Spacing.xs },

  label: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginTop: Spacing.md, marginBottom: Spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Spacing.sm },
  chip: {
    minHeight: 48, maxWidth: 180, paddingHorizontal: Spacing.md, justifyContent: 'center',
    borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.md, color: Colors.text },
  chipTextActive: { color: Colors.white, fontWeight: '700' },
  more: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: Spacing.sm },
  moreText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  retry: { minHeight: 44, justifyContent: 'center' },

  input: {
    minHeight: 52, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, fontSize: FontSize.md, color: Colors.text, backgroundColor: Colors.background,
  },
  inputError: { borderColor: Colors.error },
  error: { color: Colors.error, fontSize: FontSize.md, marginTop: Spacing.xs },
  hint: { color: Colors.textSecondary, fontSize: FontSize.sm, marginTop: Spacing.xs },
  figure: { color: Colors.textSecondary, fontSize: FontSize.md, marginTop: Spacing.sm },

  amountBox: {
    flexDirection: 'row', alignItems: 'center', minHeight: 56,
    borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, backgroundColor: Colors.background,
  },
  rupee: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.textSecondary, marginRight: Spacing.xs },
  amountInput: { flex: 1, minHeight: 54, fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] },

  closedRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: Spacing.sm,
    marginTop: Spacing.sm, padding: Spacing.sm, borderRadius: BorderRadius.md, backgroundColor: Colors.warningLight,
  },
  closedText: { fontSize: FontSize.md, color: Colors.text, flexShrink: 1 },
  openRegBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 44, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary, backgroundColor: Colors.surface,
  },
  openRegText: { color: Colors.primary, fontWeight: '700', fontSize: FontSize.md },

  rows: { marginTop: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  linkBtn: { minHeight: 48, justifyContent: 'center', alignItems: 'center', marginTop: Spacing.sm },
  linkText: { fontSize: FontSize.md, color: Colors.textSecondary, textDecorationLine: 'underline', textAlign: 'center' },

  giveBtn: {
    minHeight: 56, borderRadius: BorderRadius.md, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center', marginTop: Spacing.md,
  },
  giveText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '800' },
});
