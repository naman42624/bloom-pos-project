import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, SectionList, TouchableOpacity, RefreshControl, ActivityIndicator, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { formatCardDateTime, formatTime } from '../utils/datetime';
import { showAlert } from '../utils/alert';
import StageBadge from '../components/StageBadge';
import ContactButtons from '../components/orders/ContactButtons';
import useOrderListData from '../hooks/useOrderListData';
import OrderListToolbar from '../components/orders/OrderListToolbar';
import FilterDrawer from '../components/orders/FilterDrawer';
import ActiveFilterChips from '../components/orders/ActiveFilterChips';
import DateSessionHeader from '../components/orders/DateSessionHeader';
import useSessionsForDates from '../hooks/useSessionsForDates';
import { getSingleLocationId, groupOrdersByDay, groupOrdersBySession } from '../utils/orderGrouping';
import AssignPickerModal from '../components/orderBoard/AssignPickerModal';
import CollectCodModal from '../components/orderBoard/CollectCodModal';
import { PREP_ROLES, STAFF_ROLE_LABELS } from '../constants/orderDisplay';

const STATUS_LABELS = { pending: 'Received', confirmed: 'Confirmed', preparing: 'In Preparation', ready: 'Ready', completed: 'Completed', cancelled: 'Cancelled', draft: 'Draft' };
const ORDER_TYPE_LABELS = { pickup: 'Pickup', delivery: 'Delivery', walk_in: 'Walk-in', pre_order: 'Advance order' };
const PAYMENT_STATUS_COLORS = { paid: Colors.success, partial: Colors.warning, pending: Colors.error, refunded: Colors.textLight };
const CHANNEL_ICONS = { whatsapp: 'logo-whatsapp', email: 'mail', website: 'globe', walk_in: 'walk', phone: 'call' };
const STATUS_FILTERS = [null, 'pending', 'confirmed', 'preparing', 'ready', 'completed'];
const CHANNEL_FILTERS = [null, 'whatsapp', 'email', 'website', 'walk_in', 'phone'];

function formatItemsSummary(items) {
  if (!items || items.length === 0) return null;
  const first = items[0];
  const firstLabel = `${Number(first.quantity) || 1}x ${first.product_name || 'Item'}`;
  if (items.length === 1) return firstLabel;
  return `${firstLabel} +${items.length - 1} more`;
}

