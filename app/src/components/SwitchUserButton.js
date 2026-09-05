import React from 'react';
import { TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth, isSharedDeviceStaffRole } from '../context/AuthContext';
import { Colors } from '../constants/theme';

export default function SwitchUserButton() {
  const { lock, user } = useAuth();

  // Switch User (the staff PIN tile grid) only makes sense for shared-device
  // staff roles (employee/counter_staff/florist_staff). Owner/manager/
  // delivery_partner/customer use their own personal device with
  // phone+password — they have no PIN tile to switch to, so this button
  // must not render for them.
  if (!user || !isSharedDeviceStaffRole(user.role)) return null;

  return (
    <TouchableOpacity onPress={lock} style={{ marginRight: 12 }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
      <Ionicons name="lock-closed-outline" size={22} color={Colors.text} />
    </TouchableOpacity>
  );
}
