import React, { useState, useCallback, useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, Platform, TextInput, ActivityIndicator, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const STATUS_STEPS = ['pending', 'assigned', 'picked_up', 'in_transit', 'delivered'];
const STATUS_LABELS = { pending: 'Pending', assigned: 'Assigned', picked_up: 'Picked Up', in_transit: 'In Transit', delivered: 'Delivered', failed: 'Failed', cancelled: 'Cancelled' };
const STATUS_ICONS = { pending: 'time-outline', assigned: 'person-add-outline', picked_up: 'cube-outline', in_transit: 'bicycle-outline', delivered: 'checkmark-circle-outline', failed: 'close-circle-outline', cancelled: 'ban-outline' };
const STATUS_COLORS = { pending: '#FF9800', assigned: '#2196F3', picked_up: '#9C27B0', in_transit: '#00BCD4', delivered: '#4CAF50', failed: '#F44336', cancelled: '#9E9E9E' };

export default function DeliveryDetailScreen({ route, navigation }) {
  const { deliveryId } = route.params;
  const { user } = useAuth();
  const [delivery, setDelivery] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [codAmount, setCodAmount] = useState('');
  const [codMethod, setCodMethod] = useState('cash');
  const [codRef, setCodRef] = useState('');
  const [failReason, setFailReason] = useState('');
  const [showCodForm, setShowCodForm] = useState(false);
  const [showFailForm, setShowFailForm] = useState(false);

  const isPartner = user?.role === 'delivery_partner';
  const isManager = user?.role === 'owner' || user?.role === 'manager';

  const fetchDelivery = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.getDelivery(deliveryId);
      setDelivery(res.data);
      if (res.data?.cod_amount) {
        const remaining = (res.data.cod_amount - (res.data.cod_collected || 0)).toFixed(2);
        setCodAmount(remaining);
      }
    } catch (err) {
      console.error('Fetch delivery error:', err);
    } finally {
      setLoading(false);
    }
  }, [deliveryId]);

  useFocusEffect(useCallback(() => { fetchDelivery(); }, [fetchDelivery]));

  const doAction = async (action, data = {}) => {
    try {
      setActionLoading(true);
      if (action === 'pickup') await api.pickupDelivery(deliveryId);
      else if (action === 'in_transit') await api.markInTransit(deliveryId);
      else if (action === 'deliver') await api.deliverOrder(deliveryId, data);
      else if (action === 'fail') await api.failDelivery(deliveryId, data);
      fetchDelivery();
      setShowCodForm(false);
      setShowFailForm(false);
    } catch (err) {
      const msg = err.message || 'Action failed';
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeliver = () => {
    const data = {};
    if (delivery.cod_amount > 0) {
      const amt = parseFloat(codAmount);
      if (isNaN(amt) || amt < 0) {
        const msg = 'Enter valid COD amount';
        Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
        return;
      }
      data.cod_collected = amt;
      data.cod_method = codMethod;
      if (codMethod === 'upi' && codRef) data.cod_reference = codRef;
    }
    doAction('deliver', data);
  };

  const handleFail = () => {
    if (!failReason.trim()) {
      const msg = 'Please provide a reason for failure';
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Error', msg);
      return;
    }
    doAction('fail', { failure_reason: failReason.trim() });
  };

  const handleConvertToPickup = () => {
    const doConvert = async () => {
      try {
        setActionLoading(true);
        await api.convertOrderType(delivery.sale_id, { new_order_type: 'pickup', delivery_charges: 0 });
        Alert.alert('Done', 'Order converted to pickup');
        fetchDelivery();
      } catch (err) {
        Alert.alert('Error', err.message || 'Failed to convert');
      } finally {
        setActionLoading(false);
      }
    };
    Alert.alert('Convert to Pickup', 'Convert this delivery order to a pickup order? The delivery will be cancelled.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Convert', onPress: doConvert },
    ]);
  };

  const handleFulfillFromStock = (saleItemId, productName) => {
    Alert.alert(
      'Fulfill from Stock',
      `Use ready stock for "${productName}"? This will deduct from product inventory.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Fulfill',
          onPress: async () => {
            try {
              await api.fulfillFromStock(delivery.sale_id, saleItemId);
              fetchDelivery();
              Alert.alert('Done', `"${productName}" fulfilled from stock`);
            } catch (err) {
              Alert.alert('Error', err.message || 'Failed to fulfill from stock');
            }
          },
        },
      ]
    );
  };

  const generateChallan = async () => {
    // Fetch shop settings for shop name / contact
    let shopName = 'BloomPOS', shopContact = '';
    try {
      const settingsRes = await api.getSettings();
      if (settingsRes.data) {
        const map = {};
        settingsRes.data.forEach(s => { map[s.key] = s.value; });
        shopName = map.shop_name || shopName;
      }
    } catch {}

    const locationName = delivery.location_name || '';
    const locationAddress = delivery.location_address || '';
    const locationPhone = delivery.location_phone || '';
    const orderNo = delivery.sale_number || '';
    const date = new Date(delivery.created_at).toLocaleDateString();
    const customerName = delivery.customer_name || '';
    const customerPhone = delivery.customer_phone || '';
    const address = delivery.delivery_address || '';
    const senderName = delivery.sender_name || '';
    const senderPhone = delivery.sender_phone || '';
    const senderMessage = delivery.sender_message || '';
    const scheduledDate = delivery.scheduled_date || '';
    const scheduledTime = delivery.scheduled_time || '';

    const itemsHtml = (delivery.items || []).map(item => `
      <tr>
        <td style="padding:4px 6px;border-bottom:1px solid #ddd;">${item.product_name || ''}</td>
        <td style="padding:4px 6px;border-bottom:1px solid #ddd;text-align:center;">${item.quantity}</td>
        <td style="padding:4px 6px;border-bottom:1px solid #ddd;text-align:right;">₹${(item.line_total || 0).toFixed(0)}</td>
      </tr>
    `).join('');

    const totalAmt = (delivery.grand_total || 0).toFixed(0);
    const codAmt = (delivery.cod_amount || 0).toFixed(0);

    const buildCopyHtml = (copyTitle, showInstructions) => `
      <div style="border:2px solid #333;border-radius:6px;padding:12px 16px;height:48%;box-sizing:border-box;position:relative;overflow:hidden;">
        <div style="position:absolute;top:6px;right:10px;font-size:10px;color:#999;font-weight:600;text-transform:uppercase;letter-spacing:1px;">${copyTitle}</div>
        <div style="text-align:center;margin-bottom:6px;">
          <div style="font-size:18px;font-weight:bold;color:#E91E63;">${shopName}</div>
          ${locationName ? `<div style="font-size:11px;color:#555;">${locationName}</div>` : ''}
          ${locationAddress ? `<div style="font-size:10px;color:#888;">${locationAddress}</div>` : ''}
          ${locationPhone ? `<div style="font-size:10px;color:#888;">Ph: ${locationPhone}</div>` : ''}
        </div>
        <div style="border-top:1px dashed #999;margin:6px 0;"></div>
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px;">
          <span><strong>Order:</strong> ${orderNo}</span>
          <span><strong>Date:</strong> ${date}</span>
        </div>
        ${scheduledDate ? `<div style="font-size:11px;margin-bottom:4px;"><strong>Scheduled:</strong> ${scheduledDate} ${scheduledTime || ''}</div>` : ''}
        <div style="display:flex;gap:20px;font-size:11px;margin-bottom:2px;">
          <div style="flex:1;"><strong>Customer:</strong> ${customerName}${customerPhone ? ' • ' + customerPhone : ''}</div>
        </div>
        <div style="font-size:11px;margin-bottom:4px;"><strong>Address:</strong> ${address}</div>
        ${senderName || senderPhone ? `<div style="font-size:11px;margin-bottom:2px;"><strong>Sender:</strong> ${senderName}${senderPhone ? ' • ' + senderPhone : ''}</div>` : ''}
        ${senderMessage ? `<div style="background:#FFF3E0;border-radius:4px;padding:4px 8px;margin:4px 0;font-size:11px;"><strong>Message:</strong> ${senderMessage}</div>` : ''}
        <table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:6px;">
          <thead>
            <tr style="background:#f5f5f5;">
              <th style="padding:4px 6px;text-align:left;border-bottom:2px solid #ddd;">Item</th>
              <th style="padding:4px 6px;text-align:center;border-bottom:2px solid #ddd;">Qty</th>
              <th style="padding:4px 6px;text-align:right;border-bottom:2px solid #ddd;">Amount</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="border-top:1px dashed #999;margin:6px 0;"></div>
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:bold;">
          <span>Total: ₹${totalAmt}</span>
          ${parseFloat(codAmt) > 0 ? `<span style="color:#E91E63;">COD: ₹${codAmt}</span>` : '<span style="color:#4CAF50;">PREPAID</span>'}
        </div>
        ${showInstructions && delivery.special_instructions ? `<div style="font-size:10px;color:#666;margin-top:4px;"><strong>Instructions:</strong> ${delivery.special_instructions}</div>` : ''}
      </div>
    `;

    const html = `
      <html><head><meta charset="utf-8">
      <style>
        @page { size: A4; margin: 12mm; }
        body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; justify-content: space-between; gap: 12px; }
      </style></head>
      <body>
        ${buildCopyHtml('Shop Copy', true)}
        ${buildCopyHtml('Customer Copy', false)}
      </body></html>
    `;

    try {
      const { uri } = await Print.printToFileAsync({ html });
      if (Platform.OS === 'web') {
        await Print.printAsync({ html });
      } else {
        await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: `Challan ${orderNo}` });
      }
    } catch {
      Alert.alert('Error', 'Could not generate delivery challan');
    }
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
        {delivery.scheduled_date && <InfoRow icon="calendar-outline" label="Scheduled" value={`${delivery.scheduled_date} ${delivery.scheduled_time || ''}`} />}
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
            <TouchableOpacity style={styles.saleDetailBtn} onPress={generateChallan}>
              <Ionicons name="print-outline" size={16} color={Colors.primary} />
              <Text style={styles.saleDetailBtnText}>Delivery Challan</Text>
            </TouchableOpacity>
            {!isFinal && (
              <TouchableOpacity style={styles.convertPickupBtn} onPress={handleConvertToPickup} disabled={actionLoading}>
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
          <Text style={styles.sectionTitle}>Items ({delivery.items.length})</Text>
          {delivery.items.map((item, i) => {
            const canFulfill = !isFinal && item.product_id && !item.from_product_stock && isManager;
            return (
              <View key={i} style={styles.itemRow}>
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
                {!isPartner && <Text style={styles.itemPrice}>₹{((item.line_total || item.total || 0)).toFixed(0)}</Text>}
              </View>
            );
          })}
          {!isPartner && (
            <View style={[styles.itemRow, { borderTopWidth: 1, borderTopColor: Colors.border, marginTop: 8, paddingTop: 8 }]}>
              <Text style={[styles.itemName, { fontWeight: '700' }]}>Grand Total</Text>
              <Text style={[styles.itemPrice, { fontWeight: '700', fontSize: FontSize.lg }]}>₹{(delivery.grand_total || 0).toFixed(0)}</Text>
            </View>
          )}
        </View>
      )}

      {/* Payment & COD */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{isPartner ? 'Collection' : 'Payment'}</Text>
        {!isPartner && (
          <>
            <InfoRow icon="cash-outline" label="Grand Total" value={`₹${(delivery.grand_total || 0).toFixed(0)}`} />
            <InfoRow icon="wallet-outline" label="Paid at Shop" value={`₹${((delivery.grand_total || 0) - (delivery.cod_amount || 0)).toFixed(0)}`} />
          </>
        )}
        {delivery.cod_amount > 0 && (
          <>
            <InfoRow icon="card-outline" label={isPartner ? 'Amount to Collect' : 'COD Amount'} value={`₹${delivery.cod_amount.toFixed(0)}`} />
            <InfoRow icon="checkmark-done-outline" label="Collected" value={`₹${(delivery.cod_collected || 0).toFixed(0)}`} />
            {delivery.cod_amount - (delivery.cod_collected || 0) > 0 && (
              <InfoRow icon="alert-circle-outline" label="Remaining" value={`₹${(delivery.cod_amount - (delivery.cod_collected || 0)).toFixed(0)}`} />
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
            <Text style={styles.codStatusText}>No amount to collect — Fully prepaid</Text>
          </View>
        )}
        {!isPartner && delivery.payments?.length > 0 && (
          <View style={{ marginTop: 8 }}>
            <Text style={[styles.sectionTitle, { fontSize: FontSize.sm }]}>Payment History</Text>
            {delivery.payments.map((p, i) => (
              <View key={i} style={styles.paymentRow}>
                <Text style={styles.cardText}>{p.method?.toUpperCase()}</Text>
                <Text style={styles.cardText}>₹{p.amount.toFixed(0)}</Text>
                <Text style={[styles.cardText, { fontSize: FontSize.xs }]}>{new Date(p.created_at).toLocaleDateString()}</Text>
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

      {/* Actions */}
      {!isFinal && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Actions</Text>

          {/* Print challan — available to all roles */}
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.primary, marginBottom: 8 }]} onPress={generateChallan}>
            <Ionicons name="print" size={20} color="#fff" />
            <Text style={styles.actionBtnText}>Print Delivery Challan</Text>
          </TouchableOpacity>

          {isManager && delivery.status === 'pending' && (
            <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#2196F3' }]} onPress={() => navigation.navigate('Deliveries')} disabled={actionLoading}>
              <Ionicons name="person-add" size={20} color="#fff" />
              <Text style={styles.actionBtnText}>Assign Partner</Text>
            </TouchableOpacity>
          )}

          {isPartner && delivery.status === 'assigned' && (
            <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#9C27B0' }]} onPress={() => doAction('pickup')} disabled={actionLoading}>
              <Ionicons name="cube" size={20} color="#fff" />
              <Text style={styles.actionBtnText}>Pick Up Order</Text>
            </TouchableOpacity>
          )}

          {isPartner && delivery.status === 'picked_up' && (
            <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#00BCD4' }]} onPress={() => doAction('in_transit')} disabled={actionLoading}>
              <Ionicons name="bicycle" size={20} color="#fff" />
              <Text style={styles.actionBtnText}>Start Delivery</Text>
            </TouchableOpacity>
          )}

          {isPartner && delivery.status === 'in_transit' && (
            <>
              {!showCodForm ? (
                <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#4CAF50' }]} onPress={() => setShowCodForm(true)} disabled={actionLoading}>
                  <Ionicons name="checkmark-circle" size={20} color="#fff" />
                  <Text style={styles.actionBtnText}>Mark Delivered</Text>
                </TouchableOpacity>
              ) : (
                <View style={styles.formBox}>
                  <Text style={styles.formTitle}>Confirm Delivery</Text>
                  {delivery.cod_amount > 0 && (
                    <>
                      <Text style={styles.label}>COD Amount to Collect (₹{(delivery.cod_amount - (delivery.cod_collected || 0)).toFixed(0)} remaining)</Text>
                      <TextInput
                        style={styles.input}
                        value={codAmount}
                        onChangeText={setCodAmount}
                        keyboardType="decimal-pad"
                        placeholder="Amount collected"
                      />
                      <View style={styles.methodRow}>
                        {['cash', 'upi'].map(m => (
                          <TouchableOpacity key={m} style={[styles.methodBtn, codMethod === m && styles.methodBtnActive]} onPress={() => setCodMethod(m)}>
                            <Text style={[styles.methodText, codMethod === m && styles.methodTextActive]}>{m.toUpperCase()}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                      {codMethod === 'upi' && (
                        <TextInput style={styles.input} value={codRef} onChangeText={setCodRef} placeholder="UPI Reference" />
                      )}
                    </>
                  )}
                  <View style={styles.actionRow}>
                    <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#ccc', flex: 1 }]} onPress={() => setShowCodForm(false)}>
                      <Text style={[styles.actionBtnText, { color: '#333' }]}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#4CAF50', flex: 1 }]} onPress={handleDeliver} disabled={actionLoading}>
                      {actionLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.actionBtnText}>Confirm</Text>}
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {!showFailForm ? (
                <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#F44336', marginTop: 8 }]} onPress={() => setShowFailForm(true)} disabled={actionLoading}>
                  <Ionicons name="close-circle" size={20} color="#fff" />
                  <Text style={styles.actionBtnText}>Mark Failed</Text>
                </TouchableOpacity>
              ) : (
                <View style={[styles.formBox, { marginTop: 8 }]}>
                  <Text style={styles.formTitle}>Failure Reason</Text>
                  <TextInput
                    style={[styles.input, { height: 80, textAlignVertical: 'top' }]}
                    value={failReason}
                    onChangeText={setFailReason}
                    placeholder="Enter reason for failure..."
                    multiline
                  />
                  <View style={styles.actionRow}>
                    <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#ccc', flex: 1 }]} onPress={() => setShowFailForm(false)}>
                      <Text style={[styles.actionBtnText, { color: '#333' }]}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#F44336', flex: 1 }]} onPress={handleFail} disabled={actionLoading}>
                      {actionLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.actionBtnText}>Confirm Fail</Text>}
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </>
          )}
        </View>
      )}
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
  itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 8 },
  saleDetailBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary + '40', backgroundColor: Colors.primary + '08' },
  convertPickupBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary + '40', backgroundColor: Colors.primary + '08' },
  saleDetailBtnText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },
  stockBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  stockBadgeText: { fontSize: FontSize.xs, color: Colors.success, fontWeight: '600' },
  fulfillBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: Colors.primary + '10', alignSelf: 'flex-start' },
  fulfillBtnText: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600' },
  itemName: { flex: 1, fontSize: FontSize.sm, color: Colors.text },
  itemCustom: { fontSize: FontSize.xs, color: Colors.textLight },
  itemQty: { fontSize: FontSize.sm, color: Colors.textLight, width: 30, textAlign: 'center' },
  itemPrice: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '600', width: 70, textAlign: 'right' },
  codStatusBadge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, marginTop: 8, alignSelf: 'flex-start' },
  codStatusText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  paymentRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: Colors.border },
  cardText: { fontSize: FontSize.sm, color: Colors.textLight },
  proofImage: { width: 120, height: 120, borderRadius: 8, marginRight: 8 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 14, borderRadius: BorderRadius.md, gap: 8 },
  actionBtnText: { color: '#fff', fontWeight: '700', fontSize: FontSize.md },
  actionRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  formBox: { backgroundColor: Colors.background, borderRadius: BorderRadius.md, padding: Spacing.md, marginTop: 8 },
  formTitle: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginBottom: 8 },
  label: { fontSize: FontSize.sm, color: Colors.textLight, marginBottom: 4 },
  input: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md, padding: 10, fontSize: FontSize.md, color: Colors.text, marginBottom: 8 },
  methodRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  methodBtn: { flex: 1, paddingVertical: 10, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, alignItems: 'center' },
  methodBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  methodText: { fontSize: FontSize.sm, color: Colors.textLight, fontWeight: '600' },
  methodTextActive: { color: '#fff' },
});
