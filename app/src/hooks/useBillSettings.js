// Bill settings (round-off, delivery GST rate, custom-item GST) from
// GET /api/settings/bill, so a screen's total matches what the server saves
// (both use utils/gst.js). Kept for the whole app session; refreshed each
// time a screen using it mounts.
import { useEffect, useState } from 'react';
import api from '../services/api';

const DEFAULTS = { round_off: false, delivery_rate: 18, default_rate: 0, default_hsn: null };
let cached = null;

export async function loadBillSettings() {
  try {
    const res = await api.getBillSettings();
    if (res && res.data) cached = { ...DEFAULTS, ...res.data };
  } catch (e) {
    // Keep the last good copy; the server refuses a payment above its total
  }
  return cached || DEFAULTS;
}

export default function useBillSettings() {
  const [settings, setSettings] = useState(cached || DEFAULTS);
  useEffect(() => {
    let alive = true;
    loadBillSettings().then((s) => { if (alive) setSettings(s); });
    return () => { alive = false; };
  }, []);
  return settings;
}
