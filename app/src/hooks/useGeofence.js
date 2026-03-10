// Web fallback — geofencing is not supported on web
import { useRef } from 'react';

export default function useGeofence() {
  const noop = () => {};
  return { isMonitoring: false, startGeofencing: noop, stopGeofencing: noop };
}
