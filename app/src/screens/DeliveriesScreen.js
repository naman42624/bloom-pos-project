import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { showAlert } from '../utils/alert';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import {
  parseServerDate, formatDateTime, formatShopDateLabel,
  getShopNow, getShopTodayStr, getShopTomorrowStr, DEFAULT_TZ
} from '../utils/datetime';
import StageBadge from '../components/StageBadge';
import useOrderListData from '../hooks/useOrderListData';
import useAtRiskIds from '../hooks/useAtRiskIds';
import OrderListToolbar from '../components/orders/OrderListToolbar';
import FilterDrawer from '../components/orders/FilterDrawer';
import ActiveFilterChips from '../components/orders/ActiveFilterChips';
import CollapsibleSection from '../components/orders/CollapsibleSection';


const STATUS_TABS = [
  { key: 'active', label: 'Active (To-Do)' },
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'picked_up', label: 'Picked Up' },
  { key: 'in_transit', label: 'In Transit' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'failed', label: 'Failed' },
];

// Statuses a delivery can still be (re)assigned from — matches the batch-
// select long-press affordance and the per-card checkbox eligibility.
const ASSIGNABLE_STATUSES = ['pending', 'assigned', 'failed'];

const STATUS_COLORS = {
  pending: '#FF9800',
  assigned: '#2196F3',
  picked_up: '#9C27B0',
  in_transit: '#00BCD4',
  delivered: '#4CAF50',
  failed: '#F44336',
  cancelled: '#9E9E9E',
};

