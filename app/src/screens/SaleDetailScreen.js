import React, { useState, useEffect, useLayoutEffect, useCallback } from 'react';

import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Platform, ActivityIndicator, Modal, TextInput, KeyboardAvoidingView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as ImagePicker from 'expo-image-picker';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { formatDateTime, formatCardDateTime, isToday } from '../utils/datetime';
import { Image } from 'react-native';
import ImageModal from '../components/ImageModal';
import VoiceNoteRecorder from '../components/VoiceNoteRecorder';
import AttachmentVoiceRow from '../components/AttachmentVoiceRow';
import StageBadge from '../components/StageBadge';
import { formatMoney, STAFF_ROLE_LABELS, ASSIGNABLE_STAFF_ROLES } from '../constants/orderDisplay';

// Duplicated locally (rather than imported from OrdersInboxScreen) to avoid
// coupling this detail screen's import graph to an inbox screen.
const CHANNEL_ICONS = { whatsapp: 'logo-whatsapp', email: 'mail', website: 'globe', walk_in: 'walk', phone: 'call' };

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

const PAYMENT_METHODS = [
  { key: 'cash', label: 'Cash', icon: 'cash' },
  { key: 'card', label: 'Card', icon: 'card' },
  { key: 'upi', label: 'UPI', icon: 'phone-portrait' },
];

// Top-level sale fields the history diff summary knows how to describe in
// plain language. Anything else that changes is silently ignored rather
// than dumped as raw JSON.
const AUDIT_FIELD_LABELS = {
  delivery_address: 'Delivery address',
  payment_status: 'Payment status',
};

