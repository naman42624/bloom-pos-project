import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, Alert, Platform, ActivityIndicator, KeyboardAvoidingView,
  FlatList, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePickerModal from '../components/DateTimePickerModal';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { Image } from 'react-native';
import ImageModal from '../components/ImageModal';

const ORDER_TYPES = [
  { key: 'walk_in', label: 'Walk-in', icon: 'walk' },
  { key: 'pickup', label: 'Pickup', icon: 'bag-handle' },
  { key: 'delivery', label: 'Delivery', icon: 'bicycle' },
  { key: 'pre_order', label: 'Pre-order', icon: 'calendar' },
];

const PAYMENT_METHODS = [
  { key: 'cash', label: 'Cash', icon: 'cash' },
  { key: 'card', label: 'Card', icon: 'card' },
  { key: 'upi', label: 'UPI', icon: 'phone-portrait' },
];

export default function CheckoutScreen({ route, navigation }) {
  const { cart: initialCart, locationId, orderType: initialOrderType, customerName: initName, customerPhone: initPhone, customerAddress: initAddress } = route.params;
  const { user } = useAuth();

  const [cart, setCart] = useState(initialCart || []);
  const [orderType, setOrderType] = useState(initialOrderType || 'walk_in');
  const [customerName, setCustomerName] = useState(initName || '');
  const [customerPhone, setCustomerPhone] = useState(initPhone || '');
  const [customerId, setCustomerId] = useState(null);
  const [discountType, setDiscountType] = useState('fixed');
  const [discountValue, setDiscountValue] = useState('');
  const [deliveryCharges, setDeliveryCharges] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Customer lookup
  const [customerHistory, setCustomerHistory] = useState(null);
  // Customer search dropdown
  const [customerSuggestions, setCustomerSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchTimer = useRef(null);
  // Saved addresses
  const [savedAddresses, setSavedAddresses] = useState([]);
  const [showAddressPicker, setShowAddressPicker] = useState(false);

  // Scheduled date/time — for pickup, delivery, and pre-order
  const [scheduledDate, setScheduledDate] = useState(route.params?.scheduledDate || '');
  const [scheduledTime, setScheduledTime] = useState(route.params?.scheduledTime || '');
  const [datePickerDate, setDatePickerDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  // Pre-order sub-type (pickup or delivery)
  const [preOrderType, setPreOrderType] = useState('pickup');
  const [advanceAmount, setAdvanceAmount] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState(initAddress || '');
  // Sender info — for delivery orders
  const [senderName, setSenderName] = useState('');
  const [senderPhone, setSenderPhone] = useState('');
  const [senderMessage, setSenderMessage] = useState('');

  // Payment mode: 'pay_now' (default), 'cod' (delivery), 'credit' (customer credit), 'partial' (advance + rest later)
  const [paymentMode, setPaymentMode] = useState('pay_now');

  // Register guard — checked at submit time via handleSubmit
  const [registerOpen, setRegisterOpen] = useState(null); // null = not yet checked
  const checkRegisterStatus = useCallback(async () => {
    try {
      const res = await api.getRegisterStatus(locationId);
      setRegisterOpen(res.isOpen === true);
      return res.isOpen === true;
    } catch { setRegisterOpen(false); return false; }
  }, [locationId]);

  // Split payment — array of payment entries
  const [payments, setPayments] = useState([
    { method: 'cash', amount: '', reference: '' },
  ]);

  // Customize Component States
  const [showCustomize, setShowCustomize] = useState(false);
  const [customProduct, setCustomProduct] = useState(null); // The cart item to customize
  const [customCartIndex, setCustomCartIndex] = useState(-1);
  const [customCharge, setCustomCharge] = useState('');
  const [customMaterials, setCustomMaterials] = useState([]);
  const [customSpecialInstructions, setCustomSpecialInstructions] = useState('');
  const [customSubmitting, setCustomSubmitting] = useState(false);
  const [allMaterialsList, setAllMaterialsList] = useState([]);
  const [viewedImage, setViewedImage] = useState(null);

  // Material search modal
  const [showMaterialPicker, setShowMaterialPicker] = useState(false);
  const [materialSearch, setMaterialSearch] = useState('');
  const [editingMaterialIdx, setEditingMaterialIdx] = useState(null);

  const openCustomize = async (item, index) => {
    setCustomProduct(item);
    setCustomCartIndex(index);
    setCustomCharge('');
    setCustomSpecialInstructions(item.special_instructions || '');
    setShowCustomize(true);

    // Load all materials list for the picker
    let materialsList = allMaterialsList;
    if (allMaterialsList.length === 0) {
      try {
        const res = await api.getMaterials();
        materialsList = res.data.filter(m => m.is_active !== 0);
        setAllMaterialsList(materialsList);
      } catch {}
    }

    // If item already has custom_materials, use those (preserve previous customizations)
    if (item.custom_materials && item.custom_materials.length > 0) {
      setCustomMaterials(item.custom_materials.map(m => ({
        material_id: m.material_id,
        name: m.name || materialsList.find(mat => mat.id === m.material_id)?.name || 'Material #' + m.material_id,
        qty: String(m.qty_per_unit || m.qty || 1),
      })));
      return;
    }

    // Otherwise fetch base product materials as defaults
    try {
      const res = await api.getProductMaterials(item.product_id);
      if (res.success && res.data) {
        setCustomMaterials(res.data.map(m => {
          const matInfo = materialsList.find(mat => mat.id === m.material_id);
          return {
            material_id: m.material_id,
            name: matInfo?.name || m.material_name || 'Material #' + m.material_id,
            qty: String(m.quantity || 1)
          };
        }));
      } else {
        setCustomMaterials([]);
      }
    } catch (e) {
      console.log('Failed to fetch product materials:', e);
      setCustomMaterials([]);
    }
  };

  const openMaterialPicker = (matIdx) => {
    setEditingMaterialIdx(matIdx);
    setMaterialSearch('');
    setShowMaterialPicker(true);
  };

  const handleCustomize = () => {
    const charge = parseFloat(customCharge) || 0;
    const mats = customMaterials.filter(m => m.material_id && parseFloat(m.qty) > 0).map(m => ({
      material_id: m.material_id, name: m.name, qty_per_unit: parseFloat(m.qty)
    }));

    const newCart = [...cart];
    newCart[customCartIndex] = {
      ...newCart[customCartIndex],
      unit_price: (newCart[customCartIndex].unit_price || 0) + charge,
      special_instructions: customSpecialInstructions,
      custom_materials: mats,
      product_name: charge > 0
        ? `${newCart[customCartIndex].product_name} (Custom +₹${charge})`
        : newCart[customCartIndex].product_name,
    };
    setCart(newCart);
    setShowCustomize(false);
  };

  const subtotal = cart.reduce((s, c) => s + (c.unit_price * c.quantity), 0);
  const taxTotal = cart.reduce((s, c) => s + ((c.unit_price * c.quantity * c.tax_rate) / 100), 0);

  const discount = useMemo(() => {
    const val = parseFloat(discountValue) || 0;
    if (discountType === 'percentage') return Math.min(subtotal * val / 100, subtotal);
    return Math.min(val, subtotal);
  }, [discountType, discountValue, subtotal]);

  const needsDelivery = orderType === 'delivery' || (orderType === 'pre_order' && preOrderType === 'delivery');
  const delivery = needsDelivery ? (parseFloat(deliveryCharges) || 0) : 0;
  const grandTotal = Math.max(0, subtotal - discount) + taxTotal + delivery;

  const totalPaymentEntered = payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);

  // Reset payment mode if switching away from delivery/pickup
  React.useEffect(() => {
    if (paymentMode === 'cod' && !needsDelivery) {
      setPaymentMode('pay_now');
    }
    if (paymentMode === 'partial' && orderType === 'walk_in') {
      setPaymentMode('pay_now');
    }
  }, [needsDelivery, orderType, paymentMode]);

  // Auto-fill customer name from phone + search dropdown
  const handlePhoneChange = useCallback((text) => {
    setCustomerPhone(text);
    setShowSuggestions(false);

    // Debounced search for autocomplete
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (text.length >= 3 && text.length < 10) {
      searchTimer.current = setTimeout(async () => {
        try {
          const res = await api.customerSearch(text);
          if (res.data && res.data.length > 0) {
            setCustomerSuggestions(res.data);
            setShowSuggestions(true);
          } else {
            setCustomerSuggestions([]);
            setShowSuggestions(false);
          }
        } catch { /* ignore */ }
      }, 300);
    } else {
      setCustomerSuggestions([]);
    }
  }, []);

  const selectCustomer = useCallback((c) => {
    setCustomerPhone(c.phone || '');
    setCustomerName(c.name || '');
    if (c.id) setCustomerId(c.id);
    setShowSuggestions(false);
    setCustomerSuggestions([]);
  }, []);

  React.useEffect(() => {
    if (customerPhone.length >= 10) {
      (async () => {
        try {
          const res = await api.customerLookupEnhanced(customerPhone);
          if (res.data) {
            setCustomerHistory(res.data);
            if (res.data.is_registered) setCustomerId(res.data.id);
            if (!customerName && res.data.name) {
              setCustomerName(res.data.name);
            }
          } else {
            setCustomerHistory(null);
            setCustomerId(null);
          }
        } catch {
          setCustomerHistory(null);
          setCustomerId(null);
        }
      })();
    } else {
      setCustomerHistory(null);
      setCustomerId(null);
    }
  }, [customerPhone]);

  // Load saved addresses when customer is identified
  const loadSavedAddresses = useCallback(async () => {
    if (!customerId) return;
    try {
      const res = await api.getCustomerAddresses(customerId);
      if (res.data) setSavedAddresses(res.data);
    } catch { /* ignore */ }
  }, [customerId]);

  React.useEffect(() => {
    if (customerId) loadSavedAddresses();
    else setSavedAddresses([]);
  }, [customerId]);

  const addPaymentSplit = () => {
    setPayments([...payments, { method: 'card', amount: '', reference: '' }]);
  };

  const removePaymentSplit = (idx) => {
    if (payments.length <= 1) return;
    setPayments(payments.filter((_, i) => i !== idx));
  };

  const updatePayment = (idx, field, value) => {
    setPayments(payments.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  };

  const handleSubmit = async () => {
    if (submitting) return;

    // Register guard — check at submit time (not on focus)
    const isOpen = await checkRegisterStatus();
    if (!isOpen) {
      Alert.alert(
        'Register Closed',
        `The cash register for this location is not open. Please open it before creating a sale.`,
        [
          { text: 'Open Register', onPress: () => navigation.navigate('CashRegister') },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
      return;
    }

    if (orderType === 'pre_order' && !scheduledDate) {
      Alert.alert('Required', 'Please enter a scheduled date for pre-order');
      return;
    }
    if (needsDelivery && !deliveryAddress) {
      Alert.alert('Required', 'Please enter a delivery address');
      return;
    }

    // Credit requires customer
    if (paymentMode === 'credit' && !customerId) {
      Alert.alert('Required', 'Credit sales require a registered customer. Please enter customer phone.');
      return;
    }

    // Build payments array
    const advance = parseFloat(advanceAmount) || 0;
    const isPreOrderWithAdvance = orderType === 'pre_order' && advance > 0;
    const isCodOrCredit = paymentMode === 'cod' || paymentMode === 'credit';
    const isPartial = paymentMode === 'partial';

    // Partial requires advance amount
    if (isPartial && advance <= 0) {
      Alert.alert('Required', 'Please enter an advance payment amount');
      return;
    }
    if (isPartial && advance >= grandTotal) {
      Alert.alert('Invalid', 'Advance amount must be less than the total. Use "Pay Now" for full payment.');
      return;
    }

    let paymentEntries;
    if (isCodOrCredit) {
      paymentEntries = []; // No upfront payment for COD/Credit
    } else if (isPartial) {
      // Partial: use the first payment entry with the advance amount
      paymentEntries = [{
        method: payments[0].method,
        amount: advance,
        reference_number: payments[0].reference || null,
      }];
    } else {
      paymentEntries = payments.map((p, idx) => ({
        method: p.method,
        amount: isPreOrderWithAdvance && idx === 0
          ? advance
          : (parseFloat(p.amount) || (payments.length === 1 ? grandTotal : 0)),
        reference_number: p.reference || null,
      })).filter(p => p.amount > 0);
    }

    if (paymentEntries.length === 0 && !isPreOrderWithAdvance && !isCodOrCredit && !isPartial) {
      Alert.alert('Payment', 'Please enter payment amount');
      return;
    }

    const saleData = {
      location_id: locationId,
      order_type: orderType,
      customer_id: customerId || null,
      customer_name: customerName || null,
      customer_phone: customerPhone || null,
      discount_type: discount > 0 ? discountType : null,
      discount_value: discount > 0
        ? (discountType === 'percentage' ? (parseFloat(discountValue) || 0) : discount)
        : 0,
      delivery_charges: delivery,
      notes: notes || null,
      delivery_address: needsDelivery ? deliveryAddress : null,
      sender_name: needsDelivery ? (senderName || null) : null,
      sender_phone: needsDelivery ? (senderPhone || null) : null,
      sender_message: needsDelivery ? (senderMessage || null) : null,
      scheduled_date: scheduledDate || null,
      scheduled_time: scheduledTime || null,
      items: cart.map((c) => ({
        product_id: c.product_id || null,
        material_id: c.material_id || null,
        product_name: c.product_name,
        product_sku: c.product_sku,
        quantity: c.quantity,
        unit_price: c.unit_price,
        tax_rate: c.tax_rate,
        special_instructions: c.special_instructions || '',
        image_url: c.image_url || '',
        custom_materials: c.custom_materials || null,
      })),
      payments: paymentEntries,
    };

    if (orderType === 'pre_order') {
      saleData.pre_order = {
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime || null,
        advance_amount: advance,
        remaining_amount: grandTotal - advance,
        delivery_address: needsDelivery ? deliveryAddress : null,
        special_instructions: notes || null,
      };
      saleData.advance_amount = advance;
    }

    setSubmitting(true);
    try {
      const res = await api.createSale(saleData);
      if (res.success) {
        navigation.replace('SaleDetail', { saleId: res.data.id });
      } else {
        Alert.alert('Error', res.message || 'Failed to create sale');
      }
    } catch (err) {
      Alert.alert('Error', err.message || 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const showScheduledFields = orderType === 'pickup' || orderType === 'delivery' || orderType === 'pre_order';

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Order Type */}
        <Text style={styles.sectionTitle}>Order Type</Text>
        <View style={styles.chipRow}>
          {ORDER_TYPES.map((t) => (
            <TouchableOpacity
              key={t.key}
              style={[styles.chip, orderType === t.key && styles.chipActive]}
              onPress={() => setOrderType(t.key)}
            >
              <Ionicons name={t.icon} size={20} color={orderType === t.key ? Colors.white : Colors.textSecondary} />
              <Text style={[styles.chipText, orderType === t.key && styles.chipTextActive]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Pre-order sub-type */}
        {orderType === 'pre_order' && (
          <>
            <Text style={styles.sectionTitle}>Pre-order Type</Text>
            <View style={styles.chipRow}>
              <TouchableOpacity
                style={[styles.chip, preOrderType === 'pickup' && styles.chipActive]}
                onPress={() => setPreOrderType('pickup')}
              >
                <Ionicons name="bag-handle" size={16} color={preOrderType === 'pickup' ? Colors.white : Colors.textSecondary} />
                <Text style={[styles.chipText, preOrderType === 'pickup' && styles.chipTextActive]}>Pickup</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.chip, preOrderType === 'delivery' && styles.chipActive]}
                onPress={() => setPreOrderType('delivery')}
              >
                <Ionicons name="bicycle" size={16} color={preOrderType === 'delivery' ? Colors.white : Colors.textSecondary} />
                <Text style={[styles.chipText, preOrderType === 'delivery' && styles.chipTextActive]}>Delivery</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* Customer info */}
        <Text style={styles.sectionTitle}>Customer (optional)</Text>
        <View style={styles.row}>
          <TextInput style={[styles.input, { flex: 1 }]} value={customerName} onChangeText={setCustomerName} placeholder="Name" placeholderTextColor={Colors.textLight} />
          <TextInput style={[styles.input, { flex: 1 }]} value={customerPhone} onChangeText={handlePhoneChange} placeholder="Phone" placeholderTextColor={Colors.textLight} keyboardType="phone-pad" />
        </View>
        {showSuggestions && customerSuggestions.length > 0 && (
          <View style={styles.suggestionsBox}>
            {customerSuggestions.map((c, idx) => (
              <TouchableOpacity key={c.phone + idx} style={styles.suggestionItem} onPress={() => selectCustomer(c)}>
                <Ionicons name={c.id ? 'person' : 'person-outline'} size={16} color={Colors.primary} />
                <View style={{ flex: 1, marginLeft: 8 }}>
                  <Text style={styles.suggestionName}>{c.name || 'Unknown'}</Text>
                  <Text style={styles.suggestionPhone}>{c.phone}{c.total_spent > 0 ? ` • ₹${Math.round(c.total_spent)}` : ''}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}
        {customerHistory && (
          <View style={styles.customerHint}>
            <Ionicons name="person-circle" size={16} color={Colors.primary} />
            <Text style={styles.customerHintText}>
              {customerId ? '✓ Registered' : 'Returning'} customer • {customerHistory.order_count} orders • ₹{(customerHistory.total_spent || 0).toFixed(0)} total
              {(customerHistory.credit_balance || 0) > 0 ? ` • ₹${customerHistory.credit_balance.toFixed(0)} due` : ''}
            </Text>
          </View>
        )}

        {/* Scheduled date/time — for pickup, delivery, pre-order */}
        {showScheduledFields && (
          <>
            <Text style={styles.sectionTitle}>
              {orderType === 'pre_order' ? 'Scheduled Date & Time' : 'Scheduled For (optional)'}
            </Text>
            <View style={styles.row}>
              <TouchableOpacity
                style={[styles.pickerBtn, { flex: 1 }]}
                onPress={() => setShowDatePicker(true)}
              >
                <Ionicons name="calendar-outline" size={18} color={scheduledDate ? Colors.primary : Colors.textLight} />
                <Text style={[styles.pickerBtnText, scheduledDate && { color: Colors.text }]}>
                  {scheduledDate || 'Select Date'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pickerBtn, { flex: 1 }]}
                onPress={() => setShowTimePicker(true)}
              >
                <Ionicons name="time-outline" size={18} color={scheduledTime ? Colors.primary : Colors.textLight} />
                <Text style={[styles.pickerBtnText, scheduledTime && { color: Colors.text }]}>
                  {scheduledTime || 'Select Time'}
                </Text>
              </TouchableOpacity>
            </View>
            {(scheduledDate || scheduledTime) && (
              <TouchableOpacity onPress={() => { setScheduledDate(''); setScheduledTime(''); }} style={{ marginTop: 4 }}>
                <Text style={{ fontSize: FontSize.xs, color: Colors.error }}>Clear date/time</Text>
              </TouchableOpacity>
            )}
            <DateTimePickerModal
              visible={showDatePicker}
              mode="date"
              value={datePickerDate}
              minimumDate={new Date()}
              onCancel={() => setShowDatePicker(false)}
              onConfirm={(selected) => {
                setShowDatePicker(false);
                setDatePickerDate(selected);
                const y = selected.getFullYear();
                const m = String(selected.getMonth() + 1).padStart(2, '0');
                const d = String(selected.getDate()).padStart(2, '0');
                setScheduledDate(`${y}-${m}-${d}`);
              }}
            />
            <DateTimePickerModal
              visible={showTimePicker}
              mode="time"
              value={datePickerDate}
              onCancel={() => setShowTimePicker(false)}
              onConfirm={(selected) => {
                setShowTimePicker(false);
                const h = String(selected.getHours()).padStart(2, '0');
                const min = String(selected.getMinutes()).padStart(2, '0');
                setScheduledTime(`${h}:${min}`);
              }}
            />
          </>
        )}

        {/* Delivery address */}
        {needsDelivery && (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={styles.sectionTitle}>Delivery Address</Text>
              {customerId && savedAddresses.length > 0 && (
                <TouchableOpacity style={styles.savedAddrBtn} onPress={() => setShowAddressPicker(true)}>
                  <Ionicons name="bookmark" size={14} color={Colors.primary} />
                  <Text style={styles.savedAddrBtnText}>Saved ({savedAddresses.length})</Text>
                </TouchableOpacity>
              )}
            </View>
            <TextInput style={styles.input} value={deliveryAddress} onChangeText={setDeliveryAddress} placeholder="Full address" placeholderTextColor={Colors.textLight} multiline />

            {/* Sender Info */}
            <Text style={[styles.sectionTitle, { marginTop: Spacing.md }]}>Sender Info (optional)</Text>
            <View style={styles.row}>
              <TextInput style={[styles.input, { flex: 1 }]} value={senderName} onChangeText={setSenderName} placeholder="Sender name" placeholderTextColor={Colors.textLight} />
              <TextInput style={[styles.input, { flex: 1 }]} value={senderPhone} onChangeText={setSenderPhone} placeholder="Sender phone" placeholderTextColor={Colors.textLight} keyboardType="phone-pad" />
            </View>
            <TextInput style={[styles.input, { minHeight: 60 }]} value={senderMessage} onChangeText={setSenderMessage} placeholder="Message from sender..." placeholderTextColor={Colors.textLight} multiline />
          </>
        )}

        {/* Pre-order advance */}
        {orderType === 'pre_order' && (
          <>
            <Text style={styles.sectionTitle}>Advance Payment</Text>
            <TextInput style={styles.input} value={advanceAmount} onChangeText={setAdvanceAmount} placeholder="₹ Advance amount" placeholderTextColor={Colors.textLight} keyboardType="numeric" />
            {parseFloat(advanceAmount) > 0 && (
              <Text style={styles.remainingHint}>
                Remaining: ₹{(grandTotal - (parseFloat(advanceAmount) || 0)).toFixed(2)}
              </Text>
            )}
          </>
        )}

        {/* Discount */}
        <Text style={styles.sectionTitle}>Discount</Text>
        <View style={styles.row}>
          <View style={styles.discountToggle}>
            <TouchableOpacity
              style={[styles.discToggleBtn, discountType === 'fixed' && styles.discToggleBtnActive]}
              onPress={() => setDiscountType('fixed')}
            >
              <Text style={[styles.discToggleText, discountType === 'fixed' && styles.discToggleTextActive]}>₹</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.discToggleBtn, discountType === 'percentage' && styles.discToggleBtnActive]}
              onPress={() => setDiscountType('percentage')}
            >
              <Text style={[styles.discToggleText, discountType === 'percentage' && styles.discToggleTextActive]}>%</Text>
            </TouchableOpacity>
          </View>
          <TextInput style={[styles.input, { flex: 1 }]} value={discountValue} onChangeText={setDiscountValue}
            placeholder={discountType === 'percentage' ? 'Percentage' : 'Amount'} placeholderTextColor={Colors.textLight} keyboardType="numeric" />
        </View>
        {(() => {
          const pct = discountType === 'percentage'
            ? (parseFloat(discountValue) || 0)
            : (subtotal > 0 ? ((parseFloat(discountValue) || 0) / subtotal) * 100 : 0);
          if (pct > 30 && user.role !== 'owner') return (
            <View style={styles.codHint}>
              <Ionicons name="alert-circle" size={16} color={Colors.error} />
              <Text style={[styles.codHintText, { color: Colors.error }]}>Discount {pct.toFixed(0)}% exceeds owner threshold (30%). Only owner can apply.</Text>
            </View>
          );
          if (pct > 20 && user.role === 'employee') return (
            <View style={styles.codHint}>
              <Ionicons name="alert-circle" size={16} color={Colors.warning} />
              <Text style={styles.codHintText}>Discount {pct.toFixed(0)}% exceeds threshold (20%). A manager or owner must apply.</Text>
            </View>
          );
          return null;
        })()}

        {/* Delivery charges */}
        {needsDelivery && (
          <>
            <Text style={styles.sectionTitle}>Delivery Charges</Text>
            <TextInput style={styles.input} value={deliveryCharges} onChangeText={setDeliveryCharges}
              placeholder="₹ 0" placeholderTextColor={Colors.textLight} keyboardType="numeric" />
          </>
        )}

        {/* Notes */}
        <Text style={styles.sectionTitle}>Notes</Text>
        <TextInput style={[styles.input, { minHeight: 60 }]} value={notes} onChangeText={setNotes}
          placeholder="Any special instructions..." placeholderTextColor={Colors.textLight} multiline />

        {/* Order summary */}
        <View style={styles.summaryBox}>
          <Text style={styles.summaryTitle}>Order Summary</Text>
          {cart.map((c, idx) => (
            <View key={c.material_id ? `mat_${c.material_id}_${idx}` : `prod_${c.product_id}_${idx}`} style={styles.summaryRow}>
              <View style={{ flex: 1, paddingRight: 8 }}>
                <Text style={styles.summaryItemName} numberOfLines={1}>{c.material_id ? '🌿 ' : ''}{c.product_name} x {c.quantity}</Text>
                {c.special_instructions ? <Text style={{ fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 }}>Note: {c.special_instructions}</Text> : null}
                {c.image_url ? (
                  <TouchableOpacity onPress={() => setViewedImage(api.getMediaUrl(c.image_url))} style={{ marginTop: 4 }}>
                    <Image source={{ uri: api.getMediaUrl(c.image_url) }} style={{ width: 40, height: 40, borderRadius: 4 }} />
                  </TouchableOpacity>
                ) : null}
                {c.product_id && (
                  <TouchableOpacity onPress={() => openCustomize(c, idx)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600', marginTop: 4 }}>+ Customize</Text>
                  </TouchableOpacity>
                )}
              </View>
              <Text style={styles.summaryItemPrice}>₹{(c.unit_price * c.quantity).toFixed(2)}</Text>
            </View>
          ))}
          <View style={styles.divider} />
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Subtotal</Text>
            <Text style={styles.summaryValue}>₹{subtotal.toFixed(2)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Tax</Text>
            <Text style={styles.summaryValue}>₹{taxTotal.toFixed(2)}</Text>
          </View>
          {discount > 0 && (
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: Colors.error }]}>Discount</Text>
              <Text style={[styles.summaryValue, { color: Colors.error }]}>-₹{discount.toFixed(2)}</Text>
            </View>
          )}
          {delivery > 0 && (
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Delivery</Text>
              <Text style={styles.summaryValue}>₹{delivery.toFixed(2)}</Text>
            </View>
          )}
          <View style={styles.divider} />
          <View style={styles.summaryRow}>
            <Text style={styles.grandLabel}>Grand Total</Text>
            <Text style={styles.grandValue}>₹{grandTotal.toFixed(2)}</Text>
          </View>
        </View>

        {/* Payment Mode */}
        <Text style={styles.sectionTitle}>Payment Mode</Text>
        <View style={styles.chipRow}>
          <TouchableOpacity
            style={[styles.chip, paymentMode === 'pay_now' && styles.chipActive]}
            onPress={() => setPaymentMode('pay_now')}
          >
            <Ionicons name="cash" size={16} color={paymentMode === 'pay_now' ? Colors.white : Colors.textSecondary} />
            <Text style={[styles.chipText, paymentMode === 'pay_now' && styles.chipTextActive]}>Pay Now</Text>
          </TouchableOpacity>
          {(needsDelivery || orderType === 'pickup') && (
            <TouchableOpacity
              style={[styles.chip, paymentMode === 'partial' && styles.chipActive]}
              onPress={() => setPaymentMode('partial')}
            >
              <Ionicons name="wallet" size={16} color={paymentMode === 'partial' ? Colors.white : Colors.textSecondary} />
              <Text style={[styles.chipText, paymentMode === 'partial' && styles.chipTextActive]}>Partial Pay</Text>
            </TouchableOpacity>
          )}
          {needsDelivery && (
            <TouchableOpacity
              style={[styles.chip, paymentMode === 'cod' && styles.chipActive]}
              onPress={() => setPaymentMode('cod')}
            >
              <Ionicons name="bicycle" size={16} color={paymentMode === 'cod' ? Colors.white : Colors.textSecondary} />
              <Text style={[styles.chipText, paymentMode === 'cod' && styles.chipTextActive]}>Cash on Delivery</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.chip, paymentMode === 'credit' && styles.chipActive]}
            onPress={() => setPaymentMode('credit')}
          >
            <Ionicons name="card" size={16} color={paymentMode === 'credit' ? Colors.white : Colors.textSecondary} />
            <Text style={[styles.chipText, paymentMode === 'credit' && styles.chipTextActive]}>Credit</Text>
          </TouchableOpacity>
        </View>

        {paymentMode === 'partial' && (
          <View style={styles.codHint}>
            <Ionicons name="information-circle" size={16} color={Colors.info} />
            <Text style={[styles.codHintText, { color: Colors.info }]}>
              Pay advance now, remaining ₹{(grandTotal - (parseFloat(advanceAmount) || 0)).toFixed(0)} {needsDelivery ? 'on delivery' : 'on pickup'}
            </Text>
          </View>
        )}

        {paymentMode === 'cod' && (
          <View style={styles.codHint}>
            <Ionicons name="information-circle" size={16} color={Colors.warning} />
            <Text style={styles.codHintText}>₹{grandTotal.toFixed(0)} will be collected on delivery</Text>
          </View>
        )}
        {paymentMode === 'credit' && (
          <View style={styles.codHint}>
            <Ionicons name="information-circle" size={16} color={Colors.warning} />
            <Text style={styles.codHintText}>₹{grandTotal.toFixed(0)} will be added to customer credit{customerId ? '' : ' (select customer)'}</Text>
          </View>
        )}

        {/* Advance Amount — for partial pay mode */}
        {paymentMode === 'partial' && (
          <View style={styles.paymentSection}>
            <Text style={styles.sectionTitle}>Advance Payment</Text>
            <View style={styles.chipRow}>
              {PAYMENT_METHODS.map((m) => (
                <TouchableOpacity
                  key={m.key}
                  style={[styles.chip, payments[0].method === m.key && styles.chipActive]}
                  onPress={() => updatePayment(0, 'method', m.key)}
                >
                  <Ionicons name={m.icon} size={14} color={payments[0].method === m.key ? Colors.white : Colors.textSecondary} />
                  <Text style={[styles.chipText, payments[0].method === m.key && styles.chipTextActive]}>{m.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TextInput style={styles.input} value={advanceAmount} onChangeText={setAdvanceAmount}
              placeholder="₹ Advance amount" placeholderTextColor={Colors.textLight} keyboardType="numeric" />
            {payments[0].method !== 'cash' && (
              <TextInput style={styles.input} value={payments[0].reference}
                onChangeText={(v) => updatePayment(0, 'reference', v)}
                placeholder="Reference / Transaction ID" placeholderTextColor={Colors.textLight} />
            )}
            {parseFloat(advanceAmount) > 0 && (
              <View style={styles.changeDueBox}>
                <Ionicons name="time" size={18} color={Colors.warning} />
                <Text style={[styles.changeDueLabel, { color: Colors.warning }]}>
                  Remaining {needsDelivery ? 'COD' : 'on Pickup'}
                </Text>
                <Text style={[styles.changeDueAmount, { color: Colors.warning }]}>
                  ₹{Math.max(0, grandTotal - (parseFloat(advanceAmount) || 0)).toFixed(2)}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Payment — split payment support */}
        {paymentMode === 'pay_now' && (
        <View style={styles.paymentSection}>
          <View style={styles.paymentHeader}>
            <Text style={styles.sectionTitle}>Payment</Text>
            <TouchableOpacity onPress={addPaymentSplit} style={styles.splitBtn}>
              <Ionicons name="add-circle" size={16} color={Colors.primary} />
              <Text style={styles.splitBtnText}>Split</Text>
            </TouchableOpacity>
          </View>

          {payments.map((pmt, idx) => (
            <View key={idx} style={styles.paymentEntry}>
              {payments.length > 1 && (
                <View style={styles.paymentEntryHeader}>
                  <Text style={styles.paymentEntryLabel}>Payment {idx + 1}</Text>
                  <TouchableOpacity onPress={() => removePaymentSplit(idx)}>
                    <Ionicons name="close-circle" size={18} color={Colors.error} />
                  </TouchableOpacity>
                </View>
              )}
              <View style={styles.chipRow}>
                {PAYMENT_METHODS.map((m) => (
                  <TouchableOpacity
                    key={m.key}
                    style={[styles.chip, pmt.method === m.key && styles.chipActive]}
                    onPress={() => updatePayment(idx, 'method', m.key)}
                  >
                    <Ionicons name={m.icon} size={14} color={pmt.method === m.key ? Colors.white : Colors.textSecondary} />
                    <Text style={[styles.chipText, pmt.method === m.key && styles.chipTextActive]}>{m.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {payments.length > 1 && (
                <TextInput
                  style={styles.input}
                  value={pmt.amount}
                  onChangeText={(v) => updatePayment(idx, 'amount', v)}
                  placeholder="₹ Amount"
                  placeholderTextColor={Colors.textLight}
                  keyboardType="numeric"
                />
              )}
              {pmt.method !== 'cash' && (
                <TextInput
                  style={styles.input}
                  value={pmt.reference}
                  onChangeText={(v) => updatePayment(idx, 'reference', v)}
                  placeholder="Reference / Transaction ID"
                  placeholderTextColor={Colors.textLight}
                />
              )}
            </View>
          ))}

          {payments.length > 1 && (
            <View style={[styles.summaryRow, { marginTop: Spacing.xs }]}>
              <Text style={styles.summaryLabel}>Total Entered</Text>
              <Text style={[styles.summaryValue, {
                color: Math.abs(totalPaymentEntered - grandTotal) < 0.01 ? Colors.success : Colors.error,
              }]}>₹{totalPaymentEntered.toFixed(2)} / ₹{grandTotal.toFixed(2)}</Text>
            </View>
          )}

          {/* Change due calculator */}
          {(() => {
            const cashEntered = payments.reduce((s, p) => {
              if (p.method === 'cash') return s + (parseFloat(p.amount) || (payments.length === 1 ? grandTotal : 0));
              return s;
            }, 0);
            const changeDue = payments.length === 1 && payments[0].method === 'cash' && !payments[0].amount
              ? 0
              : totalPaymentEntered - grandTotal;
            if (changeDue > 0.01 && cashEntered > 0) {
              return (
                <View style={styles.changeDueBox}>
                  <Ionicons name="cash" size={18} color={Colors.success} />
                  <Text style={styles.changeDueLabel}>Change Due</Text>
                  <Text style={styles.changeDueAmount}>₹{changeDue.toFixed(2)}</Text>
                </View>
              );
            }
            return null;
          })()}
        </View>
        )}

        {/* Submit */}
        <TouchableOpacity style={[styles.submitBtn, submitting && { opacity: 0.6 }]} onPress={handleSubmit} disabled={submitting}>
          {submitting ? (
            <ActivityIndicator color={Colors.white} />
          ) : (
            <>
              <Ionicons name="checkmark-circle" size={20} color={Colors.white} />
              <Text style={styles.submitBtnText}>
                {orderType === 'pre_order' ? 'Create Pre-order' : paymentMode === 'cod' ? 'Create COD Order' : paymentMode === 'credit' ? 'Create Credit Sale' : paymentMode === 'partial' ? `Create Order — Advance ₹${(parseFloat(advanceAmount) || 0).toFixed(0)}` : 'Complete Sale'} — ₹{grandTotal.toFixed(2)}
              </Text>
            </>
          )}
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Saved Addresses Picker Modal */}
      <Modal visible={showAddressPicker} transparent animationType="slide" onRequestClose={() => setShowAddressPicker(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Saved Addresses</Text>
              <TouchableOpacity onPress={() => setShowAddressPicker(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>
            <FlatList
              data={savedAddresses}
              keyExtractor={(item) => String(item.id)}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.addressItem}
                  onPress={() => {
                    const parts = [item.address_line_1, item.address_line_2, item.city, item.state, item.pincode].filter(Boolean);
                    setDeliveryAddress(parts.join(', '));
                    setShowAddressPicker(false);
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                    <Ionicons name="location" size={16} color={Colors.primary} />
                    <Text style={styles.addressLabel}>{item.label}{item.is_default ? ' ★' : ''}</Text>
                  </View>
                  <Text style={styles.addressText}>{item.address_line_1}</Text>
                  {item.address_line_2 ? <Text style={styles.addressText}>{item.address_line_2}</Text> : null}
                  {(item.city || item.pincode) && (
                    <Text style={styles.addressTextSub}>{[item.city, item.state, item.pincode].filter(Boolean).join(', ')}</Text>
                  )}
                </TouchableOpacity>
              )}
              ListEmptyComponent={<Text style={{ textAlign: 'center', color: Colors.textLight, padding: 20 }}>No saved addresses</Text>}
            />
          </View>
        </View>
      </Modal>

      {/* Customize Product Modal */}
      <Modal visible={showCustomize} transparent animationType="slide">
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.cModalOverlay}>
            <View style={styles.cModalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>✨ Customize Product</Text>
                <TouchableOpacity onPress={() => setShowCustomize(false)}>
                  <Ionicons name="close" size={24} color={Colors.text} />
                </TouchableOpacity>
              </View>
              {customProduct && (
                <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: Spacing.md }}>
                    <TouchableOpacity 
                      style={[styles.productIconWrap, { width: 56, height: 56 }]}
                      onPress={(e) => { e.stopPropagation(); if (customProduct?.image_url) setViewedImage(api.getMediaUrl(customProduct.image_url)); }}
                    >
                      {customProduct.image_url ? (
                        <Image source={{ uri: api.getMediaUrl(customProduct.image_url) }} style={{ width: 56, height: 56, borderRadius: BorderRadius.md }} />
                      ) : (
                        <Ionicons name="gift" size={28} color={Colors.primary} />
                      )}
                    </TouchableOpacity>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: FontSize.lg, fontWeight: '700', color: Colors.text }}>{customProduct.product_name}</Text>
                      <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>Base Price: ₹{(customProduct.unit_price || 0).toFixed(0)}</Text>
                    </View>
                  </View>

                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.sm }}>
                    <Text style={styles.fieldLabel}>Materials</Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => setCustomMaterials([...customMaterials, { material_id: null, name: '', qty: '1' }])}
                    style={{
                      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
                      backgroundColor: Colors.primary + '15', paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md,
                      borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.primary + '30', borderStyle: 'dashed',
                      marginBottom: Spacing.sm,
                    }}
                  >
                    <Ionicons name="add-circle" size={20} color={Colors.primary} />
                    <Text style={{ fontSize: FontSize.sm, color: Colors.primary, fontWeight: '700' }}>Add Material</Text>
                  </TouchableOpacity>
                  {customMaterials.map((m, idx) => (
                    <View key={idx} style={{ flexDirection: 'row', gap: Spacing.xs, alignItems: 'center', marginBottom: Spacing.xs }}>
                      <TouchableOpacity
                        style={[styles.modalInput, { flex: 2, justifyContent: 'center', paddingVertical: Spacing.xs + 4 }]}
                        onPress={() => openMaterialPicker(idx)}
                      >
                        <Text style={{ color: m.material_id ? Colors.text : Colors.textLight, fontSize: FontSize.sm }}>{m.name || 'Select material...'}</Text>
                      </TouchableOpacity>
                      <TextInput
                        style={[styles.modalInput, { flex: 1 }]}
                        value={m.qty}
                        onChangeText={(v) => setCustomMaterials(customMaterials.map((cm, ci) => ci === idx ? { ...cm, qty: v } : cm))}
                        placeholder="Qty"
                        placeholderTextColor={Colors.textLight}
                        keyboardType="numeric"
                      />
                      <TouchableOpacity onPress={() => setCustomMaterials(customMaterials.filter((_, ci) => ci !== idx))}>
                        <Ionicons name="close-circle" size={22} color={Colors.error} />
                      </TouchableOpacity>
                    </View>
                  ))}

                  <Text style={[styles.fieldLabel, { marginTop: Spacing.sm }]}>Additional Charge (₹)</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={customCharge}
                    onChangeText={setCustomCharge}
                    placeholder="0"
                    placeholderTextColor={Colors.textLight}
                    keyboardType="numeric"
                  />

                  <Text style={[styles.fieldLabel, { marginTop: Spacing.sm }]}>Special Instructions</Text>
                  <TextInput
                    style={[styles.modalInput, { minHeight: 60 }]}
                    value={customSpecialInstructions}
                    onChangeText={setCustomSpecialInstructions}
                    placeholder="Notes for production..."
                    placeholderTextColor={Colors.textLight}
                    multiline
                  />

                  <TouchableOpacity
                    style={[styles.qaSubmitBtn, customSubmitting && { opacity: 0.6 }]}
                    onPress={handleCustomize}
                    disabled={customSubmitting}
                  >
                    {customSubmitting ? (
                      <ActivityIndicator color={Colors.white} />
                    ) : (
                      <>
                        <Ionicons name="sparkles" size={18} color={Colors.white} />
                        <Text style={styles.qaSubmitText}>Update Cart Item</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </ScrollView>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <ImageModal 
        visible={!!viewedImage} 
        imageUrl={viewedImage} 
        onClose={() => setViewedImage(null)} 
      />

      <Modal visible={showMaterialPicker} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { paddingHorizontal: Spacing.md, paddingVertical: Spacing.md, marginBottom: 0 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.md }}>
              <Text style={{ fontSize: FontSize.lg, fontWeight: '700', color: Colors.text }}>Select Material</Text>
              <TouchableOpacity onPress={() => setShowMaterialPicker(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>
            <View style={{ 
              flexDirection: 'row', alignItems: 'center', gap: 8, 
              backgroundColor: Colors.surfaceAlt || '#f5f5f5', borderRadius: BorderRadius.md,
              paddingHorizontal: Spacing.md, marginBottom: Spacing.md
            }}>
              <Ionicons name="search" size={18} color={Colors.textLight} />
              <TextInput
                style={{ flex: 1, height: 44, fontSize: FontSize.md, color: Colors.text }}
                value={materialSearch}
                onChangeText={setMaterialSearch}
                placeholder="Search materials..."
                placeholderTextColor={Colors.textLight}
                autoFocus
              />
            </View>
            <ScrollView style={{ maxHeight: 350 }}>
              {allMaterialsList
                .filter(m => {
                  const searchMatches = m.name.toLowerCase().includes(materialSearch.toLowerCase());
                  const alreadySelected = customMaterials.some((qm, qi) => qi !== editingMaterialIdx && qm.material_id === m.id);
                  return searchMatches && !alreadySelected;
                })
                .slice(0, 50)
                .map(m => (
                  <TouchableOpacity
                    key={m.id}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 12,
                      paddingVertical: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border
                    }}
                    onPress={() => {
                      setCustomMaterials(customMaterials.map((cm, ci) => ci === editingMaterialIdx ? { ...cm, material_id: m.id, name: m.name } : cm));
                      setShowMaterialPicker(false);
                    }}
                  >
                    <View style={{ 
                      width: 40, height: 40, borderRadius: 8, 
                      backgroundColor: Colors.primary + '10', justifyContent: 'center', alignItems: 'center' 
                    }}>
                      <Ionicons name="leaf-outline" size={20} color={Colors.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: FontSize.md, fontWeight: '600', color: Colors.text }}>{m.name}</Text>
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>{m.category_name || 'Material'}</Text>
                    </View>
                    <Ionicons name="add-circle" size={22} color={Colors.success} />
                  </TouchableOpacity>
                ))}
              {allMaterialsList.filter(m => m.name.toLowerCase().includes(materialSearch.toLowerCase())).length === 0 && (
                <Text style={{ textAlign: 'center', color: Colors.textLight, paddingVertical: Spacing.xl }}>No materials found</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md },

  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full, backgroundColor: Colors.surface,
    borderWidth: 1.5, borderColor: Colors.border, minHeight: 44,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.white, fontWeight: '700' },

  row: { flexDirection: 'row', gap: Spacing.sm },
  input: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md, fontSize: FontSize.md, color: Colors.text, marginTop: Spacing.xs,
  },

  remainingHint: { fontSize: FontSize.sm, color: Colors.warning, marginTop: Spacing.xs, fontWeight: '600' },

  discountToggle: { flexDirection: 'row', marginTop: Spacing.xs },
  discToggleBtn: {
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border,
  },
  discToggleBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  discToggleText: { fontSize: FontSize.md, color: Colors.textSecondary, fontWeight: '700' },
  discToggleTextActive: { color: Colors.white },

  summaryBox: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.md, marginTop: Spacing.lg,
  },
  summaryTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  summaryItemName: { fontSize: FontSize.sm, color: Colors.textSecondary, flex: 1 },
  summaryItemPrice: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '500' },
  divider: { height: 1, backgroundColor: Colors.border, marginVertical: Spacing.sm },
  summaryLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  summaryValue: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '600' },
  grandLabel: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  grandValue: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.primary },

  paymentSection: { marginTop: Spacing.md },
  paymentHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  splitBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.sm, paddingVertical: Spacing.sm,
  },
  splitBtnText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },
  paymentEntry: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.md, marginTop: Spacing.sm,
  },
  paymentEntryHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  paymentEntryLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary },

  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    backgroundColor: Colors.primary, borderRadius: BorderRadius.md,
    paddingVertical: Spacing.lg, marginTop: Spacing.lg,
  },
  submitBtnText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '700' },

  customerHint: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.primary + '10', borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, marginTop: Spacing.sm,
  },
  customerHintText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '500' },

  changeDueBox: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.success + '12', borderRadius: BorderRadius.md,
    padding: Spacing.md, marginTop: Spacing.sm,
  },
  changeDueLabel: { fontSize: FontSize.md, color: Colors.success, fontWeight: '600', flex: 1 },
  changeDueAmount: { fontSize: FontSize.lg, color: Colors.success, fontWeight: '700' },

  codHint: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.warning + '12', borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, marginTop: Spacing.sm,
  },
  codHintText: { fontSize: FontSize.sm, color: Colors.warning, fontWeight: '600', flex: 1 },

  pickerBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md, marginTop: Spacing.xs,
  },
  pickerBtnText: { fontSize: FontSize.md, color: Colors.textLight },

  // Customer search dropdown
  suggestionsBox: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.primary + '40',
    marginTop: 2, maxHeight: 200, overflow: 'hidden',
  },
  suggestionItem: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  suggestionName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  suggestionPhone: { fontSize: FontSize.xs, color: Colors.textSecondary },

  // Saved addresses
  savedAddrBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.sm, paddingVertical: 4,
    borderRadius: BorderRadius.full, backgroundColor: Colors.primary + '12',
  },
  savedAddrBtnText: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600' },

  // Address picker modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: {
    backgroundColor: Colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    maxHeight: '60%', paddingBottom: 30,
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  addressItem: {
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  addressLabel: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.primary, marginLeft: 6 },
  addressText: { fontSize: FontSize.sm, color: Colors.text, marginLeft: 22 },
  addressTextSub: { fontSize: FontSize.xs, color: Colors.textSecondary, marginLeft: 22, marginTop: 2 },

  // Customize Modal
  cModalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: Spacing.sm },
  cModalCard: { backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.lg },
  modalInput: {
    backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, fontSize: FontSize.md, color: Colors.text,
  },
  qaSubmitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: Colors.primary, borderRadius: BorderRadius.md,
    paddingVertical: Spacing.md, marginTop: Spacing.lg,
  },
  qaSubmitText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '700' },
  fieldLabel: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary, marginBottom: 4 },
  productIconWrap: {
    backgroundColor: Colors.primary + '10', justifyContent: 'center', alignItems: 'center',
    borderRadius: BorderRadius.md,
  },
});
