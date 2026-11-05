// Owner only: what the printed bill shows and how it is worked out
// (2026-11-05). Shop-level details (GSTIN, state, FSSAI, bill number start)
// live on each shop's form; this screen holds the settings shared by every shop.
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, Switch, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Input from '../components/Input';
import Button from '../components/Button';
import DismissKeyboard from '../components/DismissKeyboard';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { showAlert } from '../utils/alert';
import { loadBillSettings } from '../hooks/useBillSettings';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const TEXT_KEYS = ['bill_legal_name', 'bill_pan', 'bill_terms', 'receipt_footer', 'gst_delivery_rate', 'gst_delivery_sac', 'gst_default_rate', 'gst_default_hsn', 'invoice_prefix', 'credit_note_prefix'];
const SHOW = [
  ['customer_phone', 'Customer phone numbers'],
  ['order_number', 'Order number'],
  ['ship_to', 'Delivery address (Ship to)'],
  ['words', 'Total in words'],
  ['gst_table', 'GST summary table'],
  ['payments', 'How it was paid'],
];

export default function BillSettingsScreen({ navigation }) {
  const { user, refreshSettings } = useAuth();
  const guard = useSubmitGuard();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [vals, setVals] = useState({});
  const [roundOff, setRoundOff] = useState(false);
  const [seriesAll, setSeriesAll] = useState(false);
  const [show, setShow] = useState({});
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await api.getSettings();
      const st = res?.data?.settings || {};
      const v = {};
      for (const k of TEXT_KEYS) v[k] = st[k]?.value ?? '';
      setVals(v);
      setRoundOff(st.bill_round_off?.value === '1');
      setSeriesAll(st.invoice_series_mode?.value === 'all');
      let sf = {};
      try { sf = JSON.parse(st.bill_show_fields?.value || '{}') || {}; } catch (e) { sf = {}; }
      setShow(sf);
    } catch (e) {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const set = (k) => (t) => { setVals((p) => ({ ...p, [k]: t })); setError(null); };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const showFields = {};
      for (const [k] of SHOW) if (show[k] === false) showFields[k] = false;
      await api.updateSettings({
        ...vals,
        bill_round_off: roundOff ? '1' : '0',
        invoice_series_mode: seriesAll ? 'all' : 'shop',
        bill_show_fields: JSON.stringify(showFields),
      });
      await loadBillSettings();
      if (refreshSettings) await refreshSettings();
      showAlert('Saved', 'Bills printed from now on use these settings.');
    } catch (err) {
      // The server says exactly which field is wrong and how to fix it
      setError(err.message || 'The settings were not saved. Check your connection and tap Save again.');
    } finally {
      setSaving(false);
    }
  };

  if (user?.role !== 'owner') {
    return <View style={styles.center}><Text style={styles.body}>Only the owner can change bill settings.</Text></View>;
  }
  if (loading) return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;
  if (loadError) {
    return (
      <View style={styles.center}>
        <Text style={styles.body}>Couldn't load the bill settings.</Text>
        <Button title="Try again" onPress={load} style={{ marginTop: Spacing.md }} />
      </View>
    );
  }

  const toggle = (label, value, onChange, desc) => (
    <View style={styles.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.label}>{label}</Text>
        {desc ? <Text style={styles.desc}>{desc}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} trackColor={{ true: Colors.primary + '80' }} thumbColor={value ? Colors.primary : Colors.textLight} />
    </View>
  );

  return (
    <DismissKeyboard>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <TouchableOpacity style={styles.linkRow} onPress={() => navigation.navigate('Locations')} accessibilityRole="button">
          <Ionicons name="storefront-outline" size={22} color={Colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>GSTIN, state and FSSAI</Text>
            <Text style={styles.desc}>Set these on each shop. A shop with a GSTIN prints TAX INVOICE bills.</Text>
          </View>
          <Ionicons name="chevron-forward" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>

        <Text style={styles.section}>On every bill</Text>
        <Input label="Registered business name" value={vals.bill_legal_name} onChangeText={set('bill_legal_name')} placeholder="Optional, printed under the shop name" />
        <Input label="PAN" value={vals.bill_pan} onChangeText={(t) => set('bill_pan')(t.toUpperCase())} placeholder="Optional, like ABCDE1234F" autoCapitalize="characters" maxLength={10} />
        <Input label="Terms" value={vals.bill_terms} onChangeText={set('bill_terms')} placeholder="Optional, like: No returns on fresh flowers" multiline />
        <Input label="Thank-you line" value={vals.receipt_footer} onChangeText={set('receipt_footer')} placeholder="Printed at the very bottom" />

        <Text style={styles.section}>GST</Text>
        <Text style={styles.desc}>Shelf prices include GST. A product's GST % and HSN code are set on the product.</Text>
        <Input label="GST % inside delivery charges" value={String(vals.gst_delivery_rate)} onChangeText={set('gst_delivery_rate')} keyboardType="decimal-pad" placeholder="18" />
        <Input label="SAC code for delivery" value={vals.gst_delivery_sac} onChangeText={set('gst_delivery_sac')} keyboardType="number-pad" placeholder="9968" maxLength={8} />
        <Input label="GST % for custom items" value={String(vals.gst_default_rate)} onChangeText={set('gst_default_rate')} keyboardType="decimal-pad" placeholder="0" />
        <Input label="HSN code for custom items" value={vals.gst_default_hsn} onChangeText={set('gst_default_hsn')} keyboardType="number-pad" placeholder="Like 0603" maxLength={8} />
        {toggle('Round the total to the nearest rupee', roundOff, setRoundOff, 'Turn on only once every counter has the new app. Quick sales and helper sales are never rounded.')}

        <Text style={styles.section}>Bill numbers</Text>
        <Input label="Bill number start" value={vals.invoice_prefix} onChangeText={(t) => set('invoice_prefix')(t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5))} placeholder="INV" maxLength={5} autoCapitalize="characters" />
        <Input label="Credit note number start" value={vals.credit_note_prefix} onChangeText={(t) => set('credit_note_prefix')(t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5))} placeholder="CN" maxLength={5} autoCapitalize="characters" />
        {toggle('One series for all shops', seriesAll, setSeriesAll, seriesAll
          ? 'Every shop shares one run of numbers.'
          : 'Each shop has its own run of numbers (a shop without its own start gets this start plus its shop number). Numbers start again at 1 every April.')}

        <Text style={styles.section}>Print on the bill</Text>
        {SHOW.map(([k, label]) => toggle(label, show[k] !== false, (on) => setShow((p) => ({ ...p, [k]: on })), null))}

        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button title="Save" size="lg" loading={saving} disabled={saving} onPress={guard(save)} style={{ marginTop: Spacing.lg }} />
      </ScrollView>
    </DismissKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: Spacing.xxl || 48, width: '100%', maxWidth: 800, alignSelf: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg },
  section: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  label: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  desc: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2, marginBottom: Spacing.sm },
  body: { fontSize: FontSize.md, color: Colors.text, textAlign: 'center' },
  error: { fontSize: FontSize.md, color: Colors.error, fontWeight: '600', marginTop: Spacing.md },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, minHeight: 56, paddingVertical: Spacing.sm },
  linkRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md, minHeight: 64, padding: Spacing.md,
    backgroundColor: Colors.surface || '#fff', borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
  },
});
