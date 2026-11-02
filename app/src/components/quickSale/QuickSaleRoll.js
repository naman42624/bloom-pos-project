/**
 * QuickSaleRoll — the "This session" list under the quick sale pad.
 *
 *   This session    Cash ₹8,450 · UPI ₹3,200 · 31 sales
 *   ✓ ₹500  Bouquet     Cash  2:41   [Undo]
 *   ⟳ ₹200  Rose bunch  Cash  saving…
 *   ✕ ₹30   Loose rose  Cash  Not saved — tap to try again
 *
 * Purely presentational: the panel owns sending, undo and refreshes.
 *
 * Props:
 *   entries  — server rows from GET /quick-sale/roll (saved, newest first)
 *   pending  — local rows: { localId, saleId, status 'saving'|'saved'|'failed',
 *              amount, method, label, createdAt, errorText }
 *   totals   — server totals { cash, upi, count } (saved, not undone)
 *   undoneUntil — { [saleId]: ms } while the "Undone · Redo" window is open
 *   methodOverride — { [saleId]: 'cash'|'upi' } while a method change saves
 *   busy     — { [saleId]: true } while undo / change is in flight
 *   loadError, onReload
 *   onUndo(row) onRedo(row) onRetry(row) onDismiss(row)
 *   onChangeMethod(row, method) onPrint(row) onAddDetails(row)
 */
