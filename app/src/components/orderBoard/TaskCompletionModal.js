import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, Modal, ActivityIndicator, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { showAlert } from '../../utils/alert';
import { Colors } from '../../constants/theme';
import { FONT_FAMILY } from '../../constants/orderDisplay';

/**
 * "Finish Tasks" — resolveDeadEnd's 'finish_tasks' case (OrderCard.js) used
 * to be plain navigation to SaleDetail, the only place a preparing order's
 * open tasks could be marked done. Requested directly (2026-09-10): a modal
 * here instead, matching the other dead-end/resolution actions
 * (AssignPickerModal, CollectCodModal) rather than a screen change.
 *
 * Self-contained: takes just `order`, fetches that sale's own open tasks
 * on open (GET /production/tasks?sale_id=, the same endpoint
 * SaleDetailScreen and QuickModals.js already use — no new backend route),
 * completes them one at a time via api.completeTask (PUT
 * /production/tasks/:id/complete — the real completion logic, material
 * deduction included, not a status-flip shortcut; also auto-flips the sale
 * to 'ready' server-side once every task is done).
 *
 * The "who's allowed to complete this task" gate mirrors SaleDetailScreen's
 * own isTaskOwner exactly (canManage || flexibleTaskAssignment ||
 * task.assigned_to === viewer) — the button only renders when it would
 * actually be accepted, never a call the server is guaranteed to 403.
 */
export default function TaskCompletionModal({ visible, order, onClose, onDone }) {
  const { user, settings } = useAuth();
  const canManage = user?.role === 'owner' || user?.role === 'manager';
  const flexibleTaskAssignment = settings?.pref_flexible_task_assignment?.value !== '0';
  const canComplete = (task) => canManage || flexibleTaskAssignment || task.assigned_to === user?.id;

  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [completingId, setCompletingId] = useState(null);

  const fetchTasks = useCallback(() => {
    if (!order?.id) return;
    setLoading(true);
    api.getProductionTasks({ sale_id: order.id })
      .then((res) => {
        const rows = Array.isArray(res?.data) ? res.data : [];
        setTasks(rows.filter((t) => t.status !== 'completed' && t.status !== 'cancelled'));
      })
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  }, [order?.id]);

  useEffect(() => {
    if (visible && order?.id) fetchTasks();
    else { setTasks([]); setCompletingId(null); }
  }, [visible, order?.id, fetchTasks]);

  if (!order) return null;

  const handleComplete = async (task) => {
    if (completingId) return;
    setCompletingId(task.id);
    try {
      await api.completeTask(task.id);
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      // Fires on every task, not just once the list empties — the caller's
      // own list (open_task_count / display_stage) should reflect progress
      // live, the same way a single-task Mark Ready elsewhere does.
      onDone?.();
    } catch (err) {
      showAlert('Could not finish this task', err?.message || 'Please try again.');
    } finally {
      setCompletingId(null);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.card} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>Finish Tasks — {order.sale_number}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={5}>
              <Ionicons name="close" size={20} color="#6B7280" />
            </TouchableOpacity>
          </View>
          {loading ? (
            <ActivityIndicator color={Colors.primary} style={{ paddingVertical: 24 }} />
          ) : tasks.length === 0 ? (
            <View style={styles.doneState}>
              <Ionicons name="checkmark-circle" size={32} color={Colors.success} />
              <Text style={styles.doneText}>All tasks are done.</Text>
            </View>
          ) : (
            <ScrollView style={{ maxHeight: 340 }}>
              {tasks.map((task) => (
                <View key={task.id} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.taskName} numberOfLines={1}>{task.item_product_name || task.product_name || 'Item'}</Text>
                    <Text style={styles.taskMeta}>{task.assigned_to_name ? `Assigned to ${task.assigned_to_name}` : 'Unassigned'}</Text>
                  </View>
                  {canComplete(task) && (
                    <TouchableOpacity
                      style={[styles.doneBtn, completingId === task.id && { opacity: 0.6 }]}
                      onPress={() => handleComplete(task)}
                      disabled={!!completingId}
                    >
                      {completingId === task.id
                        ? <ActivityIndicator size="small" color="#fff" />
                        : <Text style={styles.doneBtnText}>Mark Done</Text>}
                    </TouchableOpacity>
                  )}
                </View>
              ))}
            </ScrollView>
          )}
          <TouchableOpacity style={styles.closeBtn} onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.closeBtnText}>Close</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.5)', justifyContent: 'flex-end' },
  card: { backgroundColor: '#fff', borderTopLeftRadius: 16, borderTopRightRadius: 16, marginTop: 'auto', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 24 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  title: { fontSize: 16, fontWeight: '800', color: '#111827', flex: 1, fontFamily: FONT_FAMILY },
  doneState: { alignItems: 'center', gap: 8, paddingVertical: 24 },
  doneText: { fontSize: 14, color: Colors.textSecondary, fontFamily: FONT_FAMILY },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 56, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: '#F3F4F6', gap: 10 },
  taskName: { fontSize: 15, fontWeight: '700', color: '#111827', fontFamily: FONT_FAMILY },
  taskMeta: { fontSize: 12, color: '#6B7280', marginTop: 2, fontFamily: FONT_FAMILY },
  doneBtn: { minHeight: 40, minWidth: 96, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: Colors.success, paddingHorizontal: 12 },
  doneBtnText: { fontSize: 13, fontWeight: '700', color: '#fff', fontFamily: FONT_FAMILY },
  closeBtn: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  closeBtnText: { fontSize: 15, fontWeight: '700', color: Colors.textSecondary, fontFamily: FONT_FAMILY },
});
