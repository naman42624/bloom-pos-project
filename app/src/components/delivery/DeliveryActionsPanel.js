import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, TextInput, ActivityIndicator, Image, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import DeliveryChecklist from '../DeliveryChecklist';
import AssignPickerModal from '../orderBoard/AssignPickerModal';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import { bumpActivity } from '../../hooks/useIdleLock';
import { printOrderSlip } from '../../utils/printHelpers';
import { showAlert, showConfirm } from '../../utils/alert';
import { getDeliveryActions, PRIMARY_ACTIONS, formatCodPrefill } from './deliveryActionRules';
import { Colors, FontSize, Spacing, BorderRadius } from '../../constants/theme';

// Every delivery-lifecycle action in one place, so Delivery Details and Sale
// Details can never offer different buttons for the same delivery. WHICH
// buttons show is decided only by deliveryActionRules.js (mirrors the server);
// this file never re-checks roles itself.
//
// Web note: a native Alert with buttons is a no-op on react-native-web, which is
// where the shop runs this app. Every question here goes through showConfirm
// and every message through showAlert (utils/alert.js).

// Primary (forward) actions: full-width coloured buttons. Colours kept from
// the old Delivery Details screen so riders see what they always saw.
const PRIMARY_META = {
  assign: { label: 'Assign Partner', icon: 'person-add', color: '#2196F3' },
  pickup: { label: 'Pick Up Order', icon: 'cube', color: '#9C27B0' },
  start: { label: 'Start Delivery', icon: 'bicycle', color: '#00BCD4' },
  deliver: { label: 'Mark Delivered', icon: 'checkmark-circle', color: '#4CAF50' },
  reattempt: { label: 'Reattempt Delivery', icon: 'refresh-circle', color: '#2196F3' },
};

// Secondary actions: smaller outlined buttons in a wrapping row.
const SECONDARY_META = {
  print: { label: 'Print Challan', icon: 'print-outline' },
  verify_load: { label: 'Verify Load', icon: 'checkbox-outline' },
  live_location: { label: 'View Live Location', icon: 'locate-outline' },
  fail: { label: 'Mark Failed', icon: 'close-circle-outline', danger: true },
  cancel: { label: 'Cancel Delivery', icon: 'ban-outline', danger: true },
  convert_payment: { label: 'Convert to Credit', icon: 'swap-horizontal' },
};

