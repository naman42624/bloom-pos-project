/**
 * AddExpenseSheet: the one Add / Change expense form (Expense book, spec §6.1).
 *
 *   Add expense                         [x]
 *   [Petrol ₹200] [Tea ₹60] [Roses – Ramesh ₹1,500] ...   suggestion chips
 *   What was it for?  [ pe|          ]   type-ahead list under the box
 *   Amount [ ₹ 200 ]   (Cash) ( UPI )
 *   Given to: Raju ▸                     remembered per item; optional
 *   + Note   Bill photo                  optional
 *   Date: Today ▸                        owner / manager only
 *   [            Save ₹200            ]
 *   Money coming back? Record a return
 *
 * Common case: tap a suggestion (fills name, kind, usual amount, Given to)
 * then Save.
 *
 * Props:
 *   visible, locationId, registerOpen, registerLoading?, register?
 *   expense?          change mode (shows "Remove this expense")
 *   initial?          add mode pre-fill, e.g. a return of an earlier expense
 *   onClose()
 *   onSaved(result)   result = { expense, removed, message } after a save or remove
 *   onRegisterOpened? called after the register was opened from inside the sheet
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Image,
  KeyboardAvoidingView, Platform, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import api, { getApiOrigin } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import { bumpActivity } from '../../hooks/useIdleLock';
import { appAlert, showConfirm } from '../../utils/alert';
import { getShopTodayStr } from '../../utils/datetime';
import { lastSevenDays } from '../../utils/expenseBook';
import { OpenRegisterForm } from '../OpenRegisterSheet';
import DateTimePickerModal from '../DateTimePickerModal';
import GivenToPicker, { givenToLabel } from './GivenToPicker';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

export const EXPENSE_CATEGORIES = [
  { key: 'supplies', label: 'Supplies', icon: 'cart' },
  { key: 'petty_cash', label: 'Petty Cash', icon: 'cash' },
  { key: 'maintenance', label: 'Maintenance', icon: 'construct' },
  { key: 'transport', label: 'Transport', icon: 'car' },
  { key: 'food', label: 'Food', icon: 'fast-food' },
  { key: 'utilities', label: 'Utilities', icon: 'flash' },
  { key: 'salary', label: 'Salary', icon: 'people' },
  { key: 'other', label: 'Other', icon: 'ellipsis-horizontal' },
];

export const categoryLabel = (key) => (EXPENSE_CATEGORIES.find((c) => c.key === key) || {}).label || key;

// Who a Salary expense can be logged against. Same filter as
// ShiftManagementScreen (owner left out: the owner is not paid a wage here).
const PAYROLL_ROLES = ['manager', 'employee', 'counter_staff', 'florist_staff', 'delivery_partner'];

const PHOTO_FAILED_MESSAGE = "Photo didn't upload — saved without it. Tap the expense to add it again.";

export const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const nameKey = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const dateStr = (d) => {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  try { return new Date(d).toISOString().slice(0, 10); } catch { return ''; }
};
const pad2 = (n) => String(n).padStart(2, '0');
// The stored description of a row with no item ends in " — note"; the name
// box shows it without the note (the note has its own box).
const withoutNote = (description, note) => {
  const d = String(description || '');
  const n = String(note || '').trim();
  return n && d.endsWith(` — ${n}`) ? d.slice(0, -(n.length + 3)) : d;
};
const localDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function givenToFromExpense(e) {
  if (!e) return null;
  if (e.given_to_user_id) return { user_id: Number(e.given_to_user_id), name: null, display_name: e.given_to_display || '' };
  if (e.given_to_name) return { user_id: null, name: e.given_to_name, display_name: e.given_to_name };
  return null;
}

export default function AddExpenseSheet(props) {
  const { visible } = props;
  const [closeRequest, setCloseRequest] = useState(0);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => setCloseRequest((n) => n + 1)}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.overlay}>
        <View onTouchStart={bumpActivity} style={styles.sheet}>
          {/* Mounted fresh each time it opens, so it starts from a clean slate. */}
          {visible && <SheetBody {...props} closeRequest={closeRequest} />}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SheetBody({
  locationId, registerOpen, registerLoading = false, register, expense, initial,
  onClose, onSaved, onRegisterOpened, closeRequest,
}) {
  const { user, settings } = useAuth();
  const timezone = settings?.timezone?.value || 'Asia/Kolkata';
  const today = getShopTodayStr(timezone);
  const isBoss = user?.role === 'owner' || user?.role === 'manager';
  const editing = !!expense;
  const start = expense || initial || {};

  // ── Form state ──
  const startName = expense ? (expense.item_name || withoutNote(expense.description, expense.note)) : (start.item_name || start.description || '');
  const [name, setName] = useState(startName);
  const [item, setItem] = useState(
    start.item_id ? { id: Number(start.item_id), name: start.item_name || startName, category: start.category } : null
  );
  const [category, setCategory] = useState(start.category || null);
  const [amount, setAmount] = useState(start.amount ? String(Number(start.amount)) : '');
  const [isReturn, setIsReturn] = useState(!!start.is_return);
  const [givenTo, setGivenTo] = useState(givenToFromExpense(expense));
  const [givenToTouched, setGivenToTouched] = useState(false);
  const [note, setNote] = useState(expense?.note || '');
  const [showNote, setShowNote] = useState(!!expense?.note);
  const [photo, setPhoto] = useState(null); // a newly picked local asset
  const [photoUrl, setPhotoUrl] = useState(expense?.photo_url || null); // already saved
  const [expenseDate, setExpenseDate] = useState(dateStr(expense?.expense_date) || today);
  const [showDates, setShowDates] = useState(false);
  const [showOtherDay, setShowOtherDay] = useState(false);
  const [salaryEmployee, setSalaryEmployee] = useState(
    expense?.employee_id ? { id: expense.employee_id, name: expense.employee_name || '' } : null
  );
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  // ── Register / payment method ──
  const [openedHere, setOpenedHere] = useState(false);
  const [showOpenRegister, setShowOpenRegister] = useState(false);
  const isOpen = !!registerOpen || openedHere;
  const keepsCash = editing && expense.payment_method === 'cash';
  // An old cash expense with no register session (saved before registers
  // were linked, from a day already closed) never moves into today's drawer:
  // its amount, Cash/UPI and return stay as they are (server: OLD_CASH_MESSAGE).
  const openedAt = register && (register.opened_at || register.opening_time);
  const inOpenSession = editing && !!registerOpen && !!register && (expense.register_id
    ? Number(expense.register_id) === Number(register.id)
    : !!openedAt && !!expense.created_at && new Date(expense.created_at) >= new Date(openedAt));
  const cashLocked = keepsCash && !expense.register_id && !registerLoading && !inOpenSession;
  // Cash for another day would come out of today's drawer, so an earlier day
  // is UPI only (a cash expense keeps its own session when its date moves).
  const pastDay = expenseDate !== today;
  const cashPastDay = !keepsCash && pastDay;
  const cashDisabled = !keepsCash && (pastDay || (!registerLoading && !isOpen));
  const [paymentMethod, setPaymentMethod] = useState(
    expense ? expense.payment_method : (start.payment_method || (registerOpen ? 'cash' : 'upi'))
  );
  // Move off Cash when the register turns out closed; go back to Cash once
  // it opens, but only if this sheet moved off it (never over a choice).
  const autoMovedOffCash = useRef(false);
  useEffect(() => {
    if (registerLoading) return;
    if (cashDisabled && paymentMethod === 'cash') {
      autoMovedOffCash.current = true;
      setPaymentMethod('upi');
    } else if (!editing && !cashDisabled && autoMovedOffCash.current) {
      autoMovedOffCash.current = false;
      if (paymentMethod === 'upi') setPaymentMethod('cash');
    }
  }, [registerLoading, cashDisabled, isOpen, paymentMethod]);
  // In add mode, while the register status is still loading, start on Cash
  // once we learn it is open.
  const sawLoading = useRef(registerLoading);
  useEffect(() => {
    if (editing || !sawLoading.current || registerLoading) return;
    sawLoading.current = false;
    if (isOpen && !start.payment_method) setPaymentMethod('cash');
  }, [registerLoading, isOpen]);

  const methods = [
    { key: 'cash', label: 'Cash', icon: 'cash-outline' },
    { key: 'upi', label: 'UPI', icon: 'phone-portrait-outline' },
  ];
  // Card stays only for an older expense that was paid by card.
  if (editing && expense.payment_method === 'card') methods.push({ key: 'card', label: 'Card', icon: 'card-outline' });

  // ── Suggestions ──
  const [chips, setChips] = useState([]);
  const [typed, setTyped] = useState([]);
  const [typedFor, setTypedFor] = useState('');
  const [showTyped, setShowTyped] = useState(false);
  const amountRef = useRef(null);
  const reqId = useRef(0);

  useEffect(() => {
    if (!locationId) return;
    api.getExpenseSuggestions({ location_id: locationId })
      .then((res) => setChips(res.data || []))
      .catch(() => setChips([]));
  }, [locationId]);

  useEffect(() => {
    const q = name.trim();
    if (!showTyped || !q || !locationId) {
      // A reply still on its way must not change the item any more.
      reqId.current += 1;
      setTyped([]); setTypedFor(''); return undefined;
    }
    const id = ++reqId.current;
    const t = setTimeout(() => {
      api.getExpenseSuggestions({ location_id: locationId, q })
        .then((res) => {
          if (id !== reqId.current) return;
          const all = res.data || [];
          const rows = editing ? all.filter((r) => (r.category === 'salary') === (expense.category === 'salary')) : all;
          setTyped(rows);
          setTypedFor(q);
          // Typed the exact name of a known item: use it, no kind to pick.
          const exact = rows.find((r) => nameKey(r.name) === nameKey(q));
          if (exact) setItem((cur) => (cur && cur.id === exact.id ? cur : { id: exact.id, name: exact.name, category: exact.category }));
        })
        .catch(() => { if (id === reqId.current) setTyped([]); });
    }, 250);
    return () => clearTimeout(t);
  }, [name, showTyped, locationId]);

  const pickSuggestion = (s) => {
    reqId.current += 1; // a slower type-ahead reply must not replace this pick
    setName(s.name);
    setItem({ id: s.id, name: s.name, category: s.category });
    setCategory(s.category);
    if (s.usual_amount != null && Number(s.usual_amount) > 0) setAmount(String(Number(s.usual_amount)));
    setGivenTo(s.last_given_to ? { ...s.last_given_to } : null);
    setGivenToTouched(true);
    setShowTyped(false);
    setErrors({});
    setTimeout(() => amountRef.current?.focus(), 50);
  };

  const onNameChange = (t) => {
    setName(t);
    setShowTyped(true);
    setErrors((e) => ({ ...e, name: undefined }));
    if (item && nameKey(t) !== nameKey(item.name)) setItem(null);
  };

  // A new name (not a known item) asks for the kind of expense once.
  const isNewName = !item && name.trim().length > 0;
  // Changing: a salary row keeps its kind, and other rows can't become
  // salary (server: SALARY_ROW_MESSAGE).
  const salaryRow = editing && expense.category === 'salary';
  const showCategories = editing ? !salaryRow : isNewName;
  const categoryChoices = editing ? EXPENSE_CATEGORIES.filter((c) => c.key !== 'salary') : EXPENSE_CATEGORIES;
  const effectiveCategory = item && !editing ? item.category : category;
  const isSalary = effectiveCategory === 'salary';

  // ── Photo ──
  const pickPhoto = async (fromCamera) => {
    try {
      if (fromCamera) {
        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== 'granted') {
          appAlert('Camera not allowed', 'Allow the camera in your phone settings, or pick a photo from the phone instead.');
          return;
        }
      }
      const opts = { mediaTypes: ['images'], quality: 0.6 };
      const result = fromCamera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      if (!result.canceled && result.assets?.[0]?.uri) setPhoto(result.assets[0]);
    } catch {
      appAlert('Could not open the photo', 'Try again, or save without a photo.');
    }
  };

  const choosePhoto = () => {
    if (Platform.OS === 'web') { pickPhoto(false); return; }
    appAlert('Bill photo', 'Take a photo of the bill, or pick one from the phone.', [
      { text: 'Take photo', onPress: () => pickPhoto(true) },
      { text: 'Pick from phone', onPress: () => pickPhoto(false) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const uploadPhoto = async () => {
    const uri = photo.uri;
    const formData = new FormData();
    if (Platform.OS === 'web') {
      const response = await fetch(uri);
      const blob = await response.blob();
      formData.append('image', blob, 'bill.jpg');
    } else {
      const filename = uri.split('/').pop();
      const ext = /\.(\w+)$/.exec(filename)?.[1] || 'jpg';
      formData.append('image', { uri, name: filename, type: `image/${ext}` });
    }
    const res = await api.uploadGenericImage(formData);
    return res.url;
  };

  // ── Close with unsaved input ──
  const startEmployeeId = expense?.employee_id ? Number(expense.employee_id) : null;
  const pickedEmployeeId = salaryEmployee ? Number(salaryEmployee.id) : null;
  const dirty = editing
    ? (name !== startName || amount !== String(Number(expense.amount || 0)) || givenToTouched || !!photo
      || note !== (expense.note || '') || paymentMethod !== expense.payment_method
      || category !== (expense.category || null) || isReturn !== !!expense.is_return
      || expenseDate !== (dateStr(expense.expense_date) || today) || pickedEmployeeId !== startEmployeeId
      || (photoUrl || null) !== (expense.photo_url || null))
    : (name.trim() !== startName.trim() || (amount !== '' && amount !== (start.amount ? String(Number(start.amount)) : '')) || !!photo || !!note.trim()
      || category !== (start.category || null) || isReturn !== !!start.is_return || expenseDate !== today || pickedEmployeeId !== null);
  const requestClose = () => {
    if (saving || removing) return;
    if (!dirty) { onClose(); return; }
    showConfirm('Leave without saving?', 'What you typed here will be lost.', onClose,
      { confirmLabel: 'Leave', cancelLabel: 'Keep typing', destructive: true });
  };
  const firstClose = useRef(closeRequest);
  useEffect(() => {
    if (closeRequest !== firstClose.current) requestClose();
  }, [closeRequest]);

  // ── Save ──
  const guard = useSubmitGuard();
  const amt = parseFloat(amount);
  const amountOk = Number.isFinite(amt) && amt > 0;

  const validate = () => {
    const e = {};
    if (!name.trim()) e.name = 'Type what this was for, like Petrol.';
    if (!amountOk) e.amount = 'Type how much was paid.';
    if (showCategories && !effectiveCategory) e.category = 'Pick what kind of expense this is.';
    if (isSalary && !salaryEmployee) e.salary = 'Pick which employee this salary payment is for.';
    setErrors(e);
    if (e.amount && !e.name) setTimeout(() => amountRef.current?.focus(), 50);
    return Object.keys(e).length === 0;
  };

  const itemFields = () => {
    // Salary keeps its old shape (no item), as before the expense book.
    if (isSalary && !item) return { description: name.trim(), category: 'salary' };
    if (item) return editing ? { item_id: item.id, category: effectiveCategory } : { item_id: item.id };
    return { item_name: name.trim(), category: effectiveCategory };
  };

  const givenToFields = () => (givenTo
    ? (givenTo.user_id ? { given_to_user_id: givenTo.user_id } : { given_to_name: givenToLabel(givenTo) })
    : { given_to_user_id: null, given_to_name: null });

  const handleSave = async () => {
    if (!validate()) return;
    if (!editing && !locationId) { appAlert('Pick a shop first', 'Close this, tap your shop at the top, then add the expense.'); return; }
    setSaving(true);
    let photoFailed = false;
    let newPhotoUrl;
    if (photo) {
      try { newPhotoUrl = await uploadPhoto(); } catch { photoFailed = true; }
    }
    try {
      const body = {
        amount: Math.round(amt * 100) / 100,
        payment_method: paymentMethod,
        is_return: isReturn,
        note: note.trim() || null,
        ...itemFields(),
        employee_id: isSalary ? salaryEmployee.id : null,
      };
      if (!editing || givenToTouched) Object.assign(body, givenToFields());
      if (newPhotoUrl) body.photo_url = newPhotoUrl;
      else if (editing && expense.photo_url && !photoUrl) body.photo_url = null;
      if (isBoss && (!editing ? expenseDate !== today : expenseDate !== dateStr(expense.expense_date))) body.expense_date = expenseDate;

      let res;
      if (editing) {
        // An unchanged name on an old row with no item stays as it was: no
        // description is sent, so the server keeps the text and only swaps
        // the note at its end (never adds the note twice).
        if (!expense.item_id && name === startName && !item) {
          delete body.item_name;
          delete body.description;
          body.category = effectiveCategory;
        }
        // An old cash expense with no session: only the parts that move no cash.
        if (cashLocked) {
          delete body.amount;
          delete body.payment_method;
          delete body.is_return;
        }
        res = await api.updateExpense(expense.id, body);
      } else {
        res = await api.createExpense({ location_id: locationId, ...body });
      }
      const saved = res?.data || null;
      const label = (saved && (saved.item_name || saved.description)) || name.trim();
      const message = `${isReturn ? 'Saved return' : 'Saved'} ${rupees(body.amount)} ${label}`;
      if (photoFailed) appAlert('Saved', PHOTO_FAILED_MESSAGE);
      setSaving(false);
      onSaved && onSaved({ expense: saved, removed: false, message });
    } catch (err) {
      setSaving(false);
      const msg = err?.message || 'It was not saved. Check the connection and try again.';
      // The server's register-guard copy: "Register isn't open — ..."
      if (paymentMethod === 'cash' && !keepsCash && /register isn.t open/i.test(String(err?.raw_message || ''))) {
        setOpenedHere(false);
        appAlert('Register is closed', msg, [
          { text: 'Open register', onPress: () => setShowOpenRegister(true) },
          { text: 'Pay by UPI', onPress: () => { autoMovedOffCash.current = false; setPaymentMethod('upi'); } },
        ]);
        return;
      }
      appAlert('Could not save', msg);
    }
  };

  // ── Remove (change mode) ──
  const handleRemove = () => {
    const cashNote = expense.payment_method === 'cash' && !cashLocked
      ? (expense.is_return ? ' The cash is taken back off the register.' : ' The cash is put back on the register.')
      : '';
    const label = expense.item_name || expense.description || 'this expense';
    appAlert('Remove this expense?', `${rupees(expense.amount)} — ${label}.${cashNote}`, [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: guard(async () => {
          setRemoving(true);
          try {
            await api.deleteExpense(expense.id);
            setRemoving(false);
            onSaved && onSaved({ expense, removed: true, message: `Removed ${rupees(expense.amount)} ${label}` });
          } catch (err) {
            setRemoving(false);
            appAlert('Could not remove', err?.message || 'The expense was not removed. Check the connection and try again.');
          }
        }),
      },
    ]);
  };

  // ── Date (owner / manager) ──
  const days = useMemo(() => lastSevenDays(today), [today]);
  const dateLabel = (days.find((d) => d.date === expenseDate) || {}).label || expenseDate;

  // ── Open register in place ──
  if (showOpenRegister) {
    return (
      <OpenRegisterForm
        locationId={locationId}
        actionLabel="pay cash"
        onClose={() => setShowOpenRegister(false)}
        onOpened={() => {
          setOpenedHere(true);
          setShowOpenRegister(false);
          autoMovedOffCash.current = false;
          setPaymentMethod('cash');
          onRegisterOpened && onRegisterOpened();
        }}
        onBack={() => setShowOpenRegister(false)}
        backLabel="Back to the expense"
      />
    );
  }

  const title = editing ? 'Change expense' : isReturn ? 'Record a return' : 'Add expense';
  const saveText = editing ? 'Save changes' : `${isReturn ? 'Save return' : 'Save'}${amountOk ? ` ${rupees(amt)}` : ''}`;
  const busy = saving || removing;
  const photoPreview = photo ? photo.uri : (photoUrl ? `${getApiOrigin()}${photoUrl}` : null);

  return (
    <>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <TouchableOpacity onPress={requestClose} accessibilityRole="button" accessibilityLabel="Close" style={styles.closeBtn}>
          <Ionicons name="close" size={26} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {isReturn && (
          <View style={styles.returnNote}>
            <Ionicons name="arrow-undo" size={18} color={Colors.success} />
            <Text style={styles.returnNoteText}>Money coming back into the shop.</Text>
          </View>
        )}

        {/* Suggestion chips */}
        {!editing && chips.length > 0 && !(showTyped && name.trim()) && (
          <View style={styles.chipWrap}>
            {chips.map((s) => {
              const who = s.last_given_to ? givenToLabel(s.last_given_to) : '';
              const active = item && item.id === s.id;
              return (
                <TouchableOpacity
                  key={s.id}
                  style={[styles.suggestChip, active && styles.chipActive]}
                  onPress={() => pickSuggestion(s)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: !!active }}
                >
                  <Text style={[styles.suggestText, active && styles.chipTextActive]}>
                    {s.name}{who ? ` – ${who}` : ''}
                    {s.usual_amount != null && Number(s.usual_amount) > 0 ? (
                      <Text style={[styles.suggestAmount, active && styles.chipTextActive]}>{`  ${rupees(s.usual_amount)}`}</Text>
                    ) : null}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* What was it for? */}
        <Text style={styles.label}>What was it for?</Text>
        <TextInput
          style={[styles.input, errors.name && styles.inputError]}
          value={name}
          onChangeText={onNameChange}
          placeholder="Like Petrol, Tea, Roses"
          placeholderTextColor={Colors.textLight}
          maxLength={80}
          returnKeyType="next"
          onSubmitEditing={() => { setShowTyped(false); amountRef.current?.focus(); }}
          accessibilityLabel="What was it for?"
        />
        {!!errors.name && <Text style={styles.error}>{errors.name}</Text>}
        {showTyped && name.trim() !== '' && typedFor === name.trim() && typed.length > 0 && !(item && typed.length === 1 && typed[0].id === item.id) && (
          <View style={styles.typedList}>
            {typed.map((s) => (
              <TouchableOpacity key={s.id} style={styles.typedRow} onPress={() => pickSuggestion(s)} accessibilityRole="button">
                <Text style={styles.typedName}>{s.name}</Text>
                <Text style={styles.typedMeta}>
                  {categoryLabel(s.category)}{s.usual_amount != null && Number(s.usual_amount) > 0 ? ` · ${rupees(s.usual_amount)}` : ''}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Kind of expense: once, for a new name (always shown when changing) */}
        {showCategories && (
          <>
            <Text style={styles.label}>{editing ? 'Kind of expense' : 'New item — what kind of expense is it?'}</Text>
            <View style={styles.chipWrap}>
              {categoryChoices.map((c) => {
                const active = effectiveCategory === c.key;
                return (
                  <TouchableOpacity
                    key={c.key}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => { setCategory(c.key); setErrors((e) => ({ ...e, category: undefined })); }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Ionicons name={c.icon} size={18} color={active ? Colors.white : Colors.textSecondary} />
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{c.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {!!errors.category && <Text style={styles.error}>{errors.category}</Text>}
          </>
        )}

        {isSalary && (
          <SalaryEmployeePicker
            locationId={locationId}
            value={salaryEmployee}
            onChange={(u) => { setSalaryEmployee(u); setErrors((e) => ({ ...e, salary: undefined })); }}
            error={errors.salary}
          />
        )}

        {/* Amount + Cash / UPI */}
        <Text style={styles.label}>Amount</Text>
        <View style={styles.amountRow}>
          <View style={[styles.amountBox, errors.amount && styles.inputError]}>
            <Text style={styles.rupee}>₹</Text>
            <TextInput
              ref={amountRef}
              style={styles.amountInput}
              value={amount}
              onChangeText={(t) => { setAmount(t.replace(/[^0-9.]/g, '')); setErrors((e) => ({ ...e, amount: undefined })); }}
              editable={!cashLocked}
              placeholder="0"
              placeholderTextColor={Colors.textLight}
              keyboardType="decimal-pad"
              onFocus={() => setShowTyped(false)}
              accessibilityLabel="Amount in rupees"
            />
          </View>
          {methods.map((m) => {
            const disabled = cashLocked ? !active : (m.key === 'cash' && cashDisabled);
            const active = paymentMethod === m.key;
            return (
              <TouchableOpacity
                key={m.key}
                style={[styles.methodBtn, active && styles.chipActive, disabled && styles.methodDisabled]}
                onPress={() => { autoMovedOffCash.current = false; setPaymentMethod(m.key); }}
                disabled={disabled || cashLocked}
                accessibilityRole="button"
                accessibilityState={{ selected: active, disabled }}
              >
                <Ionicons name={m.icon} size={18} color={active ? Colors.white : disabled ? Colors.textLight : Colors.textSecondary} />
                <Text style={[styles.chipText, active && styles.chipTextActive, disabled && { color: Colors.textLight }]}>{m.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {!!errors.amount && <Text style={styles.error}>{errors.amount}</Text>}
        {cashLocked && (
          <Text style={styles.hint}>
            This cash was paid on a day whose register is already closed, so the amount and Cash/UPI stay as they are. You can still change the rest.
          </Text>
        )}
        {cashPastDay && (
          <Text style={styles.hint}>Past days don't change today's drawer, so an earlier day is paid by UPI.</Text>
        )}
        {cashDisabled && !cashPastDay && (
          <View style={styles.closedRow}>
            <Text style={styles.closedText}>Open the register to pay cash</Text>
            <TouchableOpacity style={styles.openRegBtn} onPress={() => setShowOpenRegister(true)} accessibilityRole="button">
              <Ionicons name="lock-open-outline" size={18} color={Colors.primary} />
              <Text style={styles.openRegText}>Open Register</Text>
            </TouchableOpacity>
          </View>
        )}
        {!editing && !pastDay && paymentMethod === 'cash' && isOpen && register && (register.opening_time || register.opened_at) && (
          <Text style={styles.hint}>Cash comes out of the drawer that is open now.</Text>
        )}

        {/* Given to */}
        <Text style={styles.label}>Who got the money? (optional)</Text>
        <GivenToPicker
          locationId={locationId}
          value={givenTo}
          onChange={(v) => { setGivenTo(v); setGivenToTouched(true); }}
        />

        {/* Note + bill photo */}
        <View style={styles.extrasRow}>
          {!showNote && (
            <TouchableOpacity style={styles.extraBtn} onPress={() => setShowNote(true)} accessibilityRole="button">
              <Ionicons name="add" size={20} color={Colors.primary} />
              <Text style={styles.extraText}>Note</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.extraBtn} onPress={choosePhoto} accessibilityRole="button">
            <Ionicons name="camera-outline" size={20} color={Colors.primary} />
            <Text style={styles.extraText}>{photoPreview ? 'Change bill photo' : 'Bill photo'}</Text>
          </TouchableOpacity>
        </View>
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
        {photoPreview && (
          <View style={styles.photoRow}>
            <Image source={{ uri: photoPreview }} style={styles.photo} resizeMode="cover" accessibilityLabel="Bill photo" />
            <TouchableOpacity
              style={styles.extraBtn}
              onPress={() => { setPhoto(null); setPhotoUrl(null); }}
              accessibilityRole="button"
            >
              <Ionicons name="trash-outline" size={18} color={Colors.error} />
              <Text style={[styles.extraText, { color: Colors.error }]}>Remove photo</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Date: owner and manager only */}
        {isBoss && (
          <>
            <TouchableOpacity
              style={[styles.dateRow]}
              onPress={() => setShowDates((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ expanded: showDates }}
            >
              <Ionicons name="calendar-outline" size={20} color={Colors.textSecondary} />
              <Text style={styles.dateText}>Date: <Text style={styles.dateValue}>{dateLabel}</Text></Text>
              <Ionicons name={showDates ? 'chevron-up' : 'chevron-forward'} size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
            {showDates && (
              <View style={[styles.chipWrap, { marginTop: Spacing.sm }]}>
                {days.map((d) => {
                  const active = d.date === expenseDate;
                  return (
                    <TouchableOpacity
                      key={d.date}
                      style={[styles.chip, active && styles.chipActive]}
                      onPress={() => { setExpenseDate(d.date); setShowDates(false); }}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>{d.label}</Text>
                    </TouchableOpacity>
                  );
                })}
                <TouchableOpacity style={styles.chip} onPress={() => setShowOtherDay(true)} accessibilityRole="button">
                  <Text style={styles.chipText}>Other day…</Text>
                </TouchableOpacity>
              </View>
            )}
            <DateTimePickerModal
              visible={showOtherDay}
              mode="date"
              value={new Date(`${expenseDate}T12:00:00`)}
              title="Which day was it paid?"
              onCancel={() => setShowOtherDay(false)}
              onConfirm={(d) => {
                setShowOtherDay(false);
                const s = localDateStr(d);
                if (s > today) { appAlert('Pick an earlier day', 'An expense cannot be entered for a day that has not come yet.'); return; }
                setExpenseDate(s);
                setShowDates(false);
              }}
            />
          </>
        )}

        {/* Return switch, then Remove (change mode) */}
        {!cashLocked && (
          <TouchableOpacity
            style={styles.linkBtn}
            onPress={() => { setIsReturn((v) => !v); }}
            accessibilityRole="button"
          >
            <Text style={styles.linkText}>
              {isReturn ? 'This is money going out? Record an expense' : 'Money coming back? Record a return'}
            </Text>
          </TouchableOpacity>
        )}
        {editing && (
          <TouchableOpacity style={styles.removeBtn} onPress={handleRemove} disabled={busy} accessibilityRole="button">
            <Ionicons name="trash-outline" size={20} color={Colors.error} />
            <Text style={styles.removeText}>Remove this expense</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* Save stays in view below the scroll area */}
      <TouchableOpacity
        style={[styles.saveBtn, isReturn && styles.saveBtnReturn, busy && { opacity: 0.6 }]}
        onPress={guard(handleSave)}
        disabled={busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
      >
        {saving
          ? <ActivityIndicator color={Colors.white} />
          : <Text style={styles.saveText}>{saveText}</Text>}
      </TouchableOpacity>
    </>
  );
}

// ── Salary: which employee (unchanged behaviour from the old form) ──
function SalaryEmployeePicker({ locationId, value, onChange, error }) {
  const { user } = useAuth();
  const [staff, setStaff] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [recentPayroll, setRecentPayroll] = useState(null);
  const [recentSalary, setRecentSalary] = useState(null);

  // GET /users is owner/manager only. Counter staff use assignable-staff;
  // 'employee' is refused there too, so it falls back to staff-roster.
  useEffect(() => {
    const isBoss = user?.role === 'owner' || user?.role === 'manager';
    const load = async () => {
      if (isBoss) {
        const res = await api.getUsers({ limit: 100 });
        return (res.data?.users || []).filter((u) => PAYROLL_ROLES.includes(u.role) && u.is_active);
      }
      try {
        const res = await api.getAssignableStaff(locationId);
        return (res.staff || []).filter((u) => PAYROLL_ROLES.includes(u.role));
      } catch {
        const res = await api.getStaffRoster(locationId);
        return res.data?.staff || [];
      }
    };
    load().then(setStaff).catch(() => setStaff([])).finally(() => setLoaded(true));
  }, [locationId]);

  // Awareness only, never blocking: the server refuses a real overlap.
  // Payroll history is only trustworthy for the owner, or for yourself
  // (the server filters everyone else to the caller's own records).
  useEffect(() => {
    if (!value) { setRecentPayroll(null); setRecentSalary(null); return undefined; }
    let cancelled = false;
    const canRead = user?.role === 'owner' || value.id === user?.id;
    Promise.all([
      canRead
        ? api.getPayrollHistory({ user_id: value.id, limit: 3 }).catch(() => ({ data: { payments: [] } }))
        : Promise.resolve({ data: { payments: [] } }),
      api.getExpenses({ category: 'salary', employee_id: value.id }).catch(() => ({ data: [] })),
    ]).then(([payrollRes, expensesRes]) => {
      if (cancelled) return;
      const payments = (payrollRes.data?.payments || []).filter((p) => p.status !== 'cancelled');
      payments.sort((a, b) => String(b.period_end || '').localeCompare(String(a.period_end || '')));
      setRecentPayroll(payments[0] || null);
      const rows = (expensesRes.data || []).slice()
        .sort((a, b) => String(b.expense_date || '').localeCompare(String(a.expense_date || '')));
      setRecentSalary(rows[0] || null);
    });
    return () => { cancelled = true; };
  }, [value?.id]);

  return (
    <View>
      <Text style={styles.label}>Which employee is this for?</Text>
      <View style={styles.chipWrap}>
        {staff.map((u) => {
          const active = value && Number(value.id) === Number(u.id);
          return (
            <TouchableOpacity
              key={u.id}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => onChange(u)}
              accessibilityRole="button"
              accessibilityState={{ selected: !!active }}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{u.name}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {!loaded && <ActivityIndicator color={Colors.primary} style={{ marginTop: Spacing.sm }} />}
      {loaded && staff.length === 0 && (
        <Text style={styles.hint}>No staff found here — log this from Salary Management instead, or check Staff under More.</Text>
      )}
      {!!error && <Text style={styles.error}>{error}</Text>}
      {(recentPayroll || recentSalary) && (
        <View style={styles.salaryNote}>
          <Ionicons name="information-circle-outline" size={18} color={Colors.textSecondary} />
          <Text style={styles.salaryNoteText}>
            {recentPayroll && `Last paid via Payroll: ${recentPayroll.period_start} to ${recentPayroll.period_end}. `}
            {recentSalary && `Last salary expense logged: ${rupees(recentSalary.amount)} on ${dateStr(recentSalary.expense_date)}.`}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg,
    paddingHorizontal: Spacing.md, paddingTop: Spacing.md, paddingBottom: Spacing.lg,
    width: '100%', maxWidth: 560, alignSelf: 'center', maxHeight: '92%',
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.sm },
  title: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, flex: 1 },
  closeBtn: { minWidth: 48, minHeight: 48, alignItems: 'flex-end', justifyContent: 'center' },
  scroll: { flexGrow: 0 },

  returnNote: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.successLight, borderRadius: BorderRadius.md, padding: Spacing.sm, marginBottom: Spacing.sm,
  },
  returnNoteText: { fontSize: FontSize.md, color: Colors.text, flex: 1 },

  label: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginTop: Spacing.md, marginBottom: Spacing.xs },
  input: {
    minHeight: 52, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, fontSize: FontSize.md, color: Colors.text, backgroundColor: Colors.background,
  },
  inputError: { borderColor: Colors.error },
  error: { color: Colors.error, fontSize: FontSize.md, marginTop: Spacing.xs },
  hint: { color: Colors.textSecondary, fontSize: FontSize.sm, marginTop: Spacing.xs },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs,
    minHeight: 48, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.md, color: Colors.text },
  chipTextActive: { color: Colors.white, fontWeight: '700' },

  suggestChip: {
    minHeight: 52, paddingHorizontal: Spacing.md, justifyContent: 'center',
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primaryLight, backgroundColor: Colors.primaryGlow,
  },
  suggestText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  suggestAmount: { fontWeight: '600', color: Colors.textSecondary, fontVariant: ['tabular-nums'] },

  typedList: {
    marginTop: Spacing.xs, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface, overflow: 'hidden',
  },
  typedRow: {
    minHeight: 52, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, justifyContent: 'center',
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  typedName: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  typedMeta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },

  amountRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flexWrap: 'wrap' },
  amountBox: {
    flexDirection: 'row', alignItems: 'center', flexGrow: 1, flexBasis: 140, minHeight: 56,
    borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, backgroundColor: Colors.background,
  },
  rupee: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.textSecondary, marginRight: Spacing.xs },
  amountInput: {
    flex: 1, minHeight: 54, fontSize: FontSize.xl, fontWeight: '800', color: Colors.text,
    fontVariant: ['tabular-nums'],
  },
  methodBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    minHeight: 56, minWidth: 88, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  methodDisabled: { backgroundColor: Colors.surfaceAlt, opacity: 0.5 },

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

  extrasRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md, marginTop: Spacing.md },
  extraBtn: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 44, paddingHorizontal: Spacing.xs },
  extraText: { fontSize: FontSize.md, color: Colors.primary, fontWeight: '600' },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginTop: Spacing.sm },
  photo: { width: 72, height: 72, borderRadius: BorderRadius.sm, backgroundColor: Colors.surfaceAlt },

  dateRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 48, marginTop: Spacing.md,
    paddingHorizontal: Spacing.sm, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.background,
  },
  dateText: { flex: 1, fontSize: FontSize.md, color: Colors.textSecondary },
  dateValue: { color: Colors.text, fontWeight: '700' },

  linkBtn: { minHeight: 48, justifyContent: 'center', alignItems: 'center', marginTop: Spacing.md },
  linkText: { fontSize: FontSize.md, color: Colors.textSecondary, textDecorationLine: 'underline' },
  removeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    minHeight: 48, marginBottom: Spacing.sm,
  },
  removeText: { color: Colors.error, fontWeight: '600', fontSize: FontSize.md },

  salaryNote: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs,
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.sm, marginTop: Spacing.sm,
  },
  salaryNoteText: { flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary },

  saveBtn: {
    minHeight: 56, borderRadius: BorderRadius.md, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center', marginTop: Spacing.md,
  },
  saveBtnReturn: { backgroundColor: Colors.success },
  saveText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '800' },
});
