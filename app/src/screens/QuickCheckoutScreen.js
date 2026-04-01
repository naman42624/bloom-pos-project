import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, Image,
  TouchableOpacity, Alert, Platform, Modal, ActivityIndicator,
  KeyboardAvoidingView, Pressable
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, CommonActions } from '@react-navigation/native';

import DateTimePickerModal from '../components/DateTimePickerModal';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { getShopNow } from '../utils/datetime';


const ORDER_TYPES = [
  { key: 'walk_in', label: 'Walk-in', icon: 'person', color: '#4CAF50' },
  { key: 'pickup', label: 'Pickup', icon: 'bag-handle', color: '#2196F3' },
  { key: 'delivery', label: 'Delivery', icon: 'bicycle', color: '#FF9800' },
];

export default function QuickCheckoutScreen({ navigation }) {
  const { user, settings } = useAuth();
  const timezone = settings?.timezone || 'Asia/Kolkata';


  // Customer
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');

  // Items
  const [items, setItems] = useState([]);

  // Scheduled date/time
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [datePickerDate, setDatePickerDate] = useState(getShopNow(timezone));
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);


  // Order type
  const [orderType, setOrderType] = useState('walk_in');

  // Location
  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);

  // Materials list (for building custom products)
  const [allMaterials, setAllMaterials] = useState([]);

  // Delivery & Sender Info
  const [useCustomerAsSender, setUseCustomerAsSender] = useState(true);
  const [senderSameAsReceiver, setSenderSameAsReceiver] = useState(false);
  const [senderName, setSenderName] = useState('');
  const [senderPhone, setSenderPhone] = useState('');
  const [senderMessage, setSenderMessage] = useState('');
  const [senderAddress, setSenderAddress] = useState('');
  const [receiverName, setReceiverName] = useState('');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [receiverId, setReceiverId] = useState(null);
  const [orderNotes, setOrderNotes] = useState('');

  // Surcharges & Discounts
  const [deliveryCharges, setDeliveryCharges] = useState('');
  const [discountValue, setDiscountValue] = useState('');
  const [discountType, setDiscountType] = useState('fixed'); // 'fixed' or 'percentage'

  // Customer Lookup
  const [customerId, setCustomerId] = useState(null);
  const [customerHistory, setCustomerHistory] = useState(null);
  const [customerSuggestions, setCustomerSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [receiverHistory, setReceiverHistory] = useState(null);
  const [receiverSuggestions, setReceiverSuggestions] = useState([]);
  const [showReceiverSuggestions, setShowReceiverSuggestions] = useState(false);

  // Payment
  const [paymentMethod, setPaymentMethod] = useState('cash'); // Legacy single selection
  const [paymentReference, setPaymentReference] = useState(''); // Legacy single reference
  const [payments, setPayments] = useState([{ method: 'cash', amount: '', reference: '' }]);
  const [enableSplitPayment, setEnableSplitPayment] = useState(false);
  const [paymentMode, setPaymentMode] = useState('pay_now'); // 'pay_now', 'cod', 'credit', 'partial'
  const [advanceAmount, setAdvanceAmount] = useState('');

  // Submitting
  const [submitting, setSubmitting] = useState(false);

  // Product search modal
  const [showProductPicker, setShowProductPicker] = useState(false);
  const [products, setProducts] = useState([]);
  const [productSearch, setProductSearch] = useState('');
  const [editingItemIdx, setEditingItemIdx] = useState(null); // which item to add base product to

  // Material search modal
  const [showMaterialPicker, setShowMaterialPicker] = useState(false);
  const [materialSearch, setMaterialSearch] = useState('');
  const [editingMaterialIdx, setEditingMaterialIdx] = useState(null);
  const searchTimer = useRef(null);

  useFocusEffect(
    useCallback(() => {
      fetchLocations();
      fetchMaterials();
    }, [])
  );

  const fetchLocations = async () => {
    try {
      const res = await api.getLocations();
      const locs = res.data?.locations || res.data || [];
      setLocations(locs);
      if (locs.length > 0 && !selectedLocation) setSelectedLocation(locs[0].id);
    } catch { }
  };

  const handlePhoneChange = useCallback((text) => {
    setCustomerPhone(text);
    setShowSuggestions(false);
    if (senderSameAsReceiver && useCustomerAsSender) {
      setReceiverPhone(text);
    }

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
      if (text.length >= 10) {
        // Enhanced lookup for full number
        api.customerLookupEnhanced(text).then(res => {
          if (res.data) {
            setCustomerHistory(res.data);
            setCustomerId(res.data.is_registered ? res.data.id : null);
            if (res.data.name && !customerName) {
              setCustomerName(res.data.name);
            }
            if (senderSameAsReceiver && useCustomerAsSender) {
              setReceiverHistory(res.data);
              setReceiverId(res.data.is_registered ? res.data.id : null);
              if (res.data.name && !receiverName) {
                setReceiverName(res.data.name);
              }
            }
          }
        }).catch(() => { });
      } else {
        setCustomerHistory(null);
        setCustomerId(null);
      }
    }
  }, [senderSameAsReceiver, useCustomerAsSender, receiverName, customerName]);

  const selectCustomer = useCallback((c) => {
    setCustomerPhone(c.phone || '');
    setCustomerName(c.name || '');
    if (c.id) setCustomerId(c.id);
    if (senderSameAsReceiver && useCustomerAsSender) {
      setReceiverPhone(c.phone || '');
      setReceiverName(c.name || '');
      setReceiverId(c.id || null);
    }
    setShowSuggestions(false);
    setCustomerSuggestions([]);
  }, [senderSameAsReceiver, useCustomerAsSender]);

  const handleReceiverPhoneChange = useCallback((text) => {
    setReceiverPhone(text);
    setShowReceiverSuggestions(false);

    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (text.length >= 3 && text.length < 10) {
      searchTimer.current = setTimeout(async () => {
        try {
          const res = await api.customerSearch(text);
          if (res.data && res.data.length > 0) {
            setReceiverSuggestions(res.data);
            setShowReceiverSuggestions(true);
          } else {
            setReceiverSuggestions([]);
            setShowReceiverSuggestions(false);
          }
        } catch {}
      }, 300);
    } else {
      setReceiverSuggestions([]);
      if (text.length >= 10) {
        api.customerLookupEnhanced(text).then(res => {
          if (res.data) {
            setReceiverHistory(res.data);
            setReceiverId(res.data.is_registered ? res.data.id : null);
            if (res.data.name && !receiverName) {
              setReceiverName(res.data.name);
            }
          }
        }).catch(() => {});
      } else {
        setReceiverHistory(null);
        if (!senderSameAsReceiver) setReceiverId(null);
      }
    }
  }, [receiverName, senderSameAsReceiver]);

  const selectReceiver = useCallback((c) => {
    setReceiverPhone(c.phone || '');
    setReceiverName(c.name || '');
    setReceiverId(c.id || null);
    setShowReceiverSuggestions(false);
    setReceiverSuggestions([]);
  }, []);

  useEffect(() => {
    if (senderSameAsReceiver) {
      const senderNameFinal = (useCustomerAsSender ? customerName : senderName) || '';
      const senderPhoneFinal = (useCustomerAsSender ? customerPhone : senderPhone) || '';
      setReceiverName(senderNameFinal);
      setReceiverPhone(senderPhoneFinal);
      setReceiverId(useCustomerAsSender ? (customerId || null) : null);
      setReceiverHistory(useCustomerAsSender ? customerHistory : null);
      if (!customerAddress && senderAddress) setCustomerAddress(senderAddress);
    }
  }, [senderSameAsReceiver, useCustomerAsSender, customerName, customerPhone, senderName, senderPhone, customerId, customerHistory, customerAddress, senderAddress]);

  const checkRegisterStatus = async (locId) => {
    try {
      const res = await api.getRegisterStatus(locId);
      return res.isOpen === true;
    } catch { return false; }
  };

  const fetchMaterials = async () => {
    try {
      const res = await api.getMaterials({});
      setAllMaterials(res.data || []);
    } catch { }
  };

  const fetchProducts = async (q) => {
    try {
      const params = { search: q || '', is_active: 1 };
      if (selectedLocation) params.location_id = selectedLocation;
      const res = await api.getProducts(params);
      setProducts(res.data || []);
    } catch { }
  };

  // Add a blank custom item
  const addItem = () => {
    setItems([...items, {
      name: '',
      baseProduct: null, // optional: link to existing product
      materials: [],
      price: '',
      quantity: '1',
      special_instructions: '',
      image_url: '',
      fulfill_from_stock: false,
    }]);
  };

  // Add from existing product
  const addFromProduct = async (product, idx) => {
    try {
      const bomRes = await api.getProductMaterials(product.id);
      const bom = (bomRes.data || []).map(m => ({
        material_id: m.material_id,
        name: m.material_name || m.name,
        qty: String(m.quantity || 1),
      }));
      const updated = [...items];
      updated[idx] = {
        ...updated[idx],
        name: product.name,
        baseProduct: product,
        materials: bom,
        price: String(product.selling_price || 0),
        fulfill_from_stock: (product.ready_qty || product.stock_quantity || 0) > 0,
      };
      setItems(updated);
    } catch {
      const updated = [...items];
      updated[idx] = {
        ...updated[idx],
        name: product.name,
        baseProduct: product,
        price: String(product.selling_price || 0),
        fulfill_from_stock: (product.ready_qty || product.stock_quantity || 0) > 0,
      };
      setItems(updated);
    }
    setShowProductPicker(false);
  };

  const updateItem = (idx, field, value) => {
    setItems(items.map((it, i) => i === idx ? { ...it, [field]: value } : it));
  };

  const removeItem = (idx) => {
    setItems(items.filter((_, i) => i !== idx));
  };

  // Material management for an item
  const addMaterialToItem = (itemIdx) => {
    const updated = [...items];
    updated[itemIdx].materials = [...updated[itemIdx].materials, { material_id: null, name: '', qty: '1' }];
    setItems(updated);
  };

  const updateItemMaterial = (itemIdx, matIdx, field, value) => {
    const updated = [...items];
    updated[itemIdx].materials = updated[itemIdx].materials.map((m, mi) =>
      mi === matIdx ? { ...m, [field]: value } : m
    );
    setItems(updated);
  };

  const selectMaterialForItem = (itemIdx, matIdx, material) => {
    const updated = [...items];
    updated[itemIdx].materials = updated[itemIdx].materials.map((m, mi) =>
      mi === matIdx ? { ...m, material_id: material.id, name: material.name } : m
    );
    setItems(updated);
  };

  const openMaterialPicker = (itemIdx, matIdx) => {
    setEditingItemIdx(itemIdx);
    setEditingMaterialIdx(matIdx);
    setMaterialSearch('');
    setShowMaterialPicker(true);
  };

  const removeMaterialFromItem = (itemIdx, matIdx) => {
    const updated = [...items];
    updated[itemIdx].materials = updated[itemIdx].materials.filter((_, mi) => mi !== matIdx);
    setItems(updated);
  };

  // Calculate totals
  const getItemTotal = (item) => {
    const price = parseFloat(item.price) || 0;
    const qty = parseInt(item.quantity) || 1;
    return price * qty;
  };

  const itemsSubtotal = items.reduce((sum, it) => sum + getItemTotal(it), 0);

  const totals = useMemo(() => {
    const subtotal = itemsSubtotal;
    const taxRate = items[0]?.baseProduct?.tax_percentage || 0;
    const taxTotal = items.reduce((s, it) => {
      const price = parseFloat(it.price) || 0;
      const qty = parseInt(it.quantity) || 1;
      const tax = it.baseProduct?.tax_percentage || 0;
      return s + (price * qty * tax / 100);
    }, 0);

    const discVal = parseFloat(discountValue) || 0;
    const discountAmount = discountType === 'percentage' ? (subtotal * discVal / 100) : discVal;
    const delivery = (orderType === 'delivery') ? (parseFloat(deliveryCharges) || 0) : 0;
    const finalTotal = Math.max(0, subtotal - discountAmount) + taxTotal + delivery;

    return { subtotal, taxTotal, discountAmount, delivery, finalTotal };
  }, [items, discountValue, discountType, orderType, deliveryCharges]);

  // Place order
  const handlePlaceOrder = async () => {
    // Register guard
    const isRegOpen = await checkRegisterStatus(selectedLocation);
    if (!isRegOpen) {
      Alert.alert(
        'Register Closed',
        'The cash register for this location is not open. Please open it before creating a sale.',
        [
          { text: 'Open Register', onPress: () => navigation.navigate('CashRegister') },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
      return;
    }

    if (items.length === 0) {
      Alert.alert('Required', 'Please add at least one item');
      return;
    }
    for (const item of items) {
      if (!item.name.trim()) {
        Alert.alert('Required', 'All items must have a name');
        return;
      }
      if ((parseFloat(item.price) || 0) <= 0) {
        Alert.alert('Required', 'All items must have a price');
        return;
      }
    }
    if (orderType === 'delivery' && !customerAddress.trim()) {
      Alert.alert('Required', 'Delivery address is required');
      return;
    }

    const effectiveSenderName = (useCustomerAsSender ? customerName : senderName).trim();
    const effectiveSenderPhone = (useCustomerAsSender ? customerPhone : senderPhone).trim();
    const effectiveSenderId = useCustomerAsSender ? (customerId || null) : null;
    const effectiveCustomerName = (customerName || '').trim();
    const effectiveCustomerPhone = (customerPhone || '').trim();
    const effectiveReceiverName = (senderSameAsReceiver ? effectiveSenderName : receiverName).trim();
    const effectiveReceiverPhone = (senderSameAsReceiver ? effectiveSenderPhone : receiverPhone).trim();
    const effectiveReceiverId = senderSameAsReceiver ? effectiveSenderId : (receiverId || null);

    if (orderType === 'delivery' && !effectiveSenderName) {
      Alert.alert('Required', 'Please enter sender/customer name');
      return;
    }
    if (orderType === 'delivery' && !effectiveSenderPhone) {
      Alert.alert('Required', 'Please enter sender/customer phone');
      return;
    }
    if (orderType === 'delivery' && !effectiveReceiverName) {
      Alert.alert('Required', 'Please enter receiver name');
      return;
    }
    if (orderType === 'delivery' && !effectiveReceiverPhone) {
      Alert.alert('Required', 'Please enter receiver phone');
      return;
    }
    if (paymentMode === 'credit' && !effectiveSenderPhone) {
      Alert.alert('Required', 'Credit payments require sender phone details.');
      return;
    }
    if (paymentMode === 'partial' && (parseFloat(advanceAmount) || 0) <= 0) {
      Alert.alert('Required', 'Please enter an advance payment amount for partial pay');
      return;
    }
    if (!selectedLocation) {
      Alert.alert('Required', 'Please select a location');
      return;
    }

    setSubmitting(true);
    try {
      const processedItems = await Promise.all(items.map(async (item) => {
        let finalImageUrl = item.image_url;
        if (finalImageUrl && !finalImageUrl.startsWith('http') && !finalImageUrl.startsWith('/')) {
          try {
            const res = await api.uploadGenericMedia(finalImageUrl);
            if (res.success && res.url) {
              finalImageUrl = res.url;
            }
          } catch (err) { console.log('Image upload failed', err); }
        }
        return { ...item, image_url: finalImageUrl };
      }));

      // Build cart items
      const cartItems = processedItems.map(item => ({
        product_id: item.baseProduct?.id || null,
        material_id: null,
        product_name: item.name,
        product_sku: item.baseProduct?.sku || '',
        quantity: parseInt(item.quantity) || 1,
        unit_price: parseFloat(item.price) || 0,
        tax_rate: item.baseProduct?.tax_percentage || 0,
        tax_amount: (parseFloat(item.price) || 0) * (parseInt(item.quantity) || 1) * (item.baseProduct?.tax_percentage || 0) / 100,
        line_total: getItemTotal(item) + ((parseFloat(item.price) || 0) * (parseInt(item.quantity) || 1) * (item.baseProduct?.tax_percentage || 0) / 100),
        custom_materials: (item.materials || [])
          .filter(m => m.material_id)
          .map(m => ({ material_id: m.material_id, name: m.name, qty_per_unit: parseFloat(m.qty) || 1 })),
        special_instructions: item.special_instructions || '',
        image_url: item.image_url || '',
        fulfill_from_stock: item.fulfill_from_stock || false,
      }));

      const { subtotal, taxTotal, discountAmount, delivery, finalTotal: finalGrandTotal } = totals;
      const discVal = parseFloat(discountValue) || 0;

      // Payment entries
      let paymentEntries = [];
      if (paymentMode === 'pay_now') {
        if (enableSplitPayment) {
          paymentEntries = payments.map(p => ({
            method: p.method,
            amount: parseFloat(p.amount) || 0,
            reference_number: p.reference.trim() || null,
          })).filter(p => p.amount > 0);
        } else {
          paymentEntries = [{
            method: paymentMethod,
            amount: finalGrandTotal,
            reference_number: paymentReference.trim() || null,
          }];
        }
      }

      const saleData = {
        location_id: selectedLocation,
        order_type: orderType,
        customer_id: orderType === 'delivery' ? (customerId || null) : customerId,
        customer_name: orderType === 'delivery' ? (effectiveCustomerName || null) : (customerName.trim() || null),
        customer_phone: orderType === 'delivery' ? (effectiveCustomerPhone || null) : (customerPhone.trim() || null),
        discount_type: discountAmount > 0 ? discountType : null,
        discount_value: discVal,
        delivery_charges: delivery,
        notes: orderNotes || null,
        delivery_address: orderType === 'delivery' ? customerAddress.trim() : null,
        sender_customer_id: orderType === 'delivery' ? (useCustomerAsSender ? (effectiveSenderId || null) : null) : null,
        receiver_customer_id: orderType === 'delivery' ? (effectiveReceiverId || null) : null,
        sender_same_as_receiver: orderType === 'delivery' ? senderSameAsReceiver : false,
        sender_name: orderType === 'delivery' ? (effectiveSenderName || null) : (senderName.trim() || null),
        sender_phone: orderType === 'delivery' ? (effectiveSenderPhone || null) : (senderPhone.trim() || null),
        receiver_name: orderType === 'delivery' ? (effectiveReceiverName || null) : null,
        receiver_phone: orderType === 'delivery' ? (effectiveReceiverPhone || null) : null,
        sender_address: orderType === 'delivery' ? (senderAddress.trim() || null) : null,
        sender_address_label: null,
        receiver_address_label: null,
        sender_message: senderMessage.trim() || null,
        scheduled_date: scheduledDate || null,
        scheduled_time: scheduledTime || null,
        items: cartItems,
        payments: (paymentMode === 'pay_now' || paymentMode === 'partial') ? (
          paymentMode === 'partial'
            ? [{ method: payments[0].method, amount: parseFloat(advanceAmount) || 0, reference_number: payments[0].reference || null }]
            : paymentEntries
        ) : [],
        advance_amount: paymentMode === 'partial' ? (parseFloat(advanceAmount) || 0) : 0,
      };

      const res = await api.createSale(saleData);
      if (res.success) {
        navigation.dispatch(
          CommonActions.reset({
            index: 1,
            routes: [
              { name: 'POSHome', params: { clearCart: true } },
              { name: 'SaleDetail', params: { saleId: res.data.id, fromCheckout: true } },
            ],
          })
        );
      } else {

        Alert.alert('Error', res.message || 'Failed to place order');
      }
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to place order');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDateConfirm = (date) => {
    setShowDatePicker(false);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    setScheduledDate(`${yyyy}-${mm}-${dd}`);
    setDatePickerDate(date);
  };

  const handleTimeConfirm = (date) => {
    setShowTimePicker(false);
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    setScheduledTime(`${hh}:${min}`);
    setDatePickerDate(date);
  };

  const pickImage = async (idx) => {
    try {
      if (Platform.OS !== 'web') {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Permission Required', 'We need access to your photos to add a product image.');
          return;
        }
      }

      let result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaType?.Images || 'images',
        allowsEditing: true,
        quality: 0.8,
      });
      
      if (!result.canceled && result.assets && result.assets.length > 0) {
        updateItem(idx, 'image_url', result.assets[0].uri);
      }
    } catch (err) {
      console.error('Image picker error:', err);
      const msg = 'Could not open image library';
      if (Platform.OS === 'web') window.alert(msg);
      else Alert.alert('Error', msg);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { alignSelf: 'center', maxWidth: 800, width: '100%' }]}
        keyboardShouldPersistTaps="handled"
      >

        {/* ── Section 1: Order Type (Moved to Top) ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionIcon}>
              <Ionicons name="cart" size={20} color={Colors.primary} />
            </View>
            <Text style={styles.sectionTitle}>Order Type</Text>
          </View>
          <View style={styles.orderTypeRow}>
            {ORDER_TYPES.map(t => (
              <TouchableOpacity
                key={t.key}
                style={[styles.orderTypeBtn, orderType === t.key && { backgroundColor: t.color, borderColor: t.color }]}
                onPress={() => setOrderType(t.key)}
              >
                <Ionicons name={t.icon} size={24} color={orderType === t.key ? '#fff' : t.color} />
                <Text style={[styles.orderTypeBtnText, orderType === t.key && { color: '#fff' }]}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {locations.length > 1 && (
            <View style={{ marginTop: Spacing.sm }}>
              <Text style={styles.label}>Location</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: Spacing.xs }}>
                {locations.map(loc => (
                  <TouchableOpacity
                    key={loc.id}
                    style={[styles.chip, selectedLocation === loc.id && styles.chipActive]}
                    onPress={() => setSelectedLocation(loc.id)}
                  >
                    <Text style={[styles.chipText, selectedLocation === loc.id && styles.chipTextActive]}>{loc.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Scheduled date/time — for pickup, delivery */}
          {(orderType === 'pickup' || orderType === 'delivery') && (
            <View style={{ marginTop: Spacing.md }}>
              <Text style={styles.label}>Scheduled Date & Time (optional)</Text>
              <View style={[styles.fieldRow, { gap: Spacing.sm }]}>
                <TouchableOpacity
                  style={[styles.input, { flex: 1, flexDirection: 'row', alignItems: 'center' }]}
                  onPress={() => setShowDatePicker(true)}
                >
                  <Ionicons name="calendar-outline" size={18} color={scheduledDate ? Colors.primary : Colors.textLight} style={{ marginRight: 8 }} />
                  <Text style={{ color: scheduledDate ? Colors.text : Colors.textLight }}>
                    {scheduledDate || 'Select Date'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.input, { flex: 1, flexDirection: 'row', alignItems: 'center' }]}
                  onPress={() => setShowTimePicker(true)}
                >
                  <Ionicons name="time-outline" size={18} color={scheduledTime ? Colors.primary : Colors.textLight} style={{ marginRight: 8 }} />
                  <Text style={{ color: scheduledTime ? Colors.text : Colors.textLight }}>
                    {scheduledTime || 'Select Time'}
                  </Text>
                </TouchableOpacity>
              </View>
              {(scheduledDate || scheduledTime) && (
                <TouchableOpacity onPress={() => { setScheduledDate(''); setScheduledTime(''); }} style={{ marginTop: 4 }}>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.error }}>Clear date/time</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>

        {/* ── Section 2: Customer / Receiver ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionIcon}>
              <Ionicons name="person" size={20} color={Colors.primary} />
            </View>
            <Text style={styles.sectionTitle}>{orderType === 'delivery' ? 'Sender & Receiver Details' : 'Customer Details'}</Text>
          </View>
          <View style={styles.fieldRow}>
            <View style={styles.fieldHalf}>
              <Text style={styles.label}>{orderType === 'delivery' ? 'Customer / Sender Phone *' : 'Phone *'}</Text>
              <TextInput
                style={styles.input}
                value={customerPhone}
                onChangeText={handlePhoneChange}
                placeholder="Phone number"
                placeholderTextColor={Colors.textLight}
                keyboardType="phone-pad"
              />
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
            </View>
            <View style={styles.fieldHalf}>
              <Text style={styles.label}>{orderType === 'delivery' ? 'Customer / Sender Name *' : 'Name *'}</Text>
              <TextInput
                style={styles.input}
                value={customerName}
                onChangeText={setCustomerName}
                placeholder="Name"
                placeholderTextColor={Colors.textLight}
              />
            </View>
          </View>
          {customerHistory && (
            <View style={styles.customerHint}>
              <Ionicons name="person-circle" size={16} color={Colors.primary} />
              <Text style={styles.customerHintText}>
                {customerId ? '✓ Registered' : 'Returning'} customer • {customerHistory.order_count} orders • ₹{(customerHistory.total_spent || 0).toFixed(0)} total
              </Text>
            </View>
          )}
          {orderType === 'delivery' && (
            <>
              <TouchableOpacity
                style={styles.checkRow}
                onPress={() => {
                  const next = !useCustomerAsSender;
                  if (!next) {
                    if (!senderName) setSenderName(customerName || '');
                    if (!senderPhone) setSenderPhone(customerPhone || '');
                  }
                  setUseCustomerAsSender(next);
                }}
              >
                <Ionicons name={useCustomerAsSender ? 'checkbox' : 'square-outline'} size={20} color={useCustomerAsSender ? Colors.primary : Colors.textLight} />
                <Text style={styles.checkLabel}>Use customer as sender</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.checkRow} onPress={() => setSenderSameAsReceiver(!senderSameAsReceiver)}>
                <Ionicons name={senderSameAsReceiver ? 'checkbox' : 'square-outline'} size={20} color={senderSameAsReceiver ? Colors.primary : Colors.textLight} />
                <Text style={styles.checkLabel}>Self Receive</Text>
              </TouchableOpacity>

              {!useCustomerAsSender && (
                <>
                  <Text style={styles.label}>Sender Details *</Text>
                  <View style={styles.fieldRow}>
                    <View style={styles.fieldHalf}>
                      <TextInput
                        style={styles.input}
                        value={senderName}
                        onChangeText={setSenderName}
                        placeholder="Sender name"
                        placeholderTextColor={Colors.textLight}
                      />
                    </View>
                    <View style={styles.fieldHalf}>
                      <TextInput
                        style={styles.input}
                        value={senderPhone}
                        onChangeText={setSenderPhone}
                        placeholder="Sender phone"
                        placeholderTextColor={Colors.textLight}
                        keyboardType="phone-pad"
                      />
                    </View>
                  </View>
                </>
              )}

              {!senderSameAsReceiver && (
                <>
                  <Text style={styles.label}>Receiver Details *</Text>
                  <View style={styles.fieldRow}>
                    <View style={styles.fieldHalf}>
                      <TextInput
                        style={styles.input}
                        value={receiverPhone}
                        onChangeText={handleReceiverPhoneChange}
                        placeholder="Receiver phone"
                        placeholderTextColor={Colors.textLight}
                        keyboardType="phone-pad"
                      />
                      {showReceiverSuggestions && receiverSuggestions.length > 0 && (
                        <View style={styles.suggestionsBox}>
                          {receiverSuggestions.map((c, idx) => (
                            <TouchableOpacity key={c.phone + idx} style={styles.suggestionItem} onPress={() => selectReceiver(c)}>
                              <Ionicons name={c.id ? 'person' : 'person-outline'} size={16} color={Colors.primary} />
                              <View style={{ flex: 1, marginLeft: 8 }}>
                                <Text style={styles.suggestionName}>{c.name || 'Unknown'}</Text>
                                <Text style={styles.suggestionPhone}>{c.phone}{c.total_spent > 0 ? ` • ₹${Math.round(c.total_spent)}` : ''}</Text>
                              </View>
                            </TouchableOpacity>
                          ))}
                        </View>
                      )}
                    </View>
                    <View style={styles.fieldHalf}>
                      <TextInput
                        style={styles.input}
                        value={receiverName}
                        onChangeText={setReceiverName}
                        placeholder="Receiver name"
                        placeholderTextColor={Colors.textLight}
                      />
                    </View>
                  </View>
                  {receiverHistory && (
                    <View style={styles.customerHint}>
                      <Ionicons name="person-circle" size={16} color={Colors.primary} />
                      <Text style={styles.customerHintText}>
                        {receiverId ? '✓ Registered' : 'Returning'} receiver • {receiverHistory.order_count} orders • ₹{(receiverHistory.total_spent || 0).toFixed(0)} total
                      </Text>
                    </View>
                  )}
                </>
              )}

              <Text style={styles.label}>Delivery Address *</Text>
              <TextInput
                style={[styles.input, { minHeight: 60, textAlignVertical: 'top' }]}
                value={customerAddress}
                onChangeText={setCustomerAddress}
                placeholder="Full delivery address"
                placeholderTextColor={Colors.textLight}
                multiline
              />

              <Text style={styles.label}>Sender Address (optional)</Text>
              <TextInput
                style={[styles.input, { minHeight: 44, textAlignVertical: 'top' }]}
                value={senderAddress}
                onChangeText={setSenderAddress}
                placeholder="Sender address"
                placeholderTextColor={Colors.textLight}
                multiline
              />

              <Text style={styles.label}>Message / Card Text (optional)</Text>
              <TextInput
                style={[styles.input, { minHeight: 60 }]}
                value={senderMessage}
                onChangeText={setSenderMessage}
                placeholder="Message for the recipient..."
                placeholderTextColor={Colors.textLight}
                multiline
              />
            </>
          )}

          <Text style={styles.label}>{orderType === 'delivery' ? 'Special Comment (optional)' : 'Order Notes / Instructions (optional)'}</Text>
          <TextInput
            style={[styles.input, { minHeight: 44 }]}
            value={orderNotes}
            onChangeText={setOrderNotes}
            placeholder={orderType === 'delivery' ? 'Any special comment for delivery slip...' : 'Special instructions for the overall order...'}
            placeholderTextColor={Colors.textLight}
            multiline
          />
        </View>

        {/* ── Section 3: Items (moved below Customer) ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionIcon}>
              <Ionicons name="gift" size={20} color={Colors.primary} />
            </View>
            <Text style={styles.sectionTitle}>Items ({items.length})</Text>
            <TouchableOpacity style={styles.addItemBtn} onPress={addItem}>
              <Ionicons name="add-circle" size={20} color={Colors.white} />
              <Text style={styles.addItemBtnText}>Add Item</Text>
            </TouchableOpacity>
          </View>

          {items.length === 0 && (
            <View style={styles.emptyItems}>
              <Ionicons name="gift-outline" size={48} color={Colors.textLight} />
              <Text style={styles.emptyText}>No items yet — tap "Add Item" to start</Text>
            </View>
          )}

          {items.map((item, idx) => (
            <View key={idx} style={styles.itemCard}>
              <View style={styles.itemCardHeader}>
                <Text style={styles.itemNum}>#{idx + 1}</Text>
                <TouchableOpacity onPress={() => removeItem(idx)}>
                  <Ionicons name="trash-outline" size={20} color={Colors.error} />
                </TouchableOpacity>
              </View>

              {/* Product name / select base product */}
              <View style={styles.fieldRow}>
                <View style={{ flex: 2 }}>
                  <Text style={styles.label}>Product Name *</Text>
                  <TextInput
                    style={styles.input}
                    value={item.name}
                    onChangeText={(v) => updateItem(idx, 'name', v)}
                    placeholder="e.g. Custom Bouquet"
                    placeholderTextColor={Colors.textLight}
                  />
                </View>
                <TouchableOpacity
                  style={styles.pickProductBtn}
                  onPress={() => {
                    setEditingItemIdx(idx);
                    setProductSearch('');
                    fetchProducts('');
                    setShowProductPicker(true);
                  }}
                >
                  <Ionicons name="search" size={18} color={Colors.primary} />
                  <Text style={styles.pickProductText}>Pick</Text>
                </TouchableOpacity>
              </View>

              {item.baseProduct && (
                <View style={styles.baseProductTag}>
                  {item.baseProduct.image_url ? (
                    <Image source={{ uri: item.baseProduct.image_url }} style={{ width: 24, height: 24, borderRadius: 4 }} />
                  ) : (
                    <Ionicons name="gift" size={16} color={Colors.primary} />
                  )}
                  <Text style={styles.baseProductTagText}>Based on: {item.baseProduct.name}</Text>
                </View>
              )}

              {/* Price + Quantity */}
              <View style={styles.fieldRow}>
                <View style={styles.fieldHalf}>
                  <Text style={styles.label}>Price (₹) *</Text>
                  <TextInput
                    style={styles.input}
                    value={item.price}
                    onChangeText={(v) => updateItem(idx, 'price', v)}
                    placeholder="0"
                    placeholderTextColor={Colors.textLight}
                    keyboardType="numeric"
                  />
                </View>
                <View style={styles.fieldHalf}>
                  <Text style={styles.label}>Qty</Text>
                  <View style={styles.qtyRow}>
                    <TouchableOpacity
                      style={styles.qtyBtn}
                      onPress={() => updateItem(idx, 'quantity', String(Math.max(1, (parseInt(item.quantity) || 1) - 1)))}
                    >
                      <Ionicons name="remove" size={20} color={Colors.primary} />
                    </TouchableOpacity>
                    <TextInput
                      style={[styles.input, { textAlign: 'center', flex: 1 }]}
                      value={item.quantity}
                      onChangeText={(v) => updateItem(idx, 'quantity', v)}
                      keyboardType="numeric"
                    />
                    <TouchableOpacity
                      style={styles.qtyBtn}
                      onPress={() => updateItem(idx, 'quantity', String((parseInt(item.quantity) || 1) + 1))}
                    >
                      <Ionicons name="add" size={20} color={Colors.primary} />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>

              {/* Fulfill From Stock Toggle */}
              {orderType === 'walk_in' && item.baseProduct && (item.baseProduct.ready_qty > 0 || item.baseProduct.stock_quantity > 0) && !item.special_instructions && (
                <TouchableOpacity
                  style={{
                    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
                    marginTop: 8, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12,
                    backgroundColor: item.fulfill_from_stock ? Colors.success + '15' : Colors.textLight + '10',
                    borderWidth: 1, borderColor: item.fulfill_from_stock ? Colors.success + '40' : Colors.textLight + '30',
                    gap: 4
                  }}
                  onPress={() => updateItem(idx, 'fulfill_from_stock', !item.fulfill_from_stock)}
                >
                  <Ionicons
                    name={item.fulfill_from_stock ? 'checkmark-circle' : 'cube-outline'}
                    size={14}
                    color={item.fulfill_from_stock ? Colors.success : Colors.textSecondary}
                  />
                  <Text style={{ fontSize: 11, fontWeight: '600', color: item.fulfill_from_stock ? Colors.success : Colors.textSecondary }}>
                    {item.fulfill_from_stock ? 'From Stock' : 'Use Stock?'}
                  </Text>
                </TouchableOpacity>
              )}

              {/* Materials */}
              <View style={styles.materialsSection}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={styles.label}>Materials Used</Text>
                  <TouchableOpacity onPress={() => addMaterialToItem(idx)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Ionicons name="add-circle-outline" size={16} color={Colors.primary} />
                    <Text style={{ fontSize: 12, color: Colors.primary, fontWeight: '600' }}>Add</Text>
                  </TouchableOpacity>
                </View>
                {item.materials.map((m, matIdx) => (
                  <View key={matIdx} style={styles.materialRow}>
                    <TouchableOpacity
                      style={[styles.input, { flex: 2, justifyContent: 'center' }]}
                      onPress={() => openMaterialPicker(idx, matIdx)}
                    >
                      <Text style={{ color: m.material_id ? Colors.text : Colors.textLight, fontSize: FontSize.sm }}>
                        {m.name || 'Select...'}
                      </Text>
                    </TouchableOpacity>
                    <TextInput
                      style={[styles.input, { flex: 1 }]}
                      value={m.qty}
                      onChangeText={(v) => updateItemMaterial(idx, matIdx, 'qty', v)}
                      placeholder="Qty"
                      placeholderTextColor={Colors.textLight}
                      keyboardType="numeric"
                    />
                    <TouchableOpacity onPress={() => removeMaterialFromItem(idx, matIdx)}>
                      <Ionicons name="close-circle" size={20} color={Colors.error} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>

              {/* Special Instructions & Image */}
              <View style={[styles.fieldRow, { flexWrap: 'nowrap', alignItems: 'center' }]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Special Instructions (Optional)</Text>
                  <TextInput
                    style={styles.input}
                    value={item.special_instructions}
                    onChangeText={(v) => updateItem(idx, 'special_instructions', v)}
                    placeholder="Notes for production..."
                    placeholderTextColor={Colors.textLight}
                  />
                </View>
                <Pressable
                  style={({ pressed }) => [
                    styles.pickProductBtn,
                    { 
                      minWidth: 90, 
                      marginLeft: 10, 
                      justifyContent: 'center', 
                      height: 50, 
                      marginTop: 10, 
                      zIndex: 1000,
                      opacity: pressed ? 0.6 : 1,
                      borderWidth: 1,
                      borderColor: Colors.primary + '30',
                      backgroundColor: pressed ? Colors.primary + '25' : Colors.primary + '15'
                    }
                  ]}
                  onPress={() => pickImage(idx)}
                  hitSlop={15}
                >
                  {item.image_url ? (
                    <Image source={{ uri: item.image_url }} style={{ width: 40, height: 40, borderRadius: 4 }} />
                  ) : (
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Ionicons name="camera-outline" size={24} color={Colors.primary} />
                      <Text style={[styles.pickProductText, { marginLeft: 6 }]}>Photo</Text>
                    </View>
                  )}
                </Pressable>
              </View>

              {/* Item total */}
              <View style={styles.itemTotal}>
                <Text style={styles.itemTotalLabel}>Item Total</Text>
                <Text style={styles.itemTotalValue}>₹{getItemTotal(item).toFixed(0)}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* ── Section 4: Payment & Totals ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionIcon}>
              <Ionicons name="cash" size={20} color={Colors.primary} />
            </View>
            <Text style={styles.sectionTitle}>Payment & Charges</Text>
          </View>

          <View style={styles.fieldRow}>
            {orderType === 'delivery' && (
              <View style={styles.fieldHalf}>
                <Text style={styles.label}>Delivery Charge (₹)</Text>
                <TextInput
                  style={styles.input}
                  value={deliveryCharges}
                  onChangeText={setDeliveryCharges}
                  placeholder="0"
                  placeholderTextColor={Colors.textLight}
                  keyboardType="numeric"
                />
              </View>
            )}
            <View style={styles.fieldHalf}>
              <Text style={styles.label}>Discount ({discountType === 'fixed' ? '₹' : '%'})</Text>
              <View style={{ flexDirection: 'row', gap: 4 }}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  value={discountValue}
                  onChangeText={setDiscountValue}
                  placeholder="0"
                  placeholderTextColor={Colors.textLight}
                  keyboardType="numeric"
                />
                <TouchableOpacity
                  style={[styles.discToggle, { backgroundColor: Colors.surfaceAlt }]}
                  onPress={() => setDiscountType(discountType === 'fixed' ? 'percentage' : 'fixed')}
                >
                  <Text style={{ fontSize: 16, fontWeight: '700', color: Colors.primary }}>
                    {discountType === 'fixed' ? '₹' : '%'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>

          <View style={styles.divider} />

          <Text style={styles.label}>Payment Mode</Text>
          <View style={[styles.orderTypeRow, { flexWrap: 'wrap', gap: 8 }]}>
            {[
              { key: 'pay_now', label: 'Pay Now', icon: 'cash-outline' },
              { key: 'cod', label: 'COD', icon: 'bicycle-outline', hidden: orderType !== 'delivery' },
              { key: 'credit', label: 'Credit', icon: 'time-outline' },
              { key: 'partial', label: 'Partial', icon: 'pie-chart-outline', hidden: orderType === 'walk_in' },
            ].filter(m => !m.hidden).map(m => (
              <TouchableOpacity
                key={m.key}
                style={[styles.orderTypeBtn, { paddingVertical: 8, minWidth: 80, flex: 0 }, paymentMode === m.key && { backgroundColor: Colors.primary, borderColor: Colors.primary }]}
                onPress={() => setPaymentMode(m.key)}
              >
                <Ionicons name={m.icon} size={20} color={paymentMode === m.key ? '#fff' : Colors.primary} />
                <Text style={{ fontSize: 13, fontWeight: '600', color: paymentMode === m.key ? '#fff' : Colors.textSecondary }}>{m.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {paymentMode === 'partial' && (
            <View style={{ marginTop: Spacing.sm }}>
              <Text style={styles.label}>Advance Payment (₹)</Text>
              <TextInput
                style={styles.input}
                value={advanceAmount}
                onChangeText={setAdvanceAmount}
                placeholder="Enter advance amount"
                placeholderTextColor={Colors.textLight}
                keyboardType="numeric"
              />
              {parseFloat(advanceAmount) > 0 && (
                <Text style={[styles.label, { color: Colors.warning, marginTop: 4 }]}>
                  Balance ₹{(totals.finalTotal - (parseFloat(advanceAmount) || 0)).toFixed(0)} to be collected later
                </Text>
              )}
            </View>
          )}

          {paymentMode === 'pay_now' && (
            <>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: Spacing.sm }}>
                <Text style={styles.label}>Payment Method</Text>
                <TouchableOpacity onPress={() => setEnableSplitPayment(!enableSplitPayment)}>
                  <Text style={{ fontSize: 12, color: Colors.primary, fontWeight: '700' }}>
                    {enableSplitPayment ? 'Single Payment' : '+ Split Payment'}
                  </Text>
                </TouchableOpacity>
              </View>

              {!enableSplitPayment ? (
                <View style={[styles.orderTypeRow, { marginTop: 4 }]}>
                  {['cash', 'card', 'upi'].map(m => (
                    <TouchableOpacity
                      key={m}
                      style={[styles.payMethodBtn, paymentMethod === m && styles.payMethodBtnActive]}
                      onPress={() => setPaymentMethod(m)}
                    >
                      <Ionicons
                        name={m === 'cash' ? 'cash-outline' : m === 'card' ? 'card-outline' : 'phone-portrait-outline'}
                        size={18}
                        color={paymentMethod === m ? Colors.white : Colors.textSecondary}
                      />
                      <Text style={[styles.payMethodText, paymentMethod === m && styles.payMethodTextActive]}>
                        {m.toUpperCase()}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                <View style={{ gap: 8, marginTop: 4 }}>
                  {payments.map((pmt, pIdx) => (
                    <View key={pIdx} style={[styles.fieldRow, { alignItems: 'center' }]}>
                      <View style={{ width: 80 }}>
                        <TouchableOpacity
                          style={styles.input}
                          onPress={() => {
                            const newP = [...payments];
                            const methods = ['cash', 'card', 'upi'];
                            const curIdx = methods.indexOf(pmt.method);
                            newP[pIdx].method = methods[(curIdx + 1) % 3];
                            setPayments(newP);
                          }}
                        >
                          <Text style={{ fontSize: 12, textAlign: 'center' }}>{pmt.method.toUpperCase()}</Text>
                        </TouchableOpacity>
                      </View>
                      <TextInput
                        style={[styles.input, { flex: 1 }]}
                        value={pmt.amount}
                        onChangeText={(v) => {
                          const newP = [...payments];
                          newP[pIdx].amount = v;
                          setPayments(newP);
                        }}
                        placeholder="Amount"
                        keyboardType="numeric"
                      />
                      {payments.length > 1 && (
                        <TouchableOpacity onPress={() => setPayments(payments.filter((_, i) => i !== pIdx))}>
                          <Ionicons name="trash-outline" size={20} color={Colors.error} />
                        </TouchableOpacity>
                      )}
                    </View>
                  ))}
                  <TouchableOpacity
                    style={{ alignSelf: 'flex-start' }}
                    onPress={() => setPayments([...payments, { method: 'card', amount: '', reference: '' }])}
                  >
                    <Text style={{ fontSize: 12, color: Colors.primary }}>+ Add Another Method</Text>
                  </TouchableOpacity>
                </View>
              )}

              {paymentMethod !== 'cash' && !enableSplitPayment && (
                <TextInput
                  style={[styles.input, { marginTop: Spacing.xs }]}
                  value={paymentReference}
                  onChangeText={setPaymentReference}
                  placeholder="Ref / Transaction ID (optional)"
                  placeholderTextColor={Colors.textLight}
                />
              )}
            </>
          )}

          {paymentMode === 'cod' && (
            <View style={[styles.customerHint, { backgroundColor: Colors.warning + '15' }]}>
              <Ionicons name="information-circle" size={16} color={Colors.warning} />
              <Text style={styles.customerHintText}>Amount will be collected on delivery.</Text>
            </View>
          )}

          {paymentMode === 'credit' && (
            <View style={[styles.customerHint, { backgroundColor: Colors.error + '15' }]}>
              <Ionicons name="alert-circle" size={16} color={Colors.error} />
              <Text style={styles.customerHintText}>Sale will be added to customer credit.</Text>
            </View>
          )}

          <View style={styles.grandTotalBox}>
            <View style={styles.summaryLine}>
              <Text style={styles.summaryLabel}>Subtotal</Text>
              <Text style={styles.summaryValue}>₹{totals.subtotal.toFixed(2)}</Text>
            </View>
            <View style={styles.summaryLine}>
              <Text style={styles.summaryLabel}>Discount</Text>
              <Text style={styles.summaryValue}>-₹{totals.discountAmount.toFixed(2)}</Text>
            </View>
            <View style={styles.summaryLine}>
              <Text style={styles.summaryLabel}>Tax</Text>
              <Text style={styles.summaryValue}>+₹{totals.taxTotal.toFixed(2)}</Text>
            </View>
            {orderType === 'delivery' && (
              <View style={styles.summaryLine}>
                <Text style={styles.summaryLabel}>Delivery</Text>
                <Text style={styles.summaryValue}>+₹{totals.delivery.toFixed(2)}</Text>
              </View>
            )}
            <View style={[styles.divider, { marginVertical: Spacing.sm }]} />
            <View style={styles.grandTotalRow}>
              <Text style={styles.grandTotalLabel}>Grand Total</Text>
              <Text style={styles.grandTotalValue}>₹{totals.finalTotal.toFixed(2)}</Text>
            </View>
          </View>

          <TouchableOpacity
            style={[styles.placeOrderBtn, submitting && { opacity: 0.6 }]}
            onPress={handlePlaceOrder}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="checkmark-done-circle" size={24} color="#fff" />
                <Text style={styles.placeOrderText}>Confirm & Finish Order</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ── Product Picker Modal ── */}
      <Modal visible={showProductPicker} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ width: '100%', alignItems: 'center' }}
          >
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Select Product</Text>
                <TouchableOpacity onPress={() => setShowProductPicker(false)}>
                  <Ionicons name="close" size={24} color={Colors.text} />
                </TouchableOpacity>
              </View>
              <View style={styles.searchRow}>
                <Ionicons name="search" size={18} color={Colors.textLight} />
                <TextInput
                  style={styles.searchInput}
                  value={productSearch}
                  onChangeText={(v) => { setProductSearch(v); fetchProducts(v); }}
                  placeholder="Search products..."
                  placeholderTextColor={Colors.textLight}
                  autoFocus
                />
              </View>
              <ScrollView style={{ maxHeight: 400 }}>
                {products.map(p => (
                  <TouchableOpacity
                    key={p.id}
                    style={styles.productPickItem}
                    onPress={() => addFromProduct(p, editingItemIdx)}
                  >
                    <View style={styles.productPickIcon}>
                      {p.image_url ? (
                        <Image source={{ uri: p.image_url }} style={{ width: 40, height: 40, borderRadius: 8 }} />
                      ) : (
                        <Ionicons name="gift" size={22} color={Colors.primary} />
                      )}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.productPickName}>{p.name}</Text>
                      <Text style={styles.productPickPrice}>₹{(p.selling_price || 0).toFixed(0)}</Text>
                    </View>
                    <Ionicons name="add-circle" size={24} color={Colors.success} />
                  </TouchableOpacity>
                ))}
                {products.length === 0 && (
                  <Text style={styles.emptyText}>No products found</Text>
                )}
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>

      {/* Material Picker Modal */}
      <Modal visible={showMaterialPicker} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ width: '100%', alignItems: 'center' }}
          >
            <View style={[styles.modalCard, { width: '90%', maxWidth: 500, paddingBottom: 20 }]}>
              <View style={styles.modalHeader}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={[styles.sectionIcon, { width: 32, height: 32 }]}>
                    <Ionicons name="leaf-outline" size={18} color={Colors.primary} />
                  </View>
                  <Text style={styles.modalTitle}>Select Material</Text>
                </View>
                <TouchableOpacity onPress={() => setShowMaterialPicker(false)} style={styles.closeBtn}>
                  <Ionicons name="close" size={22} color={Colors.text} />
                </TouchableOpacity>
              </View>

              <View style={styles.searchRow}>
                <Ionicons name="search" size={18} color={Colors.textLight} />
                <TextInput
                  style={styles.searchInput}
                  value={materialSearch}
                  onChangeText={setMaterialSearch}
                  placeholder="Search materials by name..."
                  placeholderTextColor={Colors.textLight}
                  autoFocus
                />
              </View>

              <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>
                <View style={{ gap: 8 }}>
                  {allMaterials
                    .filter(m => {
                      const searchMatches = m.name.toLowerCase().includes(materialSearch.toLowerCase());
                      const item = items[editingItemIdx];
                      const alreadySelected = item?.materials.some((qm, qi) => qi !== editingMaterialIdx && qm.material_id === m.id);
                      return searchMatches && !alreadySelected;
                    })
                    .slice(0, 50)
                    .map(m => (
                      <TouchableOpacity
                        key={m.id}
                        style={styles.materialPickCard}
                        onPress={() => {
                          selectMaterialForItem(editingItemIdx, editingMaterialIdx, m);
                          setShowMaterialPicker(false);
                        }}
                      >
                        <View style={styles.materialIconBox}>
                          <Ionicons name="apps-outline" size={20} color={Colors.primary} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.materialPickName}>{m.name}</Text>
                          <Text style={styles.materialPickCategory}>{m.category_name || 'General Material'}</Text>
                        </View>
                        <View style={styles.addCircle}>
                          <Ionicons name="add" size={20} color={Colors.primary} />
                        </View>
                      </TouchableOpacity>
                    ))}
                </View>
                {allMaterials.filter(m => m.name.toLowerCase().includes(materialSearch.toLowerCase())).length === 0 && (
                  <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                    <Ionicons name="search-outline" size={40} color={Colors.textLight} />
                    <Text style={[styles.emptyText, { marginTop: 8 }]}>No matching materials found</Text>
                  </View>
                )}
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>

      <DateTimePickerModal
        visible={showDatePicker}
        mode="date"
        value={datePickerDate}
        minimumDate={getShopNow(timezone)}
        onConfirm={handleDateConfirm}
        onCancel={() => setShowDatePicker(false)}
      />
      <DateTimePickerModal
        visible={showTimePicker}
        mode="time"
        date={datePickerDate}
        onConfirm={handleTimeConfirm}
        onCancel={() => setShowTimePicker(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: 100 },

  section: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: Spacing.md,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 3,
  },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md,
  },
  sectionIcon: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: Colors.primary + '15', justifyContent: 'center', alignItems: 'center',
    marginRight: Spacing.sm,
  },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, flex: 1 },
  closeBtn: { padding: 4, borderRadius: 20, backgroundColor: Colors.background },

  label: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary, marginBottom: 4, marginTop: Spacing.xs },
  input: {
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm, fontSize: FontSize.md, color: Colors.text,
    minHeight: 44,
  },
  fieldRow: { flexDirection: 'row', gap: Spacing.sm, flexWrap: 'wrap', zIndex: 10 },
  fieldHalf: { flex: 1, minWidth: 150 },

  orderTypeRow: { flexDirection: 'row', gap: Spacing.sm, flexWrap: 'wrap' },
  orderTypeBtn: {
    flex: 1, minWidth: 100, alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingVertical: Spacing.md, borderRadius: BorderRadius.lg,
    backgroundColor: Colors.background, borderWidth: 2, borderColor: Colors.border,
    minHeight: 64,
  },
  orderTypeBtnText: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary },

  chip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, borderRadius: BorderRadius.full,
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.white },

  checkRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.sm, paddingVertical: Spacing.sm,
    marginTop: Spacing.xs,
  },
  checkLabel: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '600' },

  addItemBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.primary, paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm, borderRadius: BorderRadius.md,
  },
  addItemBtnText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.sm },

  emptyItems: { alignItems: 'center', paddingVertical: Spacing.xl },
  emptyText: { color: Colors.textLight, marginTop: Spacing.sm, fontSize: FontSize.sm, textAlign: 'center', padding: Spacing.md },

  itemCard: {
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border,
  },
  itemCardHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  itemNum: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },

  pickProductBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.primary + '15', paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, alignSelf: 'flex-end',
    minHeight: 44, marginTop: 24,
  },
  pickProductText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },

  baseProductTag: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.successLight || '#E8F5E9', paddingHorizontal: Spacing.sm,
    paddingVertical: 6, borderRadius: BorderRadius.sm, marginTop: Spacing.xs, marginBottom: Spacing.xs,
  },
  baseProductTagText: { fontSize: FontSize.xs, color: Colors.success, fontWeight: '600' },

  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  qtyBtn: {
    width: 44, height: 44, borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary + '15', justifyContent: 'center', alignItems: 'center',
  },

  materialsSection: {
    marginTop: Spacing.sm, paddingTop: Spacing.sm,
    borderTopWidth: 1, borderTopColor: Colors.border,
  },
  materialRow: {
    flexDirection: 'row', gap: Spacing.xs, alignItems: 'center', marginBottom: Spacing.xs,
  },

  itemTotal: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: Spacing.sm, paddingTop: Spacing.sm,
    borderTopWidth: 1, borderTopColor: Colors.border,
  },
  itemTotalLabel: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  itemTotalValue: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.success },

  grandTotalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.md,
  },
  grandTotalLabel: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  grandTotalValue: { fontSize: FontSize.xxl, fontWeight: '700', color: Colors.primary },

  divider: { height: 1, backgroundColor: Colors.border, marginVertical: Spacing.md },

  discToggle: {
    width: 44, height: 44, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
    justifyContent: 'center', alignItems: 'center',
  },

  payMethodBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: Spacing.sm, borderRadius: BorderRadius.md,
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
    minHeight: 44,
  },
  payMethodBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  payMethodText: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary },
  payMethodTextActive: { color: Colors.white },

  grandTotalBox: { marginTop: Spacing.md, gap: 4 },
  summaryLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  summaryLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  summaryValue: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '600' },

  customerHint: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.primary + '10', padding: 10, borderRadius: BorderRadius.md, marginTop: Spacing.sm,
  },
  customerHintText: { fontSize: 12, color: Colors.text, flex: 1 },

  placeOrderBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.success, paddingVertical: Spacing.md,
    borderRadius: BorderRadius.lg, marginTop: Spacing.lg,
    shadowColor: Colors.success, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 6,
  },
  placeOrderText: { color: Colors.white, fontWeight: '800', fontSize: FontSize.lg },

  // Modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: Spacing.lg, maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.md,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm, marginBottom: Spacing.md,
    borderWidth: 1, borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: FontSize.md, color: Colors.text, minHeight: 44 },

  productPickItem: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingVertical: Spacing.sm, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  productPickIcon: {
    width: 44, height: 44, borderRadius: 10,
    backgroundColor: Colors.primary + '12', justifyContent: 'center', alignItems: 'center',
  },
  productPickName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  productPickPrice: { fontSize: FontSize.sm, color: Colors.success, fontWeight: '600' },

  // Material Picker specific
  materialPickCard: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    padding: Spacing.sm, borderWidth: 1, borderColor: Colors.border,
  },
  materialIconBox: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: Colors.primary + '10', justifyContent: 'center', alignItems: 'center',
  },
  materialPickName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  materialPickCategory: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },
  addCircle: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: Colors.primary + '10', justifyContent: 'center', alignItems: 'center',
  },

  // Suggestions
  suggestionsBox: {
    position: 'absolute', top: 72, left: 0, right: 0,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
    zIndex: 1000, elevation: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.1, shadowRadius: 8,
  },
  suggestionItem: {
    flexDirection: 'row', alignItems: 'center', padding: 12,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  suggestionName: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },
  suggestionPhone: { fontSize: 12, color: Colors.textSecondary },
});