// previous_state/new_state come back from the API as already-parsed JSON
// objects (Postgres JSONB column), but this defends against a raw string
// making it through in case that ever changes.
function parseMaybeJson(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

// Turns an audit log's previous_state/new_state pair into a list of plain-
// language change descriptions ("Quantity changed from 2 to 3") instead of
// a raw JSON diff — a non-technical owner needs to read this at a glance.
function summarizeAuditChanges(log) {
  const prev = parseMaybeJson(log?.previous_state) || {};
  const next = parseMaybeJson(log?.new_state) || {};
  const changes = [];

  Object.keys(AUDIT_FIELD_LABELS).forEach((field) => {
    const oldVal = prev?.[field] ?? '';
    const newVal = next?.[field] ?? '';
    if (String(oldVal) !== String(newVal)) {
      changes.push(`${AUDIT_FIELD_LABELS[field]} changed from "${oldVal || '(none)'}" to "${newVal || '(none)'}"`);
    }
  });

  const prevItems = Array.isArray(prev?.items) ? prev.items : [];
  const nextItems = Array.isArray(next?.items) ? next.items : [];
  const prevById = new Map(prevItems.map((it) => [it.id, it]));
  nextItems.forEach((item) => {
    const old = prevById.get(item.id);
    if (!old) return;
    const itemLabel = item.product_name || old.product_name || 'Item';

    const oldQty = Number(old.quantity);
    const newQty = Number(item.quantity);
    if (Number.isFinite(oldQty) && Number.isFinite(newQty) && oldQty !== newQty) {
      changes.push(`${itemLabel}: quantity changed from ${oldQty} to ${newQty}`);
    }

    const oldPrice = Number(old.unit_price);
    const newPrice = Number(item.unit_price);
    if (Number.isFinite(oldPrice) && Number.isFinite(newPrice) && oldPrice !== newPrice) {
      changes.push(`${itemLabel}: price changed from ₹${oldPrice.toFixed(2)} to ₹${newPrice.toFixed(2)}`);
    }
  });

  return changes;
}

// One row per voice-note attachment — each owns its own expo-audio player
// instance (hooks must be called unconditionally per component instance,
// so a list of N voice notes needs N sibling components, not N hook calls
// inside a single .map()).
export default function SaleDetailScreen({ route, navigation }) {
  const { saleId } = route.params;
  const { user, settings } = useAuth();
  const [sale, setSale] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedItems, setExpandedItems] = useState({});
  const [viewedImage, setViewedImage] = useState(null);

  // Attachments (photos & voice notes) — seeded from the sale detail
  // response, then refreshed independently after each upload so newly
  // added items append to the list without losing earlier ones.
  const [attachments, setAttachments] = useState([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);

  const fromCheckout = route.params?.fromCheckout;

  useLayoutEffect(() => {
    if (fromCheckout) {
      navigation.setOptions({
        headerLeft: () => null, // Hide back button if we want to force "Done"
        headerRight: () => (
          <TouchableOpacity
            onPress={() => navigation.navigate('POS', { screen: 'POSHome', params: { clearCart: true } })}


            style={{ marginRight: 10, backgroundColor: Colors.primary, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 }}
          >
            <Text style={{ color: Colors.white, fontWeight: 'bold', fontSize: 13 }}>Done</Text>
          </TouchableOpacity>
        ),
      });
    }
  }, [navigation, fromCheckout]);


  const canManage = user?.role === 'owner' || user?.role === 'manager';
  const canEdit = canManage || (sale?.created_by === user?.id);
  const isCustomer = user?.role === 'customer';
  // Counter staff can cancel/refund at the counter (up to the same cap a
  // manager has, enforced server-side — see the refund_manager_limit check
  // on POST /:id/refund and PUT /:id/cancel). Everyone else keeps whatever
  // canManage already grants (owner/manager only). Added 2026-08-31 after
  // counter staff hit a live order needing a refund with no one able to
  // process it without an owner/manager on hand.
  const canCancelOrRefund = canManage || user?.role === 'counter_staff';
  // Counter staff assign/reassign production tasks to florist staff as part
  // of logging an order — the backend (PUT /production/tasks/:id/assign)
  // already granted this 2026-08-31, but the button itself was still gated
  // behind canManage, so it never actually appeared for them. Found live
  // (2026-09-01): the picker already listed florist_staff as assignable,
  // it just had no visible way to open it.
  const canAssignTasks = canManage || user?.role === 'counter_staff';
  // Florist/prep staff never touch payments (they only see this screen for
  // the production tasks on an order) and customers viewing their own order
  // can't record payments either (POST /:id/payments is staff-only
  // server-side) — hide the button for both rather than letting them tap
  // into a dead-end request. Delivery partners can't reach this screen at
  // all (no SaleDetail route in their stack), so no check needed for them.
  const canRecordPayment = !['florist_staff', 'customer'].includes(user?.role);
  // Assigning a rider and re-sending a failed delivery are both done on
  // DeliveryDetailScreen, whose own gate (its canManageDeliveries, :65)
  // mirrors PUT /deliveries/:id/assign and PUT /deliveries/:id/reattempt —
  // both authorize('owner', 'manager', 'counter_staff'). Without this check an
  // `employee` or `florist_staff` tapped a real-looking "Assign Rider" /
  // "Delivery Failed — Send Again", landed on a screen showing none of those
  // controls, and had nowhere to go: a dead end moved one level deeper rather
  // than removed (review finding, 2026-09-02). Live-relevant, not theoretical
  // — CLAUDE.md records four `employee` accounts that stay on that role
  // indefinitely. Same role list as OrderCard's, kept in step on purpose
  // (app/src/components/orderBoard/OrderCard.js).
  const canManageDeliveries = ['owner', 'manager', 'counter_staff'].includes(user?.role);

  // Convert order type state
  const [convertModalVisible, setConvertModalVisible] = useState(false);
  const [convertAddress, setConvertAddress] = useState('');
  const [convertCharges, setConvertCharges] = useState('');
  const [convertTarget, setConvertTarget] = useState(null);
  const [convertSavedAddresses, setConvertSavedAddresses] = useState([]);
  const [convertSenderName, setConvertSenderName] = useState('');
  const [convertSenderPhone, setConvertSenderPhone] = useState('');
  const [convertSenderAddress, setConvertSenderAddress] = useState('');
  const [convertReceiverName, setConvertReceiverName] = useState('');
  const [convertReceiverPhone, setConvertReceiverPhone] = useState('');
  const [convertSenderSameAsReceiver, setConvertSenderSameAsReceiver] = useState(false);

  // Assignment modal
  const [assignModalVisible, setAssignModalVisible] = useState(false);
  const [assignTaskId, setAssignTaskId] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [loadingEmployees, setLoadingEmployees] = useState(false);
  // True when the location-scoped staff list came back empty and we widened to
  // every location. Never inferred at render time — the modal must be able to
  // SAY it widened, and "showing everyone" above a genuinely empty list would
  // be a lie.
  const [employeesShowingEveryone, setEmployeesShowingEveryone] = useState(false);

  // Pickup Payment Modal
  const [pickupPayModalVisible, setPickupPayModalVisible] = useState(false);
  const [pickupPayments, setPickupPayments] = useState([{ method: 'cash', amount: '', reference_number: '' }]);
  const [pickupWriteOffAmount, setPickupWriteOffAmount] = useState('');
  const [confirmingPickup, setConfirmingPickup] = useState(false);
  // The inline collect-payment modal has two callers. Complete Order's own
  // guard opens it to take the money AND finish the order in one go (its
  // long-standing behaviour). The "Collect ₹N" button opens it to take the
  // money only — paying is not the same event as the customer physically
  // collecting, so the refreshed stage decides what comes next.
  const [pickupPayCompletesOrder, setPickupPayCompletesOrder] = useState(true);

  // One-tap "Confirm Pickup" / "Mark Delivered" (Task 12, order-lifecycle
  // plan, 2026-09-01) — separate from confirmingPickup above, which is the
  // pay-balance modal's own loading flag. Keyed by nothing (single button on
  // this screen, unlike OrderKanbanBoard's per-order map) since only one
  // sale is ever in view here.
  const [quickActionLoading, setQuickActionLoading] = useState(false);

  // Opens the inline take-the-money modal pre-filled with the whole balance.
  // Deliberately a modal on THIS screen rather than a navigate to AddPayment:
  // a customer is standing at the counter while this runs, and collecting a
  // balance is the shop's highest-frequency interaction, so it has to be the
  // shortest path (CLAUDE.md, UX design principles). The dashboard card's
  // Collect ₹N navigates instead only because a card has nowhere to put a
  // modal; the label is kept identical so the two still read the same.
  const openCollectPaymentModal = (completeAfter) => {
    setPickupPayCompletesOrder(completeAfter);
    setPickupPayments([{ method: 'cash', amount: Number(due).toFixed(0), reference_number: '' }]);
    setPickupWriteOffAmount('');
    setPickupPayModalVisible(true);
  };

  const handleAddPickupPayment = () => setPickupPayments([...pickupPayments, { method: 'cash', amount: '', reference_number: '' }]);
  const updatePickupPayment = (index, field, value) => {
    const updated = [...pickupPayments];
    updated[index][field] = value;
    setPickupPayments(updated);
  };
  const removePickupPayment = (index) => setPickupPayments(pickupPayments.filter((_, i) => i !== index));

  // Edit Sale & Audit Logs
  const [auditLogs, setAuditLogs] = useState([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editError, setEditError] = useState(null);
  const [editCustomerName, setEditCustomerName] = useState('');
  const [editCustomerPhone, setEditCustomerPhone] = useState('');
  const [editPaymentStatus, setEditPaymentStatus] = useState('');
  const [editPaymentMethod, setEditPaymentMethod] = useState('cash');
  const [savingEdit, setSavingEdit] = useState(false);

  // Item price/quantity edit
  const [itemEditModalVisible, setItemEditModalVisible] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [editItemQuantity, setEditItemQuantity] = useState('');
  const [editItemPrice, setEditItemPrice] = useState('');
  const [itemEditError, setItemEditError] = useState(null);
  const [savingItemEdit, setSavingItemEdit] = useState(false);

  // Plain-language reason item editing is blocked right now, or null if it's
  // allowed — mirrors PUT /api/sales/:id's own same-day + creator-only rules
  // (the register-closed check isn't verified client-side; that error surfaces
  // from the server on save instead, see handleSaveItemEdit).
  const itemEditBlockReason = !sale
    ? null
    : !isToday(sale.created_at)
      ? 'Items can only be edited on the day the order was placed.'
      : (['employee', 'counter_staff'].includes(user?.role) && sale.created_by !== user?.id)
        ? 'You can only edit orders you created.'
        : null;

  useFocusEffect(
    useCallback(() => {
      fetchSale();
    }, [saleId])
  );

  const fetchSale = async () => {
    try {
      const res = await api.getSale(saleId);
      setSale(res.data);
      setAttachments(res.data?.attachments || []);
      if (canManage) {
        const auditRes = await api.getSaleAuditLogs(saleId);
        setAuditLogs(auditRes.data || []);
      }
    } catch { } finally { setLoading(false); }
  };

  const refreshAttachments = async () => {
    try {
      const res = await api.getSaleAttachments(saleId);
      setAttachments(res.data || []);
    } catch { }
  };

  const handlePickAttachmentPhoto = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please allow access to your photo library.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6 });
      if (result.canceled || !result.assets?.[0]) return;
      setUploadingAttachment(true);
      await api.uploadSaleAttachment(saleId, result.assets[0].uri, 'photo');
      await refreshAttachments();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to upload photo');
    } finally {
      setUploadingAttachment(false);
    }
  };

  const handleVoiceNoteRecorded = async (uri, durationSeconds) => {
    try {
      setUploadingAttachment(true);
      await api.uploadSaleAttachment(saleId, uri, 'voice_note', durationSeconds);
      await refreshAttachments();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to upload voice note');
    } finally {
      setUploadingAttachment(false);
    }
  };

  const openEditModal = () => {
    setEditCustomerName(sale.customer_name || sale.customer_display_name || '');
    setEditCustomerPhone(sale.customer_phone || sale.customer_display_phone || '');
    setEditPaymentStatus(sale.payment_status || 'pending');
    setEditPaymentMethod(sale.payments && sale.payments[0] ? sale.payments[0].method : 'cash');
    setEditError(null);
    setEditModalVisible(true);
  };

  const handleSaveEdit = async () => {
    setSavingEdit(true);
    try {
      // Calculate current paid amount to retain the amount but change the method
      const currentPaid = (sale.payments || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);

      const payload = {
        customer_name: editCustomerName,
        customer_phone: editCustomerPhone,
        payment_status: editPaymentStatus,
      };

      if (currentPaid > 0) {
        // Just replacing the method of the existing payments
        payload.payments = [{ method: editPaymentMethod, amount: currentPaid }];
      } else if (editPaymentStatus === 'paid') {
        // If changed from pending to paid and no previous payments exist, insert full amount
        payload.payments = [{ method: editPaymentMethod, amount: sale.grand_total }];
      }

      await api.updateSale(saleId, payload);
      setEditModalVisible(false);
      fetchSale();
      Alert.alert('Success', 'Sale updated successfully.');
    } catch (err) {
      setEditError(err.message || 'Failed to update sale');
    } finally {
      setSavingEdit(false);
    }
  };

  const openItemEditModal = (item) => {
    if (itemEditBlockReason) {
      // Not editable right now — explain why in plain language rather than
      // opening an editor that will just fail on save.
      if (Platform.OS === 'web') window.alert(itemEditBlockReason);
      else Alert.alert('Cannot Edit Item', itemEditBlockReason);
      return;
    }
    setEditingItem(item);
    setEditItemQuantity(String(item.quantity ?? ''));
    setEditItemPrice(String(item.unit_price ?? ''));
    setItemEditError(null);
    setItemEditModalVisible(true);
  };

  const handleSaveItemEdit = async () => {
    if (!editingItem) return;
    const qty = parseFloat(editItemQuantity);
    const price = parseFloat(editItemPrice);
    if (!Number.isFinite(qty) || qty <= 0) {
      setItemEditError('Enter a quantity greater than 0.');
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setItemEditError('Enter a valid price.');
      return;
    }
    setSavingItemEdit(true);
    setItemEditError(null);
    try {
      await api.updateSale(saleId, { items: [{ id: editingItem.id, quantity: qty, unit_price: price }] });
      setItemEditModalVisible(false);
      setEditingItem(null);
      await fetchSale(); // refreshes items + grand_total + history from the server
    } catch (err) {
      // Server-side-only checks (e.g. register closed for the day) surface here
      // in plain language, same as the rest of this screen's error handling.
      setItemEditError(err.message || 'Failed to update item. Please try again.');
    } finally {
      setSavingItemEdit(false);
    }
  };

  const goToRefund = () => {
    navigation.navigate('RefundSale', { saleId, grandTotal: sale.grand_total });
  };

  const handleCancel = () => {
    // The server blocks cancelling a sale with money still owed to the
    // customer (refund it first — see PUT /sales/:id/cancel). Checking the
    // same balance here means staff hit a clear "here's what to do" screen
    // *before* confirming, instead of tapping "Yes, cancel" and landing on
    // a dead-end error with no next step (staff-ux-checklist #6, added
    // 2026-09-01 after exactly that happened in live testing).
    const paidTotal = (sale.payments || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const refundedTotal = Number(sale.refund?.amount || 0);
    const unrefundedBalance = paidTotal - refundedTotal;

    if (unrefundedBalance > 0.01) {
      const message = `This order was paid ₹${unrefundedBalance.toFixed(2)}. Cancelling won't return that money on its own — refund the customer first, then cancel.`;
      if (Platform.OS === 'web') {
        if (window.confirm(`${message}\n\nOpen the refund screen now?`)) goToRefund();
      } else {
        Alert.alert('Refund needed first', message, [
          { text: 'Not now', style: 'cancel' },
          { text: 'Refund now', onPress: goToRefund },
        ]);
      }
      return;
    }

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
    goToRefund();
  };

  const handleViewLivePartner = () => {
    const partnerId = sale?.delivery?.delivery_partner_id || sale?.delivery?.partner_id;
    if (!partnerId) return;
    navigation.navigate('LiveDeliveryMap', {
      selectedPartnerId: partnerId,
      deliveryId: sale.delivery.id,
    });
  };

  const handleStatusTransition = (nextStatus, label) => {
    // Guard: an order with an OPEN delivery cannot be completed. Keyed on the
    // delivery row rather than order_type (was `order_type === 'delivery'`) to
    // match the backend guard re-keyed 2026-09-02 — a pre_order fulfilled by
    // delivery slipped past this copy and got a raw 400 instead of a sentence.
    // Kept as a safety net even though the button is now hidden for this shape:
    // `sale` is only as fresh as the last fetch, and someone else can attach a
    // delivery between that fetch and this tap.
    if (nextStatus === 'completed' && hasOpenDelivery) {
      // A failed delivery CANNOT be marked delivered — PUT /deliveries/:id/deliver
      // only accepts 'picked_up'/'in_transit'. Its real recoveries are reattempt
      // or cancel, so telling staff to "mark it delivered" would send them at an
      // action the API refuses. Same split the backend message makes.
      const msg = sale.delivery?.status === 'failed'
        ? "This order's delivery did not go through. Send it out again, or cancel the delivery, then finish the order."
        : 'This order cannot be finished until the delivery is done. Tap Delivery Status above, then mark it delivered.';
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Cannot Complete', msg);
      return;
    }

    // Guard: cannot complete order if any production tasks are still pending/assigned/in_progress
    if (nextStatus === 'completed' && sale.production_tasks && sale.production_tasks.length > 0) {
      const incompleteTasks = sale.production_tasks.filter(t => !['completed', 'cancelled'].includes(t.status));
      if (incompleteTasks.length > 0) {
        const msg = `Cannot complete this order — ${incompleteTasks.length} production task(s) are still ${incompleteTasks.map(t => t.status).join(', ')}. Please complete or cancel all tasks first.`;
        Platform.OS === 'web' ? window.alert(msg) : Alert.alert('Cannot Complete', msg);
        return;
      }
    }

    // Guard: any NON-DELIVERY order must be settled before completion. Was
    // `order_type === 'pickup' && due > 0.01`, so an unpaid walk_in/pre_order
    // never reached this modal and hit the backend's payment guard as a raw
    // 400 with no way to take the money. balanceBlocksCompletion is the same
    // condition that guard now uses.
    if (nextStatus === 'completed' && balanceBlocksCompletion) {
      openCollectPaymentModal(true);
      return;
    }

    const msg = `${label} for this order?`;
    const onConfirm = async () => {
      try {
        // Converge on display_stage.nextAction where the server has already
        // described this exact transition (endpoint + method + body), so the
        // request stops being re-derived client-side — same api.advanceOrder
        // path handleQuickAction and the dashboard card use. Falls back to the
        // hand-built call whenever there is no matching nextAction (notably
        // when the viewer's role is outside the endpoint's authorize() list, so
        // the server sends none): behaviour is unchanged there, including the
        // error it surfaces, rather than a button that silently does nothing.
        const serverAction = nextAction && nextAction.body?.status === nextStatus ? nextAction : null;
        if (serverAction) {
          await api.advanceOrder(serverAction);
        } else {
          await api.updateOrderStatus(saleId, nextStatus);
        }
        fetchSale();
      } catch (err) {
        if (Platform.OS === 'web') {
          window.alert('Error: ' + (err.message || 'Failed to update status'));
        } else {
          Alert.alert('Error', err.message || 'Failed to update status');
        }
      }
    };

    if (Platform.OS === 'web') {
      setTimeout(() => {
        if (window.confirm(msg)) onConfirm();
      }, 50);
    } else {
      Alert.alert(label, msg, [
        { text: 'Cancel', style: 'cancel' },
        { text: label, onPress: onConfirm },
      ]);
    }
  };

  // One-tap dispatch for sale.display_stage.nextAction (server/utils/order-stage.js)
  // — only ever rendered for 'Confirm Pickup'/'Mark Delivered', both of which
  // the server only offers when there's nothing left to collect (no balance
  // due, no COD outstanding). Same generic api.advanceOrder(nextAction) call
  // Task 10 built for OrderKanbanBoard's handleQuickAction — reused as-is
  // rather than duplicated into a shared orderActions.js helper, since the
  // whole call is a single pass-through line with no logic of its own to
  // share beyond what api.advanceOrder already centralizes.
  const handleQuickAction = async () => {
    const nextAction = sale?.display_stage?.nextAction;
    if (!nextAction) return;
    setQuickActionLoading(true);
    try {
      await api.advanceOrder(nextAction);
      fetchSale();
    } catch (err) {
      const msg = err.message || 'Unable to update this order.';
      if (Platform.OS === 'web') {
        window.alert('Error: ' + msg);
      } else {
        Alert.alert('Order Update', msg);
      }
    } finally {
      setQuickActionLoading(false);
    }
  };

  // react-native-web's Alert is a literal no-op (its Alert.alert() body is
  // empty — node_modules/react-native-web/dist/exports/Alert/index.js), and the
  // counter runs this app on web. Every message on the take-the-money path has
  // to be SEEN, especially "the payment went through but the order didn't", so
  // it goes through the same Platform check the rest of this file already uses
  // (e.g. :476, :485) rather than a bare Alert.alert that vanishes on web.
  const notify = (title, message) => {
    if (Platform.OS === 'web') {
      window.alert(title + ': ' + message);
    } else {
      Alert.alert(title, message);
    }
  };

  const handleConfirmPickupPayment = async () => {
    const totalPayments = pickupPayments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    const woAmount = parseFloat(pickupWriteOffAmount) || 0;
    const totalReduction = totalPayments + woAmount;

    if (totalReduction <= 0) {
      notify('Invalid', 'Please enter a valid payment amount.');
      return;
    }

    setConfirmingPickup(true);
    try {
      const formattedPayments = pickupPayments
        .map(p => ({ ...p, amount: parseFloat(p.amount) || 0 }))
        .filter(p => p.amount > 0);

      // ── Step 1: take the money ──
      // Its own try/catch, deliberately NOT sharing one with step 2. When both
      // awaits sat in a single block, a step-2 failure surfaced step 1's
      // message — "Could not record the payment. Please try again." — while the
      // money was already banked, with the modal still open and the full
      // balance still pre-filled. Anyone who followed that instruction charged
      // the customer twice. Never tell someone to retry a payment that
      // succeeded (review finding, 2026-09-02).
      try {
        await api.addPaymentToSale(saleId, {
          payments: formattedPayments,
          write_off_amount: woAmount > 0 ? woAmount : undefined,
        });
      } catch (err) {
        // Nothing was taken. Retrying really is the right instruction here, and
        // the modal stays open with the amounts intact so it is one tap away.
        notify('Error', err.message || 'Could not record the payment. Please try again.');
        return;
      }

      // ── Step 2: finish the order too ──
      // ONLY when this modal was opened from Complete Order. Opened from
      // "Collect ₹N" it just takes the money and lets the refreshed stage offer
      // the real next step (Confirm Pickup for a pickup, Complete for a
      // walk_in/pre_order) — force-completing there would mark a pickup
      // 'picked_up' while the customer is still waiting for the flowers.
      let completed = false;
      if (pickupPayCompletesOrder) {
        try {
          await api.updateOrderStatus(saleId, 'completed');
          completed = true;
        } catch (err) {
          // The payment IS recorded. Close the modal and refetch FIRST so the
          // balance on screen is the real one and the correct next control is
          // already rendered, then say what actually happened. fetchSale()
          // swallows its own errors, so this cannot throw past the finally.
          //
          // The message deliberately does NOT name a button. The likeliest
          // real cause of a step-2 failure is a PARTIAL payment (the modal
          // allows one), and then the next control is another "Collect ₹N",
          // not Complete Order or Confirm Pickup — naming one would send staff
          // looking for a button that isn't there. The backend's own guard
          // messages are already plain language ("Cannot complete — ₹100.00 is
          // still due. Please collect payment first."), so pass that straight
          // through as the reason, the same way OrderKanbanBoard's
          // handleQuickAction does.
          setPickupPayModalVisible(false);
          await fetchSale();
          const why = err?.message ? ' ' + err.message : '';
          notify('Payment recorded', 'The payment is saved — do not collect it again. The order was not finished.' + why);
          return;
        }
      }

      setPickupPayModalVisible(false);
      // Awaited, not fire-and-forget: the next action has to be on screen the
      // moment the modal closes, with no manual pull-to-refresh.
      await fetchSale();
      notify('Success', completed ? 'Payment recorded and order completed.' : 'Payment recorded.');
    } finally {
      setConfirmingPickup(false);
    }
  };

  const handleFulfillFromStock = (saleItemId, productName) => {
    const msg = `Use ready stock for "${productName}"? This will deduct from product inventory.`;
    const onConfirm = async () => {
      try {
        await api.fulfillFromStock(saleId, saleItemId);
        fetchSale();
        if (Platform.OS === 'web') {
          window.alert(`"${productName}" fulfilled from stock`);
        } else {
          Alert.alert('Done', `"${productName}" fulfilled from stock`);
        }
      } catch (err) {
        if (Platform.OS === 'web') {
          window.alert('Error: ' + (err.message || 'Failed to fulfill from stock'));
        } else {
          Alert.alert('Error', err.message || 'Failed to fulfill from stock');
        }
      }
    };

    if (Platform.OS === 'web') {
      setTimeout(() => {
        if (window.confirm(msg)) onConfirm();
      }, 50);
    } else {
      Alert.alert('Fulfill from Stock', msg, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Fulfill', onPress: onConfirm },
      ]);
    }
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

  const openAssignModal = async (taskId) => {
    setAssignTaskId(taskId);
    setLoadingEmployees(true);
    setAssignModalVisible(true);
    setEmployeesShowingEveryone(false);
    try {
      // GET /production/assignable-staff. NOT GET /users, which is
      // owner/manager-only because it lists the whole account directory,
      // customers included — counter_staff has no business seeing that just to
      // pick who preps an order. And no longer GET /auth/staff-roster, which
      // this screen used from 2026-09-01 until Task 17: that endpoint is the
      // UNAUTHENTICATED lock-screen list, so it filters
      // `employee_code IS NOT NULL` — right for PIN entry, since no code means
      // no PIN login — and on live data that silently excluded all four of this
      // shop's `employee` accounts, the exact people who do the prep work.
      //
      // The endpoint returns everyone PUT /production/tasks/:id/assign accepts,
      // which is FIVE roles — it stays honest about what the server will take.
      // This screen offers THREE of them, and the difference is on purpose:
      //
      // `manager` and `owner` are genuinely assignable server-side (verified
      // live: both return 200 from the assign route). They are left out anyway.
      // The defect Task 17 fixed was people MISSING from this list — the
      // `employee_code` filter on the old staff-roster call was dropping the
      // shop's actual prep staff — not roles being absent by design. These three
      // are exactly what this modal has always offered; restoring them fixes the
      // bug completely. Making the owner assignable is a separate product
      // decision nobody has asked for, and a picker read at counter speed gets
      // worse with every name that is not the answer.
      //
      // So: do NOT "fix" this apparent inconsistency by widening it to five.
      // That is a deliberate change, and this comment is the reason it has not
      // happened yet. (The dashboard picker narrows further still, to
      // PREP_ROLES — counter staff can hold a task but do not make bouquets.)
      //
      // Filtering happens BEFORE the empty check below, never after. The other
      // order is a silent dead end: at a location staffed only by managers the
      // scoped call returns people, the fallback never fires, and the modal
      // renders an empty list with nothing explaining why. That is not
      // hypothetical — it is exactly what Test Loc looked like one commit ago.
      const onlyStaff = (rows) =>
        (Array.isArray(rows) ? rows : []).filter((p) => ASSIGNABLE_STAFF_ROLES.includes(p.role));
      const res = await api.getAssignableStaff(sale.location_id);
      let list = onlyStaff(res?.staff);
      // Same empty-scoped-list fallback the dashboard pickers use, for the same
      // reason: the location filter is a convenience, not a rule — the assign
      // endpoint itself accepts any active staff account regardless of
      // location. A shop whose staff have no user_locations row for it would
      // otherwise get "No employees found" and a dead end on the one action
      // this modal exists to perform. Flagged only when the wider call actually
      // returned people, and surfaced in the modal rather than applied quietly.
      if (list.length === 0 && sale.location_id) {
        const all = await api.getAssignableStaff();
        const allList = onlyStaff(all?.staff);
        if (allList.length > 0) {
          list = allList;
          setEmployeesShowingEveryone(true);
        }
      }
      setEmployees(list);
    } catch (err) {
      console.log('Failed to fetch employees:', err);
      setEmployees([]);
    } finally {
      setLoadingEmployees(false);
    }
  };

  const handleAssign = async (employeeId) => {
    try {
      await api.assignTask(assignTaskId, { assigned_to: employeeId });
      setAssignModalVisible(false);
      fetchSale();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to assign');
    }
  };

  const toggleItemExpand = (idx) => {
    setExpandedItems(prev => ({ ...prev, [idx]: !prev[idx] }));
  };

  const openConvertModal = (target) => {
    setConvertTarget(target);
    setConvertAddress(sale?.delivery_address || '');
    setConvertCharges(target === 'delivery' ? '' : '0');
    setConvertSenderName(sale?.sender_name || sale?.customer_name || '');
    setConvertSenderPhone(sale?.sender_phone || sale?.customer_phone || '');
    setConvertReceiverName(sale?.receiver_name || '');
    setConvertReceiverPhone(sale?.receiver_phone || '');
    setConvertSenderSameAsReceiver(!!sale?.sender_same_as_receiver);
    setConvertSenderAddress('');
    setConvertSavedAddresses([]);
    // Fetch saved addresses for the customer
    if (target === 'delivery' && sale?.customer_id) {
      api.getCustomerAddresses(sale.customer_id).then(res => {
        setConvertSavedAddresses(res.data || []);
      }).catch(() => { });
    }
    setConvertModalVisible(true);
  };

  const handleConvert = async () => {
    try {
      const data = { new_order_type: convertTarget };
      if (convertTarget === 'delivery') {
        if (!convertAddress?.trim()) {
          Alert.alert('Required', 'Delivery address is required');
          return;
        }
        if (!convertSenderName?.trim() || !convertSenderPhone?.trim()) {
          Alert.alert('Required', 'Sender name and phone are required');
          return;
        }
        if (!convertSenderSameAsReceiver && (!convertReceiverName?.trim() || !convertReceiverPhone?.trim())) {
          Alert.alert('Required', 'Receiver name and phone are required');
          return;
        }

        data.delivery_address = convertAddress;
        data.delivery_charges = parseFloat(convertCharges) || 0;
        data.sender_name = convertSenderName;
        data.sender_phone = convertSenderPhone;
        data.sender_same_as_receiver = convertSenderSameAsReceiver;
        data.receiver_name = convertSenderSameAsReceiver ? convertSenderName : convertReceiverName;
        data.receiver_phone = convertSenderSameAsReceiver ? convertSenderPhone : convertReceiverPhone;
        data.sender_address = convertSenderAddress || null;
        data.sender_address_label = null;
        data.receiver_address_label = null;
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

  const resolveItemLineTotal = useCallback((item) => {
    const qty = Number(item?.quantity) || 0;
    const unitPrice = Number(item?.unit_price) || 0;
    const base = qty * unitPrice;
    const taxFromField = Number(item?.tax_amount) || 0;
    const taxRate = Number(item?.tax_rate) || 0;
    const computedTax = taxFromField > 0 ? taxFromField : (base * taxRate / 100);
    const computed = base + computedTax;
    const stored = Number(item?.line_total);

    // Legacy rows may carry line_total=0; use computed amount in that case.
    if (!Number.isFinite(stored) || (stored <= 0 && computed > 0)) return computed;
    return stored;
  }, []);

  const generateReceipt = async () => {
    const paidAmt = (sale.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
    const dueAmt = Number(sale.grand_total || 0) - paidAmt;
    const receiptHtml = `
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
          <h2>Flower point</h2>
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
              <span>${item.quantity} x ₹${Number(item.unit_price || 0).toFixed(2)}</span>
              <span>₹${Number(resolveItemLineTotal(item)).toFixed(2)}</span>
            </div>
          </div>
        `).join('')}
        <div class="line"></div>
        <div class="row"><span>Subtotal</span><span>₹${Number(sale.subtotal || 0).toFixed(2)}</span></div>
        <div class="row"><span>Tax</span><span>₹${Number(sale.tax_total || 0).toFixed(2)}</span></div>
        ${sale.discount_amount > 0 ? `<div class="row"><span>Discount</span><span>-₹${Number(sale.discount_amount).toFixed(2)}</span></div>` : ''}
        ${sale.delivery_charges > 0 ? `<div class="row"><span>Delivery</span><span>₹${Number(sale.delivery_charges).toFixed(2)}</span></div>` : ''}
        <div class="line"></div>
        <div class="total-row"><span>TOTAL</span><span>₹${Number(sale.grand_total || 0).toFixed(2)}</span></div>
        <div class="line"></div>
        ${(sale.payments || []).map(p => `
          <div class="row"><span>${(p.method || '').toUpperCase()}</span><span>₹${Number(p.amount || 0).toFixed(2)}</span></div>
        `).join('')}
        ${dueAmt > 0.01 ? `<div class="row bold"><span>BALANCE DUE</span><span>₹${Number(dueAmt).toFixed(2)}</span></div>` : ''}
        <div class="line"></div>
        <div class="center"><p>Thank you for your purchase!</p></div>
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
        printHtmlOnWeb(receiptHtml, 'Receipt');
        return;
      }

      const { uri } = await Print.printToFileAsync({ html: receiptHtml, width: 300 });
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: `Receipt ${sale.sale_number}` });
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

  const paidAmount = (sale.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  const due = Number(sale.grand_total || 0) - paidAmount;

  // True only when display_stage.nextAction (server/utils/order-stage.js) is
  // the server's signal that this order's next step needs zero staff input —
  // Confirm Pickup / Mark Delivered. Single source shared by both the
  // "Complete Order" gate and the new inline quick-action button below it,
  // so the two conditions can never drift apart (Task 12 fix round,
  // 2026-09-01 — coordinator ruling: showing both at once for the same net
  // effect reintroduces the old multi-button confusion this redesign exists
  // to remove).
  const nextAction = sale.display_stage?.nextAction;
  const hasNoInputNextAction = nextAction?.label === 'Confirm Pickup' || nextAction?.label === 'Mark Delivered';

  // ── The two things that make PUT /api/sales/:id/status refuse 'completed' ──
  // Mirrors server/routes/sales.js's own guards, which were re-keyed 2026-09-02
  // OFF order_type and ONTO the data: "does this sale have an open delivery
  // row" and "is money owed on a non-delivery sale". This screen still carried
  // the old order_type-keyed copies, so two shapes rendered a Complete Order
  // button the endpoint now rejects with a raw 400: a pre_order fulfilled by
  // delivery (not order_type 'delivery', so the delivery guard never fired),
  // and an unpaid walk_in/pre_order (not order_type 'pickup', so the
  // take-the-money modal never opened).
  //
  // Deliberately NOT keyed on `nextAction == null`, which is the same signal
  // but strictly wider: an already-delivered delivery order whose sale is still
  // 'ready' also has a null nextAction (stage 'delivered'), yet completing it
  // is exactly what staff need to do and the endpoint accepts it. Hiding the
  // button there would delete real functionality, so these mirror the guards
  // themselves rather than the summary signal.
  //
  // Same decision resolveDeadEnd() makes for the dashboard card
  // (app/src/components/orderBoard/OrderCard.js) — mirrored rather than
  // imported, since that helper is card-shaped: it reads a flat list row
  // (delivery_id / delivery_status / delivery_partner_name / total_paid) while
  // this reads the nested sale.delivery object from GET /sales/:id.
  //
  // Labels, the failed-delivery branch and the who-can-assign role list are
  // kept identical on purpose so the two surfaces can never say different
  // things about one order. That claim was NOT true when it was first written:
  // resolveDeadEnd had no 'failed' branch, so a failed delivery read
  // "<rider> has it" on the dashboard while this screen said "Delivery Failed
  // — Send Again". Fixed on both sides 2026-09-02; if you change one branch
  // here, change its twin there in the same commit.
  const hasOpenDelivery = !!sale.delivery && !['delivered', 'cancelled'].includes(sale.delivery.status);
  // Deliveries are excluded: COD is collected by the rider at the door and
  // reconciled through settlements, so a delivery legitimately completes with a
  // balance outstanding — the backend guard carries the same exclusion.
  const balanceBlocksCompletion = due > 0.01 && !sale.is_credit_sale && sale.order_type !== 'delivery';
  const completionBlocked = hasOpenDelivery || balanceBlocksCompletion;
  // Delivery first when both apply: for a pre_order going out by delivery the
  // money is collected at the door, so the rider is genuinely the next step.
  const showCollectAction = sale.status === 'ready' && balanceBlocksCompletion && !hasOpenDelivery && canRecordPayment;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header card */}
      <View style={styles.headerCard}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.saleNumber}>{sale.sale_number}</Text>
            <Text style={styles.saleDate}>{formatDateTime(sale.created_at)}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {sale.channel ? (
              <View style={styles.channelBadge}>
                <Ionicons name={CHANNEL_ICONS[sale.channel] || 'ellipse'} size={12} color={Colors.textSecondary} />
                <Text style={styles.channelBadgeText}>{sale.channel.replace('_', ' ').toUpperCase()}</Text>
              </View>
            ) : null}
            {sale.priority === 'rush' ? (
              <View style={styles.rushBadge}>
                <Text style={styles.rushBadgeText}>🔥 Rush</Text>
              </View>
            ) : null}
            <StageBadge stage={sale.display_stage} />
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
          {canEdit && sale.status !== 'cancelled' && (
            <TouchableOpacity style={[styles.convertBtn, { marginRight: 6 }]} onPress={openEditModal}>
              <Ionicons name="pencil" size={14} color={Colors.primary} />
              <Text style={styles.convertBtnText}>Edit</Text>
            </TouchableOpacity>
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
      {(sale.order_type === 'delivery'
        ? (sale.sender_name || sale.sender_display_name || sale.customer_name || sale.customer_display_name)
        : (sale.customer_name || sale.customer_display_name)
      ) && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{sale.order_type === 'delivery' ? 'Sender' : 'Customer'}</Text>
            <Text style={styles.infoText}>
              {sale.order_type === 'delivery'
                ? (sale.sender_name || sale.sender_display_name || sale.customer_name || sale.customer_display_name)
                : (sale.customer_name || sale.customer_display_name)
              }
            </Text>
            {(sale.order_type === 'delivery'
              ? (sale.sender_phone || sale.sender_display_phone || sale.customer_phone || sale.customer_display_phone)
              : (sale.customer_phone || sale.customer_display_phone)
            ) && (
                <Text style={styles.infoSubtext}>
                  {sale.order_type === 'delivery'
                    ? (sale.sender_phone || sale.sender_display_phone || sale.customer_phone || sale.customer_display_phone)
                    : (sale.customer_phone || sale.customer_display_phone)
                  }
                </Text>
              )}
            {sale.order_type === 'delivery' && sale.sender_message ? (
              <Text style={styles.infoSubtext}>Message: {sale.sender_message}</Text>
            ) : null}
          </View>
        )}

      {sale.order_type === 'delivery' && (sale.receiver_name || sale.receiver_phone || sale.delivery?.customer_name || sale.delivery?.customer_phone || sale.delivery_address) && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Receiver</Text>
          {(sale.receiver_name || sale.receiver_display_name || sale.delivery?.customer_name) ? (
            <Text style={styles.infoText}>{sale.receiver_name || sale.receiver_display_name || sale.delivery?.customer_name}</Text>
          ) : null}
          {(sale.receiver_phone || sale.receiver_display_phone || sale.delivery?.customer_phone) ? (
            <Text style={styles.infoSubtext}>{sale.receiver_phone || sale.receiver_display_phone || sale.delivery?.customer_phone}</Text>
          ) : null}
          {sale.delivery_address ? <Text style={styles.infoSubtext}>{sale.delivery_address}</Text> : null}
        </View>
      )}

      {/* Delivery address — for delivery orders (non-pre-order) */}
      {sale.delivery_address && !sale.pre_order && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Delivery Address</Text>
          <Text style={styles.infoText}>{sale.delivery_address}</Text>
          {sale.scheduled_date && (
            <Text style={styles.infoSubtext}>Scheduled: {formatCardDateTime(sale.scheduled_date, sale.scheduled_time)}</Text>
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
          {sale.delivery.status === 'in_transit' && (sale.delivery.delivery_partner_id || sale.delivery.partner_id) && (
            <TouchableOpacity style={styles.liveLocationBtn} onPress={handleViewLivePartner}>
              <Ionicons name="locate-outline" size={16} color={Colors.primary} />
              <Text style={styles.liveLocationText}>View Live Location</Text>
            </TouchableOpacity>
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
          const itemTotal = resolveItemLineTotal(item);
          const canFulfill = !['cancelled', 'completed'].includes(sale.status)
            && item.product_id
            && !item.from_product_stock;
          const task = item.production_task;
          const parsedCustomMaterials = item.custom_materials && typeof item.custom_materials === 'string'
            ? (() => { try { return JSON.parse(item.custom_materials); } catch { return null; } })()
            : item.custom_materials;
          const hasCustomMaterials = parsedCustomMaterials && parsedCustomMaterials.length > 0;
          const hasMaterials = hasCustomMaterials || (item.materials && item.materials.length > 0);
          const isExpanded = expandedItems[idx];
          // Voice notes recorded against THIS item specifically (see the
          // Attachments section below for order-level notes, sale_item_id
          // IS NULL). The data already carried sale_item_id — this screen
          // just wasn't reading it, so every note showed in one flat list
          // at the bottom regardless of which item it was actually about
          // (found live, 2026-09-01 — the Dashboard task cards already got
          // this same fix in production.js the session before).
          const itemVoiceNotes = attachments.filter((a) => a.type === 'voice_note' && a.sale_item_id === item.id);
          return (
            <View key={idx} style={styles.itemRow}>
              <View style={{ flex: 1 }}>
                <TouchableOpacity onPress={() => hasMaterials && toggleItemExpand(idx)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  {/* Primary product image — prefer product_image, fallback to image_url */}
                  {(item.product_image || item.image_url) && (
                    <TouchableOpacity onPress={(e) => {
                      e.stopPropagation();
                      setViewedImage(api.getMediaUrl(item.product_image || item.image_url));
                    }}>
                      <Image source={{ uri: api.getMediaUrl(item.product_image || item.image_url) }} style={{ width: 48, height: 48, borderRadius: 8, marginRight: 6 }} />
                    </TouchableOpacity>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>{itemName}</Text>
                    <Text style={styles.itemMeta}>
                      {item.quantity} × ₹{Number(item.unit_price || 0).toFixed(2)}
                      {item.tax_rate > 0 ? ` (${item.tax_rate}% tax)` : ''}
                    </Text>
                    {item.special_instructions ? <Text style={{ fontSize: FontSize.xs, color: Colors.textLight, marginTop: 4 }}>Note: {item.special_instructions}</Text> : null}
                    {itemVoiceNotes.length > 0 && (
                      <View style={{ marginTop: 6, gap: 4 }}>
                        {itemVoiceNotes.map((att) => (
                          <AttachmentVoiceRow key={att.id} attachment={att} />
                        ))}
                      </View>
                    )}
                    {/* Show custom image_url only if different from product_image */}
                    {item.image_url && item.product_image && item.image_url !== item.product_image ? (
                      <TouchableOpacity onPress={(e) => { e.stopPropagation(); setViewedImage(api.getMediaUrl(item.image_url)); }} style={{ marginTop: 8 }}>
                        <Image source={{ uri: api.getMediaUrl(item.image_url) }} style={{ width: 60, height: 60, borderRadius: 6 }} />
                      </TouchableOpacity>
                    ) : null}
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
                    {!['completed', 'cancelled'].includes(sale.status) && !['completed', 'cancelled'].includes(task.status) && (
                      <View style={styles.taskActions}>
                        {task.status === 'pending' && (
                          <>
                            <TouchableOpacity style={styles.taskActionBtn} onPress={() => handleTaskAction(task.id, 'pick', 'pick up')}>
                              <Ionicons name="hand-left-outline" size={14} color={Colors.info} />
                              <Text style={[styles.taskActionText, { color: Colors.info }]}>Pick Up</Text>
                            </TouchableOpacity>
                            {canAssignTasks && (
                              <TouchableOpacity style={[styles.taskActionBtn, { backgroundColor: '#9C27B0' + '15' }]} onPress={() => openAssignModal(task.id)}>
                                <Ionicons name="person-add-outline" size={14} color="#9C27B0" />
                                <Text style={[styles.taskActionText, { color: '#9C27B0' }]}>Assign</Text>
                              </TouchableOpacity>
                            )}
                          </>
                        )}
                        {task.status === 'assigned' && (
                          <>
                            {canAssignTasks && (
                              <TouchableOpacity style={[styles.taskActionBtn, { backgroundColor: '#9C27B0' + '15' }]} onPress={() => openAssignModal(task.id)}>
                                <Ionicons name="swap-horizontal-outline" size={14} color="#9C27B0" />
                                <Text style={[styles.taskActionText, { color: '#9C27B0' }]}>Reassign</Text>
                              </TouchableOpacity>
                            )}
                            <TouchableOpacity style={[styles.taskActionBtn, { backgroundColor: '#00BCD4' + '15' }]} onPress={() => handleTaskAction(task.id, 'start', 'start')}>
                              <Ionicons name="play-outline" size={14} color="#00BCD4" />
                              <Text style={[styles.taskActionText, { color: '#00BCD4' }]}>Start</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={[styles.taskActionBtn, { backgroundColor: Colors.success + '15' }]} onPress={() => handleTaskAction(task.id, 'complete', 'complete')}>
                              <Ionicons name="checkmark-circle" size={14} color={Colors.success} />
                              <Text style={[styles.taskActionText, { color: Colors.success }]}>Complete</Text>
                            </TouchableOpacity>
                          </>
                        )}
                        {task.status === 'pending' && task.picked_by_name && (
                          <TouchableOpacity style={[styles.taskActionBtn, { backgroundColor: '#00BCD4' + '15' }]} onPress={() => handleTaskAction(task.id, 'start', 'start')}>
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
                    {hasCustomMaterials ? (
                      <>
                        <Text style={[styles.bomTitle, { color: Colors.primary }]}>Customized Materials:</Text>
                        {parsedCustomMaterials.map((mat, mIdx) => (
                          <View key={mIdx} style={styles.bomRow}>
                            <Text style={styles.bomName}>{mat.name || `Material #${mat.material_id}`}</Text>
                            <Text style={styles.bomQty}>{(mat.qty_per_unit || mat.qty || 1) * item.quantity}</Text>
                          </View>
                        ))}
                      </>
                    ) : (
                      <>
                        <Text style={styles.bomTitle}>Materials Required:</Text>
                        {item.materials.map((mat, mIdx) => (
                          <View key={mIdx} style={styles.bomRow}>
                            {mat.material_image && (
                              <TouchableOpacity onPress={(e) => { e.stopPropagation(); setViewedImage(api.getMediaUrl(mat.material_image)); }}>
                                <Image source={{ uri: api.getMediaUrl(mat.material_image) }} style={{ width: 20, height: 20, borderRadius: 4, marginRight: 4 }} />
                              </TouchableOpacity>
                            )}
                            <Text style={styles.bomName}>{mat.material_name}</Text>
                            <Text style={styles.bomQty}>{mat.qty_per_unit * item.quantity} {mat.unit}</Text>
                          </View>
                        ))}
                      </>
                    )}
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
                {item.tax_amount > 0 && <Text style={styles.itemTax}>incl. ₹{Number(item.tax_amount).toFixed(2)} tax</Text>}
                {canEdit && sale.status !== 'cancelled' && (
                  <TouchableOpacity style={styles.itemEditBtn} onPress={() => openItemEditModal(item)}>
                    <Ionicons name="pencil" size={13} color={Colors.primary} />
                  </TouchableOpacity>
                )}
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
        <View style={styles.totalRow}><Text style={styles.totalLabel}>Subtotal</Text><Text style={styles.totalVal}>₹{Number(sale.subtotal || 0).toFixed(2)}</Text></View>
        <View style={styles.totalRow}><Text style={styles.totalLabel}>Tax</Text><Text style={styles.totalVal}>₹{Number(sale.tax_total || 0).toFixed(2)}</Text></View>
        {sale.discount_amount > 0 && (
          <View style={styles.totalRow}>
            <Text style={[styles.totalLabel, { color: Colors.error }]}>Discount{sale.discount_type === 'percentage' ? ` (${sale.discount_percentage}%)` : ''}</Text>
            <Text style={[styles.totalVal, { color: Colors.error }]}>-₹{Number(sale.discount_amount).toFixed(2)}</Text>
          </View>
        )}
        {sale.delivery_charges > 0 && (
          <View style={styles.totalRow}><Text style={styles.totalLabel}>Delivery</Text><Text style={styles.totalVal}>₹{Number(sale.delivery_charges).toFixed(2)}</Text></View>
        )}
        <View style={styles.divider} />
        <View style={styles.totalRow}>
          <Text style={styles.grandLabel}>Grand Total</Text>
          <Text style={styles.grandVal}>₹{Number(sale.grand_total || 0).toFixed(2)}</Text>
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
            <Text style={styles.payAmount}>₹{Number(p.amount || 0).toFixed(2)}</Text>
          </View>
        ))}
        {due > 0.01 && (
          <View style={[styles.paymentRow, { backgroundColor: Colors.warningLight }]}>
            <Ionicons name="alert-circle" size={18} color={Colors.warning} />
            <Text style={[styles.payMethod, { marginLeft: Spacing.sm, color: Colors.warning }]}>Balance Due</Text>
            <Text style={[styles.payAmount, { color: Colors.warning }]}>₹{Number(due).toFixed(2)}</Text>
          </View>
        )}
      </View>

      {/* Refund Details */}
      {sale.refund && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Refund Details</Text>
          <View style={[styles.paymentRow, { backgroundColor: Colors.error + '10' }]}>
            <Ionicons name="return-down-back" size={18} color={Colors.error} />
            <View style={{ flex: 1, marginLeft: Spacing.sm }}>
              <Text style={[styles.payMethod, { color: Colors.error }]}>REFUNDED VIA {sale.refund.refund_method?.toUpperCase() || 'CASH'}</Text>
              {sale.refund.reason ? <Text style={styles.payRef}>Reason: {sale.refund.reason}</Text> : null}
              <Text style={[styles.payRef, { marginTop: 2, fontSize: FontSize.xs }]}>{formatDateTime(sale.refund.created_at)}</Text>
            </View>
            <Text style={[styles.payAmount, { color: Colors.error }]}>-₹{Number(sale.refund.amount || 0).toFixed(2)}</Text>
          </View>
        </View>
      )}

      {/* Pre-order info */}
      {sale.pre_order && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pre-order Details</Text>
          <Text style={styles.infoText}>Scheduled: {formatCardDateTime(sale.pre_order.scheduled_date, sale.pre_order.scheduled_time)}</Text>
          <Text style={styles.infoSubtext}>Advance: ₹{Number(sale.pre_order.advance_amount || 0).toFixed(2)} | Remaining: ₹{Number(sale.pre_order.remaining_amount || 0).toFixed(2)}</Text>
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
          <Text style={styles.infoText}>Amount: ₹{Number(sale.refund.amount || 0).toFixed(2)} via {sale.refund.refund_method}</Text>
          <Text style={styles.infoSubtext}>Reason: {sale.refund.reason}</Text>
        </View>
      )}

      {/* Notes */}
      {(sale.notes || sale.special_instructions) && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{sale.order_type === 'delivery' ? 'Special Comment' : 'Notes'}</Text>
          <Text style={styles.infoText}>{sale.notes || sale.special_instructions}</Text>
        </View>
      )}

      {/* Attachments (photos & voice notes) — fulfillment instructions, not
          sensitive pricing data, so viewing stays open to whoever can already
          view this screen (including customers). Adding attachments is
          owner/manager/employee-only server-side (POST /attachments), so the
          add controls are hidden for the customer role to avoid a dead 403. */}
      <View style={styles.section}>
        {/* Voice notes tied to one item (sale_item_id set) show with that
            item above instead of here — this section is general/order-wide
            notes only (sale_item_id IS NULL), so the count reflects what's
            actually listed below it rather than double-counting notes
            shown elsewhere (2026-09-01). */}
        {(() => {
          const photos = attachments.filter((a) => a.type === 'photo');
          const generalVoiceNotes = attachments.filter((a) => a.type === 'voice_note' && !a.sale_item_id);
          const hasItemNotes = attachments.some((a) => a.type === 'voice_note' && a.sale_item_id);
          return (
            <>
              <Text style={styles.sectionTitle}>Attachments ({photos.length + generalVoiceNotes.length})</Text>
              {hasItemNotes && (
                <Text style={[styles.infoSubtext, { marginBottom: Spacing.xs }]}>
                  Notes about a specific item are shown with that item above.
                </Text>
              )}

              {photos.length > 0 && (
                <View style={styles.attachmentPhotoRow}>
                  {photos.map((att) => (
                    <TouchableOpacity key={att.id} onPress={() => setViewedImage(api.getMediaUrl(att.file_url))}>
                      <Image source={{ uri: api.getMediaUrl(att.file_url) }} style={styles.attachmentThumb} />
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {generalVoiceNotes.map((att) => (
                <AttachmentVoiceRow key={att.id} attachment={att} />
              ))}

              {photos.length === 0 && generalVoiceNotes.length === 0 && (
                <Text style={styles.infoSubtext}>No general attachments yet.</Text>
              )}
            </>
          );
        })()}

        {!isCustomer && (
          <View style={{ marginTop: Spacing.sm, gap: Spacing.sm }}>
            <TouchableOpacity style={styles.addPhotoBtn} onPress={handlePickAttachmentPhoto} disabled={uploadingAttachment}>
              <Ionicons name="image-outline" size={16} color={Colors.primary} />
              <Text style={styles.addPhotoBtnText}>Add Photo</Text>
            </TouchableOpacity>
            <VoiceNoteRecorder onRecorded={handleVoiceNoteRecorded} />
            {uploadingAttachment && <ActivityIndicator color={Colors.primary} size="small" />}
          </View>
        )}
      </View>

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
          {canCancelOrRefund && (
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
          {canCancelOrRefund && (
            <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.error }]} onPress={handleCancel}>
              <Ionicons name="close-circle" size={18} color={Colors.white} />
              <Text style={styles.actionBtnText}>Cancel</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      {/* "Complete Order" is suppressed in two cases, both computed above near
          `due`. (1) hasNoInputNextAction — the dedicated "Confirm Pickup"/"Mark
          Delivered" button below covers the same net effect, and showing both
          reintroduces the multi-button confusion this redesign exists to remove
          (coordinator ruling, 2026-09-01). (2) completionBlocked — the server
          would refuse 'completed' outright, so the button was a guaranteed dead
          end; the block underneath offers the action that actually clears the
          blocker instead. Still renders for every 'ready' order the endpoint
          will accept, including an already-delivered delivery order whose sale
          is still 'ready' (null nextAction, nothing blocking — this button is
          the only way to finish it). */}
      {sale.status === 'ready' && !hasNoInputNextAction && !completionBlocked && (
        <View style={styles.actions}>
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.success, flex: 1 }]} onPress={() => handleStatusTransition('completed', 'Complete Order')}>
            <Ionicons name="checkmark-done-outline" size={18} color={Colors.white} />
            <Text style={styles.actionBtnText}>Complete Order</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── What to do INSTEAD, when finishing the order is blocked ──
          Never a dead end: whatever stops this order finishing gets exactly one
          button pointing at the screen that clears it, with the same wording the
          dashboard card uses (resolveDeadEnd in
          app/src/components/orderBoard/OrderCard.js) so one order never reads
          two different ways. When the blocker is not this person's job to clear,
          it says so in a sentence rather than offering a button that 403s.

          !hasNoInputNextAction (added 2026-09-02, review finding): a 'ready'
          sale whose delivery is assigned/picked_up/in_transit with no COD
          outstanding satisfies BOTH this gate and the one-tap gate below, so
          the screen rendered "…tap Delivery Status above to follow it" with a
          Mark Delivered button directly underneath contradicting it (live row
          INV-MAIN-20260606-002 is exactly this shape). This note is for the
          case where there is genuinely nothing to tap; whenever the server
          does offer a one-tap action, that action is the whole answer. */}
      {sale.status === 'ready' && completionBlocked && !hasNoInputNextAction && (
        <View style={styles.actions}>
          {hasOpenDelivery ? (
            /* A FAILED delivery cannot be "marked delivered" — PUT
               /deliveries/:id/deliver only accepts picked_up/in_transit. Its
               real recoveries are Reattempt or Cancel, both on DeliveryDetail,
               so it gets its own button rather than the rider sentence below.
               Checked first: a failed delivery normally still has a partner
               name attached, so it would otherwise fall into that sentence and
               tell staff to wait for something that can never happen. */
            sale.delivery.status === 'failed' ? (
              canManageDeliveries ? (
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: Colors.warning, flex: 1 }]}
                  onPress={() => navigation.navigate('DeliveryDetail', { deliveryId: sale.delivery.id })}
                >
                  <Ionicons name="refresh-outline" size={18} color={Colors.white} />
                  <Text style={styles.actionBtnText}>Delivery Failed — Send Again</Text>
                </TouchableOpacity>
              ) : (
                <View style={styles.blockedNote}>
                  <Ionicons name="alert-circle-outline" size={18} color={Colors.warning} />
                  <Text style={styles.blockedNoteText}>
                    This delivery came back undelivered. Counter staff will send it out again.
                  </Text>
                </View>
              )
            ) : sale.delivery.partner_name ? (
              <View style={styles.blockedNote}>
                <Ionicons name="bicycle-outline" size={18} color={Colors.info} />
                <Text style={styles.blockedNoteText}>
                  {sale.delivery.partner_name} has this order. It finishes on its own once the delivery is marked delivered — tap Delivery Status above to follow it.
                </Text>
              </View>
            ) : canManageDeliveries ? (
              <TouchableOpacity
                style={[styles.actionBtn, { backgroundColor: Colors.info, flex: 1 }]}
                onPress={() => navigation.navigate('DeliveryDetail', { deliveryId: sale.delivery.id })}
              >
                <Ionicons name="bicycle-outline" size={18} color={Colors.white} />
                <Text style={styles.actionBtnText}>Assign Rider</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.blockedNote}>
                <Ionicons name="bicycle-outline" size={18} color={Colors.info} />
                <Text style={styles.blockedNoteText}>
                  Waiting for a rider. Counter staff give this order to one, and it finishes once it is delivered.
                </Text>
              </View>
            )
          ) : showCollectAction ? (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: Colors.success, flex: 1 }]}
              onPress={() => openCollectPaymentModal(false)}
            >
              <Ionicons name="cash" size={18} color={Colors.white} />
              <Text style={styles.actionBtnText}>Collect {formatMoney(due)}</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.blockedNote}>
              <Ionicons name="cash-outline" size={18} color={Colors.warning} />
              <Text style={styles.blockedNoteText}>
                {formatMoney(due)} still to collect. Counter staff take the payment, then this order can be finished.
              </Text>
            </View>
          )}
        </View>
      )}

      {/* One-tap Confirm Pickup / Mark Delivered (Task 12, order-lifecycle
          plan, 2026-09-01) — rendered only for the two labels the server's
          display_stage.nextAction ever sends for the pickup/delivery
          "nothing left to collect" case (server/utils/order-stage.js). When
          a balance/COD is still outstanding, nextAction is null and this
          button doesn't render — the Delivery Status section above (taps
          through to DeliveryDetail) or the Complete Order button's own
          pay-balance modal (for pickup) remain the way to finish the order,
          same as before this task. */}
      {hasNoInputNextAction && (
        <TouchableOpacity
          style={[
            styles.actionBtn,
            { backgroundColor: Colors.success, alignSelf: 'stretch', marginHorizontal: 0, marginTop: Spacing.sm, minHeight: 44 },
            quickActionLoading && { opacity: 0.6 },
          ]}
          onPress={handleQuickAction}
          disabled={quickActionLoading}
        >
          {quickActionLoading ? (
            <ActivityIndicator color={Colors.white} size="small" />
          ) : (
            <>
              <Ionicons name="checkmark-done-outline" size={18} color={Colors.white} />
              <Text style={styles.actionBtnText}>{nextAction.label}</Text>
            </>
          )}
        </TouchableOpacity>
      )}

      {/* Actions for completed orders */}
      {canCancelOrRefund && sale.status === 'completed' && (
        <View style={styles.actions}>
          {!sale.refund && (
            <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.error }]} onPress={handleRefund}>
              <Ionicons name="arrow-undo" size={18} color={Colors.white} />
              <Text style={styles.actionBtnText}>Refund Sale</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.error }]} onPress={handleCancel}>
            <Ionicons name="close-circle" size={18} color={Colors.white} />
            <Text style={styles.actionBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Pay balance */}
      {sale.status !== 'cancelled' && due > 0.01 && canRecordPayment && !showCollectAction && (
        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: Colors.success, alignSelf: 'stretch', marginHorizontal: 0 }]}
          onPress={() => navigation.navigate('AddPayment', { saleId, due })}
        >
          <Ionicons name="cash" size={18} color={Colors.white} />
          <Text style={styles.actionBtnText}>Record Payment</Text>
        </TouchableOpacity>
      )}

      {/* History — owner/manager only, matches the backend's own restriction
          on GET /:id/audit-logs. Collapsed by default; audit log data was
          already fetched alongside the sale (see fetchSale) so expanding is
          instant. */}
      {canManage && (
        <View style={styles.section}>
          <TouchableOpacity
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
            onPress={() => setHistoryExpanded(prev => !prev)}
          >
            <Text style={styles.sectionTitle}>History{auditLogs.length > 0 ? ` (${auditLogs.length})` : ''}</Text>
            <Ionicons name={historyExpanded ? 'chevron-up' : 'chevron-down'} size={18} color={Colors.textLight} />
          </TouchableOpacity>

          {historyExpanded && (
            auditLogs.length === 0 ? (
              <Text style={[styles.infoSubtext, { marginTop: 6 }]}>No edits have been made to this order yet.</Text>
            ) : (
              auditLogs.map((log, idx) => {
                const changes = summarizeAuditChanges(log);
                const actionLabel = log.action === 'update' ? 'updated this order' : `made a change (${log.action}) to this order`;
                return (
                  <View key={log.id || idx} style={{ paddingVertical: 8, marginTop: idx === 0 ? 8 : 0, borderTopWidth: 1, borderTopColor: Colors.border }}>
                    <Text style={{ fontSize: FontSize.sm, color: Colors.text }}>
                      <Text style={{ fontWeight: '600' }}>{log.user_name || 'System'}</Text> {actionLabel} on {formatDateTime(log.created_at)}
                    </Text>
                    {changes.length > 0 ? (
                      <View style={{ marginTop: 4, gap: 2 }}>
                        {changes.map((c, cIdx) => (
                          <Text key={cIdx} style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>• {c}</Text>
                        ))}
                      </View>
                    ) : (
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textLight, marginTop: 4 }}>No item, address, or payment status changes in this edit.</Text>
                    )}
                  </View>
                );
              })
            )
          )}
        </View>
      )}

      {/* Navigation Shortcut */}
      <View style={{ marginTop: Spacing.xl, gap: Spacing.md }}>
        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: Colors.primary, paddingVertical: 16 }]}
          onPress={() => navigation.navigate('POS', { screen: 'QuickCheckout', params: { clearCart: true } })}
        >
          <Ionicons name="cart" size={20} color={Colors.white} />
          <Text style={[styles.actionBtnText, { fontSize: FontSize.md }]}>Return to Quick Checkout</Text>
        </TouchableOpacity>


        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, paddingVertical: 12 }]}
          onPress={() => navigation.navigate('Dashboard', { screen: 'DashboardHome' })}



        >
          <Ionicons name="home-outline" size={18} color={Colors.textSecondary} />
          <Text style={[styles.actionBtnText, { color: Colors.textSecondary }]}>Back to Dashboard</Text>
        </TouchableOpacity>
      </View>

      <View style={{ height: 60 }} />


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
                <Text style={styles.fieldLabel}>Sender Name *</Text>
                <TextInput
                  style={styles.modalInput}
                  value={convertSenderName}
                  onChangeText={setConvertSenderName}
                  placeholder="Sender name"
                  placeholderTextColor={Colors.textLight}
                />

                <Text style={styles.fieldLabel}>Sender Phone *</Text>
                <TextInput
                  style={styles.modalInput}
                  value={convertSenderPhone}
                  onChangeText={setConvertSenderPhone}
                  placeholder="Sender phone"
                  placeholderTextColor={Colors.textLight}
                  keyboardType="phone-pad"
                />

                <Text style={styles.fieldLabel}>Sender Address (optional)</Text>
                <TextInput
                  style={styles.modalInput}
                  value={convertSenderAddress}
                  onChangeText={setConvertSenderAddress}
                  placeholder="Sender address"
                  placeholderTextColor={Colors.textLight}
                  multiline
                />

                <TouchableOpacity style={styles.checkRow} onPress={() => setConvertSenderSameAsReceiver(!convertSenderSameAsReceiver)}>
                  <Ionicons name={convertSenderSameAsReceiver ? 'checkbox' : 'square-outline'} size={20} color={convertSenderSameAsReceiver ? Colors.primary : Colors.textLight} />
                  <Text style={styles.checkLabel}>Self Receive</Text>
                </TouchableOpacity>

                {!convertSenderSameAsReceiver && (
                  <>
                    <Text style={styles.fieldLabel}>Receiver Name *</Text>
                    <TextInput
                      style={styles.modalInput}
                      value={convertReceiverName}
                      onChangeText={setConvertReceiverName}
                      placeholder="Receiver name"
                      placeholderTextColor={Colors.textLight}
                    />

                    <Text style={styles.fieldLabel}>Receiver Phone *</Text>
                    <TextInput
                      style={styles.modalInput}
                      value={convertReceiverPhone}
                      onChangeText={setConvertReceiverPhone}
                      placeholder="Receiver phone"
                      placeholderTextColor={Colors.textLight}
                      keyboardType="phone-pad"
                    />
                  </>
                )}

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

      {/* Assign Employee Modal */}
      <Modal visible={assignModalVisible} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' }}>
          <View style={{ backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.lg, width: '85%', maxHeight: '60%' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.md }}>
              <Text style={{ fontSize: FontSize.lg, fontWeight: '700', color: Colors.text }}>Assign to Employee</Text>
              <TouchableOpacity onPress={() => setAssignModalVisible(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>
            {/* Only ever shown when the list is not the one someone would
                expect. Never on a normal scoped result. */}
            {!loadingEmployees && employeesShowingEveryone && employees.length > 0 && (
              <Text style={{ fontSize: FontSize.xs, lineHeight: 18, color: '#92400E', backgroundColor: Colors.warningLight, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginBottom: Spacing.sm }}>
                Nobody is set up at this shop — showing everyone.
              </Text>
            )}
            {loadingEmployees ? (
              <ActivityIndicator color={Colors.primary} size="large" style={{ padding: 20 }} />
            ) : employees.length === 0 ? (
              <Text style={{ color: Colors.textLight, textAlign: 'center', padding: 20 }}>
                No staff to assign yet. Ask the owner to add someone.
              </Text>
            ) : (
              <ScrollView>
                {employees.map(emp => (
                  <TouchableOpacity
                    key={emp.id}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.sm, borderBottomWidth: 1, borderBottomColor: Colors.border }}
                    onPress={() => handleAssign(emp.id)}
                  >
                    <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#9C27B0' + '15', justifyContent: 'center', alignItems: 'center' }}>
                      <Ionicons name="person" size={20} color="#9C27B0" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: FontSize.md, fontWeight: '600', color: Colors.text }}>{emp.name}</Text>
                      {/* Was `emp.phone`, which staff-roster never returned —
                          a subtitle that was always blank. The new endpoint
                          carries job_title and role, and the role is only ever
                          rendered through the shared plain-language map so
                          nobody is shown the token `florist_staff`. */}
                      {(emp.job_title || STAFF_ROLE_LABELS[emp.role]) && (
                        <Text style={{ fontSize: FontSize.xs, color: Colors.textLight }}>
                          {emp.job_title || STAFF_ROLE_LABELS[emp.role]}
                        </Text>
                      )}
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={Colors.textLight} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* Pickup Payment Modal */}
      <Modal visible={pickupPayModalVisible} transparent animationType="slide">
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{pickupPayCompletesOrder ? 'Take Payment & Finish Order' : 'Take Payment'}</Text>
              <TouchableOpacity onPress={() => setPickupPayModalVisible(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalSubtitle}>
              {sale.sale_number} — {sale.customer_name || sale.customer_display_name || 'Customer'}
            </Text>

            <View style={styles.balanceBox}>
              <Text style={styles.balanceLabel}>Remaining Balance</Text>
              <Text style={styles.balanceAmount}>₹{Number(due).toFixed(2)}</Text>
            </View>

            <ScrollView style={{ maxHeight: 300, marginBottom: Spacing.md }}>
              {pickupPayments.map((p, index) => (
                <View key={index} style={{ marginBottom: Spacing.md, padding: Spacing.sm, backgroundColor: Colors.background, borderRadius: BorderRadius.sm }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text style={styles.fieldLabel}>Payment {index + 1}</Text>
                    {pickupPayments.length > 1 && (
                      <TouchableOpacity onPress={() => removePickupPayment(index)}>
                        <Ionicons name="trash-outline" size={18} color={Colors.error} />
                      </TouchableOpacity>
                    )}
                  </View>
                  <TextInput style={[styles.modalInput, { marginBottom: Spacing.sm }]} value={p.amount} onChangeText={val => updatePickupPayment(index, 'amount', val)} keyboardType="numeric" placeholder="₹ Amount" />
                  <View style={styles.chipRow}>
                    {PAYMENT_METHODS.map(m => (
                      <TouchableOpacity key={m.key} style={[styles.methodChip, p.method === m.key && styles.methodChipActive]} onPress={() => updatePickupPayment(index, 'method', m.key)}>
                        <Text style={[styles.methodChipText, p.method === m.key && styles.methodChipTextActive]}>{m.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  {p.method !== 'cash' && (
                    <TextInput style={[styles.modalInput, { marginTop: Spacing.sm }]} value={p.reference_number} onChangeText={val => updatePickupPayment(index, 'reference_number', val)} placeholder="Reference / Transaction ID" />
                  )}
                </View>
              ))}

              <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md }} onPress={handleAddPickupPayment}>
                <Ionicons name="add-circle-outline" size={18} color={Colors.primary} />
                <Text style={{ color: Colors.primary, marginLeft: 4, fontWeight: '600', fontSize: FontSize.sm }}>Add Split Payment</Text>
              </TouchableOpacity>

              <Text style={styles.fieldLabel}>Write-off Amount (Optional)</Text>
              <TextInput style={styles.modalInput} value={pickupWriteOffAmount} onChangeText={setPickupWriteOffAmount} keyboardType="numeric" placeholder="₹ Small discrepancy amount" />
            </ScrollView>

            <TouchableOpacity
              style={[styles.confirmBtn, confirmingPickup && { opacity: 0.6 }]}
              onPress={handleConfirmPickupPayment}
              disabled={confirmingPickup}
            >
              {confirmingPickup ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle" size={20} color="#fff" />
                  <Text style={styles.confirmBtnText}>{pickupPayCompletesOrder ? 'Confirm Payment & Complete' : 'Confirm Payment'}</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      {/* Edit Sale Modal */}
      <Modal visible={editModalVisible} transparent animationType="slide">
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Edit Sale details</Text>
              <TouchableOpacity onPress={() => setEditModalVisible(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>

            {editError ? (
              <View style={{ backgroundColor: Colors.error + '20', padding: 12, borderRadius: 8, marginBottom: 16 }}>
                <Text style={{ color: Colors.error, fontSize: FontSize.sm }}>{editError}</Text>
              </View>
            ) : null}

            <ScrollView>
              <Text style={styles.fieldLabel}>Customer Name</Text>
              <TextInput
                style={styles.modalInput}
                value={editCustomerName}
                onChangeText={setEditCustomerName}
                placeholder="Customer name"
                placeholderTextColor={Colors.textLight}
              />

              <Text style={styles.fieldLabel}>Customer Phone</Text>
              <TextInput
                style={styles.modalInput}
                value={editCustomerPhone}
                onChangeText={setEditCustomerPhone}
                placeholder="Customer phone"
                placeholderTextColor={Colors.textLight}
                keyboardType="phone-pad"
              />

              <Text style={styles.fieldLabel}>Payment Method</Text>
              <View style={styles.chipRow}>
                {PAYMENT_METHODS.map(m => (
                  <TouchableOpacity
                    key={m.key}
                    style={[styles.methodChip, editPaymentMethod === m.key && styles.methodChipActive]}
                    onPress={() => setEditPaymentMethod(m.key)}
                  >
                    <Ionicons name={m.icon} size={16} color={editPaymentMethod === m.key ? '#fff' : Colors.textSecondary} />
                    <Text style={[styles.methodChipText, editPaymentMethod === m.key && styles.methodChipTextActive]}>{m.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.fieldLabel}>Payment Status</Text>
              <View style={styles.chipRow}>
                {['pending', 'paid'].map(status => (
                  <TouchableOpacity
                    key={status}
                    style={[styles.methodChip, editPaymentStatus === status && styles.methodChipActive]}
                    onPress={() => setEditPaymentStatus(status)}
                  >
                    <Text style={[styles.methodChipText, editPaymentStatus === status && styles.methodChipTextActive]}>
                      {status.toUpperCase()}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <TouchableOpacity
                style={[styles.confirmBtn, savingEdit && { opacity: 0.6 }]}
                onPress={handleSaveEdit}
                disabled={savingEdit}
              >
                {savingEdit ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons name="save" size={20} color="#fff" />
                    <Text style={styles.confirmBtnText}>Save Changes</Text>
                  </>
                )}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Item Edit Modal */}
      <Modal visible={itemEditModalVisible} transparent animationType="slide">
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Edit Item</Text>
              <TouchableOpacity onPress={() => setItemEditModalVisible(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>

            {editingItem ? (
              <Text style={styles.modalSubtitle}>{editingItem.product_name || editingItem.display_name || 'Item'}</Text>
            ) : null}

            {itemEditError ? (
              <View style={{ backgroundColor: Colors.error + '20', padding: 12, borderRadius: 8, marginBottom: 16 }}>
                <Text style={{ color: Colors.error, fontSize: FontSize.sm }}>{itemEditError}</Text>
              </View>
            ) : null}

            <Text style={styles.fieldLabel}>Quantity</Text>
            <TextInput
              style={styles.modalInput}
              value={editItemQuantity}
              onChangeText={setEditItemQuantity}
              keyboardType="numeric"
              placeholder="Quantity"
              placeholderTextColor={Colors.textLight}
            />

            <Text style={styles.fieldLabel}>Unit Price (₹)</Text>
            <TextInput
              style={styles.modalInput}
              value={editItemPrice}
              onChangeText={setEditItemPrice}
              keyboardType="numeric"
              placeholder="Unit price"
              placeholderTextColor={Colors.textLight}
            />

            <TouchableOpacity
              style={[styles.confirmBtn, savingItemEdit && { opacity: 0.6 }]}
              onPress={handleSaveItemEdit}
              disabled={savingItemEdit}
            >
              {savingItemEdit ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <Ionicons name="save" size={20} color="#fff" />
                  <Text style={styles.confirmBtnText}>Save Item</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <ImageModal visible={!!viewedImage} imageUrl={viewedImage} onClose={() => setViewedImage(null)} />

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
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  typeBadge: {
    paddingHorizontal: Spacing.sm, paddingVertical: 2, borderRadius: BorderRadius.full,
    backgroundColor: Colors.primary + '15',
  },
  typeText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.primary },
  payBadge: { paddingHorizontal: Spacing.sm, paddingVertical: 2, borderRadius: BorderRadius.full },
  payBadgeText: { fontSize: FontSize.xs, fontWeight: '700' },

  channelBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.sm, paddingVertical: 2, borderRadius: BorderRadius.full,
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
  },
  channelBadgeText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary },
  rushBadge: { paddingHorizontal: Spacing.sm, paddingVertical: 2, borderRadius: BorderRadius.full, backgroundColor: Colors.errorLight },
  rushBadgeText: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.error },

  section: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    borderWidth: 1, borderColor: Colors.border, padding: Spacing.md, marginTop: Spacing.md,
  },
  sectionTitle: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, marginBottom: Spacing.sm },
  infoText: { fontSize: FontSize.sm, color: Colors.text },
  infoSubtext: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },

  itemRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  itemName: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  itemMeta: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: 2 },
  itemTotal: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  itemTax: { fontSize: FontSize.xs, color: Colors.textLight },
  itemEditBtn: { marginTop: 6, padding: 5, borderRadius: BorderRadius.sm, backgroundColor: Colors.primary + '12' },
  stockBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  stockBadgeText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.success },
  fulfillBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, backgroundColor: Colors.primary + '15', paddingHorizontal: 8, paddingVertical: 4, borderRadius: BorderRadius.sm, alignSelf: 'flex-start' },
  fulfillBtnText: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.primary },
  liveLocationBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, alignSelf: 'flex-start', borderWidth: 1, borderColor: Colors.secondary + '40', backgroundColor: Colors.secondary + '10', paddingHorizontal: 12, paddingVertical: 8, borderRadius: BorderRadius.md },
  liveLocationText: { fontSize: FontSize.sm, color: Colors.secondary, fontWeight: '700' },

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

  // Attachments
  attachmentPhotoRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginBottom: Spacing.sm },
  attachmentThumb: { width: 64, height: 64, borderRadius: BorderRadius.sm },
  addPhotoBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1, borderColor: Colors.primary + '40', backgroundColor: Colors.primary + '10',
    paddingVertical: Spacing.sm, borderRadius: BorderRadius.md,
  },
  addPhotoBtnText: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.primary },

  blockedNote: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.md,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
  },
  blockedNoteText: { flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 19 },
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
  checkRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    marginTop: Spacing.sm,
  },
  checkLabel: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '600' },
  fieldLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginTop: Spacing.md, marginBottom: Spacing.xs },
  modalInput: { backgroundColor: Colors.background, borderRadius: BorderRadius.md, padding: Spacing.md, fontSize: FontSize.md, color: Colors.text, borderWidth: 1, borderColor: Colors.border },
  convertInfo: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.md, lineHeight: 20 },
  confirmBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: Colors.primary, paddingVertical: 14, borderRadius: BorderRadius.md, marginTop: Spacing.lg },
  confirmBtnText: { color: '#fff', fontSize: FontSize.md, fontWeight: '700' },

  // Pickup Modal Specifics
  modalSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.md },
  balanceBox: {
    backgroundColor: Colors.primary + '10', borderRadius: BorderRadius.md,
    padding: Spacing.md, alignItems: 'center', marginBottom: Spacing.md,
    borderWidth: 1, borderColor: Colors.primary + '30',
  },
  balanceLabel: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1 },
  balanceAmount: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.primary, marginTop: 4 },
  chipRow: { flexDirection: 'row', gap: Spacing.xs, marginBottom: Spacing.sm },
  methodChip: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, borderRadius: BorderRadius.full, backgroundColor: Colors.background,
    borderWidth: 1, borderColor: Colors.border,
  },
  methodChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  methodChipText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
  methodChipTextActive: { color: '#fff' },
});