import React, { useMemo, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, Modal, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';
import { bumpActivity } from '../../hooks/useIdleLock';
import { formatTime } from '../../utils/datetime';

// Darker than Colors.success / Colors.info so white text on them, and them
// as text on white, both reach 4.5:1 (spec ruling 14). The pad tint stays light.
export const METHOD_COLOR = { cash: '#15803D', upi: '#1D4ED8' };
export const METHOD_LABEL = { cash: 'Cash', upi: 'UPI' };

// ₹ with Indian digit grouping (1,00,000), paise only when there are any.
export function inr(n) {
  const v = Math.round(Number(n || 0) * 100) / 100;
  const [whole, paise] = Math.abs(v).toFixed(2).split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return (v < 0 ? '-' : '') + '₹' + grouped + (paise === '00' ? '' : '.' + paise);
}

function timeLabel(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return value.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  return formatTime(value, 'en-IN', { hour: 'numeric' });
}

export default function QuickSaleRoll({
  entries = [], pending = [], totals, undoneUntil = {}, methodOverride = {}, busy = {},
  loadError, onReload,
  onUndo, onRedo, onRetry, onDismiss, onChangeMethod, onPrint, onAddDetails,
}) {
  const [sheetRow, setSheetRow] = useState(null);

  // Local lines (newest first) sit above the server rows. The panel drops a
  // saved / undone local line once a later server refresh is applied, so the
  // server is the only source after that. Totals are the server's only.
  const { rows, shownTotals } = useMemo(() => {
    const serverIds = new Set(entries.map((e) => e.id));
    const local = pending
      .filter((p) => !(p.saleId && serverIds.has(p.saleId)))
      .sort((a, b) => b.localId - a.localId);
    const t = { cash: Number(totals?.cash || 0), upi: Number(totals?.upi || 0), count: Number(totals?.count || 0) };
    const localRows = local.map((p) => {
      return {
        key: `l${p.localId}`, localId: p.localId, saleId: p.saleId, status: p.status,
        amount: p.amount, method: p.method, label: p.label, time: p.createdAt, errorText: p.errorText,
      };
    });
    const serverRows = entries.map((e) => ({
      key: `s${e.id}`, saleId: e.id, status: e.undone ? 'undone' : 'saved',
      amount: e.amount, method: e.method, label: e.item_name, time: e.created_at,
    }));
    return { rows: [...localRows, ...serverRows], shownTotals: t };
  }, [entries, pending, totals]);

  const now = Date.now();
  const sheetMethod = sheetRow ? (methodOverride[sheetRow.saleId] || sheetRow.method) : null;
  const otherMethod = sheetMethod === 'cash' ? 'upi' : 'cash';
  const closeSheet = () => setSheetRow(null);
  const fromSheet = (fn) => () => { const row = sheetRow; setSheetRow(null); if (row) fn(row); };

  const renderRow = ({ item: row }) => {
    const method = methodOverride[row.saleId] || row.method;
    const color = METHOD_COLOR[method] || Colors.textSecondary;
    const inRedo = row.status === 'undone' && undoneUntil[row.saleId] && undoneUntil[row.saleId] > now;
    const greyed = row.status === 'undone' && !inRedo;
    const isBusy = row.saleId && busy[row.saleId];

    let onPress = null;
    let hint = '';
    if (row.status === 'failed') {
      onPress = row.errorText ? () => onDismiss(row) : () => onRetry(row);
      hint = row.errorText ? 'Tap to remove this line' : 'Tap to try again';
    } else if (row.status === 'saved' && row.saleId && !isBusy) {
      onPress = () => setSheetRow(row);
      hint = 'Tap for more: change method, print, add details, undo';
    }

    let icon = <Ionicons name="checkmark-circle" size={24} color={METHOD_COLOR.cash} />;
    if (row.status === 'saving' || isBusy) icon = <ActivityIndicator size="small" color={Colors.textSecondary} style={{ width: 24 }} />;
    else if (row.status === 'failed') icon = <Ionicons name="close-circle" size={24} color={Colors.error} />;
    else if (row.status === 'undone') icon = <Ionicons name="arrow-undo-circle" size={24} color={Colors.textLight} />;

    return (
      <TouchableOpacity
        activeOpacity={onPress ? 0.6 : 1}
        disabled={!onPress}
        onPress={onPress || undefined}
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityHint={hint || undefined}
        style={[styles.row, row.status === 'failed' && styles.rowFailed]}
      >
        {icon}
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.rowTop}>
            <Text style={[styles.amount, greyed && styles.struck]}>{inr(row.amount)}</Text>
            <Text style={[styles.label, greyed && styles.struck]}>{row.label || '—'}</Text>
          </View>
          {row.status === 'failed' ? (
            <Text style={styles.failedText}>{row.errorText || 'Not saved — tap to try again'}</Text>
          ) : (
            <Text style={styles.meta}>
              <Text style={{ color: greyed ? Colors.textLight : color, fontWeight: '800' }}>{METHOD_LABEL[method] || method || ''}</Text>
              {'  '}
              {row.status === 'saving' ? 'saving…' : timeLabel(row.time)}
              {greyed ? '  · Undone' : ''}
            </Text>
          )}
        </View>
        {row.status === 'saved' && row.saleId && !isBusy && (
          <TouchableOpacity onPress={() => onUndo(row)} style={styles.undoBtn} accessibilityRole="button" accessibilityLabel={`Undo ${inr(row.amount)} ${row.label || ''}`}>
            <Ionicons name="arrow-undo" size={18} color={Colors.textSecondary} />
            <Text style={styles.undoText}>Undo</Text>
          </TouchableOpacity>
        )}
        {inRedo && (
          <View style={styles.redoWrap}>
            <Text style={styles.undoneText}>Undone ·</Text>
            <TouchableOpacity onPress={() => onRedo(row)} style={styles.redoBtn} accessibilityRole="button" accessibilityLabel="Redo this sale">
              <Text style={styles.redoText}>Redo</Text>
            </TouchableOpacity>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>This session</Text>
        <Text style={styles.totals}>
          <Text style={{ color: METHOD_COLOR.cash, fontWeight: '800' }}>Cash {inr(shownTotals.cash)}</Text>
          {'  ·  '}
          <Text style={{ color: METHOD_COLOR.upi, fontWeight: '800' }}>UPI {inr(shownTotals.upi)}</Text>
          {'  ·  '}
          {shownTotals.count} {shownTotals.count === 1 ? 'sale' : 'sales'}
        </Text>
      </View>
      {loadError ? (
        <TouchableOpacity onPress={onReload} style={styles.loadError} accessibilityRole="button">
          <Ionicons name="refresh" size={18} color={Colors.error} />
          <Text style={{ color: Colors.error, fontSize: FontSize.md, flex: 1 }}>Could not load this session's sales. Tap to try again.</Text>
        </TouchableOpacity>
      ) : null}
      <FlatList
        style={{ flex: 1 }}
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={renderRow}
        extraData={[undoneUntil, methodOverride, busy]}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={!loadError ? (
          <Text style={styles.empty}>No quick sales yet this session. Tap a button above to record one.</Text>
        ) : null}
      />

      <Modal visible={!!sheetRow} transparent animationType="slide" onRequestClose={closeSheet}>
        <TouchableOpacity activeOpacity={1} onPress={closeSheet} style={styles.backdrop}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} onTouchStart={bumpActivity} style={styles.sheet}>
            {sheetRow && (
              <>
                <Text style={styles.sheetTitle}>
                  {inr(sheetRow.amount)} · {sheetRow.label || '—'} · <Text style={{ color: METHOD_COLOR[sheetMethod] }}>{METHOD_LABEL[sheetMethod] || ''}</Text>
                </Text>
                {(sheetMethod === 'cash' || sheetMethod === 'upi') && (
                  <SheetButton
                    icon={otherMethod === 'upi' ? 'phone-portrait-outline' : 'cash-outline'}
                    label={`Change to ${METHOD_LABEL[otherMethod]}`}
                    color={METHOD_COLOR[otherMethod]}
                    filled
                    onPress={fromSheet((row) => onChangeMethod(row, otherMethod))}
                  />
                )}
                <SheetButton icon="print-outline" label="Print bill" onPress={fromSheet(onPrint)} />
                <SheetButton icon="create-outline" label="Add details" onPress={fromSheet(onAddDetails)} />
                <SheetButton icon="arrow-undo" label="Undo" color={Colors.error} onPress={fromSheet(onUndo)} />
                <TouchableOpacity onPress={closeSheet} style={styles.sheetClose} accessibilityRole="button">
                  <Text style={{ color: Colors.textSecondary, fontSize: FontSize.md, fontWeight: '600' }}>Close</Text>
                </TouchableOpacity>
              </>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

function SheetButton({ icon, label, color = Colors.text, filled, onPress }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      style={[styles.sheetBtn, filled ? { backgroundColor: color, borderColor: color } : null]}
    >
      <Ionicons name={icon} size={22} color={filled ? Colors.white : color} />
      <Text style={[styles.sheetBtnText, { color: filled ? Colors.white : color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between',
    gap: Spacing.sm, paddingVertical: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border,
  },
  headerTitle: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  totals: { fontSize: FontSize.md, color: Colors.text, fontVariant: ['tabular-nums'] },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 56,
    paddingVertical: Spacing.xs, paddingHorizontal: Spacing.xs,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  rowFailed: { backgroundColor: Colors.errorLight },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: Spacing.sm },
  amount: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] },
  label: { fontSize: FontSize.md, color: Colors.text, flexShrink: 1 },
  struck: { textDecorationLine: 'line-through', color: Colors.textLight },
  meta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  failedText: { fontSize: FontSize.md, color: Colors.error, fontWeight: '700', marginTop: 2 },
  undoBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, minWidth: 72, justifyContent: 'center',
    paddingHorizontal: Spacing.sm, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
  },
  undoText: { fontSize: FontSize.md, color: Colors.textSecondary, fontWeight: '700' },
  redoWrap: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  undoneText: { fontSize: FontSize.md, color: Colors.textSecondary },
  redoBtn: {
    minHeight: 44, minWidth: 64, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: Spacing.sm, borderRadius: BorderRadius.md, backgroundColor: Colors.primary,
  },
  redoText: { fontSize: FontSize.md, color: Colors.white, fontWeight: '800' },
  empty: { fontSize: FontSize.md, color: Colors.textSecondary, paddingVertical: Spacing.md, textAlign: 'center' },
  loadError: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 48, padding: Spacing.sm, backgroundColor: Colors.errorLight, borderRadius: BorderRadius.md },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg,
    padding: Spacing.lg, paddingBottom: Spacing.xl, width: '100%', maxWidth: 560, alignSelf: 'center', gap: Spacing.sm,
  },
  sheetTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, marginBottom: Spacing.xs },
  sheetBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, minHeight: 56,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  sheetBtnText: { fontSize: FontSize.lg, fontWeight: '700' },
  sheetClose: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
});
