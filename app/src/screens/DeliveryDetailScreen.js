import React, { useState, useCallback, useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import DeliveryActionsPanel from '../components/delivery/DeliveryActionsPanel';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { showAlert, showConfirm } from '../utils/alert';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { parseServerDate, formatDate, formatDateTime } from '../utils/datetime';

const STATUS_STEPS = ['pending', 'assigned', 'picked_up', 'in_transit', 'delivered'];
const STATUS_LABELS = { pending: 'Pending', assigned: 'Assigned', picked_up: 'Picked Up', in_transit: 'In Transit', delivered: 'Delivered', failed: 'Failed', cancelled: 'Cancelled' };
const STATUS_ICONS = { pending: 'time-outline', assigned: 'person-add-outline', picked_up: 'cube-outline', in_transit: 'bicycle-outline', delivered: 'checkmark-circle-outline', failed: 'close-circle-outline', cancelled: 'ban-outline' };
const STATUS_COLORS = { pending: '#FF9800', assigned: '#2196F3', picked_up: '#9C27B0', in_transit: '#00BCD4', delivered: '#4CAF50', failed: '#F44336', cancelled: '#9E9E9E' };

/** Format a scheduled_date (ISO or YYYY-MM-DD) + time into readable string */
function formatScheduled(dateStr, timeStr) {
  if (!dateStr) return '';
  try {
    let localDate = dateStr;
    if (dateStr.includes('T') || dateStr.includes('Z') || dateStr.includes('+')) {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) localDate = d.toLocaleDateString('en-CA');
    }
    const [, month, day] = localDate.split('-').map(Number);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const datePart = `${day} ${months[month - 1]}`;
    if (!timeStr) return datePart;
    const [hh, mm] = String(timeStr).split(':').map(Number);
    const ampm = hh >= 12 ? 'PM' : 'AM';
    return `${datePart}, ${hh % 12 || 12}:${String(mm || 0).padStart(2, '0')} ${ampm}`;
  } catch { return dateStr; }
}

