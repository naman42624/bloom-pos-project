import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, Alert, Platform, ScrollView, Modal,
  ActivityIndicator, KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import DateTimePicker from '@react-native-community/datetimepicker';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function CustomerShopScreen({ navigation }) {
  const { user } = useAuth();
  const [products, setProducts] = useState([]);
  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [cart, setCart] = useState([]);
  const [showCheckout, setShowCheckout] = useState(false);

  // Checkout state
  const [orderType, setOrderType] = useState('delivery');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [notes, setNotes] = useState('');
  const [senderName, setSenderName] = useState('');
  const [senderPhone, setSenderPhone] = useState('');
  const [senderMessage, setSenderMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [savedAddresses, setSavedAddresses] = useState([]);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [datePickerDate, setDatePickerDate] = useState(new Date());

  useFocusEffect(useCallback(() => {
    loadData();
  }, []));

  const loadData = async () => {
    try {
      setLoading(true);
      const [prodRes, locRes] = await Promise.all([
        api.getProducts({ is_active: 1 }),
        api.getLocations(),
      ]);
      setProducts(prodRes.data || []);
      const locs = locRes.data || [];
      setLocations(locs);
      if (locs.length > 0 && !selectedLocation) setSelectedLocation(locs[0].id);

      // Load saved addresses
      try {
        const addrRes = await api.getCustomerAddresses(user.id);
        setSavedAddresses(addrRes.data || []);
      } catch {}
    } catch {} finally {
      setLoading(false);
    }
  };

  const filtered = products.filter(p => {
    if (search) {
      const q = search.toLowerCase();
      return (p.name || '').toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q);
    }
    return true;
  });

  const cartTotal = cart.reduce((s, c) => s + c.unit_price * c.quantity, 0);
  const cartCount = cart.reduce((s, c) => s + c.quantity, 0);

  const addToCart = (product) => {
    const existing = cart.find(c => c.product_id === product.id);
    if (existing) {
      setCart(cart.map(c => c.product_id === product.id ? { ...c, quantity: c.quantity + 1 } : c));
    } else {
      setCart([...cart, {
        product_id: product.id,
        product_name: product.name,
        unit_price: product.selling_price,
        quantity: 1,
      }]);
    }
  };

  const updateQty = (productId, delta) => {
    setCart(prev => prev.map(c => {
      if (c.product_id !== productId) return c;
      const newQty = c.quantity + delta;
      return newQty > 0 ? { ...c, quantity: newQty } : c;
    }).filter(c => c.quantity > 0));
  };

  const removeFromCart = (productId) => {
    setCart(prev => prev.filter(c => c.product_id !== productId));
  };

  const handlePlaceOrder = async () => {
    if (cart.length === 0) return;
    if (!selectedLocation) {
      Alert.alert('Error', 'Please select a shop location');
      return;
    }
    if (orderType === 'delivery' && !deliveryAddress.trim()) {
      Alert.alert('Error', 'Please enter a delivery address');
      return;
    }

    setSubmitting(true);
    try {
      const data = {
        location_id: selectedLocation,
        order_type: orderType,
        items: cart.map(c => ({ product_id: c.product_id, quantity: c.quantity })),
        delivery_address: orderType === 'delivery' ? deliveryAddress : null,
        scheduled_date: scheduledDate || null,
        scheduled_time: scheduledTime || null,
        notes: notes || null,
        sender_name: senderName || null,
        sender_phone: senderPhone || null,
        sender_message: senderMessage || null,
      };
      const res = await api.placeCustomerOrder(data);
      if (res.success) {
        setCart([]);
        setShowCheckout(false);
        setDeliveryAddress('');
        setNotes('');
        setSenderName('');
        setSenderPhone('');
        setSenderMessage('');
        setScheduledDate('');
        setScheduledTime('');
        Alert.alert('Order Placed!', `Order #${res.data.sale_number}\nTotal: ₹${res.data.grand_total.toFixed(0)}\n\nYou can track it in My Orders.`, [
          { text: 'View Orders', onPress: () => navigation.navigate('MyOrders') },
          { text: 'OK' },
        ]);
      }
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to place order');
    } finally {
      setSubmitting(false);
    }
  };

  const renderProduct = ({ item }) => {
    const inCart = cart.find(c => c.product_id === item.id);
    return (
      <View style={styles.productCard}>
        <View style={{ flex: 1 }}>
          <Text style={styles.productName} numberOfLines={1}>{item.name}</Text>
          <Text style={styles.productPrice}>₹{(item.selling_price || 0).toFixed(0)}</Text>
          {item.type && <Text style={styles.productType}>{item.type.replace(/_/g, ' ')}</Text>}
        </View>
        {inCart ? (
          <View style={styles.qtyRow}>
            <TouchableOpacity style={styles.qtyBtn} onPress={() => updateQty(item.id, -1)}>
              <Ionicons name="remove" size={18} color={Colors.primary} />
            </TouchableOpacity>
            <Text style={styles.qtyText}>{inCart.quantity}</Text>
            <TouchableOpacity style={styles.qtyBtn} onPress={() => updateQty(item.id, 1)}>
              <Ionicons name="add" size={18} color={Colors.primary} />
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={styles.addBtn} onPress={() => addToCart(item)}>
            <Ionicons name="add" size={18} color={Colors.white} />
            <Text style={styles.addBtnText}>Add</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;
  }

  return (
    <View style={styles.container}>
      {/* Location picker */}
      {locations.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.locRow} contentContainerStyle={{ paddingHorizontal: Spacing.md, gap: 8 }}>
          {locations.map(loc => (
            <TouchableOpacity
              key={loc.id}
              style={[styles.locChip, selectedLocation === loc.id && styles.locChipActive]}
              onPress={() => setSelectedLocation(loc.id)}
            >
              <Text style={[styles.locChipText, selectedLocation === loc.id && styles.locChipTextActive]}>{loc.name}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Search */}
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={18} color={Colors.textLight} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search products..."
          placeholderTextColor={Colors.textLight}
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={18} color={Colors.textLight} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Product list */}
      <FlatList
        data={filtered}
        keyExtractor={item => String(item.id)}
        renderItem={renderProduct}
        contentContainerStyle={{ padding: Spacing.md, paddingBottom: cart.length > 0 ? 120 : 20 }}
        ListEmptyComponent={
          <View style={styles.center}>
            <Ionicons name="leaf-outline" size={48} color={Colors.textLight} />
            <Text style={styles.emptyText}>No products found</Text>
          </View>
        }
      />

      {/* Cart bar */}
      {cart.length > 0 && (
        <View style={styles.cartBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cartCount}>{cartCount} item{cartCount > 1 ? 's' : ''}</Text>
            <Text style={styles.cartTotal}>₹{cartTotal.toFixed(0)}</Text>
          </View>
          <TouchableOpacity style={styles.cartBtn} onPress={() => setShowCheckout(true)}>
            <Text style={styles.cartBtnText}>Place Order</Text>
            <Ionicons name="arrow-forward" size={18} color={Colors.white} />
          </TouchableOpacity>
        </View>
      )}

      {/* Checkout Modal */}
      <Modal visible={showCheckout} animationType="slide" onRequestClose={() => setShowCheckout(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView style={{ flex: 1, backgroundColor: Colors.background }} contentContainerStyle={{ padding: Spacing.md, paddingBottom: 40 }}>
            {/* Header */}
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={() => setShowCheckout(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Place Order</Text>
              <View style={{ width: 24 }} />
            </View>

            {/* Cart Summary */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Your Cart</Text>
              {cart.map(item => (
                <View key={item.product_id} style={styles.cartItem}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cartItemName}>{item.product_name}</Text>
                    <Text style={styles.cartItemPrice}>₹{item.unit_price} × {item.quantity}</Text>
                  </View>
                  <Text style={styles.cartItemTotal}>₹{(item.unit_price * item.quantity).toFixed(0)}</Text>
                  <TouchableOpacity onPress={() => removeFromCart(item.product_id)} style={{ marginLeft: 8 }}>
                    <Ionicons name="trash-outline" size={18} color={Colors.error} />
                  </TouchableOpacity>
                </View>
              ))}
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Total</Text>
                <Text style={styles.totalValue}>₹{cartTotal.toFixed(0)}</Text>
              </View>
            </View>

            {/* Order Type */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Order Type</Text>
              <View style={styles.chipRow}>
                <TouchableOpacity
                  style={[styles.chip, orderType === 'delivery' && styles.chipActive]}
                  onPress={() => setOrderType('delivery')}
                >
                  <Ionicons name="bicycle" size={16} color={orderType === 'delivery' ? Colors.white : Colors.textSecondary} />
                  <Text style={[styles.chipText, orderType === 'delivery' && styles.chipTextActive]}>Delivery</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.chip, orderType === 'pickup' && styles.chipActive]}
                  onPress={() => setOrderType('pickup')}
                >
                  <Ionicons name="bag-handle" size={16} color={orderType === 'pickup' ? Colors.white : Colors.textSecondary} />
                  <Text style={[styles.chipText, orderType === 'pickup' && styles.chipTextActive]}>Pickup</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Delivery Address */}
            {orderType === 'delivery' && (
              <View style={styles.section}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={styles.sectionTitle}>Delivery Address</Text>
                  {savedAddresses.length > 0 && (
                    <Text style={styles.savedCount}>{savedAddresses.length} saved</Text>
                  )}
                </View>
                {savedAddresses.length > 0 && (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                    {savedAddresses.map(addr => (
                      <TouchableOpacity
                        key={addr.id}
                        style={styles.addrChip}
                        onPress={() => {
                          const parts = [addr.address_line_1, addr.address_line_2, addr.city, addr.state, addr.pincode].filter(Boolean);
                          setDeliveryAddress(parts.join(', '));
                        }}
                      >
                        <Ionicons name="location" size={14} color={Colors.primary} />
                        <Text style={styles.addrChipText} numberOfLines={1}>{addr.label || addr.address_line_1}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                )}
                <TextInput
                  style={styles.input}
                  value={deliveryAddress}
                  onChangeText={setDeliveryAddress}
                  placeholder="Full delivery address"
                  placeholderTextColor={Colors.textLight}
                  multiline
                />
              </View>
            )}

            {/* Scheduled Date/Time */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Preferred Date & Time (optional)</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity style={[styles.pickerBtn, { flex: 1 }]} onPress={() => setShowDatePicker(true)}>
                  <Ionicons name="calendar-outline" size={16} color={scheduledDate ? Colors.primary : Colors.textLight} />
                  <Text style={styles.pickerBtnText}>{scheduledDate || 'Select Date'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.pickerBtn, { flex: 1 }]} onPress={() => setShowTimePicker(true)}>
                  <Ionicons name="time-outline" size={16} color={scheduledTime ? Colors.primary : Colors.textLight} />
                  <Text style={styles.pickerBtnText}>{scheduledTime || 'Select Time'}</Text>
                </TouchableOpacity>
              </View>
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
                      setScheduledDate(`${y}-${m}-${d}`);
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
            </View>

            {/* Sender Info */}
            {orderType === 'delivery' && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Sender Info (optional)</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput style={[styles.input, { flex: 1 }]} value={senderName} onChangeText={setSenderName} placeholder="Sender name" placeholderTextColor={Colors.textLight} />
                  <TextInput style={[styles.input, { flex: 1 }]} value={senderPhone} onChangeText={setSenderPhone} placeholder="Sender phone" placeholderTextColor={Colors.textLight} keyboardType="phone-pad" />
                </View>
                <TextInput style={[styles.input, { minHeight: 60 }]} value={senderMessage} onChangeText={setSenderMessage} placeholder="Message from sender..." placeholderTextColor={Colors.textLight} multiline />
              </View>
            )}

            {/* Notes */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Notes (optional)</Text>
              <TextInput
                style={[styles.input, { minHeight: 60 }]}
                value={notes}
                onChangeText={setNotes}
                placeholder="Special instructions..."
                placeholderTextColor={Colors.textLight}
                multiline
              />
            </View>

            {/* Submit */}
            <TouchableOpacity
              style={[styles.submitBtn, submitting && { opacity: 0.6 }]}
              onPress={handlePlaceOrder}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator color={Colors.white} />
              ) : (
                <>
                  <Ionicons name="checkmark-circle" size={20} color={Colors.white} />
                  <Text style={styles.submitBtnText}>
                    Place {orderType === 'delivery' ? 'Delivery' : 'Pickup'} Order — ₹{cartTotal.toFixed(0)}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  emptyText: { fontSize: FontSize.md, color: Colors.textLight, marginTop: 8 },

  locRow: { maxHeight: 50, backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border },
  locChip: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: BorderRadius.full, backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border },
  locChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  locChipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  locChipTextActive: { color: Colors.white, fontWeight: '700' },

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    margin: Spacing.md, marginBottom: 0, paddingHorizontal: Spacing.md,
    height: 44, backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: FontSize.sm, color: Colors.text },

  productCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 1, borderColor: Colors.border,
  },
  productName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  productPrice: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.primary, marginTop: 2 },
  productType: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2, textTransform: 'capitalize' },

  addBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.primary, borderRadius: BorderRadius.md,
    paddingHorizontal: 14, paddingVertical: 8,
  },
  addBtnText: { fontSize: FontSize.sm, color: Colors.white, fontWeight: '600' },

  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  qtyBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: Colors.primary + '15', justifyContent: 'center', alignItems: 'center',
  },
  qtyText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, minWidth: 24, textAlign: 'center' },

  cartBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, borderTopWidth: 1, borderTopColor: Colors.border,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    paddingBottom: Platform.OS === 'ios' ? 30 : Spacing.md,
  },
  cartCount: { fontSize: FontSize.sm, color: Colors.textSecondary },
  cartTotal: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  cartBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.primary, borderRadius: BorderRadius.md,
    paddingHorizontal: 20, paddingVertical: 12,
  },
  cartBtnText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.white },

  // Checkout Modal
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  modalTitle: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },

  section: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md,
    marginBottom: Spacing.md, borderWidth: 1, borderColor: Colors.border,
  },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },

  chipRow: { flexDirection: 'row', gap: Spacing.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full, backgroundColor: Colors.background,
    borderWidth: 1.5, borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  chipTextActive: { color: Colors.white, fontWeight: '700' },

  input: {
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm, fontSize: FontSize.sm, color: Colors.text, marginTop: Spacing.xs,
  },

  pickerBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.background, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  pickerBtnText: { fontSize: FontSize.sm, color: Colors.textLight },

  savedCount: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600' },
  addrChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: BorderRadius.full,
    backgroundColor: Colors.primary + '10', marginRight: 8, maxWidth: 200,
  },
  addrChipText: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600' },

  cartItem: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 6,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  cartItemName: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  cartItemPrice: { fontSize: FontSize.xs, color: Colors.textLight },
  cartItemTotal: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },

  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between', marginTop: Spacing.sm, paddingTop: Spacing.sm,
  },
  totalLabel: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  totalValue: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.primary },

  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    backgroundColor: Colors.primary, borderRadius: BorderRadius.md,
    paddingVertical: Spacing.lg, marginTop: Spacing.sm,
  },
  submitBtnText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '700' },
});
