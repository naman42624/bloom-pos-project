// The customer-facing order-request page — a customer opens a link a staff
// member shared (see CustomerDetailScreen's "Copy Order Link"/WhatsApp
// buttons) and submits their own order request, which staff later review
// and approve into a real order (see OrderRequestsScreen.js + LogOrderScreen
// pre-fill). Rendered via App.js's routing bypass, same pattern as
// TrackingScreen.js — see that file's own header comment for why this
// screen must import NOTHING that depends on AuthContext or React
// Navigation.
import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, Image, Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import Button from '../components/Button';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { Colors, Spacing, FontSize, BorderRadius, Shadows } from '../constants/theme';

const WASH = '#FBF3EC';

const STATUS_LABEL = { pending: 'Waiting for confirmation', approved: 'Confirmed', declined: 'Declined' };

// One status line, shared by the per-customer "recent requests" list and the
// single-request status page so both always say the same words.
function StatusBlock({ status, declineReason }) {
  return (
    <>
      <Text style={[styles.statusBadge, status === 'approved' && styles.statusApproved, status === 'declined' && styles.statusDeclined]}>
        {STATUS_LABEL[status] || 'Waiting for confirmation'}
      </Text>
      {status === 'declined' && !!declineReason && (
        <Text style={styles.declineReason}>{declineReason}</Text>
      )}
    </>
  );
}

