import React from 'react';
import { View } from 'react-native';
import NotificationBell from './NotificationBell';
import SwitchUserButton from './SwitchUserButton';

// Combines the notification bell with the counter-lock button (2026-09-13,
// staff-ux fix). Before this, a handful of "home" screens (Dashboard,
// Profile, and their delivery_partner/customer equivalents) set headerRight
// to JUST NotificationBell, silently replacing SwitchUserButton — the
// default every OTHER screen gets via stackScreenOptions in
// MainNavigator.js. SwitchUserButton already renders null for every role
// that isn't a shared-device staff role (see its own file), so this is
// always safe to render everywhere the bell shows, not just on screens a
// staff member happens to reach.
export default function HeaderActions({ navigation }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <NotificationBell navigation={navigation} />
      <SwitchUserButton />
    </View>
  );
}
