import React, { useState, useCallback, useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, Platform, TextInput, ActivityIndicator, Image, Modal, FlatList } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { parseServerDate, formatDate, formatDateTime } from '../utils/datetime';

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
  const [proofPhoto, setProofPhoto] = useState(null);
  const [assignModalVisible, setAssignModalVisible] = useState(false);
  const [partners, setPartners] = useState([]);
  const [assignLoading, setAssignLoading] = useState(false);

  const isPartner = user?.role === 'delivery_partner';
  const isManager = user?.role === 'owner' || user?.role === 'manager';

  const takeProofPhoto = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Camera permission is needed for proof of delivery.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: 0.6,
        allowsEditing: false,
      });
      if (!result.canceled && result.assets?.[0]) {
        setProofPhoto(result.assets[0]);
      }
    } catch (err) {
      console.error('Camera error:', err);
    }
  };

  const pickProofPhoto = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.6,
      });
      if (!result.canceled && result.assets?.[0]) {
        setProofPhoto(result.assets[0]);
      }
    } catch (err) {
      console.error('Image picker error:', err);
    }
  };

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

  const openAssignModal = async () => {
    try {
      const res = await api.getUsers({ role: 'delivery_partner', limit: 100 });
      const users = res.data?.users || res.data || [];
      setPartners(Array.isArray(users) ? users.filter(u => u.is_active) : []);
    } catch {
      setPartners([]);
    }
    setAssignModalVisible(true);
  };

  const handleAssign = async (partnerId) => {
    try {
      setAssignLoading(true);
      await api.assignDelivery(deliveryId, { delivery_partner_id: partnerId });
      setAssignModalVisible(false);
      fetchDelivery();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to assign partner');
    } finally {
      setAssignLoading(false);
    }
  };

  const handleDeliver = async () => {
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

    // Upload proof photo if taken
    if (proofPhoto) {
      try {
        const formData = new FormData();
        if (Platform.OS === 'web') {
          const resp = await fetch(proofPhoto.uri);
          const blob = await resp.blob();
          formData.append('photo', blob, `proof_${deliveryId}_${Date.now()}.jpg`);
        } else {
          formData.append('photo', {
            uri: proofPhoto.uri,
            type: 'image/jpeg',
            name: `proof_${deliveryId}_${Date.now()}.jpg`,
          });
        }
        await api.uploadDeliveryProof(deliveryId, formData);
      } catch (err) {
        console.warn('Proof upload error (continuing):', err);
      }
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
    const date = formatDate(delivery.created_at);
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

    const codToCollect = Math.max((delivery.cod_amount || 0) - (delivery.cod_collected || 0), 0);
    const codAmt = codToCollect.toFixed(0);

    const buildCopyHtml = (copyTitle, showInstructions) => `
      <div style="border:2px solid #333;border-radius:6px;padding:10px 14px;box-sizing:border-box;position:relative;overflow:hidden;page-break-inside:avoid;break-inside:avoid;flex:1;min-height:0;">
        <div style="position:absolute;top:6px;right:10px;font-size:10px;color:#999;font-weight:600;text-transform:uppercase;letter-spacing:1px;">${copyTitle}</div>
        <div style="text-align:center;margin-bottom:4px;">
          <div style="font-size:16px;font-weight:bold;color:#E91E63;line-height:1.1;">${shopName}</div>
          ${locationName ? `<div style="font-size:10px;color:#555;line-height:1.1;">${locationName}</div>` : ''}
          ${locationAddress ? `<div style="font-size:9px;color:#888;line-height:1.1;">${locationAddress}</div>` : ''}
          ${locationPhone ? `<div style="font-size:9px;color:#888;line-height:1.1;">Ph: ${locationPhone}</div>` : ''}
        </div>
        <div style="border-top:1px dashed #999;margin:5px 0;"></div>
        <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:3px;">
          <span><strong>Order:</strong> ${orderNo}</span>
          <span><strong>Date:</strong> ${date}</span>
        </div>
        ${scheduledDate ? `<div style="font-size:10px;margin-bottom:3px;"><strong>Scheduled:</strong> ${scheduledDate} ${scheduledTime || ''}</div>` : ''}
        <div style="display:flex;gap:12px;font-size:10px;margin-bottom:2px;">
          <div style="flex:1;"><strong>Customer:</strong> ${customerName}${customerPhone ? ' • ' + customerPhone : ''}</div>
        </div>
        <div style="font-size:10px;margin-bottom:3px;"><strong>Address:</strong> ${address}</div>
        ${senderName || senderPhone ? `<div style="font-size:10px;margin-bottom:2px;"><strong>Sender:</strong> ${senderName}${senderPhone ? ' • ' + senderPhone : ''}</div>` : ''}
        ${senderMessage ? `<div style="background:#FFF3E0;border-radius:4px;padding:3px 6px;margin:3px 0;font-size:10px;"><strong>Message:</strong> ${senderMessage}</div>` : ''}
        <table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:4px;">
          <thead>
            <tr style="background:#f5f5f5;">
              <th style="padding:3px 4px;text-align:left;border-bottom:2px solid #ddd;">Item</th>
              <th style="padding:3px 4px;text-align:center;border-bottom:2px solid #ddd;">Qty</th>
              <th style="padding:3px 4px;text-align:right;border-bottom:2px solid #ddd;">Amount</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="border-top:1px dashed #999;margin:5px 0;"></div>
        <div style="display:flex;justify-content:space-between;font-size:11px;font-weight:bold;">
          ${parseFloat(codAmt) > 0 ? `<span style="color:#E91E63;">COD: ₹${codAmt}</span>` : '<span style="color:#4CAF50;">PREPAID</span>'}
          <span style="color:#666;">${copyTitle}</span>
        </div>
        ${showInstructions && delivery.special_instructions ? `<div style="font-size:10px;color:#666;margin-top:4px;"><strong>Instructions:</strong> ${delivery.special_instructions}</div>` : ''}
      </div>
    `;

    const html = `
      <html><head><meta charset="utf-8">
      <style>
        @page { size: A4 portrait; margin: 8mm; }
        html, body { margin: 0; padding: 0; }
        body { font-family: Arial, Helvetica, sans-serif; display: flex; flex-direction: column; gap: 8px; min-height: 100vh; }
      </style></head>
      <body>
        ${buildCopyHtml('Shop Copy', true)}
        ${buildCopyHtml('Customer Copy', false)}
      </body></html>
    `;

    const printHtmlOnWeb = (markup, title) => {
      const frame = document.createElement('iframe');
      frame.style.position = 'fixed';
      frame.style.right = '0';
      frame.style.bottom = '0';
      frame.style.width = '0';
      frame.style.height = '0';
      frame.style.border = '0';
      frame.setAttribute('aria-hidden', 'true');
      document.body.appendChild(frame);

      const frameDoc = frame.contentWindow?.document;
      if (!frameDoc) {
        document.body.removeChild(frame);
        throw new Error('Unable to open print frame');
      }

      frameDoc.open();
      frameDoc.write(`<html><head><title>${title}</title></head><body>${markup}</body></html>`);
      frameDoc.close();

      setTimeout(() => {
        try {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
        } finally {
          setTimeout(() => {
            if (frame.parentNode) frame.parentNode.removeChild(frame);
          }, 500);
        }
      }, 250);
    };

    try {
      if (Platform.OS === 'web') {
        printHtmlOnWeb(html, 'Delivery Challan');
      } else {
        const { uri } = await Print.printToFileAsync({ html });
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
    <>
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
            <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#2196F3' }]} onPress={openAssignModal} disabled={actionLoading}>
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
                  {/* Proof of Delivery Photo */}
                  <Text style={styles.formTitle}>Proof of Delivery (Photo)</Text>
                  {proofPhoto ? (
                    <View style={{ alignItems: 'center', marginBottom: 8 }}>
                      <Image source={{ uri: proofPhoto.uri }} style={{ width: 200, height: 150, borderRadius: 8 }} />
                      <TouchableOpacity onPress={() => setProofPhoto(null)} style={{ marginTop: 4 }}>
                        <Text style={{ color: Colors.error, fontSize: FontSize.sm }}>Remove</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                      <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#9C27B0', flex: 1 }]} onPress={takeProofPhoto}>
                        <Ionicons name="camera" size={18} color="#fff" />
                        <Text style={styles.actionBtnText}>Take Photo</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.textSecondary, flex: 1 }]} onPress={pickProofPhoto}>
                        <Ionicons name="images" size={18} color="#fff" />
                        <Text style={styles.actionBtnText}>Gallery</Text>
                      </TouchableOpacity>
                    </View>
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

      {/* Failed delivery — Reattempt or Cancel */}
      {delivery.status === 'failed' && isManager && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Failed Delivery Actions</Text>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: 12 }}>
            Reattempt to reassign to a partner, or cancel the delivery.
          </Text>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: '#2196F3', marginBottom: 10 }]}
            disabled={actionLoading}
            onPress={() => {
              Alert.alert('Reattempt Delivery', 'Reset to "assigned" for another attempt?', [
                { text: 'Back', style: 'cancel' },
                { text: 'Reattempt', onPress: async () => {
                  try { setActionLoading(true); await api.reattemptDelivery(deliveryId); fetchDelivery(); }
                  catch (err) { Alert.alert('Error', err.message || 'Failed'); }
                  finally { setActionLoading(false); }
                }},
              ]);
            }}
          >
            <Ionicons name="refresh-circle" size={20} color="#fff" />
            <Text style={styles.actionBtnText}>Reattempt Delivery</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: '#F44336' }]}
            disabled={actionLoading}
            onPress={() => {
              Alert.alert('Cancel Delivery', 'Cancel this failed delivery?', [
                { text: 'Back', style: 'cancel' },
                { text: 'Cancel Delivery Only', onPress: async () => {
                  try { setActionLoading(true); await api.cancelDelivery(deliveryId, { reason: 'Cancelled after failed delivery' }); fetchDelivery(); }
                  catch (err) { Alert.alert('Error', err.message || 'Failed'); }
                  finally { setActionLoading(false); }
                }},
                { text: 'Cancel Order Too', style: 'destructive', onPress: async () => {
                  try {
                    setActionLoading(true);
                    await api.cancelDelivery(deliveryId, { reason: 'Cancelled after failed delivery' });
                    await api.cancelSale(delivery.sale_id);
                    fetchDelivery();
                    Alert.alert('Cancelled', 'Delivery and order cancelled.');
                  } catch (err) { Alert.alert('Error', err.message || 'Failed'); }
                  finally { setActionLoading(false); }
                }},
              ]);
            }}
          >
            {actionLoading ? <ActivityIndicator color="#fff" /> : <Ionicons name="close-circle" size={20} color="#fff" />}
            <Text style={styles.actionBtnText}>Cancel Delivery</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>

    {/* Assign Partner Modal */}
    <Modal visible={assignModalVisible} animationType="slide" transparent onRequestClose={() => setAssignModalVisible(false)}>
      <View style={styles.modalOverlay}>
        <View style={styles.assignModal}>
          <View style={styles.assignModalHeader}>
            <Text style={styles.assignModalTitle}>Assign Delivery Partner</Text>
            <TouchableOpacity onPress={() => setAssignModalVisible(false)}>
              <Ionicons name="close" size={24} color={Colors.text} />
            </TouchableOpacity>
          </View>
          {partners.length === 0 ? (
            <Text style={{ textAlign: 'center', color: Colors.textSecondary, padding: 20 }}>No delivery partners found</Text>
          ) : (
            <FlatList
              data={partners}
              keyExtractor={item => String(item.id)}
              renderItem={({ item: p }) => (
                <TouchableOpacity
                  style={styles.partnerItem}
                  onPress={() => handleAssign(p.id)}
                  disabled={assignLoading}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.partnerName}>{p.name}</Text>
                    <Text style={styles.partnerPhone}>{p.phone}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />
                </TouchableOpacity>
              )}
            />
          )}
          {assignLoading && <ActivityIndicator style={{ padding: 10 }} color={Colors.primary} />}
        </View>
      </View>
    </Modal>
    </>
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
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  assignModal: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '60%', paddingBottom: 30 },
  assignModalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border },
  assignModalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  partnerItem: { flexDirection: 'row', alignItems: 'center', padding: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border },
  partnerName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  partnerPhone: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
});
