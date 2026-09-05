import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import api from '../../services/api';
import { showAlert } from '../../utils/alert';
import { Colors } from '../../constants/theme';
import { FONT_FAMILY } from '../../constants/orderDisplay';
import { STAGE_COLUMNS, TYPE_FILTERS, columnKeyForStage, isClosedStage } from '../../constants/orderStages';
import useBreakpoint from '../../hooks/useBreakpoint';
import StageColumn from './StageColumn';
import OrderCard from './OrderCard';

/**
 * The unified Stage board.
 *
 * Replaces components/OrderKanbanBoard.js, which grouped by order type first
 * and nested status lanes inside each type — four stacked mini-boards. That
 * nesting was the structural source of the "cluttered" feel, and it rendered
 * as one narrow mobile column at any viewport width because the old file
 * computed a desktop breakpoint and used it only to change how many cards
 * previewed, never the layout.
 *
 * Here: one board, columns are the Stage (from display_stage.key), and order
 * type is a filter chip plus a per-card icon.
 *
 * CALLER CONSTRAINT — staff surfaces only. This board must not be rendered on
 * a delivery-rider or customer surface. OrderCard duplicates no server
 * authorization decision — that is the anti-pattern this redesign exists to
 * remove, and display_stage.nextAction carries the server's decision about
 * every *action*. Its one exception is `viewerRole`, threaded through this
 * component and used ONLY to decide routing button vs status line for each of
 * the three screens a card can send someone to (delivery detail, add payment,
 * settlements) — see resolveDeadEnd's own note for why nextAction cannot
 * cover a destination screen. Pass it; without it every routing button
 * degrades to a status line, which is safe but tells staff less than they
 * need.
 *
 * `viewerId` is the same idea for identity rather than permission (Task 15):
 * the card needs to know WHO is looking to self-assign Start Preparing in one
 * tap and to say "You're on it" instead of repeating the person's own name
 * back at them. It grants nothing — every write it feeds is still authorized
 * server-side. Without it, self-assign falls back to the picker and the
 * preparer line shows the name; both safe.
 *
 * What actually enforces that, precisely — because the Dashboard tab itself
 * has NO role gate (MainNavigator.js:623 registers it for every role; the
 * `delivery_partner` block at :700 *adds* a Deliveries tab, it does not
 * redirect):
 *   - Riders are excluded by DashboardScreen.js's own `isDeliveryPartner ?`
 *     branch, which renders a rider view instead of this board.
 *   - Customers are excluded by its `isCustomer ?` branch, added in Task 8.
 *     Before that, `role === 'customer'` matched none of the role tests and
 *     fell through to the owner/manager branch that renders this board. That
 *     same task also stops fetchDashboard from requesting shop-wide sales for
 *     a customer at all, so the exclusion covers the data, not just the UI.
 *
 * Both exclusions live in ONE file's render chain, and neither is enforced by
 * the navigator or by this component. So do not read this as "already safe":
 * confirm the exclusion holds before wiring this board onto any new surface.
 *
 * See docs/superpowers/specs/2026-09-01-dashboard-stage-ui-redesign-design.md §3, §5.
 */
