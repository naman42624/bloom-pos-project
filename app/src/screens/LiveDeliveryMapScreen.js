import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  ScrollView, RefreshControl, Platform, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { MapView, Marker } from '../components/MapViewWrapper';

const { width } = Dimensions.get('window');

function timeSince(dateStr) {
  if (!dateStr) return 'Unknown';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

export default function LiveDeliveryMapScreen() {
  const [loading, setLoading] = useState(true);
  const [partners, setPartners] = useState([]);
  const [selectedPartner, setSelectedPartner] = useState(null);
  const [dailySummary, setDailySummary] = useState([]);
  const [viewMode, setViewMode] = useState('map'); // 'map' or 'list'
  const mapRef = useRef(null);
  const refreshInterval = useRef(null);

  const fetchPartners = useCallback(async () => {
    try {
      const [partnersRes, summaryRes] = await Promise.all([
        api.getActiveDeliveryPartners(),
        api.getDeliveryDailySummary(),
      ]);
      setPartners(partnersRes.data?.partners || []);
      setDailySummary(summaryRes.data || []);
    } catch (e) {
      console.error('Fetch delivery partners error:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    fetchPartners();
    // Auto-refresh every 30 seconds
    refreshInterval.current = setInterval(fetchPartners, 30000);
    return () => {
      if (refreshInterval.current) clearInterval(refreshInterval.current);
    };
  }, [fetchPartners]));

  const fitToPartners = useCallback(() => {
    if (!mapRef.current || partners.length === 0) return;
    const coords = partners
      .filter(p => p.latitude && p.longitude)
      .map(p => ({ latitude: Number(p.latitude), longitude: Number(p.longitude) }));
    if (coords.length > 0) {
      mapRef.current.fitToCoordinates(coords, {
        edgePadding: { top: 50, right: 50, bottom: 50, left: 50 },
        animated: true,
      });
    }
  }, [partners]);

  const activePartners = partners.filter(p => p.latitude && p.longitude);
  const noLocationPartners = partners.filter(p => !p.latitude || !p.longitude);

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color={Colors.primary} /></View>;
  }

  return (
    <View style={styles.container}>
      {/* Toggle */}
      <View style={styles.toggleRow}>
        <TouchableOpacity
          style={[styles.toggleBtn, viewMode === 'map' && styles.toggleBtnActive]}
          onPress={() => setViewMode('map')}
        >
          <Ionicons name="map" size={18} color={viewMode === 'map' ? '#fff' : Colors.textSecondary} />
          <Text style={[styles.toggleText, viewMode === 'map' && styles.toggleTextActive]}>Map</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggleBtn, viewMode === 'list' && styles.toggleBtnActive]}
          onPress={() => setViewMode('list')}
        >
          <Ionicons name="list" size={18} color={viewMode === 'list' ? '#fff' : Colors.textSecondary} />
          <Text style={[styles.toggleText, viewMode === 'list' && styles.toggleTextActive]}>List</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <View style={styles.countBadge}>
          <Text style={styles.countText}>{activePartners.length} active</Text>
        </View>
      </View>

      {viewMode === 'map' ? (
        <View style={styles.mapContainer}>
          {MapView && activePartners.length > 0 ? (
            <MapView
              ref={mapRef}
              style={styles.map}
              onMapReady={fitToPartners}
              showsUserLocation={false}
              showsMyLocationButton={false}
            >
              {activePartners.map(p => (
                <Marker
                  key={p.user_id}
                  coordinate={{ latitude: Number(p.latitude), longitude: Number(p.longitude) }}
                  title={p.user_name}
                  description={`${p.is_moving ? 'Moving' : 'Idle'} • ${timeSince(p.recorded_at)}`}
                  onPress={() => setSelectedPartner(p)}
                >
                  <View style={[styles.markerDot, p.is_moving ? styles.markerMoving : styles.markerIdle]}>
                    <Ionicons name="bicycle" size={16} color="#fff" />
                  </View>
                </Marker>
              ))}
            </MapView>
          ) : (
            <View style={styles.noMap}>
              <Ionicons name="map-outline" size={48} color={Colors.textLight} />
              <Text style={styles.noMapText}>
                {!MapView ? 'Map not available on this platform' :
                  activePartners.length === 0 ? 'No active delivery partners' : 'Loading map...'}
              </Text>
            </View>
          )}

          <TouchableOpacity style={styles.fitBtn} onPress={fitToPartners}>
            <Ionicons name="locate" size={22} color={Colors.primary} />
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          style={styles.listContainer}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={false} onRefresh={fetchPartners} colors={[Colors.primary]} />}
        >
          {/* Active partners with location */}
          {activePartners.map(p => {
            const summary = dailySummary.find(s => s.user_id === p.user_id);
            return (
              <View key={p.user_id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <View style={[styles.statusDot, p.is_moving ? styles.dotMoving : styles.dotIdle]} />
                  <View style={{ flex: 1, marginLeft: Spacing.sm }}>
                    <Text style={styles.cardName}>{p.user_name}</Text>
                    <Text style={styles.cardMeta}>
                      {p.is_moving ? 'Moving' : 'Idle'} • Last seen {timeSince(p.recorded_at)}
                    </Text>
                  </View>
                  {p.speed > 0 && (
                    <View style={styles.speedBadge}>
                      <Text style={styles.speedText}>{Math.round(p.speed * 3.6)} km/h</Text>
                    </View>
                  )}
                </View>
                {summary && (
                  <View style={styles.cardStats}>
                    <View style={styles.stat}>
                      <Text style={styles.statValue}>{summary.total_deliveries || 0}</Text>
                      <Text style={styles.statLabel}>Deliveries</Text>
                    </View>
                    <View style={styles.stat}>
                      <Text style={styles.statValue}>{(summary.total_distance_km || 0).toFixed(1)}</Text>
                      <Text style={styles.statLabel}>km</Text>
                    </View>
                    <View style={styles.stat}>
                      <Text style={styles.statValue}>{Math.round(summary.total_active_minutes || 0)}</Text>
                      <Text style={styles.statLabel}>Active min</Text>
                    </View>
                    <View style={styles.stat}>
                      <Text style={styles.statValue}>{Math.round(summary.total_idle_minutes || 0)}</Text>
                      <Text style={styles.statLabel}>Idle min</Text>
                    </View>
                  </View>
                )}
                {p.active_delivery && (
                  <View style={styles.deliveryInfo}>
                    <Ionicons name="cube-outline" size={14} color={Colors.primary} />
                    <Text style={styles.deliveryText}>
                      Active delivery #{p.active_delivery.id} — {p.active_delivery.status}
                    </Text>
                  </View>
                )}
              </View>
            );
          })}

          {/* Partners without location */}
          {noLocationPartners.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>No Location Data</Text>
              {noLocationPartners.map(p => (
                <View key={p.user_id} style={[styles.card, { opacity: 0.6 }]}>
                  <View style={styles.cardHeader}>
                    <View style={[styles.statusDot, { backgroundColor: Colors.textLight }]} />
                    <View style={{ flex: 1, marginLeft: Spacing.sm }}>
                      <Text style={styles.cardName}>{p.user_name || `Partner #${p.user_id}`}</Text>
                      <Text style={styles.cardMeta}>Location not available</Text>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          )}

          {partners.length === 0 && (
            <View style={styles.empty}>
              <Ionicons name="bicycle-outline" size={48} color={Colors.textLight} />
              <Text style={styles.emptyText}>No delivery partners active today</Text>
            </View>
          )}
        </ScrollView>
      )}

      {/* Selected partner bottom card */}
      {viewMode === 'map' && selectedPartner && (
        <View style={styles.bottomCard}>
          <TouchableOpacity style={styles.bottomClose} onPress={() => setSelectedPartner(null)}>
            <Ionicons name="close" size={20} color={Colors.textSecondary} />
          </TouchableOpacity>
          <Text style={styles.bottomName}>{selectedPartner.user_name}</Text>
          <Text style={styles.bottomMeta}>
            {selectedPartner.is_moving ? 'Moving' : 'Idle'} • {timeSince(selectedPartner.recorded_at)}
          </Text>
          {selectedPartner.speed > 0 && (
            <Text style={styles.bottomSpeed}>{Math.round(selectedPartner.speed * 3.6)} km/h</Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', padding: Spacing.sm,
    backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  toggleBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.md, marginRight: Spacing.xs,
  },
  toggleBtnActive: { backgroundColor: Colors.primary },
  toggleText: { fontSize: FontSize.sm, color: Colors.textSecondary, marginLeft: 4 },
  toggleTextActive: { color: '#fff', fontWeight: '600' },
  countBadge: {
    backgroundColor: Colors.successLight, paddingHorizontal: Spacing.sm, paddingVertical: 2,
    borderRadius: BorderRadius.sm,
  },
  countText: { fontSize: FontSize.xs, color: Colors.secondary, fontWeight: '600' },
  // Map
  mapContainer: { flex: 1 },
  map: { flex: 1 },
  noMap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  noMapText: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.md, textAlign: 'center' },
  markerDot: {
    width: 32, height: 32, borderRadius: 16,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, elevation: 4,
  },
  markerMoving: { backgroundColor: Colors.secondary },
  markerIdle: { backgroundColor: Colors.warning },
  fitBtn: {
    position: 'absolute', bottom: Spacing.lg, right: Spacing.md,
    backgroundColor: Colors.surface, borderRadius: 25, width: 44, height: 44,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 4, elevation: 3,
  },
  // List
  listContainer: { flex: 1 },
  listContent: { padding: Spacing.md },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    marginBottom: Spacing.sm, borderWidth: 1, borderColor: Colors.border, overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row', alignItems: 'center', padding: Spacing.md,
  },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  dotMoving: { backgroundColor: Colors.secondary },
  dotIdle: { backgroundColor: Colors.warning },
  cardName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  cardMeta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 },
  speedBadge: {
    backgroundColor: Colors.infoLight, paddingHorizontal: Spacing.sm, paddingVertical: 2,
    borderRadius: BorderRadius.sm,
  },
  speedText: { fontSize: FontSize.xs, color: Colors.info, fontWeight: '600' },
  cardStats: {
    flexDirection: 'row', borderTopWidth: 1, borderTopColor: Colors.border,
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md,
  },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  statLabel: { fontSize: FontSize.xs, color: Colors.textLight, marginTop: 2 },
  deliveryInfo: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingBottom: Spacing.sm,
  },
  deliveryText: { fontSize: FontSize.sm, color: Colors.primary, marginLeft: 4 },
  section: { marginTop: Spacing.md },
  sectionTitle: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.sm },
  empty: { alignItems: 'center', paddingVertical: Spacing.xl },
  emptyText: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: Spacing.md },
  // Bottom card
  bottomCard: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.lg, borderTopRightRadius: BorderRadius.lg,
    padding: Spacing.lg, paddingTop: Spacing.md,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, elevation: 8,
  },
  bottomClose: { position: 'absolute', top: Spacing.sm, right: Spacing.sm },
  bottomName: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  bottomMeta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  bottomSpeed: { fontSize: FontSize.sm, color: Colors.info, marginTop: 4, fontWeight: '600' },
});
