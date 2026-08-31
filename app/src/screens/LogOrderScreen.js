import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator, Alert, Platform, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import api from '../services/api';
import VoiceNoteRecorder from '../components/VoiceNoteRecorder';
import DateTimePickerModal from '../components/DateTimePickerModal';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { useAuth } from '../context/AuthContext';
import { getShopNow } from '../utils/datetime';
import { bumpActivity } from '../hooks/useIdleLock';

const CHANNELS = [
  { key: 'whatsapp', label: 'WhatsApp', icon: 'logo-whatsapp' },
  { key: 'email', label: 'Email', icon: 'mail' },
  { key: 'website', label: 'Website', icon: 'globe' },
  { key: 'phone', label: 'Phone', icon: 'call' },
];
const LAST_CHANNEL_KEY = 'lastLogOrderChannel';

const PAYMENT_METHODS = [
  { key: 'cash', label: 'Cash', icon: 'cash-outline' },
  { key: 'card', label: 'Card', icon: 'card-outline' },
  { key: 'upi', label: 'UPI', icon: 'phone-portrait-outline' },
];

// Alert.alert() is a silent no-op on web in this Expo app (see PROGRESS.md bug B2.11) —
// it neither shows a dialog nor fires onPress. Every single-button "OK" alert in this
// screen should go through this helper instead. Multi-button confirms (e.g. the register
// guard below) still use Alert.alert directly but must carry their own web branch —
// see DeliveryDetailScreen.js / QuickCheckoutScreen.js for the established pattern.
function showAlert(title, message, onDismiss) {
  if (Platform.OS === 'web') {
    window.alert(message ? `${title}\n\n${message}` : title);
    if (onDismiss) onDismiss();
  } else {
    Alert.alert(title, message, onDismiss ? [{ text: 'OK', onPress: onDismiss }] : undefined);
  }
}

