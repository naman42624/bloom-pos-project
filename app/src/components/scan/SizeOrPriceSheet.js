// "Which size?" / "Type the price" sheet, shared by Scan (ScanAddModal) and
// Quick Checkout's product picker so a sized or typed-price product asks the
// same question whichever way it was added.
//
// <SizeOrPriceSheet
//    pending={{ product, mode: 'size' | 'price' } | null}
//    onPickOption={(option) => ...}
//    onSubmitPrice={(price) => ...}   // price already checked: a number > 0
//    onCancel={() => ...}
//    asModal                          // own Modal (Quick Checkout); without it the
//                                     // sheet is an overlay inside the parent Modal
// />
// The parent guards against a double tap (it owns what "add" means).
import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, TextInput, ScrollView, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { bumpActivity } from '../../hooks/useIdleLock';
import { parseTypedPrice, formatRupees } from '../../utils/scanAddLine';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

const PRICE_ERROR = 'Type the price, more than ₹0.';

export default function SizeOrPriceSheet({ pending, onPickOption, onSubmitPrice, onCancel, asModal = false }) {
  const insets = useSafeAreaInsets();
  const [priceText, setPriceText] = useState('');
  const [priceError, setPriceError] = useState('');

  const productId = pending && pending.product ? pending.product.id : null;
  useEffect(() => {
    setPriceText('');
    setPriceError('');
  }, [productId, pending && pending.mode]);

  const submitPrice = () => {
    if (!pending) return;
    const price = parseTypedPrice(priceText);
    if (price == null) { setPriceError(PRICE_ERROR); return; }
    onSubmitPrice(price);
  };

  const sheet = pending ? (
    <KeyboardAvoidingView
      style={styles.sheetOverlay}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, Spacing.lg) }]}>
        <Text style={styles.sheetTitle}>{pending.product.name}</Text>

        {pending.mode === 'size' ? (
          <>
            <Text style={styles.sheetSub}>Which size?</Text>
            <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: Spacing.sm }}>
              {pending.product.options.map((o) => (
                <TouchableOpacity
                  key={o.id}
                  style={styles.sizeBtn}
                  onPress={() => onPickOption(o)}
                  accessibilityRole="button"
                  accessibilityLabel={`${o.label}, ${formatRupees(o.price)}`}
                >
                  <Text style={styles.sizeLabel}>{o.label}</Text>
                  <Text style={styles.sizePrice}>{formatRupees(o.price)}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </>
        ) : (
          <>
            <Text style={styles.sheetSub}>Type the price</Text>
            {pending.product.price_hint ? (
              <Text style={styles.hint}>{pending.product.price_hint}</Text>
            ) : null}
            <Text style={styles.inputLabel}>Price (₹)</Text>
            <TextInput
              style={[styles.priceInput, priceError ? styles.priceInputError : null]}
              value={priceText}
              onChangeText={(t) => { setPriceText(t); if (priceError) setPriceError(''); }}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={Colors.textLight}
              autoFocus
              onSubmitEditing={submitPrice}
              returnKeyType="done"
              accessibilityLabel="Price in rupees"
            />
            {priceError ? <Text style={styles.errorText}>{priceError}</Text> : null}
            <TouchableOpacity
              style={styles.addBtn}
              onPress={submitPrice}
              accessibilityRole="button"
              accessibilityLabel="Add to order"
            >
              <Ionicons name="add-circle" size={24} color={Colors.white} />
              <Text style={styles.addText}>Add to order</Text>
            </TouchableOpacity>
          </>
        )}

        <TouchableOpacity
          style={styles.cancelBtn}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Cancel, add nothing"
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  ) : null;

  if (!asModal) return sheet;
  return (
    <Modal visible={!!pending} transparent animationType="slide" onRequestClose={onCancel}>
      {/* onTouchStart: RN Modal mounts into its own root, so the idle lock
          needs to be told about touches here. */}
      <View style={{ flex: 1 }} onTouchStart={bumpActivity}>{sheet}</View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheetOverlay: {
    ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.xl, borderTopRightRadius: BorderRadius.xl,
    padding: Spacing.lg, width: '100%', maxWidth: 640, alignSelf: 'center',
  },
  sheetTitle: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  sheetSub: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textSecondary, marginTop: Spacing.xs, marginBottom: Spacing.md },
  sizeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    minHeight: 64, paddingHorizontal: Spacing.lg, borderRadius: BorderRadius.md,
    backgroundColor: Colors.primaryGlow, borderWidth: 2, borderColor: Colors.primary,
  },
  sizeLabel: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, flexShrink: 1 },
  sizePrice: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.primaryDark, fontVariant: ['tabular-nums'], marginLeft: Spacing.md },
  hint: {
    fontSize: FontSize.md, color: Colors.text, backgroundColor: Colors.warningLight,
    borderRadius: BorderRadius.sm, padding: Spacing.sm, marginBottom: Spacing.sm,
  },
  inputLabel: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginBottom: Spacing.xs },
  priceInput: {
    minHeight: 56, borderWidth: 2, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, fontSize: FontSize.xl, fontWeight: '700', color: Colors.text,
    backgroundColor: Colors.background, fontVariant: ['tabular-nums'],
  },
  priceInputError: { borderColor: Colors.error },
  errorText: { color: Colors.error, fontSize: FontSize.md, fontWeight: '600', marginTop: Spacing.xs },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    minHeight: 56, borderRadius: BorderRadius.md, backgroundColor: Colors.primary, marginTop: Spacing.md,
  },
  addText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '700' },
  cancelBtn: {
    minHeight: 56, alignItems: 'center', justifyContent: 'center', marginTop: Spacing.sm,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
  },
  cancelText: { color: Colors.textSecondary, fontSize: FontSize.lg, fontWeight: '600' },
});
