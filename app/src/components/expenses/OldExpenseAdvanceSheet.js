/**
 * OldExpenseAdvanceSheet: "Whose advance?" (owner only, PR 2).
 *
 * An old Cash/UPI expense was really money given to an employee. The owner
 * picks the person; that runs a preview at once (server checks + salary paid
 * since that day). Save marks it: the expense becomes a salary line and an
 * approved advance that comes off their next salary. No drawer move.
 *
 *   Whose advance?                                   ✕
 *   ₹500 on 2 Nov becomes a salary advance. It will be taken off their
 *   next salary.
 *   (Asha)  (Mohan ✓)  (Ramesh)          one row each, 52 px
 *   ⚠ Mohan was already paid salary on 7 Nov. If you already took this
 *     off that pay, don't mark it.
 *   [                    Save                    ]
 *
 * Path from the Expenses list: row → "This was a salary advance" → person
 * → Save = 4 taps.
 *
 * Staff list: GET /api/users (owner can read it), active users in the
 * Payroll roles, sorted by name.
 *
 * Change mode (mode="change", owner, an untaken advance made this way):
 * titled "Change whose advance?", the current person is left out of the
 * list, and the same route moves the advance; success says "Changed".
 *
 * Props: visible, expense, mode ('mark' | 'change'), onClose(), onDone(result)
 *   result = { expense, removed: false } after a save
 */
import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../services/api';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import { bumpActivity } from '../../hooks/useIdleLock';
import { showAlert } from '../../utils/alert';
import { sheetLine, paidAfterWarning, successAlert, changedAlert, payrollPeople } from '../../utils/oldExpenseAdvance';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

const ROLE_LABELS = {
  manager: 'Manager',
  employee: 'Staff',
  counter_staff: 'Counter',
  florist_staff: 'Florist',
  delivery_partner: 'Delivery',
};
const LOAD_FAILED_MESSAGE = 'Could not load the staff list. Check the connection and tap Try again.';

async function loadStaff() {
  const all = [];
  for (let page = 1; page <= 5; page += 1) {
    const res = await api.getUsers({ is_active: '1', limit: 100, page });
    all.push(...(res.data?.users || []));
    if (page >= (res.data?.pagination?.totalPages || 1)) break;
  }
  return payrollPeople(all);
}

export default function OldExpenseAdvanceSheet({ visible, expense, mode = 'mark', onClose, onDone }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View onTouchStart={bumpActivity} style={styles.sheet}>
          {visible && !!expense && <Body expense={expense} mode={mode} onClose={onClose} onDone={onDone} />}
        </View>
      </View>
    </Modal>
  );
}

