import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Alert, Modal, TextInput, Platform, KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { formatDate as formatTimestampDate } from '../utils/datetime';
import DateTimePickerModal from '../components/DateTimePickerModal';

export default function CustomerDetailScreen({ route, navigation }) {
  const { user, activeLocation, locations: assignedLocations } = useAuth();
  const { customerId } = route.params;
  const [customer, setCustomer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const canManage = user?.role === 'owner' || user?.role === 'manager';

  // Credit payment modal
  const [showCreditModal, setShowCreditModal] = useState(false);
  const [creditAmount, setCreditAmount] = useState('');
  const [creditMethod, setCreditMethod] = useState('cash');
  const [creditNotes, setCreditNotes] = useState('');
  const [creditLoading, setCreditLoading] = useState(false);

  // Add previous due modal
  const [showAddDueModal, setShowAddDueModal] = useState(false);
  const [dueAmount, setDueAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueNotes, setDueNotes] = useState('');
  const [dueLoading, setDueLoading] = useState(false);
  const [showDueDatePicker, setShowDueDatePicker] = useState(false);
  const [dueDatePickerValue, setDueDatePickerValue] = useState(new Date());

  const handleDueDateConfirm = (selectedDate) => {
    setShowDueDatePicker(false);
    if (selectedDate) {
      const yyyy = selectedDate.getFullYear();
      const mm = String(selectedDate.getMonth() + 1).padStart(2, '0');
      const dd = String(selectedDate.getDate()).padStart(2, '0');
      setDueDate(`${yyyy}-${mm}-${dd}`);
      setDueDatePickerValue(selectedDate);
    }
  };

  // Special date modal
  const [showDateModal, setShowDateModal] = useState(false);
  const [dateLabel, setDateLabel] = useState('');
  const [dateValue, setDateValue] = useState('');
  const [dateLoading, setDateLoading] = useState(false);
  const [locations, setLocations] = useState([]);
  const [selectedLocationId, setSelectedLocationId] = useState(null);

  // Address modal
  const [showAddressModal, setShowAddressModal] = useState(false);
  const [addrLabel, setAddrLabel] = useState('Home');
  const [addrLine1, setAddrLine1] = useState('');
  const [addrLine2, setAddrLine2] = useState('');
  const [addrCity, setAddrCity] = useState('');
  const [addrPincode, setAddrPincode] = useState('');
  const [addrLoading, setAddrLoading] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await api.getCustomer(customerId);
      setCustomer(res.data);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load customer');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [customerId]);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  useEffect(() => {
    const fetchLocations = async () => {
      try {
        const res = await api.getLocations();
        const allLocs = res.data?.locations || res.data || [];
        setLocations(allLocs.filter(l => l.is_active !== 0));
      } catch (err) {
        console.error('Failed to fetch locations:', err);
      }
    };
    fetchLocations();
  }, []);

  useEffect(() => {
    if (showCreditModal && !selectedLocationId) {
      setSelectedLocationId(activeLocation?.id || locations[0]?.id || null);
    }
  }, [showCreditModal, activeLocation, locations]);

  const handleRecordPayment = async () => {
    const amount = parseFloat(creditAmount);
    if (!amount || amount <= 0) return Alert.alert('Error', 'Enter a valid amount');
    setCreditLoading(true);
    try {
      await api.addCreditPayment(customerId, {
        amount,
        method: creditMethod,
        notes: creditNotes,
        location_id: selectedLocationId,
      });
      setShowCreditModal(false);
      setCreditAmount('');
      setCreditNotes('');
      fetchData();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to record payment');
    } finally { setCreditLoading(false); }
  };

  const handleAddPreviousDue = async () => {
    const amount = parseFloat(dueAmount);
    if (!amount || amount <= 0) return Alert.alert('Error', 'Enter a valid amount');
    setDueLoading(true);
    try {
      await api.addPreviousDue(customerId, {
        amount,
        date: dueDate.trim() || undefined,
        notes: dueNotes.trim(),
      });
      setShowAddDueModal(false);
      setDueAmount('');
      setDueDate('');
      setDueNotes('');
      fetchData();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to add previous due');
    } finally { setDueLoading(false); }
  };

  const handleAddSpecialDate = async () => {
    if (!dateLabel.trim() || !dateValue.trim()) return Alert.alert('Error', 'Enter label and date');
    setDateLoading(true);
    try {
      await api.addSpecialDate(customerId, { label: dateLabel.trim(), date: dateValue.trim() });
      setShowDateModal(false);
      setDateLabel('');
      setDateValue('');
      fetchData();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to add special date');
    } finally { setDateLoading(false); }
  };

  const handleDeleteSpecialDate = (id, label) => {
    const doDelete = async () => {
      try {
        await api.deleteSpecialDate(customerId, id);
        fetchData();
      } catch (err) { Alert.alert('Error', err.message); }
    };
    if (Platform.OS === 'web') {
      if (window.confirm(`Remove "${label}"?`)) doDelete();
    } else {
      Alert.alert('Remove Date', `Remove "${label}"?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', onPress: doDelete, style: 'destructive' },
      ]);
    }
  };

  const handleAddAddress = async () => {
    if (!addrLine1.trim()) return Alert.alert('Error', 'Address line 1 is required');
    setAddrLoading(true);
    try {
      await api.addCustomerAddress(customerId, {
        label: addrLabel.trim() || 'Home',
        address_line_1: addrLine1.trim(),
        address_line_2: addrLine2.trim(),
        city: addrCity.trim(),
        pincode: addrPincode.trim(),
      });
      setShowAddressModal(false);
      setAddrLine1(''); setAddrLine2(''); setAddrCity(''); setAddrPincode('');
      fetchData();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to add address');
    } finally { setAddrLoading(false); }
  };

  const handleDeleteAddress = (id, label) => {
    const doDelete = async () => {
      try {
        await api.deleteCustomerAddress(customerId, id);
        fetchData();
      } catch (err) { Alert.alert('Error', err.message); }
    };
    if (Platform.OS === 'web') {
      if (window.confirm(`Delete "${label}" address?`)) doDelete();
    } else {
      Alert.alert('Delete Address', `Delete "${label}" address?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', onPress: doDelete, style: 'destructive' },
      ]);
    }
  };

  const formatDate = (d) => {
    if (!d) return '';
    return formatTimestampDate(d);
  };

  if (loading) {
    return <View style={styles.container}><Text style={styles.loadingText}>Loading...</Text></View>;
  }
  if (!customer) {
    return <View style={styles.container}><Text style={styles.loadingText}>Customer not found</Text></View>;
  }

  const unpaidOrdersSum = (customer.orders || []).reduce((acc, o) => acc + (o.balance_due > 0.01 ? o.balance_due : 0), 0);
  const manualPreviousDue = Math.max(0, (customer.credit_balance || 0) - unpaidOrdersSum);
  const hasPendingBreakup = unpaidOrdersSum > 0.01 || manualPreviousDue > 0.01;

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} colors={[Colors.primary]} />}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.avatarLarge}>
            <Text style={styles.avatarLargeText}>{(customer.name?.[0] || '?').toUpperCase()}</Text>
          </View>
          <Text style={styles.name}>{customer.name}</Text>
          <View style={styles.contactRow}>
            <Ionicons name="call" size={14} color={Colors.textSecondary} />
            <Text style={styles.contactText}>{customer.phone}</Text>
          </View>
          {customer.email && (
            <View style={styles.contactRow}>
              <Ionicons name="mail" size={14} color={Colors.textSecondary} />
              <Text style={styles.contactText}>{customer.email}</Text>
            </View>
          )}
          {canManage && (
            <TouchableOpacity style={styles.editBtn} onPress={() => navigation.navigate('CustomerForm', { customer })}>
              <Ionicons name="pencil" size={14} color={Colors.primary} />
              <Text style={styles.editText}>Edit</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Stats */}
        <View style={styles.statsGrid}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>₹{Number(customer.total_spent || 0).toFixed(0)}</Text>
            <Text style={styles.statLabel}>Total Spent</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, customer.credit_balance > 0 && { color: Colors.error }]}>
              ₹{Number(customer.credit_balance || 0).toFixed(0)}
            </Text>
            <Text style={styles.statLabel}>Due Balance</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{(customer.orders || []).length}</Text>
            <Text style={styles.statLabel}>Orders</Text>
          </View>
        </View>

        {/* Credit Balance Section */}
        {(customer.credit_balance > 0 || canManage) && (
          <View style={styles.creditSection}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Outstanding Dues</Text>
              <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
                {canManage && (
                  <TouchableOpacity style={styles.addBtn} onPress={() => setShowAddDueModal(true)}>
                    <Ionicons name="add-circle" size={16} color={Colors.warning} />
                    <Text style={[styles.addBtnText, { color: Colors.warning }]}>Add Past Due</Text>
                  </TouchableOpacity>
                )}
                {customer.credit_balance > 0 && (
                  <TouchableOpacity style={styles.addBtn} onPress={() => setShowCreditModal(true)}>
                    <Ionicons name="cash" size={16} color={Colors.success} />
                    <Text style={[styles.addBtnText, { color: Colors.success }]}>Record Payment</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
            <View style={styles.dueCard}>
              <Ionicons name="alert-circle" size={20} color={Colors.error} />
              <Text style={styles.dueAmount}>₹{Number(customer.credit_balance).toFixed(2)}</Text>
            </View>
            
            {/* Pending Dues Breakup */}
            {hasPendingBreakup && (
              <View style={{ marginTop: Spacing.sm }}>
                <Text style={[styles.sectionTitle, { marginTop: 0, paddingHorizontal: 0, fontSize: FontSize.sm, color: Colors.textSecondary }]}>
                  Pending Dues Breakup:
                </Text>
                
                {manualPreviousDue > 0.01 && (
                  <View style={[styles.orderCard, { marginHorizontal: 0, borderColor: Colors.warning + '30', backgroundColor: Colors.warning + '05', paddingVertical: Spacing.md }]}>
                    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
                      <Ionicons name="time" size={18} color={Colors.warning} style={{ marginRight: Spacing.sm }} />
                      <View>
                        <Text style={[styles.orderNumber, { color: Colors.warning }]}>Legacy / Manual Pending Dues</Text>
                        <Text style={styles.orderMeta}>Accumulated from past records</Text>
                      </View>
                    </View>
                    <View style={{ alignItems: 'flex-end', marginRight: Spacing.xs }}>
                      <Text style={[styles.orderTotal, { color: Colors.warning }]}>Due: ₹{Number(manualPreviousDue).toFixed(0)}</Text>
                    </View>
                  </View>
                )}

                {(customer.orders || []).filter(o => o.balance_due > 0.01).map(order => (
                  <TouchableOpacity
                    key={`due-${order.id}`}
                    style={[styles.orderCard, { marginHorizontal: 0, borderColor: Colors.error + '30', backgroundColor: Colors.error + '05' }]}
                    onPress={() => navigation.navigate('SaleDetail', { saleId: order.id })}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.orderNumber}>{order.sale_number}</Text>
                      <Text style={styles.orderMeta}>{formatDate(order.created_at)}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end', marginRight: Spacing.xs }}>
                      <Text style={[styles.orderTotal, { color: Colors.error }]}>Due: ₹{Number(order.balance_due).toFixed(0)}</Text>
                      <Text style={styles.orderMeta}>Total: ₹{Number(order.grand_total || 0).toFixed(0)}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={Colors.textLight} />
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>

        )}

        {/* Credit payment history */}
        {(customer.credit_payments || []).length > 0 && (
          <>
            <View style={[styles.sectionHeader, { marginBottom: Spacing.xs }]}>
              <Text style={[styles.sectionTitle, { marginTop: 0, paddingHorizontal: 0 }]}>Payment History</Text>
            </View>
            {customer.credit_payments.slice(0, 5).map((cp) => (
              <View key={cp.id} style={[styles.historyCard, cp.amount < 0 && { borderColor: Colors.warning + '50', backgroundColor: Colors.warning + '05' }]}>
                <View style={{ flex: 1 }}>
                  {cp.amount < 0 ? (
                    <Text style={[styles.historyAmount, { color: Colors.warning }]}>
                      ₹{Math.abs(Number(cp.amount)).toFixed(2)} — PAST DUE ADDED
                    </Text>
                  ) : (
                    <Text style={styles.historyAmount}>
                      ₹{Number(cp.amount).toFixed(2)} — {(cp.method || 'cash').toUpperCase()}
                    </Text>
                  )}
                  <Text style={styles.historyMeta}>
                    {formatDate(cp.created_at)} • by {cp.received_by_name || 'Unknown'} {cp.location_name ? `• ${cp.location_name}` : ''}
                  </Text>
                  {cp.notes ? <Text style={styles.historyNotes}>{cp.notes}</Text> : null}
                </View>
                {cp.amount < 0 ? (
                  <Ionicons name="alert-circle" size={18} color={Colors.warning} />
                ) : (
                  <Ionicons name="checkmark-circle" size={18} color={Colors.success} />
                )}
              </View>
            ))}
            {(customer.credit_payments || []).length > 5 && (
              <TouchableOpacity 
                style={{ alignItems: 'center', paddingVertical: Spacing.md }}
                onPress={() => navigation.navigate('CustomerCreditRecords', { customerId: customer.id, customerName: customer.name })}
              >
                <Text style={{ color: Colors.primary, fontSize: FontSize.sm, fontWeight: '600' }}>View All Records</Text>
              </TouchableOpacity>
            )}
          </>
        )}

        {/* Special Dates */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Special Dates</Text>
          <TouchableOpacity style={styles.addBtn} onPress={() => setShowDateModal(true)}>
            <Ionicons name="add-circle" size={16} color={Colors.primary} />
            <Text style={styles.addBtnText}>Add</Text>
          </TouchableOpacity>
        </View>
        {customer.birthday && (
          <View style={styles.dateCard}>
            <Ionicons name="gift" size={18} color={Colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.dateLabel}>Birthday</Text>
              <Text style={styles.dateValue}>{formatDate(customer.birthday)}</Text>
            </View>
          </View>
        )}
        {customer.anniversary && (
          <View style={styles.dateCard}>
            <Ionicons name="heart" size={18} color={Colors.error} />
            <View style={{ flex: 1 }}>
              <Text style={styles.dateLabel}>Anniversary</Text>
              <Text style={styles.dateValue}>{formatDate(customer.anniversary)}</Text>
            </View>
          </View>
        )}
        {(customer.special_dates || []).map((sd) => (
          <View key={sd.id} style={styles.dateCard}>
            <Ionicons name="calendar" size={18} color={Colors.warning} />
            <View style={{ flex: 1 }}>
              <Text style={styles.dateLabel}>{sd.label}</Text>
              <Text style={styles.dateValue}>{sd.date}</Text>
            </View>
            <TouchableOpacity onPress={() => handleDeleteSpecialDate(sd.id, sd.label)}>
              <Ionicons name="close-circle" size={20} color={Colors.error} />
            </TouchableOpacity>
          </View>
        ))}
        {!customer.birthday && !customer.anniversary && (customer.special_dates || []).length === 0 && (
          <View style={styles.emptySection}><Text style={styles.emptyText}>No special dates added</Text></View>
        )}

        {/* Addresses */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Addresses</Text>
          <TouchableOpacity style={styles.addBtn} onPress={() => setShowAddressModal(true)}>
            <Ionicons name="add-circle" size={16} color={Colors.primary} />
            <Text style={styles.addBtnText}>Add</Text>
          </TouchableOpacity>
        </View>
        {(customer.addresses || []).length === 0 ? (
          <View style={styles.emptySection}><Text style={styles.emptyText}>No addresses added</Text></View>
        ) : (
          customer.addresses.map((addr) => (
            <View key={addr.id} style={styles.addressCard}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={styles.addressLabel}>{addr.label}</Text>
                  {addr.is_default ? (
                    <View style={styles.defaultBadge}><Text style={styles.defaultText}>Default</Text></View>
                  ) : null}
                </View>
                <Text style={styles.addressLine}>{addr.address_line_1}</Text>
                {addr.address_line_2 ? <Text style={styles.addressLine}>{addr.address_line_2}</Text> : null}
                {addr.city ? <Text style={styles.addressLine}>{addr.city}{addr.pincode ? ` - ${addr.pincode}` : ''}</Text> : null}
              </View>
              <TouchableOpacity onPress={() => handleDeleteAddress(addr.id, addr.label)}>
                <Ionicons name="trash-outline" size={18} color={Colors.error} />
              </TouchableOpacity>
            </View>
          ))
        )}

        {/* Order History */}
        <Text style={styles.sectionTitle}>Recent Orders</Text>
        {(customer.orders || []).length === 0 ? (
          <View style={styles.emptySection}><Text style={styles.emptyText}>No orders yet</Text></View>
        ) : (
          customer.orders.map((order) => (
            <TouchableOpacity
              key={order.id}
              style={styles.orderCard}
              onPress={() => navigation.navigate('SaleDetail', { saleId: order.id })}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.orderNumber}>{order.sale_number}</Text>
                <Text style={styles.orderMeta}>{formatDate(order.created_at)} • {order.order_type?.replace(/_/g, ' ')}</Text>
                {order.order_type === 'delivery' && (order.sender_same_as_receiver !== 1 && order.sender_same_as_receiver !== true) && (order.receiver_name || order.receiver_phone) ? (
                  <Text style={styles.orderMeta}>
                    To: {order.receiver_name || 'Receiver'}{order.receiver_phone ? ` • ${order.receiver_phone}` : ''}
                  </Text>
                ) : null}
                {order.order_type === 'delivery' && order.delivery_address ? (
                  <Text style={styles.orderMeta} numberOfLines={1}>Address: {order.delivery_address}</Text>
                ) : null}
              </View>
              <Text style={styles.orderTotal}>₹{Number(order.grand_total || 0).toFixed(0)}</Text>
              <Ionicons name="chevron-forward" size={16} color={Colors.textLight} />
            </TouchableOpacity>
          ))
        )}

        {/* Notes */}
        {customer.notes ? (
          <>
            <Text style={styles.sectionTitle}>Notes</Text>
            <View style={styles.notesCard}>
              <Text style={styles.notesText}>{customer.notes}</Text>
            </View>
          </>
        ) : null}
      </ScrollView>

      {/* Credit Payment Modal */}
      <Modal visible={showCreditModal} transparent animationType="slide">
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Record Payment</Text>
              <TouchableOpacity onPress={() => setShowCreditModal(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalSubtext}>Outstanding: ₹{Number(customer.credit_balance || 0).toFixed(2)}</Text>
            <Text style={styles.fieldLabel}>Amount (₹)</Text>
            <TextInput style={styles.modalInput} value={creditAmount} onChangeText={setCreditAmount}
              keyboardType="decimal-pad" placeholder="0" placeholderTextColor={Colors.textLight} />
            <Text style={styles.fieldLabel}>Method</Text>
            <View style={styles.methodRow}>
              {['cash', 'card', 'upi'].map((m) => (
                <TouchableOpacity key={m} style={[styles.methodChip, creditMethod === m && styles.methodActive]}
                  onPress={() => setCreditMethod(m)}>
                  <Text style={[styles.methodText, creditMethod === m && styles.methodTextActive]}>{m.toUpperCase()}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.fieldLabel}>Location</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.methodRow}>
              {locations.map((loc) => (
                <TouchableOpacity key={loc.id} style={[styles.methodChip, selectedLocationId === loc.id && styles.methodActive]}
                  onPress={() => setSelectedLocationId(loc.id)}>
                  <Text style={[styles.methodText, selectedLocationId === loc.id && styles.methodTextActive]}>{loc.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <Text style={styles.fieldLabel}>Notes (optional)</Text>
            <TextInput style={styles.modalInput} value={creditNotes} onChangeText={setCreditNotes}
              placeholder="Payment notes" placeholderTextColor={Colors.textLight} />
            <TouchableOpacity style={[styles.submitBtn, creditLoading && { opacity: 0.6 }]}
              onPress={handleRecordPayment} disabled={creditLoading}>
              <Text style={styles.submitText}>{creditLoading ? 'Recording...' : 'Record Payment'}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Add Previous Due Modal */}
      <Modal visible={showAddDueModal} transparent animationType="fade">
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={[styles.modalCard, { padding: 0, overflow: 'hidden' }]}>
            <View style={{ backgroundColor: Colors.warning + '15', padding: Spacing.lg, borderBottomWidth: 1, borderBottomColor: Colors.warning + '30', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.sm }}>
                <View style={{ backgroundColor: Colors.warning + '30', padding: 8, borderRadius: 12 }}>
                  <Ionicons name="document-text" size={20} color={Colors.warning} />
                </View>
                <View>
                  <Text style={[styles.modalTitle, { marginBottom: 0, color: Colors.warning }]}>Add Past Due</Text>
                  <Text style={[styles.modalSubtext, { marginBottom: 0, color: Colors.textSecondary, fontSize: FontSize.xs }]}>Add historical dues from paper records</Text>
                </View>
              </View>
              <TouchableOpacity onPress={() => setShowAddDueModal(false)} style={{ padding: 4 }}>
                <Ionicons name="close" size={24} color={Colors.textLight} />
              </TouchableOpacity>
            </View>

            <View style={{ padding: Spacing.lg, gap: Spacing.md }}>
              <View>
                <Text style={styles.fieldLabel}>Amount (₹) *</Text>
                <View style={[styles.modalInput, { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.md, height: 60, backgroundColor: Colors.background, borderColor: Colors.border, borderWidth: 1, borderRadius: BorderRadius.md }]}>
                  <Text style={{ fontSize: 24, color: Colors.textLight, marginRight: 8, fontWeight: '600' }}>₹</Text>
                  <TextInput 
                    style={{ flex: 1, fontSize: 24, fontWeight: '700', color: Colors.text }}
                    value={dueAmount} 
                    onChangeText={setDueAmount}
                    keyboardType="decimal-pad" 
                    placeholder="0" 
                    placeholderTextColor={Colors.textLight} 
                  />
                </View>
              </View>

              <View>
                <Text style={styles.fieldLabel}>Date of Record</Text>
                <TouchableOpacity 
                  style={[styles.modalInput, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}
                  onPress={() => setShowDueDatePicker(true)}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Ionicons name="calendar-outline" size={18} color={dueDate ? Colors.primary : Colors.textLight} />
                    <Text style={{ color: dueDate ? Colors.text : Colors.textLight, fontSize: FontSize.md }}>
                      {dueDate ? formatTimestampDate(dueDate) : 'Today (Default)'}
                    </Text>
                  </View>
                  <Ionicons name="chevron-down" size={16} color={Colors.textLight} />
                </TouchableOpacity>
              </View>

              <View>
                <Text style={styles.fieldLabel}>Notes / Details</Text>
                <View style={[styles.modalInput, { height: 90, paddingVertical: Spacing.sm, flexDirection: 'row' }]}>
                  <Ionicons name="pencil-outline" size={16} color={Colors.textLight} style={{ marginTop: 2, marginRight: 8 }} />
                  <TextInput 
                    style={{ flex: 1, textAlignVertical: 'top', color: Colors.text, fontSize: FontSize.md }}
                    value={dueNotes} 
                    onChangeText={setDueNotes}
                    placeholder="Items, details from paper ledger..." 
                    placeholderTextColor={Colors.textLight} 
                    multiline 
                  />
                </View>
              </View>

              <TouchableOpacity 
                style={[styles.submitBtn, { backgroundColor: Colors.warning, marginTop: Spacing.sm, height: 50, borderRadius: BorderRadius.md, elevation: 2, shadowColor: Colors.warning, shadowOffset: {width:0, height:2}, shadowOpacity: 0.2, shadowRadius: 4 }, dueLoading && { opacity: 0.7 }]}
                onPress={handleAddPreviousDue} 
                disabled={dueLoading}
              >
                <Ionicons name="save-outline" size={18} color={Colors.white} style={{ marginRight: 8 }} />
                <Text style={[styles.submitText, { color: Colors.white, fontSize: FontSize.md, fontWeight: '600' }]}>
                  {dueLoading ? 'Saving...' : 'Save Record'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <DateTimePickerModal
        visible={showDueDatePicker}
        mode="date"
        value={dueDatePickerValue}
        onConfirm={handleDueDateConfirm}
        onCancel={() => setShowDueDatePicker(false)}
      />

      {/* Special Date Modal */}
      <Modal visible={showDateModal} transparent animationType="slide">
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Special Date</Text>
              <TouchableOpacity onPress={() => setShowDateModal(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>
            <Text style={styles.fieldLabel}>Label</Text>
            <TextInput style={styles.modalInput} value={dateLabel} onChangeText={setDateLabel}
              placeholder="e.g. Mom's Birthday" placeholderTextColor={Colors.textLight} />
            <Text style={styles.fieldLabel}>Date (MM-DD)</Text>
            <TextInput style={styles.modalInput} value={dateValue} onChangeText={setDateValue}
              placeholder="e.g. 03-15" placeholderTextColor={Colors.textLight} keyboardType="numbers-and-punctuation" />
            <TouchableOpacity style={[styles.submitBtn, dateLoading && { opacity: 0.6 }]}
              onPress={handleAddSpecialDate} disabled={dateLoading}>
              <Text style={styles.submitText}>{dateLoading ? 'Adding...' : 'Add Date'}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Address Modal */}
      <Modal visible={showAddressModal} transparent animationType="slide">
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Address</Text>
              <TouchableOpacity onPress={() => setShowAddressModal(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <Text style={styles.fieldLabel}>Label</Text>
              <View style={styles.methodRow}>
                {['Home', 'Office', 'Temple', 'Other'].map((l) => (
                  <TouchableOpacity key={l} style={[styles.methodChip, addrLabel === l && styles.methodActive]}
                    onPress={() => setAddrLabel(l)}>
                    <Text style={[styles.methodText, addrLabel === l && styles.methodTextActive]}>{l}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.fieldLabel}>Address Line 1 *</Text>
              <TextInput style={styles.modalInput} value={addrLine1} onChangeText={setAddrLine1}
                placeholder="Street, building" placeholderTextColor={Colors.textLight} />
              <Text style={styles.fieldLabel}>Address Line 2</Text>
              <TextInput style={styles.modalInput} value={addrLine2} onChangeText={setAddrLine2}
                placeholder="Area, landmark" placeholderTextColor={Colors.textLight} />
              <Text style={styles.fieldLabel}>City</Text>
              <TextInput style={styles.modalInput} value={addrCity} onChangeText={setAddrCity}
                placeholder="City" placeholderTextColor={Colors.textLight} />
              <Text style={styles.fieldLabel}>Pincode</Text>
              <TextInput style={styles.modalInput} value={addrPincode} onChangeText={setAddrPincode}
                placeholder="Pincode" placeholderTextColor={Colors.textLight} keyboardType="number-pad" />
              <TouchableOpacity style={[styles.submitBtn, addrLoading && { opacity: 0.6 }]}
                onPress={handleAddAddress} disabled={addrLoading}>
                <Text style={styles.submitText}>{addrLoading ? 'Adding...' : 'Add Address'}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { paddingBottom: 40 },
  loadingText: { textAlign: 'center', marginTop: 80, color: Colors.textLight, fontSize: FontSize.md },
  header: {
    alignItems: 'center', padding: Spacing.lg,
    backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  avatarLarge: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: Colors.primary + '15', justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.sm,
  },
  avatarLargeText: { fontSize: 28, fontWeight: '700', color: Colors.primary },
  name: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  contactText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  editBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs, borderRadius: BorderRadius.full,
    borderWidth: 1, borderColor: Colors.primary,
  },
  editText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },
  statsGrid: {
    flexDirection: 'row', padding: Spacing.md, gap: Spacing.sm,
  },
  statCard: {
    flex: 1, alignItems: 'center', padding: Spacing.md,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    borderWidth: 1, borderColor: Colors.border,
  },
  statValue: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  statLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  creditSection: { paddingHorizontal: Spacing.md, marginBottom: Spacing.sm },
  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.md, marginTop: Spacing.lg, marginBottom: Spacing.sm,
  },
  sectionTitle: {
    fontSize: FontSize.md, fontWeight: '700', color: Colors.text,
    paddingHorizontal: Spacing.md, marginTop: Spacing.lg, marginBottom: Spacing.sm,
  },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  addBtnText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },
  dueCard: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.error + '10', borderRadius: BorderRadius.lg,
    padding: Spacing.md, borderWidth: 1, borderColor: Colors.error + '30',
  },
  dueAmount: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.error },
  historyCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginHorizontal: Spacing.md, marginBottom: Spacing.xs,
    borderWidth: 1, borderColor: Colors.border,
  },
  historyAmount: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  historyMeta: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  historyNotes: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2, fontStyle: 'italic' },
  dateCard: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginHorizontal: Spacing.md, marginBottom: Spacing.xs,
    borderWidth: 1, borderColor: Colors.border,
  },
  dateLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  dateValue: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  addressCard: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginHorizontal: Spacing.md, marginBottom: Spacing.xs,
    borderWidth: 1, borderColor: Colors.border,
  },
  addressLabel: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },
  addressLine: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 1 },
  defaultBadge: {
    paddingHorizontal: 6, paddingVertical: 1, borderRadius: BorderRadius.full,
    backgroundColor: Colors.primary + '15',
  },
  defaultText: { fontSize: FontSize.xs - 1, color: Colors.primary, fontWeight: '600' },
  orderCard: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginHorizontal: Spacing.md, marginBottom: Spacing.xs,
    borderWidth: 1, borderColor: Colors.border,
  },
  orderNumber: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  orderMeta: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  orderTotal: { fontSize: FontSize.md, fontWeight: '700', color: Colors.success },
  emptySection: {
    alignItems: 'center', padding: Spacing.md, marginHorizontal: Spacing.md,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, borderWidth: 1, borderColor: Colors.border,
  },
  emptyText: { fontSize: FontSize.sm, color: Colors.textLight },
  notesCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginHorizontal: Spacing.md,
    borderWidth: 1, borderColor: Colors.border,
  },
  notesText: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 },
  // Modals
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.xl, borderTopRightRadius: BorderRadius.xl,
    padding: Spacing.lg, maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.md,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  modalSubtext: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.md },
  fieldLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, marginBottom: Spacing.xs, marginTop: Spacing.sm },
  modalInput: {
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    padding: Spacing.sm, fontSize: FontSize.sm, color: Colors.text,
    borderWidth: 1, borderColor: Colors.border,
  },
  methodRow: { flexDirection: 'row', gap: Spacing.sm, flexWrap: 'wrap' },
  methodChip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.full, backgroundColor: Colors.background,
    borderWidth: 1, borderColor: Colors.border,
  },
  methodActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  methodText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  methodTextActive: { color: Colors.white },
  submitBtn: {
    backgroundColor: Colors.primary, borderRadius: BorderRadius.md,
    padding: Spacing.sm + 2, alignItems: 'center', marginTop: Spacing.lg,
  },
  submitText: { fontSize: FontSize.md, fontWeight: '600', color: Colors.white },
});