function formatAmount(value) {
  const n = Number(value) || 0;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export default function OrdersInboxScreen({ navigation, route }) {
  const { user } = useAuth();
  // Owner/manager already have full Customers access via the More tab —
  // this shortcut is only for employee/counter_staff, who don't have a
  // 'Customers' route registered in their stack's owner/manager sibling
  // (OrdersStack), so it must not render there.
  const showCustomersShortcut = user?.role === 'employee' || user?.role === 'counter_staff';

  const fetchFn = useCallback(
    (params) => api.getSales(params).then((res) => ({ items: res.data?.sales || [], total: Number(res.data?.total) || 0 })),
    []
  );
  const list = useOrderListData(fetchFn, { pageSize: 50 });
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Bumped on every focus-regain (see useFocusEffect below) and handed to
  // useSessionsForDates as a cache-reset signal — this screen never
  // actually unmounts on a focus loss/regain (tab/stack navigators keep it
  // mounted), so without this, a register close/reopen while a staff member
  // stays on this screen would leave session labels stale indefinitely. See
  // useSessionsForDates.js's resetToken comment for the full failure case.
  const [sessionsResetToken, setSessionsResetToken] = useState(0);
  // Which row's next-action button is mid-request — drives the disabled/
  // spinner state below so a double-tap can't fire the same advance twice.
  const [advancingId, setAdvancingId] = useState(null);
  // { order, loading, showingEveryone, people } while the "who is making
  // this?" picker is open, null when closed — mirrors DashboardScreen.js's
  // preparerPicker (2026-09-10, live-reported gap: this screen used to just
  // hide the Start Preparing button whenever a preparer needed picking,
  // rather than actually offering the picker like the Dashboard does).
  // 'start' mode only — this screen never shows a next-action for an
  // already-preparing order in the first place (display_stage.nextAction is
  // null until every task is done), so the dashboard's 'assign' mode (fixing
  // an ALREADY-preparing order's assignment) never applies here.
  const [preparerPicker, setPreparerPicker] = useState(null);
  const preparerReqRef = useRef(0);
  // The order the Collect COD & Mark Delivered modal is open for, null when
  // closed — see CollectCodModal.js, which owns the amount/method form and
  // submission itself.
  const [codCollectOrder, setCodCollectOrder] = useState(null);

  const singleLocationId = useMemo(() => getSingleLocationId(list.items), [list.items]);
  const dayGroups = useMemo(() => groupOrdersByDay(list.items), [list.items]);
  const dateKeysNeedingSessions = useMemo(
    // Under urgency sort, grouping (including session sub-grouping) is fully
    // suppressed — one flat list, no headers (spec §2) — so there's nothing
    // to fetch session data for; skip the fan-out entirely rather than
    // fetching and then throwing every result away.
    () => (singleLocationId && list.sort !== 'urgency' ? dayGroups.map((d) => d.dateKey).filter(Boolean) : []),
    [singleLocationId, list.sort, dayGroups]
  );
  const { sessionsByDate } = useSessionsForDates(singleLocationId, dateKeysNeedingSessions, sessionsResetToken);

  const sections = useMemo(() => {
    if (list.sort === 'urgency') {
      // Guard against a real SectionList quirk: a section object with an
      // empty `data` array still counts as 2 "items" internally (header +
      // footer slots), so ListEmptyComponent would never show for a filter
      // combo with zero results while sorted by urgency. Returning [] here
      // (rather than one section with data: []) keeps the existing
      // "flat, no headers, server order" behavior for any non-empty case
      // while letting the normal empty state show correctly.
      return list.items.length === 0 ? [] : [{ key: 'urgent', dateLabel: null, sessionLabel: null, data: list.items }];
    }
    const result = [];
    for (const day of dayGroups) {
      if (singleLocationId && day.dateKey) {
        const sessionGroups = groupOrdersBySession(day.orders, sessionsByDate[day.dateKey] || []);
        for (const sg of sessionGroups) {
          result.push({
            key: `${day.dateKey}:${sg.sessionLabel || '_none'}`,
            dateLabel: day.dateLabel,
            sessionLabel: sg.sessionLabel,
            data: sg.orders,
          });
        }
      } else {
        result.push({ key: day.dateKey || '_unknown', dateLabel: day.dateLabel, sessionLabel: null, data: day.orders });
      }
    }
    return result;
  }, [list.items, list.sort, singleLocationId, dayGroups, sessionsByDate]);

  // Seeded from an incoming `status` param (the Dashboard's Done chip lands
  // here with { status: 'completed' }) — same intent as the original file's
  // comment, now driven through setFilter instead of local state.
  useEffect(() => {
    if (route.params?.status !== undefined) list.setFilter('status', route.params.status || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params?.status]);

  // list.refresh() depends on `filters` (and therefore, e.g., the status
  // filter above) — so unlike the ORIGINAL file's fetchOrders (which only
  // changed identity on an actual filter change), this refetches on every
  // filter change too, in addition to every focus. That's a deliberate,
  // accepted minor inefficiency (a double-fetch immediately after changing
  // a filter while this screen has focus) — the alternative, freezing the
  // dependency array to [], would replay a STALE list.refresh closure after
  // any filter change, which is worse (silently ignores the new filter on
  // next focus). Do not "fix" this by reverting to [].
  useFocusEffect(useCallback(() => {
    list.refresh();
    setSessionsResetToken((g) => g + 1);
  }, [list.refresh]));

  // Opens the "who is making this?" picker for a Start Preparing order with
  // a genuinely unassigned task — the 'start'-mode half of DashboardScreen.js's
  // handleResolveAction 'pick_preparer' branch, trimmed to what this screen
  // ever needs (it never shows a next-action for an already-preparing order,
  // so 'assign' mode — reassigning an EXISTING preparing order's task —
  // never applies here). Fetch logic (location fallback + honest
  // "showingEveryone" notice) mirrors that branch exactly; see it for the
  // full reasoning.
  const openPreparerPicker = useCallback(async (order) => {
    const locId = order.location_id;
    if (!locId) {
      showAlert('Assign', 'Could not tell which shop this order belongs to. Open the order to assign someone.');
      navigation.navigate('SaleDetail', { saleId: order.id });
      return;
    }
    const reqId = ++preparerReqRef.current;
    setPreparerPicker({ order, loading: true, people: [] });
    try {
      const onlyPrep = (rows) => (Array.isArray(rows) ? rows : []).filter((p) => PREP_ROLES.includes(p.role));
      const res = await api.getAssignableStaff(locId);
      let list = onlyPrep(res?.staff);
      let showingEveryone = false;
      if (list.length === 0) {
        const all = await api.getAssignableStaff();
        const allList = onlyPrep(all?.staff);
        if (allList.length > 0) { list = allList; showingEveryone = true; }
      }
      if (preparerReqRef.current !== reqId) return;
      setPreparerPicker({
        order, loading: false, showingEveryone,
        people: list.map((p) => ({ id: p.id, name: p.name, meta: p.job_title || STAFF_ROLE_LABELS[p.role] || null })),
      });
    } catch (err) {
      if (preparerReqRef.current !== reqId) return;
      setPreparerPicker(null);
      showAlert('Staff', err?.message || 'Could not load the staff list. Please try again.');
    }
  }, [navigation]);

  const closePreparerPicker = useCallback(() => {
    preparerReqRef.current += 1;
    setPreparerPicker(null);
  }, []);

  const handlePickPreparer = useCallback(async (person) => {
    const picker = preparerPicker;
    if (!picker?.order || picker.loading) return;
    const nextAction = picker.order.display_stage?.nextAction;
    if (!nextAction) {
      setPreparerPicker(null);
      showAlert('Start Preparing', 'This order has already moved on. Pull down to refresh.');
      return;
    }
    const reqId = ++preparerReqRef.current;
    setPreparerPicker((prev) => (prev ? { ...prev, loading: true } : prev));
    try {
      await api.advanceOrder(nextAction, { assigned_to: person.id });
      if (preparerReqRef.current === reqId) setPreparerPicker(null);
      list.refresh();
    } catch (err) {
      if (preparerReqRef.current !== reqId) return;
      setPreparerPicker(null);
      showAlert('Start Preparing', err?.message || 'Could not start this order. Please try again.');
    }
  }, [preparerPicker, list.refresh]);

  // "Leave for now" — Start Preparing without naming anybody. Someone
  // mid-rush must always be able to move the order along and sort out who is
  // making it afterwards; matches DashboardScreen.js's identically-named
  // escape hatch.
  const handleLeavePreparerForNow = useCallback(async () => {
    const picker = preparerPicker;
    if (!picker?.order || picker.loading) return;
    const nextAction = picker.order.display_stage?.nextAction;
    if (!nextAction) {
      setPreparerPicker(null);
      showAlert('Start Preparing', 'This order has already moved on. Pull down to refresh.');
      return;
    }
    const reqId = ++preparerReqRef.current;
    setPreparerPicker((prev) => (prev ? { ...prev, loading: true } : prev));
    try {
      await api.advanceOrder(nextAction);
      if (preparerReqRef.current === reqId) setPreparerPicker(null);
      list.refresh();
    } catch (err) {
      if (preparerReqRef.current !== reqId) return;
      setPreparerPicker(null);
      showAlert('Start Preparing', err?.message || 'Could not start this order. Please try again.');
    }
  }, [preparerPicker, list.refresh]);

  const renderItem = ({ item }) => {
    const itemsSummary = formatItemsSummary(item.items);
    const orderTypeLabel = ORDER_TYPE_LABELS[item.order_type] || item.order_type;
    const isUnpaid = item.payment_status && item.payment_status !== 'paid' && item.payment_status !== 'refunded';
    const nextAction = item.display_stage?.nextAction;
    // Mirrors OrderCard.js's handlePrimaryPress: whenever a nextAction
    // exists, ALWAYS show ONE primary button (never silently hide it) —
    // the button itself decides whether to fire directly or open a small
    // resolution step first, exactly like the Dashboard's cards already do.
    // The first version of this screen (2026-09-09) hid the button whenever
    // resolution was needed rather than actually offering it — live-reported
    // as "next actions aren't visible," since Start Preparing is the single
    // most common action and needed resolution roughly half the time in
    // real data. Fixed 2026-09-10 by reusing the Dashboard's exact flows
    // (AssignPickerModal + CollectCodModal, extracted to be shared) instead
    // of a second, divergent copy.
    const needsPreparerPick = nextAction?.body?.status === 'preparing'
      && item.has_unassigned_open_task && user?.role !== 'employee';
    const needsCodCollect = nextAction?.endpoint?.endsWith('/deliver')
      && (Number(item.cod_amount || 0) - Number(item.cod_collected || 0)) > 0.01;
    // 'employee' viewer + an unassigned task: resolvePreparerStep's 'self'
    // case — still one tap, just needs assigned_to attached.
    const selfAssign = nextAction?.body?.status === 'preparing'
      && item.has_unassigned_open_task && user?.role === 'employee' && user?.id != null
      ? { assigned_to: user.id } : undefined;
    const isAdvancing = advancingId === item.id;

    const handleAdvance = async () => {
      // Guard against a double-tap firing this twice while the first call
      // is still in flight — without it, a second tap during the ~500ms-
      // 1s round trip hits the server's own transition guard (e.g. "Cannot
      // transition from ready to ready") and shows that raw, confusing
      // message as if the FIRST tap had failed, when it actually succeeded.
      if (advancingId) return;
      setAdvancingId(item.id);
      try {
        // api.advanceOrder(nextAction, extraBody) — NOT (id, nextAction).
        // The sale id is already baked into nextAction.endpoint (e.g.
        // `/sales/${id}/status`); passing an extra leading id argument
        // would silently shift it into advanceOrder's `extraBody` parameter
        // instead. Matches every other caller of this same helper
        // (DashboardScreen.js, SaleDetailScreen.js, OrderKanbanBoard.js).
        await api.advanceOrder(nextAction, selfAssign);
        list.refresh();
      } catch (err) {
        // err?.message, not err?.response?.data?.message — api.js's request()
        // throws a plain Error whose .message is already the server's plain-
        // language text; every other screen's catch (err) block reads it this
        // way (DashboardScreen.js is the clearest precedent).
        showAlert('Could not update this order', err?.message || 'Please try again, or open the order to see what it needs.');
      } finally {
        setAdvancingId(null);
      }
    };

    const handlePress = () => {
      if (needsPreparerPick) { openPreparerPicker(item); return; }
      if (needsCodCollect) { setCodCollectOrder(item); return; }
      handleAdvance();
    };

    return (
      <TouchableOpacity style={styles.row} onPress={() => navigation.navigate('SaleDetail', { saleId: item.id })}>
        <View style={styles.rowTop}>
          <Ionicons name={CHANNEL_ICONS[item.channel] || 'ellipse'} size={20} color={Colors.textSecondary} style={styles.channelIcon} />
          <View style={styles.rowMain}>
            <Text style={styles.saleNumber}>{item.sale_number}{item.priority === 'rush' ? '  🔥 Rush' : ''}</Text>
            <Text style={styles.customerName}>{item.customer_display_name || item.customer_name || 'Walk-in'} · {orderTypeLabel}</Text>
            {item.location_name && <Text style={styles.locationName}>{item.location_name}</Text>}
            {itemsSummary && <Text style={styles.itemsSummary} numberOfLines={1}>{itemsSummary}</Text>}
            <Text style={styles.timeText}>{formatTime(item.created_at)}</Text>
            {item.scheduled_date && (
              <Text style={styles.scheduled}>📅 {formatCardDateTime(item.scheduled_date, item.scheduled_time)}</Text>
            )}
          </View>
          <View style={styles.rowSide}>
            <StageBadge stage={item.display_stage} size="sm" />
            <Text style={styles.amount}>{formatAmount(item.grand_total)}</Text>
            {isUnpaid && (
              <Text style={[styles.paymentBadge, { color: PAYMENT_STATUS_COLORS[item.payment_status] || Colors.error }]}>
                {item.payment_status === 'partial' ? 'Partly paid' : 'Unpaid'}
              </Text>
            )}
          </View>
        </View>
        <View style={styles.actionsRow}>
          {nextAction ? (
            <TouchableOpacity
              style={[styles.actionBtn, isAdvancing && styles.actionBtnDisabled]}
              onPress={(e) => { e.stopPropagation(); handlePress(); }}
              disabled={isAdvancing}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              {isAdvancing
                ? <ActivityIndicator size="small" color={Colors.white} />
                : <Text style={styles.actionBtnText}>{nextAction.label || 'Next step'}</Text>}
            </TouchableOpacity>
          ) : <View style={{ flex: 1 }} />}
          <ContactButtons
            contacts={[
              { label: 'Customer', phone: item.customer_display_phone || item.customer_phone },
              { label: 'Recipient', phone: item.receiver_display_phone },
            ]}
            context={{
              type: item.display_stage?.key === 'ready_for_pickup' ? 'order_ready_pickup'
                : item.display_stage?.key === 'out_for_delivery' ? 'order_out_for_delivery'
                : 'general_inquiry',
              params: { sale_number: item.sale_number, location_name: item.location_name },
            }}
          />
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* PickupOrdersScreen (the only screen with the "mark picked up /
          collect payment" action) was never registered in this stack at
          all — counter_staff had zero path to it, even after the backend
          gained permission to confirm pickup payment. Owner/manager reach
          it via their own OrdersHub, so this link is scoped to the roles
          that only have this stack (2026-09-01, sub-project 4 audit).
          DeliveriesList added the same day for the same reason, sub-
          project 5 — the list/at-risk monitoring view, not just a single
          delivery's own detail (already reachable via SaleDetail). */}
      {showCustomersShortcut && (
        <View style={styles.quickLinksRow}>
          <TouchableOpacity style={styles.pickupLink} onPress={() => navigation.navigate('PickupOrders')}>
            <Ionicons name="bag-handle-outline" size={16} color={Colors.primary} />
            <Text style={styles.pickupLinkText}>Pickup Orders →</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.pickupLink} onPress={() => navigation.navigate('DeliveriesList')}>
            <Ionicons name="bicycle-outline" size={16} color={Colors.primary} />
            <Text style={styles.pickupLinkText}>Deliveries →</Text>
          </TouchableOpacity>
        </View>
      )}
      <OrderListToolbar
        search={list.search}
        onSearchChange={list.setSearch}
        activeFilterCount={list.activeFilterCount - (list.filters.status ? 1 : 0)}
        onOpenFilters={() => setFiltersOpen(true)}
        sortProps={{
          value: list.sort,
          onChange: list.setSort,
          options: [{ value: null, label: 'Recent' }, { value: 'urgency', label: 'Urgent first' }],
        }}
        placeholder="Search order #, customer, phone, item…"
      />

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterRowScroll} contentContainerStyle={styles.filterRow}>
        {STATUS_FILTERS.map((s) => (
          <TouchableOpacity key={s || 'all'} style={[styles.filterChip, (list.filters.status ?? null) === s && styles.filterChipSelected]} onPress={() => list.setFilter('status', s || undefined)}>
            <Text style={[styles.filterChipText, (list.filters.status ?? null) === s && styles.filterChipTextSelected]}>{s ? STATUS_LABELS[s] : 'All'}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ActiveFilterChips
        filters={{ channel: list.filters.channel, priority: list.filters.priority, order_type: list.filters.order_type }}
        labels={{
          channel: (v) => `Channel: ${v}`,
          priority: () => '🔥 Rush only',
          order_type: (v) => `Type: ${ORDER_TYPE_LABELS[v] || v}`,
        }}
        onRemove={(key) => list.setFilter(key, undefined)}
        // Not list.clearFilters() — that clears status too, and Status has
        // its own always-visible chip row that "Clear all" deliberately
        // leaves alone (spec §3), so each filter is cleared individually
        // here instead.
        onClearAll={() => { list.setFilter('channel', undefined); list.setFilter('priority', undefined); list.setFilter('order_type', undefined); }}
      />

      <FilterDrawer
        visible={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        onClearAll={() => { list.setFilter('channel', undefined); list.setFilter('priority', undefined); list.setFilter('order_type', undefined); setFiltersOpen(false); }}
        sections={[
          {
            key: 'channel', label: 'Channel', value: list.filters.channel ?? null,
            onChange: (v) => list.setFilter('channel', v || undefined),
            options: CHANNEL_FILTERS.map((c) => ({ value: c, label: c || 'Any channel' })),
          },
          {
            key: 'rush', label: 'Rush', value: list.filters.priority ?? null,
            onChange: (v) => list.setFilter('priority', v || undefined),
            options: [{ value: null, label: 'All orders' }, { value: 'rush', label: '🔥 Rush only' }],
          },
          {
            key: 'order_type', label: 'Order type', value: list.filters.order_type ?? null,
            onChange: (v) => list.setFilter('order_type', v || undefined),
            options: [null, 'walk_in', 'pickup', 'delivery', 'pre_order'].map((t) => ({ value: t, label: t ? (ORDER_TYPE_LABELS[t] || t) : 'All types' })),
          },
        ]}
      />

      {/* "Who is making this?" — Start Preparing when a real preparer needs
          picking (has_unassigned_open_task). Same shared component and
          fetch/write flow as DashboardScreen.js's identical picker. */}
      <AssignPickerModal
        visible={preparerPicker !== null}
        title="Who is making this?"
        notice={
          preparerPicker?.loading ? null
            : preparerPicker?.showingEveryone
              ? 'Nobody is set up as prep staff at this location — showing everyone.'
              : (preparerPicker?.people || []).length === 0
                ? 'No prep staff yet. Ask the owner to add someone as Florist/Prep Staff.'
                : null
        }
        people={preparerPicker?.people || []}
        loading={!!preparerPicker?.loading}
        onPick={handlePickPreparer}
        onClose={closePreparerPicker}
        footer={
          preparerPicker?.loading ? null : (
            <TouchableOpacity style={styles.pickerFallbackBtn} activeOpacity={0.7} onPress={handleLeavePreparerForNow}>
              <Text style={styles.pickerFallbackText}>Leave for now</Text>
            </TouchableOpacity>
          )
        }
      />

      {/* Mark Delivered with COD outstanding — same shared component and
          flow as DashboardScreen.js's identical modal. */}
      <CollectCodModal
        visible={codCollectOrder !== null}
        order={codCollectOrder}
        onClose={() => setCodCollectOrder(null)}
        onDone={() => { setCodCollectOrder(null); list.refresh(); }}
      />

      {list.error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{list.error}</Text>
        </View>
      )}

      {list.loading && list.items.length === 0 ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={Colors.primary} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          renderSectionHeader={({ section }) =>
            // No totalAmount here — sumGrandTotal(section.data) only sums the
            // currently-loaded/filtered page, which with a 50-row page size
            // and any Status filter active would look like a complete
            // session reconciliation figure without being one. The real
            // total lives on the Cash Register close screen; this row is
            // for browsing, not reconciling. (Post-implementation review,
            // 2026-09-10 — user chose "drop the total for now.")
            section.key === 'urgent' ? null : (
              <DateSessionHeader
                dateLabel={section.dateLabel}
                sessionLabel={section.sessionLabel}
              />
            )
          }
          refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} colors={[Colors.primary]} />}
          ListEmptyComponent={<Text style={styles.empty}>No orders match these filters.</Text>}
          ListFooterComponent={
            list.hasMore ? (
              <TouchableOpacity style={styles.loadMoreBtn} onPress={list.loadMore} disabled={list.loading || list.refreshing}>
                {list.loading ? <ActivityIndicator color={Colors.primary} /> : <Text style={styles.loadMoreText}>Load more</Text>}
              </TouchableOpacity>
            ) : null
          }
          contentContainerStyle={{ padding: Spacing.md }}
          stickySectionHeadersEnabled={false}
        />
      )}

      {/* Secondary action — smaller than the primary Log Order FAB, so it
          doesn't compete for attention on a screen with one clear main task.
          Lets counter staff check a customer's outstanding balance without
          an active checkout (e.g. a phone call asking about dues). Owner/
          manager already have this via the More tab, so it's hidden there —
          this screen is also reachable by their OrdersStack, which has no
          'Customers' route registered. */}
      {showCustomersShortcut && (
        <TouchableOpacity style={styles.fabSecondary} onPress={() => navigation.navigate('Customers')}>
          <Ionicons name="people" size={22} color={Colors.primary} />
        </TouchableOpacity>
      )}

      <TouchableOpacity style={styles.fab} onPress={() => navigation.navigate('LogOrder')}>
        <Ionicons name="add" size={28} color={Colors.white} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  quickLinksRow: {
    flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.md,
    paddingHorizontal: Spacing.md, paddingTop: Spacing.xs,
  },
  pickupLink: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
  },
  pickupLinkText: { color: Colors.primary, fontWeight: '600', fontSize: FontSize.sm },
  // flexGrow/flexShrink: 0 on the ScrollView's own style (not
  // contentContainerStyle) — without it, react-native-web lets a
  // horizontal ScrollView stretch to fill all remaining vertical space in
  // its flex-column parent, distorting each pill-shaped chip into a
  // near-circle and making the row compete with the SectionList below for
  // space (confirmed live, 2026-09-10 — screenshots showed exactly this).
  // Matches the already-working pattern in DeliveriesScreen.js's
  // tabsRow/locationTabsRow; native is unaffected either way.
  filterRowScroll: { flexGrow: 0, flexShrink: 0 },
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: Spacing.md, paddingTop: Spacing.xs },
  // minHeight 44, not the pre-existing screen's 36 — Status is now the ONLY
  // always-visible filter row on this redesigned screen (staff-ux-checklist
  // #7 / this plan's own 44x44pt global constraint), so it doesn't get to
  // quietly stay under-sized just because it's visually unchanged from before.
  filterChip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: BorderRadius.lg, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, minHeight: 44, justifyContent: 'center' },
  filterChipSelected: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  filterChipText: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '600' },
  filterChipTextSelected: { color: Colors.white },
  row: { backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md, marginBottom: Spacing.sm },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start' },
  channelIcon: { marginRight: Spacing.sm, marginTop: 2 },
  rowMain: { flex: 1 },
  saleNumber: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  customerName: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  locationName: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  itemsSummary: { fontSize: FontSize.sm, color: Colors.text, marginTop: 4 },
  timeText: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  scheduled: { fontSize: FontSize.xs, color: Colors.info, fontWeight: '600', marginTop: 4 },
  rowSide: { alignItems: 'flex-end', marginLeft: Spacing.sm },
  amount: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, marginTop: 4 },
  paymentBadge: { fontSize: FontSize.xs, fontWeight: '700', marginTop: 4 },
  actionsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border },
  actionBtn: { backgroundColor: Colors.primary, borderRadius: BorderRadius.md, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  actionBtnDisabled: { opacity: 0.6 },
  actionBtnText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.sm },
  errorBanner: { backgroundColor: Colors.error + '15', padding: Spacing.sm, marginHorizontal: Spacing.md, borderRadius: BorderRadius.md },
  errorBannerText: { color: Colors.error, fontSize: FontSize.sm },
  empty: { textAlign: 'center', color: Colors.textLight, marginTop: 40 },
  loadMoreBtn: { alignItems: 'center', paddingVertical: Spacing.md, minHeight: 44, justifyContent: 'center' },
  loadMoreText: { color: Colors.primary, fontWeight: '600' },
  // AssignPickerModal's "Leave for now" escape hatch (matches
  // DashboardScreen.js's identically-purposed style, sans FONT_FAMILY since
  // nothing else on this screen sets one either).
  pickerFallbackBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surfaceAlt, marginTop: 4 },
  pickerFallbackText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  fab: { position: 'absolute', right: Spacing.lg, bottom: Spacing.lg, width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center', elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4 },
  fabSecondary: { position: 'absolute', right: Spacing.lg, bottom: Spacing.lg + 68, width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, justifyContent: 'center', alignItems: 'center', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 3 },
});
