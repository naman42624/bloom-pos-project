/**
 * Offline Cache Layer
 *
 * Caches API responses in AsyncStorage for offline-first behavior.
 * Used for read-heavy data (products, settings, locations).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const CACHE_PREFIX = '@bloomcart_cache_';
const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get cached data if still valid, otherwise fetch from API
 * @param {string} key - Cache key
 * @param {Function} fetchFn - Async function to call if cache miss
 * @param {number} ttl - Cache TTL in milliseconds
 */
export async function cachedFetch(key, fetchFn, ttl = DEFAULT_TTL) {
  const cacheKey = `${CACHE_PREFIX}${key}`;

  try {
    const cached = await AsyncStorage.getItem(cacheKey);
    if (cached) {
      const { data, timestamp } = JSON.parse(cached);
      if (Date.now() - timestamp < ttl) {
        return data;
      }
    }
  } catch {
    // Cache read failed — proceed to fetch
  }

  try {
    const data = await fetchFn();
    // Store in cache
    await AsyncStorage.setItem(cacheKey, JSON.stringify({
      data,
      timestamp: Date.now(),
    }));
    return data;
  } catch (error) {
    // If fetch fails, try returning stale cache
    try {
      const cached = await AsyncStorage.getItem(cacheKey);
      if (cached) {
        const { data } = JSON.parse(cached);
        return data;
      }
    } catch {}
    throw error;
  }
}

/**
 * Invalidate a specific cache key
 */
export async function invalidateCache(key) {
  try {
    await AsyncStorage.removeItem(`${CACHE_PREFIX}${key}`);
  } catch {}
}

/**
 * Clear all cached data
 */
export async function clearAllCache() {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const cacheKeys = keys.filter(k => k.startsWith(CACHE_PREFIX));
    if (cacheKeys.length > 0) {
      await AsyncStorage.multiRemove(cacheKeys);
    }
  } catch {}
}
