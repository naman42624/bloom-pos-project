import React from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Colors } from '../../constants/theme';
import { FONT_FAMILY } from '../../constants/orderDisplay';
import RoutePicker from '../RoutePicker';

/**
 * Bulk route (re)assignment — the Assign Route counterpart to
 * AssignPickerModal's Assign Rider flow (same screen, same batch-select
 * mechanism, see docs/superpowers/specs/2026-09-11-deliveries-bulk-actions-
 * design.md). Fully controlled: the screen owns `routeId` and `warning`
 * (the overwrite check needs the current selection's own route_id values,
 * which live in the screen's data, not in here) — this component only
 * renders RoutePicker plus a confirm button.
 */
export default function RouteAssignModal({ visible, deliveryCount, routeId, onChangeRoute, warning, locationId, confirming, onConfirm, onClose }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>
            {deliveryCount > 1 ? `Assign Route — ${deliveryCount} Deliveries` : 'Assign Route'}
          </Text>
          {warning ? <Text style={styles.notice}>{warning}</Text> : null}
          <RoutePicker value={routeId} onChange={onChangeRoute} locationId={locationId} />
          <TouchableOpacity
            style={[styles.confirm, (!routeId || confirming) && styles.confirmDisabled]}
            onPress={onConfirm}
            disabled={!routeId || confirming}
            activeOpacity={0.7}
          >
            {confirming
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.confirmText}>{`Apply to ${deliveryCount} deliver${deliveryCount === 1 ? 'y' : 'ies'}`}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancel} onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#00000055', justifyContent: 'center', padding: 20 },
  sheet: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 16, maxWidth: 420, width: '100%', alignSelf: 'center' },
  title: { fontSize: 17, fontWeight: '800', color: Colors.text, fontFamily: FONT_FAMILY, marginBottom: 10 },
  notice: { fontSize: 13, lineHeight: 18, color: '#92400E', backgroundColor: Colors.warningLight, fontFamily: FONT_FAMILY, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 10 },
  confirm: { minHeight: 44, backgroundColor: Colors.primary, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  confirmDisabled: { backgroundColor: Colors.border },
  confirmText: { fontSize: 15, fontWeight: '700', color: '#fff', fontFamily: FONT_FAMILY },
  cancel: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  cancelText: { fontSize: 15, fontWeight: '700', color: Colors.textSecondary, fontFamily: FONT_FAMILY },
});
