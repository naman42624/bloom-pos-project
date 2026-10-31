/**
 * OpenRegisterSheet — shown when staff try to take cash with the register
 * closed. Instead of sending them to the Cash Register screen and back, it
 * opens the register right here and then carries on with what they were doing.
 *
 *   Register is closed
 *   Cash in the drawer now (₹) [ 2000 ]
 *   [ Open register & place order ]     <- primary
 *   [ Save as draft for later ]         <- only when onSaveDraft is given
 *
 * The opening cash is pre-filled with the count from the last time the
 * register was closed today, when there is one.
 *
 * Props: visible, locationId, actionLabel ('place order'), onClose(),
 *        onOpened()  — register is open now; carry on,
 *        onSaveDraft() (optional)
 *
 * OpenRegisterForm is the same content without the pop-up, for a panel that
 * is already open (the Collect dues panel swaps to it in place). It also
 * takes onBack + backLabel for a "go back" link under the buttons.
 */
import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import useSubmitGuard from '../hooks/useSubmitGuard';
import { bumpActivity } from '../hooks/useIdleLock';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const money = (n) => Number(n || 0).toFixed(2).replace(/\.00$/, '');

export default function OpenRegisterSheet({ visible, locationId, actionLabel = 'place order', onClose, onOpened, onSaveDraft }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}>
        <View onTouchStart={bumpActivity} style={{
          backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg,
          padding: Spacing.lg, paddingBottom: Spacing.xl, width: '100%', maxWidth: 560, alignSelf: 'center',
        }}>
          {visible && (
            <OpenRegisterForm
              locationId={locationId}
              actionLabel={actionLabel}
              onClose={onClose}
              onOpened={onOpened}
              onSaveDraft={onSaveDraft}
            />
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// Mounted fresh each time it is shown, so it starts from a clean slate.
export function OpenRegisterForm({ locationId, actionLabel = 'place order', onClose, onOpened, onSaveDraft, onBack, backLabel = 'Back' }) {
  const [cash, setCash] = useState('');
  const [lastCount, setLastCount] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (locationId) {
      api.getRegisterStatus(locationId).then((res) => {
        const last = (res?.todaySessions || []).find((s) => s.closed_at && s.actual_cash != null);
        if (!cancelled && last) {
          setLastCount(Number(last.actual_cash));
          setCash(money(last.actual_cash));
        }
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [locationId]);

  const amount = parseFloat(cash);
  const valid = cash.trim() !== '' && Number.isFinite(amount) && amount >= 0;

  const guard = useSubmitGuard();
  const openAndContinue = guard(async () => {
    if (!valid) { setError('Count the cash in the drawer and type it here (0 if empty).'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await api.openRegister({ location_id: locationId, opening_balance: Math.round(amount * 100) / 100 });
      if (res && res.success === false) throw new Error(res.message);
      setSaving(false);
      onOpened && onOpened();
    } catch (err) {
      setSaving(false);
      setError(err?.message ? `Could not open the register: ${err.message}` : 'Could not open the register. Check the connection and try again.');
    }
  });

  return (
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flex: 1 }}>
              <Ionicons name="lock-closed" size={22} color={Colors.error} />
              <Text style={{ fontSize: FontSize.lg, fontWeight: '800', color: Colors.text }}>Register is closed</Text>
            </View>
            <TouchableOpacity onPress={onClose} accessibilityLabel="Close" style={{ minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' }}>
              <Ionicons name="close" size={26} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: FontSize.md, color: Colors.textSecondary, marginTop: 4 }}>
            Open it here to take cash. Nothing you entered is lost.
          </Text>

          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: Spacing.md, marginBottom: 4 }}>
            Cash in the drawer now (₹)
          </Text>
          <TextInput
            style={{
              minHeight: 52, borderWidth: 1, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md,
              fontSize: FontSize.lg, fontWeight: '700', color: Colors.text,
              borderColor: error ? Colors.error : Colors.border,
            }}
            keyboardType="numeric"
            value={cash}
            onChangeText={(t) => { setCash(t.replace(/[^0-9.]/g, '')); setError(''); }}
            placeholder="Count the drawer, e.g. 2000"
            placeholderTextColor={Colors.textLight}
            autoFocus={lastCount == null}
            accessibilityLabel="Cash in the drawer now"
          />
          {lastCount != null && !error && (
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 }}>
              Filled in from the last close today (₹{money(lastCount)}). Change it if the drawer has a different amount.
            </Text>
          )}
          {!!error && <Text style={{ color: Colors.error, fontSize: FontSize.sm, marginTop: 4 }}>{error}</Text>}

          <TouchableOpacity
            onPress={openAndContinue}
            disabled={saving}
            accessibilityRole="button"
            style={{
              marginTop: Spacing.lg, minHeight: 56, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center',
              backgroundColor: valid ? Colors.success : Colors.border, flexDirection: 'row', gap: 8,
            }}
          >
            {saving
              ? <ActivityIndicator color={Colors.white} />
              : <>
                  <Ionicons name="lock-open" size={20} color={Colors.white} />
                  <Text style={{ color: Colors.white, fontSize: FontSize.lg, fontWeight: '800' }}>Open register & {actionLabel}</Text>
                </>}
          </TouchableOpacity>

          {onSaveDraft && (
            <TouchableOpacity
              onPress={onSaveDraft}
              disabled={saving}
              accessibilityRole="button"
              style={{
                marginTop: Spacing.sm, minHeight: 52, borderRadius: BorderRadius.md, alignItems: 'center', justifyContent: 'center',
                borderWidth: 1, borderColor: Colors.border, flexDirection: 'row', gap: 8,
              }}
            >
              <Ionicons name="document-text-outline" size={20} color={Colors.primary} />
              <Text style={{ color: Colors.primary, fontSize: FontSize.md, fontWeight: '700' }}>Save as draft for later</Text>
            </TouchableOpacity>
          )}

          {onBack && (
            <TouchableOpacity
              onPress={onBack}
              disabled={saving}
              accessibilityRole="button"
              style={{ marginTop: Spacing.sm, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ color: Colors.textSecondary, fontSize: FontSize.md, fontWeight: '600' }}>{backLabel}</Text>
            </TouchableOpacity>
          )}
        </View>
  );
}
