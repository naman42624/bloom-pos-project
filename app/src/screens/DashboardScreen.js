import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const ROLE_LABELS = {
  owner: 'Owner',
  manager: 'Manager',
  employee: 'Employee',
  delivery_partner: 'Delivery Partner',
  customer: 'Customer',
};

const ROLE_COLORS = {
  owner: Colors.roleOwner,
  manager: Colors.roleManager,
  employee: Colors.roleEmployee,
  delivery_partner: Colors.roleDelivery,
  customer: Colors.roleCustomer,
};

function QuickAction({ icon, label, color, onPress }) {
  return (
    <TouchableOpacity style={styles.quickAction} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.quickActionIcon, { backgroundColor: color + '15' }]}>
        <Ionicons name={icon} size={24} color={color} />
      </View>
      <Text style={styles.quickActionLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function StatCard({ title, value, icon, color }) {
  return (
    <View style={styles.statCard}>
      <View style={[styles.statIconWrap, { backgroundColor: color + '15' }]}>
        <Ionicons name={icon} size={20} color={color} />
      </View>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statTitle}>{title}</Text>
    </View>
  );
}

export default function DashboardScreen({ navigation }) {
  const { user, activeLocation } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [locationCount, setLocationCount] = useState(0);
  const [myTasks, setMyTasks] = useState([]);
  const [prodStats, setProdStats] = useState(null);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [dashSummary, setDashSummary] = useState(null);
  const [urgentOrders, setUrgentOrders] = useState([]);
  const [atRiskOrders, setAtRiskOrders] = useState([]);
  const [reportKPIs, setReportKPIs] = useState(null);
  const role = user?.role;
  const isStaff = role === 'owner' || role === 'manager' || role === 'employee';
  const isManagerOrOwner = role === 'owner' || role === 'manager';

  const fetchDashboardData = useCallback(async () => {
    try {
      const response = await api.getLocations();
      setLocationCount(response.data?.locations?.length || 0);
    } catch {
      // non-critical
    }

    if (isStaff) {
      setTasksLoading(true);
      try {
        const promises = [
          api.getMyTasks(),
          api.getProductionStats({ user_id: user?.id }),
          api.getDashboardSummary(),
          api.getSales({ order_type: 'walk_in', status: 'preparing', limit: 10 }),
        ];
        if (isManagerOrOwner) {
          promises.push(api.getAtRiskOrders(activeLocation ? { location_id: activeLocation.id } : {}).catch(() => ({ data: [] })));
          promises.push(api.getReportsDashboard().catch(() => ({ data: null })));
        }
        const results = await Promise.all(promises);
        const [tasksRes, statsRes, summaryRes, urgentRes] = results;
        setMyTasks((tasksRes.data || []).filter(t => t.status !== 'completed' && t.status !== 'cancelled'));
        setProdStats(statsRes.data || null);
        setDashSummary(summaryRes.data || null);
        setUrgentOrders((urgentRes.data?.sales || []).slice(0, 5));
        if (isManagerOrOwner && results[4]) {
          setAtRiskOrders((results[4].data || []).slice(0, 5));
        }
        if (isManagerOrOwner && results[5]) {
          setReportKPIs(results[5].data || null);
        }
      } catch {}
      setTasksLoading(false);
    }

    setRefreshing(false);
  }, [isStaff, isManagerOrOwner, user?.id, activeLocation]);

  useFocusEffect(
    useCallback(() => {
      fetchDashboardData();
    }, [fetchDashboardData])
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchDashboardData();
  }, [fetchDashboardData]);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good Morning';
    if (hour < 17) return 'Good Afternoon';
    return 'Good Evening';
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[Colors.primary]} />}
    >
      {/* Welcome Header */}
      <View style={styles.welcomeCard}>
        <View style={styles.welcomeRow}>
          <View style={styles.welcomeText}>
            <Text style={styles.greeting}>{getGreeting()}</Text>
            <Text style={styles.userName}>{user?.name}</Text>
          </View>
          <View style={[styles.roleBadge, { backgroundColor: ROLE_COLORS[role] + '20' }]}>
            <Text style={[styles.roleText, { color: ROLE_COLORS[role] }]}>
              {ROLE_LABELS[role]}
            </Text>
          </View>
        </View>

        {activeLocation && (
          <View style={styles.locationRow}>
            <Ionicons name="location" size={14} color={Colors.primary} />
            <Text style={styles.locationText}>{activeLocation.name}</Text>
          </View>
        )}
      </View>

      {/* Revenue KPIs — Owner/Manager */}
      {isManagerOrOwner && reportKPIs && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Today's Revenue</Text>
            <TouchableOpacity onPress={() => navigation.navigate('More', { screen: 'Reports', initial: false })}>
              <Text style={styles.seeAll}>Full Reports</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.statsRow}>
            <StatCard
              title="Today"
              value={`₹${Math.round(reportKPIs.today?.revenue || 0).toLocaleString()}`}
              icon="trending-up"
              color={Colors.success}
            />
            <StatCard
              title="Orders"
              value={reportKPIs.today?.orders || 0}
              icon="receipt"
              color={Colors.primary}
            />
          </View>
          <View style={[styles.statsRow, { marginTop: Spacing.sm }]}>
            <StatCard
              title="Yesterday"
              value={`₹${Math.round(reportKPIs.yesterday?.revenue || 0).toLocaleString()}`}
              icon="time"
              color={Colors.info}
            />
            <StatCard
              title="This Week"
              value={`₹${Math.round(reportKPIs.week?.revenue || 0).toLocaleString()}`}
              icon="calendar"
              color="#9C27B0"
            />
          </View>
        </View>
      )}

      {/* Owner/Manager Quick Actions */}
      {(role === 'owner' || role === 'manager') && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
          <View style={styles.quickActions}>
            <QuickAction
              icon="qr-code"
              label="Scan QR"
              color="#00BCD4"
              onPress={() => navigation.navigate('Inventory', { screen: 'QRScanner' })}
            />
            <QuickAction
              icon="leaf"
              label="Inventory"
              color={Colors.success}
              onPress={() => navigation.navigate('Inventory')}
            />
            <QuickAction
              icon="gift"
              label="Products"
              color="#9C27B0"
              onPress={() => navigation.navigate('Inventory', { screen: 'Products' })}
            />
            <QuickAction
              icon="people"
              label="Staff"
              color={Colors.info}
              onPress={() => navigation.navigate('More', { screen: 'Staff', initial: false })}
            />
            <QuickAction
              icon="location"
              label="Locations"
              color={Colors.secondary}
              onPress={() => navigation.navigate('More', { screen: 'Locations', initial: false })}
            />
            <QuickAction
              icon="settings"
              label="Settings"
              color={Colors.warning}
              onPress={() => navigation.navigate('More', { screen: 'Settings', initial: false })}
            />
          </View>
        </View>
      )}

      {/* Employee quick actions */}
      {role === 'employee' && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
          <View style={styles.quickActions}>
            <QuickAction
              icon="qr-code"
              label="Scan QR"
              color="#00BCD4"
              onPress={() => navigation.navigate('Inventory', { screen: 'QRScanner' })}
            />
            <QuickAction
              icon="leaf"
              label="Inventory"
              color={Colors.success}
              onPress={() => navigation.navigate('Inventory')}
            />
            <QuickAction
              icon="construct"
              label="Produce"
              color="#9C27B0"
              onPress={() => navigation.navigate('POS', { initial: false, screen: 'ProduceProduct' })}
            />
            <QuickAction
              icon="list"
              label="My Tasks"
              color={Colors.info}
              onPress={() => navigation.navigate('POS', { initial: false, screen: 'ProductionQueue' })}
            />
          </View>
        </View>
      )}

      {/* Order Status Summary — All Staff */}
      {isStaff && dashSummary && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Orders Overview</Text>
            <TouchableOpacity onPress={() => navigation.navigate('POS', { initial: false, screen: 'ProductionQueue' })}>
              <Text style={styles.seeAll}>View All</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.orderSummaryRow}>
            <TouchableOpacity
              style={[styles.orderSummaryCard, { borderLeftColor: Colors.warning || '#FF9800' }]}
              onPress={() => navigation.navigate('POS', { initial: false, screen: 'ProductionQueue' })}
            >
              <Text style={[styles.orderSummaryCount, { color: Colors.warning || '#FF9800' }]}>{dashSummary.pending_orders}</Text>
              <Text style={styles.orderSummaryLabel}>Pending</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.orderSummaryCard, { borderLeftColor: '#2196F3' }]}
              onPress={() => navigation.navigate('POS', { initial: false, screen: 'ProductionQueue' })}
            >
              <Text style={[styles.orderSummaryCount, { color: '#2196F3' }]}>{dashSummary.preparing_orders}</Text>
              <Text style={styles.orderSummaryLabel}>Preparing</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.orderSummaryCard, { borderLeftColor: Colors.success }]}
              onPress={() => navigation.navigate('POS', { initial: false, screen: 'ProductionQueue' })}
            >
              <Text style={[styles.orderSummaryCount, { color: Colors.success }]}>{dashSummary.ready_orders}</Text>
              <Text style={styles.orderSummaryLabel}>Ready</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Action Items — Manager/Owner To-Do */}
      {isManagerOrOwner && dashSummary && (dashSummary.unassigned_tasks > 0 || dashSummary.material_shortages > 0 || dashSummary.pending_tasks > 0) && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Action Items</Text>
          {dashSummary.unassigned_tasks > 0 && (
            <TouchableOpacity
              style={styles.actionItemCard}
              onPress={() => navigation.navigate('POS', { initial: false, screen: 'ProductionQueue' })}
            >
              <View style={[styles.actionItemIcon, { backgroundColor: '#FF980020' }]}>
                <Ionicons name="people-outline" size={22} color={Colors.warning || '#FF9800'} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.actionItemTitle}>{dashSummary.unassigned_tasks} Unassigned Tasks</Text>
                <Text style={styles.actionItemDesc}>Tasks waiting to be assigned to staff</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />
            </TouchableOpacity>
          )}
          {dashSummary.material_shortages > 0 && (
            <TouchableOpacity
              style={styles.actionItemCard}
              onPress={() => navigation.navigate('Inventory')}
            >
              <View style={[styles.actionItemIcon, { backgroundColor: '#F4433620' }]}>
                <Ionicons name="warning-outline" size={22} color={Colors.error || '#F44336'} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.actionItemTitle}>{dashSummary.material_shortages} Material Shortages</Text>
                <Text style={styles.actionItemDesc}>Materials needed for pending orders are low</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />
            </TouchableOpacity>
          )}
          {dashSummary.pending_tasks > 0 && (
            <TouchableOpacity
              style={styles.actionItemCard}
              onPress={() => navigation.navigate('POS', { initial: false, screen: 'ProductionQueue' })}
            >
              <View style={[styles.actionItemIcon, { backgroundColor: Colors.primary + '20' }]}>
                <Ionicons name="construct-outline" size={22} color={Colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.actionItemTitle}>{dashSummary.pending_tasks} Active Production Tasks</Text>
                <Text style={styles.actionItemDesc}>Items waiting to be produced</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* At-Risk Orders — Manager/Owner: deliveries/pickups not ready near scheduled time */}
      {isManagerOrOwner && atRiskOrders.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="warning" size={18} color="#FF6D00" />
              <Text style={[styles.sectionTitle, { color: '#FF6D00' }]}>At Risk</Text>
            </View>
            <TouchableOpacity onPress={() => navigation.navigate('Orders', { initial: false, screen: 'DeliveriesList' })}>
              <Text style={styles.seeAll}>View All</Text>
            </TouchableOpacity>
          </View>
          {atRiskOrders.map((order) => (
            <TouchableOpacity
              key={`risk-${order.delivery_id || order.sale_id}`}
              style={[styles.actionItemCard, { borderLeftWidth: 3, borderLeftColor: '#FF6D00' }]}
              onPress={() => {
                if (order.type === 'delivery' && order.delivery_id) {
                  navigation.navigate('Orders', { initial: false, screen: 'DeliveryDetail', params: { deliveryId: order.delivery_id } });
                } else {
                  navigation.navigate('Orders', { initial: false, screen: 'SaleDetail', params: { saleId: order.sale_id } });
                }
              }}
            >
              <View style={[styles.actionItemIcon, { backgroundColor: '#FFF3E0' }]}>
                <Ionicons name={order.type === 'delivery' ? 'bicycle' : 'bag-handle'} size={20} color="#FF6D00" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.actionItemTitle}>{order.sale_number}</Text>
                <Text style={styles.actionItemDesc}>
                  {order.type === 'delivery' ? 'Delivery' : 'Pickup'} • Not ready • {order.scheduled_time || order.scheduled_date}
                </Text>
              </View>
              <View style={[styles.lateChip]}>
                <Text style={styles.lateChipText}>LATE</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Urgent Walk-in Orders — All Staff */}
      {isStaff && urgentOrders.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="flash" size={18} color={Colors.primary} />
              <Text style={styles.sectionTitle}>Urgent Walk-in Orders</Text>
            </View>
            <TouchableOpacity onPress={() => navigation.navigate('POS', { initial: false, screen: 'ProductionQueue' })}>
              <Text style={styles.seeAll}>View All</Text>
            </TouchableOpacity>
          </View>
          {urgentOrders.map((order) => (
            <TouchableOpacity
              key={`urgent-${order.id}`}
              style={[styles.taskCard, styles.taskUrgent]}
              onPress={() => navigation.navigate('POS', { initial: false, screen: 'SaleDetail', params: { saleId: order.id } })}
            >
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={styles.taskProduct}>{order.sale_number}</Text>
                  <View style={styles.urgentBadge}>
                    <Ionicons name="flash" size={8} color="#FF6D00" />
                    <Text style={{ fontSize: 7, fontWeight: '800', color: '#FF6D00' }}>WALK-IN</Text>
                  </View>
                </View>
                <Text style={styles.taskMeta}>
                  {order.customer_name || 'Walk-in'} • ₹{(order.grand_total || 0).toFixed(0)} • Preparing
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={Colors.textLight} />
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Your Tasks Today — Staff */}
      {isStaff && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Your Tasks</Text>
            <TouchableOpacity onPress={() => navigation.navigate('POS', { initial: false, screen: 'ProductionQueue' })}>
              <Text style={styles.seeAll}>View Queue</Text>
            </TouchableOpacity>
          </View>
          {tasksLoading ? (
            <ActivityIndicator color={Colors.primary} style={{ paddingVertical: Spacing.lg }} />
          ) : myTasks.length === 0 ? (
            <View style={styles.emptyTasks}>
              <Ionicons name="checkmark-done-circle-outline" size={32} color={Colors.textLight} />
              <Text style={styles.emptyTasksText}>No pending tasks</Text>
            </View>
          ) : (
            myTasks.slice(0, 5).map((task) => {
              const statusColors = {
                pending: Colors.warning || '#FF9800',
                assigned: '#2196F3',
                in_progress: Colors.primary,
              };
              return (
                <View key={task.id} style={[styles.taskCard, task.priority === 'urgent' && styles.taskUrgent]}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={styles.taskProduct}>{task.quantity}x {task.product_name}</Text>
                      {task.priority === 'urgent' && (
                        <View style={styles.urgentBadge}>
                          <Ionicons name="flash" size={8} color="#FF6D00" />
                          <Text style={{ fontSize: 7, fontWeight: '800', color: '#FF6D00' }}>URGENT</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.taskMeta}>{task.sale_number} • {task.order_type?.replace('_', ' ')}</Text>
                  </View>
                  <View style={[styles.taskStatus, { backgroundColor: (statusColors[task.status] || Colors.textLight) + '20' }]}>
                    <Text style={[styles.taskStatusText, { color: statusColors[task.status] || Colors.textLight }]}>
                      {task.status?.replace('_', ' ')}
                    </Text>
                  </View>
                </View>
              );
            })
          )}
        </View>
      )}

      {/* Production Stats — Staff */}
      {isStaff && prodStats && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Your Production</Text>
          <View style={styles.statsRow}>
            <StatCard
              title="Items Made"
              value={prodStats.byEmployee?.[0]?.total_produced || 0}
              icon="construct"
              color={Colors.primary}
            />
            <StatCard
              title="Products"
              value={prodStats.byEmployee?.[0]?.unique_products || 0}
              icon="gift"
              color="#9C27B0"
            />
          </View>
        </View>
      )}

      {/* Overview — Non-owner sees location count & role */}
      {!isManagerOrOwner && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Overview</Text>
          <View style={styles.statsRow}>
            <StatCard title="Locations" value={locationCount} icon="storefront" color={Colors.secondary} />
            <StatCard title="Role" value={ROLE_LABELS[role]} icon="shield" color={Colors.info} />
          </View>
        </View>
      )}

      {/* Quick Checkout Floating Action Button */}
      {(isManagerOrOwner || user?.role === 'employee') && (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => navigation.navigate('POS', { screen: 'QuickCheckout' })}
          activeOpacity={0.8}
        >
          <Ionicons name="flash" size={24} color={Colors.white} />
          <Text style={styles.fabText}>Quick</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, paddingBottom: Spacing.xxl },

  welcomeCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.03,
    shadowRadius: 4,
    elevation: 1,
  },
  welcomeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  welcomeText: { flex: 1 },
  greeting: { fontSize: FontSize.sm, color: Colors.textSecondary },
  userName: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text, marginTop: 2 },
  roleBadge: { paddingHorizontal: Spacing.sm + 2, paddingVertical: Spacing.xs, borderRadius: BorderRadius.full },
  roleText: { fontSize: FontSize.xs, fontWeight: '600' },
  locationRow: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.sm, gap: 4 },
  locationText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '500' },

  section: { marginBottom: Spacing.lg },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.text, marginBottom: Spacing.md },

  quickActions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  quickAction: { alignItems: 'center', width: 84 },
  quickActionIcon: {
    width: 64,
    height: 64,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.xs,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.04, shadowRadius: 6, elevation: 2,
  },
  quickActionLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600', textAlign: 'center' },

  statsRow: { flexDirection: 'row', gap: Spacing.md },
  statCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    padding: Spacing.lg,
    alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.04, shadowRadius: 8, elevation: 2,
  },
  statIconWrap: { width: 44, height: 44, borderRadius: BorderRadius.md, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.sm },
  statValue: { fontSize: FontSize.xxl, fontWeight: '800', color: Colors.text },
  statTitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4, fontWeight: '600' },

  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.md,
  },
  seeAll: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '600' },

  emptyTasks: { alignItems: 'center', paddingVertical: Spacing.lg },
  emptyTasksText: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: Spacing.xs },

  taskCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.sm, marginBottom: Spacing.xs,
    borderWidth: 1, borderColor: Colors.border,
  },
  taskUrgent: { borderColor: '#FF6D00', borderWidth: 2 },
  taskProduct: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  taskMeta: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 1 },
  urgentBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    backgroundColor: '#FFF3E0', paddingHorizontal: 5, paddingVertical: 1,
    borderRadius: BorderRadius.sm,
  },
  taskStatus: {
    paddingHorizontal: Spacing.sm, paddingVertical: 3, borderRadius: BorderRadius.full,
  },
  taskStatusText: { fontSize: 10, fontWeight: '600', textTransform: 'capitalize' },

  // Order summary cards
  orderSummaryRow: { flexDirection: 'row', gap: Spacing.md },
  orderSummaryCard: {
    flex: 1, backgroundColor: Colors.surface, borderRadius: BorderRadius.xl,
    padding: Spacing.md, paddingVertical: Spacing.lg, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.03, shadowRadius: 6, elevation: 2,
  },
  orderSummaryCount: { fontSize: FontSize.hero || 42, fontWeight: '800' },
  orderSummaryLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '700', marginTop: 4 },

  // Action items
  actionItemCard: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.xl,
    padding: Spacing.md, marginBottom: Spacing.md,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.03, shadowRadius: 6, elevation: 2,
  },
  actionItemIcon: {
    width: 54, height: 54, borderRadius: BorderRadius.md,
    justifyContent: 'center', alignItems: 'center',
  },
  actionItemDesc: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  actionItemTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  lateChip: { backgroundColor: '#FFF3E0', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  lateChipText: { fontSize: 9, fontWeight: '800', color: '#FF6D00' },

  fab: {
    position: 'absolute', bottom: 20, right: 20, width: 64, height: 64, borderRadius: 32,
    backgroundColor: '#FF3D00', justifyContent: 'center', alignItems: 'center',
    shadowColor: '#FF3D00', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 6,
  },
  fabText: { fontSize: 10, fontWeight: '800', color: Colors.white, marginTop: -2 },
});
