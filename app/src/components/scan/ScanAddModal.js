// Scan-to-add for Quick Checkout (Full order).
//
// <ScanAddModal visible onClose locationId onAdd onFindByName />
//   - keeps the camera open so several items can be scanned one after another
//   - a product with sizes asks "Which size?" (one big button per size, Cancel adds nothing)
//   - a "type the price" product asks for the price (must be more than ₹0)
//   - onAdd({ product, option, price }) is the parent's job (it loads the full
//     product and puts the line in the order); it returns the line to show,
//     e.g. "Added Rose", or throws { message }
//   - errors from the scan (unknown code, switched off, one-off sold) show here,
//     in the modal, and scanning carries on
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, TextInput, ActivityIndicator, ScrollView,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ProductScanner from './ProductScanner';
import { SCANNER_COPY } from './scanCooldown';
import api from '../../services/api';
import { bumpActivity } from '../../hooks/useIdleLock';
import { parseTypedPrice, formatRupees } from '../../utils/scanAddLine';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

const PRICE_ERROR = 'Type the price, more than ₹0.';
const LOOKUP_FAILED = 'Could not look up this item. Check the connection and scan it again.';

export default function ScanAddModal({ visible, onClose, locationId, onAdd, onFindByName }) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { kind: 'ok' | 'error', text }
  const [pending, setPending] = useState(null); // { product, mode: 'size' | 'price' }
  const [priceText, setPriceText] = useState('');
  const [priceError, setPriceError] = useState('');
  const busyRef = useRef(false);

  useEffect(() => {
    if (visible) {
      setMessage(null);
      setPending(null);
      setPriceText('');
      setPriceError('');
    }
  }, [visible]);

  const commit = async (product, { option = null, price = null } = {}) => {
    busyRef.current = true;
    setBusy(true);
    setPending(null);
    try {
      const text = await onAdd({ product, option, price });
      setMessage({ kind: 'ok', text: text || `Added ${product.name}` });
    } catch (err) {
      setMessage({ kind: 'error', text: (err && err.message) || LOOKUP_FAILED });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleCode = async (raw) => {
    if (busyRef.current || pending) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    let next = null;
    try {
      const res = await api.scanProductQR(raw, locationId || undefined);
      const product = res && res.data;
      if (!product) throw new Error(LOOKUP_FAILED);
      if (Array.isArray(product.options) && product.options.length > 0) {
        next = { product, mode: 'size' };
      } else if (product.price_mode === 'open') {
        next = { product, mode: 'price' };
      } else {
        next = { product, mode: 'add' };
      }
    } catch (err) {
      setMessage({ kind: 'error', text: (err && err.message) || LOOKUP_FAILED });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    if (!next) return;
    if (next.mode === 'add') {
      await commit(next.product);
    } else {
      setPriceText('');
      setPriceError('');
      setPending(next);
    }
  };

  const cancelPending = () => {
    setPending(null);
    setPriceError('');
    setMessage({ kind: 'ok', text: 'Nothing added. Scan the next item.' });
  };

  const submitPrice = () => {
    const price = parseTypedPrice(priceText);
    if (price == null) { setPriceError(PRICE_ERROR); return; }
    commit(pending.product, { price });
  };

  const paused = !visible || busy || !!pending;

  let pill;
  if (busy) {
    pill = (
      <View style={styles.pill}>
        <ActivityIndicator color={Colors.white} />
        <Text style={styles.pillText}>Looking up the item{'…'}</Text>
      </View>
    );
  } else if (message) {
    const isError = message.kind === 'error';
    pill = (
      <View style={[styles.pill, isError ? styles.pillError : styles.pillOk]} accessibilityLiveRegion={isError ? 'assertive' : 'polite'}>
        <Ionicons name={isError ? 'alert-circle' : 'checkmark-circle'} size={24} color={isError ? Colors.warning : Colors.success} />
        <Text style={styles.pillText}>{message.text}</Text>
      </View>
    );
  } else {
    pill = (
      <View style={styles.pill}>
        <Ionicons name="qr-code-outline" size={24} color={Colors.white} />
        <Text style={styles.pillText}>{SCANNER_COPY.hint}</Text>
      </View>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {/* onTouchStart: RN Modal mounts into its own root, so the idle lock
          needs to be told about touches here. */}
      <View style={styles.root} onTouchStart={bumpActivity}>
        <View style={[styles.header, { paddingTop: Math.max(insets.top, Spacing.sm) }]}>
          <Text style={styles.title}>Scan items</Text>
          <TouchableOpacity
            style={styles.doneBtn}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Done scanning"
          >
            <Ionicons name="checkmark" size={24} color={Colors.white} />
            <Text style={styles.doneText}>Done</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.cameraArea}>
          {visible ? (
            <ProductScanner onCode={handleCode} paused={paused}>
              <View style={styles.pillWrap} pointerEvents="none">{pill}</View>
            </ProductScanner>
          ) : null}
        </View>

        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, Spacing.md) }]}>
          <TouchableOpacity
            style={styles.findBtn}
            onPress={onFindByName}
            accessibilityRole="button"
            accessibilityLabel="Find the item by name instead"
          >
            <Ionicons name="search" size={22} color={Colors.primary} />
            <Text style={styles.findText}>Find by name</Text>
          </TouchableOpacity>
        </View>

        {pending ? (
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
                        onPress={() => commit(pending.product, { option: o })}
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
                onPress={cancelPending}
                accessibilityRole="button"
                accessibilityLabel="Cancel, add nothing"
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.black },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingBottom: Spacing.sm, backgroundColor: Colors.black,
  },
  title: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '700' },
  doneBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs,
    backgroundColor: Colors.primary, borderRadius: BorderRadius.md,
    minHeight: 48, paddingHorizontal: Spacing.lg,
  },
  doneText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '700' },
  cameraArea: { flex: 1 },
  pillWrap: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    padding: Spacing.md, alignItems: 'center',
  },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.75)', borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md, maxWidth: 520,
  },
  pillOk: { borderWidth: 2, borderColor: Colors.success },
  pillError: { backgroundColor: 'rgba(0,0,0,0.85)', borderWidth: 2, borderColor: Colors.warning },
  pillText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '600', flexShrink: 1 },
  footer: { backgroundColor: Colors.surface, paddingHorizontal: Spacing.md, paddingTop: Spacing.md },
  findBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    minHeight: 56, borderRadius: BorderRadius.md, borderWidth: 2, borderColor: Colors.primary,
    backgroundColor: Colors.surface,
  },
  findText: { color: Colors.primary, fontSize: FontSize.md, fontWeight: '700' },
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