export default function DeliveriesScreen({ navigation }) {
  const { user, activeLocation, settings } = useAuth();
  const timezone = settings?.timezone?.value || 'Asia/Kolkata';

  /** Convert ISO datetime or YYYY-MM-DD to shop-local YYYY-MM-DD */
  const extractLocalDate = (value) => {
    if (!value) return '';
    const raw = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    try {
      const d = new Date(raw);
      if (!isNaN(d.getTime())) return d.toLocaleDateString('en-CA', { timeZone: timezone });
    } catch { }
    return raw.split('T')[0] || '';
  };

  const [statusFilter, setStatusFilter] = useState('active');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [assignModalVisible, setAssignModalVisible] = useState(false);
  const [selectedDelivery, setSelectedDelivery] = useState(null);
  const [partners, setPartners] = useState([]);
  const [now, setNow] = useState(getShopNow(timezone));

  const tickRef = useRef(null);

  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);

  const isManager = user?.role === 'owner' || user?.role === 'manager';
  const isOwner = user?.role === 'owner';
  // This screen was built assuming only two audiences: owner/manager
  // (management view) or delivery_partner (their own simplified "what do
  // I still owe" view). counter_staff is a third audience the backend
  // already grants full access to (GET /deliveries, GET /deliveries/
  // at-risk, assign/batch-assign/cancel/reattempt — widened 2026-09-01,
  // sub-project 5, user confirmed) but the screen wasn't registered
  // anywhere counter_staff could reach it, and every isManager check here
  // would have silently treated them like a delivery_partner instead.
  // canManageDeliveries covers the management view for all three
  // management-capable roles; isManager stays as-is for the one place
  // that's genuinely owner/manager-specific (the multi-location switcher —
  // counter_staff already gets auto-scoped to their own location, same as
  // non-owner managers, via the !isOwner check in fetchLocations below).
  const canManageDeliveries = isManager || user?.role === 'counter_staff';

  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Dispatch view: with 50+ deliveries/day, different areas, and a handful
  // of delivery partners, a flat date list stops being manageable (design
  // brief, spec §9.1.1). Default is route-grouped with at-risk (late/nearly-
  // late) deliveries surfaced first; date-grouping stays available as a
  // toggle, per CLAUDE.md's "never cut functionality" rule — this is
  // additive, not a replacement. Only meaningful for the management view;
  // a delivery_partner's own small list always stays date-grouped.
  const [viewMode, setViewMode] = useState('route'); // 'route' | 'date'
  const effectiveViewMode = canManageDeliveries ? viewMode : 'date';

  // Tick every 60s to update countdowns
  useEffect(() => {
    tickRef.current = setInterval(() => setNow(getShopNow(timezone)), 60000);
    return () => clearInterval(tickRef.current);
  }, [timezone]);

  const fetchLocations = useCallback(async () => {
    try {
      const res = await api.getLocations();
      const locs = (res.data?.locations || res.data || []).filter(l => (l.type === 'shop' || l.type == null) && l.is_active);
      setLocations(locs);
      if (locs.length > 0 && selectedLocation === null && !isOwner) {
        const defaultLoc = activeLocation && locs.some(l => l.id === activeLocation.id) ? activeLocation.id : locs[0].id;
        setSelectedLocation(defaultLoc);
      }
    } catch (err) { console.error('Error fetching locations:', err); }
  }, [activeLocation, isOwner, selectedLocation]);

  useFocusEffect(useCallback(() => { fetchLocations(); }, [fetchLocations]));

  const fetchFn = useCallback(
    (params) => api.getDeliveries(params).then((res) => ({ items: res.data?.deliveries || [], total: Number(res.data?.total) || 0 })),
    []
  );
  const list = useOrderListData(fetchFn, { pageSize: 200 });
  // Bumped on every focus-regain (see useFocusEffect below) — same reset-
  // token pattern useSessionsForDates/useAtRiskIds both use, for the same
  // reason (this screen never unmounts on a focus loss/regain).
  const [resetToken, setResetToken] = useState(0);
  const { atRiskIds } = useAtRiskIds(list.filters.location_id, resetToken);

  // Location and status filtering still live in local `selectedLocation`/
  // `statusFilter` state — location's UI trigger is now the FilterDrawer's
  // Location section (Task 4), status stays its own always-visible chip row
  // (spec §2: status is a one-tap row, never moved into the drawer) — this
  // effect is the single wire keeping `list`'s own fetch (and, for location,
  // useAtRiskIds above) in sync with them, without a bigger rewrite in this
  // task. Mirrors the old `fetchDeliveries` exactly: `if (statusFilter !==
  // 'all') params.status = statusFilter;` — passing `undefined` for 'all'
  // correctly omits the `status` param entirely, since useOrderListData
  // strips undefined filter values before sending the request.
  useEffect(() => {
    list.setFilter('location_id', selectedLocation || undefined);
    list.setFilter('status', statusFilter === 'all' ? undefined : statusFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLocation, statusFilter]);

  useFocusEffect(useCallback(() => {
    list.refresh();
    setResetToken((g) => g + 1);
  }, [list.refresh]));

  // The FilterDrawer's Rider section (and ActiveFilterChips' rider label
  // lookup) needs `partners` populated as soon as the drawer can be opened —
  // not lazily on assign-modal-open like `openAssignModal`/
  // `openBatchAssignModal` below already do, which would leave the drawer's
  // rider list empty on first render.
  useEffect(() => {
    api.getDeliveryPartners(selectedLocation).then((res) => {
      const users = res.data?.users || res.data || [];
      setPartners(Array.isArray(users) ? users : []);
    }).catch(() => {});
  }, [selectedLocation]);

  const [dateRangePreset, setDateRangePreset] = useState(null);
  const applyDateRangePreset = (preset) => {
    setDateRangePreset(preset);
    const todayStr = getShopTodayStr(timezone);
    if (preset === 'today') {
      list.setFilter('date_from', todayStr); list.setFilter('date_to', todayStr);
    } else if (preset === 'yesterday') {
      const y = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: timezone });
      list.setFilter('date_from', y); list.setFilter('date_to', y);
    } else if (preset === 'this_week') {
      // Fix (Task 4 fix round): the previous version read getShopNow()'s
      // pseudo-local Date (only safe via LOCAL getters like .getDay()), then
      // mutated it with .setDate() (a local-timezone op) and ran the result
      // through a SECOND, real timezone conversion via toLocaleDateString(
      // ..., { timeZone }). That double conversion only happened to agree
      // with the shop's actual Monday when the device's own system timezone
      // matched `timezone` — wrong in `UTC`/`America/Los_Angeles` device
      // timezones, confirmed by trace (see task-4-report.md fix-round note).
      // Fixed the same safe way `yesterday` above already does: keep
      // getShopNow(timezone).getDay() for the weekday number (correct,
      // verified), but compute Monday via real epoch arithmetic off
      // Date.now() and a SINGLE real timeZone-aware conversion at the end.
      const day = getShopNow(timezone).getDay(); // weekday in shop-local time (0=Sunday)
      const mondayOffsetDays = (day + 6) % 7;
      const mondayStr = new Date(Date.now() - mondayOffsetDays * 86400000).toLocaleDateString('en-CA', { timeZone: timezone });
      list.setFilter('date_from', mondayStr); list.setFilter('date_to', todayStr);
    } else {
      list.setFilter('date_from', undefined); list.setFilter('date_to', undefined);
    }
  };

  const openAssignModal = async (delivery) => {
    setSelectedDelivery(delivery);
    try {
      // GET /deliveries/partners (not GET /users, which is owner/manager-
      // only) — already scoped to active delivery_partner accounts server-
      // side, and reachable by counter_staff now that they can assign a
      // rider (2026-09-01, sub-project 5).
      const res = await api.getDeliveryPartners(selectedLocation);
      const users = res.data?.users || res.data || [];
      setPartners(Array.isArray(users) ? users : []);
    } catch (err) {
      console.error('Fetch partners error:', err);
      setPartners([]);
    }
    setAssignModalVisible(true);
  };

  const handleAssign = async (partnerId) => {
    try {
      if (batchMode && selectedIds.size > 0) {
        const res = await api.batchAssignDeliveries({
          delivery_ids: Array.from(selectedIds),
          delivery_partner_id: partnerId,
        });
        const msg = res.message || `Assigned ${selectedIds.size} deliveries`;
        showAlert('Success', msg);
        setSelectedIds(new Set());
        setBatchMode(false);
      } else {
        await api.assignDelivery(selectedDelivery.id, { delivery_partner_id: partnerId });
      }
      setAssignModalVisible(false);
      list.refresh();
    } catch (err) {
      const msg = err.message || 'Failed to assign';
      showAlert('Error', msg);
    }
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // `idsOverride` lets a caller (e.g. "select all in this route") hand in
  // the exact set to assign instead of relying on `selectedIds` state,
  // which wouldn't be flushed yet if we just called setSelectedIds() and
  // then immediately called this in the same synchronous handler.
  const openBatchAssignModal = async (idsOverride) => {
    const ids = idsOverride && idsOverride.size > 0 ? idsOverride : selectedIds;
    if (ids.size === 0) {
      const msg = 'Select at least one delivery';
      showAlert('Info', msg);
      return;
    }
    setBatchMode(true);
    setSelectedIds(ids);
    try {
      // GET /deliveries/partners (not GET /users, which is owner/manager-
      // only) — already scoped to active delivery_partner accounts server-
      // side, and reachable by counter_staff now that they can assign a
      // rider (2026-09-01, sub-project 5).
      const res = await api.getDeliveryPartners(selectedLocation);
      const users = res.data?.users || res.data || [];
      setPartners(Array.isArray(users) ? users : []);
    } catch (err) {
      console.error('Fetch partners error:', err);
      setPartners([]);
    }
    setAssignModalVisible(true);
  };

  // A route tag carries no date, so a route group mixes today's stops with
  // anything scheduled further out on the same route (an advance order due
  // next week, say). One tap of "select all" must never sweep a future-dated
  // delivery into today's rider assignment — so it only ever picks up what's
  // actually due for dispatch now: today's, anything already overdue, and
  // undated stops. A genuinely future one can still be assigned deliberately
  // — long-press its card to enter batch mode and tick it — it just isn't
  // included by a blind bulk tap. (2026-09-01 final-review fix; the old
  // date-grouped-only view gave this boundary for free.)
  const isDueForDispatch = (d) => {
    if (!ASSIGNABLE_STATUSES.includes(d.status)) return false;
    const date = extractLocalDate(d.scheduled_date);
    if (!date) return true; // undated — nothing scheduling it for later
    return date <= getShopTodayStr(timezone);
  };

  // "Select all in this route" — a route group header button. Pure frontend
  // selection convenience (spec §9.1.1): no new endpoint, it just selects
  // every still-assignable delivery due today in that route's group and
  // opens the existing batch-assign modal pre-populated.
  const selectAllInRoute = (routeItems) => {
    const ids = new Set(routeItems.filter(isDueForDispatch).map(d => d.id));
    if (ids.size === 0) {
      const laterCount = routeItems.filter(d => ASSIGNABLE_STATUSES.includes(d.status)).length;
      const msg = laterCount > 0
        ? `Nothing due today on this route — the ${laterCount} delivery(s) left here are scheduled for a later date. Long-press one to assign it early.`
        : 'Nothing to assign in this route — every delivery here is already picked up, delivered, or cancelled.';
      showAlert('Info', msg);
      return;
    }
    openBatchAssignModal(ids);
  };

  // Text search now happens server-side (list.search, via OrderListToolbar) —
  // GET /deliveries already filters by sale_number/customer_name/
  // customer_phone/delivery_address/partner name (Task 1), so no client-side
  // text predicate is needed here anymore. Name kept as `filteredDeliveries`
  // since later code (and Task 5) references it directly.
  const filteredDeliveries = list.items;

  // Group by date for section headers
  const getDateLabel = (dateStr) => formatShopDateLabel(dateStr, timezone);


  const dateSections = [];
  const grouped = {};
  for (const item of filteredDeliveries) {
    const key = extractLocalDate(item.scheduled_date) || '_unscheduled';
    if (!grouped[key]) {
      grouped[key] = { key, title: key === '_unscheduled' ? 'No Date Set' : getDateLabel(key), data: [], isAtRisk: false, isRoute: false };
      dateSections.push(grouped[key]);
    }
    grouped[key].data.push(item);
  }
  // Spec §4: Date view sections and their items must come out chronological
  // by scheduled date/time. That used to fall out for free from iterating
  // the (now-deleted) client-presorted `sortedDeliveries` list — Route/
  // Rider don't need an equivalent fix since both already have their own
  // explicit alphabetical `.sort()` on their section-key arrays, independent
  // of item order; date grouping had no such sort of its own, so it needs
  // one explicitly now that the upstream presort is gone. Scoped to just
  // this block — does not touch filteredDeliveries or any other section
  // builder.
  dateSections.sort((a, b) => {
    if (a.key === '_unscheduled') return 1;
    if (b.key === '_unscheduled') return -1;
    return a.key.localeCompare(b.key);
  });
  for (const section of dateSections) {
    section.data.sort((a, b) => (a.scheduled_time || '00:00').localeCompare(b.scheduled_time || '00:00'));
  }

  // Dispatch/route view — at-risk deliveries lead (regardless of route, so
  // nothing urgent gets buried inside a route group), then every delivery
  // grouped by route. At-risk items still also appear in their route group
  // below (still carrying their "LATE" badge there) — dropping them out of
  // the route group would make "select all in route" silently skip them.
  const NO_ROUTE_KEY = '_no_route';
  const routeSections = [];
  const atRiskItems = filteredDeliveries.filter(d => atRiskIds.has(d.id));
  if (atRiskItems.length > 0) {
    // Plain title, no embedded count — CollapsibleSection's own `count`
    // prop (section.data.length) supplies the "(N)" on its own now that
    // this renders through CollapsibleSection instead of the old custom
    // renderSectionHeader. Embedding a count here too produced a double
    // "(N) (N)" (fix-round finding, see task-5-report.md).
    routeSections.push({ key: '_at_risk', title: 'Needs Attention', data: atRiskItems, isAtRisk: true, isRoute: false });
  }
  const byRoute = {};
  const routeKeys = [];
  for (const item of filteredDeliveries) {
    const key = item.route_name || NO_ROUTE_KEY;
    if (!byRoute[key]) {
      byRoute[key] = { key, title: item.route_name || 'No Route Assigned', data: [], isAtRisk: false, isRoute: true };
      routeKeys.push(key);
    }
    byRoute[key].data.push(item);
  }
  routeKeys.sort((a, b) => {
    if (a === NO_ROUTE_KEY) return 1;
    if (b === NO_ROUTE_KEY) return -1;
    return a.localeCompare(b);
  });
  for (const key of routeKeys) routeSections.push(byRoute[key]);

  // By-rider grouping (new, alongside route/date). Same NO_*_KEY-last sort
  // convention as routeSections above, keyed on partner_name since that's
  // what the delivery list already carries (no separate partner-id lookup
  // needed here).
  const NO_RIDER_KEY = '_no_rider';
  const riderSections = [];
  const byRider = {};
  const riderKeys = [];
  for (const item of filteredDeliveries) {
    const key = item.partner_name || NO_RIDER_KEY;
    if (!byRider[key]) {
      byRider[key] = { key, title: item.partner_name || 'Unassigned', data: [], isAtRisk: false, isRoute: false };
      riderKeys.push(key);
    }
    byRider[key].data.push(item);
  }
  riderKeys.sort((a, b) => {
    if (a === NO_RIDER_KEY) return 1;
    if (b === NO_RIDER_KEY) return -1;
    return a.localeCompare(b);
  });
  for (const key of riderKeys) riderSections.push(byRider[key]);

  // sort==='urgency' wins over any view-mode toggle: one flat, server-
  // ordered list with no headers and no at-risk lead section (spec §4) —
  // the whole point of "Urgent first" is a single ranked queue, not another
  // grouping axis.
  const sections = list.sort === 'urgency'
    ? [{ key: '_flat', title: null, data: filteredDeliveries, isAtRisk: false, isRoute: false }]
    : effectiveViewMode === 'route' ? routeSections
    : effectiveViewMode === 'rider' ? riderSections
    : dateSections;

  const getTimeInfo = (item) => {
    // For delivered/failed orders, show completion time instead of countdown
    if (item.status === 'delivered' && item.delivered_time) {
      return {
        label: 'Delivered ' + formatDateTime(item.delivered_time, 'en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }),
        countdown: null,
        isOverdue: false,
        isDone: true,
      };
    }
    if (item.status === 'failed') {
      return { label: 'Failed', countdown: null, isOverdue: false, isDone: true };
    }

    if (!item.scheduled_date) return { label: null, countdown: null, isOverdue: false };
    const dateStr = extractLocalDate(item.scheduled_date);
    if (!dateStr) return { label: null, countdown: null, isOverdue: false };
    // PostgreSQL TIME returns HH:MM:SS — only take HH:MM for display
    const rawTime = (item.scheduled_time || '').split('.')[0]; // strip fractional seconds
    const timeStr = rawTime || '00:00';
    // Build ISO string: if timeStr is HH:MM:SS, don't append :00
    const isoTime = timeStr.length <= 5 ? `${timeStr}:00` : timeStr;
    const [year, month, day] = dateStr.split('-').map(Number);
    const [hr, min, sec] = isoTime.split(':').map(Number);
    const target = new Date(year, month - 1, day, hr, min, sec || 0);

    if (isNaN(target.getTime())) return { label: dateStr, countdown: null, isOverdue: false };
    const diffMs = target - now;
    const diffMin = Math.round(diffMs / 60000);

    const today = getShopTodayStr(timezone);
    const tomorrowStr = getShopTomorrowStr(timezone);

    let dateLabel = '';
    if (dateStr === today) dateLabel = 'Today';
    else if (dateStr === tomorrowStr) dateLabel = 'Tomorrow';
    else {
      dateLabel = target.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    }

    const formattedTime = rawTime ? target.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '';
    const label = formattedTime ? `${dateLabel}, ${formattedTime}` : dateLabel;

    let countdown = null;
    let isOverdue = false;
    if (diffMin < 0) {
      isOverdue = true;
      const overMin = Math.abs(diffMin);
      countdown = overMin >= 60 ? `${Math.floor(overMin / 60)}h ${overMin % 60}m overdue` : `${overMin}m overdue`;
    } else if (diffMin < 1440) {
      countdown = diffMin >= 60 ? `in ${Math.floor(diffMin / 60)}h ${diffMin % 60}m` : `in ${diffMin}m`;
    }
    return { label, countdown, isOverdue };
  };

  const renderDelivery = ({ item }) => {
    const statusColor = STATUS_COLORS[item.status] || '#999';
    const isAtRisk = atRiskIds.has(item.id);
    const timeInfo = getTimeInfo(item);
    const canSelect = batchMode && ASSIGNABLE_STATUSES.includes(item.status);
    const isSelected = selectedIds.has(item.id);
    return (
      <TouchableOpacity
        style={[styles.card, isAtRisk && styles.cardAtRisk, isSelected && styles.cardSelected]}
        onPress={() => {
          if (canSelect) { toggleSelect(item.id); }
          else navigation.navigate('DeliveryDetail', { deliveryId: item.id });
        }}
        onLongPress={() => {
          if (canManageDeliveries && ASSIGNABLE_STATUSES.includes(item.status)) {
            setBatchMode(true);
            setSelectedIds(new Set([item.id]));
          }
        }}
      >
        {/* Selection checkbox */}
        {batchMode && canSelect && (
          <View style={styles.selectCheck}>
            <Ionicons name={isSelected ? 'checkbox' : 'square-outline'} size={22} color={isSelected ? Colors.primary : Colors.textLight} />
          </View>
        )}

        {/* Time header — prominent */}
        {timeInfo.label && (
          <View style={[styles.timeHeader, timeInfo.isOverdue && styles.timeHeaderOverdue, timeInfo.isDone && styles.timeHeaderDone]}>
            <View style={styles.timeRow}>
              <Ionicons name={timeInfo.isDone ? 'checkmark-circle' : 'time-outline'} size={18} color={timeInfo.isDone ? Colors.success : timeInfo.isOverdue ? '#D32F2F' : Colors.primary} />
              <Text style={[styles.timeText, timeInfo.isOverdue && styles.timeTextOverdue, timeInfo.isDone && { color: Colors.success }]}>{timeInfo.label}</Text>
            </View>
            {timeInfo.countdown && (
              <Text style={[styles.countdownText, timeInfo.isOverdue ? styles.countdownOverdue : styles.countdownNormal]}>
                {timeInfo.countdown}
              </Text>
            )}
          </View>
        )}

        <View style={styles.cardHeader}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: 1 }}>
            <Text style={styles.orderNum}>
              {item.sale_number}
              {!selectedLocation && item.location_name ? ` • ${item.location_name}` : ''}
            </Text>
            {isAtRisk && (
              <View style={styles.urgentBadge}>
                <Ionicons name="warning" size={10} color="#FF6D00" />
                <Text style={styles.urgentText}>LATE</Text>
              </View>
            )}
          </View>

          <View style={styles.badgeStack}>
            <StageBadge stage={item.display_stage} size="sm" />
            <View style={[styles.badge, { backgroundColor: statusColor + '20' }]}>
              <Text style={[styles.badgeText, { color: statusColor }]}>
                {item.status.replace(/_/g, ' ').toUpperCase()}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.cardBody}>
          <View style={styles.row}>
            <Ionicons name="location-outline" size={16} color={Colors.textLight} />
            <Text style={styles.address} numberOfLines={2}>{item.delivery_address}</Text>
          </View>
          {item.customer_name && (
            <View style={styles.row}>
              <Ionicons name="person-outline" size={16} color={Colors.textLight} />
              <Text style={styles.cardText}>{item.customer_name} {item.customer_phone ? `• ${item.customer_phone}` : ''}</Text>
            </View>
          )}
          {item.partner_name && (
            <View style={styles.row}>
              <Ionicons name="bicycle-outline" size={16} color={Colors.textLight} />
              <Text style={styles.cardText}>{item.partner_name}</Text>
            </View>
          )}
        </View>

        {(item.special_instructions || item.notes) && (
          <Text style={{ fontSize: FontSize.xs, color: '#D32F2F', marginTop: 4, paddingHorizontal: Spacing.md, fontWeight: '600' }}>
            Order Note: {item.special_instructions || item.notes}
          </Text>
        )}

        {(item.items && item.items.length > 0) && (
          <View style={{ marginHorizontal: Spacing.md, marginTop: 8, backgroundColor: Colors.background, padding: 8, borderRadius: 6 }}>
            {item.items.map((it, idx) => (
              <View key={idx} style={{ marginBottom: idx === item.items.length - 1 ? 0 : 4 }}>
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{it.quantity}x {it.product_name}</Text>
                {it.item_special_instructions ? (
                  <Text style={{ fontSize: FontSize.xs, color: '#F57C00', marginLeft: 8, fontWeight: '500' }}>* {it.item_special_instructions}</Text>
                ) : null}
              </View>
            ))}
          </View>
        )}

        <View style={styles.cardFooter}>
          {canManageDeliveries && <Text style={styles.amount}>₹{Number(item.grand_total || 0).toFixed(0)}</Text>}
          {item.cod_amount > 0 && (
            <View style={[styles.codBadge, item.cod_status === 'collected' ? styles.codCollected : styles.codPending]}>
              <Text style={styles.codText}>
                {!canManageDeliveries ? 'Collect' : 'COD'} ₹{Number(item.cod_amount).toFixed(0)} {item.cod_status === 'collected' ? '✓' : item.cod_status === 'settled' ? '$$' : ''}
              </Text>
            </View>
          )}
          {!canManageDeliveries && item.cod_amount === 0 && (
            <View style={[styles.codBadge, styles.codCollected]}>
              <Text style={styles.codText}>Prepaid ✓</Text>
            </View>
          )}
          {canManageDeliveries && item.status === 'pending' && (
            <TouchableOpacity style={styles.assignBtn} onPress={() => openAssignModal(item)}>
              <Text style={styles.assignBtnText}>Assign</Text>
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <OrderListToolbar
        search={list.search}
        onSearchChange={list.setSearch}
        activeFilterCount={list.activeFilterCount}
        onOpenFilters={() => setFiltersOpen(true)}
        viewModeProps={canManageDeliveries ? {
          value: viewMode,
          onChange: setViewMode,
          options: [
            { value: 'route', label: 'By Route' },
            { value: 'date', label: 'By Date' },
            { value: 'rider', label: 'By Rider' },
          ],
        } : undefined}
        sortProps={{
          value: list.sort,
          onChange: list.setSort,
          options: [{ value: null, label: 'Recent' }, { value: 'urgency', label: 'Urgent first' }],
        }}
        placeholder="Search by order #, customer, partner…"
      />

      <ActiveFilterChips
        filters={{ location_id: list.filters.location_id, delivery_partner_id: list.filters.delivery_partner_id, date_from: list.filters.date_from, date_to: list.filters.date_to }}
        labels={{
          location_id: (v) => `Location: ${locations.find((l) => l.id === v)?.name || v}`,
          delivery_partner_id: (v) => `Rider: ${partners.find((p) => p.id === v)?.name || v}`,
          date_from: (v) => `From: ${v}`,
          date_to: (v) => `To: ${v}`,
        }}
        onRemove={(key) => { if (key === 'location_id') setSelectedLocation(null); else list.setFilter(key, undefined); }}
        onClearAll={() => { setSelectedLocation(null); list.setFilter('delivery_partner_id', undefined); list.setFilter('date_from', undefined); list.setFilter('date_to', undefined); }}
      />

      <FilterDrawer
        visible={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        onClearAll={() => { setSelectedLocation(null); list.setFilter('delivery_partner_id', undefined); list.setFilter('date_from', undefined); list.setFilter('date_to', undefined); setFiltersOpen(false); }}
        sections={[
          ...(isManager ? [{
            key: 'location', label: 'Location', value: selectedLocation ?? null,
            onChange: (v) => setSelectedLocation(v),
            options: [{ value: null, label: isOwner ? 'All Locations' : 'My Location' }, ...locations.map((l) => ({ value: l.id, label: l.name }))],
          }] : []),
          {
            key: 'rider', label: 'Rider', value: list.filters.delivery_partner_id ?? null,
            onChange: (v) => list.setFilter('delivery_partner_id', v || undefined),
            options: [{ value: null, label: 'Any rider' }, ...partners.map((p) => ({ value: p.id, label: p.name }))],
          },
          {
            key: 'date_range', label: 'Date range', value: dateRangePreset ?? null,
            onChange: (v) => applyDateRangePreset(v),
            options: [
              { value: null, label: 'All dates' },
              { value: 'today', label: 'Today' },
              { value: 'yesterday', label: 'Yesterday' },
              { value: 'this_week', label: 'This Week' },
            ],
          },
        ]}
      />

      {/* Status tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsRow}>
        {STATUS_TABS.map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, statusFilter === tab.key && styles.tabActive]}
            onPress={() => setStatusFilter(tab.key)}
          >
            <Text style={[styles.tabText, statusFilter === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Batch mode bar */}
      {canManageDeliveries && batchMode && (
        <View style={styles.batchBar}>
          <Text style={styles.batchBarText}>{selectedIds.size} selected</Text>
          <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
            <TouchableOpacity style={styles.batchAssignBtn} onPress={openBatchAssignModal}>
              <Ionicons name="people" size={16} color="#fff" />
              <Text style={styles.batchAssignText}>Assign All</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.batchCancelBtn}
              onPress={() => { setBatchMode(false); setSelectedIds(new Set()); }}
            >
              <Text style={styles.batchCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* List — grouped by route/date/rider (toggled above), or one flat
          urgency-ranked list with no grouping when sort==='urgency'. Was a
          SectionList; now a plain ScrollView of CollapsibleSections so each
          group can be independently collapsed/expanded (spec §4). */}
      <ScrollView
        style={{ flex: 1 }}
        refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} colors={[Colors.primary]} />}
        contentContainerStyle={{ padding: Spacing.md, paddingBottom: 100 }}
      >
        {sections.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="bicycle-outline" size={48} color={Colors.textLight} />
            <Text style={styles.emptyText}>No deliveries found</Text>
          </View>
        ) : list.sort === 'urgency' ? (
          sections[0].data.map((item) => <View key={item.id}>{renderDelivery({ item })}</View>)
        ) : (
          sections.map((section) => {
            // Counts only what "select all" will actually select — see
            // isDueForDispatch: today/overdue/undated, never future-dated.
            const selectableCount = section.isRoute ? section.data.filter(isDueForDispatch).length : 0;
            return (
              <CollapsibleSection key={section.key} title={section.title} count={section.data.length} defaultExpanded>
                {section.isRoute && canManageDeliveries && selectableCount > 0 && (
                  <TouchableOpacity style={styles.selectRouteBtn} onPress={() => selectAllInRoute(section.data)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="checkmark-done-outline" size={16} color={Colors.primary} />
                    <Text style={styles.selectRouteBtnText}>Select today's ({selectableCount})</Text>
                  </TouchableOpacity>
                )}
                {section.data.map((item) => <View key={item.id}>{renderDelivery({ item })}</View>)}
              </CollapsibleSection>
            );
          })
        )}
      </ScrollView>

      {/* Assign Modal */}
      <Modal visible={assignModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Assign Delivery Partner</Text>
              <TouchableOpacity onPress={() => setAssignModalVisible(false)}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>
            {batchMode ? (
              <Text style={styles.modalSubtitle}>Assign {selectedIds.size} deliveries to a partner</Text>
            ) : selectedDelivery ? (
              <Text style={styles.modalSubtitle}>{selectedDelivery.sale_number} — {selectedDelivery.customer_name || 'Customer'}</Text>
            ) : null}
            <ScrollView style={{ maxHeight: 300 }}>
              {partners.length === 0 ? (
                <Text style={styles.emptyText}>No delivery partners found. Add staff with "delivery_partner" role.</Text>
              ) : (
                partners.map(p => (
                  <TouchableOpacity key={p.id} style={styles.partnerItem} onPress={() => handleAssign(p.id)}>
                    <Ionicons name="person-circle" size={36} color={Colors.primary} />
                    <View style={{ marginLeft: 12, flex: 1 }}>
                      <Text style={styles.partnerName}>{p.name}</Text>
                      <Text style={styles.partnerPhone}>{p.phone}</Text>
                      <Text style={styles.partnerLoad}>{p.active_delivery_count || 0} stop{Number(p.active_delivery_count) !== 1 ? 's' : ''} today</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  tabsRow: { flexGrow: 0, flexShrink: 0, paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: Colors.surface, marginRight: 8, borderWidth: 1, borderColor: Colors.border },
  tabActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  tabText: { fontSize: FontSize.sm, color: Colors.textLight },
  tabTextActive: { color: '#fff', fontWeight: '600' },
  card: { backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.md, marginBottom: Spacing.md, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
  cardAtRisk: { borderWidth: 2, borderColor: '#FF6D00' },
  timeHeader: { backgroundColor: Colors.primary + '10', borderRadius: BorderRadius.sm, padding: Spacing.sm, marginBottom: Spacing.sm, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  timeHeaderOverdue: { backgroundColor: '#FFEBEE' },
  timeHeaderDone: { backgroundColor: '#E8F5E9' },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  timeText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  timeTextOverdue: { color: '#D32F2F' },
  countdownText: { fontSize: FontSize.sm, fontWeight: '700' },
  countdownNormal: { color: Colors.primary },
  countdownOverdue: { color: '#D32F2F' },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  orderNum: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  badgeStack: { alignItems: 'flex-end', gap: 4 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  badgeText: { fontSize: FontSize.xs, fontWeight: '700' },
  cardBody: { marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 6 },
  address: { fontSize: FontSize.sm, color: Colors.text, flex: 1 },
  cardText: { fontSize: FontSize.sm, color: Colors.textLight },
  cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 8 },
  amount: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  codBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  codPending: { backgroundColor: '#FFF3E0' },
  codCollected: { backgroundColor: '#E8F5E9' },
  codText: { fontSize: FontSize.xs, fontWeight: '600', color: '#E65100' },
  assignBtn: { backgroundColor: Colors.primary, paddingHorizontal: 16, paddingVertical: 8, borderRadius: BorderRadius.md },
  assignBtnText: { color: '#fff', fontWeight: '600', fontSize: FontSize.sm },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 4, marginTop: 8 },
  sectionHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, flexShrink: 1 },
  sectionHeaderText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
  sectionHeaderTextAtRisk: { color: '#FF6D00' },
  selectRouteBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary + '15', borderWidth: 1, borderColor: Colors.primary + '30',
  },
  selectRouteBtnText: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.primary },
  empty: { alignItems: 'center', marginTop: 60 },
  emptyText: { fontSize: FontSize.md, color: Colors.textLight, marginTop: 8, textAlign: 'center' },
  urgentBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#FFF3E0', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  urgentText: { fontSize: 8, fontWeight: '800', color: '#FF6D00' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: Spacing.lg, maxHeight: '70%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  modalSubtitle: { fontSize: FontSize.sm, color: Colors.textLight, marginBottom: Spacing.md },
  partnerItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Colors.border },
  partnerName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  partnerPhone: { fontSize: FontSize.sm, color: Colors.textLight },
  partnerLoad: { fontSize: FontSize.sm, color: Colors.primary, marginTop: 2 },
  // Batch mode
  cardSelected: { borderWidth: 2, borderColor: Colors.primary, backgroundColor: Colors.primary + '08' },
  selectCheck: { position: 'absolute', top: Spacing.sm, right: Spacing.sm, zIndex: 1 },
  batchBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    backgroundColor: Colors.primary + '15', borderBottomWidth: 1, borderBottomColor: Colors.primary + '30',
    flexShrink: 0
  },
  batchBarText: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.primary },
  batchAssignBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.primary, paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.md,
  },
  batchAssignText: { color: '#fff', fontSize: FontSize.sm, fontWeight: '600' },
  batchCancelBtn: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs },
  batchCancelText: { color: Colors.textSecondary, fontSize: FontSize.sm },
});
