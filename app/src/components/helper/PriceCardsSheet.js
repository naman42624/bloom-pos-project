// "Price cards" (spec §9.1): one big button per thing on the shop's printed
// price card — the active products in the category named "Price cards". A
// product with sizes shows one button per size (Bouquet ₹200 / ₹300 / ₹500),
// a "type the price" product asks for the price after the tap.
//
// <PriceCardsSheet visible cards loading error onRetry onPick={(card) => …} onClose notice>
//   {size / price sheet overlay, so it shows above this Modal}
// </PriceCardsSheet>
//   card = { key, product, option, title, priceText }
// The sheet stays open after a tap (a bouquet, its wrapping and a card are
// often bought together); `notice` says what was just added.
import React from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, FlatList, ActivityIndicator, useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

export default function PriceCardsSheet({ visible, cards, loading, error, onRetry, onPick, onClose, notice, children }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const columns = width >= 640 ? 3 : 2;

  let body;
  if (loading) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={styles.centerText}>Loading the price cards…</Text>
      </View>
    );
  } else if (error) {
    body = (
      <View style={styles.center}>
        <Ionicons name="cloud-offline-outline" size={48} color={Colors.textSecondary} />
        <Text style={styles.centerText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={onRetry} accessibilityRole="button" accessibilityLabel="Try again">
          <Ionicons name="refresh" size={22} color={Colors.white} />
          <Text style={styles.retryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (!cards || cards.length === 0) {
    body = (
      <View style={styles.center}>
        <Ionicons name="pricetags-outline" size={48} color={Colors.textSecondary} />
        <Text style={styles.centerText}>No price cards yet. Scan the item, or tap Find by name.</Text>
      </View>
    );
  } else {
    body = (
      <FlatList
        key={`cols-${columns}`}
        data={cards}
        keyExtractor={(c) => c.key}
        numColumns={columns}
        contentContainerStyle={{ padding: Spacing.md, paddingBottom: Spacing.xl }}
        columnWrapperStyle={{ gap: Spacing.sm }}
        ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.card}
            onPress={() => onPick(item)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}, ${item.priceText}`}
          >
            <Text style={styles.cardTitle}>{item.title}</Text>
            <Text style={styles.cardPrice}>{item.priceText}</Text>
          </TouchableOpacity>
        )}
      />
    );
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: Math.max(insets.top, Spacing.sm) }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Price cards</Text>
          <TouchableOpacity
            style={styles.closeBtn}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Done, back to the basket"
          >
            <Ionicons name="checkmark" size={24} color={Colors.white} />
            <Text style={styles.closeText}>Done</Text>
          </TouchableOpacity>
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
        ) : (
          <Text style={styles.sub}>Tap what the customer is buying.</Text>
        )}
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
    paddingHorizontal: Spacing.md, paddingBottom: Spacing.xs,
  },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  sub: { fontSize: FontSize.md, color: Colors.textSecondary, paddingHorizontal: Spacing.md },
  closeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 48, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, backgroundColor: Colors.primary,
  },
  closeText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.white },
  notice: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginHorizontal: Spacing.md,
    padding: Spacing.sm, borderRadius: BorderRadius.md, backgroundColor: Colors.successLight,
  },
  noticeError: { backgroundColor: Colors.errorLight },
  noticeText: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  card: {
    flex: 1, minHeight: 104, borderRadius: BorderRadius.lg, backgroundColor: Colors.surface,
    borderWidth: 2, borderColor: Colors.primary, padding: Spacing.md, justifyContent: 'space-between',
  },
  cardTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  cardPrice: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.primaryDark, fontVariant: ['tabular-nums'], marginTop: Spacing.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg, gap: Spacing.md },
  centerText: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', maxWidth: 360, lineHeight: 22 },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 52, paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md, backgroundColor: Colors.primary,
  },
  retryText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '700' },
});
