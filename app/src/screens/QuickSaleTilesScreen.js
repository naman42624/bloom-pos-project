import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Button from '../components/Button';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { showAlert, showConfirm } from '../utils/alert';
import { Colors, FontSize, Spacing, BorderRadius, TouchTarget } from '../constants/theme';

const MAX_TILES = 12;
const MAX_PRICE = 100000;

const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

// Draft tile shape: { id, type: 'product'|'label', product_id?, label, price }
let draftSeq = 0;
const nextId = () => `t${++draftSeq}`;

function fromServerTile(t) {
  return t.type === 'product'
    ? { id: nextId(), type: 'product', product_id: t.product_id, label: t.label || `Product #${t.product_id}`, price: t.price }
    : { id: nextId(), type: 'label', label: t.label, price: t.price };
}

function IconBtn({ name, label, onPress, disabled, color }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.iconBtn, disabled && { opacity: 0.3 }]}
    >
      <Ionicons name={name} size={22} color={color || Colors.text} />
    </TouchableOpacity>
  );
}

export default function QuickSaleTilesScreen({ navigation }) {
  const { user, activeLocation } = useAuth();
  const isOwner = user?.role === 'owner';
  const locationId = activeLocation?.id;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [source, setSource] = useState('owner');
  const [tiles, setTiles] = useState([]);
  const [saving, setSaving] = useState(false);

  // add-product search
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);

  // add-label form
  const [labelText, setLabelText] = useState('');
  const [labelPrice, setLabelPrice] = useState('');
  const [labelError, setLabelError] = useState('');

  // Typed amounts: the name on the bill and its HSN (always billed at 0% GST)
  const [billLabel, setBillLabel] = useState('Fresh Flowers');
  const [billHsn, setBillHsn] = useState('0603');
  const [billError, setBillError] = useState('');

  const full = tiles.length >= MAX_TILES;

  // Snapshot of the last loaded/saved list, to tell whether there are unsaved changes.
  const [savedSnap, setSavedSnap] = useState('[]');
  const snapOf = (list, label = billLabel, hsn = billHsn) => JSON.stringify([label.trim(), hsn.trim(), ...list.map((t) => (t.type === 'product'
    ? [t.type, t.product_id] : [t.type, t.label, t.price]))]);
  const dirty = snapOf(tiles) !== savedSnap;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  // silent: used after a save. A failed reload keeps the draft instead of showing the load error.
  const load = useCallback(async (silent) => {
    if (!silent) { setLoading(true); setLoadError(''); }
    try {
      const res = await api.getQuickTiles(locationId);
      const data = res.data || res;
      const list = (data.tiles || []).map(fromServerTile);
      setSource(data.source === 'owner' ? 'owner' : 'suggested');
      const label = data.default_label || 'Fresh Flowers';
      const hsn = data.hsn || '0603';
      setBillLabel(label);
      setBillHsn(hsn);
      setTiles(list);
      setSavedSnap(snapOf(list, label, hsn));
    } catch (err) {
      if (!silent) setLoadError('Could not load the buttons. Check your connection and tap Try again.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [locationId]);

  useEffect(() => {
    if (isOwner && locationId) load(); else setLoading(false);
  }, [load, isOwner, locationId]);

  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      showConfirm(
        'Leave without saving?',
        'Your changes to the buttons have not been saved.',
        () => navigation.dispatch(e.data.action),
        { confirmLabel: 'Leave', cancelLabel: 'Stay', destructive: true },
      );
    });
    return unsub;
  }, [navigation]);

  // Debounced product search (active products only)
  useEffect(() => {
    const q = search.trim();
    if (!q) { setResults([]); setSearching(false); return undefined; }
    setSearching(true);
    const seq = ++searchSeq.current;
    const timer = setTimeout(async () => {
      try {
        const params = { search: q, is_active: 1, limit: 8 };
        if (locationId) params.location_id = locationId;
        const res = await api.getProducts(params);
        if (seq === searchSeq.current) setResults(res.data || []);
      } catch {
        if (seq === searchSeq.current) setResults([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [search, locationId]);

  const addProduct = (p) => {
    if (full) return;
    if (tiles.some((t) => t.type === 'product' && Number(t.product_id) === Number(p.id))) {
      showAlert('Already added', `${p.name} is already one of the buttons.`);
      return;
    }
    setTiles((prev) => [...prev, {
      id: nextId(), type: 'product', product_id: p.id, label: p.name, price: Number(p.selling_price || 0),
    }]);
    setSearch('');
    setResults([]);
  };

  const addLabel = () => {
    if (full) return;
    const label = labelText.trim();
    const typed = labelPrice.trim().replace(/,/g, '');
    if (!label) { setLabelError('Type a name for the button, like "Bouquet".'); return; }
    if (!typed) { setLabelError('Type the price in rupees. It must be more than 0.'); return; }
    if (!/^\d+(\.\d{1,2})?$/.test(typed)) {
      setLabelError('Type the price as a number with at most 2 digits after the dot, like 300 or 199.50.'); return;
    }
    const price = Math.round(Number(typed) * 100) / 100;
    if (price <= 0) { setLabelError('The price must be more than 0.'); return; }
    if (price > MAX_PRICE) { setLabelError('The price can be at most ₹1,00,000.'); return; }
    setLabelError('');
    setTiles((prev) => [...prev, { id: nextId(), type: 'label', label, price }]);
    setLabelText('');
    setLabelPrice('');
  };

  const removeAt = (i) => setTiles((prev) => prev.filter((_, idx) => idx !== i));
  const move = (i, dir) => setTiles((prev) => {
    const j = i + dir;
    if (j < 0 || j >= prev.length) return prev;
    const next = prev.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const persist = async (list) => {
    const label = billLabel.trim();
    const hsn = billHsn.replace(/\s/g, '');
    if (!label) { setBillError('Type the name the bill shows, like Fresh Flowers.'); return false; }
    if (!/^[0-9]{4,8}$/.test(hsn)) { setBillError('The HSN code is 4 to 8 numbers, like 0603.'); return false; }
    setBillError('');
    setSaving(true);
    try {
      const payload = list.map((t) => (t.type === 'product'
        ? { type: 'product', product_id: t.product_id }
        : { type: 'label', label: t.label, price: t.price }));
      // Empty list saves '' so the screen goes back to suggested buttons.
      const value = payload.length ? JSON.stringify(payload) : '';
      await api.updateSettings({ quick_sale_tiles: value, quick_sale_label: label, quick_sale_hsn: hsn });
      // Saved: the draft is now the saved list (no leave prompt), then refresh quietly.
      setTiles(list);
      setSavedSnap(snapOf(list, label, hsn));
      setSaving(false);
      showAlert('Saved', payload.length
        ? 'Your buttons and bill name are saved. Counter staff will see them on the Quick sale screen.'
        : 'Your own buttons were removed. Suggested buttons will be shown again.');
      await load(true);
      return true;
    } catch (err) {
      showAlert('Could not save', 'The buttons were not saved. Check your connection and tap Save again.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const guardSubmit = useSubmitGuard();
  const handleSave = guardSubmit(async () => {
    if (!isOwner) return;
    await persist(tiles);
  });

  const handleRemoveAll = () => {
    showConfirm(
      'Remove all buttons?',
      'Counter staff will see suggested buttons again until you add your own.',
      () => { persist([]); },
      { confirmLabel: 'Remove all', destructive: true },
    );
  };

  if (!isOwner) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Only the owner can change the Quick sale buttons.</Text>
      </View>
    );
  }

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={Colors.primary} /></View>;
  }

  if (loadError) {
    return (
      <View style={styles.center}>
        <Text style={[styles.muted, { marginBottom: Spacing.md }]}>{loadError}</Text>
        <Button title="Try again" onPress={load} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.intro}>
        These are the buttons counter staff tap on the Quick sale screen. Up to {MAX_TILES}.
      </Text>

      {source === 'suggested' && (
        <View style={styles.notice}>
          <Ionicons name="information-circle-outline" size={20} color={Colors.info} />
          <Text style={styles.noticeText}>
            {tiles.length === 0
              ? 'No suggested buttons yet — add your own below'
              : 'Showing suggested buttons — add your own to replace them'}
          </Text>
        </View>
      )}

      <Text style={styles.section}>Your buttons ({tiles.length} of {MAX_TILES})</Text>
      {tiles.length === 0 ? (
        <Text style={styles.muted}>No buttons yet. Add a product or a named amount below.</Text>
      ) : tiles.map((t, i) => (
        <View key={t.id} style={styles.tileRow}>
          <View style={styles.tileInfo}>
            <Text style={styles.tileName}>{t.label}</Text>
            <Text style={styles.tileMeta}>
              {t.type === 'product' ? `Product · ${rupees(t.price)}` : `Fixed amount · ${rupees(t.price)}`}
            </Text>
          </View>
          <IconBtn name="arrow-up" label={`Move ${t.label} up`} onPress={() => move(i, -1)} disabled={i === 0} />
          <IconBtn name="arrow-down" label={`Move ${t.label} down`} onPress={() => move(i, 1)} disabled={i === tiles.length - 1} />
          <IconBtn name="trash-outline" label={`Remove ${t.label}`} onPress={() => removeAt(i)} color={Colors.danger} />
        </View>
      ))}

      <Text style={styles.section}>Add a product</Text>
      {full && <Text style={styles.warn}>12 buttons is the most that fit</Text>}
      <TextInput
        style={[styles.input, full && styles.inputDisabled]}
        value={search}
        onChangeText={setSearch}
        editable={!full}
        placeholder="Search products by name"
        placeholderTextColor={Colors.textLight}
        accessibilityLabel="Search products"
      />
      {searching && <ActivityIndicator style={{ marginTop: Spacing.sm }} color={Colors.primary} />}
      {!full && results.map((p) => (
        <TouchableOpacity key={p.id} style={styles.resultRow} onPress={() => addProduct(p)} accessibilityRole="button">
          <Text style={styles.tileName} numberOfLines={2}>{p.name}</Text>
          <Text style={styles.tileMeta}>{rupees(p.selling_price)}</Text>
          <Ionicons name="add-circle-outline" size={24} color={Colors.primary} />
        </TouchableOpacity>
      ))}
      {!full && !searching && !!search.trim() && results.length === 0 && (
        <Text style={[styles.muted, { marginTop: Spacing.sm }]}>No active product matches that name.</Text>
      )}

      <Text style={styles.section}>Add a named amount</Text>
      <Text style={styles.label}>Button name</Text>
      <TextInput
        style={[styles.input, full && styles.inputDisabled]}
        value={labelText}
        onChangeText={(v) => { setLabelText(v); setLabelError(''); }}
        editable={!full}
        placeholder="For example: Bouquet"
        placeholderTextColor={Colors.textLight}
        maxLength={30}
      />
      <Text style={[styles.label, { marginTop: Spacing.sm }]}>Price (₹)</Text>
      <TextInput
        style={[styles.input, full && styles.inputDisabled]}
        value={labelPrice}
        onChangeText={(v) => { setLabelPrice(v); setLabelError(''); }}
        editable={!full}
        keyboardType="decimal-pad"
        placeholder="300"
        placeholderTextColor={Colors.textLight}
      />
      {!!labelError && <Text style={styles.error}>{labelError}</Text>}
      <Button title="Add this button" onPress={addLabel} disabled={full} variant="outline" style={{ marginTop: Spacing.md }} />

      <Text style={styles.section}>Typed amounts on the bill</Text>
      <Text style={styles.intro}>
        When staff type an amount, the bill shows this name with this HSN code, at 0% GST.
        The named amounts above use the same HSN code.
      </Text>
      <Text style={styles.label}>Name on the bill</Text>
      <TextInput
        style={styles.input}
        value={billLabel}
        onChangeText={(v) => { setBillLabel(v); setBillError(''); }}
        placeholder="Fresh Flowers"
        placeholderTextColor={Colors.textLight}
        maxLength={30}
        accessibilityLabel="Name on the bill for typed amounts"
      />
      <Text style={[styles.label, { marginTop: Spacing.sm }]}>HSN code</Text>
      <TextInput
        style={styles.input}
        value={billHsn}
        onChangeText={(v) => { setBillHsn(v.replace(/\D/g, '').slice(0, 8)); setBillError(''); }}
        keyboardType="number-pad"
        placeholder="0603"
        placeholderTextColor={Colors.textLight}
        accessibilityLabel="HSN code for typed amounts"
      />
      {!!billError && <Text style={styles.error}>{billError}</Text>}

      <Button title="Save" onPress={handleSave} loading={saving} style={{ marginTop: Spacing.xl }} />
      {tiles.length > 0 && (
        <TouchableOpacity onPress={handleRemoveAll} disabled={saving} style={styles.removeAll} accessibilityRole="button">
          <Text style={styles.removeAllText}>Remove all</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: Spacing.xxl, width: '100%', maxWidth: 800, alignSelf: 'center' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.lg, backgroundColor: Colors.background },
  muted: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center' },
  intro: { fontSize: FontSize.md, color: Colors.textSecondary, marginBottom: Spacing.md },
  notice: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, padding: Spacing.md,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.info,
    marginBottom: Spacing.md,
  },
  noticeText: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  section: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  tileRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    paddingLeft: Spacing.md, paddingRight: Spacing.xs, paddingVertical: Spacing.xs, marginBottom: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border, minHeight: 56,
  },
  tileInfo: { flex: 1, paddingRight: Spacing.sm },
  tileName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, flexShrink: 1 },
  tileMeta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  iconBtn: { ...TouchTarget, justifyContent: 'center', alignItems: 'center' },
  resultRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md, padding: Spacing.md, marginTop: Spacing.sm, minHeight: 56,
    borderWidth: 1, borderColor: Colors.border,
  },
  label: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, marginBottom: Spacing.xs },
  input: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.sm, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.md, minHeight: 48, fontSize: FontSize.md, color: Colors.text,
  },
  inputDisabled: { backgroundColor: Colors.surfaceAlt, opacity: 0.6 },
  warn: { fontSize: FontSize.md, color: Colors.warning, fontWeight: '600', marginBottom: Spacing.sm },
  error: { fontSize: FontSize.sm, color: Colors.danger, marginTop: Spacing.sm },
  removeAll: { minHeight: 48, justifyContent: 'center', alignItems: 'center', marginTop: Spacing.sm },
  removeAllText: { fontSize: FontSize.md, color: Colors.danger, fontWeight: '600' },
});
