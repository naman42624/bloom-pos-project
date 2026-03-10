import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, Alert, Platform, ActivityIndicator,
  FlatList, KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const FREQ_OPTIONS = [
  { key: 'daily', label: 'Daily', icon: 'today' },
  { key: 'weekly', label: 'Weekly', icon: 'calendar' },
  { key: 'monthly', label: 'Monthly', icon: 'calendar-outline' },
  { key: 'custom', label: 'Custom Dates', icon: 'options' },
];

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function AddRecurringOrderScreen({ route, navigation }) {
  const { user } = useAuth();
  const editId = route?.params?.orderId;

  const [loading, setLoading] = useState(!!editId);
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerId, setCustomerId] = useState(null);
  const [locationId, setLocationId] = useState(null);
  const [orderType, setOrderType] = useState('delivery');
  const [frequency, setFrequency] = useState('daily');
  const [selectedDays, setSelectedDays] = useState([]); // day-of-week for weekly custom
  const [customDates, setCustomDates] = useState([]); // specific dates
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [notes, setNotes] = useState('');
  const [senderMessage, setSenderMessage] = useState('');
  const [senderName, setSenderName] = useState('');
  const [senderPhone, setSenderPhone] = useState('');
  const [startDate, setStartDate] = useState('');

  // Items
  const [products, setProducts] = useState([]);
  const [items, setItems] = useState([]);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [datePickerDate, setDatePickerDate] = useState(new Date());
  const [datePickerMode, setDatePickerMode] = useState('start'); // 'start' or 'custom'

  // Locations
  const [locations, setLocations] = useState([]);

  // Customer search
  const [customerSuggestions, setCustomerSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Saved addresses
  const [savedAddresses, setSavedAddresses] = useState([]);

  useEffect(() => {
    loadLocations();
    loadProducts();
    if (editId) loadExisting();
  }, []);

  const loadLocations = async () => {
    try {
      const res = await api.getLocations();
      const locs = (res.data?.locations || res.data || []).filter(l => l.is_active);
      setLocations(Array.isArray(locs) ? locs : []);
      if (locs.length === 1 && !locationId) setLocationId(locs[0].id);
    } catch {}
  };

  const loadProducts = async () => {
    try {
      const res = await api.getProducts({ is_active: 1 });
      setProducts(res.data || []);
    } catch {}
  };

  const loadExisting = async () => {
    try {
      const res = await api.getRecurringOrder(editId);
      const o = res.data;
      setCustomerId(o.customer_id);
      setCustomerName(o.customer_name || '');
      setCustomerPhone(o.customer_phone || '');
      // Fetch saved addresses for existing customer
      if (o.customer_id) {
        api.getCustomerAddresses(o.customer_id).then(res => {
          setSavedAddresses(res.data || []);
        }).catch(() => {});
      }
      setLocationId(o.location_id);
      setOrderType(o.order_type);
      setFrequency(o.frequency);
      setDeliveryAddress(o.delivery_address || '');
      setScheduledTime(o.scheduled_time || '');
      setNotes(o.notes || '');
      setSenderMessage(o.sender_message || '');
      setSenderName(o.sender_name || '');
      setSenderPhone(o.sender_phone || '');
      setStartDate(o.next_run_date || '');
      setItems(o.items || []);
      if (o.custom_days) {
        if (typeof o.custom_days[0] === 'number') {
          setSelectedDays(o.custom_days);
        } else {
          setCustomDates(o.custom_days);
        }
      }
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePhoneSearch = useCallback((text) => {
    setCustomerPhone(text);
    if (text.length >= 3) {
      const timer = setTimeout(async () => {
        try {
          const res = await api.customerSearch(text);
          if (res.data?.length > 0) {
            setCustomerSuggestions(res.data);
            setShowSuggestions(true);
          } else {
            setShowSuggestions(false);
          }
        } catch {}
      }, 300);
      return () => clearTimeout(timer);
    } else {
      setShowSuggestions(false);
    }
  }, []);

  const selectCustomer = (c) => {
    setCustomerPhone(c.phone || '');
    setCustomerName(c.name || '');
    if (c.id) {
      setCustomerId(c.id);
      // Fetch saved addresses for the selected customer
      api.getCustomerAddresses(c.id).then(res => {
        setSavedAddresses(res.data || []);
      }).catch(() => {});
    }
    setShowSuggestions(false);
  };

  const addItem = (product) => {
    const existing = items.find(i => i.product_id === product.id);
    if (existing) {
      setItems(items.map(i => i.product_id === product.id ? { ...i, quantity: i.quantity + 1 } : i));
    } else {
      setItems([...items, {
        product_id: product.id,
        product_name: product.name,
        unit_price: product.selling_price || 0,
        quantity: 1,
        tax_rate: 0,
      }]);
    }
  };

  const updateItemQty = (idx, qty) => {
    if (qty <= 0) {
      setItems(items.filter((_, i) => i !== idx));
    } else {
      setItems(items.map((item, i) => i === idx ? { ...item, quantity: qty } : item));
    }
  };

  const toggleDay = (day) => {
    setSelectedDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]);
  };

  const handleSubmit = async () => {
    if (!customerId) return Alert.alert('Required', 'Please select a customer');
    if (!locationId) return Alert.alert('Required', 'Please select a location');
    if (items.length === 0) return Alert.alert('Required', 'Please add at least one item');
    if (!startDate) return Alert.alert('Required', 'Please select a start date');
    if (orderType === 'delivery' && !deliveryAddress) return Alert.alert('Required', 'Please enter delivery address');

    let custom_days = null;
    if (frequency === 'custom') {
      custom_days = customDates.length > 0 ? customDates : (selectedDays.length > 0 ? selectedDays : null);
      if (!custom_days || custom_days.length === 0) {
        return Alert.alert('Required', 'Please select custom days or dates');
      }
    }

    const data = {
      customer_id: customerId,
      location_id: locationId,
      order_type: orderType,
      frequency,
      custom_days,
      delivery_address: orderType === 'delivery' ? deliveryAddress : null,
      scheduled_time: scheduledTime || null,
      notes,
      sender_message: senderMessage,
      sender_name: senderName,
      sender_phone: senderPhone,
      items,
      next_run_date: startDate,
    };

    setSubmitting(true);
    try {
      if (editId) {
        await api.updateRecurringOrder(editId, data);
        Alert.alert('Updated', 'Recurring order updated');
      } else {
        await api.createRecurringOrder(data);
        Alert.alert('Created', 'Recurring order created');
      }
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <ActivityIndicator size="large" color={Colors.primary} style={{ flex: 1, justifyContent: 'center' }} />;

  const totalAmount = items.reduce((s, i) => s + ((i.unit_price || 0) * (i.quantity || 1)), 0);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.pageTitle}>{editId ? 'Edit' : 'New'} Recurring Order</Text>

        {/* Customer */}
        <Text style={styles.sectionTitle}>Customer *</Text>
        <View style={styles.row}>
          <TextInput style={[styles.input, { flex: 1 }]} value={customerPhone} onChangeText={handlePhoneSearch}
            placeholder="Phone" placeholderTextColor={Colors.textLight} keyboardType="phone-pad" />
          <TextInput style={[styles.input, { flex: 1 }]} value={customerName} onChangeText={setCustomerName}
            placeholder="Name" placeholderTextColor={Colors.textLight} />
        </View>
        {showSuggestions && customerSuggestions.length > 0 && (
          <View style={styles.suggestionsBox}>
            {customerSuggestions.map((c, idx) => (
              <TouchableOpacity key={c.phone + idx} style={styles.suggestionItem} onPress={() => selectCustomer(c)}>
                <Ionicons name={c.id ? 'person' : 'person-outline'} size={14} color={Colors.primary} />
                <Text style={styles.suggestionText}>{c.name || 'Unknown'} • {c.phone}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        {customerId && <Text style={styles.selectedHint}>✓ Customer selected (ID: {customerId})</Text>}

        {/* Location */}
        <Text style={styles.sectionTitle}>Location *</Text>
        <View style={styles.chipRow}>
          {locations.map(loc => (
            <TouchableOpacity
              key={loc.id}
              style={[styles.chip, locationId === loc.id && styles.chipActive]}
              onPress={() => setLocationId(loc.id)}
            >
              <Ionicons name="storefront" size={14} color={locationId === loc.id ? Colors.white : Colors.textSecondary} />
              <Text style={[styles.chipText, locationId === loc.id && styles.chipTextActive]}>{loc.name}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Order Type */}
        <Text style={styles.sectionTitle}>Order Type</Text>
        <View style={styles.chipRow}>
          <TouchableOpacity style={[styles.chip, orderType === 'delivery' && styles.chipActive]} onPress={() => setOrderType('delivery')}>
            <Ionicons name="bicycle" size={16} color={orderType === 'delivery' ? Colors.white : Colors.textSecondary} />
            <Text style={[styles.chipText, orderType === 'delivery' && styles.chipTextActive]}>Delivery</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.chip, orderType === 'pickup' && styles.chipActive]} onPress={() => setOrderType('pickup')}>
            <Ionicons name="bag-handle" size={16} color={orderType === 'pickup' ? Colors.white : Colors.textSecondary} />
            <Text style={[styles.chipText, orderType === 'pickup' && styles.chipTextActive]}>Pickup</Text>
          </TouchableOpacity>
        </View>

        {/* Delivery Address */}
        {orderType === 'delivery' && (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.sectionTitle}>Delivery Address *</Text>
              {savedAddresses.length > 0 && (
                <Text style={{ fontSize: FontSize.xs, color: Colors.textLight }}>{savedAddresses.length} saved</Text>
              )}
            </View>
            {savedAddresses.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                {savedAddresses.map(addr => (
                  <TouchableOpacity
                    key={addr.id}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.full, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8 }}
                    onPress={() => {
                      const parts = [addr.address_line_1, addr.address_line_2, addr.city, addr.state, addr.pincode].filter(Boolean);
                      setDeliveryAddress(parts.join(', '));
                    }}
                  >
                    <Ionicons name="location" size={14} color={Colors.primary} />
                    <Text style={{ fontSize: FontSize.xs, color: Colors.text }} numberOfLines={1}>{addr.label || addr.address_line_1}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
            <TextInput style={styles.input} value={deliveryAddress} onChangeText={setDeliveryAddress}
              placeholder="Full address" placeholderTextColor={Colors.textLight} multiline />
          </>
        )}

        {/* Frequency */}
        <Text style={styles.sectionTitle}>Frequency *</Text>
        <View style={styles.chipRow}>
          {FREQ_OPTIONS.map(f => (
            <TouchableOpacity
              key={f.key}
              style={[styles.chip, frequency === f.key && styles.chipActive]}
              onPress={() => setFrequency(f.key)}
            >
              <Ionicons name={f.icon} size={14} color={frequency === f.key ? Colors.white : Colors.textSecondary} />
              <Text style={[styles.chipText, frequency === f.key && styles.chipTextActive]}>{f.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Custom days of week */}
        {frequency === 'custom' && (
          <>
            <Text style={styles.sectionTitle}>Days of Week</Text>
            <View style={styles.chipRow}>
              {DAYS_OF_WEEK.map((day, idx) => (
                <TouchableOpacity
                  key={day}
                  style={[styles.dayChip, selectedDays.includes(idx) && styles.dayChipActive]}
                  onPress={() => toggleDay(idx)}
                >
                  <Text style={[styles.dayChipText, selectedDays.includes(idx) && styles.dayChipTextActive]}>{day}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}

        {/* Start Date */}
        <Text style={styles.sectionTitle}>Start Date *</Text>
        <TouchableOpacity
          style={styles.pickerBtn}
          onPress={() => { setDatePickerMode('start'); setShowDatePicker(true); }}
        >
          <Ionicons name="calendar-outline" size={18} color={startDate ? Colors.primary : Colors.textLight} />
          <Text style={[styles.pickerBtnText, startDate && { color: Colors.text }]}>
            {startDate || 'Select start date'}
          </Text>
        </TouchableOpacity>

        {/* Time */}
        <Text style={styles.sectionTitle}>Scheduled Time (optional)</Text>
        <TouchableOpacity
          style={styles.pickerBtn}
          onPress={() => setShowTimePicker(true)}
        >
          <Ionicons name="time-outline" size={18} color={scheduledTime ? Colors.primary : Colors.textLight} />
          <Text style={[styles.pickerBtnText, scheduledTime && { color: Colors.text }]}>
            {scheduledTime || 'Select time'}
          </Text>
        </TouchableOpacity>

        {showDatePicker && (
          <DateTimePicker
            value={datePickerDate}
            mode="date"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            minimumDate={new Date()}
            onChange={(event, selected) => {
              setShowDatePicker(Platform.OS === 'ios');
              if (selected) {
                setDatePickerDate(selected);
                const y = selected.getFullYear();
                const m = String(selected.getMonth() + 1).padStart(2, '0');
                const d = String(selected.getDate()).padStart(2, '0');
                const dateStr = `${y}-${m}-${d}`;
                if (datePickerMode === 'start') {
                  setStartDate(dateStr);
                } else {
                  if (!customDates.includes(dateStr)) setCustomDates([...customDates, dateStr].sort());
                }
              }
            }}
          />
        )}
        {showTimePicker && (
          <DateTimePicker
            value={datePickerDate}
            mode="time"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            minuteInterval={15}
            onChange={(event, selected) => {
              setShowTimePicker(Platform.OS === 'ios');
              if (selected) {
                const h = String(selected.getHours()).padStart(2, '0');
                const min = String(selected.getMinutes()).padStart(2, '0');
                setScheduledTime(`${h}:${min}`);
              }
            }}
          />
        )}

        {/* Sender Info */}
        <Text style={styles.sectionTitle}>Sender Info (optional)</Text>
        <TextInput style={styles.input} value={senderName} onChangeText={setSenderName}
          placeholder="Sender name" placeholderTextColor={Colors.textLight} />
        <TextInput style={[styles.input, { marginTop: Spacing.xs }]} value={senderPhone} onChangeText={setSenderPhone}
          placeholder="Sender phone" placeholderTextColor={Colors.textLight} keyboardType="phone-pad" />
        <TextInput style={[styles.input, { marginTop: Spacing.xs, minHeight: 50 }]} value={senderMessage} onChangeText={setSenderMessage}
          placeholder="Message from sender..." placeholderTextColor={Colors.textLight} multiline />

        {/* Notes */}
        <Text style={styles.sectionTitle}>Notes</Text>
        <TextInput style={[styles.input, { minHeight: 50 }]} value={notes} onChangeText={setNotes}
          placeholder="Special instructions..." placeholderTextColor={Colors.textLight} multiline />

        {/* Items */}
        <Text style={styles.sectionTitle}>Items *</Text>
        {items.length > 0 && (
          <View style={styles.itemsBox}>
            {items.map((item, idx) => (
              <View key={idx} style={styles.itemRow}>
                <Text style={styles.itemName} numberOfLines={1}>{item.product_name}</Text>
                <View style={styles.qtyControls}>
                  <TouchableOpacity onPress={() => updateItemQty(idx, item.quantity - 1)} style={styles.qtyBtn}>
                    <Ionicons name="remove" size={16} color={Colors.error} />
                  </TouchableOpacity>
                  <Text style={styles.qtyText}>{item.quantity}</Text>
                  <TouchableOpacity onPress={() => updateItemQty(idx, item.quantity + 1)} style={styles.qtyBtn}>
                    <Ionicons name="add" size={16} color={Colors.success} />
                  </TouchableOpacity>
                </View>
                <Text style={styles.itemPrice}>₹{(item.unit_price * item.quantity).toFixed(0)}</Text>
              </View>
            ))}
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total per order</Text>
              <Text style={styles.totalValue}>₹{totalAmount.toFixed(0)}</Text>
            </View>
          </View>
        )}

        {/* Product picker */}
        <Text style={styles.subLabel}>Add products:</Text>
        <View style={styles.productGrid}>
          {products.slice(0, 20).map(p => (
            <TouchableOpacity key={p.id} style={styles.productChip} onPress={() => addItem(p)}>
              <Text style={styles.productChipText} numberOfLines={1}>{p.name}</Text>
              <Text style={styles.productChipPrice}>₹{p.selling_price || 0}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Submit */}
        <TouchableOpacity style={styles.submitBtn} onPress={handleSubmit} disabled={submitting}>
          {submitting ? (
            <ActivityIndicator color={Colors.white} />
          ) : (
            <>
              <Ionicons name="checkmark-circle" size={20} color={Colors.white} />
              <Text style={styles.submitBtnText}>{editId ? 'Update' : 'Create'} Recurring Order</Text>
            </>
          )}
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md },
  pageTitle: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginBottom: Spacing.md },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  subLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.md, marginBottom: Spacing.sm },
  row: { flexDirection: 'row', gap: Spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full, backgroundColor: Colors.surface,
    borderWidth: 1.5, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.white, fontWeight: '700' },
  dayChip: {
    width: 42, height: 42, borderRadius: 21, justifyContent: 'center', alignItems: 'center',
    backgroundColor: Colors.surface, borderWidth: 1.5, borderColor: Colors.border,
  },
  dayChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  dayChipText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary },
  dayChipTextActive: { color: Colors.white },
  input: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md, fontSize: FontSize.md, color: Colors.text, marginTop: Spacing.xs,
  },
  pickerBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md, marginTop: Spacing.xs,
  },
  pickerBtnText: { fontSize: FontSize.md, color: Colors.textLight },
  suggestionsBox: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.primary + '40', marginTop: 2,
  },
  suggestionItem: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  suggestionText: { fontSize: FontSize.sm, color: Colors.text },
  selectedHint: { fontSize: FontSize.sm, color: Colors.success, marginTop: 4, fontWeight: '500' },
  itemsBox: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.md,
  },
  itemRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 6,
  },
  itemName: { flex: 1, fontSize: FontSize.sm, color: Colors.text, fontWeight: '500' },
  qtyControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  qtyBtn: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: Colors.background,
    justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: Colors.border,
  },
  qtyText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, minWidth: 20, textAlign: 'center' },
  itemPrice: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.primary, marginLeft: 8, minWidth: 50, textAlign: 'right' },
  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    borderTopWidth: 1, borderTopColor: Colors.border, marginTop: Spacing.sm, paddingTop: Spacing.sm,
  },
  totalLabel: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  totalValue: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  productGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  productChip: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  productChipText: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '500' },
  productChipPrice: { fontSize: FontSize.xs, color: Colors.textSecondary },
  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    backgroundColor: Colors.primary, borderRadius: BorderRadius.md,
    paddingVertical: Spacing.lg, marginTop: Spacing.xl,
  },
  submitBtnText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '700' },
});