export default function DeliveryDetailScreen({ route, navigation }) {
  const { deliveryId } = route.params;
  const { user } = useAuth();
  const [delivery, setDelivery] = useState(null);
  const [loading, setLoading] = useState(true);
  const [converting, setConverting] = useState(false);
  // Every delivery-lifecycle action lives in DeliveryActionsPanel (shared
  // with Sale Details). The ref lets this screen reload the panel too.
  const panelRef = useRef(null);
  // Full-screen spinner only on the very first load: a refetch after an
  // action must not unmount the panel (it would reload a second time).
  const hasLoaded = useRef(false);
  const guard = useSubmitGuard();

  const isPartner = user?.role === 'delivery_partner';
  const isManager = user?.role === 'owner' || user?.role === 'manager';
  // Fulfill-from-stock allows counter_staff server-side (always did).
  // Convert-to-Pickup stays isManager-only below — that backend route is
  // still owner/manager-only.
  const canManageDeliveries = isManager || user?.role === 'counter_staff';

  const fetchDelivery = useCallback(async () => {
    try {
      if (!hasLoaded.current) setLoading(true);
      const res = await api.getDelivery(deliveryId);
      setDelivery(res.data);
      hasLoaded.current = true;
    } catch (err) {
      console.error('Fetch delivery error:', err);
    } finally {
      setLoading(false);
    }
  }, [deliveryId]);

  useFocusEffect(useCallback(() => {
    fetchDelivery();
    panelRef.current?.refresh();
  }, [fetchDelivery]));

  const handleConvertToPickup = () => {
    const doConvert = async () => {
      try {
        setConverting(true);
        await api.convertOrderType(delivery.sale_id, { new_order_type: 'pickup', delivery_charges: 0 });
        showAlert('Done', 'Order converted to pickup');
        fetchDelivery();
        panelRef.current?.refresh();
      } catch (err) {
        showAlert('Error', err.message || 'Failed to convert');
      } finally {
        setConverting(false);
      }
    };
    showConfirm('Convert to Pickup', 'Convert this delivery order to a pickup order? The delivery will be cancelled.', guard(doConvert), { confirmLabel: 'Convert' });
  };

  const handleFulfillFromStock = (saleItemId, productName) => {
    const msg = `Use ready stock for "${productName}"? This will deduct from product inventory.`;
    const onConfirm = async () => {
      try {
        await api.fulfillFromStock(delivery.sale_id, saleItemId);
        fetchDelivery();
        showAlert('Done', `"${productName}" fulfilled from stock`);
      } catch (err) {
        showAlert('Error', err.message || 'Failed to fulfill from stock');
      }
    };

    showConfirm('Fulfill from Stock', msg, onConfirm, { confirmLabel: 'Fulfill' });
  };

  if (loading) return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;
  if (!delivery) return <View style={styles.center}><Text>Delivery not found</Text></View>;

  const stepIndex = STATUS_STEPS.indexOf(delivery.status);
  const isFinal = ['delivered', 'failed', 'cancelled'].includes(delivery.status);

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 100 }}>
      {/* Status Progress */}
      <View style={styles.section}>
        <View style={styles.progressRow}>
          {STATUS_STEPS.map((step, i) => {
            const active = i <= stepIndex && stepIndex >= 0;
            const isCurrent = delivery.status === step;
            const color = isFinal && delivery.status === 'failed' ? STATUS_COLORS.failed : active ? STATUS_COLORS[step] : '#ddd';
            return (
              <View key={step} style={styles.stepItem}>
                <View style={[styles.stepDot, { backgroundColor: active ? color : '#eee', borderColor: color }]}>
                  <Ionicons name={STATUS_ICONS[step]} size={16} color={active ? '#fff' : '#ccc'} />
                </View>
                {i < STATUS_STEPS.length - 1 && <View style={[styles.stepLine, { backgroundColor: i < stepIndex ? color : '#eee' }]} />}
                {isCurrent && <Text style={[styles.stepLabel, { color }]}>{STATUS_LABELS[step]}</Text>}
              </View>
            );
          })}
        </View>
        {delivery.status === 'failed' && (
          <View style={[styles.alert, { backgroundColor: '#FFEBEE' }]}>
            <Ionicons name="close-circle" size={20} color="#F44336" />
            <Text style={[styles.alertText, { color: '#C62828' }]}>Failed: {delivery.failure_reason}</Text>
          </View>
        )}
      </View>

      {/* Order Info */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Order Details</Text>
        <InfoRow icon="receipt-outline" label="Order #" value={delivery.sale_number} />
        <InfoRow icon="location-outline" label="Address" value={delivery.delivery_address} />
        {delivery.customer_name && <InfoRow icon="person-outline" label="Customer" value={`${delivery.customer_name} ${delivery.customer_phone ? '• ' + delivery.customer_phone : ''}`} />}
        {delivery.partner_name && <InfoRow icon="bicycle-outline" label="Partner" value={`${delivery.partner_name} ${delivery.partner_phone ? '• ' + delivery.partner_phone : ''}`} />}
        {delivery.scheduled_date && <InfoRow icon="calendar-outline" label="Scheduled" value={formatScheduled(delivery.scheduled_date, delivery.scheduled_time)} />}

        {/* Delivery Timeline */}
        {(delivery.assigned_at || delivery.pickup_time || delivery.delivered_time) && (
          <View style={styles.timeline}>
            <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, marginBottom: 6 }}>Timeline</Text>
            {delivery.created_at && (
              <View style={styles.timelineRow}>
                <Ionicons name="add-circle" size={16} color="#FF9800" />
                <Text style={styles.timelineText}>Created: {formatDateTime(delivery.created_at)}</Text>
              </View>
            )}
            {delivery.assigned_at && (
              <View style={styles.timelineRow}>
                <Ionicons name="person-add" size={16} color="#2196F3" />
                <Text style={styles.timelineText}>Assigned: {formatDateTime(delivery.assigned_at)}</Text>
              </View>
            )}
            {delivery.pickup_time && (
              <View style={styles.timelineRow}>
                <Ionicons name="cube" size={16} color="#9C27B0" />
                <Text style={styles.timelineText}>Picked Up: {formatDateTime(delivery.pickup_time)}</Text>
              </View>
            )}
            {delivery.delivered_time && (
              <View style={styles.timelineRow}>
                <Ionicons name="checkmark-circle" size={16} color="#4CAF50" />
                <Text style={styles.timelineText}>Delivered: {formatDateTime(delivery.delivered_time)}</Text>
              </View>
            )}
            {delivery.pickup_time && delivery.delivered_time && (
              <View style={[styles.timelineRow, { backgroundColor: '#E8F5E9', borderRadius: 6, padding: 6, marginTop: 4 }]}>
                <Ionicons name="timer" size={16} color={Colors.success} />
                <Text style={[styles.timelineText, { fontWeight: '700', color: Colors.success }]}>
                  Delivery Time: {(() => {
                    const deliveredAt = parseServerDate(delivery.delivered_time);
                    const pickupAt = parseServerDate(delivery.pickup_time);
                    const mins = deliveredAt && pickupAt ? Math.round((deliveredAt - pickupAt) / 60000) : 0;
                    return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
                  })()}
                </Text>
              </View>
            )}
          </View>
        )}
        {delivery.delivery_notes && <InfoRow icon="chatbox-outline" label="Notes" value={delivery.delivery_notes} />}
        {delivery.sender_name ? <InfoRow icon="gift-outline" label="Sender" value={`${delivery.sender_name}${delivery.sender_phone ? ' • ' + delivery.sender_phone : ''}`} /> : null}
        {delivery.sender_message ? <InfoRow icon="mail-outline" label="Message" value={delivery.sender_message} /> : null}
        {/* View Sale Details + Convert + Challan */}
        {isManager && (
          <View style={{ flexDirection: 'row', marginTop: 12, gap: 10, flexWrap: 'wrap' }}>
            <TouchableOpacity
              style={styles.saleDetailBtn}
              onPress={() => navigation.navigate('SaleDetail', { saleId: delivery.sale_id })}
            >
              <Ionicons name="document-text-outline" size={16} color={Colors.primary} />
              <Text style={styles.saleDetailBtnText}>Sale Details</Text>
            </TouchableOpacity>
            {!isFinal && (
              <TouchableOpacity style={styles.convertPickupBtn} onPress={handleConvertToPickup} disabled={converting}>
                <Ionicons name="swap-horizontal" size={14} color={Colors.primary} />
                <Text style={styles.saleDetailBtnText}>Convert to Pickup</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>

      {/* Items */}
      {delivery.items?.length > 0 && (
        <View style={styles.section}>
          <View style={styles.itemsSectionHeader}>
            <Text style={styles.sectionTitle}>Items ({delivery.items.length})</Text>
          </View>
          {delivery.items.map((item, i) => {
            const canFulfill = !isFinal && item.product_id && !item.from_product_stock && canManageDeliveries;
            return (
              <View key={i} style={styles.itemRow}>
                {item.product_image && (
                  <Image source={{ uri: item.product_image }} style={{ width: 48, height: 48, borderRadius: 8, marginRight: 8 }} />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName}>{item.product_name || item.name}</Text>
                  {item.customization && <Text style={styles.itemCustom}>{item.customization}</Text>}
                  {item.from_product_stock ? (
                    <View style={styles.stockBadge}>
                      <Ionicons name="checkmark-circle" size={12} color={Colors.success} />
                      <Text style={styles.stockBadgeText}>From Stock</Text>
                    </View>
                  ) : canFulfill ? (
                    <TouchableOpacity style={styles.fulfillBtn} onPress={() => handleFulfillFromStock(item.id, item.product_name)}>
                      <Ionicons name="cube-outline" size={14} color={Colors.primary} />
                      <Text style={styles.fulfillBtnText}>Fulfill from Stock</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                <Text style={styles.itemQty}>x{item.quantity}</Text>
                {!isPartner && <Text style={styles.itemPrice}>₹{Number(item.line_total || item.total || 0).toFixed(0)}</Text>}
              </View>
            );
          })}
          {!isPartner && (
            <View style={[styles.itemRow, { borderTopWidth: 1, borderTopColor: Colors.border, marginTop: 8, paddingTop: 8 }]}>
              <Text style={[styles.itemName, { fontWeight: '700' }]}>Grand Total</Text>
              <Text style={[styles.itemPrice, { fontWeight: '700', fontSize: FontSize.lg }]}>₹{Number(delivery.grand_total || 0).toFixed(0)}</Text>
            </View>
          )}
        </View>
      )}

      {/* Payment & COD */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{isPartner ? 'Collection' : 'Payment'}</Text>
        {!isPartner && (
          <>
            <InfoRow icon="cash-outline" label="Grand Total" value={`₹${Number(delivery.grand_total || 0).toFixed(0)}`} />
            {delivery.is_credit_sale === 1 ? (
              <InfoRow icon="document-text-outline" label="On Credit" value={`₹${Number(delivery.grand_total || 0).toFixed(0)}`} />
            ) : (
              <InfoRow icon="wallet-outline" label="Paid at Shop" value={`₹${Number((delivery.grand_total || 0) - (delivery.cod_amount || 0)).toFixed(0)}`} />
            )}
          </>
        )}
        {delivery.cod_amount > 0 && (
          <>
            <InfoRow icon="card-outline" label={isPartner ? 'Amount to Collect' : 'COD Amount'} value={`₹${Number(delivery.cod_amount).toFixed(0)}`} />
            <InfoRow icon="checkmark-done-outline" label="Collected" value={`₹${Number(delivery.cod_collected || 0).toFixed(0)}`} />
            {delivery.cod_amount - (delivery.cod_collected || 0) > 0.01 && (
              <InfoRow icon="alert-circle-outline" label="Remaining" value={`₹${Number(delivery.cod_amount - (delivery.cod_collected || 0)).toFixed(0)}`} />
            )}
            <View style={[styles.codStatusBadge, { backgroundColor: delivery.cod_status === 'collected' ? '#E8F5E9' : delivery.cod_status === 'settled' ? '#E3F2FD' : '#FFF3E0' }]}>
              <Text style={styles.codStatusText}>
                {isPartner ? 'Status' : 'COD Status'}: {(delivery.cod_status || 'none').replace(/_/g, ' ').toUpperCase()}
              </Text>
            </View>
          </>
        )}
        {delivery.cod_amount === 0 && isPartner && (
          <View style={[styles.codStatusBadge, { backgroundColor: '#E8F5E9' }]}>
            <Text style={styles.codStatusText}>
              {delivery.is_credit_sale === 1 ? 'Credit Sale — No amount to collect' : 'No amount to collect — Fully prepaid'}
            </Text>
          </View>
        )}
        {!isPartner && delivery.payments?.length > 0 && (
          <View style={{ marginTop: 8 }}>
            <Text style={[styles.sectionTitle, { fontSize: FontSize.sm }]}>Payment History</Text>
            {delivery.payments.map((p, i) => (
              <View key={i} style={styles.paymentRow}>
                <Text style={styles.cardText}>{p.method?.toUpperCase()}</Text>
                <Text style={styles.cardText}>₹{Number(p.amount).toFixed(0)}</Text>
                <Text style={[styles.cardText, { fontSize: FontSize.xs }]}>{formatDate(p.created_at)}</Text>
              </View>
            ))}
          </View>
        )}
      </View>

      {/* Delivery Proofs */}
      {delivery.proofs?.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Delivery Proof</Text>
          <ScrollView horizontal>
            {delivery.proofs.map((proof, i) => (
              <Image key={i} source={{ uri: proof.photo_url }} style={styles.proofImage} />
            ))}
          </ScrollView>
        </View>
      )}

      {/* Delivery actions — one shared panel (also on Sale Details). */}
      <View style={styles.section}>
        <DeliveryActionsPanel ref={panelRef} deliveryId={deliveryId} navigation={navigation} onChanged={fetchDelivery} />
      </View>
    </ScrollView>
  );
}

function InfoRow({ icon, label, value }) {
  return (
    <View style={styles.infoRow}>
      <Ionicons name={icon} size={16} color={Colors.textLight} />
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  section: { backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, margin: Spacing.md, marginBottom: 0, padding: Spacing.md, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 1 },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: 10 },
  timeline: { marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: Colors.border },
  timelineRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  timelineText: { fontSize: FontSize.sm, color: Colors.text },
  progressRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  stepItem: { alignItems: 'center', flex: 1, position: 'relative' },
  stepDot: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, justifyContent: 'center', alignItems: 'center', zIndex: 1 },
  stepLine: { position: 'absolute', top: 15, left: '60%', right: '-40%', height: 3 },
  stepLabel: { fontSize: FontSize.xs, fontWeight: '600', marginTop: 4 },
  alert: { flexDirection: 'row', alignItems: 'center', padding: 10, borderRadius: BorderRadius.md, marginTop: 8, gap: 8 },
  alertText: { fontSize: FontSize.sm, flex: 1 },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8, gap: 8 },
  infoLabel: { fontSize: FontSize.sm, color: Colors.textLight, width: 80 },
  infoValue: { fontSize: FontSize.sm, color: Colors.text, flex: 1, fontWeight: '500' },
  itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.md, gap: 8, borderBottomWidth: 1, borderBottomColor: Colors.border },
  itemsSectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  saleDetailBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary + '40', backgroundColor: Colors.primary + '08' },
  convertPickupBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary + '40', backgroundColor: Colors.primary + '08' },
  saleDetailBtnText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },
  stockBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  stockBadgeText: { fontSize: FontSize.xs, color: Colors.success, fontWeight: '600' },
  fulfillBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: Colors.primary + '10', alignSelf: 'flex-start' },
  fulfillBtnText: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600' },
  itemName: { flex: 1, fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  itemCustom: { fontSize: FontSize.sm, color: Colors.textLight },
  itemQty: { fontSize: FontSize.md, color: Colors.textLight, width: 30, textAlign: 'center' },
  itemPrice: { fontSize: FontSize.md, color: Colors.text, fontWeight: '700', width: 70, textAlign: 'right' },
  codStatusBadge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, marginTop: 8, alignSelf: 'flex-start' },
  codStatusText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  paymentRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: Colors.border },
  cardText: { fontSize: FontSize.sm, color: Colors.textLight },
  proofImage: { width: 120, height: 120, borderRadius: 8, marginRight: 8 },
});
