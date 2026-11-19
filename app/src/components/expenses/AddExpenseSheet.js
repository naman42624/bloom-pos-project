/**
 * AddExpenseSheet: the one Add / Change expense form (Expense book; calmer
 * layout from the staff money spec §4.1).
 *
 *   Add expense                                   ✕
 *   Usual now
 *     Tea      ₹50   Cash · Tota Ram
 *   Often
 *     Petrol  ₹200   Cash · Ramesh
 *   What was it for?   [ type here…            ]
 *   Amount             ₹ [      ]
 *   Paid by            [ Cash | UPI | Own pocket ]
 *   Whose?             (Me) (Ramesh) (Asha)   More ›   only with Own pocket
 *   Given to           (Tota Ram) (Ramesh) (Asha)   More ›
 *   Kind               Food (from the item)     ›
 *   Date               Today                    ›   owner / manager only
 *   Note / bill photo  —                        ›
 *   ↗ Salary advance      ↗ Shopping money      ↗ Km reading   (in place)
 *   [ This was a salary advance ]   change mode, owner only (OldExpenseAdvanceSheet)
 *   [              Save ₹50              ]
 *   Money coming back? Record a return
 *
 * Common case: Add expense → Tea → Save (3 taps). A suggestion fills the
 * item, its most common amount, your own last Cash/UPI and the last Given to
 * (only when that person is here today), see pickDefaults.
 *
 * Props:
 *   visible, locationId, registerOpen, registerLoading?, register?
 *   expense?          change mode (shows "Remove this expense")
 *   initial?          add mode pre-fill, e.g. a return of an earlier expense
 *   prefill?          add mode: a suggestion item (from Usual now) to start from
 *   mode?             'expense' (default); 'advance' / 'shopping' open straight on that form
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
import { useNavigation } from '@react-navigation/native';
import { useAuth } from '../../context/AuthContext';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import { bumpActivity } from '../../hooks/useIdleLock';
import { appAlert, showConfirm } from '../../utils/alert';
import { getShopTodayStr } from '../../utils/datetime';
import { lastSevenDays, pickDefaults, methodAfterPick, suggestionSections, suggestionLine } from '../../utils/expenseBook';
import { OpenRegisterForm } from '../OpenRegisterSheet';
import DateTimePickerModal from '../DateTimePickerModal';
import RecentPeople, { givenToLabel } from './RecentPeople';
import SheetRow from './SheetRow';
import OptionList from './OptionList';
import MethodSwitch from './MethodSwitch';
import MoneyToStaffForm from './MoneyToStaffForm';
import KmReadingForm from './KmReadingForm';
import OldExpenseAdvanceSheet from './OldExpenseAdvanceSheet';
import { canMarkSalaryAdvance } from '../../utils/oldExpenseAdvance';
import { moneyLinksFor, heldBy, isBackHint } from '../../utils/staffMoney';
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

// Who may give Salary advance / Shopping money and pay from their own pocket
// (spec 5.1; server GIVER_ROLES).
const GIVER_ROLES = ['owner', 'manager', 'employee', 'counter_staff'];
// B8 registers this screen ("Ramesh is back") with params { id }.
const IS_BACK_SCREEN = 'ShoppingMoneyBack';

const MONEY_LINKS = {
  advance: { label: 'Salary advance', sub: 'Salary money given now, taken from pay later' },
  shopping: { label: 'Shopping money', sub: 'Cash to buy things; the bills and change come back' },
  km: { label: 'Km reading', sub: 'A rider\'s bike meter reading, for their km pay' },
};

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
const firstNameOf = (people, id) => {
  const p = (people || []).find((x) => Number(x.id) === Number(id));
  return p ? String(p.name || '').trim().split(/\s+/)[0] || 'them' : 'them';
};
const personKey = (p) => (!p ? '' : p.user_id ? `u${Number(p.user_id)}` : `n${nameKey(givenToLabel(p))}`);

function givenToFromExpense(e) {
  if (!e) return null;
  if (e.given_to_user_id) return { user_id: Number(e.given_to_user_id), name: null, display_name: e.given_to_display || '' };
  if (e.given_to_name) return { user_id: null, name: e.given_to_name, display_name: e.given_to_name };
  return null;
}

// A Usual now item handed in by the caller becomes the add-mode start.
function startFromPrefill(p) {
  if (!p || !p.id) return null;
  const d = pickDefaults(p);
  return {
    item_id: p.id, item_name: p.name, category: p.category,
    amount: d.amount, payment_method: d.method, givenTo: d.givenTo,
  };
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
  locationId, registerOpen, registerLoading = false, register, expense, initial, prefill,
  mode = 'expense',
  onClose, onSaved, onRegisterOpened, closeRequest,
}) {
  const { user, settings } = useAuth();
  const timezone = settings?.timezone?.value || 'Asia/Kolkata';
  const today = getShopTodayStr(timezone);
  const isBoss = user?.role === 'owner' || user?.role === 'manager';
  // Counter staff give salary money through Salary advance (server refuses it here).
  const hideSalary = user?.role === 'employee' || user?.role === 'counter_staff';
  const editing = !!expense;
  const canGive = !editing && GIVER_ROLES.includes(user?.role);
  // 'expense' | 'advance' | 'shopping': the two money forms show in place of
  // the expense form; this form's state stays while they show.
  const [view, setView] = useState(canGive && (mode === 'advance' || mode === 'shopping') ? mode : 'expense');
  const navigation = useNavigation();
  const [fromPrefill] = useState(() => (editing || initial ? null : startFromPrefill(prefill)));
  const start = expense || initial || fromPrefill || {};

  // ── Form state ──
  const startName = expense ? (expense.item_name || withoutNote(expense.description, expense.note)) : (start.item_name || start.description || '');
  const startAmount = start.amount ? String(Number(start.amount)) : '';
  const startGivenTo = editing ? givenToFromExpense(expense) : (fromPrefill ? fromPrefill.givenTo : null);
  const [name, setName] = useState(startName);
  const [item, setItem] = useState(
    start.item_id ? { id: Number(start.item_id), name: start.item_name || startName, category: start.category } : null
  );
  const [category, setCategory] = useState(start.category || null);
  // Add mode: the kind comes from the item unless picked in the Kind list.
  const [kindChosen, setKindChosen] = useState(false);
  const [amount, setAmount] = useState(startAmount);
  const [isReturn, setIsReturn] = useState(!!start.is_return);
  const [givenTo, setGivenTo] = useState(startGivenTo);
  const [givenToTouched, setGivenToTouched] = useState(false);
  const [note, setNote] = useState(expense?.note || '');
  const [photo, setPhoto] = useState(null); // a newly picked local asset
  const [photoUrl, setPhotoUrl] = useState(expense?.photo_url || null); // already saved
  const [showExtras, setShowExtras] = useState(!!(expense?.note || expense?.photo_url));
  const [expenseDate, setExpenseDate] = useState(dateStr(expense?.expense_date) || today);
  const [showDates, setShowDates] = useState(false);
  const [showKinds, setShowKinds] = useState(false);
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
  const methodChosen = useRef(false); // a pick or a tap on Paid by already chose
  useEffect(() => {
    if (editing || !sawLoading.current || registerLoading) return;
    sawLoading.current = false;
    if (isOpen && !start.payment_method && !methodChosen.current) setPaymentMethod('cash');
  }, [registerLoading, isOpen]);

  // ── Own pocket: whose pocket (null = Me) ──
  const meId = Number(user?.id);
  const startWhoseId = editing && expense.payment_method === 'own_pocket' && expense.paid_by_user_id
    && Number(expense.paid_by_user_id) !== meId ? Number(expense.paid_by_user_id) : null;
  const [whoseId, setWhoseId] = useState(startWhoseId);
  const [whosePeople, setWhosePeople] = useState([]);
  const [whoseState, setWhoseState] = useState('idle'); // idle | loading | ready | error
  const loadWhose = () => {
    if (!locationId) return;
    setWhoseState('loading');
    api.getExpensePeople(locationId)
      .then((res) => { setWhosePeople(res.data || []); setWhoseState('ready'); })
      .catch(() => setWhoseState('error'));
  };
  useEffect(() => {
    if (paymentMethod === 'own_pocket' && whoseState === 'idle') loadWhose();
  }, [paymentMethod]);
  // A row paid from someone no longer in the list still shows their name.
  const whoseList = startWhoseId && !whosePeople.some((p) => Number(p.id) === startWhoseId)
    ? whosePeople.concat({ id: startWhoseId, name: expense.paid_by_user_name || 'Someone' })
    : whosePeople;

  // ── Suggestions ──
  const [sections, setSections] = useState({ usualNow: [], often: [] });
  const [typed, setTyped] = useState([]);
  const [typedFor, setTypedFor] = useState('');
  const [showTyped, setShowTyped] = useState(false);
  const amountRef = useRef(null);
  const reqId = useRef(0);

  useEffect(() => {
    if (!locationId || editing) return;
    api.getExpenseSuggestions({ location_id: locationId })
      .then((res) => setSections(suggestionSections(res, { hideSalary })))
      .catch(() => setSections({ usualNow: [], often: [] }));
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
          const rows = editing
            ? all.filter((r) => (r.category === 'salary') === (expense.category === 'salary'))
            : all.filter((r) => !(hideSalary && r.category === 'salary'));
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
    const d = pickDefaults(s, { userId: user?.id });
    setName(s.name);
    setItem({ id: s.id, name: s.name, category: s.category });
    setCategory(s.category);
    setKindChosen(false);
    if (d.amount) setAmount(String(d.amount));
    // Your own last Cash/UPI for this item, only when the row knows it (a
    // type-ahead row does not: the current choice stays). A change keeps its method.
    if (!editing && d.method) {
      autoMovedOffCash.current = false;
      methodChosen.current = true;
      setPaymentMethod((cur) => methodAfterPick(cur, s));
    }
    // A change keeps the row's own Given to (controller ruling, fix round 1).
    if (!editing) {
      setGivenTo(d.givenTo);
      setGivenToTouched(true);
    }
    setShowTyped(false);
    setErrors({});
    if (!d.amount) setTimeout(() => amountRef.current?.focus(), 50);
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
  const needsKind = editing ? !salaryRow : isNewName;
  const categoryChoices = (editing || hideSalary) ? EXPENSE_CATEGORIES.filter((c) => c.key !== 'salary') : EXPENSE_CATEGORIES;
  const effectiveCategory = editing ? category : (item && !kindChosen ? item.category : category);
  const isSalary = effectiveCategory === 'salary';
  // Salary: the employee picked IS who it was given to, so Given to is
  // hidden. Moving the Kind away from Salary brings Given to back empty.
  const wasSalary = useRef(isSalary);
  useEffect(() => {
    if (wasSalary.current && !isSalary) { setGivenTo(null); setGivenToTouched(true); }
    wasSalary.current = isSalary;
  }, [isSalary]);

  // Paid by. Own pocket (spec 4.1, 5.5) never touches the drawer, so it stays
  // on with the register closed and on past days; not for a return or salary
  // (server refuses both). A shopping money bill keeps its method.
  const shoppingBill = editing && expense.payment_method === 'shopping_money';
  const ownPocketOk = GIVER_ROLES.includes(user?.role) && !isReturn && !isSalary;
  const methods = shoppingBill ? [{ key: 'shopping_money', label: 'Shopping money' }] : [
    { key: 'cash', label: 'Cash', disabled: cashDisabled },
    { key: 'upi', label: 'UPI' },
  ];
  // Card stays only for an older expense that was paid by card.
  if (editing && expense.payment_method === 'card') methods.push({ key: 'card', label: 'Card' });
  if (!shoppingBill && (ownPocketOk || paymentMethod === 'own_pocket')) {
    methods.push({ key: 'own_pocket', label: 'Own pocket', disabled: !ownPocketOk });
  }
  useEffect(() => {
    if (paymentMethod === 'own_pocket' && !ownPocketOk) setPaymentMethod(cashDisabled ? 'upi' : 'cash');
  }, [ownPocketOk]);

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
      || (photoUrl || null) !== (expense.photo_url || null)
      || (paymentMethod === 'own_pocket' && whoseId !== startWhoseId))
    : (name.trim() !== startName.trim() || (amount !== '' && amount !== startAmount) || !!photo || !!note.trim()
      || category !== (start.category || null) || isReturn !== !!start.is_return || expenseDate !== today
      || pickedEmployeeId !== null || personKey(givenTo) !== personKey(startGivenTo)
      || (paymentMethod === 'own_pocket' && whoseId !== null));
  const requestClose = () => {
    if (saving || removing) return;
    if (!dirty) { onClose(); return; }
    showConfirm('Leave without saving?', 'What you typed here will be lost.', onClose,
      { confirmLabel: 'Leave', cancelLabel: 'Keep typing', destructive: true });
  };
  const firstClose = useRef(closeRequest);
  useEffect(() => {
    // While a money form shows, it handles the close itself.
    if (closeRequest !== firstClose.current && view === 'expense') requestClose();
  }, [closeRequest]);

  // ── Save ──
  const guard = useSubmitGuard();
  const amt = parseFloat(amount);
  const amountOk = Number.isFinite(amt) && amt > 0;

  const validate = () => {
    const e = {};
    if (!name.trim()) e.name = 'Type what this was for, like Petrol.';
    if (!amountOk) e.amount = 'Type how much was paid.';
    if (needsKind && !effectiveCategory) e.category = 'Tap Kind and pick what kind of expense this is.';
    if (isSalary && !salaryEmployee) e.salary = 'Pick which employee this salary payment is for.';
    setErrors(e);
    if (e.amount && !e.name) setTimeout(() => amountRef.current?.focus(), 50);
    return Object.keys(e).length === 0;
  };

  const itemFields = () => {
    // Salary keeps its old shape (no item), as before the expense book.
    if (isSalary && !item) return { description: name.trim(), category: 'salary' };
    if (item) {
      if (editing) return { item_id: item.id, category: effectiveCategory };
      // A kind picked in the Kind list for a known item goes with this entry.
      return kindChosen && category && category !== item.category ? { item_id: item.id, category } : { item_id: item.id };
    }
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
      // Own pocket: whose pocket (Me unless another person was picked).
      if (paymentMethod === 'own_pocket') body.paid_by_user_id = whoseId || meId;
      if (isSalary) {
        // Given to is the salary employee (lists that show Given to agree).
        body.category = 'salary';
        body.given_to_user_id = Number(salaryEmployee.id);
        body.given_to_name = null;
      } else if (!editing || givenToTouched) Object.assign(body, givenToFields());
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

  // ── "This was a salary advance" (owner only, PR 2) ──
  // Hidden when the server would refuse it (canMarkSalaryAdvance); the
  // server stays the guard. Shop-local day, as the server's todayStr.
  const canMarkAdvance = editing && user?.role === 'owner' && canMarkSalaryAdvance(expense, today);
  const [showOldAdvance, setShowOldAdvance] = useState(false);
  const openOldAdvance = () => {
    if (saving || removing) return;
    if (!dirty) { setShowOldAdvance(true); return; }
    showConfirm('Leave without saving?', 'What you changed here will be lost.', () => setShowOldAdvance(true),
      { confirmLabel: 'Leave', cancelLabel: 'Keep typing', destructive: true });
  };

  // ── Date (owner / manager) ──
  const days = useMemo(() => lastSevenDays(today), [today]);
  const dateLabel = (days.find((d) => d.date === expenseDate) || {}).label || expenseDate;

  // ── Salary advance / Shopping money (spec 4.1) ──
  // Who holds shopping money now, for the "<Name> is back? ›" hint.
  const [openShopping, setOpenShopping] = useState([]);
  useEffect(() => {
    if (!canGive || !locationId) return;
    api.getOpenStaffMoney({ location_id: locationId })
      .then((res) => setOpenShopping(res.data?.shopping || []))
      .catch(() => setOpenShopping([]));
  }, [locationId]);
  const isBackReady = (() => {
    try { return (navigation.getState()?.routeNames || []).includes(IS_BACK_SCREEN); } catch { return false; }
  })();
  const held = givenTo && givenTo.user_id ? heldBy(openShopping, givenTo.user_id) : { amount: 0, id: null };
  const isBackLine = canGive && isBackReady && !isSalary && !isReturn && held.id ? isBackHint(givenToLabel(givenTo), held.amount) : null;
  const goIsBack = () => {
    const go = () => { onClose(); navigation.navigate(IS_BACK_SCREEN, { id: held.id, locationId }); };
    if (!name.trim() && !amount && !note.trim() && !photo) { go(); return; }
    showConfirm('Leave without saving?', 'What you typed here will be lost.', go,
      { confirmLabel: 'Leave', cancelLabel: 'Keep typing', destructive: true });
  };
  const typedLinks = canGive && !isReturn && showTyped ? moneyLinksFor(name, { hideSalary }) : [];
  const openMoney = (kind, fromTyping) => {
    if (fromTyping) {
      // "advance" was typed only to find the link: leave the expense form clean.
      reqId.current += 1;
      setName(''); setItem(null); setShowTyped(false);
      setErrors((e) => ({ ...e, name: undefined }));
    }
    setView(kind);
  };

  if (view === 'km') {
    return (
      <KmReadingForm
        key="km"
        locationId={locationId}
        onBack={() => setView('expense')}
        onClose={onClose}
        onDone={(result) => onSaved && onSaved(result)}
        closeRequest={closeRequest}
      />
    );
  }

  if (view !== 'expense') {
    return (
      <MoneyToStaffForm
        key={view}
        kind={view}
        locationId={locationId}
        registerOpen={isOpen}
        registerLoading={registerLoading}
        register={register}
        onBack={() => setView('expense')}
        onClose={onClose}
        onDone={(result) => onSaved && onSaved(result)}
        onRegisterOpened={() => { setOpenedHere(true); onRegisterOpened && onRegisterOpened(); }}
        closeRequest={closeRequest}
      />
    );
  }

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
  const showSuggestions = !editing && !(showTyped && name.trim()) && (sections.usualNow.length + sections.often.length) > 0;
  const suggestItems = sections.usualNow.concat(sections.often);
  const extrasText = [note.trim() ? 'Note' : null, photoPreview ? 'Bill photo' : null].filter(Boolean).join(' · ');

  let kindValue = effectiveCategory ? categoryLabel(effectiveCategory) : '';
  if (kindValue && item && !editing && !kindChosen) kindValue = `${kindValue} (from the item)`;
  const kindHint = salaryRow
    ? 'A salary line stays Salary. To make it something else, remove it and add it again.'
    : (!editing && isNewName && !effectiveCategory ? 'New item — tap Kind and pick what kind it is.' : null);

  const suggestionRow = (s) => {
    const d = pickDefaults(s);
    const active = !!item && item.id === s.id;
    return (
      <TouchableOpacity
        key={s.id}
        style={styles.suggestRow}
        onPress={() => pickSuggestion(s)}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={`${s.name}${d.amount ? `, ${rupees(d.amount)}` : ''}, ${suggestionLine(s)}`}
      >
        <View style={{ flex: 1 }}>
          <Text style={[styles.suggestName, active && styles.suggestNameActive]} numberOfLines={1}>{s.name}</Text>
          <Text style={styles.suggestMeta} numberOfLines={1}>{suggestionLine(s)}</Text>
        </View>
        {!!d.amount && <Text style={styles.suggestAmount}>{rupees(d.amount)}</Text>}
        {active && <Ionicons name="checkmark" size={20} color={Colors.primary} />}
      </TouchableOpacity>
    );
  };

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

        {/* Usual now, then Often */}
        {showSuggestions && (
          <View style={styles.section}>
            {sections.usualNow.length > 0 && <Text style={styles.sectionTitle}>Usual now</Text>}
            {sections.usualNow.map(suggestionRow)}
            {sections.often.length > 0 && <Text style={styles.sectionTitle}>Often</Text>}
            {sections.often.map(suggestionRow)}
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
        {typedLinks.length > 0 && (
          <View style={styles.typedList}>
            {typedLinks.map((k) => (
              <TouchableOpacity key={k} style={styles.typedRow} onPress={() => openMoney(k, true)} accessibilityRole="button">
                <Text style={[styles.typedName, { color: Colors.primary }]}>{MONEY_LINKS[k].label} ›</Text>
                <Text style={styles.typedMeta}>{MONEY_LINKS[k].sub}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
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

        {/* Amount */}
        <Text style={styles.label}>Amount</Text>
        <View style={[styles.amountBox, errors.amount && styles.inputError, cashLocked && styles.lockedBox]}>
          <Text style={styles.rupee}>₹</Text>
          <TextInput
            ref={amountRef}
            style={[styles.amountInput, cashLocked && { color: Colors.textLight }]}
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
        {!!errors.amount && <Text style={styles.error}>{errors.amount}</Text>}

        {/* Paid by: Cash | UPI */}
        <Text style={styles.label}>Paid by</Text>
        <MethodSwitch
          value={paymentMethod}
          options={methods}
          locked={cashLocked || shoppingBill}
          onChange={(k) => { autoMovedOffCash.current = false; methodChosen.current = true; setPaymentMethod(k); }}
          whose={{
            meId, people: whoseList, value: whoseId, state: whoseState, onRetry: loadWhose,
            onChange: (id) => setWhoseId(id),
          }}
        />
        {paymentMethod === 'own_pocket' && (
          <Text style={styles.hint}>
            Not from the drawer. The shop owes {whoseId ? firstNameOf(whoseList, whoseId) : 'you'} this until it is paid back.
          </Text>
        )}
        {shoppingBill && (
          <Text style={styles.hint}>Bought with shopping money, so Paid by stays as it is.</Text>
        )}
        {cashLocked && (
          <Text style={styles.hint}>
            This cash was paid on a day whose register is already closed, so the amount and Cash/UPI stay as they are. You can still change the rest.
          </Text>
        )}
        {cashPastDay && (
          <Text style={styles.hint}>Past days don't change today's drawer, so an earlier day is paid by UPI.</Text>
        )}
        {cashDisabled && !cashPastDay && paymentMethod !== 'own_pocket' && !shoppingBill && (
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

        {/* Given to (optional). Not for Salary: the employee below is the person. */}
        {!isSalary && (
          <>
            <Text style={styles.label}>Given to <Text style={styles.optional}>(optional)</Text></Text>
            <RecentPeople
              locationId={locationId}
              items={suggestItems}
              value={givenTo}
              onChange={(v) => { setGivenTo(v); setGivenToTouched(true); }}
            />
            {!!isBackLine && (
              <TouchableOpacity style={styles.isBackRow} onPress={goIsBack} accessibilityRole="button">
                <Text style={styles.isBackText}>{isBackLine}</Text>
                <Ionicons name="chevron-forward" size={20} color={Colors.primary} />
              </TouchableOpacity>
            )}
          </>
        )}

        <View style={styles.rows}>
          {/* Kind: from the item; Salary not offered to counter staff */}
          <SheetRow
            label="Kind"
            value={kindValue}
            placeholder={isNewName ? 'Pick one' : '—'}
            onPress={() => setShowKinds(true)}
            disabled={salaryRow}
            hint={kindHint}
            error={errors.category}
          />
          {isSalary && (
            <SalaryEmployeePicker
              locationId={locationId}
              value={salaryEmployee}
              onChange={(u) => { setSalaryEmployee(u); setErrors((e) => ({ ...e, salary: undefined })); }}
              error={errors.salary}
            />
          )}

          {/* Date: owner and manager only */}
          {isBoss && <SheetRow label="Date" value={dateLabel} onPress={() => setShowDates(true)} />}

          {/* Note / bill photo */}
          <SheetRow
            label="Note / bill photo"
            value={extrasText}
            onPress={() => setShowExtras((v) => !v)}
            accessibilityLabel={`Note and bill photo: ${extrasText || 'none'}. Tap to ${showExtras ? 'hide' : 'add'}.`}
          />
          {showExtras && (
            <View style={styles.extras}>
              <TextInput
                style={styles.input}
                value={note}
                onChangeText={setNote}
                placeholder="Note (optional)"
                placeholderTextColor={Colors.textLight}
                maxLength={200}
                accessibilityLabel="Note"
              />
              <View style={styles.photoRow}>
                {photoPreview && (
                  <Image source={{ uri: photoPreview }} style={styles.photo} resizeMode="cover" accessibilityLabel="Bill photo" />
                )}
                <TouchableOpacity style={styles.extraBtn} onPress={choosePhoto} accessibilityRole="button">
                  <Ionicons name="camera-outline" size={20} color={Colors.primary} />
                  <Text style={styles.extraText}>{photoPreview ? 'Change bill photo' : 'Add bill photo'}</Text>
                </TouchableOpacity>
                {photoPreview && (
                  <TouchableOpacity
                    style={styles.extraBtn}
                    onPress={() => { setPhoto(null); setPhotoUrl(null); }}
                    accessibilityRole="button"
                  >
                    <Ionicons name="trash-outline" size={18} color={Colors.error} />
                    <Text style={[styles.extraText, { color: Colors.error }]}>Remove photo</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}
        </View>

        {/* Salary advance / Shopping money: given to staff, not an expense here */}
        {canGive && !isReturn && (
          <View style={styles.moneyLinks}>
            {['advance', 'shopping', 'km'].map((k) => (
              <TouchableOpacity
                key={k}
                style={styles.moneyLink}
                onPress={() => openMoney(k, false)}
                accessibilityRole="button"
                accessibilityLabel={`${MONEY_LINKS[k].label}: ${MONEY_LINKS[k].sub}`}
              >
                <Ionicons name="arrow-forward-circle-outline" size={20} color={Colors.primary} />
                <Text style={styles.moneyLinkText}>{MONEY_LINKS[k].label}</Text>
              </TouchableOpacity>
            ))}
          </View>
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
        {canMarkAdvance && (
          <TouchableOpacity
            style={styles.advanceBtn}
            onPress={openOldAdvance}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="This was a salary advance"
          >
            <Ionicons name="people-outline" size={20} color={Colors.primary} />
            <Text style={styles.advanceText}>This was a salary advance</Text>
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

      {canMarkAdvance && (
        <OldExpenseAdvanceSheet
          visible={showOldAdvance}
          expense={expense}
          onClose={() => setShowOldAdvance(false)}
          onDone={(result) => { setShowOldAdvance(false); onSaved && onSaved(result); }}
        />
      )}

      <OptionList
        visible={showKinds}
        title="What kind of expense?"
        options={categoryChoices.map((c) => ({ key: c.key, label: c.label, selected: effectiveCategory === c.key }))}
        onPick={(o) => {
          setShowKinds(false);
          setCategory(o.key);
          setKindChosen(true);
          setErrors((e) => ({ ...e, category: undefined }));
        }}
        onClose={() => setShowKinds(false)}
      />

      {isBoss && (
        <>
          <OptionList
            visible={showDates}
            title="Which day was it paid?"
            options={days.map((d) => ({ key: d.date, label: d.label, selected: d.date === expenseDate }))}
            footer={[{ key: 'other', label: 'Other day…' }]}
            onPick={(o) => {
              setShowDates(false);
              // iOS cannot open a modal while another is still closing.
              if (o.key === 'other') { setTimeout(() => setShowOtherDay(true), Platform.OS === 'ios' ? 400 : 0); return; }
              setExpenseDate(o.key);
            }}
            onClose={() => setShowDates(false)}
          />
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
            }}
          />
        </>
      )}
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
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.xs },
  title: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, flex: 1 },
  closeBtn: { minWidth: 48, minHeight: 48, alignItems: 'flex-end', justifyContent: 'center' },
  scroll: { flexGrow: 0 },

  returnNote: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.successLight, borderRadius: BorderRadius.md, padding: Spacing.sm, marginBottom: Spacing.sm,
  },
  returnNoteText: { fontSize: FontSize.md, color: Colors.text, flex: 1 },

  // Usual now / Often: plain list rows with thin dividers
  section: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border, paddingBottom: Spacing.xs },
  sectionTitle: {
    fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary, textTransform: 'uppercase',
    letterSpacing: 0.5, marginTop: Spacing.sm, marginBottom: Spacing.xs,
  },
  suggestRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 56, paddingVertical: Spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border,
  },
  suggestName: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  suggestNameActive: { color: Colors.primary },
  suggestMeta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  suggestAmount: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] },

  label: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginTop: Spacing.md, marginBottom: Spacing.xs },
  optional: { fontWeight: '400', color: Colors.textSecondary },
  input: {
    minHeight: 52, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, fontSize: FontSize.md, color: Colors.text, backgroundColor: Colors.background,
  },
  inputError: { borderColor: Colors.error },
  error: { color: Colors.error, fontSize: FontSize.md, marginTop: Spacing.xs },
  hint: { color: Colors.textSecondary, fontSize: FontSize.sm, marginTop: Spacing.xs },

  // Salary employee chips
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs,
    minHeight: 48, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.md, color: Colors.text },
  chipTextActive: { color: Colors.white, fontWeight: '700' },

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

  amountBox: {
    flexDirection: 'row', alignItems: 'center', minHeight: 56,
    borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, backgroundColor: Colors.background,
  },
  lockedBox: { backgroundColor: Colors.surfaceAlt },
  rupee: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.textSecondary, marginRight: Spacing.xs },
  amountInput: {
    flex: 1, minHeight: 54, fontSize: FontSize.xl, fontWeight: '800', color: Colors.text,
    fontVariant: ['tabular-nums'],
  },

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
  extras: { paddingVertical: Spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border },
  photoRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: Spacing.md, marginTop: Spacing.sm },
  photo: { width: 72, height: 72, borderRadius: BorderRadius.sm, backgroundColor: Colors.surfaceAlt },
  extraBtn: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 44, paddingHorizontal: Spacing.xs },
  extraText: { fontSize: FontSize.md, color: Colors.primary, fontWeight: '600' },

  moneyLinks: {
    flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.md,
    paddingVertical: Spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border,
  },
  moneyLink: { flex: 1, minWidth: 150, flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 48 },
  moneyLinkText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  isBackRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 48, marginTop: Spacing.xs,
  },
  isBackText: { flex: 1, fontSize: FontSize.md, color: Colors.primary, fontWeight: '600' },

  linkBtn: { minHeight: 48, justifyContent: 'center', alignItems: 'center', marginTop: Spacing.md },
  linkText: { fontSize: FontSize.md, color: Colors.textSecondary, textDecorationLine: 'underline' },
  removeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    minHeight: 48, marginBottom: Spacing.sm,
  },
  removeText: { color: Colors.error, fontWeight: '600', fontSize: FontSize.md },
  advanceBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    minHeight: 48, marginTop: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 1, borderColor: Colors.primary, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md,
  },
  advanceText: { color: Colors.primary, fontWeight: '700', fontSize: FontSize.md },

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
