import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, SectionList, TouchableOpacity,
  ActivityIndicator, RefreshControl, Alert, ScrollView, Modal, TextInput, Platform, Image,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { 
  parseServerDate, formatShopDateLabel, 
  getShopNow, getShopTodayStr, getShopTomorrowStr 
} from '../utils/datetime';
import ImageModal from '../components/ImageModal';



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
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const numColumns = useMemo(() => {
    if (width >= 1200) return 4;
    if (width >= 900) return 3;
    if (width >= 600) return 2;
    return 1;
  }, [width]);

  const { user, activeLocation, settings } = useAuth();
  const timezone = settings?.timezone || 'Asia/Kolkata';

  const [viewMode, setViewMode] = useState('tasks');
  const [tasks, setTasks] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [orderStatusFilter, setOrderStatusFilter] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [orderSearch, setOrderSearch] = useState('');
  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [now, setNow] = useState(getShopNow(timezone));

  // Update clock every minute for SLA timers (relative to Shop Timezone)
  useEffect(() => {
    const timer = setInterval(() => setNow(getShopNow(timezone)), 60000);
    return () => clearInterval(timer);
  }, [timezone]);

  // Assignment modal
  const [showAssign, setShowAssign] = useState(false);
  const [assignTask, setAssignTask] = useState(null);
  const [assignOrderTasks, setAssignOrderTasks] = useState([]); // tasks for an order
  const [employees, setEmployees] = useState([]);
  const [viewedImage, setViewedImage] = useState(null);

  const isOwner = user?.role === 'owner';
  const isManager = user?.role === 'owner' || user?.role === 'manager';

  // Date filter for production tasks
  const todayStr = useMemo(() => getShopTodayStr(timezone), [timezone]);
  const [selectedDate, setSelectedDate] = useState(todayStr); // defaults to today
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Helper: format date label
  const formatDateLabel = (dateStr) => formatShopDateLabel(dateStr, timezone);


  // Helper: check if task is urgent or late
  const getTaskUrgency = useCallback((task) => {
    if (task.status === 'completed' || task.status === 'cancelled') return null;
    
    // Fallback: If no scheduled date/time, use created_at as scheduled info
    const schedDate = task.scheduled_date || (task.created_at ? task.created_at.split('T')[0] : null);
    const schedTime = task.scheduled_time || (task.created_at ? task.created_at.split('T')[1]?.slice(0, 5) : null);

    // Walk-ins: Urgent if pending/assigned > 10-20 mins
    if (task.order_type === 'walk_in') {
      const created = parseServerDate(task.created_at);
      if (!created) return null;
      const diffMins = Math.floor((now - created) / 60000);
      if (diffMins > 20) return 'late';
      if (diffMins > 10) return 'urgent';
      return null;
    }

    // Scheduled: Late if time passed, Urgent if within 60 mins
    if (schedDate && schedTime) {
      const scheduled = parseServerDate(`${schedDate}T${schedTime}`);
      if (!scheduled) return null;
      const diffMins = Math.floor((scheduled - now) / 60000);
      if (diffMins < 0) return 'late';
      if (diffMins < 60) return 'urgent';



    }

    // 3. Urgent (Walk-in or ASAP/Unscheduled Pickup/Delivery)
    if (task.order_type === 'walk_in') return 'urgent';
    if (!task.scheduled_date && (task.order_type === 'pickup' || task.order_type === 'delivery')) {
      return 'urgent';
    }

    return null;
  }, [now, todayStr]);



  // Helper: check if order is urgent or late
  const getOrderUrgency = useCallback((order) => {
    if (order.status === 'ready' || order.status === 'completed' || order.status === 'cancelled') return null;
    
    const today = getShopTodayStr(timezone);
    
    // Fallback: If no scheduled info, use created_at
    const schedDate = order.scheduled_date || (order.created_at ? order.created_at.split('T')[0] : null);
    const schedTime = order.scheduled_time || (order.created_at ? order.created_at.split('T')[1]?.slice(0, 5) : null);

    // 1. Overdue (Past scheduled date)
    if (schedDate && schedDate < today) return 'late';
    
    // 2. Late & Urgent (Today)
    if (schedDate === today && schedTime) {
      const scheduled = parseServerDate(`${schedDate}T${schedTime}`);
      if (scheduled) {
        if (scheduled < now) return 'late';
        const diffMs = scheduled - now;
        if (diffMs >= 0 && diffMs < 3600000) return 'urgent'; // < 1 hour
      }
    }


    // 3. Urgent (Walk-in or ASAP/Unscheduled Pickup/Delivery)
    if (order.order_type === 'walk_in') return 'urgent';
    // If no explicit scheduled_date, it's an "ASAP" order. Use creation time as baseline.
    if (!order.scheduled_date && (order.order_type === 'pickup' || order.order_type === 'delivery')) {
      return 'urgent';
    }

    return null;
  }, [now, todayStr, timezone]);



  const renderSLA = (item) => {
    if (item.status === 'completed' || item.status === 'cancelled') return null;

    const created = parseServerDate(item.created_at);
    if (!created) return null;

    const diffMins = Math.floor((now - created) / 60000);

    // Walk-in orders: Track "X mins passed"
    if (item.order_type === 'walk_in') {
      const color = diffMins > 20 ? Colors.error : diffMins > 10 ? Colors.warning : Colors.success;
      return (
        <View style={[styles.slaBadge, { backgroundColor: color + '15' }]}>
          <Ionicons name="timer-outline" size={12} color={color} />
          <Text style={[styles.slaText, { color }]}>{diffMins}m passed</Text>
        </View>
      );
    }

    // Scheduled orders (pickup/delivery)
    const schedDate = item.scheduled_date || (item.created_at ? item.created_at.split('T')[0] : null);
    const schedTime = item.scheduled_time || (item.created_at ? item.created_at.split('T')[1]?.slice(0, 5) : null);

    if (schedDate && schedTime) {
      const scheduled = parseServerDate(`${schedDate}T${schedTime}`);
      if (!scheduled) return null;
      const remainingMins = Math.floor((scheduled - now) / 60000);

      if (remainingMins < 0) {
        return (
          <View style={[styles.slaBadge, { backgroundColor: Colors.error + '15' }]}>
            <Ionicons name="alert-circle" size={12} color={Colors.error} />
            <Text style={[styles.slaText, { color: Colors.error }]}>{Math.abs(remainingMins)}m LATE</Text>
          </View>
        );
      } else if (remainingMins < 60) {
        return (
          <View style={[styles.slaBadge, { backgroundColor: Colors.warning + '15' }]}>
            <Ionicons name="alarm-outline" size={12} color={Colors.warning} />
            <Text style={[styles.slaText, { color: Colors.warning }]}>In {remainingMins}m</Text>
          </View>
        );
      }
    }

    return null;
  };


  // Unified Grouping Logic for both Tasks and Orders
  const getSections = (data, isOrders) => {
    const urgentData = [];
    const pendingData = [];
    const activeData = [];
    const completeData = [];

    data.forEach(item => {
      const urgency = isOrders ? getOrderUrgency(item) : getTaskUrgency(item);
      const isUrgentOrLate = urgency === 'late' || urgency === 'urgent';

      // Section 1: 🔥 Overdue & Urgent (Always shows, ignores date filter)
      if (isUrgentOrLate) {
        urgentData.push(item);
        return;
      }

      // Date Filtering applies for the remaining sections
      const schedDate = item.scheduled_date || (item.created_at ? item.created_at.split('T')[0] : null);
      if (selectedDate && schedDate !== selectedDate) {
        return;
      }


      // Section 2, 3, 4 based on status
      const status = item.status || 'pending';
      if (isOrders) {
         if (status === 'pending') pendingData.push(item);
         else if (status === 'preparing') activeData.push(item);
         else if (status === 'ready' || status === 'completed') completeData.push(item);
      } else {
         if (status === 'pending' || status === 'assigned') pendingData.push(item);
         else if (status === 'in_progress') activeData.push(item);
         else if (status === 'completed') completeData.push(item);
      }
    });

    const sections = [];
    if (urgentData.length > 0) sections.push({ title: '🔥 Urgent & Overdue', key: 'urgent', data: urgentData, color: Colors.error });
    if (pendingData.length > 0) sections.push({ title: '⏳ Pending Queue', key: 'pending', data: pendingData, color: Colors.warning });
    if (activeData.length > 0) sections.push({ title: '🎨 In Progress', key: 'active', data: activeData, color: Colors.primary });
    if (completeData.length > 0) sections.push({ title: '✅ Ready / History', key: 'complete', data: completeData, color: Colors.success });
    
    return sections;
  };

  const taskSectionsList = useMemo(() => getSections(tasks, false), [tasks, getTaskUrgency, selectedDate]);
  const orderSectionsList = useMemo(() => getSections(orders, true), [orders, getOrderUrgency, selectedDate]);

  // Chunking for grids
  const chunkedTaskSections = useMemo(() => {
    return taskSectionsList.map(section => {
      const rows = [];
      const cols = numColumns || 1;
      for (let i = 0; i < section.data.length; i += cols) {
        rows.push({ id: `row-task-${section.key}-${i}`, items: section.data.slice(i, i + cols) });
      }
      return { ...section, data: rows };
    });
  }, [taskSectionsList, numColumns]);

  const chunkedOrderSections = useMemo(() => {
    return orderSectionsList.map(section => {
      const rows = [];
      const cols = numColumns || 1;
      for (let i = 0; i < section.data.length; i += cols) {
        rows.push({ id: `row-order-${section.key}-${i}`, items: section.data.slice(i, i + cols) });
      }
      return { ...section, data: rows };
    });
  }, [orderSectionsList, numColumns]);

  const sectionListRef = React.useRef(null);
  const scrollToSection = (sectionKey) => {
    if (!sectionListRef.current) return;
    
    // Find index in the current active list
    const list = viewMode === 'tasks' ? chunkedTaskSections : chunkedOrderSections;
    const index = list.findIndex(s => s.key === sectionKey);
    
    if (index !== -1) {
      // Small delay to ensure the VirtualizedList has updated its internals
      setTimeout(() => {
        try {
          sectionListRef.current.scrollToLocation({
            sectionIndex: index,
            itemIndex: 0,
            animated: true,
            viewPosition: 0, // 0 = Scroll to top of section
            viewOffset: 10   // Offset from top
          });
        } catch (e) {
          // If scrollToLocation fails, try scrolling to a generic index/offset
          console.warn('Scroll failed:', e);
        }
      }, 100);
    }
  };

  // getItemLayout to help SectionList calculate scroll offsets for long lists
  const getItemLayout = useCallback((data, index) => {
    // Estimating row height based on grid items
    // task rows are ~220, order rows are ~180, plus padding/gap
    const rowHeight = viewMode === 'tasks' ? 240 : 210;
    const headerHeight = 60;
    
    return {
      length: rowHeight,
      offset: rowHeight * index,
      index
    };
  }, [viewMode]);



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
      const locs = (res.data?.locations || res.data || []).filter((l) => (l.type === 'shop' || l.type == null) && l.is_active);
      setLocations(locs);
      if (locs.length > 0 && selectedLocation === null && !isOwner) {
        const defaultLoc = activeLocation && locs.some((l) => l.id === activeLocation.id)
          ? activeLocation.id
          : locs[0].id;
        setSelectedLocation(defaultLoc);
      }
    } catch {}
  }, [activeLocation, isOwner, selectedLocation]);

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
    const msg = `Pick up: ${task.quantity}x ${task.product_name}?`;
    const onConfirm = async () => {
      try {
        await api.pickTask(task.id);
        fetchTasks();
      } catch (err) {
        if (Platform.OS === 'web') {
          window.alert('Error: ' + (err.message || 'Failed'));
        } else {
          Alert.alert('Error', err.message || 'Failed');
        }
      }
    };

    if (Platform.OS === 'web') {
      setTimeout(() => {
        if (window.confirm(msg)) onConfirm();
      }, 50);
    } else {
      Alert.alert('Pick Task', msg, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Pick Up', onPress: onConfirm },
      ]);
    }
  };

  const handleStartTask = (task) => {
    const msg = `Start making ${task.quantity}x ${task.product_name}?`;
    const onConfirm = async () => {
      try {
        await api.startTask(task.id);
        fetchTasks();
      } catch (err) {
        if (Platform.OS === 'web') {
          window.alert('Error: ' + (err.message || 'Failed'));
        } else {
          Alert.alert('Error', err.message || 'Failed');
        }
      }
    };

    if (Platform.OS === 'web') {
      setTimeout(() => {
        if (window.confirm(msg)) onConfirm();
      }, 50);
    } else {
      Alert.alert('Start Task', msg, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start', onPress: onConfirm },
      ]);
    }
  };

  const handleCompleteTask = (task) => {
    const msg = `Done making ${task.quantity}x ${task.product_name}?\n\nMaterials will be deducted.`;
    const onConfirm = async () => {
      try {
        await api.completeTask(task.id);
        fetchTasks();
      } catch (err) {
        if (Platform.OS === 'web') {
          window.alert('Error: ' + (err.message || 'Failed'));
        } else {
          Alert.alert('Error', err.message || 'Failed');
        }
      }
    };

    if (Platform.OS === 'web') {
      setTimeout(() => {
        if (window.confirm(msg)) onConfirm();
      }, 50);
    } else {
      Alert.alert('Complete Task', msg, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Complete', style: 'default', onPress: onConfirm },
      ]);
    }
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

  const handleAssign = async (employeeId) => {
    try {
      if (assignOrderTasks.length > 0) {
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

  const handleOrderStatus = (order, nextStatus, label) => {
    const msg = `${label} for ${order.sale_number}?`;
    const onConfirm = async () => {
      try {
        await api.updateOrderStatus(order.id, nextStatus);
        fetchOrders();
      } catch (err) {
        if (Platform.OS === 'web') {
          window.alert('Error: ' + (err.message || 'Failed'));
        } else {
          Alert.alert('Error', err.message || 'Failed');
        }
      }
    };

    if (Platform.OS === 'web') {
      setTimeout(() => {
        if (window.confirm(msg)) onConfirm();
      }, 50);
    } else {
      Alert.alert(label, msg, [
        { text: 'Cancel', style: 'cancel' },
        { text: label, onPress: onConfirm },
      ]);
    }
  };

  const renderItemImage = (imageUrl) => {
    if (!imageUrl) return (
      <View style={{ width: 80, height: 80, borderRadius: 8, backgroundColor: Colors.surfaceAlt, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.border }}>
        <Ionicons name="image-outline" size={24} color={Colors.textLight} />
      </View>
    );
    return (
      <TouchableOpacity onPress={() => setViewedImage(api.getMediaUrl(imageUrl))}>
        <Image 
          source={{ uri: api.getMediaUrl(imageUrl) }} 
          style={{ width: 80, height: 80, borderRadius: 8, backgroundColor: Colors.surfaceAlt, borderWidth: 1, borderColor: Colors.border }} 
          resizeMode="cover" 
        />
      </TouchableOpacity>
    );
  };

  const renderTask = ({ item }) => {
    const urgency = getTaskUrgency(item);
    const urgencyColor = urgency === 'late' ? Colors.error : urgency === 'urgent' ? Colors.warning : Colors.border;
    const imageUrl = item.item_image_url || item.product_image;

    return (
      <View style={[styles.card, { borderLeftWidth: 6, borderLeftColor: urgencyColor, padding: 0, overflow: 'hidden' }]}>
        <TouchableOpacity style={{ flex: 1, opacity: item.status === 'completed' ? 0.7 : 1 }} activeOpacity={0.9} onPress={() => navigation.navigate('SaleDetail', { saleId: item.sale_id || item.id })}>
          <View style={{ backgroundColor: Colors.surfaceAlt, padding: 10, borderBottomWidth: 1, borderBottomColor: Colors.border, flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.orderNum, { fontSize: 14 }]} numberOfLines={1}>#{item.sale_number || '---'}</Text>
              <Text style={[styles.cardSchedule, { marginTop: 0 }]} numberOfLines={1}>{item.scheduled_time || 'ASAP'} • {formatDateLabel(item.scheduled_date)}</Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4, minWidth: 85 }}>
              {renderSLA(item)}
              <View style={[styles.statusBadge, { backgroundColor: (TASK_STATUS_CONFIG[item.status]?.color || Colors.primary) + '20', paddingVertical: 1, paddingHorizontal: 6, borderRadius: 4 }]}>
                <Text style={[styles.statusText, { color: TASK_STATUS_CONFIG[item.status]?.color || Colors.primary, fontSize: 9, fontWeight: '800' }]}>
                  {TASK_STATUS_CONFIG[item.status]?.label?.toUpperCase() || item.status}
                </Text>
              </View>
            </View>
          </View>

          <View style={{ padding: 12, flex: 1 }}>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              {renderItemImage(imageUrl)}
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '800', color: Colors.text, lineHeight: 20 }} numberOfLines={2}>
                  {item.quantity}x {item.product_name || item.item_product_name}
                </Text>
                <Text style={{ fontSize: 12, color: Colors.textSecondary, marginTop: 2 }} numberOfLines={1}>
                  {item.assigned_to_name ? `Designer: ${item.assigned_to_name}` : 'Unassigned'}
                </Text>
                
                {/* Order Level Instructions */}
                {(item.order_special_instructions || item.order_notes || item.special_instructions || item.notes) ? (
                   <View style={{ backgroundColor: '#FFEBEE', padding: 6, borderRadius: 4, marginTop: 8, borderLeftWidth: 2, borderLeftColor: Colors.error }}>
                     <Text style={{ fontSize: 10, color: Colors.error, fontWeight: '800', textTransform: 'uppercase', marginBottom: 2 }}>Order Note:</Text>
                     <Text style={{ fontSize: 11, color: Colors.error, fontWeight: '600' }} numberOfLines={4}>{item.order_special_instructions || item.order_notes || item.special_instructions || item.notes}</Text>
                   </View>
                ) : null}


                {/* Item Level Instructions */}
                {item.item_special_instructions ? (
                   <View style={{ backgroundColor: '#FFF9C4', padding: 6, borderRadius: 4, marginTop: 6, borderLeftWidth: 2, borderLeftColor: Colors.warning }}>
                     <Text style={{ fontSize: 10, color: '#F57F17', fontWeight: '800', textTransform: 'uppercase', marginBottom: 2 }}>Item Note:</Text>
                     <Text style={{ fontSize: 11, color: '#F57F17', fontWeight: '600' }} numberOfLines={3}>{item.item_special_instructions}</Text>
                   </View>
                ) : null}
              </View>
            </View>

            <View style={{ flex: 1, minHeight: 8 }} />

            {item.status !== 'completed' && item.status !== 'cancelled' && (
              <View style={[styles.taskActions, { marginTop: 8 }]}>
                {item.status === 'pending' && (
                  <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.primary }]} onPress={() => handlePickTask(item)}>
                    <Text style={[styles.actionBtnText, { fontSize: 13 }]}>Pick Up</Text>
                  </TouchableOpacity>
                )}
                {isManager && (item.status === 'pending' || item.status === 'assigned') && (
                  <TouchableOpacity style={[styles.actionBtn, { backgroundColor: Colors.surfaceAlt, borderWidth: 1, borderColor: Colors.border }]} onPress={() => openAssignModal(item)}>
                    <Text style={[styles.actionBtnText, { color: Colors.primary, fontSize: 13 }]}>{item.assigned_to ? 'Reassign' : 'Assign'}</Text>
                  </TouchableOpacity>
                )}

                {(item.status === 'assigned' || item.status === 'in_progress') && (
                  <TouchableOpacity 
                    style={[styles.actionBtn, { backgroundColor: item.status === 'in_progress' ? Colors.success : Colors.primary }]} 
                    onPress={() => item.status === 'in_progress' ? handleCompleteTask(item) : handleStartTask(item)}>
                    <Text style={[styles.actionBtnText, { fontSize: 13 }]}>{item.status === 'in_progress' ? 'Done' : 'Start'}</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>
        </TouchableOpacity>
      </View>
    );
  };

  const renderOrder = ({ item }) => {
    const urgency = getOrderUrgency(item);
    const urgencyColor = urgency === 'late' ? Colors.error : urgency === 'urgent' ? Colors.warning : Colors.border;
    const summary = item.task_summary || { pending_tasks: 0, assigned_tasks: 0, in_progress_tasks: 0, completed_tasks: 0 };

    return (
      <View style={[styles.card, { borderLeftWidth: 6, borderLeftColor: urgencyColor, padding: 0, overflow: 'hidden' }]}>
        <TouchableOpacity style={{ flex: 1 }} onPress={() => navigation.navigate('SaleDetail', { saleId: item.id })} activeOpacity={0.9}>
          <View style={{ backgroundColor: Colors.surfaceAlt, padding: 10, borderBottomWidth: 1, borderBottomColor: Colors.border, flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <Text style={[styles.orderNum, { fontSize: 14 }]} numberOfLines={1}>#{item.sale_number}</Text>
                <View style={{ backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4 }}>
                   <Text style={{ fontSize: 8, fontWeight: '800', textTransform: 'uppercase' }}>{item.order_type?.replace('_', ' ')}</Text>
                </View>
              </View>
              <Text style={[styles.customerName, { fontSize: 11, marginTop: 2 }]} numberOfLines={1}>{item.customer_name || ''}</Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2, minWidth: 80 }}>
              {renderSLA(item)}
              <Text style={{ fontSize: 10, color: Colors.textLight, fontWeight: '700' }}>{item.scheduled_time || 'ASAP'}</Text>
              {item.payment_status && item.payment_status !== 'paid' && (
                <View style={[styles.statusBadge, { backgroundColor: Colors.error + '15', paddingVertical: 1, marginTop: 2 }]}>
                  <Text style={[styles.statusText, { color: Colors.error, fontSize: 9, fontWeight: '900' }]}>PAYMENT PENDING</Text>
                </View>
              )}
            </View>
          </View>


          <View style={{ padding: 12, flex: 1 }}>
            {(item.special_instructions || item.notes || item.order_special_instructions || item.order_notes) ? (
               <View style={{ backgroundColor: '#FFEBEE', padding: 6, borderRadius: 4, marginBottom: 10, borderLeftWidth: 2, borderLeftColor: Colors.error }}>
                 <Text style={{ fontSize: 11, color: Colors.error, fontWeight: '600' }} numberOfLines={3}>{item.special_instructions || item.notes || item.order_special_instructions || item.order_notes}</Text>
               </View>
            ) : null}


            <View style={{ flex: 1 }}>
              {(item.items || []).slice(0, 2).map((si, idx) => (
                <View key={idx} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                  <Image 
                    source={{ uri: api.getMediaUrl(si.item_image_url || si.product_image) }} 
                    style={{ width: 36, height: 36, borderRadius: 4, backgroundColor: Colors.surfaceAlt, borderWidth: 1, borderColor: Colors.border }} 
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: Colors.text }} numberOfLines={1}>{si.quantity}x {si.product_name}</Text>
                  </View>
                </View>
              ))}
              {item.items?.length > 2 && <Text style={{ fontSize: 10, color: Colors.textLight, fontWeight: '600' }}>+ {item.items.length - 2} more items</Text>}
            </View>

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: Colors.border }}>
               <View style={{ flex: 1, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: Colors.error }}>{summary.pending_tasks + summary.assigned_tasks}</Text>
                  <Text style={{ fontSize: 8, color: Colors.textLight, fontWeight: '700' }}>PENDING</Text>
               </View>
               <View style={{ flex: 1, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: Colors.warning }}>{summary.in_progress_tasks}</Text>
                  <Text style={{ fontSize: 8, color: Colors.textLight, fontWeight: '700' }}>ACTIVE</Text>
               </View>
               <View style={{ flex: 1, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: Colors.success }}>{summary.completed_tasks}</Text>
                  <Text style={{ fontSize: 8, color: Colors.textLight, fontWeight: '700' }}>DONE</Text>
               </View>
            </View>

            {item.delivery && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 10, backgroundColor: Colors.info + '08', borderRadius: 10, borderWidth: 1, borderColor: Colors.info + '15' }}>
                <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.info + '15', alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="car" size={18} color={Colors.info} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 9, color: Colors.info, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    Delivery: {item.delivery.status?.replace(/_/g, ' ')}
                  </Text>
                  <Text style={{ fontSize: 13, color: Colors.text, fontWeight: '700', marginTop: 1 }}>
                    {item.delivery.partner_name || item.delivery.driver_name ? `Driver: ${item.delivery.partner_name || item.delivery.driver_name}` : 'Not Assigned'}
                  </Text>
                </View>
                {item.delivery.status === 'delivered' && (
                  <Ionicons name="checkmark-circle" size={20} color={Colors.success} />
                )}
              </View>
            )}


            {item.status !== 'completed' && item.status !== 'cancelled' && (
              <View style={[styles.taskActions, { marginTop: 10 }]}>
                {(() => {
                  const hasIncompleteTasks = (summary.pending_tasks || 0) + (summary.assigned_tasks || 0) + (summary.in_progress_tasks || 0) > 0;
                  const deliveryBlocked = item.order_type === 'delivery' && item.delivery && item.delivery.status !== 'delivered';
                  
                  let nextBlocked = false;
                  let blockReason = '';
                  let nextAction = null;

                  if (item.status === 'pending') {
                    nextAction = { status: 'preparing', label: 'Prepare', color: Colors.primary };
                  } else if (item.status === 'preparing') {
                    nextAction = { status: 'ready', label: 'Ready', color: Colors.success };
                    if (hasIncompleteTasks) {
                      nextBlocked = true;
                      blockReason = `${(summary.pending_tasks || 0) + (summary.assigned_tasks || 0) + (summary.in_progress_tasks || 0)} tasks left`;
                    }
                  } else if (item.status === 'ready') {
                    nextAction = { status: 'completed', label: 'Done', color: Colors.primary };
                    if (hasIncompleteTasks) {
                      nextBlocked = true;
                      blockReason = 'Tasks incomplete';
                    } else if (deliveryBlocked) {
                      nextBlocked = true;
                      blockReason = 'Delivery pending';
                    } else if (item.payment_status && item.payment_status !== 'paid') {
                      nextBlocked = true;
                      blockReason = 'Payment pending';
                    }
                  }


                  if (!nextAction) return null;

                  if (nextBlocked) {
                    return (
                      <View style={[styles.actionBtn, { backgroundColor: Colors.surfaceAlt, borderWidth: 1, borderColor: Colors.border, opacity: 0.7 }]}>
                        <Ionicons name="lock-closed" size={14} color={Colors.textLight} />
                        <Text style={[styles.actionBtnText, { color: Colors.textLight, fontSize: 11 }]}>{blockReason}</Text>
                      </View>
                    );
                  }

                  return (
                    <TouchableOpacity 
                      style={[styles.actionBtn, { backgroundColor: nextAction.color }]} 
                      onPress={() => handleOrderStatus(item, nextAction.status, `Mark ${nextAction.label}`)}
                    >
                      <Text style={[styles.actionBtnText, { fontSize: 13 }]}>{nextAction.label}</Text>
                    </TouchableOpacity>
                  );
                })()}
              </View>
            )}

          </View>
        </TouchableOpacity>
      </View>
    );
  };

  const renderFilters = () => {
    if (!showFilters) return null;
    
    const filterContainerStyle = isTablet 
      ? { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm }
      : { paddingHorizontal: Spacing.md, gap: Spacing.xs };

    const FilterWrapper = isTablet ? View : ScrollView;
    const wrapperProps = isTablet ? { style: filterContainerStyle } : { horizontal: true, showsHorizontalScrollIndicator: false, contentContainerStyle: filterContainerStyle };

    const today = getShopTodayStr(timezone);
    const tomorrow = getShopTomorrowStr(timezone);


    return (
      <View style={styles.filterPane}>
        {(locations.length > 1 || isOwner) && (
          <View style={{ marginBottom: isTablet ? 0 : Spacing.xs }}>
            <FilterWrapper {...wrapperProps}>
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
            </FilterWrapper>
          </View>
        )}

        <View style={{ marginVertical: Spacing.xs, height: 1, backgroundColor: Colors.border + '15' }} />

        <FilterWrapper {...wrapperProps}>
          <TouchableOpacity
            style={[styles.dateChip, selectedDate === null && styles.dateChipActive]}
            onPress={() => { setSelectedDate(null); setShowDatePicker(false); }}>
            <Text style={[styles.dateChipText, selectedDate === null && styles.dateChipTextActive]}>All Dates</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.dateChip, selectedDate === today && styles.dateChipActive]}
            onPress={() => { setSelectedDate(today); setShowDatePicker(false); }}>
            <Text style={[styles.dateChipText, selectedDate === today && styles.dateChipTextActive]}>Today</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.dateChip, selectedDate === tomorrow && styles.dateChipActive]}
            onPress={() => { setSelectedDate(tomorrow); setShowDatePicker(false); }}>
            <Text style={[styles.dateChipText, selectedDate === tomorrow && styles.dateChipTextActive]}>Tomorrow</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.dateChip, showDatePicker && styles.dateChipActive, selectedDate && ![today, tomorrow].includes(selectedDate) && styles.dateChipActive]}
            onPress={() => setShowDatePicker(!showDatePicker)}>
            <Ionicons name="calendar-outline" size={16} color={(showDatePicker || (selectedDate && ![today, tomorrow].includes(selectedDate))) ? Colors.white : Colors.primary} />
            <Text style={[styles.dateChipText, (showDatePicker || (selectedDate && ![today, tomorrow].includes(selectedDate))) && styles.dateChipTextActive]}>
              {selectedDate && ![today, tomorrow].includes(selectedDate) ? formatDateLabel(selectedDate) : 'Custom'}
            </Text>
          </TouchableOpacity>
        </FilterWrapper>

        {showDatePicker && (
          <View style={styles.customDateWrapper}>
            <Text style={styles.customDateLabel}>Select from recent dates:</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: Spacing.xs }}>
              {availableDates.filter(d => ![today, tomorrow].includes(d)).map(d => (
                <TouchableOpacity key={d} 
                  style={[styles.chip, selectedDate === d && styles.chipActive]}
                  onPress={() => setSelectedDate(d)}>
                  <Text style={[styles.chipText, selectedDate === d && styles.chipTextActive]}>{formatDateLabel(d)}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        <View style={{ marginVertical: Spacing.xs, height: 1, backgroundColor: Colors.border + '15' }} />

        {viewMode === 'tasks' && (
          <FilterWrapper {...wrapperProps}>
            {TASK_STATUS_TABS.map((tab) => (
              <TouchableOpacity key={tab.key}
                style={[styles.chip, statusFilter === tab.key && styles.chipActive]}
                onPress={() => setStatusFilter(tab.key)}>
                <Text style={[styles.chipText, statusFilter === tab.key && styles.chipTextActive]}>{tab.label}</Text>
              </TouchableOpacity>
            ))}
          </FilterWrapper>
        )}

        {viewMode === 'orders' && (
          <FilterWrapper {...wrapperProps}>
            {ORDER_STATUS_TABS.map((tab) => (
              <TouchableOpacity key={tab.key}
                style={[styles.chip, orderStatusFilter === tab.key && styles.chipActive]}
                onPress={() => setOrderStatusFilter(tab.key)}>
                <Text style={[styles.chipText, orderStatusFilter === tab.key && styles.chipTextActive]}>{tab.label}</Text>
              </TouchableOpacity>
            ))}
          </FilterWrapper>
        )}
      </View>
    );
  };

  if (loading && tasks.length === 0 && orders.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  const activeSections = viewMode === 'tasks' ? taskSectionsList : orderSectionsList;
  const chunkedList = viewMode === 'tasks' ? chunkedTaskSections : chunkedOrderSections;

  return (
    <View style={styles.container}>
      <View style={styles.headerPanel}>
        <View style={[styles.headerRow, isTablet && { flexDirection: 'row', alignItems: 'center' }]}>
          <View style={[{ flexDirection: 'row', alignItems: 'center', flex: isTablet ? 0 : 1 }]}>
            {!isTablet && (
              <View style={{ flex: 1 }}>
                <View style={[styles.viewToggle, { marginHorizontal: Spacing.md }]}>
                  {VIEW_TABS.map((tab) => (
                    <TouchableOpacity key={tab.key}
                      style={[styles.viewBtn, viewMode === tab.key && styles.viewBtnActive, { paddingVertical: 8 }]}
                      onPress={() => { setViewMode(tab.key); setStatusFilter(''); setOrderStatusFilter(''); setOrderSearch(''); }}>
                      <Text style={[styles.viewBtnText, viewMode === tab.key && styles.viewBtnTextActive, { fontSize: 13 }]}>{tab.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: Colors.border + '15' }}>
                  <TouchableOpacity
                    style={styles.filterToggleBtn}
                    onPress={() => setShowFilters(!showFilters)}
                  >
                    <Ionicons name={showFilters ? 'options' : 'options-outline'} size={18} color={Colors.primary} />
                    <Text style={styles.filterToggleText}>{showFilters ? 'Hide' : 'Filter'}</Text>
                  </TouchableOpacity>
                  <View style={{ flex: 1 }} />
                  <TouchableOpacity
                    style={[styles.historyBtn, { borderWidth: 0, backgroundColor: 'transparent' }]}
                    onPress={() => navigation.navigate('CompletedTasks')}
                  >
                    <Ionicons name="checkmark-done-circle-outline" size={20} color={Colors.primary} />
                    <Text style={[styles.historyBtnText, { fontSize: 13 }]}>History</Text>
                  </TouchableOpacity>
                </View>
                {viewMode === 'orders' && (
                  <View style={[styles.searchBar, { marginHorizontal: Spacing.md, marginBottom: Spacing.sm }]}>
                    <Ionicons name="search" size={16} color={Colors.textLight} />
                    <TextInput
                      style={styles.searchInput}
                      placeholder="Search..."
                      value={orderSearch}
                      onChangeText={setOrderSearch}
                    />
                  </View>
                )}
              </View>
            )}

            {isTablet && (
              <>
                <TouchableOpacity
                  style={styles.filterToggleBtn}
                  onPress={() => setShowFilters(!showFilters)}
                >
                  <Ionicons name={showFilters ? 'options' : 'options-outline'} size={18} color={Colors.primary} />
                  <Text style={styles.filterToggleText}>{showFilters ? 'Hide' : 'Filter'}</Text>
                </TouchableOpacity>
                
                <View style={[styles.viewToggle, { marginVertical: 0, paddingHorizontal: Spacing.sm, width: 280, borderTopWidth: 0 }]}>
                  {VIEW_TABS.map((tab) => (
                    <TouchableOpacity key={tab.key}
                      style={[styles.viewBtn, viewMode === tab.key && styles.viewBtnActive, { paddingVertical: 8 }]}
                      onPress={() => { setViewMode(tab.key); setStatusFilter(''); setOrderStatusFilter(''); setOrderSearch(''); }}>
                      <Text style={[styles.viewBtnText, viewMode === tab.key && styles.viewBtnTextActive, { fontSize: 12 }]}>{tab.key === 'tasks' ? 'Tasks' : 'Orders Queue'}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <View style={[{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingHorizontal: Spacing.md }]}>
                  {viewMode === 'orders' && (
                    <View style={[styles.searchBar, { flex: 1, marginHorizontal: 0 }]}>
                      <Ionicons name="search" size={16} color={Colors.textLight} />
                      <TextInput
                        style={styles.searchInput}
                        placeholder="Search orders..."
                        value={orderSearch}
                        onChangeText={setOrderSearch}
                      />
                    </View>
                  )}
                  <TouchableOpacity
                    style={styles.historyBtn}
                    onPress={() => navigation.navigate('CompletedTasks')}
                  >
                    <Ionicons name="checkmark-done-circle-outline" size={20} color={Colors.primary} />
                    <Text style={styles.historyBtnText}>History</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </View>

      {renderFilters()}
      
      <View style={{ flex: 1 }}>
        <View style={styles.summaryBar}>
           {(activeSections || []).map((section) => (
             <TouchableOpacity 
               key={section.key} 
               style={[styles.summaryItem, { paddingVertical: 12 }]} 
               onPress={() => scrollToSection(section.key)}
               activeOpacity={0.6}
             >
                <Text style={[styles.summaryCount, { color: section.color }]}>{section.data?.length || 0}</Text>
                <Text style={styles.summaryLabel}>{section.title.split(' ')[1] || section.title}</Text>
             </TouchableOpacity>

           ))}
        </View>


        <SectionList
            ref={sectionListRef}
            sections={chunkedList}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <View style={styles.gridRow}>
                {item.items.map(obj => (
                  <View key={obj.id} style={styles.gridColumn}>
                    {viewMode === 'tasks' ? renderTask({ item: obj }) : renderOrder({ item: obj })}
                  </View>
                ))}
                {item.items.length < numColumns && Array(numColumns - item.items.length).fill(0).map((_, i) => (
                  <View key={`pad-${i}`} style={styles.gridColumn} />
                ))}
              </View>
            )}
            renderSectionHeader={({ section: { title, data, color } }) => {
              const count = data.reduce((acc, row) => acc + row.items.length, 0);
              return (
                <View style={[styles.sectionHeader, { borderLeftWidth: 4, borderLeftColor: color }]}>
                  <Text style={[styles.sectionTitle, { color: color }]}>{title}</Text>
                  <View style={[styles.sectionBadge, { backgroundColor: color + '20' }]}>
                    <Text style={[styles.sectionCount, { color: color }]}>{count}</Text>
                  </View>
                </View>
              );
            }}
            contentContainerStyle={styles.listContent}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[Colors.primary]} />}
            stickySectionHeadersEnabled={true}
            getItemLayout={getItemLayout}
            onScrollToIndexFailed={(info) => {

               sectionListRef.current?.scrollToLocation({
                 sectionIndex: info.index,
                 itemIndex: 0,
                 animated: true,
                 viewPosition: 0
               });
            }}

            ListEmptyComponent={
              <View style={styles.empty}>
                <Ionicons name="list-outline" size={48} color={Colors.textLight} />
                <Text style={styles.emptyText}>{loading ? 'Loading...' : 'No items in this queue'}</Text>
              </View>
            }
          />
      </View>

      {showAssign && (
        <Modal visible={true} transparent animationType="fade">
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
                  {assignOrderTasks.map((t) => (
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
      )}

      {!!viewedImage && (
        <ImageModal 
          visible={true} 
          imageUrl={viewedImage} 
          onClose={() => setViewedImage(null)} 
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  headerPanel: {
    backgroundColor: Colors.surface,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  headerRow: {
    paddingVertical: Spacing.xs,
  },
  filterPane: {
    backgroundColor: Colors.background,
    paddingVertical: Spacing.xs,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  filterToggleBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: Spacing.md, height: 44,
  },
  filterToggleText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '700' },
  historyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: Spacing.sm, paddingVertical: 8,
    borderRadius: BorderRadius.sm, backgroundColor: Colors.surfaceAlt,
    borderWidth: 1, borderColor: Colors.border,
  },
  historyBtnText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '700' },
  viewToggle: {
    flexDirection: 'row', padding: 4, gap: 4,
    backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.md,
    marginVertical: Spacing.sm,
  },
  viewBtn: {
    flex: 1, alignItems: 'center', paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md, 
  },
  viewBtnActive: { backgroundColor: Colors.surface, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2, elevation: 2 },
  viewBtnText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  viewBtnTextActive: { color: Colors.primary, fontWeight: '800' },
  
  chip: {
    paddingHorizontal: Spacing.md, paddingVertical: 6,
    borderRadius: BorderRadius.full, borderWidth: 1,
    borderColor: Colors.border, backgroundColor: Colors.surface,
    minHeight: 32, justifyContent: 'center',
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: 12, color: Colors.textSecondary, fontWeight: '600' },
  chipTextActive: { color: Colors.white, fontWeight: '800' },

  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.md, height: 36,
    borderWidth: 1, borderColor: Colors.border,
  },
  searchInput: { flex: 1, fontSize: 13, color: Colors.text, paddingVertical: 0 },

  summaryBar: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
    paddingVertical: Spacing.sm,
  },
  summaryItem: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  summaryCount: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.warning },
  summaryLabel: { fontSize: 10, color: Colors.textSecondary, fontWeight: '600', textTransform: 'uppercase', marginTop: 2 },

  dateChip: {
    paddingHorizontal: Spacing.lg, paddingVertical: 8,
    borderRadius: BorderRadius.md, backgroundColor: Colors.surfaceAlt,
    borderWidth: 1, borderColor: Colors.border,
    flexDirection: 'row', alignItems: 'center', gap: 6,
  },
  dateChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  dateChipText: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary },
  dateChipTextActive: { color: Colors.white, fontWeight: '800' },

  customDateWrapper: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    backgroundColor: Colors.surfaceAlt + '50',
  },
  customDateLabel: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary, marginBottom: Spacing.xs },

  slaBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
  },
  slaText: { fontSize: 10, fontWeight: '800' },
  cardSchedule: { fontSize: 11, color: Colors.textSecondary, fontWeight: '600', marginTop: 2 },

  listContent: { padding: Spacing.md, gap: Spacing.sm },
  ordersListContent: { padding: Spacing.md, gap: Spacing.lg },
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
    backgroundColor: Colors.surface, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 4,
    flex: 1,
  },
  urgentCard: { borderColor: '#FF6D00', borderWidth: 2 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  taskProduct: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  orderNum: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  customerName: { fontSize: FontSize.md, color: Colors.textSecondary, fontWeight: '600' },
  taskMeta: { fontSize: FontSize.md, color: Colors.textSecondary, marginTop: 4 },
  taskCustomer: { fontSize: FontSize.md, color: Colors.textSecondary },

  urgentBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#FFF3E0', paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: BorderRadius.sm,
  },
  urgentText: { fontSize: 10, fontWeight: '800', color: '#FF6D00' },

  statusBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.md, paddingVertical: 6,
    borderRadius: BorderRadius.full,
  },
  statusText: { fontSize: FontSize.sm, fontWeight: '700' },

  assignedRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8,
  },
  assignedText: { fontSize: FontSize.md, color: Colors.primary, fontWeight: '600' },

  itemsList: { marginTop: Spacing.sm, gap: 4 },
  itemText: { fontSize: FontSize.lg, color: Colors.text },

  taskActions: {
    flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.lg, flexWrap: 'wrap',
  },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 8, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, minHeight: 40, flex: 1,
  },
  actionBtnText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '700' },

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

  // BOM / Material composition styles
  bomSection: {
    backgroundColor: Colors.background, borderRadius: 8, padding: 8, marginTop: 8,
    borderWidth: 1, borderColor: Colors.border,
  },
  bomSectionTitle: { fontSize: FontSize.xs, fontWeight: '700', color: Colors.textSecondary, marginBottom: 4 },
  bomMaterialRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  stockDot: { width: 6, height: 6, borderRadius: 3 },
  bomMatName: { flex: 1, fontSize: FontSize.xs, color: Colors.text },
  bomMatQty: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary, minWidth: 50, textAlign: 'right' },
  bomMatStock: { fontSize: FontSize.xs, fontWeight: '600', minWidth: 60, textAlign: 'right' },
  gridRow: {
    flexDirection: 'row',
    gap: Spacing.lg,
    alignItems: 'stretch', // Ensure items in the same row have equal height
  },
  gridColumn: {
    flex: 1,
    minWidth: 0, // important for nested text wrapping
  },
});
