// Web fallback — delivery tracking is not supported on web
export default function useDeliveryTracking() {
  const noop = () => {};
  return { isTracking: false, startTracking: noop, stopTracking: noop };
}
