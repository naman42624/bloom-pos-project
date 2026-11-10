/**
 * QuickSalePanel — "Quick sale" mode of Quick Checkout (spec 2026-11-02 §5).
 *
 *   [   CASH   ]  [   UPI   ]          <- remembered on the device
 *   [Rose bunch ₹200] [Bouquet ₹500] … <- one tap = one sale
 *   Other amount ₹ [ 350 ] [ + Add ₹350 ]
 *   (Bouquet) (Bunch) (Box) …          <- names the next typed entry only
 *   This session  Cash ₹… · UPI ₹… · N sales
 *   rows…                              <- only this list scrolls
 *
 * Self-contained: <QuickSalePanel locationId navigation helpSignal />.
 * helpSignal is a counter; each change re-opens the "How this works" card.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Animated, ActivityIndicator,
  Platform, StyleSheet, useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../../services/api';
import { OpenRegisterForm } from '../OpenRegisterSheet';
import { printSaleBill } from '../../utils/printHelpers';
import { showAlert } from '../../utils/alert';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';
import {
  QUICK_LABELS, DEFAULT_QUICK_LABEL, amountError, buildQuickSalePayload,
  createTapGuard, createSequentialSender,
} from '../../utils/quickSale';
import QuickSaleRoll, { inr, METHOD_COLOR } from './QuickSaleRoll';

const METHOD_KEY = '@petal_quick_method';
const HELP_KEY = '@petal_quick_help_seen';
const INACTIVE_TEXT = "isn't sold any more";
const REDO_WINDOW_MS = 5000;
const REFRESH_MS = 60000;
const TINT = { cash: Colors.successLight, upi: Colors.infoLight };

async function readKey(key) {
  try { return await AsyncStorage.getItem(key); } catch { return null; }
}
async function writeKey(key, value) {
  try { await AsyncStorage.setItem(key, value); } catch { /* per-device convenience only */ }
}

// The roll always keeps room for at least 3 rows (plus its totals line).
const ROLL_MIN_HEIGHT = 56 * 3 + 48;