// Props: { token } per-customer page, { mode: 'open' } the general link
// (anyone, asks for name + phone), { statusToken } status of one open-link
// request.
export default function OrderRequestScreen({ token, mode, statusToken }) {
  const isOpen = mode === 'open';
  const isStatus = !!statusToken;
  const guardSubmit = useSubmitGuard();
  const [state, setState] = useState({ loading: true, data: null, errorKind: null });
  const [submitted, setSubmitted] = useState(false);

  const [orderType, setOrderType] = useState('delivery');
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [message, setMessage] = useState('');
  const [requestedDate, setRequestedDate] = useState('');
  const [requestedTime, setRequestedTime] = useState('');
  const [items, setItems] = useState([]);
  const [productQuery, setProductQuery] = useState('');
  const [customText, setCustomText] = useState('');
  const [paymentClaimed, setPaymentClaimed] = useState(false);
  const [paymentReference, setPaymentReference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [requesterPhone, setRequesterPhone] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [statusUrl, setStatusUrl] = useState('');

  const fetchPage = () => {
    if (isStatus) return api.getOrderRequestStatus(statusToken);
    if (isOpen) return api.getOpenOrderRequestPage();
    return api.getOrderRequestPage(token);
  };

  const loadPage = () => {
    fetchPage()
      .then((res) => setState({ loading: false, data: res.data, errorKind: null }))
      .catch((err) => {
        const kind = err?.status === 404 ? 'not_found' : 'server_error';
        setState({ loading: false, data: null, errorKind: kind });
      });
  };

  useEffect(() => {
    let cancelled = false;
    fetchPage()
      .then((res) => { if (!cancelled) setState({ loading: false, data: res.data, errorKind: null }); })
      .catch((err) => {
        if (cancelled) return;
        const kind = err?.status === 404 ? 'not_found' : 'server_error';
        setState({ loading: false, data: null, errorKind: kind });
      });
    return () => { cancelled = true; };
  }, [token, mode, statusToken]);

  const addProduct = (product) => {
    setItems((prev) => [...prev, { key: `p-${product.id}-${prev.length}`, product_id: product.id, name: product.name, quantity: 1 }]);
    setProductQuery('');
  };

  const addCustomItem = () => {
    if (!customText.trim()) return;
    setItems((prev) => [...prev, { key: `c-${prev.length}-${prev.length + 1}`, custom: true, description: customText.trim(), name: customText.trim(), quantity: 1 }]);
    setCustomText('');
  };

  const changeQuantity = (key, delta) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, quantity: Math.max(1, it.quantity + delta) } : it)));
  };

  const removeItem = (key) => {
    setItems((prev) => prev.filter((it) => it.key !== key));
  };

  const handleSubmit = async () => {
    setFormError('');
    if (isOpen) {
      const errs = {};
      if (requesterName.trim().length < 2) errs.name = 'Please enter your name.';
      if (requesterPhone.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '').length !== 10) {
        errs.phone = 'Please enter your 10-digit phone number.';
      }
      setFieldErrors(errs);
      if (errs.name || errs.phone) return;
    }
    if (!recipientName.trim() || !recipientPhone.trim()) {
      setFormError('Please enter who the order is for, and their phone number.');
      return;
    }
    if (orderType === 'delivery' && !deliveryAddress.trim()) {
      setFormError('Please enter a delivery address.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate.trim())) {
      setFormError('Please enter a date like 2026-09-25.');
      return;
    }
    if (items.length === 0) {
      setFormError('Please add at least one item.');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        recipient_name: recipientName.trim(),
        recipient_phone: recipientPhone.trim(),
        order_type: orderType,
        delivery_address: orderType === 'delivery' ? deliveryAddress.trim() : undefined,
        message: message.trim() || undefined,
        requested_date: requestedDate.trim(),
        requested_time: requestedTime.trim() || undefined,
        items: items.map((it) => (it.custom
          ? { custom: true, description: it.description, quantity: it.quantity }
          : { product_id: it.product_id, name: it.name, quantity: it.quantity })),
        payment_claimed: paymentClaimed,
        payment_reference: paymentClaimed ? (paymentReference.trim() || undefined) : undefined,
      };
      if (isOpen) {
        payload.requester_name = requesterName.trim();
        payload.requester_phone = requesterPhone.trim();
        const res = await api.submitOpenOrderRequest(payload);
        const path = res?.data?.status_url || '';
        setStatusUrl(path ? `${window.location.origin}${path}` : '');
      } else {
        await api.submitOrderRequest(token, payload);
      }
      setSubmitted(true);
    } catch (err) {
      setFormError(err.message || 'Something went wrong — please try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setSubmitted(false);
    setOrderType('delivery');
    setRecipientName('');
    setRecipientPhone('');
    setDeliveryAddress('');
    setMessage('');
    setRequestedDate('');
    setRequestedTime('');
    setItems([]);
    setPaymentClaimed(false);
    setPaymentReference('');
    setFormError('');
    setFieldErrors({});
    setStatusUrl('');
    setState((s) => ({ ...s, loading: true }));
    loadPage();
  };

  if (state.loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  if (state.errorKind || !state.data) {
    const isServerError = state.errorKind === 'server_error';
    return (
      <View style={styles.center}>
        <Ionicons name={isServerError ? 'cloud-offline-outline' : 'link-outline'} size={40} color={Colors.textLight} style={{ marginBottom: Spacing.sm }} />
        <Text style={styles.notFoundTitle}>{isServerError ? "We couldn't load this page" : "This link isn't valid"}</Text>
        <Text style={styles.notFoundText}>
          {isServerError
            ? 'Something went wrong on our end — please try reloading this page in a moment.'
            : 'Please ask the shop to send you a fresh link.'}
        </Text>
      </View>
    );
  }

  if (isStatus) {
    const d = state.data;
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.card}>
          <View style={styles.ribbon} />
          <View style={styles.cardBody}>
            <Text style={styles.eyebrow}>ORDER REQUEST</Text>
            <Text style={styles.saleNumber}>Your request</Text>
            <View style={styles.statusSection}>
              <StatusBlock status={d.status} declineReason={d.decline_reason} />
              {(d.items_summary || []).map((it, i) => (
                <Text key={i} style={styles.statusRowText}>{it.quantity} x {it.name}</Text>
              ))}
            </View>
            <Text style={styles.notFoundText}>Keep this page to check on your order any time.</Text>
          </View>
        </View>
      </ScrollView>
    );
  }

  const { customer_name, products, upi_qr_image_url } = state.data;
  const requests = state.data.requests || [];
  const filteredProducts = productQuery.trim()
    ? products.filter((p) => p.name.toLowerCase().includes(productQuery.trim().toLowerCase())).slice(0, 8)
    : products.slice(0, 8);

  if (submitted) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.card}>
          <View style={styles.ribbon} />
          <View style={styles.cardBody}>
            <Ionicons name="checkmark-circle" size={40} color={Colors.success} style={{ alignSelf: 'center', marginBottom: Spacing.sm }} />
            <Text style={styles.saleNumber}>Your request has been sent</Text>
            <Text style={styles.notFoundText}>We'll confirm with you shortly.</Text>
            {isOpen && !!statusUrl && (
              <View style={styles.statusSection}>
                <Text style={styles.sectionTitle}>Save this link to check your order</Text>
                <Text selectable style={styles.linkText}>{statusUrl}</Text>
                <Button title="Open my order status" variant="outline" onPress={() => { window.location.href = statusUrl; }} style={{ marginTop: Spacing.sm }} />
              </View>
            )}
            <Button title="Submit another request" onPress={resetForm} style={{ marginTop: Spacing.lg }} />
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <View style={styles.ribbon} />
        <View style={styles.cardBody}>
          <Text style={styles.eyebrow}>ORDER REQUEST</Text>
          <Text style={styles.saleNumber}>{isOpen ? 'Place an order request' : `Hi, ${customer_name}`}</Text>

          {isOpen && (
            <>
              <Text style={styles.label}>Your details</Text>
              <TextInput style={styles.input} placeholder="Your name" value={requesterName} onChangeText={setRequesterName} placeholderTextColor={Colors.textLight} />
              {!!fieldErrors.name && <Text style={styles.fieldError}>{fieldErrors.name}</Text>}
              <TextInput style={styles.input} placeholder="Your phone number" value={requesterPhone} onChangeText={setRequesterPhone} keyboardType="phone-pad" placeholderTextColor={Colors.textLight} />
              {!!fieldErrors.phone && <Text style={styles.fieldError}>{fieldErrors.phone}</Text>}
            </>
          )}

          {requests.length > 0 && (
            <View style={styles.statusSection}>
              <Text style={styles.sectionTitle}>Your recent requests</Text>
              {requests.map((r) => (
                <View key={r.id} style={styles.statusRow}>
                  <Text style={styles.statusRowText}>{r.requested_date} — {r.order_type === 'delivery' ? 'Delivery' : 'Pickup'}</Text>
                  <StatusBlock status={r.status} declineReason={r.decline_reason} />
                </View>
              ))}
            </View>
          )}

          <Text style={styles.sectionTitle}>New request</Text>

          <View style={styles.chipRow}>
            {['delivery', 'pickup'].map((t) => (
              <TouchableOpacity key={t} style={[styles.chip, orderType === t && styles.chipActive]} onPress={() => setOrderType(t)}>
                <Text style={[styles.chipText, orderType === t && styles.chipTextActive]}>{t === 'delivery' ? 'Delivery' : 'Pickup'}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>Who is this order for?</Text>
          <TextInput style={styles.input} placeholder="Recipient's name" value={recipientName} onChangeText={setRecipientName} placeholderTextColor={Colors.textLight} />
          <TextInput style={styles.input} placeholder="Recipient's phone number" value={recipientPhone} onChangeText={setRecipientPhone} keyboardType="phone-pad" placeholderTextColor={Colors.textLight} />

          {orderType === 'delivery' && (
            <TextInput style={[styles.input, styles.multiline]} placeholder="Delivery address" value={deliveryAddress} onChangeText={setDeliveryAddress} multiline placeholderTextColor={Colors.textLight} />
          )}

          <TextInput style={[styles.input, styles.multiline]} placeholder="Card message (optional)" value={message} onChangeText={setMessage} multiline placeholderTextColor={Colors.textLight} />

          <Text style={styles.label}>When would you like this?</Text>
          <TextInput style={styles.input} placeholder="Date (e.g. 2026-09-25)" value={requestedDate} onChangeText={setRequestedDate} placeholderTextColor={Colors.textLight} />
          <TextInput style={styles.input} placeholder="Time (e.g. morning, or 6 PM) — optional" value={requestedTime} onChangeText={setRequestedTime} placeholderTextColor={Colors.textLight} />

          <Text style={styles.label}>What would you like to order?</Text>
          <TextInput style={styles.input} placeholder="Search products…" value={productQuery} onChangeText={setProductQuery} placeholderTextColor={Colors.textLight} />
          {filteredProducts.map((p) => (
            <TouchableOpacity key={p.id} style={styles.suggestionRow} onPress={() => addProduct(p)}>
              <Text style={styles.suggestionText}>{p.name}</Text>
              <Text style={styles.suggestionPrice}>₹{p.selling_price}</Text>
            </TouchableOpacity>
          ))}

          <View style={styles.customRow}>
            <TextInput style={[styles.input, { flex: 1, marginBottom: 0 }]} placeholder="Anything else? (custom request)" value={customText} onChangeText={setCustomText} placeholderTextColor={Colors.textLight} />
            <TouchableOpacity style={styles.addCustomBtn} onPress={addCustomItem}>
              <Ionicons name="add" size={20} color={Colors.white} />
            </TouchableOpacity>
          </View>

          {items.map((it) => (
            <View key={it.key} style={styles.itemRow}>
              <Text style={styles.itemName} numberOfLines={1}>{it.name}</Text>
              <View style={styles.qtyControls}>
                <TouchableOpacity onPress={() => changeQuantity(it.key, -1)} style={styles.qtyBtn}><Text style={styles.qtyBtnText}>−</Text></TouchableOpacity>
                <Text style={styles.qtyText}>{it.quantity}</Text>
                <TouchableOpacity onPress={() => changeQuantity(it.key, 1)} style={styles.qtyBtn}><Text style={styles.qtyBtnText}>+</Text></TouchableOpacity>
              </View>
              <TouchableOpacity onPress={() => removeItem(it.key)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={18} color={Colors.textLight} />
              </TouchableOpacity>
            </View>
          ))}

          <Text style={styles.label}>Payment</Text>
          {upi_qr_image_url && (
            <Image source={{ uri: api.getMediaUrl(upi_qr_image_url) }} style={styles.qrImage} resizeMode="contain" />
          )}
          <View style={styles.paidRow}>
            <Text style={styles.paidLabel}>I've already paid</Text>
            <Switch value={paymentClaimed} onValueChange={setPaymentClaimed} trackColor={{ false: Colors.border, true: Colors.primary + '80' }} thumbColor={paymentClaimed ? Colors.primary : Colors.textLight} />
          </View>
          {paymentClaimed && (
            <TextInput style={styles.input} placeholder="UPI reference number (optional)" value={paymentReference} onChangeText={setPaymentReference} placeholderTextColor={Colors.textLight} />
          )}

          {!!formError && <Text style={styles.errorText}>{formError}</Text>}

          <Button title="Send Request" onPress={guardSubmit(handleSubmit)} loading={submitting} style={{ marginTop: Spacing.lg }} />
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg, backgroundColor: WASH },
  container: { flexGrow: 1, alignItems: 'center', padding: Spacing.lg, backgroundColor: WASH, minHeight: '100%' },
  card: { backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, width: '100%', maxWidth: 480, overflow: 'hidden', ...Shadows.md, marginVertical: Spacing.lg },
  ribbon: { height: 6, backgroundColor: Colors.primary },
  cardBody: { padding: Spacing.lg },
  eyebrow: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.primary, textAlign: 'center', letterSpacing: 1.5 },
  saleNumber: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, textAlign: 'center', marginTop: 4, marginBottom: Spacing.md },
  notFoundTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, textAlign: 'center' },
  notFoundText: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.sm },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginTop: Spacing.md, marginBottom: Spacing.sm },
  statusSection: { backgroundColor: Colors.background, borderRadius: BorderRadius.md, padding: Spacing.md, marginBottom: Spacing.md },
  statusRow: { paddingVertical: Spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border },
  statusRowText: { fontSize: FontSize.sm, color: Colors.text },
  statusBadge: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.textLight, marginTop: 2 },
  statusApproved: { color: Colors.success },
  statusDeclined: { color: Colors.error },
  declineReason: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2, fontStyle: 'italic' },
  chipRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.md },
  chip: { flex: 1, paddingVertical: Spacing.sm, borderRadius: BorderRadius.md, borderWidth: 1.5, borderColor: Colors.border, alignItems: 'center' },
  chipActive: { borderColor: Colors.primary, backgroundColor: Colors.primary + '18' },
  chipText: { color: Colors.textSecondary, fontWeight: '600' },
  chipTextActive: { color: Colors.primary },
  label: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text, marginTop: Spacing.md, marginBottom: Spacing.xs },
  input: { backgroundColor: Colors.background, borderRadius: BorderRadius.sm, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, fontSize: FontSize.md, color: Colors.text, borderWidth: 1, borderColor: Colors.border, marginBottom: Spacing.sm },
  multiline: { minHeight: 60, textAlignVertical: 'top' },
  suggestionRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, backgroundColor: Colors.background, borderRadius: BorderRadius.sm, marginBottom: 2 },
  suggestionText: { color: Colors.text, flex: 1 },
  suggestionPrice: { color: Colors.textSecondary },
  customRow: { flexDirection: 'row', gap: Spacing.sm, alignItems: 'center' },
  addCustomBtn: { backgroundColor: Colors.primary, borderRadius: BorderRadius.sm, width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border, gap: Spacing.sm },
  itemName: { flex: 1, color: Colors.text },
  qtyControls: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  qtyBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: Colors.background, alignItems: 'center', justifyContent: 'center' },
  qtyBtnText: { fontSize: FontSize.md, color: Colors.text, fontWeight: '700' },
  qtyText: { minWidth: 20, textAlign: 'center', color: Colors.text },
  qrImage: { width: 180, height: 180, alignSelf: 'center', marginBottom: Spacing.md, borderRadius: BorderRadius.sm },
  paidRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: Spacing.sm },
  paidLabel: { fontSize: FontSize.sm, color: Colors.text },
  fieldError: { color: Colors.error, fontSize: FontSize.sm, marginTop: -Spacing.xs, marginBottom: Spacing.sm },
  linkText: { fontSize: FontSize.sm, color: Colors.text },
  errorText: { color: Colors.error, fontSize: FontSize.sm, marginTop: Spacing.sm, textAlign: 'center' },
});
