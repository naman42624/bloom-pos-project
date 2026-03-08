import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Platform, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const STATUS_COLORS = {
  completed: Colors.success,
  cancelled: Colors.error,
  draft: Colors.warning,
};

const PAYMENT_STATUS_COLORS = {
  paid: Colors.success,
  partial: Colors.warning,
  pending: Colors.error,
  refunded: Colors.textLight,
};

export default function SaleDetailScreen({ route, navigation }) {
  const { saleId } = route.params;
  const { user } = useAuth();
  const [sale, setSale] = useState(null);
  const [loading, setLoading] = useState(true);

  const canManage = user?.role === 'owner' || user?.role === 'manager';

  useEffect(() => { fetchSale(); }, [saleId]);

  const fetchSale = async () => {
    try {
      const res = await api.getSale(saleId);
      setSale(res.data);
    } catch {} finally { setLoading(false); }
  };

  const handleCancel = () => {
    const doCancel = async () => {
      try {
        await api.cancelSale(saleId);
        fetchSale();
        Alert.alert('Cancelled', 'Sale has been cancelled');
      } catch (err) {
        Alert.alert('Error', err.message || 'Failed to cancel');
      }
    };
    if (Platform.OS === 'web') {
      if (window.confirm('Cancel this sale?')) doCancel();
    } else {
      Alert.alert('Cancel Sale', 'Are you sure?', [
        { text: 'No', style: 'cancel' },
        { text: 'Yes, cancel', style: 'destructive', onPress: doCancel },
      ]);
    }
  };

  const handleRefund = () => {
    navigation.navigate('RefundSale', { saleId, grandTotal: sale.grand_total });
  };

  const generateReceipt = async () => {
    const paidAmt = (sale.payments || []).reduce((s, p) => s + p.amount, 0);
    const dueAmt = sale.grand_total - paidAmt;
    const html = `
      <html><head><meta charset="utf-8"><style>
        body { font-family: 'Courier New', monospace; max-width: 300px; margin: 0 auto; padding: 16px; font-size: 12px; }
        .center { text-align: center; }
        .bold { font-weight: bold; }
        .line { border-top: 1px dashed #333; margin: 8px 0; }
        .row { display: flex; justify-content: space-between; }
        .total-row { display: flex; justify-content: space-between; font-weight: bold; font-size: 14px; margin: 4px 0; }
        h2 { margin: 4px 0; }
        p { margin: 2px 0; }
      </style></head><body>
        <div class="center">
          <h2>BloomCart POS</h2>
          <p>${sale.location_name || ''}</p>
          <p>Invoice: <strong>${sale.sale_number}</strong></p>
          <p>${new Date(sale.created_at).toLocaleString()}</p>
        </div>
        ${sale.customer_name ? `<p>Customer: ${sale.customer_name}</p>` : ''}
        ${sale.customer_phone ? `<p>Phone: ${sale.customer_phone}</p>` : ''}
        <div class="line"></div>
        ${(sale.items || []).map(item => `
          <div>
            <p>${item.product_name}</p>
            <div class="row">
              <span>${item.quantity} x ₹${(item.unit_price || 0).toFixed(2)}</span>
              <span>₹${(item.line_total || 0).toFixed(2)}</span>
            </div>
          </div>
        `).join('')}
        <div class="line"></div>
        <div class="row"><span>Subtotal</span><span>₹${(sale.subtotal || 0).toFixed(2)}</span></div>
        <div class="row"><span>Tax</span><span>₹${(sale.tax_total || 0).toFixed(2)}</span></div>
        ${sale.discount_amount > 0 ? `<div class="row"><span>Discount</span><span>-₹${sale.discount_amount.toFixed(2)}</span></div>` : ''}
        ${sale.delivery_charges > 0 ? `<div class="row"><span>Delivery</span><span>₹${sale.delivery_charges.toFixed(2)}</span></div>` : ''}
        <div class="line"></div>
        <div class="total-row"><span>TOTAL</span><span>₹${(sale.grand_total || 0).toFixed(2)}</span></div>
        <div class="line"></div>
        ${(sale.payments || []).map(p => `
          <div class="row"><span>${(p.method || '').toUpperCase()}</span><span>₹${(p.amount || 0).toFixed(2)}</span></div>
        `).join('')}
        ${dueAmt > 0.01 ? `<div class="row bold"><span>BALANCE DUE</span><span>₹${dueAmt.toFixed(2)}</span></div>` : ''}
        <div class="line"></div>
        <div class="center"><p>Thank you for your purchase!</p></div>
      </body></html>
    `;
    try {
      const { uri } = await Print.printToFileAsync({ html, width: 300 });
      if (Platform.OS === 'web') {
        await Print.printAsync({ html });
      } else {
        await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: `Receipt ${sale.sale_number}` });
      }
    } catch (err) {
      Alert.alert('Error', 'Could not generate receipt');
    }
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={Colors.primary} size="large" /></View>;
  }
  if (!sale) {
    return <View style={styles.center}><Text style={styles.emptyText}>Sale not found</Text></View>;
  }

  const paidAmount = (sale.payments || []).reduce((s, p) => s + p.amount, 0);
  const due = sale.grand_total - paidAmount;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header card */}
      <View style={styles.headerCard}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.saleNumber}>{sale.sale_number}</Text>
            <Text style={styles.saleDate}>{new Date(sale.created_at).toLocaleString()}</Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: (STATUS_COLORS[sale.status] || Colors.textLight) + '20' }]}>
            <Text style={[styles.statusText, { color: STATUS_COLORS[sale.status] || Colors.textLight }]}>
              {sale.status?.toUpperCase()}
            </Text>
          </View>
        </View>

        <View style={styles.headerRow}>
          <View style={styles.metaItem}>
            <Ionicons name="location" size={14} color={Colors.textSecondary} />
            <Text style={styles.metaText}>{sale.location_name || 'N/A'}</Text>
          </View>
          <View style={styles.metaItem}>
            <Ionicons name="person" size={14} color={Colors.textSecondary} />
            <Text style={styles.metaText}>{sale.created_by_name}</Text>
          </View>
        </View>

        <View style={styles.headerRow}>
          <View style={[styles.typeBadge]}>
            <Text style={styles.typeText}>{(sale.order_type || '').replace('_', ' ').toUpperCase()}</Text>
          </View>
          <View style={[styles.payBadge, { backgroundColor: (PAYMENT_STATUS_COLORS[sale.payment_status] || Colors.textLight) + '20' }]}>
            <Text style={[styles.payBadgeText, { color: PAYMENT_STATUS_COLORS[sale.payment_status] }]}>
              {(sale.payment_status || '').toUpperCase()}
            </Text>
          </View>
        </View>
      </View>

      {/* Customer info */}
      {(sale.customer_name || sale.customer_phone || sale.customer_display_name) && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Customer</Text>
          <Text style={styles.infoText}>{sale.customer_name || sale.customer_display_name}</Text>
          {(sale.customer_phone || sale.customer_display_phone) && (
            <Text style={styles.infoSubtext}>{sale.customer_phone || sale.customer_display_phone}</Text>
          )}
        </View>
      )}

      {/* Items */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Items ({(sale.items || []).length})</Text>
        {(sale.items || []).map((item, idx) => (
          <View key={idx} style={styles.itemRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.itemName}>{item.product_name}</Text>
              <Text style={styles.itemMeta}>
                {item.quantity} × ₹{(item.unit_price || 0).toFixed(2)}
                {item.tax_rate > 0 ? ` (${item.tax_rate}% tax)` : ''}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.itemTotal}>₹{(item.line_total || 0).toFixed(2)}</Text>
              {item.tax_amount > 0 && <Text style={styles.itemTax}>incl. ₹{item.tax_amount.toFixed(2)} tax</Text>}
            </View>
          </View>
        ))}
      </View>

      {/* Totals */}
      <View style={styles.totalsBox}>
        <View style={styles.totalRow}><Text style={styles.totalLabel}>Subtotal</Text><Text style={styles.totalVal}>₹{(sale.subtotal || 0).toFixed(2)}</Text></View>
        <View style={styles.totalRow}><Text style={styles.totalLabel}>Tax</Text><Text style={styles.totalVal}>₹{(sale.tax_total || 0).toFixed(2)}</Text></View>
        {sale.discount_amount > 0 && (
          <View style={styles.totalRow}>
            <Text style={[styles.totalLabel, { color: Colors.error }]}>Discount{sale.discount_type === 'percentage' ? ` (${sale.discount_percentage}%)` : ''}</Text>
            <Text style={[styles.totalVal, { color: Colors.error }]}>-₹{sale.discount_amount.toFixed(2)}</Text>
          </View>
        )}
        {sale.delivery_charges > 0 && (
          <View style={styles.totalRow}><Text style={styles.totalLabel}>Delivery</Text><Text style={styles.totalVal}>₹{sale.delivery_charges.toFixed(2)}</Text></View>
        )}
        <View style={styles.divider} />
        <View style={styles.totalRow}>
          <Text style={styles.grandLabel}>Grand Total</Text>
          <Text style={styles.grandVal}>₹{(sale.grand_total || 0).toFixed(2)}</Text>
        </View>
      </View>

      {/* Payments */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Payments</Text>
        {(sale.payments || []).map((p, idx) => (
          <View key={idx} style={styles.paymentRow}>
            <Ionicons name={p.method === 'cash' ? 'cash' : p.method === 'card' ? 'card' : 'phone-portrait'} size={18} color={Colors.primary} />
            <View style={{ flex: 1, marginLeft: Spacing.sm }}>
              <Text style={styles.payMethod}>{p.method?.toUpperCase()}</Text>
              {p.reference_number ? <Text style={styles.payRef}>Ref: {p.reference_number}</Text> : null}
            </View>
            <Text style={styles.payAmount}>₹{(p.amount || 0).toFixed(2)}</Text>
          </View>
        ))}
        {due > 0.01 && (
          <View style={[styles.paymentRow, { backgroundColor: Colors.warningLight }]}>
            <Ionicons name="alert-circle" size={18} color={Colors.warning} />
            <Text style={[styles.payMethod, { marginLeft: Spacing.sm, color: Colors.warning }]}>Balance Due</Text>
            <Text style={[styles.payAmount, { color: Colors.warning }]}>₹{due.toFixed(2)}</Text>
          </View>
        )}
      </View>

      {/* Pre-order info */}
      {sale.pre_order && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pre-order Details</Text>
          <Text style={styles.infoText}>Scheduled: {sale.pre_order.scheduled_date} {sale.pre_order.scheduled_time || ''}</Text>
          <Text style={styles.infoSubtext}>Advance: ₹{(sale.pre_order.advance_amount || 0).toFixed(2)} | Remaining: ₹{(sale.pre_order.remaining_amount || 0).toFixed(2)}</Text>
          {sale.pre_order.delivery_address && <Text style={styles.infoSubtext}>Address: {sale.pre_order.delivery_address}</Text>}
          <View style={[styles.statusBadge, { backgroundColor: sale.pre_order.status === 'delivered' ? Colors.successLight : Colors.warningLight, alignSelf: 'flex-start', marginTop: Spacing.xs }]}>
            <Text style={{ fontSize: FontSize.xs, fontWeight: '600', color: sale.pre_order.status === 'delivered' ? Colors.success : Colors.warning }}>
              {(sale.pre_order.status || 'pending').toUpperCase()}
            </Text>
          </View>
        </View>
      )}

      {/* Refund info */}
      {sale.refund && (
        <View style={[styles.section, { borderColor: Colors.error, borderWidth: 1 }]}>
          <Text style={[styles.sectionTitle, { color: Colors.error }]}>Refund</Text>
          <Text style={styles.infoText}>Amount: ₹{(sale.refund.amount || 0).toFixed(2)} via {sale.refund.refund_method}</Text>
          <Text style={styles.infoSubtext}>Reason: {sale.refund.reason}</Text>
        </View>
      )}

      {/* Notes */}
      {sale.notes && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Notes</Text>
          <Text style={styles.infoText}>{sale.notes}</Text>
        </View>
      )}

      {/* Receipt button */}
      <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.primary, alignSelf: 'stretch', marginHorizontal: 0, marginTop: Spacing.md }]} onPress={generateReceipt}>
        <Ionicons name="receipt" size={18} color={Colors.white} />
        <Text style={styles.actionBtnText}>Share Receipt / PDF</Text>
      </TouchableOpacity>

      {/* Actions */}
      {canManage && sale.status === 'completed' && (
        <View style={styles.actions}>
          {!sale.refund && (
            <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.warning }]} onPress={handleRefund}>
              <Ionicons name="return-down-back" size={18} color={Colors.white} />
              <Text style={styles.actionBtnText}>Refund</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.error }]} onPress={handleCancel}>
            <Ionicons name="close-circle" size={18} color={Colors.white} />
            <Text style={styles.actionBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Pay balance */}
      {sale.status === 'completed' && due > 0.01 && (
        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: Colors.success, alignSelf: 'stretch', marginHorizontal: 0 }]}
          onPress={() => navigation.navigate('AddPayment', { saleId, due })}
        >
          <Ionicons name="cash" size={18} color={Colors.white} />
          <Text style={styles.actionBtnText}>Record Payment</Text>
        </TouchableOpacity>
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background },
  emptyText: { color: Colors.textLight, fontSize: FontSize.sm },

  headerCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.md, gap: Spacing.sm,
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  saleNumber: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  saleDate: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  statusBadge: { paddingHorizontal: Spacing.sm, paddingVertical: 2, borderRadius: BorderRadius.full },
  statusText: { fontSize: FontSize.xs, fontWeight: '700' },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  typeBadge: {
    paddingHorizontal: Spacing.sm, paddingVertical: 2, borderRadius: BorderRadius.full,
    backgroundColor: Colors.primary + '15',
  },
  typeText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.primary },
  payBadge: { paddingHorizontal: Spacing.sm, paddingVertical: 2, borderRadius: BorderRadius.full },
  payBadgeText: { fontSize: FontSize.xs, fontWeight: '700' },

  section: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.md, marginTop: Spacing.md,
  },
  sectionTitle: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  infoText: { fontSize: FontSize.sm, color: Colors.text },
  infoSubtext: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },

  itemRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: Spacing.xs, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  itemName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  itemMeta: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 1 },
  itemTotal: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  itemTax: { fontSize: FontSize.xs, color: Colors.textLight },

  totalsBox: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.md, marginTop: Spacing.md,
  },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  totalLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  totalVal: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '500' },
  divider: { height: 1, backgroundColor: Colors.border, marginVertical: Spacing.sm },
  grandLabel: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  grandVal: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.primary },

  paymentRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.sm, borderRadius: BorderRadius.sm,
    marginBottom: Spacing.xs, backgroundColor: Colors.background,
  },
  payMethod: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  payRef: { fontSize: FontSize.xs, color: Colors.textLight },
  payAmount: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },

  actions: {
    flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md,
  },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    paddingVertical: Spacing.sm, borderRadius: BorderRadius.md,
  },
  actionBtnText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.sm },
});
