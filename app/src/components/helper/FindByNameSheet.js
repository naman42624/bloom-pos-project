// "Find by name" for the helper's Sell screen: a search box and a photo grid
// of the shop's products (GET /products, the helper's view: no stock numbers,
// just available yes/no). Tapping one hands it to the parent, which asks for
// a size or a price when needed and adds it to the basket.
//
// <FindByNameSheet visible locationId onPick={(product) => …} onClose onError notice>
//   {size / price sheet overlay, so it shows above this Modal}
// </FindByNameSheet>
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, FlatList, TextInput, Image,
  ActivityIndicator, useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import api from '../../services/api';
import { formatRupees } from '../../utils/scanAddLine';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

const LOAD_FAILED = "Couldn't load the products. Check the internet and tap Try again.";

function priceText(p) {
  if (p.price_mode === 'open') return p.price_hint || 'Type the price';
  const n = Number(p.selling_price) || 0;
  return n > 0 ? formatRupees(n) : '';
}

export default function FindByNameSheet({ visible, locationId, onPick, onClose, onError, notice, children }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const columns = width >= 900 ? 4 : width >= 600 ? 3 : 2;
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef(null);
  const seq = useRef(0);

  const load = useCallback(async (q) => {
    const mine = ++seq.current;
    setLoading(true);
    setError('');
    try {
      const params = { limit: 60 };
      if (locationId) params.location_id = locationId;
      if (q && q.trim()) params.search = q.trim();
      const res = await api.getProducts(params);
      if (mine !== seq.current) return;
      setProducts(Array.isArray(res?.data) ? res.data : []);
    } catch (err) {
      if (mine !== seq.current) return;
      if (onError && onError(err)) return;
      setError(LOAD_FAILED);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [locationId, onError]);

  useEffect(() => {
    if (!visible) return;
    setQuery('');
    load('');
  }, [visible, load]);

  const onChange = (t) => {
    setQuery(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => load(t), 300);
  };

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const tileWidth = Math.floor((Math.min(width, 1100) - Spacing.md * 2 - Spacing.sm * (columns - 1)) / columns);

  const renderItem = ({ item }) => {
    const sold = item.available === false;
    const img = item.image_url ? api.getMediaUrl(item.image_url) : null;
    return (
      <TouchableOpacity
        style={[styles.tile, { width: tileWidth }, sold && styles.tileSold]}
        onPress={() => onPick(item)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}${sold ? ', already sold' : ''}`}
      >
        <View style={styles.photo}>
          {img ? (
            <Image source={{ uri: img }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          ) : (
            <Ionicons name="flower-outline" size={36} color={Colors.textLight} />
          )}
          {sold ? (
            <View style={styles.soldBadge}><Text style={styles.soldText}>Sold</Text></View>
          ) : null}
        </View>
        <Text style={styles.name} numberOfLines={2}>{item.name}</Text>
        {priceText(item) ? <Text style={styles.price} numberOfLines={1}>{priceText(item)}</Text> : null}
      </TouchableOpacity>
    );
  };

  let body;
  if (error) {
    body = (
      <View style={styles.center}>
        <Ionicons name="cloud-offline-outline" size={48} color={Colors.textSecondary} />
        <Text style={styles.centerText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => load(query)} accessibilityRole="button" accessibilityLabel="Try again">
          <Ionicons name="refresh" size={22} color={Colors.white} />
          <Text style={styles.retryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (!loading && products.length === 0) {
    body = (
      <View style={styles.center}>
        <Ionicons name="search-outline" size={48} color={Colors.textSecondary} />
        <Text style={styles.centerText}>
          {query.trim() ? `Nothing called "${query.trim()}". Try a shorter word.` : 'No products yet.'}
        </Text>
      </View>
    );
  } else {
    body = (
      <FlatList
        key={`cols-${columns}`}
        data={products}
        keyExtractor={(p) => String(p.id)}
        numColumns={columns}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: Spacing.md, paddingBottom: Spacing.xl }}
        columnWrapperStyle={columns > 1 ? { gap: Spacing.sm } : undefined}
        ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
      />
    );
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: Math.max(insets.top, Spacing.sm) }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Find by name</Text>
          <TouchableOpacity
            style={styles.closeBtn}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close, back to the basket"
          >
            <Ionicons name="close" size={26} color={Colors.text} />
            <Text style={styles.closeText}>Close</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.searchRow}>
          <Ionicons name="search" size={22} color={Colors.textSecondary} />
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={onChange}
            placeholder="Type a name, e.g. rose"
            placeholderTextColor={Colors.textLight}
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Product name"
          />
          {loading ? <ActivityIndicator color={Colors.primary} /> : null}
        </View>
        {notice ? (
          <View style={[styles.notice, notice.kind === 'error' && styles.noticeError]} accessibilityLiveRegion="polite">
            <Ionicons
              name={notice.kind === 'error' ? 'alert-circle' : 'checkmark-circle'}
              size={22}
              color={notice.kind === 'error' ? Colors.error : Colors.success}
            />
            <Text style={styles.noticeText}>{notice.text}</Text>
          </View>
        ) : null}
        <View style={{ flex: 1, paddingBottom: insets.bottom }}>{body}</View>
        {children}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingBottom: Spacing.sm,
  },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  closeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 48, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  closeText: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginHorizontal: Spacing.md,
    paddingHorizontal: Spacing.md, minHeight: 56, borderRadius: BorderRadius.md,
    borderWidth: 2, borderColor: Colors.primary, backgroundColor: Colors.surface,
  },
  search: { flex: 1, fontSize: FontSize.lg, color: Colors.text, minHeight: 52 },
  notice: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginHorizontal: Spacing.md, marginTop: Spacing.sm,
    padding: Spacing.sm, borderRadius: BorderRadius.md, backgroundColor: Colors.successLight,
  },
  noticeError: { backgroundColor: Colors.errorLight },
  noticeText: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  tile: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.sm, minHeight: 180,
  },
  tileSold: { opacity: 0.55 },
  photo: {
    width: '100%', aspectRatio: 1, borderRadius: BorderRadius.sm, backgroundColor: Colors.surfaceAlt,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginBottom: Spacing.xs,
  },
  soldBadge: {
    position: 'absolute', top: Spacing.xs, left: Spacing.xs, backgroundColor: Colors.text,
    borderRadius: BorderRadius.sm, paddingHorizontal: Spacing.sm, paddingVertical: 2,
  },
  soldText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: '700' },
  name: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  price: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primaryDark, marginTop: 2, fontVariant: ['tabular-nums'] },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg, gap: Spacing.md },
  centerText: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', maxWidth: 360, lineHeight: 22 },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 52, paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md, backgroundColor: Colors.primary,
  },
  retryText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '700' },
});
