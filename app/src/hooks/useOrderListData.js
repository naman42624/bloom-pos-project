// Shared list-data hook for Orders Inbox / Deliveries / Pickup Orders —
// centralizes debounced search, filter state, real offset pagination, and
// the request-race protection OrdersInboxScreen already did well on its
// own (a fast typist firing three searches must not let an earlier, slower
// response overwrite a later, faster one).
import { useState, useRef, useCallback, useEffect } from 'react';

const SEARCH_DEBOUNCE_MS = 300;

// Single source of truth for "how many filters are active" — the number
// shown on OrderListToolbar's Filters button badge. Colocated here (not
// re-derived per screen) so every future consumer of this hook lands on
// the same count rather than each screen writing its own copy — the exact
// "two divergent calculations for one conceptual value" bug pattern this
// codebase has already had to fix repeatedly in its register/settlement
// math (see CLAUDE.md's "Known structural debt").
function countActiveFilters(filters) {
  return Object.values(filters || {}).filter((v) => v !== undefined && v !== null && v !== '').length;
}

export default function useOrderListData(fetchFn, { pageSize = 50 } = {}) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearchState] = useState('');
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState(null); // null = server default; e.g. 'urgency' when opted in

  const requestIdRef = useRef(0);
  const searchTimerRef = useRef(null);
  const offsetRef = useRef(0);
  // "Latest ref" pattern (fixes a stale-closure bug found in task review):
  // the debounce timer below is scheduled once and fires later, after
  // possibly several more renders (and possibly several more keystrokes)
  // have happened. A setTimeout callback that calls a useCallback-memoized
  // function captures whichever version of that function existed AT
  // SCHEDULE TIME, not fire time — so without this ref, a fetch fired by
  // the debounce timer would use the search text as it was one keystroke
  // ago, not the text the timer was actually scheduled in response to.
  // searchValueRef always holds the most recently *requested* search text
  // (set synchronously in setSearch below), independent of React's render
  // cycle, so the timer reads the true latest value at fire time.
  const searchValueRef = useRef('');

  const runFetch = useCallback((append, opts = {}) => {
    const myRequestId = ++requestIdRef.current;
    if (!append && !opts.silent) setLoading(true);
    const offset = append ? offsetRef.current : 0;
    const merged = { ...filters, search: searchValueRef.current, limit: pageSize, offset, ...(sort ? { sort } : {}) };
    // A "removed" filter (ActiveFilterChips's onRemove calls setFilter(key,
    // undefined)) must leave that key entirely absent from the outgoing
    // request, not present with value undefined — URLSearchParams would
    // otherwise serialize it to the literal string "undefined", which the
    // server matches as a real (non-matching) filter value, zeroing out
    // results. Confirmed live: GET /sales?limit=3&status=undefined -> total:
    // 0 vs total: 227 without it.
    const params = Object.fromEntries(
      Object.entries(merged).filter(([, v]) => v !== undefined && v !== null && v !== '')
    );

    return fetchFn(params).then(({ items: newItems, total: newTotal }) => {
      if (myRequestId !== requestIdRef.current) return; // a newer request already landed
      setItems((prev) => (append ? [...prev, ...newItems] : newItems));
      setTotal(newTotal);
      offsetRef.current = offset + newItems.length;
      setError(null);
      setLoading(false);
      setRefreshing(false);
    }).catch((err) => {
      if (myRequestId !== requestIdRef.current) return; // a superseded request's error must not overwrite a later request's state
      setError(err?.message || 'Could not load orders. Pull down to try again.');
      setLoading(false);
      setRefreshing(false);
    });
  }, [fetchFn, filters, sort, pageSize]); // search intentionally NOT a dependency — runFetch reads searchValueRef.current instead, so it no longer needs to be recreated (and stale-closed-over) on every keystroke

  // Latest-ref for runFetch itself, for the same stale-closure reason as
  // searchValueRef above: the debounce timer must call whichever runFetch
  // is current AT FIRE TIME (reflecting the latest filters/sort/fetchFn),
  // not whichever version existed when the timer was scheduled.
  const runFetchRef = useRef(runFetch);
  useEffect(() => { runFetchRef.current = runFetch; });

  useEffect(() => {
    offsetRef.current = 0;
    runFetch(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, sort]);

  const setSearch = useCallback((value) => {
    searchValueRef.current = value;
    setSearchState(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      offsetRef.current = 0;
      runFetchRef.current(false);
    }, SEARCH_DEBOUNCE_MS);
  }, []);

  const setFilter = useCallback((key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  const clearFilters = useCallback(() => setFilters({}), []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    offsetRef.current = 0;
    runFetch(false, { silent: true });
  }, [runFetch]);

  const loadMore = useCallback(() => {
    if (loading || items.length >= total) return;
    runFetch(true);
  }, [loading, items.length, total, runFetch]);

  const hasMore = items.length < total;

  return {
    items, loading, refreshing, error, total, hasMore, loadMore, refresh,
    search, setSearch, filters, setFilter, clearFilters, sort, setSort,
    activeFilterCount: countActiveFilters(filters),
  };
}