export default function LogOrderScreen({ navigation }) {
  const { user, activeLocation, settings } = useAuth();
  const timezone = settings?.timezone?.value || 'Asia/Kolkata';

  const [channel, setChannel] = useState('whatsapp');

  // Customer — phone/name with debounced search-as-you-type, matching QuickCheckoutScreen.
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerId, setCustomerId] = useState(null);
  const [customerSuggestions, setCustomerSuggestions] = useState([]);
  const [showCustomerSuggestions, setShowCustomerSuggestions] = useState(false);
  const [customerSearchTarget, setCustomerSearchTarget] = useState('phone');
  const customerSearchTimer = useRef(null);

  const [note, setNote] = useState('');
  const [items, setItems] = useState([]);
  const [customItemName, setCustomItemName] = useState('');
  const [customItemPrice, setCustomItemPrice] = useState('');

  // Product catalog search-as-you-type — a fast path alongside the free-text custom item fallback.
  const [productSearch, setProductSearch] = useState('');
  const [productSuggestions, setProductSuggestions] = useState([]);
  const [showProductSuggestions, setShowProductSuggestions] = useState(false);
  const productSearchTimer = useRef(null);

  // Payment — defaults to "not paid yet", the common case for a WhatsApp/phone order.
  const [paymentMode, setPaymentMode] = useState('unpaid'); // 'unpaid' | 'paid_full' | 'partial'
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [paymentAmount, setPaymentAmount] = useState('');

  const [fulfilment, setFulfilment] = useState('pickup');
  const [receiverName, setReceiverName] = useState('');
  const [receiverPhone, setReceiverPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');

  // Scheduled date/time for advance orders — both optional.
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [datePickerDate, setDatePickerDate] = useState(getShopNow(timezone));
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);

  const [priority, setPriority] = useState('normal');

  // Skip-assignment — user-controlled, defaults OFF. An earlier version of this screen
  // hardcoded skip_assignment: true unconditionally, which force-marked every logged
  // order "ready" with production tasks pre-completed before any florist saw them.
  // This must stay an explicit, visible, opt-in staff choice.
  const [skipAssignment, setSkipAssignment] = useState(false);

  const [pendingAttachments, setPendingAttachments] = useState([]);
  // Which item (by index in `items`) currently has the voice-note recording
  // modal open, or null. Per-item photo/voice note — each item can optionally
  // carry its own reference photo/voice note, distinct from the order-level
  // ones above (e.g. "this specific rose needs to be this exact shade").
  const [itemVoiceModalIdx, setItemVoiceModalIdx] = useState(null);
  const [saving, setSaving] = useState(false);

  const [vendorName, setVendorName] = useState('');

  useEffect(() => {
    // Remember last-used channel per staff member, per staff-ux-checklist §4
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      AsyncStorage.getItem(LAST_CHANNEL_KEY).then((v) => { if (v) setChannel(v); });
    } catch { /* ignore */ }
  }, []);

  const selectChannel = (key) => {
    setChannel(key);
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      AsyncStorage.setItem(LAST_CHANNEL_KEY, key);
    } catch { /* ignore */ }
  };

  // ── Customer search-as-you-type (mirrors QuickCheckoutScreen's handlePhoneChange/
  // handleNameChange/selectCustomer, without the sender/receiver duplication this
  // screen doesn't need — just the single buyer phone+name pair). ──
  const handlePhoneChange = useCallback((rawText) => {
    const text = rawText.replace(/[^0-9+\-\s()]/g, '');
    setCustomerPhone(text);
    setCustomerId(null);
    setShowCustomerSuggestions(false);
    if (customerSearchTimer.current) clearTimeout(customerSearchTimer.current);
    if (text.length >= 3) {
      customerSearchTimer.current = setTimeout(async () => {
        try {
          const res = await api.customerSearch(text);
          if (res.data && res.data.length > 0) {
            setCustomerSearchTarget('phone');
            setCustomerSuggestions(res.data);
            setShowCustomerSuggestions(true);
          } else {
            setCustomerSuggestions([]);
            setShowCustomerSuggestions(false);
          }
        } catch { /* ignore — not found is a normal quick-add path */ }
      }, 300);
    } else {
      setCustomerSuggestions([]);
    }
  }, []);

  const handleNameChange = useCallback((text) => {
    setCustomerName(text);
    setShowCustomerSuggestions(false);
    if (customerSearchTimer.current) clearTimeout(customerSearchTimer.current);
    if (text.length >= 3) {
      customerSearchTimer.current = setTimeout(async () => {
        try {
          const res = await api.customerSearch(text);
          if (res.data && res.data.length > 0) {
            setCustomerSearchTarget('name');
            setCustomerSuggestions(res.data);
            setShowCustomerSuggestions(true);
          } else {
            setCustomerSuggestions([]);
            setShowCustomerSuggestions(false);
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
    setCustomerId(c.id || null); // customerSearch results carry a real id, unlike customerLookup
    setShowCustomerSuggestions(false);
    setCustomerSuggestions([]);
  }, []);

  // ── Product catalog search-as-you-type ──
  const handleProductSearchChange = useCallback((text) => {
    setProductSearch(text);
    if (productSearchTimer.current) clearTimeout(productSearchTimer.current);
    if (text.trim().length >= 2) {
      productSearchTimer.current = setTimeout(async () => {
        try {
          const res = await api.getProducts({ search: text.trim(), limit: 8 });
          const results = res.data || [];
          setProductSuggestions(results);
          setShowProductSuggestions(results.length > 0);
        } catch { /* ignore */ }
      }, 300);
    } else {
      setProductSuggestions([]);
      setShowProductSuggestions(false);
    }
  }, []);

  const selectProduct = (product) => {
    setItems((prev) => [...prev, {
      product_id: product.id,
      product_name: product.name,
      quantity: 1,
      unit_price: Number(product.selling_price) || 0,
    }]);
    setProductSearch('');
    setProductSuggestions([]);
    setShowProductSuggestions(false);
  };

  const pickReferencePhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      showAlert('Permission Required', 'Please allow access to your photo library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8, allowsEditing: true });
    if (result.canceled) return;
    setPendingAttachments((prev) => [...prev, { uri: result.assets[0].uri, type: 'photo', durationSeconds: null }]);
  };

  const addCustomItem = () => {
    if (!customItemName.trim()) return;
    setItems((prev) => [...prev, {
      product_id: null,
      product_name: customItemName.trim(),
      quantity: 1,
      unit_price: parseFloat(customItemPrice) || 0,
    }]);
    setCustomItemName('');
    setCustomItemPrice('');
  };

  const removeItem = (idx) => setItems((prev) => prev.filter((_, i) => i !== idx));

  const pickItemPhoto = async (idx) => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      showAlert('Permission Required', 'Please allow access to your photo library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8, allowsEditing: true });
    if (result.canceled) return;
    setItems((prev) => prev.map((it, i) => (i === idx
      ? { ...it, pendingAttachments: [...(it.pendingAttachments || []), { uri: result.assets[0].uri, type: 'photo', durationSeconds: null }] }
      : it)));
  };

  const addItemVoiceNote = (idx, uri, durationSeconds) => {
    setItems((prev) => prev.map((it, i) => (i === idx
      ? { ...it, pendingAttachments: [...(it.pendingAttachments || []), { uri, type: 'voice_note', durationSeconds }] }
      : it)));
    setItemVoiceModalIdx(null);
  };

  const clearItemAttachments = (idx) => setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, pendingAttachments: [] } : it)));

  const computeItemsTotal = () => items.reduce(
    (sum, it) => sum + (Number(it.unit_price) || 0) * (Number(it.quantity) || 0),
    0
  );

  const selectPaymentMode = (mode) => {
    setPaymentMode(mode);
    if (mode === 'paid_full') {
      setPaymentAmount(computeItemsTotal().toFixed(2));
    } else if (mode === 'unpaid') {
      setPaymentAmount('');
    }
    // 'partial' — leave whatever the staff member already typed alone.
  };

  // ── Scheduled date/time — same pattern as QuickCheckoutScreen's handleDateConfirm/handleTimeConfirm ──
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

  // Matches QuickCheckoutScreen's checkRegisterStatus exactly.
  const checkRegisterStatus = async (locId) => {
    if (!locId) return false;
    try {
      const res = await api.getRegisterStatus(locId);
      return res.isOpen === true;
    } catch { return false; }
  };

  const canSave = !saving && (items.length > 0 || note.trim().length > 0);

  const handleSave = async () => {
    if (!canSave) return;

    // A payment is being recorded — validate the amount, and if it's cash, the physical
    // register must be open before we let this write happen (only cash writes affect
    // expected_cash; card/UPI never need this check).
    if (paymentMode !== 'unpaid') {
      const amt = parseFloat(paymentAmount);
      if (!amt || amt <= 0) {
        showAlert('Enter payment amount', 'Please enter how much was paid, or switch back to "Not paid yet".');
        return;
      }
      if (paymentMethod === 'cash') {
        const isOpen = await checkRegisterStatus(activeLocation?.id);
        if (!isOpen) {
          const title = 'Register Closed';
          const msg = 'The cash register for this location is not open. Please open it before recording a cash payment.';
          if (Platform.OS === 'web') {
            if (window.confirm(`${title}\n\n${msg}\n\nOK = Open Register, Cancel = go back.`)) {
              navigation.navigate('CashRegister');
            }
          } else {
            Alert.alert(title, msg, [
              { text: 'Open Register', onPress: () => navigation.navigate('CashRegister') },
              { text: 'Cancel', style: 'cancel' },
            ]);
          }
          return;
        }
      }
    }

    setSaving(true);

    // Step 1: create the sale. If this fails, nothing was created server-side —
    // it's safe to show a hard failure and let the staff member retry.
    let saleId;
    let savedItems = [];
    try {
      const payload = {
        location_id: activeLocation?.id,
        order_type: fulfilment,
        channel,
        priority,
        customer_id: customerId,
        customer_name: customerName || undefined,
        customer_phone: customerPhone || undefined,
        // Strip the local-only pendingAttachments field — the server doesn't need it
        // (per-item photos/voice notes upload separately, after creation, once each
        // item has a real sale_item_id — see Step 2 below).
        items: (items.length > 0 ? items : [{ product_id: null, product_name: 'See notes', quantity: 1, unit_price: 0 }])
          .map(({ pendingAttachments, ...rest }) => rest),
        notes: note || undefined,
        receiver_name: fulfilment === 'delivery' ? receiverName : undefined,
        receiver_phone: fulfilment === 'delivery' ? receiverPhone : undefined,
        delivery_address: fulfilment === 'delivery' ? deliveryAddress : undefined,
        scheduled_date: scheduledDate || undefined,
        scheduled_time: scheduledTime || undefined,
        ...(paymentMode !== 'unpaid' ? { payments: [{ method: paymentMethod, amount: parseFloat(paymentAmount) || 0 }] } : {}),
        ...(skipAssignment ? { skip_assignment: true } : {}),
        ...(user?.role === 'owner' || user?.role === 'manager' ? { vendor_name: vendorName || null } : {}),
      };
      const res = await api.createSale(payload);
      saleId = res.data?.id;
      savedItems = res.data?.items || [];
    } catch (err) {
      setSaving(false);
      showAlert('Could not save order', err.message || 'Please try again.');
      return;
    }

    // Step 2: the order now exists — from here on, any failure is an attachment
    // problem, not a save problem. Never tell the staff member the save failed
    // (that would invite a duplicate re-submit), and always navigate away so the
    // populated form can't be resubmitted. Each attachment (order-level and
    // per-item) uploads independently so one failing doesn't stop the rest.
    let failedCount = 0;
    for (const att of pendingAttachments) {
      try {
        await api.uploadSaleAttachment(saleId, att.uri, att.type, att.durationSeconds);
      } catch (err) {
        failedCount += 1;
      }
    }
    // savedItems[i] pairs with items[i] by position — the server preserves the
    // request array's order (see the ORDER BY id ASC comment on the create-sale
    // response), so this is the only way to learn each item's real sale_item_id.
    for (let i = 0; i < items.length; i++) {
      const itemAttachments = items[i]?.pendingAttachments || [];
      const savedItemId = savedItems[i]?.id;
      if (itemAttachments.length === 0 || !savedItemId) continue;
      for (const att of itemAttachments) {
        try {
          await api.uploadSaleAttachment(saleId, att.uri, att.type, att.durationSeconds, savedItemId);
        } catch (err) {
          failedCount += 1;
        }
      }
    }
    setSaving(false);

    if (failedCount > 0) {
      const noun = failedCount === 1 ? 'attachment' : 'attachments';
      showAlert(
        'Order logged',
        `The order was saved, but ${failedCount} ${noun} could not be uploaded. You can add ${failedCount === 1 ? 'it' : 'them'} again from the order later.`,
        () => navigation.goBack()
      );
    } else {
      showAlert('Order logged', 'The order has been added to the inbox.', () => navigation.goBack());
    }
  };

  return (
    <>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.sectionLabel}>Where did this order come from?</Text>
        <View style={styles.chipRow}>
          {CHANNELS.map((c) => (
            <TouchableOpacity
              key={c.key}
              style={[styles.chip, channel === c.key && styles.chipSelected]}
              onPress={() => selectChannel(c.key)}
            >
              <Ionicons name={c.icon} size={18} color={channel === c.key ? Colors.white : Colors.text} />
              <Text style={[styles.chipText, channel === c.key && styles.chipTextSelected]}>{c.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.sectionLabel}>Customer (optional for now)</Text>
        <TextInput
          style={styles.input}
          placeholder="Phone number"
          keyboardType="phone-pad"
          value={customerPhone}
          onChangeText={handlePhoneChange}
        />
        {showCustomerSuggestions && customerSearchTarget === 'phone' && customerSuggestions.length > 0 && (
          <ScrollView style={styles.suggestionsBox} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {customerSuggestions.map((c, idx) => (
              <TouchableOpacity key={(c.phone || idx) + '-' + idx} style={styles.suggestionItem} onPress={() => selectCustomer(c)}>
                <Ionicons name={c.id ? 'person' : 'person-outline'} size={16} color={Colors.primary} />
                <View style={{ flex: 1, marginLeft: 8 }}>
                  <Text style={styles.suggestionName}>{c.name || 'Unknown'}</Text>
                  <Text style={styles.suggestionSub}>{c.phone}{c.total_spent > 0 ? ` • ₹${Math.round(c.total_spent)}` : ''}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
        <TextInput style={styles.input} placeholder="Name" value={customerName} onChangeText={handleNameChange} />
        {showCustomerSuggestions && customerSearchTarget === 'name' && customerSuggestions.length > 0 && (
          <ScrollView style={styles.suggestionsBox} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {customerSuggestions.map((c, idx) => (
              <TouchableOpacity key={(c.phone || idx) + '-' + idx} style={styles.suggestionItem} onPress={() => selectCustomer(c)}>
                <Ionicons name={c.id ? 'person' : 'person-outline'} size={16} color={Colors.primary} />
                <View style={{ flex: 1, marginLeft: 8 }}>
                  <Text style={styles.suggestionName}>{c.name || 'Unknown'}</Text>
                  <Text style={styles.suggestionSub}>{c.phone}{c.total_spent > 0 ? ` • ₹${Math.round(c.total_spent)}` : ''}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        <Text style={styles.sectionLabel}>What are they ordering?</Text>
        {items.map((it, idx) => {
          const itemAttCount = (it.pendingAttachments || []).length;
          return (
            <View key={idx} style={styles.itemRow}>
              <Text style={styles.itemText}>{it.product_name} × {it.quantity} — ₹{it.unit_price}</Text>
              <TouchableOpacity onPress={() => pickItemPhoto(idx)} style={styles.itemIconBtn}>
                <Ionicons name="camera-outline" size={18} color={Colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setItemVoiceModalIdx(idx)} style={styles.itemIconBtn}>
                <Ionicons name="mic-outline" size={18} color={Colors.textSecondary} />
              </TouchableOpacity>
              {itemAttCount > 0 && (
                <TouchableOpacity onPress={() => clearItemAttachments(idx)} style={styles.itemAttachmentBadge}>
                  <Text style={styles.itemAttachmentBadgeText}>{itemAttCount}</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => removeItem(idx)}>
                <Ionicons name="close-circle" size={20} color={Colors.textLight} />
              </TouchableOpacity>
            </View>
          );
        })}

        {/* Per-item voice note — one small modal reused for whichever item's mic icon was tapped. */}
        <Modal visible={itemVoiceModalIdx !== null} transparent animationType="slide" onRequestClose={() => setItemVoiceModalIdx(null)}>
          <View style={styles.modalOverlay} onTouchStart={bumpActivity}>
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>
                  Voice note for {itemVoiceModalIdx !== null ? items[itemVoiceModalIdx]?.product_name : ''}
                </Text>
                <TouchableOpacity onPress={() => setItemVoiceModalIdx(null)}>
                  <Ionicons name="close" size={24} color={Colors.text} />
                </TouchableOpacity>
              </View>
              {itemVoiceModalIdx !== null && (
                <VoiceNoteRecorder
                  onRecorded={(uri, durationSeconds) => addItemVoiceNote(itemVoiceModalIdx, uri, durationSeconds)}
                />
              )}
            </View>
          </View>
        </Modal>
        <TextInput
          style={styles.input}
          placeholder="Search products…"
          value={productSearch}
          onChangeText={handleProductSearchChange}
        />
        {showProductSuggestions && productSuggestions.length > 0 && (
          <ScrollView style={styles.suggestionsBox} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {productSuggestions.map((p) => (
              <TouchableOpacity key={p.id} style={styles.suggestionItem} onPress={() => selectProduct(p)}>
                <Ionicons name="pricetag-outline" size={16} color={Colors.primary} />
                <View style={{ flex: 1, marginLeft: 8 }}>
                  <Text style={styles.suggestionName}>{p.name}</Text>
                  <Text style={styles.suggestionSub}>₹{p.selling_price}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
        <Text style={styles.sectionHint}>Or add a one-off item not in the catalog:</Text>
        <View style={styles.customItemRow}>
          <TextInput style={[styles.input, styles.customItemInput]} placeholder="Item / description" value={customItemName} onChangeText={setCustomItemName} />
          <TextInput style={[styles.input, styles.priceInput]} placeholder="₹" keyboardType="numeric" value={customItemPrice} onChangeText={setCustomItemPrice} />
          <TouchableOpacity style={styles.addButton} onPress={addCustomItem}>
            <Ionicons name="add" size={22} color={Colors.white} />
          </TouchableOpacity>
        </View>
        <TextInput
          style={[styles.input, styles.noteInput]}
          placeholder="Or just jot a note if details are still being worked out…"
          value={note}
          onChangeText={setNote}
          multiline
        />

        {(user?.role === 'owner' || user?.role === 'manager') && (
          <View style={styles.field}>
            <Text style={styles.label}>Vendor (optional)</Text>
            <TextInput
              style={styles.input}
              value={vendorName}
              onChangeText={setVendorName}
              placeholder="Who referred this order?"
              placeholderTextColor={Colors.textLight}
            />
          </View>
        )}

        <Text style={styles.sectionLabel}>Payment</Text>
        <View style={styles.chipRow}>
          <TouchableOpacity style={[styles.chip, paymentMode === 'unpaid' && styles.chipSelected]} onPress={() => selectPaymentMode('unpaid')}>
            <Text style={[styles.chipText, paymentMode === 'unpaid' && styles.chipTextSelected]}>Not paid yet</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.chip, paymentMode === 'paid_full' && styles.chipSelected]} onPress={() => selectPaymentMode('paid_full')}>
            <Text style={[styles.chipText, paymentMode === 'paid_full' && styles.chipTextSelected]}>Paid in full</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.chip, paymentMode === 'partial' && styles.chipSelected]} onPress={() => selectPaymentMode('partial')}>
            <Text style={[styles.chipText, paymentMode === 'partial' && styles.chipTextSelected]}>Partial payment</Text>
          </TouchableOpacity>
        </View>
        {paymentMode !== 'unpaid' && (
          <View>
            <View style={styles.chipRow}>
              {PAYMENT_METHODS.map((m) => (
                <TouchableOpacity
                  key={m.key}
                  style={[styles.chip, paymentMethod === m.key && styles.chipSelected]}
                  onPress={() => setPaymentMethod(m.key)}
                >
                  <Ionicons name={m.icon} size={18} color={paymentMethod === m.key ? Colors.white : Colors.text} />
                  <Text style={[styles.chipText, paymentMethod === m.key && styles.chipTextSelected]}>{m.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {paymentMode === 'paid_full' && (
              <Text style={styles.paymentNote}>Prefilled from item totals — edit if it's not quite right.</Text>
            )}
            <TextInput
              style={styles.input}
              placeholder="Amount paid (₹)"
              keyboardType="numeric"
              value={paymentAmount}
              onChangeText={setPaymentAmount}
            />
          </View>
        )}

        <Text style={styles.sectionLabel}>Pickup or delivery?</Text>
        <View style={styles.chipRow}>
          <TouchableOpacity style={[styles.chip, fulfilment === 'pickup' && styles.chipSelected]} onPress={() => setFulfilment('pickup')}>
            <Text style={[styles.chipText, fulfilment === 'pickup' && styles.chipTextSelected]}>Pickup</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.chip, fulfilment === 'delivery' && styles.chipSelected]} onPress={() => setFulfilment('delivery')}>
            <Text style={[styles.chipText, fulfilment === 'delivery' && styles.chipTextSelected]}>Delivery</Text>
          </TouchableOpacity>
        </View>

        {fulfilment === 'delivery' && (
          <View>
            <Text style={styles.sectionLabel}>Recipient (if different from customer)</Text>
            <TextInput style={styles.input} placeholder="Recipient name" value={receiverName} onChangeText={setReceiverName} />
            <TextInput style={styles.input} placeholder="Recipient phone" keyboardType="phone-pad" value={receiverPhone} onChangeText={setReceiverPhone} />
            <TextInput style={styles.input} placeholder="Delivery address" value={deliveryAddress} onChangeText={setDeliveryAddress} multiline />
          </View>
        )}

        <Text style={styles.sectionLabel}>When is this needed? (optional)</Text>
        <View style={styles.dateTimeRow}>
          <TouchableOpacity style={styles.dateTimeButton} onPress={() => setShowDatePicker(true)}>
            <Ionicons name="calendar-outline" size={18} color={scheduledDate ? Colors.primary : Colors.textLight} />
            <Text style={[styles.dateTimeButtonText, !scheduledDate && { color: Colors.textLight }]}>
              {scheduledDate || 'Select Date'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.dateTimeButton} onPress={() => setShowTimePicker(true)}>
            <Ionicons name="time-outline" size={18} color={scheduledTime ? Colors.primary : Colors.textLight} />
            <Text style={[styles.dateTimeButtonText, !scheduledTime && { color: Colors.textLight }]}>
              {scheduledTime || 'Select Time'}
            </Text>
          </TouchableOpacity>
        </View>
        {(scheduledDate || scheduledTime) && (
          <TouchableOpacity onPress={() => { setScheduledDate(''); setScheduledTime(''); }}>
            <Text style={styles.clearLink}>Clear date/time</Text>
          </TouchableOpacity>
        )}

        <Text style={styles.sectionLabel}>Rush order?</Text>
        <View style={styles.chipRow}>
          <TouchableOpacity style={[styles.chip, priority === 'normal' && styles.chipSelected]} onPress={() => setPriority('normal')}>
            <Text style={[styles.chipText, priority === 'normal' && styles.chipTextSelected]}>Normal</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.chip, priority === 'rush' && styles.chipSelected]} onPress={() => setPriority('rush')}>
            <Text style={[styles.chipText, priority === 'rush' && styles.chipTextSelected]}>Rush</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionLabel}>Will you prepare/complete this order yourself right now?</Text>
        <View style={styles.chipRow}>
          <TouchableOpacity style={[styles.chip, !skipAssignment && styles.chipSelected]} onPress={() => setSkipAssignment(false)}>
            <Text style={[styles.chipText, !skipAssignment && styles.chipTextSelected]}>No</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.chip, skipAssignment && styles.chipSelected]} onPress={() => setSkipAssignment(true)}>
            <Text style={[styles.chipText, skipAssignment && styles.chipTextSelected]}>Yes</Text>
          </TouchableOpacity>
        </View>
        {skipAssignment && (
          <Text style={styles.paymentNote}>This order will skip the florist queue and be marked ready immediately.</Text>
        )}

        <Text style={styles.sectionLabel}>Reference photo or voice note (optional)</Text>
        <TouchableOpacity style={styles.photoButton} onPress={pickReferencePhoto}>
          <Ionicons name="camera" size={20} color={Colors.text} />
          <Text style={styles.photoButtonText}>Add reference photo</Text>
        </TouchableOpacity>
        <VoiceNoteRecorder
          onRecorded={(uri, durationSeconds) => setPendingAttachments((prev) => [...prev, { uri, type: 'voice_note', durationSeconds }])}
        />
        {pendingAttachments.map((a, i) => (
          <Text key={i} style={styles.attachmentNote}>
            {a.type === 'photo' ? '📷 Photo attached' : `🎤 Voice note recorded (${a.durationSeconds}s)`} — will attach on save
          </Text>
        ))}

        <TouchableOpacity
          style={[styles.saveButton, !canSave && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={!canSave}
        >
          {saving ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.saveButtonText}>Save Order</Text>}
        </TouchableOpacity>
      </ScrollView>

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
        value={datePickerDate}
        onConfirm={handleTimeConfirm}
        onCancel={() => setShowTimePicker(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: 60 },
  sectionLabel: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary, marginTop: Spacing.lg, marginBottom: Spacing.sm, textTransform: 'uppercase' },
  sectionHint: { fontSize: FontSize.xs, color: Colors.textLight, marginBottom: Spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 14, borderRadius: BorderRadius.lg, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, minHeight: 44 },
  chipSelected: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.md, color: Colors.text, fontWeight: '600' },
  chipTextSelected: { color: Colors.white },
  input: { backgroundColor: Colors.surface, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, padding: 12, fontSize: FontSize.md, marginBottom: Spacing.sm },
  noteInput: { minHeight: 60, textAlignVertical: 'top' },
  itemRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, gap: 4 },
  itemText: { fontSize: FontSize.md, color: Colors.text, flex: 1 },
  itemIconBtn: { padding: 4 },
  itemAttachmentBadge: { backgroundColor: Colors.primary + '20', borderRadius: 10, minWidth: 20, height: 20, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4 },
  itemAttachmentBadgeText: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.primary },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: Spacing.lg, paddingBottom: Spacing.xl },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.md },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, flex: 1, marginRight: Spacing.sm },
  customItemRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  customItemInput: { flex: 2 },
  priceInput: { flex: 1 },
  addButton: { backgroundColor: Colors.primary, borderRadius: BorderRadius.md, width: 44, height: 44, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.sm },
  photoButton: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.lg, paddingVertical: 12, paddingHorizontal: Spacing.md, marginBottom: Spacing.sm },
  photoButtonText: { fontSize: FontSize.md, color: Colors.text, fontWeight: '600' },
  attachmentNote: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  saveButton: { backgroundColor: Colors.primary, borderRadius: BorderRadius.lg, paddingVertical: 16, alignItems: 'center', marginTop: Spacing.xl },
  saveButtonDisabled: { backgroundColor: Colors.border },
  saveButtonText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '700' },

  // Customer / product search dropdowns — rendered inline (not absolutely positioned)
  // since this screen is a single-column ScrollView, unlike QuickCheckoutScreen's
  // two-column layout.
  suggestionsBox: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
    marginTop: -4, marginBottom: Spacing.sm, maxHeight: 180,
  },
  suggestionItem: { flexDirection: 'row', alignItems: 'center', padding: 12, borderBottomWidth: 1, borderBottomColor: Colors.border },
  suggestionName: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },
  suggestionSub: { fontSize: FontSize.xs, color: Colors.textSecondary },

  paymentNote: { fontSize: FontSize.xs, color: Colors.textLight, marginBottom: Spacing.sm },

  dateTimeRow: { flexDirection: 'row', gap: 8 },
  dateTimeButton: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.surface, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, padding: 12, marginBottom: Spacing.sm },
  dateTimeButtonText: { fontSize: FontSize.md, color: Colors.text },
  clearLink: { fontSize: FontSize.sm, color: Colors.error, marginTop: -4, marginBottom: Spacing.sm },

  field: { marginBottom: Spacing.md },
  label: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary, marginBottom: 4 },
});
