/**
 * SavedAddressChips — one-tap saved delivery addresses for a customer.
 * Driven purely by props: refetches whenever customerId / receiverId change.
 * Receiver addresses come first, defaults first within each group.
 * Renders nothing when there is nothing to offer.
 *
 * Usage: <SavedAddressChips customerId={customerId} receiverId={receiverId} onPick={setAddress} />
 */
import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import api from '../services/api';
import { sameAddress, addressText } from '../utils/addressMatch';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

async function fetchRows(id) {
  if (!id) return [];
  try {
    const res = await api.getCustomerAddresses(id);
    const rows = Array.isArray(res?.data) ? res.data : [];
    // Server sorts default first already; keep it stable regardless.
    return [...rows].sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0));
  } catch {
    return [];
  }
}

// After an order is created: remember the delivery address on the profile if
// it is new. Never throws, never blocks the order.
export async function saveAddressBack(targetId, text) {
  try {
    const clean = (text || '').trim();
    if (!targetId || !clean) return;
    const rows = await fetchRows(targetId);
    if (rows.some((r) => sameAddress(addressText(r), clean))) return;
    await api.addCustomerAddress(targetId, { label: 'Saved from order', address: clean, address_line_1: clean });
  } catch (err) {
    console.warn('Could not save address back to customer:', err?.message || err);
  }
}

export default function SavedAddressChips({ customerId, receiverId, onPick }) {
  const [chips, setChips] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = [];
      if (receiverId) ids.push(receiverId);
      if (customerId && customerId !== receiverId) ids.push(customerId);
      const groups = await Promise.all(ids.map(fetchRows));
      if (cancelled) return;
      const out = [];
      groups.flat().forEach((r) => {
        const text = addressText(r);
        if (text && !out.some((c) => sameAddress(c.text, text))) {
          out.push({ key: `${r.customer_id}-${r.id}`, label: r.label, text });
        }
      });
      setChips(out);
    })();
    return () => { cancelled = true; };
  }, [customerId, receiverId]);

  if (chips.length === 0) return null;

  return (
    <View style={{ marginBottom: Spacing.sm }}>
      <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, marginBottom: Spacing.xs }}>
        Tap a saved address
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {chips.map((c) => (
          <TouchableOpacity
            key={c.key}
            onPress={() => onPick(c.text)}
            accessibilityRole="button"
            accessibilityLabel={`Use saved address ${c.label || ''} ${c.text}`}
            style={{
              minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs,
              marginRight: Spacing.sm, marginBottom: Spacing.sm, maxWidth: '100%',
              borderRadius: BorderRadius.lg, borderWidth: 1, borderColor: Colors.primary, backgroundColor: Colors.surface || '#fff',
            }}
          >
            {!!c.label && <Text style={{ fontSize: FontSize.xs, color: Colors.primary, fontWeight: '700' }}>{c.label}</Text>}
            <Text numberOfLines={2} style={{ fontSize: FontSize.md, color: Colors.text }}>{c.text}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}
