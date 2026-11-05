// Quick tag: type a name and a price, get a printed QR tag that scans at
// checkout. Saves a normal product with stock at this shop (the same
// "custom item" route Produce uses), so it shows in Products and Inventory.
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, Switch,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { printHtml } from '../utils/printHelpers';
import { printProductTag, quickTagProblem, parsePrice, QUICK_TAG_MAX } from '../utils/productTag';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const SHEETS = [
  { key: 'bucket', label: 'Bucket card' },
  { key: 'stickers', label: 'Sticker' },
];

const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export default function QuickTagScreen({ navigation }) {
  const { activeLocation } = useAuth();
  const guardSubmit = useSubmitGuard();
  const nameRef = useRef(null);

  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState(1);
  const [layout, setLayout] = useState('bucket');
  const [showPrice, setShowPrice] = useState(true);
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState(activeLocation?.id || null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // After saving: { id, name, price, qty, locationName }. Print again never
  // makes a second product.
  const [made, setMade] = useState(null);
  const [printState, setPrintState] = useState(''); // '' | 'printing' | 'done'
  const [printError, setPrintError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await api.getLocations();
        const locs = (res.data?.locations || res.data || []).filter((l) => l.is_active !== 0);
        setLocations(locs);
        setLocationId((cur) => cur || (locs[0] && locs[0].id) || null);
      } catch {
        // Only needed for the shop picker; saving still says what to do.
      }
    })();
  }, []);

  const locationName = (locations.find((l) => l.id === locationId) || {}).name || activeLocation?.name || '';

  const doPrint = async (item) => {
    setPrintState('printing');
    setPrintError('');
    try {
      await printProductTag({ api, printHtml }, {
        productId: item.id, qty: item.qty, layout: item.layout, showPrice: item.showPrice, retry: item.qty === 1 ? 'Print tag again' : `Print ${item.qty} tags again`,
      });
      setPrintState('done');
    } catch (e) {
      setPrintState('');
      setPrintError(e.message || 'Could not print. Tap "Print tag again".');
    }
  };

  const handleSave = async () => {
    const problem = quickTagProblem({ name, price, qty });
    if (problem) { setError(problem); return; }
    if (!locationId) { setError('Could not find this shop. Check the connection, go back and open Quick tag again.'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await api.customProduceProduct({
        name: name.trim(),
        location_id: locationId,
        quantity: qty,
        selling_price: parsePrice(price),
        category: 'other',
        notes: 'Quick tag',
      });
      const id = res?.data?.product?.id;
      if (!id) throw new Error('');
      const item = { id, name: name.trim(), price: parsePrice(price), qty, layout, showPrice, locationName };
      setMade(item);
      await doPrint(item);
    } catch (e) {
      setError(e?.status === 403
        ? 'You cannot make tags. Ask the owner.'
        : 'The tag was not saved. Check the connection and tap Save & print again.');
    } finally {
      setSaving(false);
    }
  };

  const startOver = () => {
    setMade(null);
    setPrintState('');
    setPrintError('');
    setName('');
    setPrice('');
    setQty(1);
    setError('');
    setTimeout(() => nameRef.current && nameRef.current.focus(), 50);
  };

  if (made) {
    const single = made.qty === 1;
    return (
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.column}>
          <View style={styles.doneCard}>
            <Ionicons name="checkmark-circle" size={40} color={Colors.success} />
            <Text style={styles.doneTitle}>{made.name} · {rupees(made.price)}</Text>
            <Text style={styles.doneText}>
              Saved as a product{made.locationName ? ` at ${made.locationName}` : ''}, {made.qty} in stock.
              {' '}Scan the tag at checkout to sell it.
            </Text>
            <Text style={styles.doneText}>
              {single
                ? 'One-of-a-kind: once it is sold, its tag shows "already sold".'
                : `${made.qty} tags, one for each piece.`}
            </Text>
            {printState === 'printing' && <Text style={styles.doneText}>Opening the print window…</Text>}
          </View>
          {!!printError && <Text style={styles.error}>{printError}</Text>}
          <TouchableOpacity
            style={[styles.primaryBtn, printState === 'printing' && styles.disabled]}
            onPress={guardSubmit(() => doPrint(made))}
            disabled={printState === 'printing'}
            accessibilityRole="button"
            accessibilityState={{ disabled: printState === 'printing' }}
          >
            {printState === 'printing'
              ? <ActivityIndicator color={Colors.white} />
              : <Text style={styles.primaryText}>{single ? 'Print tag again' : `Print ${made.qty} tags again`}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} onPress={startOver} accessibilityRole="button">
            <Text style={styles.secondaryText}>Make another tag</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.linkBtn} onPress={() => navigation.goBack()} accessibilityRole="button">
            <Text style={styles.linkText}>Done</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  const multiShop = locations.length > 1;

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.column}>
          <Text style={styles.intro}>Type a name and a price. You get a QR tag that scans at checkout.</Text>

          <Text style={styles.label}>What is it?</Text>
          <TextInput
            ref={nameRef}
            style={styles.input}
            value={name}
            onChangeText={(t) => { setName(t); setError(''); }}
            placeholder="For example: Red rose bunch"
            placeholderTextColor={Colors.textLight}
            autoFocus
            maxLength={120}
            returnKeyType="next"
          />

          <Text style={styles.label}>Price (₹)</Text>
          <TextInput
            style={[styles.input, styles.priceInput]}
            value={price}
            onChangeText={(t) => { setPrice(t.replace(/[^0-9.]/g, '')); setError(''); }}
            placeholder="0"
            placeholderTextColor={Colors.textLight}
            keyboardType="decimal-pad"
            maxLength={9}
          />

          <Text style={styles.label}>How many tags?</Text>
          <View style={styles.stepper}>
            <TouchableOpacity style={styles.stepBtn} onPress={() => setQty((q) => Math.max(1, q - 1))} accessibilityLabel="Fewer tags">
              <Ionicons name="remove" size={26} color={Colors.text} />
            </TouchableOpacity>
            <Text style={styles.qty}>{qty}</Text>
            <TouchableOpacity style={styles.stepBtn} onPress={() => setQty((q) => Math.min(QUICK_TAG_MAX, q + 1))} accessibilityLabel="More tags">
              <Ionicons name="add" size={26} color={Colors.text} />
            </TouchableOpacity>
          </View>
          <Text style={styles.note}>
            {qty === 1
              ? 'One-of-a-kind item. Once it is sold, its tag shows "already sold".'
              : `${qty} pieces in stock, one tag each.`}
          </Text>

          {multiShop && (
            <>
              <Text style={styles.label}>Shop</Text>
              <View style={styles.chipWrap}>
                {locations.map((l) => (
                  <Chip key={l.id} label={l.name} active={locationId === l.id} onPress={() => setLocationId(l.id)} />
                ))}
              </View>
            </>
          )}

          <Text style={styles.label}>Tag size</Text>
          <View style={styles.chipWrap}>
            {SHEETS.map((s) => <Chip key={s.key} label={s.label} active={layout === s.key} onPress={() => setLayout(s.key)} />)}
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Show price on the tag</Text>
            <Switch value={showPrice} onValueChange={setShowPrice} trackColor={{ true: Colors.primary }} />
          </View>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        {!!error && <Text style={styles.error}>{error}</Text>}
        <TouchableOpacity
          style={[styles.primaryBtn, saving && styles.disabled]}
          onPress={guardSubmit(handleSave)}
          disabled={saving}
          accessibilityRole="button"
          accessibilityState={{ disabled: saving }}
        >
          {saving
            ? <ActivityIndicator color={Colors.white} />
            : <Text style={styles.primaryText}>{qty === 1 ? 'Save & print tag' : `Save & print ${qty} tags`}</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

function Chip({ label, active, onPress }) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipOn]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.chipText, active && styles.chipTextOn]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: Spacing.md, paddingBottom: Spacing.xl },
  column: { width: '100%', maxWidth: 600, alignSelf: 'center' },
  intro: { fontSize: FontSize.md, color: Colors.textSecondary, marginBottom: Spacing.md },
  label: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginTop: Spacing.md, marginBottom: Spacing.xs },
  input: { minHeight: 52, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, fontSize: FontSize.lg, backgroundColor: Colors.surface, color: Colors.text },
  priceInput: { fontVariant: ['tabular-nums'], fontWeight: '700' },
  stepper: { flexDirection: 'row', alignItems: 'center' },
  stepBtn: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center', borderRadius: BorderRadius.md, backgroundColor: Colors.surfaceAlt, borderWidth: 1, borderColor: Colors.border },
  qty: { minWidth: 64, textAlign: 'center', fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] },
  note: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.xs },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: { minHeight: 48, paddingHorizontal: Spacing.md, justifyContent: 'center', borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface, marginRight: Spacing.sm, marginBottom: Spacing.sm },
  chipOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.md, color: Colors.text },
  chipTextOn: { color: Colors.textOnPrimary, fontWeight: '700' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 56 },
  switchLabel: { fontSize: FontSize.md, color: Colors.text },
  footer: { padding: Spacing.md, backgroundColor: Colors.surface, borderTopWidth: 1, borderTopColor: Colors.border, alignItems: 'center' },
  error: { color: Colors.error, fontSize: FontSize.md, fontWeight: '600', marginBottom: Spacing.sm, textAlign: 'center' },
  primaryBtn: { minHeight: 56, width: '100%', maxWidth: 600, backgroundColor: Colors.primary, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.lg },
  primaryText: { color: Colors.textOnPrimary, fontSize: FontSize.lg, fontWeight: '700' },
  secondaryBtn: { minHeight: 52, width: '100%', marginTop: Spacing.sm, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: Colors.primary, fontSize: FontSize.md, fontWeight: '700' },
  linkBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: Spacing.xs },
  linkText: { color: Colors.textSecondary, fontSize: FontSize.md, textDecorationLine: 'underline' },
  disabled: { opacity: 0.5 },
  doneCard: { alignItems: 'center', backgroundColor: Colors.successLight, borderRadius: BorderRadius.lg, padding: Spacing.lg, marginBottom: Spacing.md },
  doneTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginTop: Spacing.sm, textAlign: 'center' },
  doneText: { fontSize: FontSize.md, color: Colors.text, marginTop: Spacing.xs, textAlign: 'center' },
});
