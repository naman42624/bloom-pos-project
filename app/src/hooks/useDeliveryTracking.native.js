import { useEffect, useRef, useCallback } from 'react';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { AppState, Platform } from 'react-native';
import api from '../services/api';

const LOCATION_TASK = 'BLOOMCART_DELIVERY_LOCATION_TASK';
const LOCATION_INTERVAL = 30000; // 30 seconds

// Register background location task at module level
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.error('Location task error:', error);
    return;
  }
  if (!data?.locations?.length) return;

  const location = data.locations[data.locations.length - 1]; // latest
  try {
    await api.recordDeliveryLocation({
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      accuracy: location.coords.accuracy,
      speed: location.coords.speed,
      heading: location.coords.heading,
      battery_level: null,
      is_moving: (location.coords.speed || 0) > 0.5 ? 1 : 0,
    });
  } catch (e) {
    console.error('Failed to record delivery location:', e);
  }
});

export default function useDeliveryTracking({ user, enabled = false, socketRef }) {
  const isTracking = useRef(false);
  const hasTriedRef = useRef(false);
  const foregroundSub = useRef(null);

  const startTracking = useCallback(async () => {
    if (!enabled || !user || user.role !== 'delivery_partner') return;
    if (isTracking.current || hasTriedRef.current) return;

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        hasTriedRef.current = true;
        return;
      }

      const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
      if (bgStatus !== 'granted') {
        console.warn('Background location not granted — delivery tracking requires "Always Allow" location permission');
        // Fall back to foreground-only watcher (no background task)
        if (socketRef?.current && !foregroundSub.current) {
          foregroundSub.current = await Location.watchPositionAsync(
            { accuracy: Location.Accuracy.High, timeInterval: LOCATION_INTERVAL, distanceInterval: 10 },
            (location) => {
              socketRef.current?.emit('location:update', {
                latitude: location.coords.latitude,
                longitude: location.coords.longitude,
                accuracy: location.coords.accuracy,
                speed: location.coords.speed,
                heading: location.coords.heading,
                is_moving: (location.coords.speed || 0) > 0.5,
              });
              // Also record via API in foreground
              api.recordDeliveryLocation({
                latitude: location.coords.latitude,
                longitude: location.coords.longitude,
                accuracy: location.coords.accuracy,
                speed: location.coords.speed,
                heading: location.coords.heading,
                battery_level: null,
                is_moving: (location.coords.speed || 0) > 0.5 ? 1 : 0,
              }).catch(() => {});
            }
          );
        }
        isTracking.current = true;
        hasTriedRef.current = true;
        return;
      }

      // Start background location updates (only with background permission)
      const isRegistered = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK);
      if (!isRegistered) {
        await Location.startLocationUpdatesAsync(LOCATION_TASK, {
          accuracy: Location.Accuracy.High,
          timeInterval: LOCATION_INTERVAL,
          distanceInterval: 10,
          foregroundService: Platform.OS === 'android' ? {
            notificationTitle: 'BloomCart Delivery',
            notificationBody: 'Tracking your location for delivery',
            notificationColor: '#E91E63',
          } : undefined,
          pausesUpdatesAutomatically: false,
          showsBackgroundLocationIndicator: true,
        });
      }

      // Also start foreground watcher for real-time Socket.io updates
      if (socketRef?.current && !foregroundSub.current) {
        foregroundSub.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: LOCATION_INTERVAL, distanceInterval: 10 },
          (location) => {
            socketRef.current?.emit('location:update', {
              latitude: location.coords.latitude,
              longitude: location.coords.longitude,
              accuracy: location.coords.accuracy,
              speed: location.coords.speed,
              heading: location.coords.heading,
              is_moving: (location.coords.speed || 0) > 0.5,
            });
          }
        );
      }

      isTracking.current = true;
      hasTriedRef.current = true;
    } catch (e) {
      console.error('Failed to start delivery tracking:', e);
      hasTriedRef.current = true;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, user?.id, user?.role]);

  const stopTracking = useCallback(async () => {
    try {
      const isRegistered = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK);
      if (isRegistered) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK);
      }
      if (foregroundSub.current) {
        foregroundSub.current.remove();
        foregroundSub.current = null;
      }
      isTracking.current = false;
      hasTriedRef.current = false;
    } catch (e) {
      console.error('Failed to stop delivery tracking:', e);
    }
  }, []);

  useEffect(() => {
    if (enabled && !hasTriedRef.current) startTracking();
    return () => { stopTracking(); };
  }, [enabled, startTracking, stopTracking]);

  return { isTracking: isTracking.current, startTracking, stopTracking };
}
