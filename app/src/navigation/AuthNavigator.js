import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import SetupScreen from '../screens/SetupScreen';
import { Colors } from '../constants/theme';

const Stack = createNativeStackNavigator();

export default function AuthNavigator({ showSetup = false }) {
  return (
    <Stack.Navigator
      initialRouteName={showSetup ? 'Setup' : 'Login'}
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: Colors.background },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="Setup" component={SetupScreen} />
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Register" component={RegisterScreen} />
    </Stack.Navigator>
  );
}
