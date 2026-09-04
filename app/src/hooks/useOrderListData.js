// Shared list-data hook for Orders Inbox / Deliveries / Pickup Orders —
// centralizes debounced search, filter state, real offset pagination, and
// the request-race protection OrdersInboxScreen already did well on its
// own (a fast typist firing three searches must not let an earlier, slower
// response overwrite a later, faster one).
import { useState, useRef, useCallback, useEffect } from 'react';

const SEARCH_DEBOUNCE_MS = 300;

export default function useOrderListData(fetchFn, { pageSize = 50 } = {}) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearchState] = useState('');
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState(null); // null = server default; e.g. 'urgency' when opted in

  const requestIdRef = useRef(0);
  const searchTimerRef = useRef(null);
  const offsetRef = useRef(0);

  const runFetch = useCallback((append) => {
    const myRequestId = ++requestIdRef.current;
    if (!append) setLoading(true);
    const offset = append ? offsetRef.current : 0;
    const params = { ...filters, search, limit: pageSize, offset, ...(sort ? { sort } : {}) };

    return fetchFn(params).then(({ items: newItems, total: newTotal }) => {
      if (myRequestId !== requestIdRef.current) return; // a newer request already landed
      setItems((prev) => (append ? [...prev, ...newItems] : newItems));
      setTotal(newTotal);
      offsetRef.current = offset + newItems.length;
      setLoading(false);
      setRefreshing(false);
    }).catch(() => {
      if (myRequestId !== requestIdRef.current) return;
      setLoading(false);
      setRefreshing(false);
    });
  }, [fetchFn, filters, search, sort, pageSize]);

  useEffect(() => {
    offsetRef.current = 0;
    runFetch(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, sort]);

  const setSearch = useCallback((value) => {
    setSearchState(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      offsetRef.current = 0;
      runFetch(false);
    }, SEARCH_DEBOUNCE_MS);
  }, [runFetch]);

  const setFilter = useCallback((key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  const clearFilters = useCallback(() => setFilters({}), []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    offsetRef.current = 0;
    runFetch(false);
  }, [runFetch]);

  const loadMore = useCallback(() => {
    if (loading || items.length >= total) return;
    runFetch(true);
  }, [loading, items.length, total, runFetch]);

  const hasMore = items.length < total;

  return { items, loading, refreshing, total, hasMore, loadMore, refresh, search, setSearch, filters, setFilter, clearFilters, sort, setSort };
}
