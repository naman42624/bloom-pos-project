/**
 * The Usual now 1-tap line on the Expenses screen (staff money spec §4.3):
 *
 *   Usual now
 *     Tea   ₹50   Cash · Tota Ram              [+ Add]
 *     Milk  ₹60   Cash                         [+ Add]
 *
 * + Add saves at once with what the line shows; a large bar at the bottom,
 * "Added Tea ₹50 · Cash — Undo", stays 15 seconds. Tapping the name opens
 * the add sheet pre-filled instead. A Cash line with the register closed
 * reads "Open register" (never switched to UPI quietly).
 *
 * useUsualNow() keeps the rows and the Undo state; the screen renders
 * <UsualNowLine> where the line goes and <UndoBar> at the bottom of the
 * screen. The pure parts live in usualNowUndo.js (tested in plain node).
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../services/api';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import { showAlert } from '../../utils/alert';
import { pickDefaults, suggestionLine } from '../../utils/expenseBook';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';
import {
  UNDO_MS, initialUndoState, undoReducer, undoBarText, usualNowBody, usualNowRows,
} from './usualNowUndo';

export { UNDO_MS, initialUndoState, undoReducer, undoBarText, usualNowBody, usualNowRows };

const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const REGISTER_CLOSED = /register isn.t open/i;

// locationId: the shop entries are added to (null hides the line).
// onChanged(): after an add or an undo, so the screen refreshes its list.
// onOpenRegister(): where "Open register" goes.
export function useUsualNow({ locationId, enabled = true, onChanged, onOpenRegister }) {
  const [items, setItems] = useState([]);
  const [state, dispatch] = useReducer(undoReducer, initialUndoState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const reqId = useRef(0);
  const addGuard = useSubmitGuard();
  const undoGuard = useSubmitGuard();

  const reload = useCallback(() => {
    const id = ++reqId.current;
    if (!enabled || !locationId) { setItems([]); return; }
    api.getExpenseSuggestions({ location_id: locationId })
      .then((res) => { if (id === reqId.current) setItems(usualNowRows(res)); })
      .catch(() => { if (id === reqId.current) setItems([]); });
  }, [enabled, locationId]);

  // On focus and when the shop changes ("usual now" moves with the clock).
  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  // The bar closes itself after 15 s.
  const expiresAt = state.bar ? state.bar.expiresAt : null;
  useEffect(() => {
    if (!expiresAt) return undefined;
    const t = setTimeout(() => dispatch({ type: 'expire', now: Date.now() }), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(t);
  }, [expiresAt]);

  // An Undo the server refused: its own plain message; the entry stays.
  useEffect(() => {
    if (!state.message) return;
    showAlert('Could not undo', state.message);
    dispatch({ type: 'message_shown' });
  }, [state.message]);

  const add = addGuard(async (item) => {
    const body = usualNowBody(item, locationId);
    if (!body) return;
    dispatch({ type: 'add_start' });
    try {
      const res = await api.createExpense(body);
      const saved = res?.data || { id: null };
      dispatch({
        type: 'add_done',
        expense: saved,
        text: undoBarText(item.name, body.amount, body.payment_method),
        now: Date.now(),
      });
      onChanged && onChanged();
      reload();
    } catch (err) {
      dispatch({ type: 'add_failed' });
      const msg = err?.message || 'It was not saved. Check the connection and try again.';
      if (body.payment_method === 'cash' && REGISTER_CLOSED.test(String(err?.raw_message || ''))) {
        showAlert('Register is closed', msg, [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open register', onPress: () => onOpenRegister && onOpenRegister() },
        ]);
        return;
      }
      showAlert('Could not save', msg);
    }
  });

  const undo = undoGuard(async () => {
    const bar = stateRef.current.bar;
    if (!bar || bar.undoing || !bar.expense || !bar.expense.id) return;
    dispatch({ type: 'undo_start' });
    try {
      await api.deleteExpense(bar.expense.id);
      dispatch({ type: 'undo_done' });
      onChanged && onChanged();
      reload();
    } catch (err) {
      dispatch({ type: 'undo_failed', message: err?.message });
    }
  });

  return { items, state, add, undo, reload };
}

export default function UsualNowLine({
  items, saving, registerOpen, registerLoading, onAdd, onOpenSheet, onOpenRegister, style,
}) {
  if (!items || items.length === 0) return null;
  return (
    <View style={[styles.box, style]}>
      <Text style={styles.title}>Usual now</Text>
      {items.map((item, i) => {
        const d = pickDefaults(item);
        const body = usualNowBody(item, 0);
        const cashClosed = body && body.payment_method === 'cash' && !registerLoading && !registerOpen;
        const line = suggestionLine(item);
        return (
          <View key={item.id} style={[styles.row, i > 0 && styles.rowDivider]}>
            <TouchableOpacity
              style={styles.nameArea}
              onPress={() => onOpenSheet(item)}
              accessibilityRole="button"
              accessibilityLabel={`${item.name}${d.amount ? `, ${rupees(d.amount)}` : ''}${line ? `, ${line}` : ''}. Opens the form to change it first.`}
            >
              <View style={styles.nameTop}>
                <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                {!!d.amount && <Text style={styles.amount}>{rupees(d.amount)}</Text>}
              </View>
              {!!line && <Text style={styles.meta} numberOfLines={1}>{line}</Text>}
            </TouchableOpacity>
            {cashClosed ? (
              <TouchableOpacity
                style={[styles.btn, styles.btnWarn]}
                onPress={onOpenRegister}
                accessibilityRole="button"
                accessibilityLabel={`Open register to pay ${item.name} in cash`}
              >
                <Text style={[styles.btnText, styles.btnWarnText]}>Open register</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.btn, saving && styles.btnBusy]}
                // No amount known: the sheet opens so one can be typed.
                onPress={() => (body ? onAdd(item) : onOpenSheet(item))}
                disabled={saving}
                accessibilityRole="button"
                accessibilityState={{ disabled: !!saving }}
                accessibilityLabel={body ? `Add ${undoBarText(item.name, body.amount, body.payment_method).slice(6)}` : `Add ${item.name}`}
              >
                <Text style={styles.btnText}>+ Add</Text>
              </TouchableOpacity>
            )}
          </View>
        );
      })}
    </View>
  );
}

// The large bar at the bottom of the screen: "Added Tea ₹50 · Cash — Undo".
export function UndoBar({ bar, onUndo }) {
  if (!bar) return null;
  return (
    <View style={styles.bar} accessibilityLiveRegion="polite">
      <Ionicons name="checkmark-circle" size={22} color={Colors.success} />
      <Text style={styles.barText} numberOfLines={2}>{bar.text}</Text>
      <TouchableOpacity
        style={styles.undoBtn}
        onPress={onUndo}
        disabled={bar.undoing}
        accessibilityRole="button"
        accessibilityLabel={`Undo: remove ${bar.text.replace(/^Added /, '')}`}
      >
        {bar.undoing
          ? <ActivityIndicator color={Colors.primary} />
          : <Text style={styles.undoText}>Undo</Text>}
      </TouchableOpacity>
    </View>
  );
}

export const UNDO_BAR_SPACE = 96; // room to leave under a list while the bar shows

const styles = StyleSheet.create({
  box: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, marginBottom: Spacing.sm,
  },
  title: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 60 },
  rowDivider: { borderTopWidth: 1, borderTopColor: Colors.border },
  nameArea: { flex: 1, minHeight: 52, justifyContent: 'center', paddingVertical: Spacing.xs },
  nameTop: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.sm },
  name: { flexShrink: 1, fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  amount: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] },
  meta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  btn: {
    minHeight: 44, minWidth: 88, paddingHorizontal: Spacing.md, justifyContent: 'center', alignItems: 'center',
    borderRadius: BorderRadius.md, borderWidth: 1.5, borderColor: Colors.primary, backgroundColor: Colors.surface,
  },
  btnBusy: { opacity: 0.5 },
  btnText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  btnWarn: { borderColor: Colors.warning, backgroundColor: Colors.warningLight },
  btnWarnText: { color: Colors.text },
  bar: {
    position: 'absolute', left: Spacing.md, right: Spacing.md, bottom: Spacing.md,
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    minHeight: 64, paddingLeft: Spacing.md, paddingRight: Spacing.sm, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md, backgroundColor: Colors.text,
    shadowColor: Colors.black, shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 6,
  },
  barText: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.white },
  undoBtn: {
    minHeight: 48, minWidth: 96, paddingHorizontal: Spacing.md, justifyContent: 'center', alignItems: 'center',
    borderRadius: BorderRadius.md, backgroundColor: Colors.white,
  },
  undoText: { fontSize: FontSize.md, fontWeight: '800', color: Colors.primary },
});