export default function OrderKanbanBoard({
  sales,
  onOrderPress,
  onResolveAction,
  onNavigateToDone,
  onShowAll,
  tasksBySaleId,
  timezone,
  viewerRole,
  viewerId,
  onRefresh,
}) {
  const { isWide } = useBreakpoint();
  const [typeFilter, setTypeFilter] = useState('all');
  const [collapsed, setCollapsed] = useState({});
  const [quickActionLoading, setQuickActionLoading] = useState({});
  const effectiveTimezone = timezone || 'Asia/Kolkata';

  // `extraBody` is passed only by OrderCard's self-assign branch, and only
  // ever as `{ assigned_to }` on the Start Preparing action — the one
  // transition PUT /sales/:id/status acts on it for. The card owns that gate;
  // this just forwards it (see api.advanceOrder).
  const handleQuickAction = useCallback(async (order, extraBody) => {
    const nextAction = order?.display_stage?.nextAction;
    if (!nextAction) return;
    setQuickActionLoading((prev) => ({ ...prev, [order.id]: true }));
    let advanced = false;
    try {
      await api.advanceOrder(nextAction, extraBody);
      advanced = true;
    } catch (err) {
      // The backend's guard messages are already plain language
      // (server/routes/sales.js) — pass them straight through rather than
      // wrapping them in something more technical.
      showAlert('Order Update', err?.message || 'Unable to update this order.');
    }

    // Refresh deliberately OUTSIDE that try/catch. If the advance succeeded but
    // the refetch failed, the order really did move — telling the person at the
    // counter "Unable to update this order." would be a lie that makes them
    // redo a done action. Worst case here is a stale board until the next
    // refresh, which is recoverable and silent.
    if (advanced && onRefresh) {
      try {
        await onRefresh();
      } catch (refreshErr) {
        // Swallowed on purpose — see above. Nothing actionable for the user.
      }
    }

    // Both awaits above are individually caught, so nothing throws past them
    // and this always runs; it stays last so the card keeps its spinner until
    // the refreshed data has actually landed.
    setQuickActionLoading((prev) => ({ ...prev, [order.id]: false }));
  }, [onRefresh]);

  const { columns, doneCount } = useMemo(() => {
    const buckets = STAGE_COLUMNS.reduce((acc, c) => { acc[c.key] = []; return acc; }, {});
    let done = 0;
    const list = (sales || []).filter(
      (s) => typeFilter === 'all' || s.order_type === typeFilter
    );
    list.forEach((sale) => {
      const stageKey = sale.display_stage?.key;
      if (!stageKey) return;
      if (isClosedStage(stageKey)) { done++; return; }
      const columnKey = columnKeyForStage(stageKey);
      if (!columnKey) {
        // Not closed (checked above) and not mapped to a column: a stage key
        // the server emits that this board has never heard of. Without this
        // line the order would vanish from the board with no signal at all —
        // and constants/orderStages.js's CLOSED_STAGE_KEYS comment explicitly
        // promises the board logs exactly this case.
        console.warn(
          `[OrderKanbanBoard] Unmapped display_stage key "${stageKey}" on sale ${sale.id} — `
          + 'this order is not shown on the board. Add the key to STAGE_COLUMNS or '
          + 'CLOSED_STAGE_KEYS in constants/orderStages.js.'
        );
        return;
      }
      buckets[columnKey].push(sale);
    });
    // Oldest first within a column, so nothing quietly ages out at the bottom.
    // Deliberately NOT sorted by urgency: the SLA calculation lives in
    // OrderCard and sorting by it here would mean either duplicating that
    // logic or hoisting it, for a reordering that the per-card warning pills
    // already make visible. Revisit only if columns get long enough that
    // scanning them stops working.
    Object.keys(buckets).forEach((k) => {
      buckets[k].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    });
    return { columns: buckets, doneCount: done };
  }, [sales, typeFilter]);

  const renderCard = useCallback((order) => (
    <OrderCard
      key={order.id}
      order={order}
      tasks={tasksBySaleId?.get?.(order.id)}
      timezone={effectiveTimezone}
      quickActionLoading={!!quickActionLoading[order.id]}
      viewerRole={viewerRole}
      viewerId={viewerId}
      onOpen={() => onOrderPress(order)}
      onQuickAction={handleQuickAction}
      onResolve={onResolveAction}
    />
  ), [tasksBySaleId, effectiveTimezone, quickActionLoading, viewerRole, viewerId, onOrderPress, handleQuickAction, onResolveAction]);

  return (
    <View>
      <View style={styles.toolbar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          {TYPE_FILTERS.map((f) => {
            const active = typeFilter === f.key;
            return (
              <TouchableOpacity
                key={f.key}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setTypeFilter(f.key)}
                activeOpacity={0.75}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        {doneCount > 0 && (
          <TouchableOpacity style={styles.doneChip} onPress={onNavigateToDone} activeOpacity={0.75}>
            <Text style={styles.doneChipText}>Done today · {doneCount}</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={isWide ? styles.boardWide : styles.boardNarrow}>
        {STAGE_COLUMNS.map((column) => (
          <StageColumn
            key={column.key}
            column={column}
            orders={columns[column.key]}
            isWide={isWide}
            collapsed={!!collapsed[column.key]}
            onToggleCollapse={() => setCollapsed((p) => ({ ...p, [column.key]: !p[column.key] }))}
            renderCard={renderCard}
            onShowAll={onShowAll}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  chipRow: { gap: 6, paddingRight: 8 },
  chip: {
    paddingHorizontal: 14, minHeight: 36, justifyContent: 'center',
    borderRadius: 18, borderWidth: 1, borderColor: '#E5E7EB', backgroundColor: '#FFFFFF',
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, fontFamily: FONT_FAMILY },
  chipTextActive: { color: '#FFFFFF' },
  doneChip: {
    paddingHorizontal: 12, minHeight: 36, justifyContent: 'center',
    borderRadius: 18, backgroundColor: '#F3F4F6',
  },
  doneChipText: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary, fontFamily: FONT_FAMILY },
  boardWide: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  boardNarrow: { flexDirection: 'column' },
});