function DeliveryActionsPanel({ deliveryId, navigation, onChanged, compact = false }, ref) {
  const { user } = useAuth();
  const guard = useSubmitGuard();

  const [delivery, setDelivery] = useState(null);
  const [loadState, setLoadState] = useState('loading'); // 'loading' | 'ready' | 'error'

  const [actionLoading, setActionLoading] = useState(false);
  const [codAmount, setCodAmount] = useState('');
  const [codMethod, setCodMethod] = useState('cash');
  const [codRef, setCodRef] = useState('');
  const [failReason, setFailReason] = useState('');
  const [showCodForm, setShowCodForm] = useState(false);
  const [showFailForm, setShowFailForm] = useState(false);
  const [showCancelBox, setShowCancelBox] = useState(false);
  const [proofPhoto, setProofPhoto] = useState(null);
  const [assignModalVisible, setAssignModalVisible] = useState(false);
  const [partners, setPartners] = useState([]);
  const [partnersLoading, setPartnersLoading] = useState(false);
  const [assignLoading, setAssignLoading] = useState(false);
  const [checklistVisible, setChecklistVisible] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.getDelivery(deliveryId);
      setDelivery(res.data || null);
      setLoadState(res.data ? 'ready' : 'error');
    } catch (err) {
      console.error('Delivery actions load error:', err);
      setLoadState('error');
    }
  }, [deliveryId]);

  useImperativeHandle(ref, () => ({ refresh }), [refresh]);

  useEffect(() => {
    setLoadState('loading');
    refresh();
  }, [refresh]);

  // After every successful action: reload our own buttons, then let the host
  // screen reload its own data.
  const afterSuccess = async () => {
    setShowCodForm(false);
    setShowFailForm(false);
    setShowCancelBox(false);
    await refresh();
    onChanged?.();
  };

  // The server's messages are already plain language. Reloading afterwards
  // means that if the delivery moved on meanwhile (e.g. the rider already
  // marked it delivered), the buttons correct themselves.
  const afterFailure = async (err) => {
    showAlert('Could not update delivery', (err && err.message) || 'Please try again.');
    await refresh();
  };

  const takeProofPhoto = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        showAlert('Permission Required', 'Camera permission is needed for proof of delivery.');
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

  const doAction = async (action, data = {}) => {
    try {
      setActionLoading(true);
      if (action === 'pickup') await api.pickupDelivery(deliveryId);
      else if (action === 'in_transit') await api.markInTransit(deliveryId);
      else if (action === 'deliver') await api.deliverOrder(deliveryId, data);
      else if (action === 'fail') await api.failDelivery(deliveryId, data);
      await afterSuccess();
    } catch (err) {
      await afterFailure(err);
    } finally {
      setActionLoading(false);
    }
  };

  const openAssignModal = async () => {
    setPartners([]);
    setPartnersLoading(true);
    setAssignModalVisible(true);
    try {
      // GET /deliveries/partners, not GET /users (owner/manager-only) —
      // counter_staff can assign too (2026-09-01, sub-project 5).
      const res = await api.getDeliveryPartners(delivery?.location_id);
      const users = res.data?.users || res.data || [];
      setPartners(Array.isArray(users) ? users : []);
    } catch {
      setPartners([]);
    } finally {
      setPartnersLoading(false);
    }
  };

  const handleAssign = async (partnerId) => {
    try {
      setAssignLoading(true);
      await api.assignDelivery(deliveryId, { delivery_partner_id: partnerId });
      setAssignModalVisible(false);
      await afterSuccess();
    } catch (err) {
      setAssignModalVisible(false);
      await afterFailure(err);
    } finally {
      setAssignLoading(false);
    }
  };

  const handleViewLivePartner = () => {
    const partnerId = delivery?.delivery_partner_id || delivery?.partner_id;
    if (!partnerId) return;
    navigation.navigate('LiveDeliveryMap', {
      selectedPartnerId: partnerId,
      deliveryId,
    });
  };

  const handleConvertPayment = (action) => {
    if (!delivery) return;
    const msg = action === 'to_cod'
      ? 'Convert this credit order to Cash on Delivery?'
      : 'Convert this COD order to a Credit Sale? (Requires customer details)';

    const confirmConversion = async () => {
      setActionLoading(true);
      try {
        await api.convertDeliveryPayment(delivery.id, { action });
        await afterSuccess();
      } catch (err) {
        await afterFailure(err);
      } finally {
        setActionLoading(false);
      }
    };

    showConfirm('Confirm Conversion', msg, guard(confirmConversion), { confirmLabel: 'Convert' });
  };

  const handleDeliver = async () => {
    const data = {};
    if (delivery.cod_amount > 0) {
      const amt = parseFloat(codAmount);
      if (isNaN(amt) || amt < 0) {
        showAlert('Check the amount', 'Type the amount you collected from the customer, e.g. 500.');
        return;
      }
      data.cod_collected = amt;
      data.cod_method = codMethod;
      if (codMethod === 'upi' && codRef) data.cod_reference = codRef;
    }

    // Upload proof photo if taken. A failed upload never blocks the delivery.
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

    await doAction('deliver', data);
  };

  const handleFail = async () => {
    if (!failReason.trim()) {
      showAlert('Reason needed', 'Type why the delivery failed, e.g. "Customer not at home".');
      return;
    }
    await doAction('fail', { failure_reason: failReason.trim() });
  };

  const runReattempt = async () => {
    try {
      setActionLoading(true);
      await api.reattemptDelivery(deliveryId);
      await afterSuccess();
    } catch (err) {
      await afterFailure(err);
    } finally {
      setActionLoading(false);
    }
  };

  const cancelDeliveryOnly = async () => {
    try {
      setActionLoading(true);
      await api.cancelDelivery(deliveryId, { reason: 'Cancelled after failed delivery' });
      await afterSuccess();
    } catch (err) {
      await afterFailure(err);
    } finally {
      setActionLoading(false);
    }
  };

  const cancelDeliveryAndOrder = async () => {
    try {
      setActionLoading(true);
      await api.cancelDelivery(deliveryId, { reason: 'Cancelled after failed delivery' });
      await api.cancelSale(delivery.sale_id);
      await afterSuccess();
      showAlert('Cancelled', 'Delivery and order cancelled.');
    } catch (err) {
      await afterFailure(err);
    } finally {
      setActionLoading(false);
    }
  };

  const openDeliverForm = () => {
    if (delivery.cod_amount > 0) setCodAmount(formatCodPrefill(delivery.cod_amount, delivery.cod_collected));
    setShowFailForm(false);
    setShowCancelBox(false);
    setShowCodForm(true);
  };

  const onPressAction = (key) => {
    switch (key) {
      case 'assign': return guard(openAssignModal)();
      case 'pickup': return guard(() => doAction('pickup'))();
      case 'start': return guard(() => doAction('in_transit'))();
      case 'deliver': return openDeliverForm();
      case 'reattempt':
        return showConfirm(
          'Send it out again?',
          'The order goes back to "assigned" so a rider can take it again.',
          guard(runReattempt),
          { confirmLabel: 'Send again' },
        );
      case 'fail':
        setShowCodForm(false);
        setShowCancelBox(false);
        return setShowFailForm(true);
      case 'cancel':
        setShowCodForm(false);
        setShowFailForm(false);
        return setShowCancelBox(true);
      case 'verify_load': return setChecklistVisible(true);
      case 'live_location': return handleViewLivePartner();
      case 'convert_payment': return handleConvertPayment(delivery.is_credit_sale === 1 ? 'to_cod' : 'to_credit');
      case 'print': return guard(() => printOrderSlip(delivery.sale_id))();
      default: return undefined;
    }
  };

  // ---- Render ----

  if (loadState === 'loading' && !delivery) {
    return (
      <View style={styles.loadingRow}>
        <ActivityIndicator color={Colors.primary} />
      </View>
    );
  }

  if (loadState === 'error') {
    return (
      <TouchableOpacity
        style={styles.retryRow}
        onPress={() => { setLoadState('loading'); refresh(); }}
        accessibilityRole="button"
        activeOpacity={0.7}
      >
        <Ionicons name="refresh" size={18} color={Colors.textSecondary} />
        <Text style={styles.retryText}>Couldn't load delivery actions — tap to retry</Text>
      </TouchableOpacity>
    );
  }

  let actions = getDeliveryActions({ delivery, role: user?.role, userId: user?.id });
  if (!navigation?.getState?.()?.routeNames?.includes('LiveDeliveryMap')) {
    actions = actions.filter((k) => k !== 'live_location');
  }
  if (actions.length === 0) return null;

  const primaries = actions.filter((k) => PRIMARY_ACTIONS.has(k));
  const secondaries = actions.filter((k) => !PRIMARY_ACTIONS.has(k));
  const codRemaining = Number(delivery.cod_amount - (delivery.cod_collected || 0));

  const renderPrimary = (key, isFirst) => {
    const meta = PRIMARY_META[key];
    if (key === 'deliver' && showCodForm) return <View key={key}>{renderDeliverForm()}</View>;
    return (
      <TouchableOpacity
        key={key}
        style={[styles.primaryBtn, { backgroundColor: meta.color }, !isFirst && styles.primaryBtnFollow, actionLoading && styles.disabled]}
        onPress={() => onPressAction(key)}
        disabled={actionLoading}
        accessibilityRole="button"
        accessibilityState={{ disabled: actionLoading }}
        activeOpacity={0.8}
      >
        {actionLoading && isFirst ? <ActivityIndicator color={Colors.white} /> : <Ionicons name={meta.icon} size={22} color={Colors.white} />}
        <Text style={styles.primaryBtnText}>{meta.label}</Text>
      </TouchableOpacity>
    );
  };

  const renderDeliverForm = () => (
    <View style={styles.formBox}>
      <Text style={styles.formTitle}>Confirm Delivery</Text>
      {delivery.cod_amount > 0 && (
        <>
          <Text style={styles.label}>COD Amount to Collect (₹{codRemaining.toFixed(0)} remaining)</Text>
          <TextInput
            style={styles.input}
            value={codAmount}
            onChangeText={setCodAmount}
            keyboardType="decimal-pad"
            placeholder="Amount collected"
          />
          <View style={styles.methodRow}>
            {['cash', 'upi'].map((m) => (
              <TouchableOpacity
                key={m}
                style={[styles.methodBtn, codMethod === m && styles.methodBtnActive]}
                onPress={() => setCodMethod(m)}
                accessibilityRole="button"
                accessibilityState={{ selected: codMethod === m }}
              >
                <Text style={[styles.methodText, codMethod === m && styles.methodTextActive]}>{m.toUpperCase()}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {codMethod === 'upi' && (
            <TextInput style={styles.input} value={codRef} onChangeText={setCodRef} placeholder="UPI Reference" />
          )}
        </>
      )}
      <Text style={styles.formTitle}>Proof of Delivery (Photo)</Text>
      {proofPhoto ? (
        <View style={styles.photoPreview}>
          <Image source={{ uri: proofPhoto.uri }} style={styles.photo} />
          <TouchableOpacity onPress={() => setProofPhoto(null)} style={styles.removePhotoBtn} accessibilityRole="button">
            <Text style={styles.removePhotoText}>Remove photo</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.actionRow}>
          <TouchableOpacity style={[styles.formBtn, styles.photoBtn]} onPress={takeProofPhoto} accessibilityRole="button">
            <Ionicons name="camera" size={18} color={Colors.white} />
            <Text style={styles.formBtnText}>Take Photo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.formBtn, styles.galleryBtn]} onPress={pickProofPhoto} accessibilityRole="button">
            <Ionicons name="images" size={18} color={Colors.white} />
            <Text style={styles.formBtnText}>Gallery</Text>
          </TouchableOpacity>
        </View>
      )}
      <View style={styles.actionRow}>
        <TouchableOpacity style={[styles.formBtn, styles.backBtn]} onPress={() => setShowCodForm(false)} accessibilityRole="button">
          <Text style={styles.backBtnText}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.formBtn, { backgroundColor: PRIMARY_META.deliver.color }, actionLoading && styles.disabled]}
          onPress={guard(handleDeliver)}
          disabled={actionLoading}
          accessibilityRole="button"
        >
          {actionLoading ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.formBtnText}>Confirm Delivered</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <View>
      {!compact && <Text style={styles.heading}>Delivery actions</Text>}

      {primaries.map((key, i) => renderPrimary(key, i === 0))}

      {secondaries.length > 0 && (
        <View style={[styles.secondaryRow, primaries.length > 0 && styles.secondaryRowSpaced]}>
          {secondaries.map((key) => {
            const meta = SECONDARY_META[key];
            const label = key === 'convert_payment' && delivery.is_credit_sale === 1 ? 'Convert to COD' : meta.label;
            const tint = meta.danger ? Colors.error : Colors.primary;
            return (
              <TouchableOpacity
                key={key}
                style={[styles.secondaryBtn, { borderColor: tint }, actionLoading && styles.disabled]}
                onPress={() => onPressAction(key)}
                disabled={actionLoading}
                accessibilityRole="button"
                accessibilityState={{ disabled: actionLoading }}
                activeOpacity={0.7}
              >
                <Ionicons name={meta.icon} size={18} color={tint} />
                <Text style={[styles.secondaryBtnText, { color: tint }]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {showFailForm && actions.includes('fail') && (
        <View style={styles.formBox}>
          <Text style={styles.formTitle}>Why did the delivery fail?</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={failReason}
            onChangeText={setFailReason}
            placeholder="e.g. Customer not at home"
            multiline
          />
          <View style={styles.actionRow}>
            <TouchableOpacity style={[styles.formBtn, styles.backBtn]} onPress={() => setShowFailForm(false)} accessibilityRole="button">
              <Text style={styles.backBtnText}>Back</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.formBtn, styles.dangerBtn, actionLoading && styles.disabled]}
              onPress={guard(handleFail)}
              disabled={actionLoading}
              accessibilityRole="button"
            >
              {actionLoading ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.formBtnText}>Confirm Failed</Text>}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {showCancelBox && actions.includes('cancel') && (
        <View style={styles.formBox}>
          <Text style={styles.formTitle}>Cancel this delivery?</Text>
          <Text style={styles.label}>Cancel only the delivery, or the whole order too.</Text>
          <TouchableOpacity
            style={[styles.formBtn, styles.outlineBtn, actionLoading && styles.disabled]}
            onPress={guard(cancelDeliveryOnly)}
            disabled={actionLoading}
            accessibilityRole="button"
          >
            <Text style={styles.outlineBtnText}>Cancel delivery only</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.formBtn, styles.dangerBtn, styles.stackedBtn, actionLoading && styles.disabled]}
            onPress={guard(cancelDeliveryAndOrder)}
            disabled={actionLoading}
            accessibilityRole="button"
          >
            {actionLoading ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.formBtnText}>Cancel delivery and order</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={[styles.formBtn, styles.backBtn, styles.stackedBtn]} onPress={() => setShowCancelBox(false)} accessibilityRole="button">
            <Text style={styles.backBtnText}>Back</Text>
          </TouchableOpacity>
        </View>
      )}

      <AssignPickerModal
        visible={assignModalVisible}
        title="Who is delivering this?"
        notice={!partnersLoading && partners.length === 0 ? 'No riders at this location. Ask the owner to add one.' : null}
        people={partners.map((p) => ({ id: p.id, name: p.name, meta: `${p.active_delivery_count || 0} stop(s) today` }))}
        loading={partnersLoading || assignLoading}
        onPick={(person) => guard(() => handleAssign(person.id))()}
        onClose={() => setAssignModalVisible(false)}
      />

      <Modal visible={checklistVisible} animationType="slide" transparent onRequestClose={() => setChecklistVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.checklistModal} onTouchStart={bumpActivity}>
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>Verify Load</Text>
                <Text style={styles.modalSubtitle}>{delivery.sale_number} — check off each item as it goes in</Text>
              </View>
              <TouchableOpacity
                onPress={() => setChecklistVisible(false)}
                style={styles.closeBtn}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>
            <View style={{ padding: Spacing.md, flex: 1 }}>
              {checklistVisible && <DeliveryChecklist deliveryId={deliveryId} />}
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

export default forwardRef(DeliveryActionsPanel);

const styles = StyleSheet.create({
  heading: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: 10 },
  loadingRow: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  retryRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 44, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.md, backgroundColor: Colors.surfaceAlt, borderWidth: 1, borderColor: Colors.border },
  retryText: { flex: 1, fontSize: FontSize.md, color: Colors.textSecondary, fontWeight: '600' },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 52, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.md, gap: Spacing.sm },
  primaryBtnFollow: { marginTop: Spacing.sm },
  primaryBtnText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.md },
  secondaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  secondaryRowSpaced: { marginTop: Spacing.md },
  secondaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.md, borderWidth: 1, backgroundColor: Colors.surface },
  secondaryBtnText: { fontSize: FontSize.sm, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  formBox: { backgroundColor: Colors.background, borderRadius: BorderRadius.md, padding: Spacing.md, marginTop: Spacing.sm },
  formTitle: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginBottom: Spacing.sm },
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.xs },
  input: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md, minHeight: 44, paddingHorizontal: 10, paddingVertical: Spacing.sm, fontSize: FontSize.md, color: Colors.text, marginBottom: Spacing.sm },
  multiline: { height: 80, textAlignVertical: 'top' },
  methodRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.sm },
  methodBtn: { flex: 1, minHeight: 44, justifyContent: 'center', borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, alignItems: 'center', backgroundColor: Colors.surface },
  methodBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  methodText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  methodTextActive: { color: Colors.white },
  photoPreview: { alignItems: 'center', marginBottom: Spacing.sm },
  photo: { width: 200, height: 150, borderRadius: BorderRadius.sm },
  removePhotoBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.md },
  removePhotoText: { color: Colors.error, fontSize: FontSize.sm, fontWeight: '600' },
  actionRow: { flexDirection: 'row', gap: 10, marginTop: Spacing.sm },
  formBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 48, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.md, gap: Spacing.sm },
  formBtnText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.md },
  photoBtn: { backgroundColor: '#9C27B0' },
  galleryBtn: { backgroundColor: Colors.textSecondary },
  backBtn: { backgroundColor: Colors.border },
  backBtnText: { color: Colors.text, fontWeight: '700', fontSize: FontSize.md },
  dangerBtn: { backgroundColor: Colors.error },
  outlineBtn: { flex: 0, borderWidth: 1, borderColor: Colors.error, backgroundColor: Colors.surface, marginTop: Spacing.sm },
  outlineBtnText: { color: Colors.error, fontWeight: '700', fontSize: FontSize.md },
  stackedBtn: { flex: 0, marginTop: Spacing.sm },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  checklistModal: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, height: '80%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  modalSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  closeBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
