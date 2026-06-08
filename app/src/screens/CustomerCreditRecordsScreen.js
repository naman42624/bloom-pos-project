import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, Alert, Modal, Platform, KeyboardAvoidingView, ScrollView, ActivityIndicator
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import { formatDate as formatTimestampDate } from '../utils/datetime';
import DateTimePickerModal from '../components/DateTimePickerModal';

export default function CustomerCreditRecordsScreen({ route, navigation }) {
  const { user } = useAuth();
  const { customerId, customerName } = route.params;
  const isOwner = user?.role === 'owner';

  const [records, setRecords] = useState([]);
  const [total, setTotal] = useState(0);
  const [creditBalance, setCreditBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const limit = 20;

  // Filters
  const [search, setSearch] = useState('');
  const [method, setMethod] = useState('all');
  const [type, setType] = useState('all');
  const [sort, setSort] = useState('date_desc');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Date Pickers
  const [showStartDatePicker, setShowStartDatePicker] = useState(false);
  const [showEndDatePicker, setShowEndDatePicker] = useState(false);

  // Edit Modal
  const [editRecord, setEditRecord] = useState(null);
  const [editAmount, setEditAmount] = useState('');
  const [editMethod, setEditMethod] = useState('cash');
  const [editNotes, setEditNotes] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  // Add Modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [addType, setAddType] = useState('payment'); // 'payment' | 'debt'
  const [addAmount, setAddAmount] = useState('');
  const [addMethod, setAddMethod] = useState('cash'); // 'cash' | 'card' | 'upi'
  const [addDate, setAddDate] = useState('');
  const [addNotes, setAddNotes] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [showAddDatePicker, setShowAddDatePicker] = useState(false);

  const fetchRecords = useCallback(async (reset = false) => {
    try {
      const currentOffset = reset ? 0 : offset;
      if (reset) {
        setLoading(true);
        setRecords([]);
      } else {
        setLoadingMore(true);
      }

      const params = {
        limit,
        offset: currentOffset,
        search,
        method,
        type,
        sort,
      };
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;

      const query = new URLSearchParams(params).toString();
      const res = await api.request(`/customers/${customerId}/credits?${query}`);
      
      if (reset) {
        setRecords(res.data || []);
      } else {
        setRecords(prev => [...prev, ...(res.data || [])]);
      }
      setTotal(res.total || 0);
      setCreditBalance(res.credit_balance || 0);
      setOffset(currentOffset + limit);
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load records');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, [customerId, search, method, type, sort, startDate, endDate, offset, limit]);

  useFocusEffect(useCallback(() => {
    fetchRecords(true);
  }, [search, method, type, sort, startDate, endDate]));

  const handleExportCSV = () => {
    setShowExportModal(true);
  };

  const executeExport = async (includeAll) => {
    try {
      const params = {
        limit: 999999,
        offset: 0,
        search, startDate, endDate, method, type, sort,
        includeAllOrders: includeAll ? 'true' : 'false'
      };
      const query = new URLSearchParams(params).toString();
      const res = await api.request(`/customers/${customerId}/credits?${query}`);
      const data = res.data || [];

      if (!data || data.length === 0) return Alert.alert('Export', 'No data to export.');

      let totalReceived = 0;
      let totalDue = 0;
      data.forEach(row => {
        const amt = parseFloat(row.amount) || 0;
        if (amt > 0) totalReceived += amt;
        else totalDue += Math.abs(amt);
      });
      const netBalance = totalReceived - totalDue;

      const csvRows = [
        `Customer Ledger, "${customerName}"`,
        `Export Date, "${new Date().toLocaleDateString()}"`,
        `Included Orders, "${includeAll ? 'All Orders' : 'Credit Orders Only'}"`,
        ``, // Empty line
        ['Date', 'Type', 'Method', 'Debt Added', 'Payment Received', 'Recorded By', 'Location', 'Notes'].join(',')
      ];

      data.forEach(row => {
        let rowType = row.amount > 0 ? 'Payment Received' : 'Debt Added';
        if (row.source_table === 'sales') rowType = 'Order Debt';
        else if (row.source_table === 'payments') rowType = 'Order Payment';
        else if (row.method === 'previous_due') rowType = 'Manual Debt Added';
        
        let displayNotes = row.notes || '';
        if ((row.source_table === 'sales' || row.source_table === 'payments') && row.sale_number) {
          displayNotes += displayNotes ? ` (Order #${row.sale_number})` : `Order #${row.sale_number}`;
        }
        
        if (row.allocation_details) {
          displayNotes += displayNotes ? ` (${row.allocation_details})` : row.allocation_details;
        }

        if (row.source_table === 'sales' && row.remaining_due !== null) {
          const rem = Math.abs(row.remaining_due).toFixed(2);
          displayNotes += displayNotes ? ` [Remaining: ₹${rem}]` : `[Remaining: ₹${rem}]`;
        }
        
        let debtAdded = '';
        let paymentReceived = '';
        if (parseFloat(row.amount) > 0) {
          paymentReceived = Math.abs(row.amount).toFixed(2);
        } else {
          debtAdded = Math.abs(row.amount).toFixed(2);
        }
        
        let formattedDate = '';
        if (row.created_at) {
          const d = new Date(row.created_at);
          formattedDate = !isNaN(d.getTime()) ? d.toLocaleString() : row.created_at;
        }
        
        const values = [
          `"${formattedDate}"`,
          rowType,
          row.method || '',
          debtAdded,
          paymentReceived,
          `"${String(row.received_by_name || '').replace(/"/g, '""')}"`,
          `"${String(row.location_name || '').replace(/"/g, '""')}"`,
          `"${String(displayNotes).replace(/"/g, '""')}"`
        ];
        csvRows.push(values.join(','));
      });

      // Append summary at the bottom
      csvRows.push('');
      csvRows.push(`Total Received (Period), "Rs. ${totalReceived.toFixed(2)}"`);
      csvRows.push(`Total Due Added (Period), "Rs. ${totalDue.toFixed(2)}"`);
      csvRows.push(`Net Balance (Period), "Rs. ${netBalance.toFixed(2)}"`);
      csvRows.push(`Current Outstanding Balance, "Rs. ${Number(creditBalance || 0).toFixed(2)}"`);

      const csvString = csvRows.join('\n');
      const sanitizedName = String(customerName || 'Customer').replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `credit_records_${sanitizedName}.csv`;

      if (Platform.OS === 'web') {
        const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } else {
        const filepath = `${FileSystem.documentDirectory}${filename}`;
        await FileSystem.writeAsStringAsync(filepath, csvString, { encoding: FileSystem.EncodingType.UTF8 });
        
        const isSharingAvailable = await Sharing.isAvailableAsync();
        if (isSharingAvailable) {
          await Sharing.shareAsync(filepath, {
            mimeType: 'text/csv',
            dialogTitle: 'Download Customer Ledger',
            UTI: 'public.comma-separated-values-text'
          });
        } else {
          Alert.alert('Export Successful', `Saved to ${filepath}`);
        }
      }
    } catch (err) {
      console.error('Export Error:', err);
      Alert.alert('Export Error', err.message || 'An unknown error occurred during export.');
    }
  };

  const handleEditSubmit = async () => {
    if (!editRecord) return;
    const amount = parseFloat(editAmount);
    if (isNaN(amount) || amount <= 0) return Alert.alert('Error', 'Enter a valid amount');
    setEditLoading(true);
    try {
      const isPastDue = editRecord.amount < 0;
      const payload = {
        amount: isPastDue ? -Math.abs(amount) : Math.abs(amount),
        method: editMethod,
        notes: editNotes,
      };
      await api.request(`/customers/${customerId}/credits/${editRecord.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      setEditRecord(null);
      fetchRecords(true);
    } catch (err) {
      Alert.alert('Error', err.response?.data?.message || err.message);
    } finally {
      setEditLoading(false);
    }
  };

  const handleDelete = (record) => {
    if (!isOwner) return Alert.alert('Error', 'Only owners can delete records.');
    const doDelete = async () => {
      try {
        await api.request(`/customers/${customerId}/credits/${record.id}`, { method: 'DELETE' });
        fetchRecords(true);
      } catch (err) {
        Alert.alert('Error', err.response?.data?.message || err.message);
      }
    };

    if (Platform.OS === 'web') {
      if (window.confirm('Are you sure you want to delete this record?')) doDelete();
    } else {
      Alert.alert('Delete Record', 'Are you sure you want to delete this record?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', onPress: doDelete, style: 'destructive' },
      ]);
    }
  };

  const handleAddSubmit = async () => {
    const amount = parseFloat(addAmount);
    if (isNaN(amount) || amount <= 0) return Alert.alert('Error', 'Enter a valid positive amount');
    
    setAddLoading(true);
    try {
      if (addType === 'payment') {
        const payload = {
          amount,
          method: addMethod,
          location_id: user?.location_id || 1,
          notes: addNotes,
        };
        await api.request(`/customers/${customerId}/credits`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      } else {
        const payload = {
          amount,
          date: addDate || undefined,
          notes: addNotes,
        };
        await api.request(`/customers/${customerId}/add-due`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      }
      setShowAddModal(false);
      setAddAmount('');
      setAddNotes('');
      setAddDate('');
      fetchRecords(true);
    } catch (err) {
      Alert.alert('Error', err.response?.data?.message || err.message);
    } finally {
      setAddLoading(false);
    }
  };

  const openEditModal = (record) => {
    if (!isOwner) return Alert.alert('Error', 'Only owners can edit records.');
    setEditRecord(record);
    setEditAmount(Math.abs(record.amount).toString());
    setEditMethod(record.method || 'cash');
    setEditNotes(record.notes || '');
  };

  const renderItem = ({ item }) => {
    const isPastDue = item.amount < 0;
    const amountAbs = Math.abs(item.amount).toFixed(2);
    
    let title = isPastDue ? 'Debt Added' : 'Payment Received';
    if (item.source_table === 'sales') title = `Order Debt (Sale #${item.sale_number || item.reference_number})`;
    else if (item.source_table === 'payments') title = `Order Payment (Sale #${item.sale_number || '?'})`;
    else if (item.method === 'previous_due') title = 'Manual Debt Added';
    
    return (
      <View style={[styles.card, isPastDue ? styles.cardWarning : styles.cardSuccess]}>
        <View style={[styles.cardIconWrapper, isPastDue ? { backgroundColor: Colors.warning + '15' } : { backgroundColor: Colors.success + '15' }]}>
          <Ionicons 
            name={item.source_table === 'sales' ? "cart" : (isPastDue ? "document-text" : "wallet")} 
            size={22} 
            color={isPastDue ? Colors.warning : Colors.success} 
          />
        </View>
        
        <View style={styles.cardContent}>
          <View style={styles.cardHeaderRow}>
            <View style={{ flex: 1, paddingRight: 8 }}>
              <Text style={styles.cardTitle}>
                {title}
              </Text>
              <Text style={styles.metaText}>
                {formatTimestampDate(item.created_at)} • {(item.method || 'cash').replace('_', ' ').toUpperCase()}
              </Text>
              <Text style={styles.metaText}>
                by {item.received_by_name || 'Unknown'}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={[styles.amountText, isPastDue ? { color: Colors.warning } : { color: Colors.success }]}>
                {isPastDue ? '+' : '-'} ₹{amountAbs}
              </Text>
              {item.source_table === 'sales' && item.remaining_due !== null && (
                <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 4 }}>
                  Remaining: ₹{Math.abs(item.remaining_due).toFixed(2)}
                </Text>
              )}
            </View>
          </View>

          {item.notes ? <Text style={styles.notesText}>"{item.notes}"</Text> : null}
          {item.allocation_details ? <Text style={[styles.notesText, { color: Colors.success, marginTop: 4, fontStyle: 'italic' }]}>{item.allocation_details}</Text> : null}
          
          {isOwner && item.source_table === 'credit_payment' && (
            <View style={styles.actionRow}>
              <TouchableOpacity onPress={() => openEditModal(item)} style={styles.actionBtn}>
                <Ionicons name="pencil" size={14} color={Colors.textSecondary} />
                <Text style={styles.actionText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleDelete(item)} style={[styles.actionBtn, { borderColor: Colors.error + '40', backgroundColor: Colors.error + '05' }]}>
                <Ionicons name="trash" size={14} color={Colors.error} />
                <Text style={[styles.actionText, { color: Colors.error }]}>Delete</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header & Export */}
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { flex: 1 }]} numberOfLines={1}>{customerName}'s Ledger</Text>
        <TouchableOpacity style={styles.exportBtn} onPress={handleExportCSV}>
          <Ionicons name="download-outline" size={18} color={Colors.white} />
          <Text style={styles.exportText}>Export</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={records}
        keyExtractor={item => `${item.source_table || 'cp'}-${item.id}`}
        ListHeaderComponent={() => (
          <>
            {/* Summary Card */}
            <View style={styles.summaryWrapper}>
        <View style={[styles.summaryCard, creditBalance > 0 ? styles.summaryDanger : styles.summarySuccess]}>
          <View style={styles.summaryHeader}>
            <Ionicons name={creditBalance > 0 ? "alert-circle" : "checkmark-circle"} size={24} color={creditBalance > 0 ? Colors.error : Colors.success} />
            <Text style={[styles.summaryTitle, creditBalance > 0 ? { color: Colors.error } : { color: Colors.success }]} numberOfLines={2}>
              {creditBalance > 0 ? 'Total Outstanding Due' : 'Account Settled / Advance'}
            </Text>
          </View>
          <Text style={[styles.summaryAmount, creditBalance > 0 ? { color: Colors.error } : { color: Colors.success }]}>
            ₹{Math.abs(creditBalance).toFixed(2)}
          </Text>
        </View>
      </View>

      {/* Filters */}
      <View style={styles.filtersContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search notes or staff..."
          placeholderTextColor={Colors.textLight}
          value={search}
          onChangeText={setSearch}
        />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll} contentContainerStyle={{ gap: Spacing.sm }}>
          {/* Type Filter */}
          <View style={styles.pickerContainer}>
            <Text style={styles.pickerLabel}>Type:</Text>
            {['all', 'payment', 'due'].map(t => (
              <TouchableOpacity key={t} onPress={() => setType(t)} style={[styles.chip, type === t && styles.chipActive]}>
                <Text style={[styles.chipText, type === t && styles.chipTextActive]}>{t.toUpperCase()}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {/* Method Filter */}
          <View style={styles.pickerContainer}>
            <Text style={styles.pickerLabel}>Method:</Text>
            {['all', 'cash', 'card', 'upi', 'previous_due'].map(m => (
              <TouchableOpacity key={m} onPress={() => setMethod(m)} style={[styles.chip, method === m && styles.chipActive]}>
                <Text style={[styles.chipText, method === m && styles.chipTextActive]}>{m.replace('_', ' ').toUpperCase()}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {/* Sort Filter */}
          <View style={styles.pickerContainer}>
            <Text style={styles.pickerLabel}>Sort:</Text>
            {['date_desc', 'date_asc', 'amount_desc'].map(s => (
              <TouchableOpacity key={s} onPress={() => setSort(s)} style={[styles.chip, sort === s && styles.chipActive]}>
                <Text style={[styles.chipText, sort === s && styles.chipTextActive]}>{s.replace('_', ' ').toUpperCase()}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {/* Date Filters */}
          <TouchableOpacity onPress={() => setShowStartDatePicker(true)} style={styles.datePickerBtn}>
            <Ionicons name="calendar" size={14} color={Colors.primary} />
            <Text style={styles.datePickerText}>{startDate || 'Start Date'}</Text>
          </TouchableOpacity>
          {startDate ? (
             <TouchableOpacity onPress={() => setStartDate('')} style={styles.clearDateBtn}>
               <Ionicons name="close" size={14} color={Colors.error} />
             </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={() => setShowEndDatePicker(true)} style={styles.datePickerBtn}>
            <Ionicons name="calendar" size={14} color={Colors.primary} />
            <Text style={styles.datePickerText}>{endDate || 'End Date'}</Text>
          </TouchableOpacity>
          {endDate ? (
             <TouchableOpacity onPress={() => setEndDate('')} style={styles.clearDateBtn}>
               <Ionicons name="close" size={14} color={Colors.error} />
             </TouchableOpacity>
          ) : null}
        </ScrollView>
      </View>
          </>
        )}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        onRefresh={() => fetchRecords(true)}
        refreshing={refreshing}
        onEndReached={() => {
          if (!loadingMore && records.length < total) {
            fetchRecords(false);
          }
        }}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          !loading ? <Text style={styles.emptyText}>No records found.</Text> : null
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footerLoader}>
              <ActivityIndicator size="small" color={Colors.primary} />
            </View>
          ) : null
        }
      />

      {/* Date Pickers */}
      <DateTimePickerModal
        visible={showStartDatePicker}
        mode="date"
        value={startDate ? new Date(startDate) : new Date()}
        onConfirm={(date) => {
          const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          setStartDate(d);
          setShowStartDatePicker(false);
        }}
        onCancel={() => setShowStartDatePicker(false)}
      />
      <DateTimePickerModal
        visible={showEndDatePicker}
        mode="date"
        value={endDate ? new Date(endDate) : new Date()}
        onConfirm={(date) => {
          const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          setEndDate(d);
          setShowEndDatePicker(false);
        }}
        onCancel={() => setShowEndDatePicker(false)}
      />

      {/* FAB */}
      {(isOwner || user?.role === 'manager') && (
        <TouchableOpacity style={styles.fab} onPress={() => setShowAddModal(true)}>
          <Ionicons name="add" size={24} color={Colors.white} />
          <Text style={styles.fabText}>Record</Text>
        </TouchableOpacity>
      )}

      {/* Add Record Modal */}
      <Modal visible={showAddModal} transparent animationType="slide">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Transaction</Text>
              <TouchableOpacity onPress={() => setShowAddModal(false)} style={styles.closeBtn}>
                <Ionicons name="close" size={24} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Segmented Control */}
            <View style={styles.segmentContainer}>
              <TouchableOpacity style={[styles.segmentBtn, addType === 'payment' && styles.segmentBtnActivePayment]} onPress={() => setAddType('payment')}>
                <Ionicons name="wallet" size={18} color={addType === 'payment' ? Colors.success : Colors.textSecondary} />
                <Text style={[styles.segmentText, addType === 'payment' && { color: Colors.success }]}>Payment Received</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.segmentBtn, addType === 'debt' && styles.segmentBtnActiveDebt]} onPress={() => setAddType('debt')}>
                <Ionicons name="document-text" size={18} color={addType === 'debt' ? Colors.warning : Colors.textSecondary} />
                <Text style={[styles.segmentText, addType === 'debt' && { color: Colors.warning }]}>Add Debt</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.fieldLabel}>Amount</Text>
            <View style={styles.amountInputWrapper}>
              <Text style={styles.currencySymbol}>₹</Text>
              <TextInput style={styles.amountInput} value={addAmount} onChangeText={setAddAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={Colors.textLight} />
            </View>

            {addType === 'payment' && (
              <>
                <Text style={styles.fieldLabel}>Payment Method</Text>
                <View style={styles.methodRow}>
                  {['cash', 'card', 'upi'].map((m) => (
                    <TouchableOpacity key={m} style={[styles.methodChip, addMethod === m && styles.methodActive]} onPress={() => setAddMethod(m)}>
                      <Text style={[styles.methodText, addMethod === m && styles.methodTextActive]}>{m.replace('_', ' ').toUpperCase()}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}

            {addType === 'debt' && (
              <>
                <Text style={styles.fieldLabel}>Date (optional)</Text>
                <TouchableOpacity onPress={() => setShowAddDatePicker(true)} style={[styles.modalInput, { justifyContent: 'center' }]}>
                  <Text style={{ color: addDate ? Colors.text : Colors.textLight, fontSize: FontSize.md, fontWeight: addDate ? '600' : '400' }}>
                    {addDate || 'Today (Auto)'}
                  </Text>
                </TouchableOpacity>
              </>
            )}

            <Text style={styles.fieldLabel}>Notes (optional)</Text>
            <TextInput style={styles.modalInput} value={addNotes} onChangeText={setAddNotes} placeholder="Add any details..." placeholderTextColor={Colors.textLight} />

            <TouchableOpacity style={[styles.submitBtn, addLoading && { opacity: 0.6 }]} onPress={handleAddSubmit} disabled={addLoading}>
              <Text style={styles.submitText}>{addLoading ? 'Saving...' : 'Save Transaction'}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Add Date Picker */}
      <DateTimePickerModal
        visible={showAddDatePicker}
        mode="date"
        value={addDate ? new Date(addDate) : new Date()}
        onConfirm={(date) => {
          const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          setAddDate(d);
          setShowAddDatePicker(false);
        }}
        onCancel={() => setShowAddDatePicker(false)}
      />

      {/* Edit Modal */}
      <Modal visible={!!editRecord} transparent animationType="slide">
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Edit Transaction</Text>
              <TouchableOpacity onPress={() => setEditRecord(null)} style={styles.closeBtn}>
                <Ionicons name="close" size={24} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
            
            {editRecord?.sale_id && (
              <View style={styles.warningBox}>
                <Ionicons name="warning" size={16} color={Colors.warning} />
                <Text style={styles.warningText}>This payment is linked to a sale. Amount and Method cannot be edited here.</Text>
              </View>
            )}

            <Text style={styles.fieldLabel}>Amount</Text>
            <View style={[styles.amountInputWrapper, !!editRecord?.sale_id && { backgroundColor: Colors.background, opacity: 0.7 }]}>
              <Text style={styles.currencySymbol}>₹</Text>
              <TextInput style={styles.amountInput} value={editAmount} onChangeText={setEditAmount}
                keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={Colors.textLight} 
                editable={!editRecord?.sale_id} />
            </View>
            {editRecord?.amount > 0 && (
              <>
                <Text style={styles.fieldLabel}>Payment Method</Text>
                <View style={[styles.methodRow, { flexWrap: 'wrap' }]}>
                  {['cash', 'card', 'upi'].map((m) => (
                    <TouchableOpacity key={m} style={[styles.methodChip, editMethod === m && styles.methodActive, !!editRecord?.sale_id && editMethod !== m && { opacity: 0.5 }]}
                      onPress={() => { if (!editRecord?.sale_id) setEditMethod(m); }}
                      disabled={!!editRecord?.sale_id}
                    >
                      <Text style={[styles.methodText, editMethod === m && styles.methodTextActive]}>{m.toUpperCase()}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
            
            <Text style={styles.fieldLabel}>Notes (optional)</Text>
            <TextInput style={styles.modalInput} value={editNotes} onChangeText={setEditNotes}
              placeholder="Payment notes" placeholderTextColor={Colors.textLight} />
              
            <TouchableOpacity style={[styles.submitBtn, editLoading && { opacity: 0.6 }]}
              onPress={handleEditSubmit} disabled={editLoading}>
              <Text style={styles.submitText}>{editLoading ? 'Saving...' : 'Save Changes'}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Export Options Modal */}
      <Modal visible={showExportModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Export Ledger</Text>
                <Text style={styles.modalSubtitle}>Choose records to include</Text>
              </View>
              <TouchableOpacity onPress={() => setShowExportModal(false)} style={styles.closeBtn}>
                <Ionicons name="close" size={24} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={{ marginTop: 8 }}>
              <TouchableOpacity 
                style={[styles.exportOptionCard, { borderColor: Colors.primary + '40', backgroundColor: Colors.primary + '05' }]} 
                onPress={() => { setShowExportModal(false); executeExport(false); }}
              >
                <View style={[styles.exportOptionIcon, { backgroundColor: Colors.primary + '20' }]}>
                  <Ionicons name="document-text" size={20} color={Colors.primary} />
                </View>
                <View style={styles.exportOptionTextWrapper}>
                  <Text style={styles.exportOptionTitle}>Credit Orders Only</Text>
                  <Text style={styles.exportOptionDesc}>Standard accounting format. Includes manual dues, unpaid orders, and payments made against credit.</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={Colors.primary} />
              </TouchableOpacity>

              <TouchableOpacity 
                style={[styles.exportOptionCard, { borderColor: Colors.textLight + '30', marginTop: 12 }]} 
                onPress={() => { setShowExportModal(false); executeExport(true); }}
              >
                <View style={[styles.exportOptionIcon, { backgroundColor: Colors.textLight + '15' }]}>
                  <Ionicons name="list" size={20} color={Colors.textSecondary} />
                </View>
                <View style={styles.exportOptionTextWrapper}>
                  <Text style={styles.exportOptionTitle}>All Orders</Text>
                  <Text style={styles.exportOptionDesc}>Includes everything above plus fully-paid walk-in orders that never carried a debt.</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: Spacing.md, backgroundColor: Colors.surface, borderBottomWidth: 1, borderColor: Colors.border,
  },
  headerTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, letterSpacing: -0.5 },
  exportBtn: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.md, paddingVertical: 8, borderRadius: BorderRadius.full, gap: 4,
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 2,
  },
  exportText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.sm },
  
  fab: {
    position: 'absolute', bottom: Spacing.xl, right: Spacing.lg,
    flexDirection: 'row', gap: 6, paddingHorizontal: 20, height: 54, borderRadius: 27, backgroundColor: Colors.primary,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 8, elevation: 5,
  },
  fabText: { color: Colors.white, fontWeight: '700', fontSize: FontSize.md },

  summaryWrapper: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.background,
  },
  summaryCard: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 3,
  },
  summaryDanger: {
    backgroundColor: Colors.surface,
    borderColor: Colors.error + '30',
    shadowColor: Colors.error,
  },
  summarySuccess: {
    backgroundColor: Colors.surface,
    borderColor: Colors.success + '30',
    shadowColor: Colors.success,
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    marginBottom: Spacing.xs,
  },
  summaryTitle: {
    fontSize: FontSize.md,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flex: 1,
    flexWrap: 'wrap',
  },
  summaryAmount: {
    fontSize: FontSize.xxl,
    fontWeight: '900',
    letterSpacing: -1,
    marginTop: Spacing.xs,
  },

  filtersContainer: { backgroundColor: Colors.surface, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, borderBottomWidth: 1, borderColor: Colors.border, marginBottom: Spacing.sm },
  searchInput: {
    backgroundColor: Colors.background, borderRadius: BorderRadius.lg, padding: Spacing.md,
    fontSize: FontSize.sm, color: Colors.text, borderWidth: 1, borderColor: Colors.border, marginBottom: Spacing.sm,
  },
  filterScroll: { flexDirection: 'row' },
  pickerContainer: { flexDirection: 'row', alignItems: 'center', gap: 6, marginRight: Spacing.lg },
  pickerLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: BorderRadius.full,
    borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.background,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
  chipTextActive: { color: Colors.white },
  datePickerBtn: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.primary + '50', backgroundColor: Colors.primary + '05', gap: 6,
  },
  clearDateBtn: {
    justifyContent: 'center', alignItems: 'center', paddingHorizontal: 6, marginRight: Spacing.md,
  },
  datePickerText: { fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600' },
  
  listContent: { padding: Spacing.md, paddingBottom: Spacing.xxl },
  card: {
    flexDirection: 'row', alignItems: 'flex-start', backgroundColor: Colors.surface,
    padding: Spacing.md, borderRadius: BorderRadius.xl, marginBottom: Spacing.md,
    borderWidth: 1,
    shadowColor: Colors.black, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 1,
  },
  cardWarning: {
    borderColor: Colors.warning + '40',
  },
  cardSuccess: {
    borderColor: Colors.border,
  },
  cardIconWrapper: {
    width: 44, height: 44, borderRadius: 22,
    justifyContent: 'center', alignItems: 'center',
    marginRight: Spacing.md,
  },
  cardContent: {
    flex: 1,
  },
  cardHeaderRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4,
  },
  cardTitle: {
    fontSize: FontSize.md, fontWeight: '700', color: Colors.text, letterSpacing: -0.3, marginBottom: 2,
  },
  amountText: { fontSize: FontSize.md + 2, fontWeight: '800', letterSpacing: -0.5, marginTop: 2 },
  metaText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500', marginBottom: 2 },
  notesText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontStyle: 'italic', marginTop: Spacing.xs, backgroundColor: Colors.background, padding: Spacing.sm, borderRadius: BorderRadius.sm, overflow: 'hidden' },
  
  actionRow: {
    flexDirection: 'row', justifyContent: 'flex-start', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.md, paddingTop: Spacing.sm, borderTopWidth: 1, borderColor: Colors.border,
  },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: Colors.background, borderRadius: BorderRadius.full, borderWidth: 1, borderColor: Colors.border },
  actionText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary },
  
  emptyText: { textAlign: 'center', marginTop: 60, color: Colors.textLight, fontSize: FontSize.md, fontWeight: '500' },
  
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: Colors.surface, borderTopLeftRadius: BorderRadius.xl, borderTopRightRadius: BorderRadius.xl, padding: Spacing.xl },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.lg },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  closeBtn: { padding: 4, backgroundColor: Colors.background, borderRadius: BorderRadius.full },
  
  segmentContainer: {
    flexDirection: 'row', backgroundColor: Colors.background, borderRadius: BorderRadius.lg, padding: 4, marginBottom: Spacing.lg,
  },
  segmentBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: BorderRadius.md, gap: 8,
  },
  segmentBtnActivePayment: {
    backgroundColor: Colors.surface,
    shadowColor: Colors.success, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4, elevation: 2,
  },
  segmentBtnActiveDebt: {
    backgroundColor: Colors.surface,
    shadowColor: Colors.warning, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4, elevation: 2,
  },
  segmentText: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary },
  
  fieldLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.xs, marginLeft: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  
  amountInputWrapper: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.lg, paddingHorizontal: Spacing.md, marginBottom: Spacing.lg,
  },
  currencySymbol: { fontSize: FontSize.xl + 4, fontWeight: '800', color: Colors.textSecondary, marginRight: 8 },
  amountInput: { flex: 1, fontSize: FontSize.xxl + 4, fontWeight: '800', color: Colors.text, paddingVertical: Spacing.md },
  
  modalInput: { backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.lg, padding: Spacing.md, fontSize: FontSize.md, color: Colors.text, marginBottom: Spacing.lg },
  
  methodRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.lg },
  methodChip: { flex: 1, paddingVertical: 12, alignItems: 'center', borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.background },
  methodActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  methodText: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary },
  methodTextActive: { color: Colors.white },
  
  submitBtn: { backgroundColor: Colors.primary, paddingVertical: Spacing.md, borderRadius: BorderRadius.full, alignItems: 'center', marginTop: Spacing.sm, shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 8, elevation: 3 },
  submitText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '700' },
  
  warningBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.warning + '15', padding: Spacing.md, borderRadius: BorderRadius.lg, marginBottom: Spacing.md, borderWidth: 1, borderColor: Colors.warning + '30' },
  warningText: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.warning, flex: 1 },
  footerLoader: { paddingVertical: Spacing.lg, alignItems: 'center', justifyContent: 'center' },
  modalSubtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  exportOptionCard: { flexDirection: 'row', alignItems: 'center', padding: 16, borderWidth: 1, borderRadius: 12 },
  exportOptionIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  exportOptionTextWrapper: { flex: 1, paddingRight: 8 },
  exportOptionTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, marginBottom: 4 },
  exportOptionDesc: { fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 18 },
});
