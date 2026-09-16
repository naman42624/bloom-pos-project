// app/src/screens/AttendanceHubScreen.js
//
// Owner/manager's new Attendance & Payroll hub — added ALONGSIDE
// AttendanceScreen (not replacing its route, see Task 19) since three real
// capabilities (outdoor-duty approval, a manager's own clock-in, Live Map)
// exist only there. Two tabs: Today (live roster) and Manage (the six
// existing screens including AttendanceScreen's own sections, reached
// directly instead of nested inside Quick Links). See spec §7.
import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import AttendanceRoster from '../components/attendance/AttendanceRoster';

const TABS = [{ key: 'today', label: 'Today' }, { key: 'manage', label: 'Manage' }];

export default function AttendanceHubScreen({ navigation }) {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';
  const [tab, setTab] = useState('today');
  const [advancesPendingCount, setAdvancesPendingCount] = useState(0);

  useEffect(() => {
    api.getSalaryAdvances({ status: 'pending' }).then((res) => {
      setAdvancesPendingCount((res.data || []).length);
    }).catch(() => {});
  }, []);

  const manageLinks = [
    // These three point at the EXISTING 'Attendance' route (AttendanceScreen,
    // untouched — see Task 19) — nothing an owner/manager could do before
    // this hub shipped becomes unreachable after.
    { key: 'Attendance', label: 'My Attendance', icon: 'time' },
    { key: 'Attendance', label: 'Outdoor Requests', icon: 'walk', params: { scrollTo: 'outdoorRequests' } },
    { key: 'LiveDeliveryMap', label: 'Live Map', icon: 'map', showFor: isOwner || user?.role === 'manager' },
    { key: 'ShiftManagement', label: 'Shifts', icon: 'calendar' },
    { key: 'SalaryAdvances', label: 'Advances', icon: 'cash', badge: advancesPendingCount },
    { key: 'AttendanceReport', label: 'Reports', icon: 'bar-chart' },
    ...(isOwner ? [{ key: 'SalaryManagement', label: 'Salaries & Payroll', icon: 'wallet' }] : []),
  ].filter((l) => l.showFor !== false);

  return (
    <View style={styles.container}>
      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <TouchableOpacity key={t.key} style={[styles.tabBtn, tab === t.key && styles.tabBtnActive]} onPress={() => setTab(t.key)}>
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'today' ? (
        <AttendanceRoster />
      ) : (
        <ScrollView contentContainerStyle={styles.manageList}>
          {manageLinks.map((link, idx) => (
            <TouchableOpacity key={`${link.key}-${idx}`} style={styles.manageRow} onPress={() => navigation.navigate(link.key, link.params)}>
              <Ionicons name={link.icon} size={22} color={Colors.primary} />
              <Text style={styles.manageRowText}>{link.label}</Text>
              {!!link.badge && <View style={styles.badge}><Text style={styles.badgeText}>{link.badge}</Text></View>}
              <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  tabBar: { flexDirection: 'row', backgroundColor: Colors.surface, borderBottomWidth: 1, borderColor: Colors.border },
  tabBtn: { flex: 1, paddingVertical: Spacing.md, alignItems: 'center', borderBottomWidth: 3, borderColor: 'transparent' },
  tabBtnActive: { borderColor: Colors.primary },
  tabText: { fontSize: FontSize.md, fontWeight: '600', color: Colors.textLight },
  tabTextActive: { color: Colors.primary },
  manageList: { padding: Spacing.md },
  manageRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md,
    padding: Spacing.md, marginBottom: Spacing.sm,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
  },
  manageRowText: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  badge: {
    backgroundColor: Colors.danger, borderRadius: 10, minWidth: 20, height: 20,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
