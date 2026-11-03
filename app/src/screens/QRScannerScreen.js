import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import ProductScanner from '../components/scan/ProductScanner';
import { SCANNER_COPY } from '../components/scan/scanCooldown';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

// Works on web (browser camera) and in the native app. The scanner component
// handles the camera, permission and the same-code cooldown; this screen only
// decides what a scanned code means.
export default function QRScannerScreen({ navigation, route }) {
  const fromPOS = route.params?.fromPOS || false;
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);

  const handleCode = async (data) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setProcessing(true);
    setError('');

    try {
      const res = await api.scanProductQR(data);
      if (res.success && res.data) {
        if (fromPOS) {
          // Scan is selling-only; re-read the full product so tax, sku and stock match the cart
          const full = await api.getProduct(res.data.id);
          if (!full || !full.success || !full.data) throw new Error('Could not load this product. Please try again.');
          navigation.navigate('POSHome', { scannedProduct: full.data });
        } else {
          navigation.replace('ProductDetail', { productId: res.data.id });
        }
      } else {
        setError(res.message || 'No product matched this QR code');
      }
    } catch (err) {
      setError(err.message || 'Could not read this code. Please try again.');
    } finally {
      busyRef.current = false;
      setProcessing(false);
    }
  };

  return (
    <View style={styles.container}>
      <ProductScanner onCode={handleCode} paused={processing}>
        <View style={styles.bottom} pointerEvents="none">
          {processing ? (
            <View style={styles.pill}>
              <ActivityIndicator color={Colors.white} />
              <Text style={styles.pillText}>Looking up product{'…'}</Text>
            </View>
          ) : error ? (
            <View style={[styles.pill, styles.errorPill]} accessibilityLiveRegion="assertive">
              <Ionicons name="alert-circle" size={24} color={Colors.warning} />
              <Text style={styles.pillText}>{error}</Text>
            </View>
          ) : (
            <View style={styles.pill}>
              <Ionicons name="qr-code-outline" size={24} color={Colors.white} />
              <Text style={styles.pillText}>{SCANNER_COPY.hint}</Text>
            </View>
          )}
        </View>
      </ProductScanner>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.black },
  bottom: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    padding: Spacing.md, paddingBottom: Spacing.xl, alignItems: 'center',
  },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md, maxWidth: 520,
  },
  errorPill: { backgroundColor: 'rgba(0,0,0,0.85)', borderWidth: 2, borderColor: Colors.warning },
  pillText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '600', flexShrink: 1 },
});
