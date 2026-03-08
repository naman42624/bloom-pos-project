import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, Image, TouchableOpacity, Alert,
  ActivityIndicator, Share, Platform, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function QRLabelScreen({ route }) {
  const { productId } = route.params;
  const [qrData, setQrData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.getProductQR(productId, 400);
        setQrData(res.data);
      } catch (err) {
        Alert.alert('Error', err.message || 'Failed to generate QR code');
      } finally {
        setLoading(false);
      }
    })();
  }, [productId]);

  const handleShare = async () => {
    if (!qrData) return;
    try {
      await Share.share({
        message: `${qrData.product.name}\nSKU: ${qrData.product.sku}\nPrice: ₹${(qrData.product.selling_price || 0).toFixed(2)}`,
        title: `QR Label — ${qrData.product.name}`,
      });
    } catch {}
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={styles.loadingText}>Generating QR code...</Text>
      </View>
    );
  }

  if (!qrData) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={48} color={Colors.error} />
        <Text style={styles.errorText}>Failed to load QR data</Text>
      </View>
    );
  }

  const { product, qr_data_url } = qrData;

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      {/* Label preview */}
      <View style={styles.labelCard}>
        <Text style={styles.shopName}>BloomCart</Text>

        <View style={styles.qrContainer}>
          <Image
            source={{ uri: qr_data_url }}
            style={styles.qrImage}
            resizeMode="contain"
          />
        </View>

        <Text style={styles.productName}>{product.name}</Text>
        <Text style={styles.productSku}>SKU: {product.sku}</Text>
        <Text style={styles.productPrice}>₹{(product.selling_price || 0).toFixed(2)}</Text>
      </View>

      {/* Info */}
      <Text style={styles.hintText}>
        Scan this QR code with the BloomCart app to quickly look up product details.
      </Text>

      {/* Actions */}
      <View style={styles.actionsRow}>
        <TouchableOpacity style={styles.actionBtn} onPress={handleShare}>
          <Ionicons name="share-outline" size={22} color={Colors.primary} />
          <Text style={styles.actionText}>Share</Text>
        </TouchableOpacity>

        {Platform.OS === 'web' && (
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => {
              const link = document.createElement('a');
              link.href = qr_data_url;
              link.download = `QR-${product.sku}.png`;
              link.click();
            }}
          >
            <Ionicons name="download-outline" size={22} color={Colors.info} />
            <Text style={styles.actionText}>Download</Text>
          </TouchableOpacity>
        )}

        {Platform.OS === 'web' && (
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => {
              const printWin = window.open('', '_blank');
              if (!printWin) return;
              printWin.document.write(`
                <html><head><title>QR Label</title>
                <style>body{font-family:sans-serif;text-align:center;padding:20px}
                .name{font-size:18px;font-weight:bold;margin:8px 0 4px}
                .sku{color:#666;font-size:12px} .price{font-size:20px;font-weight:bold;margin-top:8px;color:#4CAF50}</style>
                </head><body>
                <p style="font-size:14px;color:#E91E63;font-weight:bold">BloomCart</p>
                <img src="${qr_data_url}" width="250" height="250"/>
                <p class="name">${product.name}</p>
                <p class="sku">SKU: ${product.sku}</p>
                <p class="price">₹${(product.selling_price || 0).toFixed(2)}</p>
                </body></html>
              `);
              printWin.document.close();
              printWin.focus();
              printWin.print();
            }}
          >
            <Ionicons name="print-outline" size={22} color={Colors.secondary} />
            <Text style={styles.actionText}>Print</Text>
          </TouchableOpacity>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background },
  loadingText: { color: Colors.textSecondary, marginTop: Spacing.md, fontSize: FontSize.sm },
  errorText: { color: Colors.error, marginTop: Spacing.md, fontSize: FontSize.md },

  scrollContent: { padding: Spacing.lg, alignItems: 'center', paddingBottom: 60 },

  labelCard: {
    backgroundColor: Colors.white || '#FFFFFF', borderRadius: BorderRadius.lg,
    padding: Spacing.xl, alignItems: 'center', width: '100%', maxWidth: 340,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 4,
    borderWidth: 1, borderColor: Colors.border,
  },
  shopName: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.primary, letterSpacing: 1, marginBottom: Spacing.md },
  qrContainer: { padding: Spacing.sm, backgroundColor: '#FFFFFF', borderRadius: BorderRadius.md },
  qrImage: { width: 250, height: 250 },
  productName: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginTop: Spacing.md, textAlign: 'center' },
  productSku: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  productPrice: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.success, marginTop: Spacing.sm },

  hintText: {
    fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center',
    marginTop: Spacing.lg, lineHeight: 20, maxWidth: 300,
  },

  actionsRow: { flexDirection: 'row', gap: Spacing.lg, marginTop: Spacing.xl },
  actionBtn: { alignItems: 'center', gap: Spacing.xs },
  actionText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500' },
});
