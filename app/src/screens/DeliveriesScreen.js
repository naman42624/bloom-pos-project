import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, RefreshControl, ActivityIndicator } from 'react-native';
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
import ContactButtons from '../components/orders/ContactButtons';
import AssignPickerModal from '../components/orderBoard/AssignPickerModal';
import RouteAssignModal from '../components/orderBoard/RouteAssignModal';
import CollectCodModal from '../components/orderBoard/CollectCodModal';
import TaskCompletionModal from '../components/orderBoard/TaskCompletionModal';
import { resolveDeadEnd } from '../components/orderBoard/OrderCard';
import { PREP_ROLES, STAFF_ROLE_LABELS } from '../constants/orderDisplay';


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

// GET /deliveries rows aren't sale-shaped — resolveDeadEnd/resolvePreparerStep/
// resolveDeliverStep (OrderCard.js) were built against GET /sales rows. See
// this task's own interface note in docs/superpowers/plans/2026-09-10-
// deliveries-redesign.md Task 6 for the full field-name mapping and why it's
// required, not optional.
function toSaleShape(delivery) {
  return {
    ...delivery,
    id: delivery.sale_id,
    delivery_id: delivery.id,
    delivery_status: delivery.status,
    delivery_partner_name: delivery.partner_name,
  };
}

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
  // Exact role list copied from OrderCard.js's own canTakeMoney (not
  // re-derived) — see resolveDeadEnd's doc comment in that file for why a
  // role check belongs here at all even though a null nextAction already
  // encodes the server's own decision about the ACTION.
  const canTakeMoney = ['owner', 'manager', 'employee', 'counter_staff'].includes(user?.role);
  // Exact role list copied from GET /production/tasks's own authorize() —
  // excludes delivery_partner, who this screen (DeliveriesScreen/
  // MyDeliveries) also serves as their own home screen. resolveDeadEnd's
  // finish_tasks branch (OrderCard.js) deliberately has no role gate of its
  // own — correct for its native callers (Dashboard/Orders Inbox, neither of
  // which serves delivery_partner) — so this is a LOCAL downgrade in this
  // screen's own renderDelivery, not a change to the shared helper. Without
  // it, a rider tapping "N tasks to finish" opened TaskCompletionModal, whose
  // GET /production/tasks 403'd silently and rendered as an empty "all done"
  // list — directly contradicting the card behind it, which still said "N
  // tasks to finish."
  const canViewTasks = ['owner', 'manager', 'employee', 'counter_staff', 'florist_staff'].includes(user?.role);

  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  // Which card's item list is expanded behind the disclosure — a single id
  // at component scope is enough since only one card is likely to be
  // expanded at a time in practice (matches riderPicker-style single-item
  // state elsewhere in this file).
  const [expandedItemsId, setExpandedItemsId] = useState(null);
  // The order the Collect COD & Mark Delivered modal is open for, null when
  // closed — see CollectCodModal.js, which owns the amount/method form and
  // submission itself.
  const [codCollectOrder, setCodCollectOrder] = useState(null);
  // The order the "Finish Tasks" modal is open for, null when closed — see
  // TaskCompletionModal.js, which owns its own task-list fetch/complete flow.
  const [taskCompletionOrder, setTaskCompletionOrder] = useState(null);
  // Which row's next-action button is mid-request — drives the disabled/
  // spinner state below so a double-tap can't fire the same advance twice.
  const [advancingId, setAdvancingId] = useState(null);
  // { order, loading, showingEveryone, people } while the "who is making
  // this?" picker is open, null when closed — mirrors OrdersInboxScreen.js's
  // identical preparerPicker (copied, not re-derived; see this task's brief).
  const [preparerPicker, setPreparerPicker] = useState(null);
  const preparerReqRef = useRef(0);

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
  // Gated to canManageDeliveries (byproduct, final whole-branch review,
  // 2026-09-10) — a delivery_partner viewer always 403s GET /deliveries/
  // at-risk (owner/manager/employee/counter_staff-only), harmlessly resolving
  // to an empty Set either way, but there's no reason to fire a request that
  // can never succeed for that audience.
  const { atRiskIds } = useAtRiskIds(list.filters.location_id, resetToken, canManageDeliveries);

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
  // not lazily on rider-picker-open like `openRiderPickerFor` below already
  // does, which would leave the drawer's rider list empty on first render.
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

  // Opens the "who is making this?" picker for a Start Preparing order with
  // a genuinely unassigned task — copied verbatim from OrdersInboxScreen.js's
  // own openPreparerPicker (not re-derived), just against `saleShaped` order
  // objects (toSaleShape-adapted delivery rows) instead of GET /sales rows.
  // See that file for the full fetch/fallback reasoning.
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
      let staffList = onlyPrep(res?.staff);
      let showingEveryone = false;
      if (staffList.length === 0) {
        const all = await api.getAssignableStaff();
        const allList = onlyPrep(all?.staff);
        if (allList.length > 0) { staffList = allList; showingEveryone = true; }
      }
      if (preparerReqRef.current !== reqId) return;
      setPreparerPicker({
        order, loading: false, showingEveryone,
        people: staffList.map((p) => ({ id: p.id, name: p.name, meta: p.job_title || STAFF_ROLE_LABELS[p.role] || null })),
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
  // making it afterwards; matches OrdersInboxScreen.js's identically-named
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

  // Consolidated rider picker — replaces the old openAssignModal/handleAssign/
  // batch-assign-driven custom <Modal> with the same AssignPickerModal
  // component OrdersInboxScreen.js's preparerPicker above already uses.
  // { deliveryIds: Set, label, loading, showingEveryone, people } while open,
  // null when closed. A single deliveryIds Set carries both the single- and
  // batch-assign case — handlePickRiderConsolidated picks the right API call
  // by its size, so this screen never needs two parallel pickers. `label`
  // (optional — only the single-delivery dead-end call site has an order in
  // scope to build one from) identifies which order is being assigned, shown
  // in the single-item title so a staff member sweeping similar-looking
  // stacked cards in a route group has an in-modal sanity check before
  // picking a name (fix-round finding: the deleted custom modal used to show
  // this as a subtitle; consolidating onto AssignPickerModal silently
  // dropped it).
  const [riderPicker, setRiderPicker] = useState(null);
  const riderReqRef = useRef(0);

  const openRiderPickerFor = useCallback(async (deliveryIds, label) => {
    const reqId = ++riderReqRef.current;
    setRiderPicker({ deliveryIds, label, loading: true, people: [] });
    try {
      // GET /deliveries/partners (not GET /users, which is owner/manager-
      // only) — already scoped to active delivery_partner accounts server-
      // side, and reachable by counter_staff now that they can assign a
      // rider (2026-09-01, sub-project 5).
      const res = await api.getDeliveryPartners(selectedLocation);
      let people = res.data?.users || res.data || [];
      if (!Array.isArray(people)) people = [];
      let showingEveryone = false;
      if (people.length === 0 && selectedLocation) {
        const all = await api.getDeliveryPartners();
        const allList = all.data?.users || all.data || [];
        if (Array.isArray(allList) && allList.length > 0) { people = allList; showingEveryone = true; }
      }
      if (riderReqRef.current !== reqId) return;
      setRiderPicker({
        deliveryIds, label, loading: false, showingEveryone,
        // Matches OrdersInboxScreen.js's own openRiderPicker meta phrasing
        // exactly (fix-round finding — was drifted, and "N stops today"
        // overclaimed since active_delivery_count has no date filter
        // server-side).
        people: people.map((p) => {
          const busy = Number(p.active_delivery_count || 0);
          return { id: p.id, name: p.name, meta: busy === 0 ? 'Free right now' : busy === 1 ? '1 on the road' : `${busy} on the road` };
        }),
      });
    } catch (err) {
      if (riderReqRef.current !== reqId) return;
      setRiderPicker(null);
      showAlert('Riders', err?.message || 'Could not load the rider list. Please try again.');
    }
  }, [selectedLocation]);

  const closeRiderPicker = useCallback(() => { riderReqRef.current += 1; setRiderPicker(null); }, []);

  const handlePickRiderConsolidated = useCallback(async (person) => {
    const picker = riderPicker;
    if (!picker || picker.loading) return;
    const reqId = ++riderReqRef.current;
    setRiderPicker((prev) => (prev ? { ...prev, loading: true } : prev));
    try {
      if (picker.deliveryIds.size > 1) {
        const res = await api.batchAssignDeliveries({ delivery_ids: Array.from(picker.deliveryIds), delivery_partner_id: person.id });
        showAlert('Success', res.message || `Assigned ${picker.deliveryIds.size} deliveries`);
      } else {
        await api.assignDelivery(Array.from(picker.deliveryIds)[0], { delivery_partner_id: person.id });
      }
      if (riderReqRef.current === reqId) setRiderPicker(null);
      setBatchMode(false);
      setSelectedIds(new Set());
      list.refresh();
    } catch (err) {
      if (riderReqRef.current !== reqId) return;
      setRiderPicker(null);
      showAlert('Error', err?.message || 'Failed to assign');
    }
  }, [riderPicker, list.refresh]);

  // Assign Route — the Assign Rider counterpart. Fully controlled (see
  // RouteAssignModal.js's own header comment for why): this screen owns
  // routeId and computes the overwrite warning fresh from filteredDeliveries
  // on every render, never stored (CLAUDE.md's "derived values computed
  // fresh" rule).
  const [routeAssignPicker, setRouteAssignPicker] = useState(null); // { deliveryIds: Set } | null
  const [routeAssignRouteId, setRouteAssignRouteId] = useState(null);
  const [routeAssignConfirming, setRouteAssignConfirming] = useState(false);

  const openRouteAssignModal = (deliveryIds) => {
    setRouteAssignRouteId(null);
    setRouteAssignPicker({ deliveryIds });
  };

  const closeRouteAssignModal = () => {
    setRouteAssignPicker(null);
    setRouteAssignRouteId(null);
  };

  // routeAssignOverwriteCount/routeAssignWarning (derived from
  // filteredDeliveries) are declared further down, right after
  // filteredDeliveries itself — filteredDeliveries isn't defined yet at this
  // point in the component body, and referencing it here would throw
  // (temporal dead zone) the moment a route is actually picked.

  const handleConfirmRouteAssign = async () => {
    if (!routeAssignPicker || !routeAssignRouteId || routeAssignConfirming) return;
    setRouteAssignConfirming(true);
    try {
      const ids = routeAssignPicker.deliveryIds;
      if (ids.size > 1) {
        const res = await api.batchAssignRoute({ delivery_ids: Array.from(ids), route_id: routeAssignRouteId });
        showAlert('Success', res.message || `Assigned route to ${ids.size} deliveries`);
      } else {
        await api.assignDeliveryRoute(Array.from(ids)[0], { route_id: routeAssignRouteId });
      }
      closeRouteAssignModal();
      setBatchMode(false);
      setSelectedIds(new Set());
      list.refresh();
    } catch (err) {
      showAlert('Error', err?.message || 'Failed to assign route');
    } finally {
      setRouteAssignConfirming(false);
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

  // Enters batch mode with a specific id set — called by selectAllInRoute.
  // Deliberately does NOT open any picker itself: since this screen now has
  // two bulk actions (Assign Rider / Assign Route), opening one automatically
  // would silently pick for the user. The batch bar's own two buttons open
  // the right picker once the user chooses.
  const selectForBatch = (ids) => {
    setBatchMode(true);
    setSelectedIds(ids);
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
    selectForBatch(ids);
  };

  // Text search now happens server-side (list.search, via OrderListToolbar) —
  // GET /deliveries already filters by sale_number/customer_name/
  // customer_phone/delivery_address/partner name (Task 1), so no client-side
  // text predicate is needed here anymore. Name kept as `filteredDeliveries`
  // since later code (and Task 5) references it directly.
  const filteredDeliveries = list.items;

  // How many of the currently-targeted deliveries already carry a
  // DIFFERENT route than the one about to be applied. Zero (no warning)
  // until the user has actually picked a route to apply. Declared here
  // (not up with routeAssignPicker/routeAssignRouteId above) because it
  // reads filteredDeliveries, which isn't defined until this point in the
  // component body.
  const routeAssignOverwriteCount = (routeAssignPicker && routeAssignRouteId)
    ? filteredDeliveries.filter((d) => routeAssignPicker.deliveryIds.has(d.id) && d.route_id != null && d.route_id !== routeAssignRouteId).length
    : 0;

  const routeAssignWarning = routeAssignOverwriteCount > 0
    ? `${routeAssignOverwriteCount} of ${routeAssignPicker.deliveryIds.size} selected already ${routeAssignOverwriteCount === 1 ? 'has' : 'have'} a different route — applying this will replace it.`
    : null;

  // Group by date for section headers
  const getDateLabel = (dateStr) => formatShopDateLabel(dateStr, timezone);

  // Finding #5 (final whole-branch review, 2026-09-10): this whole grouping
  // computation used to run on every render — including the 60s `now` tick
  // (see the setInterval above), which re-renders the whole screen but never
  // changes the underlying data — rebuilding dateSections/routeSections/
  // riderSections from scratch against what can now be a 200-item page
  // (raised from 50 in an earlier fix round). Spec §4 explicitly calls for a
  // `useMemo` here. Deps: `filteredDeliveries`/`list.sort`/`effectiveViewMode`
  // per the spec's own (list.items, list.sort, viewMode) triple, PLUS
  // `atRiskIds` and `timezone` — both genuinely read inside this computation
  // (atRiskIds for the "Needs Attention" lead section, timezone via
  // extractLocalDate/getDateLabel for date-bucket keys/labels) and left out
  // of the spec's own dependency list; omitting either would leave the
  // at-risk section or date labels silently stale after an at-risk refetch
  // or a timezone setting change.
  const sections = useMemo(() => {
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
    return list.sort === 'urgency'
      ? [{ key: '_flat', title: null, data: filteredDeliveries, isAtRisk: false, isRoute: false }]
      : effectiveViewMode === 'route' ? routeSections
      : effectiveViewMode === 'rider' ? riderSections
      : dateSections;
  }, [filteredDeliveries, list.sort, effectiveViewMode, atRiskIds, timezone]);

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
    const isAtRisk = atRiskIds.has(item.id);
    const timeInfo = getTimeInfo(item);
    const canSelect = batchMode && ASSIGNABLE_STATUSES.includes(item.status);
    const isSelected = selectedIds.has(item.id);

    // Safe-action guard — a near-verbatim copy of OrdersInboxScreen.js's own
    // renderItem guard (not re-derived), adapted to this screen's
    // toSaleShape'd delivery rows. See resolvePreparerStep/resolveDeliverStep
    // (OrderCard.js) for the underlying rules this mirrors inline.
    const saleShaped = toSaleShape(item);
    const nextAction = saleShaped.display_stage?.nextAction;
    const needsPreparerPick = nextAction?.body?.status === 'preparing'
      && item.has_unassigned_open_task && user?.role !== 'employee';
    const needsCodCollect = nextAction?.endpoint?.endsWith('/deliver')
      && (Number(item.cod_amount || 0) - Number(item.cod_collected || 0)) > 0.01;
    // 'employee' viewer + an unassigned task: resolvePreparerStep's 'self'
    // case — still one tap, just needs assigned_to attached.
    const selfAssign = nextAction?.body?.status === 'preparing'
      && item.has_unassigned_open_task && user?.role === 'employee' && user?.id != null
      ? { assigned_to: user.id } : undefined;
    // Dead-end parity — a null nextAction means "advancing needs a human
    // decision," not "nothing can be done" (resolveDeadEnd's own doc comment).
    let deadEnd = !nextAction ? resolveDeadEnd(saleShaped, canManageDeliveries, canTakeMoney) : null;
    // Local downgrade for a viewer TaskCompletionModal's own fetch would
    // 403 (see canViewTasks above) — turns the button into a plain status
    // line instead of a route to a dead end. handleDeadEndPress below
    // already only dispatches for deadEnd.type === 'route', so this alone
    // is enough to stop the modal from opening for this role.
    if (deadEnd?.kind === 'finish_tasks' && !canViewTasks) {
      deadEnd = { type: 'status', text: `${deadEnd.label} — ask the counter` };
    }
    const isAdvancing = advancingId === item.id;

    const handleAdvance = async () => {
      // Guard against a double-tap firing this twice while the first call is
      // still in flight — see OrdersInboxScreen.js's identical guard for the
      // full reasoning (a second tap during the round trip would otherwise
      // hit the server's own transition guard and show a confusing error as
      // if the FIRST tap had failed).
      if (advancingId) return;
      setAdvancingId(item.id);
      try {
        await api.advanceOrder(nextAction, selfAssign);
        list.refresh();
      } catch (err) {
        showAlert('Could not update this order', err?.message || 'Please try again, or open the order to see what it needs.');
      } finally {
        setAdvancingId(null);
      }
    };

    const handlePress = () => {
      // Belt-and-suspenders alongside the render-side canSelect gate below:
      // this card is in "tap toggles selection" mode, so nothing here may
      // fire a real transition even if some future change ends up calling
      // this a second way.
      if (canSelect) return;
      if (needsPreparerPick) { openPreparerPicker(saleShaped); return; }
      if (needsCodCollect) { setCodCollectOrder(saleShaped); return; }
      handleAdvance();
    };

    // Dispatches a resolveDeadEnd 'route' kind. reattempt_delivery/
    // collect_payment/record_cod are plain navigation (same destinations
    // OrdersInboxScreen.js's identical handler sends these to); assign_rider
    // and finish_tasks open a modal instead. assign_rider routes through the
    // same consolidated rider picker single- and batch-assign both use
    // (Task 7) — a single-item Set makes handlePickRiderConsolidated take
    // the api.assignDelivery (not batch) branch. The label (sale number +
    // customer name, same format the deleted custom modal's subtitle used)
    // is only buildable here, where a single real order is in scope — the
    // batch bar's Assign Rider button (which calls openRiderPickerFor
    // directly, not via selectForBatch) passes no label.
    const handleDeadEndPress = () => {
      // Same belt-and-suspenders as handlePress above.
      if (canSelect) return;
      if (!deadEnd || deadEnd.type !== 'route') return;
      if (deadEnd.kind === 'assign_rider') {
        openRiderPickerFor(new Set([item.id]), `${item.sale_number} — ${item.customer_name || 'Customer'}`);
        return;
      }
      if (deadEnd.kind === 'finish_tasks') { setTaskCompletionOrder(saleShaped); return; }
      if (deadEnd.kind === 'reattempt_delivery') { navigation.navigate('DeliveryDetail', { deliveryId: item.id }); return; }
      if (deadEnd.kind === 'collect_payment') {
        const due = Number(item.grand_total || 0) - Number(item.total_paid || 0);
        navigation.navigate('AddPayment', { saleId: item.sale_id, due });
        return;
      }
      if (deadEnd.kind === 'record_cod') { navigation.navigate('Settlements'); }
    };

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

          <StageBadge stage={item.display_stage} size="sm" />
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
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation(); setExpandedItemsId((id) => (id === item.id ? null : item.id)); }}
            style={{ marginHorizontal: Spacing.md, marginTop: 8 }}
            // Collapsed content is one small text line, well under the
            // 44x44pt minimum tap target (staff-ux-checklist #7) — this
            // task's own two action buttons already have minHeight/minWidth
            // 44 for the same reason; this is the disclosure's equivalent.
            // Larger than this file's usual 8pt hitSlop since the text
            // itself is this small.
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Text style={{ fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' }}>
              {expandedItemsId === item.id ? '▾' : '▸'} {item.items.length} item{item.items.length !== 1 ? 's' : ''}
            </Text>
            {expandedItemsId === item.id && (
              <View style={{ marginTop: 8, backgroundColor: Colors.background, padding: 8, borderRadius: 6 }}>
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
          </TouchableOpacity>
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
        </View>

        <View style={styles.actionsRow}>
          {/* Gate is `batchMode`, not `canSelect` (fix-round finding —
              canSelect was one predicate too narrow: batchMode AND this
              card's status is in ASSIGNABLE_STATUSES). A card interleaved in
              the same route group whose status ISN'T assignable (e.g.
              picked_up/in_transit) still has batchMode true but canSelect
              false, and used to fall through to a live, unguarded
              actionBtn/deadEndBtn here — a mis-tap during a batch sweep would
              fire a real transition. The mutating action button is withheld
              for EVERY card while batchMode is true, regardless of canSelect;
              the plain-text status line stays visible even in batch mode —
              informational only, not mutating, no risk there. ContactButtons
              below stays live regardless — calling/WhatsApp is harmless
              mid-sweep. */}
          {batchMode ? (
            deadEnd?.type === 'status' ? (
              <Text style={styles.deadEndStatus}>{deadEnd.text}</Text>
            ) : (
              <View style={{ flex: 1 }} />
            )
          ) : nextAction ? (
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
          ) : deadEnd?.type === 'route' ? (
            <TouchableOpacity
              style={styles.deadEndBtn}
              onPress={(e) => { e.stopPropagation(); handleDeadEndPress(); }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.deadEndBtnText}>{deadEnd.label}</Text>
            </TouchableOpacity>
          ) : deadEnd?.type === 'status' ? (
            <Text style={styles.deadEndStatus}>{deadEnd.text}</Text>
          ) : <View style={{ flex: 1 }} />}
          <ContactButtons
            contacts={[
              { label: 'Customer', phone: item.customer_phone },
              { label: 'Rider', phone: item.partner_phone },
            ]}
            context={{
              type: item.status === 'in_transit' ? 'order_out_for_delivery' : 'general_inquiry',
              params: { sale_number: item.sale_number, location_name: item.location_name },
            }}
          />
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <OrderListToolbar
        search={list.search}
        onSearchChange={list.setSearch}
        // Subtract the two filters that are always auto-set rather than
        // user-chosen, mirroring OrdersInboxScreen.js's identical fix for
        // `status` (fix-round finding #3): `status` defaults to 'active' and
        // is never absent, so it always counted as "1 active filter" even
        // with nothing picked; `location_id` is auto-scoped for every
        // non-manager role (see fetchLocations above) with no drawer control
        // to even change it (FilterDrawer's Location section is
        // isManager-only, same flag used here), so it's not a user choice
        // for that audience either. For isManager, location_id stays a real,
        // user-changeable filter and is NOT subtracted.
        activeFilterCount={list.activeFilterCount - (list.filters.status ? 1 : 0) - (list.filters.location_id && !isManager ? 1 : 0)}
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
        // location_id is only included for isManager (fix-round finding #6)
        // — FilterDrawer's Location section below is gated to isManager
        // only, so a counter_staff/employee/delivery_partner viewer was
        // never shown a control for this filter in the first place, yet saw
        // a removable "Location: X" chip for it anyway. Removing that chip
        // would un-scope their view (the backend doesn't location-scope
        // those roles at all when location_id is omitted — only 'manager'),
        // so it must not be offered as something to remove. The underlying
        // list.filters.location_id sync (from selectedLocation, Task 3)
        // stays as-is — this only changes what's shown/removable here.
        filters={{ ...(isManager ? { location_id: list.filters.location_id } : {}), delivery_partner_id: list.filters.delivery_partner_id, date_from: list.filters.date_from, date_to: list.filters.date_to }}
        labels={{
          location_id: (v) => `Location: ${locations.find((l) => l.id === v)?.name || v}`,
          delivery_partner_id: (v) => `Rider: ${partners.find((p) => p.id === v)?.name || v}`,
          date_from: (v) => `From: ${v}`,
          date_to: (v) => `To: ${v}`,
        }}
        onRemove={(key) => {
          if (key === 'location_id') { setSelectedLocation(null); return; }
          list.setFilter(key, undefined);
          // Byproduct (final whole-branch review, 2026-09-10): removing a
          // date chip must also drop the drawer's own preset highlight
          // (Today/Yesterday/This Week), which otherwise stayed stale-active
          // even though the actual date_from/date_to filter had cleared.
          if (key === 'date_from' || key === 'date_to') setDateRangePreset(null);
        }}
        onClearAll={() => { if (isManager) setSelectedLocation(null); list.setFilter('delivery_partner_id', undefined); list.setFilter('date_from', undefined); list.setFilter('date_to', undefined); setDateRangePreset(null); }}
      />

      <FilterDrawer
        visible={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        onClearAll={() => { if (isManager) setSelectedLocation(null); list.setFilter('delivery_partner_id', undefined); list.setFilter('date_from', undefined); list.setFilter('date_to', undefined); setDateRangePreset(null); setFiltersOpen(false); }}
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
          <View style={{ flexDirection: 'row', gap: Spacing.sm, flexWrap: 'wrap' }}>
            <TouchableOpacity
              style={styles.batchAssignBtn}
              onPress={() => {
                if (selectedIds.size === 0) { showAlert('Info', 'Select at least one delivery'); return; }
                openRiderPickerFor(selectedIds);
              }}
            >
              <Ionicons name="people" size={16} color="#fff" />
              <Text style={styles.batchAssignText}>Assign Rider</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.batchAssignBtn}
              onPress={() => {
                if (selectedIds.size === 0) { showAlert('Info', 'Select at least one delivery'); return; }
                openRouteAssignModal(selectedIds);
              }}
            >
              <Ionicons name="map" size={16} color="#fff" />
              <Text style={styles.batchAssignText}>Assign Route</Text>
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

      {/* Fetch errors were previously invisible — a dropped/failed request
          just fell through to the plain "No deliveries found" empty state
          below, a false statement about live data (fix-round finding #2).
          Same error-banner + initial-load-spinner pattern as
          OrdersInboxScreen.js's identical block. */}
      {list.error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{list.error}</Text>
        </View>
      )}

      {/* List — grouped by route/date/rider (toggled above), or one flat
          urgency-ranked list with no grouping when sort==='urgency'. Was a
          SectionList; now a plain ScrollView of CollapsibleSections so each
          group can be independently collapsed/expanded (spec §4). */}
      {list.loading && list.items.length === 0 ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={Colors.primary} />
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} colors={[Colors.primary]} />}
          contentContainerStyle={{ padding: Spacing.md, paddingBottom: 100 }}
        >
          {filteredDeliveries.length === 0 ? (
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
      )}

      {/* Assign Delivery Partner — single-delivery (safe-action row / dead-end
          "Assign" tap) and batch ("Assign All" / "Select all in this route")
          share this one picker; handlePickRiderConsolidated picks
          api.assignDelivery vs api.batchAssignDeliveries by deliveryIds.size.
          Title/notice/meta copy matches OrdersInboxScreen.js's own
          openRiderPicker exactly (fix-round finding — was drifted, including
          raw-jargon "delivery_partner" role text) — batch's "Assign N
          Deliveries" has no Orders Inbox equivalent to match since that
          screen's picker is always single-item, so it stays as-is; the
          single-item title appends riderPicker.label (order identity) when
          the call site provided one, so a staff member always has an
          in-modal sanity check on which delivery they're assigning. */}
      <AssignPickerModal
        visible={riderPicker !== null}
        title={
          riderPicker?.deliveryIds?.size > 1
            ? `Assign ${riderPicker.deliveryIds.size} Deliveries`
            : riderPicker?.label ? `Assign Rider — ${riderPicker.label}` : 'Assign Rider'
        }
        notice={
          riderPicker?.loading ? null
            : riderPicker?.showingEveryone
              ? 'No riders set up at this location — showing everyone.'
              : (riderPicker?.people || []).length === 0
                ? 'No delivery partners yet. Ask the owner to add someone as a Delivery Rider.'
                : null
        }
        people={riderPicker?.people || []}
        loading={!!riderPicker?.loading}
        onPick={handlePickRiderConsolidated}
        onClose={closeRiderPicker}
      />

      {/* Assign Route — the Assign Rider counterpart. See RouteAssignModal.js's
          own header comment; this screen owns routeId/warning, the modal is
          a thin controlled shell around RoutePicker. */}
      <RouteAssignModal
        visible={routeAssignPicker !== null}
        deliveryCount={routeAssignPicker?.deliveryIds?.size || 0}
        routeId={routeAssignRouteId}
        onChangeRoute={setRouteAssignRouteId}
        warning={routeAssignWarning}
        locationId={selectedLocation}
        confirming={routeAssignConfirming}
        onConfirm={handleConfirmRouteAssign}
        onClose={closeRouteAssignModal}
      />

      {/* "Who is making this?" — Start Preparing when a real preparer needs
          picking (has_unassigned_open_task). Same shared component and
          fetch/write flow as OrdersInboxScreen.js's identical picker. */}
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
          flow as OrdersInboxScreen.js's identical modal. */}
      <CollectCodModal
        visible={codCollectOrder !== null}
        order={codCollectOrder}
        onClose={() => setCodCollectOrder(null)}
        onDone={() => { setCodCollectOrder(null); list.refresh(); }}
      />

      {/* Finish Tasks (resolveDeadEnd's 'finish_tasks' case) — a preparing
          order whose tasks aren't all done. Same shared component
          OrdersInboxScreen.js uses. */}
      <TaskCompletionModal
        visible={taskCompletionOrder !== null}
        order={taskCompletionOrder}
        onClose={() => setTaskCompletionOrder(null)}
        onDone={() => list.refresh()}
      />
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
  // Safe-action row (Task 6) — matches OrdersInboxScreen.js's actionsRow/
  // actionBtn/deadEndBtn/deadEndStatus styles exactly, so the same one-tap
  // pattern reads identically across both screens.
  actionsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border },
  actionBtn: { backgroundColor: Colors.primary, borderRadius: BorderRadius.md, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  actionBtnDisabled: { opacity: 0.6 },
  actionBtnText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.sm },
  deadEndBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 44, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.md, borderWidth: 1.5, borderColor: Colors.primary, backgroundColor: Colors.primary + '10' },
  deadEndBtnText: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.primary },
  deadEndStatus: { flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary, fontStyle: 'italic' },
  // AssignPickerModal's "Leave for now" escape hatch (matches
  // OrdersInboxScreen.js's identically-purposed style).
  pickerFallbackBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surfaceAlt, marginTop: 4 },
  pickerFallbackText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primary },
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
  // Matches OrdersInboxScreen.js's identical errorBanner/errorBannerText
  // (fix-round finding #2 — fetch errors were previously invisible here).
  errorBanner: { backgroundColor: Colors.error + '15', padding: Spacing.sm, marginHorizontal: Spacing.md, borderRadius: BorderRadius.md, marginTop: Spacing.xs },
  errorBannerText: { color: Colors.error, fontSize: FontSize.sm },
  urgentBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#FFF3E0', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  urgentText: { fontSize: 8, fontWeight: '800', color: '#FF6D00' },
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
