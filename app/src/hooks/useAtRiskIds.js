// At-risk delivery/pickup detection for the Deliveries screen's lead
// section — structurally identical to useSessionsForDates.js's resetToken
// pattern (see that file's header comment for the full reasoning: this
// screen never unmounts on a focus loss/regain, so a plain dependency-array
// fetch would never refresh once mounted). See
// docs/superpowers/specs/2026-09-10-deliveries-redesign-design.md §3.
import { useState, useEffect } from 'react';
import api from '../services/api';

export default function useAtRiskIds(locationId, resetToken, enabled = true) {
  const [atRiskIds, setAtRiskIds] = useState(new Set());

  useEffect(() => {
    // `enabled` (final whole-branch review byproduct, 2026-09-10): lets a
    // caller skip the fetch entirely for a viewer who'd always 403 anyway
    // (e.g. delivery_partner on DeliveriesScreen — harmless today since a
    // 403 resolves to an empty Set either way, but this avoids firing a
    // request that can never succeed). Defaults to true so every other/
    // future caller behaves exactly as before.
    if (!enabled) { setAtRiskIds(new Set()); return; }
    let cancelled = false;
    api.getAtRiskOrders(locationId ? { location_id: locationId } : {})
      .then((res) => {
        if (cancelled) return;
        const ids = new Set();
        for (const row of res.data || []) {
          if (row.delivery_id) ids.add(row.delivery_id);
        }
        setAtRiskIds(ids);
      })
      .catch(() => { if (!cancelled) setAtRiskIds(new Set()); });
    return () => { cancelled = true; };
  }, [locationId, resetToken, enabled]);

  return { atRiskIds };
}
