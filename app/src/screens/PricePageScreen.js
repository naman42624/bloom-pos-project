// Public price page reached by scanning a label QR (/p/<code>). No login, no
// navigation chrome. Shows "Available" or "Ask at the counter" only, never a
// stock number. App.js renders this before AuthProvider mounts.
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, ScrollView, Image } from 'react-native';
import api from '../services/api';
import { Colors, Spacing, FontSize, BorderRadius } from '../constants/theme';

const FALLBACK = "We couldn't find this item — please ask at the counter.";

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export default function PricePageScreen({ code }) {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
    let alive = true;
    api.getPublicPrice(code)
      .then((res) => { if (alive) setState({ loading: false, data: res.data, error: null }); })
      .catch((e) => {
        if (alive) setState({ loading: false, data: null, error: (e && e.message) || FALLBACK });
      });
    return () => { alive = false; };
  }, [code]);

  const { loading, data, error } = state;
  const options = (data && data.options) || [];

  let priceBlock = null;
  if (data) {
    if (options.length > 0) {
      priceBlock = (
        <View style={styles.options}>
          {options.map((o, i) => (
            <View key={`${o.label}-${i}`} style={styles.optionRow}>
              <Text style={styles.optionLabel}>{o.label}</Text>
              <Text style={styles.optionPrice}>{money(o.price)}</Text>
            </View>
          ))}
        </View>
      );
    } else if (data.price_mode === 'open') {
      priceBlock = (
        <Text style={styles.hint}>{data.price_hint || 'Price depends on size — ask at the counter'}</Text>
      );
    } else if (data.price == null || money(data.price) == null) {
      priceBlock = <Text style={styles.hint}>Ask at the counter for the price</Text>;
    } else {
      priceBlock = <Text style={styles.price}>{money(data.price)}</Text>;
    }
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        {loading ? (
          <ActivityIndicator size="large" color={Colors.primary} style={{ marginVertical: Spacing.xl }} />
        ) : error ? (
          <Text style={styles.error}>{error}</Text>
        ) : (
          <>
            {!!data.shop_name && <Text style={styles.shop}>{data.shop_name}</Text>}
            {!!data.image_url && (
              <Image
                source={{ uri: api.getMediaUrl(data.image_url) }}
                style={styles.image}
                resizeMode="cover"
                accessibilityLabel={data.name}
              />
            )}
            <Text style={styles.name}>{data.name}</Text>
            {priceBlock}
            <View style={[styles.pill, data.available ? styles.pillOn : styles.pillOff]}>
              <Text style={[styles.pillText, data.available ? styles.pillTextOn : styles.pillTextOff]}>
                {data.available ? 'Available' : 'Ask at the counter'}
              </Text>
            </View>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: Colors.background },
  content: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.md },
  card: {
    width: '100%', maxWidth: 480, backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.lg, alignItems: 'center',
  },
  shop: { fontSize: FontSize.md, color: Colors.textSecondary, marginBottom: Spacing.md, textAlign: 'center' },
  image: { width: '100%', aspectRatio: 1, borderRadius: BorderRadius.md, backgroundColor: Colors.surfaceAlt, marginBottom: Spacing.md },
  name: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, textAlign: 'center', marginBottom: Spacing.sm },
  price: { fontSize: FontSize.hero, fontWeight: '800', color: Colors.primaryDark, marginVertical: Spacing.sm },
  hint: { fontSize: FontSize.lg, color: Colors.textSecondary, textAlign: 'center', marginVertical: Spacing.sm },
  options: { width: '100%', marginVertical: Spacing.sm },
  optionRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: Spacing.sm + 2, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  optionLabel: { fontSize: FontSize.lg, color: Colors.text, flexShrink: 1, paddingRight: Spacing.md },
  optionPrice: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.primaryDark },
  pill: { marginTop: Spacing.md, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg, borderRadius: BorderRadius.full },
  pillOn: { backgroundColor: Colors.secondaryLight },
  pillOff: { backgroundColor: Colors.surfaceAlt },
  pillText: { fontSize: FontSize.lg, fontWeight: '700' },
  pillTextOn: { color: Colors.secondaryDark },
  pillTextOff: { color: Colors.textSecondary },
  error: { fontSize: FontSize.lg, color: Colors.text, textAlign: 'center', paddingVertical: Spacing.lg },
});