export default function QuickSalePanel({ locationId, navigation, helpSignal = 0, onBusyChange }) {
  const { width, height } = useWindowDimensions();
  const columns = width >= 600 ? 4 : 3;
  const compact = height < 760;
  const narrow = width < 420;

  const [method, setMethod] = useState('cash');
  const [showHelp, setShowHelp] = useState(false);
  const [tiles, setTiles] = useState([]);
  const [tilesSource, setTilesSource] = useState(null);
  const [tilesState, setTilesState] = useState('loading'); // loading | ready | error
  const [defaultLabel, setDefaultLabel] = useState(DEFAULT_QUICK_LABEL);
  const [roll, setRoll] = useState({ entries: [], totals: { cash: 0, upi: 0, count: 0 } });
  const [rollError, setRollError] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(null); // null = not known yet
  const [pending, setPending] = useState([]);
  const [amount, setAmount] = useState('');
  const [amountErr, setAmountErr] = useState('');
  const [chip, setChip] = useState(null);
  const [undoneUntil, setUndoneUntil] = useState({});
  const [methodOverride, setMethodOverride] = useState({});
  const [busy, setBusy] = useState({});

  const amountRef = useRef(null);
  const tapGuardRef = useRef(createTapGuard(700));
  const payloadBySale = useRef({});
  const errorByKey = useRef({});
  const busyRef = useRef({});
  const rollTimer = useRef(null);
  const redoTimers = useRef([]);
  const redoneRef = useRef(new Set());
  // Roll responses are applied in request order. A "mark" is the last request
  // number started when a local change happened; a response from a request
  // started after that mark already reflects the change.
  const reqSeq = useRef(0);
  const appliedSeq = useRef(0);
  const undoneMark = useRef(new Map());   // saleId -> mark
  const overrideMark = useRef(new Map()); // saleId -> { method, mark }
  const locationRef = useRef(locationId);
  locationRef.current = locationId;

  // ── Loading ────────────────────────────────────────────
  const loadTiles = useCallback(async () => {
    if (!locationRef.current) return;
    try {
      const res = await api.getQuickTiles(locationRef.current);
      setTiles(res?.data?.tiles || []);
      setTilesSource(res?.data?.source || null);
      if (res?.data?.default_label) setDefaultLabel(res.data.default_label);
      setTilesState('ready');
    } catch {
      setTilesState((s) => (s === 'ready' ? 'ready' : 'error'));
    }
  }, []);

  const syncOverrides = useCallback(() => {
    const o = {};
    overrideMark.current.forEach((v, id) => { o[id] = v.method; });
    setMethodOverride(o);
  }, []);

  const loadRoll = useCallback(async () => {
    if (!locationRef.current) return;
    const seq = ++reqSeq.current;
    try {
      const res = await api.getQuickRoll(locationRef.current);
      if (seq < appliedSeq.current) return; // a newer response is already shown
      appliedSeq.current = seq;
      const d = res?.data || {};
      undoneMark.current.forEach((mark, id) => { if (mark < seq) undoneMark.current.delete(id); });
      overrideMark.current.forEach((v, id) => { if (v.mark < seq) overrideMark.current.delete(id); });
      const entries = (d.entries || []).map((e) => (undoneMark.current.has(e.id) ? { ...e, undone: true } : e));
      setRoll({ entries, totals: d.totals || { cash: 0, upi: 0, count: 0 } });
      // Saved / undone local lines give way to the server once it has caught up.
      setPending((prev) => prev.filter((p) => p.status === 'saving' || p.status === 'failed' || (p.markSeq != null && p.markSeq >= seq)));
      syncOverrides();
      setRegisterOpen(!!d.register_open);
      setRollError(false);
    } catch {
      if (seq >= appliedSeq.current) setRollError(true);
    }
  }, [syncOverrides]);

  const loadRollSoon = useCallback(() => {
    if (rollTimer.current) clearTimeout(rollTimer.current);
    rollTimer.current = setTimeout(loadRoll, 400);
  }, [loadRoll]);

  useEffect(() => () => {
    if (rollTimer.current) clearTimeout(rollTimer.current);
    redoTimers.current.forEach(clearTimeout);
  }, []);

  // Tell the screen whether a line is still saving or failed (blocks leaving).
  const busyState = pending.some((p) => p.status === 'saving') ? 'saving'
    : (pending.some((p) => p.status === 'failed') ? 'failed' : null);
  useEffect(() => { if (onBusyChange) onBusyChange(busyState); }, [busyState, onBusyChange]);
  useEffect(() => () => { if (onBusyChange) onBusyChange(null); }, [onBusyChange]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [m, seen] = await Promise.all([readKey(METHOD_KEY), readKey(HELP_KEY)]);
      if (cancelled) return;
      if (m === 'cash' || m === 'upi') setMethod(m);
      if (seen !== '1') setShowHelp(true);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { if (helpSignal > 0) setShowHelp(true); }, [helpSignal]);

  // Refresh on focus and every 60 s while on screen; reset when the shop changes.
  useFocusEffect(
    useCallback(() => {
      if (!locationId) return undefined;
      loadTiles();
      loadRoll();
      const t = setInterval(() => { loadTiles(); loadRoll(); }, REFRESH_MS);
      return () => clearInterval(t);
    }, [locationId, loadTiles, loadRoll])
  );

  // ── Sending ────────────────────────────────────────────
  const senderRef = useRef(null);
  if (!senderRef.current) {
    senderRef.current = createSequentialSender(
      async (entry) => {
        try {
          const res = await api.createSale(entry.payload);
          return res;
        } catch (err) {
          const msg = err?.message || '';
          if (msg.includes(INACTIVE_TEXT)) {
            errorByKey.current[entry.key] = msg;
            loadTiles();
          } else if (err && err.status >= 400 && err.status < 500 && msg) {
            // The server said why in plain words; show that, not the generic line.
            errorByKey.current[entry.key] = msg;
          }
          // A closed register (or anything else) shows up on the next refresh.
          loadRoll();
          throw err;
        }
      },
      (localId, rec) => {
        if (rec.status === 'saved' && rec.saleId) {
          payloadBySale.current[rec.saleId] = rec.entry.payload;
          loadRollSoon();
        }
        setPending((prev) => {
          const errorText = rec.status === 'failed' ? (errorByKey.current[rec.entry.key] || '') : '';
          const next = {
            localId, saleId: rec.saleId, status: rec.status, errorText,
            markSeq: rec.status === 'saved' ? reqSeq.current : null,
            amount: rec.entry.amount, method: rec.entry.method, label: rec.entry.label, createdAt: rec.entry.createdAt,
          };
          const i = prev.findIndex((p) => p.localId === localId);
          if (i === -1) return [...prev, next];
          const copy = prev.slice();
          copy[i] = next;
          return copy;
        });
      }
    );
  }

  const record = useCallback((payload, { label, amount: value, method: m }) => {
    const key = `${Date.now()}-${Math.random()}`;
    senderRef.current.enqueue({ key, payload, label, amount: value, method: m, createdAt: new Date() });
  }, []);

  const chooseMethod = (m) => {
    setMethod(m);
    writeKey(METHOD_KEY, m);
  };

  const dismissHelp = () => {
    setShowHelp(false);
    writeKey(HELP_KEY, '1');
  };

  // One tap = one sale. Returns false when the same tile was tapped < 700 ms ago.
  const onTile = (tile) => {
    if (!tapGuardRef.current(`tile:${tile.key}`)) return false;
    const payload = buildQuickSalePayload({
      locationId, method, amount: tile.price, label: tile.label, productId: tile.product_id || undefined,
    });
    record(payload, { label: tile.label, amount: Number(tile.price), method });
    return true;
  };

  const onAdd = () => {
    const err = amountError(amount);
    if (err) { setAmountErr(err); amountRef.current && amountRef.current.focus(); return; }
    if (!tapGuardRef.current('add')) return;
    const label = chip || defaultLabel;
    const payload = buildQuickSalePayload({ locationId, method, amount, label });
    record(payload, { label, amount: payload.payments[0].amount, method });
    setAmount('');
    setAmountErr('');
    setChip(null);
    amountRef.current && amountRef.current.focus();
  };

  // ── Row actions ────────────────────────────────────────
  const setRowBusy = (saleId, on) => {
    busyRef.current = { ...busyRef.current };
    if (on) busyRef.current[saleId] = true; else delete busyRef.current[saleId];
    setBusy(busyRef.current);
  };

  const onUndo = async (row) => {
    const id = row.saleId;
    if (!id || busyRef.current[id]) return;
    setRowBusy(id, true);
    try {
      await api.undoQuickSale(id);
      const mark = reqSeq.current;
      undoneMark.current.set(id, mark);
      setPending((prev) => prev.map((p) => (p.saleId === id ? { ...p, status: 'undone', markSeq: mark } : p)));
      setRoll((r) => ({ ...r, entries: r.entries.map((e) => (e.id === id ? { ...e, undone: true } : e)) }));
      setUndoneUntil((u) => ({ ...u, [id]: Date.now() + REDO_WINDOW_MS }));
      const t = setTimeout(() => {
        redoTimers.current = redoTimers.current.filter((x) => x !== t);
        setUndoneUntil((u) => { const c = { ...u }; delete c[id]; return c; });
      }, REDO_WINDOW_MS);
      redoTimers.current.push(t);
      loadRoll();
    } catch (err) {
      showAlert('Could not undo', err?.message || 'Check the connection and try again.');
    } finally {
      setRowBusy(id, false);
    }
  };

  // Redo = a new entry with the same payload as the undone one.
  const onRedo = (row) => {
    if (!row.saleId || redoneRef.current.has(row.saleId)) return;
    if (!tapGuardRef.current(`redo:${row.saleId}`)) return;
    redoneRef.current.add(row.saleId);
    setUndoneUntil((u) => { const c = { ...u }; delete c[row.saleId]; return c; });
    const saved = payloadBySale.current[row.saleId];
    const payload = saved || buildQuickSalePayload({
      locationId, method: row.method === 'upi' ? 'upi' : 'cash', amount: row.amount, label: row.label,
    });
    record(payload, { label: row.label, amount: Number(row.amount), method: payload.payments[0].method });
  };

  const onRetry = (row) => {
    setPending((prev) => prev.map((p) => (p.localId === row.localId ? { ...p, errorText: '' } : p)));
    senderRef.current.retry(row.localId);
  };

  const onDismiss = (row) => {
    setPending((prev) => prev.filter((p) => p.localId !== row.localId));
  };

  const onChangeMethod = async (row, newMethod) => {
    const id = row.saleId;
    if (!id || busyRef.current[id]) return;
    setRowBusy(id, true);
    overrideMark.current.set(id, { method: newMethod, mark: Infinity });
    syncOverrides();
    try {
      await api.updateSale(id, { payments: [{ method: newMethod, amount: Number(row.amount) }] });
      overrideMark.current.set(id, { method: newMethod, mark: reqSeq.current });
      const p = payloadBySale.current[id];
      if (p) payloadBySale.current[id] = { ...p, payments: [{ ...p.payments[0], method: newMethod }] };
      setPending((prev) => prev.map((x) => (x.saleId === id ? { ...x, method: newMethod } : x)));
      await loadRoll();
    } catch (err) {
      overrideMark.current.delete(id);
      syncOverrides();
      showAlert('Could not change the method', err?.message || 'Check the connection and try again.');
    } finally {
      setRowBusy(id, false);
    }
  };

  const onPrint = (row) => { printSaleBill(row.saleId); };
  const onAddDetails = (row) => { navigation.navigate('SaleDetail', { saleId: row.saleId }); };

  // ── Web: digits typed anywhere go into the amount box ──
  const registerBlocksCash = method === 'cash' && registerOpen === false;
  const typingRef = useRef(false);
  typingRef.current = !registerBlocksCash;
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
      const onKey = (e) => {
        if (!typingRef.current || e.ctrlKey || e.metaKey || e.altKey) return;
        if (!/^[0-9.]$/.test(e.key)) return;
        const el = typeof document !== 'undefined' ? document.activeElement : null;
        const tag = el && el.tagName ? el.tagName.toUpperCase() : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
        e.preventDefault();
        setAmount((a) => (a + e.key).replace(/[^0-9.]/g, ''));
        setAmountErr('');
        amountRef.current && amountRef.current.focus();
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [])
  );

  const amountOk = amount.trim() !== '' && amountError(amount) === '';
  const addLabel = amountOk ? `+ Add ${inr(Number(amount))}` : '+ Add';
  const accent = METHOD_COLOR[method];

  if (!locationId) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {/* Only this top area scrolls (when it does not fit); the roll below always keeps its room. */}
      <ScrollView style={styles.top} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator>
      {showHelp && (
        <View style={styles.help}>
          <Text style={styles.helpLine}>1. Pick <Text style={styles.bold}>Cash</Text> or <Text style={styles.bold}>UPI</Text>.</Text>
          <Text style={styles.helpLine}>2. Tap a button, or type the amount and press <Text style={styles.bold}>Add</Text>. The sale is saved right away.</Text>
          <Text style={styles.helpLine}>3. Made a mistake? Tap <Text style={styles.bold}>Undo</Text> on that line.</Text>
          <TouchableOpacity onPress={dismissHelp} style={styles.helpBtn} accessibilityRole="button">
            <Text style={styles.helpBtnText}>Got it</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={[styles.pad, { backgroundColor: TINT[method] }]}>
        <View style={styles.methodRow}>
          {['cash', 'upi'].map((m) => {
            const on = method === m;
            const c = METHOD_COLOR[m];
            return (
              <TouchableOpacity
                key={m}
                onPress={() => chooseMethod(m)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={[styles.methodBtn, { borderColor: c, backgroundColor: on ? c : Colors.surface }]}
              >
                <Ionicons
                  name={on ? 'checkmark-circle' : (m === 'cash' ? 'cash-outline' : 'phone-portrait-outline')}
                  size={24}
                  color={on ? Colors.white : c}
                />
                <Text style={[styles.methodText, { color: on ? Colors.white : c }]}>{m === 'cash' ? 'CASH' : 'UPI'}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {registerBlocksCash ? (
          <View style={styles.registerBox}>
            <Text style={styles.registerLine}>The register is closed. Count the drawer and open it to start taking cash.</Text>
            <OpenRegisterForm
              locationId={locationId}
              actionLabel="take cash"
              onClose={() => chooseMethod('upi')}
              onBack={() => chooseMethod('upi')}
              backLabel="Use UPI instead"
              onOpened={() => { setRegisterOpen(true); loadRoll(); }}
            />
          </View>
        ) : (
          <>
            <TileGrid
              tiles={tiles}
              state={tilesState}
              source={tilesSource}
              columns={columns}
              compact={compact}
              accent={accent}
              onTile={onTile}
              onReload={loadTiles}
            />

            {narrow && <Text style={[styles.amountLabel, styles.amountLabelAbove]}>Other amount ₹</Text>}
            <View style={styles.amountRow}>
              {!narrow && <Text style={styles.amountLabel}>Other amount ₹</Text>}
              <TextInput
                ref={amountRef}
                value={amount}
                onChangeText={(t) => { setAmount(t.replace(/[^0-9.]/g, '')); setAmountErr(''); }}
                onSubmitEditing={onAdd}
                blurOnSubmit={false}
                returnKeyType="done"
                keyboardType="decimal-pad"
                autoFocus={Platform.OS === 'web'}
                placeholder="0"
                placeholderTextColor={Colors.textLight}
                accessibilityLabel="Other amount in rupees"
                style={[styles.amountInput, amountErr ? { borderColor: Colors.error } : null]}
              />
              <TouchableOpacity
                onPress={onAdd}
                accessibilityRole="button"
                style={[styles.addBtn, { backgroundColor: accent }]}
              >
                <Text style={styles.addText} numberOfLines={1}>{addLabel}</Text>
              </TouchableOpacity>
            </View>
            {!!amountErr && <Text style={styles.amountErr}>{amountErr}</Text>}

            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.chips}>
              {QUICK_LABELS.filter((l) => l !== defaultLabel).map((l) => {
                const on = chip === l;
                return (
                  <TouchableOpacity
                    key={l}
                    onPress={() => setChip(on ? null : l)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    style={[styles.chip, on && { backgroundColor: Colors.primary, borderColor: Colors.primary }]}
                  >
                    <Text style={[styles.chipText, on && { color: Colors.white }]}>{l}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </>
        )}
      </View>
      </ScrollView>

      <View style={styles.rollWrap}>
      <QuickSaleRoll
        entries={roll.entries}
        pending={pending}
        totals={roll.totals}
        undoneUntil={undoneUntil}
        methodOverride={methodOverride}
        busy={busy}
        loadError={rollError}
        onReload={loadRoll}
        onUndo={onUndo}
        onRedo={onRedo}
        onRetry={onRetry}
        onDismiss={onDismiss}
        onChangeMethod={onChangeMethod}
        onPrint={onPrint}
        onAddDetails={onAddDetails}
      />
      </View>
    </View>
  );
}

function TileGrid({ tiles, state, source, columns, compact, accent, onTile, onReload }) {
  if (state === 'loading' && tiles.length === 0) {
    return <View style={styles.tilesMsg}><ActivityIndicator color={Colors.primary} /></View>;
  }
  if (state === 'error' && tiles.length === 0) {
    return (
      <TouchableOpacity onPress={onReload} style={styles.tilesMsg} accessibilityRole="button">
        <Text style={styles.tilesMsgText}>Could not load the buttons. Tap to try again, or type the amount below.</Text>
      </TouchableOpacity>
    );
  }
  if (tiles.length === 0) {
    return (
      <View style={styles.tilesMsg}>
        <Text style={styles.tilesMsgText}>No buttons yet. Type the amount below. The owner can add buttons in Settings → Quick sale buttons.</Text>
      </View>
    );
  }
  return (
    <View>
      <View style={styles.grid}>
        {tiles.map((t) => (
          <View key={t.key} style={{ width: `${100 / columns}%`, padding: Spacing.xs }}>
            <Tile tile={t} compact={compact} accent={accent} onTile={onTile} />
          </View>
        ))}
      </View>
      {source === 'suggested' && (
        <Text style={styles.suggested}>Suggested — the owner can change these in Settings</Text>
      )}
    </View>
  );
}

function Tile({ tile, compact, accent, onTile }) {
  const flash = useRef(new Animated.Value(0)).current;
  const shake = useRef(new Animated.Value(0)).current;
  const useNative = Platform.OS !== 'web';

  const onPress = () => {
    if (onTile(tile)) {
      flash.setValue(1);
      Animated.timing(flash, { toValue: 0, duration: 300, useNativeDriver: false }).start();
    } else {
      shake.setValue(0);
      Animated.sequence([
        Animated.timing(shake, { toValue: 1, duration: 50, useNativeDriver: useNative }),
        Animated.timing(shake, { toValue: -1, duration: 50, useNativeDriver: useNative }),
        Animated.timing(shake, { toValue: 0, duration: 50, useNativeDriver: useNative }),
      ]).start();
    }
  };

  const bg = flash.interpolate({ inputRange: [0, 1], outputRange: [Colors.surface, accent] });
  const tx = shake.interpolate({ inputRange: [-1, 1], outputRange: [-6, 6] });

  return (
    <Animated.View style={{ transform: [{ translateX: tx }] }}>
      <TouchableOpacity onPress={onPress} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`${tile.label}, ${inr(tile.price)}. Tap to record a sale.`}>
        {compact ? (
          // Short screens: one line, price beside the name, 56 px tall.
          <Animated.View style={[styles.tile, styles.tileCompact, { backgroundColor: bg, borderColor: accent }]}>
            <Text style={[styles.tileLabel, styles.tileLabelCompact]} numberOfLines={1}>{tile.label}</Text>
            <Text style={[styles.tilePrice, styles.tilePriceCompact]}>{inr(tile.price)}</Text>
          </Animated.View>
        ) : (
          <Animated.View style={[styles.tile, { backgroundColor: bg, borderColor: accent }]}>
            <Text style={styles.tileLabel} numberOfLines={2}>{tile.label}</Text>
            <Text style={styles.tilePrice}>{inr(tile.price)}</Text>
          </Animated.View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, width: '100%', maxWidth: 800, alignSelf: 'center', paddingHorizontal: Spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  top: { flexGrow: 0, flexShrink: 1 },
  rollWrap: { flex: 1, minHeight: ROLL_MIN_HEIGHT },
  tileCompact: { minHeight: 56, flexDirection: 'row', justifyContent: 'space-between', gap: Spacing.xs },
  tileLabelCompact: { flexShrink: 1, textAlign: 'left' },
  tilePriceCompact: { fontSize: FontSize.md },
  amountLabelAbove: { paddingHorizontal: Spacing.xs, marginTop: Spacing.xs },
  bold: { fontWeight: '800' },
  help: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md, marginBottom: Spacing.sm, gap: 4,
  },
  helpLine: { fontSize: FontSize.md, color: Colors.text },
  helpBtn: {
    alignSelf: 'flex-end', minHeight: 44, minWidth: 96, marginTop: Spacing.xs, borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.md,
  },
  helpBtnText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '800' },
  pad: { borderRadius: BorderRadius.lg, padding: Spacing.sm, marginBottom: Spacing.sm },
  methodRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.xs, paddingHorizontal: Spacing.xs },
  methodBtn: {
    flex: 1, minHeight: 56, borderRadius: BorderRadius.md, borderWidth: 2,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
  },
  methodText: { fontSize: FontSize.lg, fontWeight: '800', letterSpacing: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: {
    minHeight: 64, borderRadius: BorderRadius.md, borderWidth: 1, paddingHorizontal: Spacing.sm, paddingVertical: Spacing.xs,
    alignItems: 'center', justifyContent: 'center',
  },
  tileLabel: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, textAlign: 'center' },
  tilePrice: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] },
  suggested: { fontSize: FontSize.sm, color: Colors.textSecondary, paddingHorizontal: Spacing.xs },
  tilesMsg: { minHeight: 64, alignItems: 'center', justifyContent: 'center', padding: Spacing.sm },
  tilesMsgText: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center' },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.xs, paddingHorizontal: Spacing.xs },
  amountLabel: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  amountInput: {
    flex: 1, minWidth: 80, minHeight: 52, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface, paddingHorizontal: Spacing.md, fontSize: FontSize.lg, fontWeight: '800', color: Colors.text,
  },
  addBtn: { minHeight: 52, minWidth: 120, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.md },
  addText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '800' },
  amountErr: { color: Colors.error, fontSize: FontSize.md, marginTop: 4, paddingHorizontal: Spacing.xs },
  chips: { gap: Spacing.sm, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.xs },
  chip: {
    minHeight: 44, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.xl, borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center',
  },
  chipText: { fontSize: FontSize.md, color: Colors.text, fontWeight: '600' },
  registerBox: { paddingHorizontal: Spacing.xs, paddingTop: Spacing.sm, gap: Spacing.sm },
  registerLine: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
});
