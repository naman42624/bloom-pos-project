import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Platform, ActivityIndicator, Modal, TextInput, KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { formatDateTime } from '../utils/datetime';
import { Image } from 'react-native';

const STATUS_COLORS = {
  completed: Colors.success,
  cancelled: Colors.error,
  draft: Colors.warning,
  pending: Colors.warning,
  preparing: Colors.info,
  ready: Colors.success,
};

const PAYMENT_STATUS_COLORS = {
  paid: Colors.success,
  partial: Colors.warning,
  pending: Colors.error,
  refunded: Colors.textLight,
};

const TASK_STATUS_COLORS = {
  pending: '#FF9800',
  assigned: '#2196F3',
  in_progress: '#00BCD4',
  completed: '#4CAF50',
  cancelled: '#9E9E9E',
};

export default function SaleDetailScreen({ route, navigation }) {
  const { saleId } = route.params;
  const { user } = useAuth();
  const [sale, setSale] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedItems, setExpandedItems] = useState({});

  const canManage = user?.role === 'owner' || user?.role === 'manager';

  // Convert order type state
  const [convertModalVisible, setConvertModalVisible] = useState(false);
  const [convertAddress, setConvertAddress] = useState('');
  const [convertCharges, setConvertCharges] = useState('');
  const [convertTarget, setConvertTarget] = useState(null); // 'pickup' or 'delivery'
  const [convertSavedAddresses, setConvertSavedAddresses] = useState([]);

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

  const handleStatusTransition = (nextStatus, label) => {
    Alert.alert(label, `${label} for this order?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: label,
        onPress: async () => {
          try {
            await api.updateOrderStatus(saleId, nextStatus);
            fetchSale();
          } catch (err) {
            Alert.alert('Error', err.message || 'Failed to update status');
          }
        },
      },
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
              await api.fulfillFromStock(saleId, saleItemId);
              fetchSale();
              Alert.alert('Done', `"${productName}" fulfilled from stock`);
            } catch (err) {
              Alert.alert('Error', err.message || 'Failed to fulfill from stock');
            }
          },
        },
      ]
    );
  };

  // Production task actions
  const handleTaskAction = async (taskId, action, label) => {
    try {
      if (action === 'pick') await api.pickTask(taskId);
      else if (action === 'start') await api.startTask(taskId);
      else if (action === 'complete') await api.completeTask(taskId);
      fetchSale();
    } catch (err) {
      Alert.alert('Error', err.message || `Failed to ${label}`);
    }
  };

  const toggleItemExpand = (idx) => {
    setExpandedItems(prev => ({ ...prev, [idx]: !prev[idx] }));
  };

  const openConvertModal = (target) => {
    setConvertTarget(target);
    setConvertAddress(sale?.delivery_address || '');
    setConvertCharges(target === 'delivery' ? '' : '0');
    setConvertSavedAddresses([]);
    // Fetch saved addresses for the customer
    if (target === 'delivery' && sale?.customer_id) {
      api.getCustomerAddresses(sale.customer_id).then(res => {
        setConvertSavedAddresses(res.data || []);
      }).catch(() => {});
    }
    setConvertModalVisible(true);
  };

  const handleConvert = async () => {
    try {
      const data = { new_order_type: convertTarget };
      if (convertTarget === 'delivery') {
        data.delivery_address = convertAddress;
        data.delivery_charges = parseFloat(convertCharges) || 0;
      } else {
        data.delivery_charges = 0;
      }
      await api.convertOrderType(saleId, data);
      setConvertModalVisible(false);
      fetchSale();
      Alert.alert('Done', `Order converted to ${convertTarget}`);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to convert');
    }
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
          <p>${formatDateTime(sale.created_at)}</p>
        </div>
        ${sale.customer_name ? `<p>Customer: ${sale.customer_name}</p>` : ''}
        ${sale.customer_phone ? `<p>Phone: ${sale.customer_phone}</p>` : ''}
        <div class="line"></div>
        ${(sale.items || []).map(item => `
          <div>
            <p>${item.product_name || item.display_name || 'Item'}</p>
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
            <Text style={styles.saleDate}>{formatDateTime(sale.created_at)}</Text>
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
          {sale.source === 'recurring' && (
            <View style={[styles.typeBadge, { backgroundColor: '#9C27B0' + '15' }]}>
              <Text style={[styles.typeText, { color: '#9C27B0' }]}>RECURRING</Text>
            </View>
          )}
          {canManage && sale.status !== 'cancelled' && (sale.order_type === 'pickup' || sale.order_type === 'delivery') && (
            <TouchableOpacity
              style={styles.convertBtn}
              onPress={() => openConvertModal(sale.order_type === 'pickup' ? 'delivery' : 'pickup')}
            >
              <Ionicons name="swap-horizontal" size={14} color={Colors.primary} />
              <Text style={styles.convertBtnText}>
                {sale.order_type === 'pickup' ? 'Convert to Delivery' : 'Convert to Pickup'}
              </Text>
            </TouchableOpacity>
          )}
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

      {/* Delivery address — for delivery orders (non-pre-order) */}
      {sale.delivery_address && !sale.pre_order && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Delivery Address</Text>
          <Text style={styles.infoText}>{sale.delivery_address}</Text>
          {sale.scheduled_date && (
            <Text style={styles.infoSubtext}>Scheduled: {sale.scheduled_date} {sale.scheduled_time || ''}</Text>
          )}
        </View>
      )}

      {/* Delivery tracking info */}
      {sale.delivery && (
        <TouchableOpacity
          style={[styles.section, { borderLeftWidth: 3, borderLeftColor: '#00BCD4' }]}
          onPress={() => navigation.navigate('DeliveryDetail', { deliveryId: sale.delivery.id })}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.sectionTitle}>Delivery Status</Text>
            <Ionicons name="chevron-forward" size={18} color={Colors.textLight} />
          </View>
          <View style={[styles.statusBadge, { backgroundColor: sale.delivery.status === 'delivered' ? Colors.successLight : Colors.infoLight, alignSelf: 'flex-start' }]}>
            <Text style={{ fontSize: FontSize.xs, fontWeight: '700', color: sale.delivery.status === 'delivered' ? Colors.success : Colors.info }}>
              {(sale.delivery.status || '').replace(/_/g, ' ').toUpperCase()}
            </Text>
          </View>
          {sale.delivery.partner_name && (
            <Text style={[styles.infoSubtext, { marginTop: 4 }]}>Partner: {sale.delivery.partner_name} {sale.delivery.partner_phone ? '• ' + sale.delivery.partner_phone : ''}</Text>
          )}
          {sale.delivery.cod_amount > 0 && (
            <Text style={[styles.infoSubtext, { marginTop: 2 }]}>COD: ₹{sale.delivery.cod_amount} ({sale.delivery.cod_status || 'pending'})</Text>
          )}
        </TouchableOpacity>
      )}

      {/* Pickup status */}
      {sale.order_type === 'pickup' && sale.pickup_status && (
        <View style={[styles.section, { borderLeftWidth: 3, borderLeftColor: Colors.secondary }]}>
          <Text style={styles.sectionTitle}>Pickup Status</Text>
          <View style={[styles.statusBadge, { backgroundColor: sale.pickup_status === 'picked_up' ? Colors.successLight : Colors.warningLight, alignSelf: 'flex-start' }]}>
            <Text style={{ fontSize: FontSize.xs, fontWeight: '700', color: sale.pickup_status === 'picked_up' ? Colors.success : Colors.warning }}>
              {(sale.pickup_status || '').replace(/_/g, ' ').toUpperCase()}
            </Text>
          </View>
        </View>
      )}

      {/* Items */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Items ({(sale.items || []).length})</Text>
        {(sale.items || []).map((item, idx) => {
          const itemName = item.product_name || item.display_name || 'Item';
          const itemTotal = item.line_total ?? ((Number(item.quantity) || 0) * (Number(item.unit_price) || 0) + (Number(item.tax_amount) || 0));
          const canFulfill = sale.order_type !== 'walk_in'
            && !['cancelled', 'completed'].includes(sale.status)
            && item.product_id
            && !item.from_product_stock;
          const task = item.production_task;
          const hasMaterials = item.materials && item.materials.length > 0;
          const isExpanded = expandedItems[idx];
          return (
            <View key={idx} style={styles.itemRow}>
              <View style={{ flex: 1 }}>
                <TouchableOpacity onPress={() => hasMaterials && toggleItemExpand(idx)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  {item.product_image && (
                    <Image source={{ uri: item.product_image }} style={{ width: 36, height: 36, borderRadius: 6, marginRight: 6 }} />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>{itemName}</Text>
                    <Text style={styles.itemMeta}>
                      {item.quantity} × ₹{(item.unit_price || 0).toFixed(2)}
                      {item.tax_rate > 0 ? ` (${item.tax_rate}% tax)` : ''}
                    </Text>
                  </View>
                  {hasMaterials && (
                    <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={Colors.textLight} />
                  )}
                </TouchableOpacity>

                {/* Production task status & actions */}
                {task && (
                  <View style={styles.taskRow}>
                    <View style={[styles.taskBadge, { backgroundColor: (TASK_STATUS_COLORS[task.status] || '#999') + '20' }]}>
                      <Text style={[styles.taskBadgeText, { color: TASK_STATUS_COLORS[task.status] || '#999' }]}>
                        {(task.status || '').replace(/_/g, ' ').toUpperCase()}
                      </Text>
                    </View>
                    {task.assigned_to_name && <Text style={styles.taskAssignee}>👤 {task.assigned_to_name}</Text>}
                    {task.picked_by_name && <Text style={styles.taskAssignee}>🤲 {task.picked_by_name}</Text>}
                    {/* Action buttons based on task status */}
                    {!['completed', 'cancelled'].includes(sale.status) && (
                      <View style={styles.taskActions}>
                        {task.status === 'pending' && (
                          <TouchableOpacity style={styles.taskActionBtn} onPress={() => handleTaskAction(task.id, 'pick', 'pick up')}>
                            <Ionicons name="hand-left-outline" size={14} color={Colors.info} />
                            <Text style={[styles.taskActionText, { color: Colors.info }]}>Pick</Text>
                          </TouchableOpacity>
                        )}
                        {(task.status === 'pending' || task.status === 'assigned') && (
                          <TouchableOpacity style={styles.taskActionBtn} onPress={() => handleTaskAction(task.id, 'start', 'start')}>
                            <Ionicons name="play-outline" size={14} color="#00BCD4" />
                            <Text style={[styles.taskActionText, { color: '#00BCD4' }]}>Start</Text>
                          </TouchableOpacity>
                        )}
                        {task.status === 'in_progress' && (
                          <TouchableOpacity style={[styles.taskActionBtn, { backgroundColor: Colors.success + '15' }]} onPress={() => handleTaskAction(task.id, 'complete', 'complete')}>
                            <Ionicons name="checkmark-circle" size={14} color={Colors.success} />
                            <Text style={[styles.taskActionText, { color: Colors.success }]}>Complete</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    )}
                  </View>
                )}

                {/* Expandable material composition */}
                {isExpanded && hasMaterials && (
                  <View style={styles.bomContainer}>
                    <Text style={styles.bomTitle}>Materials Required:</Text>
                    {item.materials.map((mat, mIdx) => (
                      <View key={mIdx} style={styles.bomRow}>
                        {mat.material_image && (
                          <Image source={{ uri: mat.material_image }} style={{ width: 20, height: 20, borderRadius: 4, marginRight: 4 }} />
                        )}
                        <Text style={styles.bomName}>{mat.material_name}</Text>
                        <Text style={styles.bomQty}>{mat.qty_per_unit * item.quantity} {mat.unit}</Text>
                      </View>
                    ))}
                  </View>
                )}

                {item.from_product_stock ? (
                  <View style={styles.stockBadge}>
                    <Ionicons name="checkmark-circle" size={12} color={Colors.success} />
                    <Text style={styles.stockBadgeText}>From Stock</Text>
                  </View>
                ) : canFulfill ? (
                  <TouchableOpacity
                    style={styles.fulfillBtn}
                    onPress={() => handleFulfillFromStock(item.id, itemName)}
                  >
                    <Ionicons name="cube-outline" size={14} color={Colors.primary} />
                    <Text style={styles.fulfillBtnText}>Fulfill from Stock</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.itemTotal}>₹{Number(itemTotal || 0).toFixed(2)}</Text>
                {item.tax_amount > 0 && <Text style={styles.itemTax}>incl. ₹{item.tax_amount.toFixed(2)} tax</Text>}
              </View>
            </View>
          );
        })}
      </View>

      {/* Production Summary */}
      {sale.production_summary && sale.production_summary.total_tasks > 0 && (
        <View style={[styles.section, { borderLeftWidth: 3, borderLeftColor: sale.production_summary.all_done ? Colors.success : Colors.warning }]}>
          <Text style={styles.sectionTitle}>Production Progress</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {sale.production_summary.completed > 0 && (
              <View style={[styles.taskBadge, { backgroundColor: Colors.success + '20' }]}>
                <Text style={[styles.taskBadgeText, { color: Colors.success }]}>✅ {sale.production_summary.completed} Done</Text>
              </View>
            )}
            {sale.production_summary.in_progress > 0 && (
              <View style={[styles.taskBadge, { backgroundColor: '#00BCD4' + '20' }]}>
                <Text style={[styles.taskBadgeText, { color: '#00BCD4' }]}>🔄 {sale.production_summary.in_progress} In Progress</Text>
              </View>
            )}
            {sale.production_summary.pending > 0 && (
              <View style={[styles.taskBadge, { backgroundColor: Colors.warning + '20' }]}>
                <Text style={[styles.taskBadgeText, { color: Colors.warning }]}>⏳ {sale.production_summary.pending} Pending</Text>
              </View>
            )}
            {sale.production_summary.assigned > 0 && (
              <View style={[styles.taskBadge, { backgroundColor: Colors.info + '20' }]}>
                <Text style={[styles.taskBadgeText, { color: Colors.info }]}>👤 {sale.production_summary.assigned} Assigned</Text>
              </View>
            )}
          </View>
          {sale.production_summary.all_done && (
            <Text style={{ color: Colors.success, fontSize: FontSize.xs, fontWeight: '600', marginTop: 6 }}>All production tasks complete — order can be marked ready</Text>
          )}
        </View>
      )}

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
      {(sale.notes || sale.special_instructions) && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Notes</Text>
          <Text style={styles.infoText}>{sale.notes || sale.special_instructions}</Text>
        </View>
      )}

      {/* Receipt button */}
      <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.primary, alignSelf: 'stretch', marginHorizontal: 0, marginTop: Spacing.md }]} onPress={generateReceipt}>
        <Ionicons name="receipt" size={18} color={Colors.white} />
        <Text style={styles.actionBtnText}>Share Receipt / PDF</Text>
      </TouchableOpacity>

      {/* Order status transitions */}
      {sale.status === 'pending' && (
        <View style={styles.actions}>
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.info, flex: 1 }]} onPress={() => handleStatusTransition('preparing', 'Start Preparing')}>
            <Ionicons name="flame-outline" size={18} color={Colors.white} />
            <Text style={styles.actionBtnText}>Start Preparing</Text>
          </TouchableOpacity>
          {canManage && (
            <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.error }]} onPress={handleCancel}>
              <Ionicons name="close-circle" size={18} color={Colors.white} />
              <Text style={styles.actionBtnText}>Cancel</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      {sale.status === 'preparing' && (
        <View style={styles.actions}>
          {sale.production_summary?.all_done ? (
            <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.success, flex: 1 }]} onPress={() => handleStatusTransition('ready', 'Mark Ready')}>
              <Ionicons name="checkmark-circle-outline" size={18} color={Colors.white} />
              <Text style={styles.actionBtnText}>Mark Ready</Text>
            </TouchableOpacity>
          ) : (
            <View style={[styles.actionBtn, { backgroundColor: Colors.textLight, flex: 1, opacity: 0.6 }]}>
              <Ionicons name="time-outline" size={18} color={Colors.white} />
              <Text style={styles.actionBtnText}>Waiting for Production ({sale.production_summary?.completed || 0}/{sale.production_summary?.total_tasks || 0})</Text>
            </View>
          )}
          {canManage && (
            <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.error }]} onPress={handleCancel}>
              <Ionicons name="close-circle" size={18} color={Colors.white} />
              <Text style={styles.actionBtnText}>Cancel</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      {sale.status === 'ready' && (
        <View style={styles.actions}>
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.success, flex: 1 }]} onPress={() => handleStatusTransition('completed', 'Complete Order')}>
            <Ionicons name="checkmark-done-outline" size={18} color={Colors.white} />
            <Text style={styles.actionBtnText}>Complete Order</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Actions for completed orders */}
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

      {/* Convert Order Type Modal */}
      <Modal visible={convertModalVisible} transparent animationType="slide">
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                Convert to {convertTarget === 'delivery' ? 'Delivery' : 'Pickup'}
              </Text>
              <TouchableOpacity onPress={() => setConvertModalVisible(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>

            {convertTarget === 'delivery' && (
              <>
                <Text style={styles.fieldLabel}>Delivery Address *</Text>
                {convertSavedAddresses.length > 0 && (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                    {convertSavedAddresses.map(addr => (
                      <TouchableOpacity
                        key={addr.id}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.full, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8 }}
                        onPress={() => {
                          const parts = [addr.address_line_1, addr.address_line_2, addr.city, addr.state, addr.pincode].filter(Boolean);
                          setConvertAddress(parts.join(', '));
                        }}
                      >
                        <Ionicons name="location" size={14} color={Colors.primary} />
                        <Text style={{ fontSize: FontSize.xs, color: Colors.text }} numberOfLines={1}>{addr.label || addr.address_line_1}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                )}
                <TextInput
                  style={styles.modalInput}
                  value={convertAddress}
                  onChangeText={setConvertAddress}
                  placeholder="Enter delivery address"
                  placeholderTextColor={Colors.textLight}
                  multiline
                />

                <Text style={styles.fieldLabel}>Delivery Charges (optional)</Text>
                <TextInput
                  style={styles.modalInput}
                  value={convertCharges}
                  onChangeText={setConvertCharges}
                  placeholder="₹ 0"
                  placeholderTextColor={Colors.textLight}
                  keyboardType="numeric"
                />
              </>
            )}

            {convertTarget === 'pickup' && (
              <Text style={styles.convertInfo}>
                This will cancel the delivery assignment and switch to pickup mode. Delivery charges will be removed.
              </Text>
            )}

            <TouchableOpacity style={styles.confirmBtn} onPress={handleConvert}>
              <Ionicons name="swap-horizontal" size={20} color="#fff" />
              <Text style={styles.confirmBtnText}>Convert Order</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
  stockBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  stockBadgeText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.success },
  fulfillBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, backgroundColor: Colors.primary + '15', paddingHorizontal: 8, paddingVertical: 4, borderRadius: BorderRadius.sm, alignSelf: 'flex-start' },
  fulfillBtnText: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.primary },

  // Production task styles
  taskRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6 },
  taskBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12 },
  taskBadgeText: { fontSize: FontSize.xs, fontWeight: '700' },
  taskAssignee: { fontSize: FontSize.xs, color: Colors.textSecondary },
  taskActions: { flexDirection: 'row', gap: 6, marginTop: 2 },
  taskActionBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border },
  taskActionText: { fontSize: FontSize.xs, fontWeight: '700' },

  // BOM / Material composition styles
  bomContainer: { backgroundColor: Colors.background, borderRadius: 8, padding: 8, marginTop: 6, borderWidth: 1, borderColor: Colors.border },
  bomTitle: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.textSecondary, marginBottom: 4 },
  bomRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2 },
  bomName: { flex: 1, fontSize: FontSize.xs, color: Colors.text },
  bomQty: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary },

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

  convertBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.primary + '12', paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: BorderRadius.full,
  },
  convertBtnText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.primary },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: Spacing.lg, maxHeight: '80%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.md },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  fieldLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginTop: Spacing.md, marginBottom: Spacing.xs },
  modalInput: { backgroundColor: Colors.background, borderRadius: BorderRadius.md, padding: Spacing.md, fontSize: FontSize.md, color: Colors.text, borderWidth: 1, borderColor: Colors.border },
  convertInfo: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.md, lineHeight: 20 },
  confirmBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: Colors.primary, paddingVertical: 14, borderRadius: BorderRadius.md, marginTop: Spacing.lg },
  confirmBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '700' },
});
