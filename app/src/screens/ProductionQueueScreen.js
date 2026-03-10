import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, FlatList, SectionList, TouchableOpacity,
  ActivityIndicator, RefreshControl, Alert, ScrollView, Modal, TextInput, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';

const TASK_STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'completed', label: 'Done' },
];

const TASK_STATUS_CONFIG = {
  pending: { color: Colors.warning || '#FF9800', icon: 'time-outline', label: 'Pending' },
  assigned: { color: '#2196F3', icon: 'person-outline', label: 'Assigned' },
  in_progress: { color: Colors.primary, icon: 'flame-outline', label: 'In Progress' },
  completed: { color: Colors.success, icon: 'checkmark-circle', label: 'Completed' },
  cancelled: { color: Colors.error || '#F44336', icon: 'close-circle', label: 'Cancelled' },
};

const VIEW_TABS = [
  { key: 'tasks', label: 'Production Tasks' },
  { key: 'orders', label: 'Orders Queue' },
];

const ORDER_STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'preparing', label: 'Preparing' },
  { key: 'ready', label: 'Ready' },
];

export default function ProductionQueueScreen({ navigation }) {
  const { user } = useAuth();
  const [viewMode, setViewMode] = useState('tasks');
  const [tasks, setTasks] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [orderStatusFilter, setOrderStatusFilter] = useState('');
  const [orderSearch, setOrderSearch] = useState('');
  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);

  // Assignment modal
  const [showAssign, setShowAssign] = useState(false);
  const [assignTask, setAssignTask] = useState(null);
  const [assignOrderTasks, setAssignOrderTasks] = useState([]); // tasks for an order
  const [employees, setEmployees] = useState([]);

  const isOwner = user?.role === 'owner';
  const isManager = user?.role === 'owner' || user?.role === 'manager';

  // Date filter for production tasks
  const [selectedDate, setSelectedDate] = useState(null); // null = all dates
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Helper: format date label
  const formatDateLabel = (dateStr) => {
    if (!dateStr) return 'No Date';
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    if (dateStr === today) return 'Today';
    if (dateStr === tomorrow) return 'Tomorrow';
    return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  };

  // Group tasks by scheduled_date into sections, today on top
  const taskSections = useMemo(() => {
    if (!tasks.length) return [];
    const groups = {};
    tasks.forEach(t => {
      const date = t.scheduled_date || '9999-12-31'; // no date goes last
      if (!groups[date]) groups[date] = [];
      groups[date].push(t);
    });
    const today = new Date().toISOString().split('T')[0];
    const dates = Object.keys(groups).sort((a, b) => {
      // Today first, then ascending dates
      if (a === today) return -1;
      if (b === today) return 1;
      return a.localeCompare(b);
    });
    return dates.map(date => ({
      title: date === '9999-12-31' ? 'No Date' : formatDateLabel(date),
      dateKey: date,
      data: groups[date],
    }));
  }, [tasks]);

  // Available dates for the date picker
  const availableDates = useMemo(() => {
    const dateSet = new Set();
    tasks.forEach(t => { if (t.scheduled_date) dateSet.add(t.scheduled_date); });
    return Array.from(dateSet).sort();
  }, [tasks]);

  const fetchTasks = useCallback(async () => {
    try {
      const params = {};
      if (selectedLocation) params.location_id = selectedLocation;
      if (statusFilter) params.status = statusFilter;
      const res = await api.getProductionTasks(params);
      setTasks(res.data || []);
    } catch (err) {
      console.error('Failed to fetch tasks:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedLocation, statusFilter]);

  const fetchOrders = useCallback(async () => {
    try {
      const params = {};
      if (selectedLocation) params.location_id = selectedLocation;
      if (orderStatusFilter) params.status = orderStatusFilter;
      const res = await api.getProductionQueue(params);
      let data = res.data || [];
      // Client-side search by sale_number or customer_name
      if (orderSearch.trim()) {
        const q = orderSearch.trim().toLowerCase();
        data = data.filter(o =>
          (o.sale_number || '').toLowerCase().includes(q) ||
          (o.customer_name || '').toLowerCase().includes(q)
        );
      }
      setOrders(data);
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedLocation, orderStatusFilter, orderSearch]);

  const fetchLocations = useCallback(async () => {
    try {
      const res = await api.getLocations();
      const locs = res.data?.locations || res.data || [];
      setLocations(locs);
      if (locs.length > 0 && selectedLocation === null && !isOwner) {
        setSelectedLocation(locs[0].id);
      }
      // Only owners default to all locations (selectedLocation stays null)
    } catch {}
  }, []);

  useFocusEffect(
    useCallback(() => { fetchLocations(); }, [])
  );

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      if (viewMode === 'tasks') fetchTasks();
      else fetchOrders();
    }, [selectedLocation, statusFilter, orderStatusFilter, orderSearch, viewMode])
  );

  const onRefresh = () => {
    setRefreshing(true);
    if (viewMode === 'tasks') fetchTasks();
    else fetchOrders();
  };

  const handlePickTask = (task) => {
    Alert.alert('Pick Task', `Pick up: ${task.quantity}x ${task.product_name}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Pick Up', onPress: async () => {
        try {
          await api.pickTask(task.id);
          fetchTasks();
        } catch (err) { Alert.alert('Error', err.message || 'Failed'); }
      }},
    ]);
  };

  const handleStartTask = (task) => {
    Alert.alert('Start Task', `Start making ${task.quantity}x ${task.product_name}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Start', onPress: async () => {
        try {
          await api.startTask(task.id);
          fetchTasks();
        } catch (err) { Alert.alert('Error', err.message || 'Failed'); }
      }},
    ]);
  };

  const handleCompleteTask = (task) => {
    Alert.alert('Complete Task', `Done making ${task.quantity}x ${task.product_name}?\n\nMaterials will be deducted.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Complete', style: 'default', onPress: async () => {
        try {
          await api.completeTask(task.id);
          fetchTasks();
        } catch (err) { Alert.alert('Error', err.message || 'Failed'); }
      }},
    ]);
  };

  const openAssignModal = async (task) => {
    setAssignTask(task);
    setAssignOrderTasks([]);
    try {
      const res = await api.getUsers();
      const allUsers = res.data?.users || res.data || [];
      const staffList = (Array.isArray(allUsers) ? allUsers : []).filter(u => ['owner', 'manager', 'employee'].includes(u.role));
      setEmployees(staffList);
    } catch {}
    setShowAssign(true);
  };

  const openAssignOrderModal = async (order) => {
    // Fetch all tasks for this order, then let manager assign them
    try {
      const res = await api.getProductionTasks({ sale_id: order.id });
      const orderTasks = (res.data || []).filter(t => t.status !== 'completed' && t.status !== 'cancelled');
      if (orderTasks.length === 0) {
        Alert.alert('No Tasks', 'All tasks for this order are already completed.');
        return;
      }
      setAssignOrderTasks(orderTasks);
      setAssignTask(orderTasks[0]); // display context
      const usersRes = await api.getUsers();
      const allUsers = usersRes.data?.users || usersRes.data || [];
      const staffList = (Array.isArray(allUsers) ? allUsers : []).filter(u => ['owner', 'manager', 'employee'].includes(u.role));
      setEmployees(staffList);
      setShowAssign(true);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to fetch tasks for order');
    }
  };

  const handleAssign = async (employeeId) => {
    try {
      if (assignOrderTasks.length > 0) {
        // Assign ALL pending tasks for this order to the employee
        for (const t of assignOrderTasks) {
          if (t.status === 'pending' || t.status === 'assigned') {
            await api.assignTask(t.id, { assigned_to: employeeId });
          }
        }
      } else {
        await api.assignTask(assignTask.id, { assigned_to: employeeId });
      }
      setShowAssign(false);
      setAssignTask(null);
      setAssignOrderTasks([]);
      if (viewMode === 'tasks') fetchTasks();
      else fetchOrders();
    } catch (err) { Alert.alert('Error', err.message || 'Failed to assign'); }
  };

  // Order-level status (legacy)
  const handleOrderStatus = (order, nextStatus, label) => {
    Alert.alert(label, `${label} for ${order.sale_number}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: label, onPress: async () => {
        try {
          await api.updateOrderStatus(order.id, nextStatus);
          fetchOrders();
        } catch (err) { Alert.alert('Error', err.message || 'Failed'); }
      }},
    ]);
  };

  const formatTime = (dateStr) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const renderTask = ({ item }) => {
    const config = TASK_STATUS_CONFIG[item.status] || {};
    const isMyTask = item.assigned_to === user?.id;
    const canPick = item.status === 'pending';
    const canStart = item.status === 'assigned' && (isMyTask || isManager);
    const canComplete = (item.status === 'assigned' || item.status === 'in_progress') && (isMyTask || isManager);

    return (
      <View style={[styles.card, item.priority === 'urgent' && styles.urgentCard]}>
        <View style={styles.cardHeader}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={styles.taskProduct}>{item.quantity}x {item.product_name}</Text>
              {item.priority === 'urgent' && (
                <View style={styles.urgentBadge}>
                  <Ionicons name="flash" size={12} color="#FF6D00" />
                  <Text style={styles.urgentText}>URGENT</Text>
                </View>
              )}
            </View>
            <Text style={styles.taskMeta}>
              {item.sale_number} • {item.order_type?.replace('_', ' ')} • {formatTime(item.created_at)}
              {!selectedLocation && item.location_name ? ` • ${item.location_name}` : ''}
            </Text>
            {item.customer_name && (
              <Text style={styles.taskCustomer}>{item.customer_name}</Text>
            )}
          </View>
          <View style={[styles.statusBadge, { backgroundColor: (config.color || Colors.textLight) + '20' }]}>
            <Ionicons name={config.icon} size={14} color={config.color} />
            <Text style={[styles.statusText, { color: config.color }]}>{config.label}</Text>
          </View>
        </View>

        {/* Show who is assigned */}
        {item.assigned_to_name && (
          <View style={styles.assignedRow}>
            <Ionicons name="person" size={14} color={Colors.primary} />
            <Text style={styles.assignedText}>{item.assigned_to_name}</Text>
          </View>
        )}

        {item.scheduled_date && (
          <View style={styles.assignedRow}>
            <Ionicons name="calendar" size={14} color={Colors.primary} />
            <Text style={styles.assignedText}>{item.scheduled_date} {item.scheduled_time || ''}</Text>
          </View>
        )}

        {/* Action buttons — large and clear */}
        {item.status !== 'completed' && item.status !== 'cancelled' && (
          <View style={styles.taskActions}>
            {canPick && (
              <TouchableOpacity style={[styles.actionBtn, { backgroundColor: '#2196F3' }]} onPress={() => handlePickTask(item)}>
                <Ionicons name="hand-left" size={18} color={Colors.white} />
                <Text style={styles.actionBtnText}>Pick Up</Text>
              </TouchableOpacity>
            )}
            {isManager && (item.status === 'pending' || item.status === 'assigned') && (
              <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.textSecondary }]} onPress={() => openAssignModal(item)}>
                <Ionicons name="people" size={18} color={Colors.white} />
                <Text style={styles.actionBtnText}>{item.assigned_to ? 'Reassign' : 'Assign'}</Text>
              </TouchableOpacity>
            )}
            {canStart && (
              <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.primary }]} onPress={() => handleStartTask(item)}>
                <Ionicons name="play" size={18} color={Colors.white} />
                <Text style={styles.actionBtnText}>Start</Text>
              </TouchableOpacity>
            )}
            {canComplete && (
              <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.success }]} onPress={() => handleCompleteTask(item)}>
                <Ionicons name="checkmark-circle" size={18} color={Colors.white} />
                <Text style={styles.actionBtnText}>Done</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    );
  };

  const renderOrder = ({ item }) => {
    const statusConfig = {
      pending: { color: Colors.warning || '#FF9800', label: 'Pending', next: 'preparing', nextLabel: 'Start Preparing', icon: 'time-outline' },
      preparing: { color: '#2196F3', label: 'Preparing', next: 'ready', nextLabel: 'Mark Ready', icon: 'construct-outline' },
      ready: { color: Colors.success, label: 'Ready', next: 'completed', nextLabel: 'Complete', icon: 'checkmark-circle-outline' },
    };
    const config = statusConfig[item.status] || {};

    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() => navigation.navigate('SaleDetail', { saleId: item.id })}
        activeOpacity={0.7}
      >
        <View style={styles.cardHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.orderNumber}>{item.sale_number}</Text>
            <Text style={styles.taskMeta}>
              {item.order_type?.replace('_', ' ')} • {formatTime(item.created_at)}
              {item.customer_name ? ` • ${item.customer_name}` : ''}
              {!selectedLocation && item.location_name ? ` • ${item.location_name}` : ''}
            </Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: (config.color || Colors.textLight) + '20' }]}>
            <Ionicons name={config.icon || 'ellipse'} size={14} color={config.color} />
            <Text style={[styles.statusText, { color: config.color }]}>{config.label || item.status}</Text>
          </View>
        </View>
        <View style={styles.itemsList}>
          {(item.items || []).map((si, idx) => (
            <Text key={idx} style={styles.itemText}>{si.quantity}x {si.product_name}</Text>
          ))}
        </View>
        <View style={styles.taskActions}>
          {isManager && item.status === 'pending' && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: Colors.textSecondary }]}
              onPress={() => openAssignOrderModal(item)}
            >
              <Ionicons name="people" size={18} color={Colors.white} />
              <Text style={styles.actionBtnText}>Assign</Text>
            </TouchableOpacity>
          )}
          {config.next && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: config.color, flex: 1 }]}
              onPress={() => handleOrderStatus(item, config.next, config.nextLabel)}
            >
              <Ionicons name={config.next === 'preparing' ? 'play' : config.next === 'ready' ? 'checkmark' : 'checkmark-done'} size={18} color={Colors.white} />
              <Text style={styles.actionBtnText}>{config.nextLabel}</Text>
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  if (loading && tasks.length === 0 && orders.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Location filter */}
      {(locations.length > 1 || isOwner) && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.locRow}
          contentContainerStyle={{ paddingHorizontal: Spacing.md, gap: Spacing.xs }}>
          {isOwner && (
            <TouchableOpacity
              style={[styles.chip, selectedLocation === null && styles.chipActive]}
              onPress={() => setSelectedLocation(null)}>
              <Text style={[styles.chipText, selectedLocation === null && styles.chipTextActive]}>All Locations</Text>
            </TouchableOpacity>
          )}
          {locations.map((loc) => (
            <TouchableOpacity key={loc.id}
              style={[styles.chip, selectedLocation === loc.id && styles.chipActive]}
              onPress={() => setSelectedLocation(loc.id)}>
              <Text style={[styles.chipText, selectedLocation === loc.id && styles.chipTextActive]}>{loc.name}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* View mode toggle: Tasks vs Orders */}
      <View style={styles.viewToggle}>
        {VIEW_TABS.map((tab) => (
          <TouchableOpacity key={tab.key}
            style={[styles.viewBtn, viewMode === tab.key && styles.viewBtnActive]}
            onPress={() => { setViewMode(tab.key); setStatusFilter(''); setOrderStatusFilter(''); setOrderSearch(''); }}>
            <Text style={[styles.viewBtnText, viewMode === tab.key && styles.viewBtnTextActive]}>{tab.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Status filter (for tasks view) */}
      {viewMode === 'tasks' && (
        <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: Spacing.md, gap: Spacing.xs, paddingVertical: Spacing.xs }}>
            {TASK_STATUS_TABS.map((tab) => (
              <TouchableOpacity key={tab.key}
                style={[styles.chip, statusFilter === tab.key && styles.chipActive]}
                onPress={() => setStatusFilter(tab.key)}>
                <Text style={[styles.chipText, statusFilter === tab.key && styles.chipTextActive]}>{tab.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          {/* Date filter row */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: Spacing.md, gap: Spacing.xs, paddingBottom: Spacing.xs }}>
            <TouchableOpacity
              style={[styles.chip, selectedDate === null && styles.chipActive]}
              onPress={() => setSelectedDate(null)}>
              <Text style={[styles.chipText, selectedDate === null && styles.chipTextActive]}>All Dates</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.chip, selectedDate === new Date().toISOString().split('T')[0] && styles.chipActive]}
              onPress={() => setSelectedDate(new Date().toISOString().split('T')[0])}>
              <Ionicons name="today" size={14} color={selectedDate === new Date().toISOString().split('T')[0] ? Colors.white : Colors.textSecondary} />
              <Text style={[styles.chipText, selectedDate === new Date().toISOString().split('T')[0] && styles.chipTextActive]}> Today</Text>
            </TouchableOpacity>
            {availableDates.filter(d => d !== new Date().toISOString().split('T')[0]).map(date => (
              <TouchableOpacity key={date}
                style={[styles.chip, selectedDate === date && styles.chipActive]}
                onPress={() => setSelectedDate(date)}>
                <Text style={[styles.chipText, selectedDate === date && styles.chipTextActive]}>{formatDateLabel(date)}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Status filter + search (for orders view) */}
      {viewMode === 'orders' && (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: Spacing.md, gap: Spacing.xs, paddingVertical: Spacing.xs }}>
            {ORDER_STATUS_TABS.map((tab) => (
              <TouchableOpacity key={tab.key}
                style={[styles.chip, orderStatusFilter === tab.key && styles.chipActive]}
                onPress={() => setOrderStatusFilter(tab.key)}>
                <Text style={[styles.chipText, orderStatusFilter === tab.key && styles.chipTextActive]}>{tab.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <View style={styles.searchBar}>
            <Ionicons name="search" size={18} color={Colors.textLight} />
            <TextInput
              style={styles.searchInput}
              value={orderSearch}
              onChangeText={setOrderSearch}
              placeholder="Search by order # or customer..."
              placeholderTextColor={Colors.textLight}
            />
            {orderSearch.length > 0 && (
              <TouchableOpacity onPress={() => setOrderSearch('')}>
                <Ionicons name="close-circle" size={18} color={Colors.textLight} />
              </TouchableOpacity>
            )}
          </View>
        </>
      )}

      {viewMode === 'tasks' ? (
        <SectionList
          sections={selectedDate ? taskSections.filter(s => s.dateKey === selectedDate || (selectedDate && !s.dateKey)) : taskSections}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderTask}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Ionicons name="calendar-outline" size={16} color={Colors.primary} />
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <View style={styles.sectionBadge}>
                <Text style={styles.sectionCount}>{section.data.length}</Text>
              </View>
            </View>
          )}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[Colors.primary]} />}
          stickySectionHeadersEnabled={true}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="checkmark-done-circle-outline" size={48} color={Colors.textLight} />
              <Text style={styles.emptyText}>No production tasks</Text>
            </View>
          }
        />
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderOrder}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[Colors.primary]} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="checkmark-done-circle-outline" size={48} color={Colors.textLight} />
              <Text style={styles.emptyText}>No orders in queue</Text>
            </View>
          }
        />
      )}

      {/* Assign modal */}
      <Modal visible={showAssign} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {assignOrderTasks.length > 0 ? 'Assign Order Tasks' : 'Assign Task'}
              </Text>
              <TouchableOpacity onPress={() => { setShowAssign(false); setAssignTask(null); setAssignOrderTasks([]); }}>
                <Ionicons name="close" size={24} color={Colors.text} />
              </TouchableOpacity>
            </View>
            {assignOrderTasks.length > 0 ? (
              <View style={{ marginBottom: Spacing.md }}>
                <Text style={styles.modalSubtitle}>Assign all pending tasks to one employee:</Text>
                {assignOrderTasks.map((t, i) => (
                  <Text key={t.id} style={{ fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2 }}>
                    • {t.quantity}x {t.product_name} ({t.status})
                  </Text>
                ))}
              </View>
            ) : assignTask && (
              <Text style={styles.modalSubtitle}>{assignTask.quantity}x {assignTask.product_name}</Text>
            )}
            <ScrollView style={{ maxHeight: 300 }}>
              {employees.map((emp) => (
                <TouchableOpacity key={emp.id} style={styles.empRow} onPress={() => handleAssign(emp.id)}>
                  <Ionicons name="person-circle" size={28} color={Colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.empName}>{emp.name}</Text>
                    <Text style={styles.empRole}>{emp.role}</Text>
                  </View>
                  {assignTask?.assigned_to === emp.id && (
                    <Ionicons name="checkmark-circle" size={20} color={Colors.success} />
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  locRow: { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: Colors.border },
  viewToggle: {
    flexDirection: 'row', paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    gap: Spacing.xs, backgroundColor: Colors.surface,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  viewBtn: {
    flex: 1, alignItems: 'center', paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md, backgroundColor: Colors.background,
    borderWidth: 1, borderColor: Colors.border,
  },
  viewBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  viewBtnText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  viewBtnTextActive: { color: Colors.white, fontWeight: '700' },

  chip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.full, borderWidth: 1,
    borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  chipTextActive: { color: Colors.white, fontWeight: '700' },

  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginHorizontal: Spacing.md, marginBottom: Spacing.xs,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm, height: 42,
    borderWidth: 1, borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: FontSize.sm, color: Colors.text },

  listContent: { padding: Spacing.md, gap: Spacing.sm },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md,
    backgroundColor: Colors.background,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
    marginBottom: Spacing.xs,
  },
  sectionTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flex: 1 },
  sectionBadge: {
    backgroundColor: Colors.primary + '20', borderRadius: BorderRadius.full,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  sectionCount: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.primary },
  card: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.md, borderWidth: 1, borderColor: Colors.border,
  },
  urgentCard: { borderColor: '#FF6D00', borderWidth: 2 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  taskProduct: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  orderNumber: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  taskMeta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 3 },
  taskCustomer: { fontSize: FontSize.sm, color: Colors.textSecondary },

  urgentBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#FFF3E0', paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: BorderRadius.sm,
  },
  urgentText: { fontSize: 10, fontWeight: '800', color: '#FF6D00' },

  statusBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.sm + 2, paddingVertical: 4,
    borderRadius: BorderRadius.full,
  },
  statusText: { fontSize: FontSize.xs, fontWeight: '700' },

  assignedRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6,
  },
  assignedText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '500' },

  itemsList: { marginTop: Spacing.xs, gap: 3 },
  itemText: { fontSize: FontSize.md, color: Colors.text },

  taskActions: {
    flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md, flexWrap: 'wrap',
  },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 12, paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md, minHeight: 44,
  },
  actionBtnText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: '700' },

  empty: { alignItems: 'center', marginTop: 80 },
  emptyText: { fontSize: FontSize.md, color: Colors.textLight, marginTop: Spacing.sm },

  // Assign modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: Spacing.lg },
  modalCard: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg, padding: Spacing.lg,
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.sm,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  modalSubtitle: { fontSize: FontSize.md, color: Colors.textSecondary, marginBottom: Spacing.md },
  empRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingVertical: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  empName: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  empRole: { fontSize: FontSize.sm, color: Colors.textLight, textTransform: 'capitalize' },
});
