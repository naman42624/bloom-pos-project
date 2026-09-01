import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { FONT_FAMILY } from '../constants/orderDisplay';

/**
 * Renders a sale's server-computed stage — display_stage.label and .color from
 * server/utils/order-stage.js.
 *
 * This is a component rather than a copied <View> on purpose: it is rendered by
 * the order card, OrderQuickModal, SaleDetailScreen, OrdersInboxScreen and
 * DeliveriesScreen, and the single-source-of-truth property the stage model
 * exists to provide only holds if there is exactly one place that decides how a
 * stage looks.
 *
 * Never derive a stage here from status/payment_status/pickup_status/
 * delivery_status. If `stage` is missing, render nothing and let the caller's
 * layout collapse — a wrong stage is worse than no stage.
 *
 * See docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md §4.
 */
export default function StageBadge({ stage, size = 'md' }) {
  if (!stage || !stage.label) return null;
  const color = stage.color || '#9CA3AF';
  const small = size === 'sm';
  return (
    <View
      style={[
        styles.badge,
        small && styles.badgeSmall,
        { backgroundColor: color + '18', borderColor: color },
      ]}
    >
      <Text style={[styles.text, small && styles.textSmall, { color }]} numberOfLines={1}>
        {stage.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  badgeSmall: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  text: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: FONT_FAMILY,
  },
  textSmall: {
    fontSize: 11,
  },
});
