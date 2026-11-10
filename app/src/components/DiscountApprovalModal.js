/**
 * DiscountApprovalModal: counter staff typed a discount above what they may
 * give. A manager or the owner types their own code + PIN here and the order
 * is placed again with it (POST /sales discount_override). The PIN is sent
 * with that one request and never kept.
 *
 * <DiscountApprovalModal visible discountText="30% off" message busy error
 *   onApprove={(code, pin) => ...} onCancel={() => ...} />
 */
import React from 'react';
import { Modal, View, Text, ScrollView, StyleSheet } from 'react-native';
import OverridePad from './helper/OverridePad';
import { bumpActivity } from '../hooks/useIdleLock';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

export default function DiscountApprovalModal({ visible, discountText, message, busy, error, onApprove, onCancel }) {
  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={() => { if (!busy) onCancel(); }}>
      <View style={styles.backdrop}>
        <View style={styles.card} onTouchStart={bumpActivity}>
          <ScrollView keyboardShouldPersistTaps="handled">
            {message ? <Text style={styles.message}>{message}</Text> : null}
            <OverridePad
              approver="manager"
              discountText={discountText}
              busy={busy}
              error={error}
              onApprove={onApprove}
              onCancel={onCancel}
            />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', alignItems: 'center', padding: Spacing.md },
  card: { width: '100%', maxWidth: 440, maxHeight: '92%', backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md },
  message: { fontSize: FontSize.md, color: Colors.text, marginBottom: Spacing.sm, textAlign: 'center' },
});