function Body({ expense, mode, onClose, onDone }) {
  const changing = mode === 'change';
  const currentId = changing ? Number(expense.employee_id || expense.given_to_user_id || 0) : 0;
  const [staff, setStaff] = useState(null); // null = loading
  const [loadFailed, setLoadFailed] = useState(false);
  const [picked, setPicked] = useState(null); // { id, name }
  const [preview, setPreview] = useState(null); // preview data for `picked`
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const reqId = useRef(0);
  const guard = useSubmitGuard();

  const load = () => {
    setLoadFailed(false);
    setStaff(null);
    loadStaff()
      .then((list) => setStaff(currentId ? list.filter((p) => Number(p.id) !== currentId) : list))
      .catch(() => { setStaff([]); setLoadFailed(true); });
  };
  useEffect(load, []);

  const pick = async (person) => {
    if (saving) return;
    const id = (reqId.current += 1);
    setPicked({ id: person.id, name: person.name });
    setPreview(null);
    setChecking(true);
    try {
      const res = await api.markExpenseSalaryAdvance(expense.id, { employee_id: person.id, preview: true });
      if (id !== reqId.current) return;
      setPreview(res.data || null);
    } catch (err) {
      if (id !== reqId.current) return;
      setPicked(null);
      showAlert(changing ? 'Could not change it' : 'Could not mark it', err?.message || 'Check the connection and try again.');
    } finally {
      if (id === reqId.current) setChecking(false);
    }
  };

  const ready = !!picked && !!preview && Number(preview.employee?.id) === Number(picked.id) && !checking;

  const save = async () => {
    if (!ready) return;
    setSaving(true);
    try {
      const res = await api.markExpenseSalaryAdvance(expense.id, { employee_id: picked.id });
      setSaving(false);
      const name = preview.employee?.name || picked.name;
      const a = (changing ? changedAlert : successAlert)(preview.amount ?? expense.amount, name);
      showAlert(a.title, a.message);
      onDone && onDone({ expense: res.data?.expense || null, removed: false });
    } catch (err) {
      setSaving(false);
      showAlert(changing ? 'Could not change it' : 'Could not mark it', err?.message || 'It was not saved. Check the connection and try again.');
    }
  };

  const requestClose = () => { if (!saving) onClose(); };
  const warning = ready ? paidAfterWarning(preview.employee?.name || picked.name, preview.salary_paid_after) : null;
  const busy = saving || checking;

  return (
    <>
      <View style={styles.header}>
        <Text style={styles.title}>{changing ? 'Change whose advance?' : 'Whose advance?'}</Text>
        <TouchableOpacity onPress={requestClose} accessibilityRole="button" accessibilityLabel="Close" style={styles.closeBtn}>
          <Ionicons name="close" size={26} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>
      <Text style={styles.line}>{sheetLine(expense.amount, String(expense.expense_date || '').slice(0, 10))}</Text>

      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        {staff === null && (
          <View style={styles.center}><ActivityIndicator color={Colors.primary} /></View>
        )}
        {loadFailed && (
          <View style={styles.center}>
            <Text style={styles.empty}>{LOAD_FAILED_MESSAGE}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={load} accessibilityRole="button">
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          </View>
        )}
        {staff && !loadFailed && staff.length === 0 && (
          <Text style={styles.empty}>No staff to pick yet. Add the person as a user first, then come back here.</Text>
        )}
        {(staff || []).map((p) => {
          const selected = !!picked && Number(picked.id) === Number(p.id);
          return (
            <TouchableOpacity
              key={p.id}
              style={[styles.row, selected && styles.rowSelected]}
              onPress={() => pick(p)}
              disabled={saving}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: saving }}
              accessibilityLabel={`${p.name}, ${ROLE_LABELS[p.role] || ''}`}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.name, selected && styles.nameSelected]}>{p.name}</Text>
                {!!ROLE_LABELS[p.role] && <Text style={styles.role}>{ROLE_LABELS[p.role]}</Text>}
              </View>
              {selected && checking && <ActivityIndicator color={Colors.primary} />}
              {selected && !checking && preview && <Ionicons name="checkmark-circle" size={24} color={Colors.primary} />}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {!!warning && (
        <View style={styles.warning} accessibilityRole="alert">
          <Ionicons name="warning" size={20} color={Colors.warning} />
          <Text style={styles.warningText}>{warning}</Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.saveBtn, (!ready || busy) && styles.saveBtnOff]}
        onPress={guard(save)}
        disabled={!ready || busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: !ready || busy }}
      >
        {saving
          ? <ActivityIndicator color={Colors.white} />
          : <Text style={styles.saveText}>Save</Text>}
      </TouchableOpacity>
      {!picked && !!staff && staff.length > 0 && (
        <Text style={styles.hint}>Tap the person who got this money.</Text>
      )}
    </>
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
  line: { fontSize: FontSize.md, color: Colors.text, lineHeight: 22, marginBottom: Spacing.sm },
  list: { flexGrow: 0, flexShrink: 1 },
  center: { alignItems: 'center', paddingVertical: Spacing.lg },
  empty: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', paddingVertical: Spacing.md },
  retryBtn: {
    minHeight: 48, paddingHorizontal: Spacing.lg, justifyContent: 'center',
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary,
  },
  retryText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  row: {
    flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border, borderRadius: BorderRadius.md,
  },
  rowSelected: { backgroundColor: Colors.primaryGlow },
  name: { fontSize: FontSize.md, color: Colors.text },
  nameSelected: { fontWeight: '800', color: Colors.primaryDark },
  role: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  warning: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs,
    backgroundColor: Colors.warningLight, borderRadius: BorderRadius.md, padding: Spacing.sm, marginTop: Spacing.sm,
  },
  warningText: { flex: 1, fontSize: FontSize.md, color: Colors.text, lineHeight: 22 },
  saveBtn: {
    minHeight: 56, borderRadius: BorderRadius.md, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center', marginTop: Spacing.md,
  },
  saveBtnOff: { opacity: 0.45 },
  saveText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '800' },
  hint: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.xs },
});
