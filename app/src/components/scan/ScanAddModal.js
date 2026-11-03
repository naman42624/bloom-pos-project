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
  View, Text, StyleSheet, Modal, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ProductScanner from './ProductScanner';
import { SCANNER_COPY } from './scanCooldown';
import api from '../../services/api';
import { bumpActivity } from '../../hooks/useIdleLock';
import { sheetModeFor } from '../../utils/scanAddLine';
import SizeOrPriceSheet from './SizeOrPriceSheet';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

const LOOKUP_FAILED = 'Could not look up this item. Check the connection and scan it again.';

export default function ScanAddModal({ visible, onClose, locationId, onAdd, onFindByName }) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { kind: 'ok' | 'error', text }
  const [pending, setPending] = useState(null); // { product, mode: 'size' | 'price' }
  const busyRef = useRef(false);
  // A second tap on a size / "Add to order" before the sheet re-renders away
  // must not add the item twice.
  const committingRef = useRef(false);

  useEffect(() => {
    if (visible) {
      setMessage(null);
      setPending(null);
    }
  }, [visible]);

  const commit = async (product, { option = null, price = null } = {}) => {
    if (committingRef.current) return;
    committingRef.current = true;
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
      committingRef.current = false;
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
      next = { product, mode: sheetModeFor(product) || 'add' };
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
      setPending(next);
    }
  };

  const cancelPending = () => {
    setPending(null);
    setMessage({ kind: 'ok', text: 'Nothing added. Scan the next item.' });
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

        <SizeOrPriceSheet
          pending={pending}
          onPickOption={(o) => commit(pending.product, { option: o })}
          onSubmitPrice={(price) => { if (!committingRef.current && pending) commit(pending.product, { price }); }}
          onCancel={cancelPending}
        />
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
});
