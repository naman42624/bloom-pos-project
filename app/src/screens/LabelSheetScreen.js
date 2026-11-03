import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, Switch,
  ActivityIndicator,
} from 'react-native';
import api from '../services/api';
import { printHtml } from '../utils/printHelpers';
import { buildLabelSheetHtml } from '../utils/labelSheetHtml';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const LAYOUT_CHIPS = [
  { key: 'stickers', label: 'Stickers' },
  { key: 'bucket', label: 'Bucket cards' },
  { key: 'price_card', label: 'Price card' },
];

const MAX_COUNT = 48;

export default function LabelSheetScreen({ route }) {
  const preselect = route?.params?.productId;
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [counts, setCounts] = useState(preselect ? { [preselect]: 1 } : {});
  const [layout, setLayout] = useState('stickers');
  const [showPrice, setShowPrice] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      let all = [];
      for (let page = 0; page < 10; page += 1) {
        const res = await api.getProducts({ limit: 100, offset: page * 100, is_active: 1 });
        const list = res.data || [];
        all = all.concat(list);
        if (list.length < 100) break;
      }
      setProducts(all);
    } catch (e) {
      setLoadError('Could not load the products. Check the connection and tap Try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const categories = useMemo(
    () => Array.from(new Set(products.map((p) => p.category).filter(Boolean))).sort(),
    [products],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => (!category || p.category === category)
      && (!q || String(p.name || '').toLowerCase().includes(q)));
  }, [products, search, category]);

  const selectedIds = Object.keys(counts).map(Number);
  const totalLabels = selectedIds.reduce((s, id) => s + counts[id], 0);

  const toggle = (id) => setCounts((c) => {
    const n = { ...c };
    if (n[id]) delete n[id]; else n[id] = 1;
    return n;
  });
  const step = (id, d) => setCounts((c) => ({ ...c, [id]: Math.max(1, Math.min(MAX_COUNT, (c[id] || 1) + d)) }));
  const tickAllInCategory = () => setCounts((c) => {
    const n = { ...c };
    visible.forEach((p) => { if (!n[p.id]) n[p.id] = 1; });
    return n;
  });

  const handlePrint = async () => {
    if (printing) return;
    if (!selectedIds.length) { setError('Tick at least one product first.'); return; }
    setPrinting(true);
    setError('');
    try {
      const res = await api.getLabels(selectedIds);
      const rows = res.data || [];
      const items = rows.map((r) => ({ ...r, count: counts[r.product_id] || 1 }));
      const html = buildLabelSheetHtml({ layout, items, showPrice, date: new Date() });
      await printHtml(html, 'Labels');
    } catch (e) {
      setError('Could not make the labels. Check the connection and tap Print again.');
    } finally {
      setPrinting(false);
    }
  };

  if (loading) return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;
  if (loadError) {
    return (
      <View style={styles.center}>
        <Text style={styles.msg}>{loadError}</Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={load}><Text style={styles.primaryText}>Try again</Text></TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.column}>
          <Text style={styles.heading}>1. Pick the products</Text>
          <TextInput
            style={styles.input}
            placeholder="Search by name"
            placeholderTextColor={Colors.textLight}
            value={search}
            onChangeText={setSearch}
          />
          {categories.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
              <Chip label="All" active={!category} onPress={() => setCategory('')} />
              {categories.map((c) => (
                <Chip key={c} label={c.replace(/_/g, ' ')} active={category === c} onPress={() => setCategory(c)} />
              ))}
            </ScrollView>
          )}
          {!!category && (
            <TouchableOpacity style={styles.secondaryBtn} onPress={tickAllInCategory}>
              <Text style={styles.secondaryText}>Tick all in {category.replace(/_/g, ' ')}</Text>
            </TouchableOpacity>
          )}

          {visible.length === 0 && <Text style={styles.msg}>No products match.</Text>}
          {visible.map((p) => {
            const on = !!counts[p.id];
            return (
              <View key={p.id} style={[styles.row, on && styles.rowOn]}>
                <TouchableOpacity style={styles.rowMain} onPress={() => toggle(p.id)} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
                  <View style={[styles.box, on && styles.boxOn]}>{on && <Text style={styles.tick}>{'✓'}</Text>}</View>
                  <Text style={styles.rowName} numberOfLines={2}>{p.name}</Text>
                </TouchableOpacity>
                {on && (
                  <View style={styles.stepper}>
                    <TouchableOpacity style={styles.stepBtn} onPress={() => step(p.id, -1)} accessibilityLabel="Fewer labels"><Text style={styles.stepText}>-</Text></TouchableOpacity>
                    <Text style={styles.count}>{counts[p.id]}</Text>
                    <TouchableOpacity style={styles.stepBtn} onPress={() => step(p.id, 1)} accessibilityLabel="More labels"><Text style={styles.stepText}>+</Text></TouchableOpacity>
                  </View>
                )}
              </View>
            );
          })}

          <Text style={[styles.heading, { marginTop: Spacing.lg }]}>2. Pick the sheet</Text>
          <View style={styles.chipWrap}>
            {LAYOUT_CHIPS.map((l) => <Chip key={l.key} label={l.label} active={layout === l.key} onPress={() => setLayout(l.key)} />)}
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Show price on the label</Text>
            <Switch value={showPrice} onValueChange={setShowPrice} trackColor={{ true: Colors.primary }} />
          </View>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        {!!error && <Text style={styles.error}>{error}</Text>}
        <TouchableOpacity style={[styles.primaryBtn, (printing || !selectedIds.length) && styles.disabled]} onPress={handlePrint} disabled={printing}>
          {printing ? <ActivityIndicator color={Colors.white} /> : (
            <Text style={styles.primaryText}>{totalLabels ? `Print ${totalLabels} label${totalLabels === 1 ? '' : 's'}` : 'Print'}</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Chip({ label, active, onPress }) {
  return (
    <TouchableOpacity style={[styles.chip, active && styles.chipOn]} onPress={onPress}>
      <Text style={[styles.chipText, active && styles.chipTextOn]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg },
  scroll: { padding: Spacing.md, paddingBottom: Spacing.xl },
  column: { width: '100%', maxWidth: 800, alignSelf: 'center' },
  heading: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  msg: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', marginVertical: Spacing.md },
  input: { minHeight: 48, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, fontSize: FontSize.md, backgroundColor: Colors.surface, color: Colors.text },
  chipRow: { marginTop: Spacing.sm, flexGrow: 0 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: { minHeight: 48, paddingHorizontal: Spacing.md, justifyContent: 'center', borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface, marginRight: Spacing.sm, marginBottom: Spacing.sm },
  chipOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.md, color: Colors.text, textTransform: 'capitalize' },
  chipTextOn: { color: Colors.textOnPrimary, fontWeight: '700' },
  secondaryBtn: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary, marginBottom: Spacing.sm },
  secondaryText: { color: Colors.primary, fontSize: FontSize.md, fontWeight: '600', textTransform: 'capitalize' },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 56, backgroundColor: Colors.surface, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, marginBottom: Spacing.sm, paddingRight: Spacing.sm },
  rowOn: { borderColor: Colors.primary, backgroundColor: Colors.primaryGlow },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: Spacing.md },
  box: { width: 28, height: 28, borderRadius: 6, borderWidth: 2, borderColor: Colors.textLight, alignItems: 'center', justifyContent: 'center', marginRight: Spacing.md },
  boxOn: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  tick: { color: Colors.white, fontWeight: '700', fontSize: FontSize.md },
  rowName: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  stepper: { flexDirection: 'row', alignItems: 'center' },
  stepBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: BorderRadius.md, backgroundColor: Colors.surfaceAlt, borderWidth: 1, borderColor: Colors.border },
  stepText: { fontSize: FontSize.xl, color: Colors.text, fontWeight: '600' },
  count: { minWidth: 36, textAlign: 'center', fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 56 },
  switchLabel: { fontSize: FontSize.md, color: Colors.text },
  footer: { padding: Spacing.md, backgroundColor: Colors.surface, borderTopWidth: 1, borderTopColor: Colors.border, alignItems: 'center' },
  error: { color: Colors.error, fontSize: FontSize.md, marginBottom: Spacing.sm, textAlign: 'center' },
  primaryBtn: { minHeight: 56, width: '100%', maxWidth: 800, backgroundColor: Colors.primary, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.lg },
  primaryText: { color: Colors.textOnPrimary, fontSize: FontSize.lg, fontWeight: '700' },
  disabled: { opacity: 0.5 },
});
