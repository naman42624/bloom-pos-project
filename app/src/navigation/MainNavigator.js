import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useAuth } from '../context/AuthContext';
import useGeofence from '../hooks/useGeofence';
import useDeliveryTracking from '../hooks/useDeliveryTracking';

import DashboardScreen from '../screens/DashboardScreen';
import LocationsScreen from '../screens/LocationsScreen';
import LocationDetailScreen from '../screens/LocationDetailScreen';
import LocationFormScreen from '../screens/LocationFormScreen';
import UsersScreen from '../screens/UsersScreen';
import UserFormScreen from '../screens/UserFormScreen';
import ProfileScreen from '../screens/ProfileScreen';
import SettingsScreen from '../screens/SettingsScreen';
import DataManagementScreen from '../screens/DataManagementScreen';

// Phase 2 — Inventory
import CategoriesScreen from '../screens/CategoriesScreen';
import CategoryDetailScreen from '../screens/CategoryDetailScreen';
import CategoryFormScreen from '../screens/CategoryFormScreen';
import MaterialsScreen from '../screens/MaterialsScreen';
import MaterialDetailScreen from '../screens/MaterialDetailScreen';
import MaterialFormScreen from '../screens/MaterialFormScreen';
import SuppliersScreen from '../screens/SuppliersScreen';
import SupplierDetailScreen from '../screens/SupplierDetailScreen';
import SupplierFormScreen from '../screens/SupplierFormScreen';
import PurchaseOrdersScreen from '../screens/PurchaseOrdersScreen';
import PurchaseOrderDetailScreen from '../screens/PurchaseOrderDetailScreen';
import PurchaseOrderFormScreen from '../screens/PurchaseOrderFormScreen';
import StockOverviewScreen from '../screens/StockOverviewScreen';
import InventoryMetricsScreen from '../screens/InventoryMetricsScreen';
import StockAdjustScreen from '../screens/StockAdjustScreen';
import StockTransfersScreen from '../screens/StockTransfersScreen';
import StockTransferFormScreen from '../screens/StockTransferFormScreen';

// Phase 3 — Products & QR
import ProductsScreen from '../screens/ProductsScreen';
import ProductDetailScreen from '../screens/ProductDetailScreen';
import ProductFormScreen from '../screens/ProductFormScreen';
import ProductStockScreen from '../screens/ProductStockScreen';
import QRScannerScreen from '../screens/QRScannerScreen';
import QRLabelScreen from '../screens/QRLabelScreen';

// Phase 4 — POS & Sales
import POSScreen from '../screens/POSScreen';
import QuickCheckoutScreen from '../screens/QuickCheckoutScreen';
import CheckoutScreen from '../screens/CheckoutScreen';
import SaleDraftsScreen from '../screens/SaleDraftsScreen';
import SaleDetailScreen from '../screens/SaleDetailScreen';
import SalesScreen from '../screens/SalesScreen';
import CashRegisterScreen from '../screens/CashRegisterScreen';
import RefundSaleScreen from '../screens/RefundSaleScreen';
import AddPaymentScreen from '../screens/AddPaymentScreen';
import ExpensesScreen from '../screens/ExpensesScreen';

// Phase 5 — Customers
import CustomersScreen from '../screens/CustomersScreen';
import CustomerDetailScreen from '../screens/CustomerDetailScreen';
import CustomerFormScreen from '../screens/CustomerFormScreen';

// Production Queue
import ProductionQueueScreen from '../screens/ProductionQueueScreen';
import ProduceScreen from '../screens/ProduceScreen';
import CompletedTasksScreen from '../screens/CompletedTasksScreen';

// Phase 7 — Orders & Delivery
import DeliveriesScreen from '../screens/DeliveriesScreen';
import DeliveryDetailScreen from '../screens/DeliveryDetailScreen';
import SettlementsScreen from '../screens/SettlementsScreen';
import PickupOrdersScreen from '../screens/PickupOrdersScreen';
import CustomerOrdersScreen from '../screens/CustomerOrdersScreen';

// More hub
import MoreScreen from '../screens/MoreScreen';
import OrdersHubScreen from '../screens/OrdersHubScreen';

// Recurring Orders
import RecurringOrdersScreen from '../screens/RecurringOrdersScreen';
import AddRecurringOrderScreen from '../screens/AddRecurringOrderScreen';
import CustomerShopScreen from '../screens/CustomerShopScreen';

// Phase 8 — Attendance
import AttendanceScreen from '../screens/AttendanceScreen';

// Phase 9 — Reports
import ReportsHubScreen from '../screens/ReportsHubScreen';
import SalesReportScreen from '../screens/SalesReportScreen';
import InventoryReportScreen from '../screens/InventoryReportScreen';
import CustomerInsightsScreen from '../screens/CustomerInsightsScreen';
import EmployeePerformanceScreen from '../screens/EmployeePerformanceScreen';
import StaffAttendanceScreen from '../screens/StaffAttendanceScreen';
import AttendanceReportScreen from '../screens/AttendanceReportScreen';
import SalaryAdvancesScreen from '../screens/SalaryAdvancesScreen';
import ShiftManagementScreen from '../screens/ShiftManagementScreen';
import SalaryManagementScreen from '../screens/SalaryManagementScreen';
import LiveDeliveryMapScreen from '../screens/LiveDeliveryMapScreen';
import NotificationCenterScreen from '../screens/NotificationCenterScreen';
import NotificationBell from '../components/NotificationBell';
import usePushNotifications from '../hooks/usePushNotifications';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors, FontSize } from '../constants/theme';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const stackScreenOptions = {
  headerStyle: { backgroundColor: Colors.surface },
  headerTintColor: Colors.text,
  headerTitleStyle: { fontWeight: '600' },
  contentStyle: { backgroundColor: Colors.background },
};

// ─── Dashboard Stack ────────────────────────────────────────
function DashboardStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen
        name="DashboardHome"
        component={DashboardScreen}
        options={({ navigation }) => ({
          title: 'Dashboard',
          headerRight: () => <NotificationBell navigation={navigation} />,
        })}
      />
      <Stack.Screen name="Notifications" component={NotificationCenterScreen} options={{ title: 'Notifications' }} />
      <Stack.Screen name="SaleDrafts" component={SaleDraftsScreen} options={{ title: 'Saved Drafts' }} />
      <Stack.Screen name="SaleDetail" component={SaleDetailScreen} options={{ title: 'Sale Details' }} />
      <Stack.Screen name="DeliveryDetail" component={DeliveryDetailScreen} options={{ title: 'Delivery' }} />
      <Stack.Screen name="ProductionQueue" component={ProductionQueueScreen} options={{ title: 'Production Queue' }} />
      <Stack.Screen name="CompletedTasks" component={CompletedTasksScreen} options={{ title: 'Completed Tasks' }} />
      <Stack.Screen name="ProduceProduct" component={ProduceScreen} options={{ title: 'Produce Products' }} />
      <Stack.Screen name="RefundSale" component={RefundSaleScreen} options={{ title: 'Refund' }} />
      <Stack.Screen name="MaterialDetail" component={MaterialDetailScreen} options={{ title: 'Material Details' }} />
    </Stack.Navigator>

  );
}

// ─── Locations Stack (Owner/Manager) ────────────────────────
function LocationsStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen
        name="LocationsList"
        component={LocationsScreen}
        options={{ title: 'Locations' }}
      />
      <Stack.Screen
        name="LocationDetail"
        component={LocationDetailScreen}
        options={{ title: 'Location Details' }}
      />
      <Stack.Screen
        name="LocationForm"
        component={LocationFormScreen}
        options={({ route }) => ({
          title: route.params?.location ? 'Edit Location' : 'New Location',
          presentation: 'modal',
        })}
      />
    </Stack.Navigator>
  );
}

// ─── Users Stack (Owner/Manager) ────────────────────────────
function UsersStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen
        name="UsersList"
        component={UsersScreen}
        options={{ title: 'Staff' }}
      />
      <Stack.Screen
        name="UserForm"
        component={UserFormScreen}
        options={({ route }) => ({
          title: route.params?.user ? 'Edit Staff' : 'Add Staff',
          presentation: 'modal',
        })}
      />
    </Stack.Navigator>
  );
}

// ─── Inventory Stack (Owner/Manager/Employee) ──────────────
function InventoryStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen
        name="StockOverview"
        component={StockOverviewScreen}
        options={{ title: 'Inventory' }}
      />
      {/* Categories */}
      <Stack.Screen name="Categories" component={CategoriesScreen} options={{ title: 'Categories' }} />
      <Stack.Screen name="CategoryDetail" component={CategoryDetailScreen} options={{ title: 'Category' }} />
      <Stack.Screen
        name="CategoryForm"
        component={CategoryFormScreen}
        options={({ route }) => ({ title: route.params?.category ? 'Edit Category' : 'New Category', presentation: 'modal' })}
      />
      {/* Materials */}
      <Stack.Screen name="Materials" component={MaterialsScreen} options={{ title: 'Materials' }} />
      <Stack.Screen name="MaterialDetail" component={MaterialDetailScreen} options={{ title: 'Material' }} />
      <Stack.Screen
        name="MaterialForm"
        component={MaterialFormScreen}
        options={({ route }) => ({ title: route.params?.material ? 'Edit Material' : 'New Material', presentation: 'modal' })}
      />
      {/* Suppliers */}
      <Stack.Screen name="Suppliers" component={SuppliersScreen} options={{ title: 'Suppliers' }} />
      <Stack.Screen name="SupplierDetail" component={SupplierDetailScreen} options={{ title: 'Supplier' }} />
      <Stack.Screen
        name="SupplierForm"
        component={SupplierFormScreen}
        options={({ route }) => ({ title: route.params?.supplier ? 'Edit Supplier' : 'New Supplier', presentation: 'modal' })}
      />
      {/* Purchase Orders */}
      <Stack.Screen name="PurchaseOrders" component={PurchaseOrdersScreen} options={{ title: 'Purchase Orders' }} />
      <Stack.Screen name="PurchaseOrderDetail" component={PurchaseOrderDetailScreen} options={{ title: 'Order Details' }} />
      <Stack.Screen
        name="PurchaseOrderForm"
        component={PurchaseOrderFormScreen}
        options={({ route }) => ({ title: route.params?.order ? 'Edit Order' : 'New Order', presentation: 'modal' })}
      />
      {/* Stock */}
      <Stack.Screen name="StockAdjust" component={StockAdjustScreen} options={{ title: 'Adjust Stock', presentation: 'modal' }} />
      <Stack.Screen name="InventoryMetrics" component={InventoryMetricsScreen} options={{ title: 'Inventory Metrics' }} />
      <Stack.Screen name="ProductStock" component={ProductStockScreen} options={{ title: 'Product Stock' }} />
      <Stack.Screen name="StockTransfers" component={StockTransfersScreen} options={{ title: 'Transfers' }} />
      <Stack.Screen
        name="StockTransferForm"
        component={StockTransferFormScreen}
        options={{ title: 'New Transfer', presentation: 'modal' }}
      />
      {/* Products */}
      <Stack.Screen name="Products" component={ProductsScreen} options={{ title: 'Products' }} />
      <Stack.Screen name="ProductDetail" component={ProductDetailScreen} options={{ title: 'Product' }} />
      <Stack.Screen
        name="ProductForm"
        component={ProductFormScreen}
        options={({ route }) => ({ title: route.params?.product ? 'Edit Product' : 'New Product', presentation: 'modal' })}
      />
      {/* QR */}
      <Stack.Screen name="QRScanner" component={QRScannerScreen} options={{ title: 'Scan QR Code' }} />
      <Stack.Screen name="QRLabel" component={QRLabelScreen} options={{ title: 'QR Label' }} />
    </Stack.Navigator>
  );
}

// ─── Customers Stack (Owner/Manager) ────────────────────────
function CustomersStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen name="CustomersList" component={CustomersScreen} options={{ title: 'Customers' }} />
      <Stack.Screen name="CustomerDetail" component={CustomerDetailScreen} options={{ title: 'Customer' }} />
      <Stack.Screen
        name="CustomerForm"
        component={CustomerFormScreen}
        options={({ route }) => ({ title: route.params?.customer ? 'Edit Customer' : 'New Customer', presentation: 'modal' })}
      />
      <Stack.Screen name="SaleDetail" component={SaleDetailScreen} options={{ title: 'Sale Details' }} />
    </Stack.Navigator>
  );
}

// ─── Profile Stack ──────────────────────────────────────────
function ProfileStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen
        name="ProfileHome"
        component={ProfileScreen}
        options={({ navigation }) => ({
          title: 'Profile',
          headerRight: () => <NotificationBell navigation={navigation} />,
        })}
      />
      <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
      <Stack.Screen name="Notifications" component={NotificationCenterScreen} options={{ title: 'Notifications' }} />
    </Stack.Navigator>
  );
}

// ─── POS Stack ──────────────────────────────────────────────
function POSStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen name="POSHome" component={POSScreen} options={{ title: 'Point of Sale' }} />
      <Stack.Screen name="SaleDrafts" component={SaleDraftsScreen} options={{ title: 'Saved Drafts' }} />
      <Stack.Screen name="QuickCheckout" component={QuickCheckoutScreen} options={{ title: 'Quick Checkout' }} />
      <Stack.Screen name="Checkout" component={CheckoutScreen} options={{ title: 'Checkout' }} />
      <Stack.Screen name="SaleDetail" component={SaleDetailScreen} options={{ title: 'Sale Details' }} />
      <Stack.Screen name="RefundSale" component={RefundSaleScreen} options={{ title: 'Refund' }} />
      <Stack.Screen name="AddPayment" component={AddPaymentScreen} options={{ title: 'Record Payment' }} />
      <Stack.Screen name="QRScanner" component={QRScannerScreen} options={{ title: 'Scan QR' }} />
      <Stack.Screen name="CashRegister" component={CashRegisterScreen} options={{ title: 'Cash Register' }} />
      <Stack.Screen name="Expenses" component={ExpensesScreen} options={{ title: 'Expenses' }} />
      <Stack.Screen name="ProductionQueue" component={ProductionQueueScreen} options={{ title: 'Production Queue' }} />
      <Stack.Screen name="CompletedTasks" component={CompletedTasksScreen} options={{ title: 'Completed Tasks' }} />
      <Stack.Screen name="ProduceProduct" component={ProduceScreen} options={{ title: 'Produce Products' }} />
      <Stack.Screen name="DeliveryDetail" component={DeliveryDetailScreen} options={{ title: 'Delivery' }} />
    </Stack.Navigator>
  );
}

// ─── Sales Stack ────────────────────────────────────────────
function SalesStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen name="SalesList" component={SalesScreen} options={{ title: 'Sales' }} />
      <Stack.Screen name="SaleDetail" component={SaleDetailScreen} options={{ title: 'Sale Details' }} />
      <Stack.Screen name="RefundSale" component={RefundSaleScreen} options={{ title: 'Refund' }} />
      <Stack.Screen name="AddPayment" component={AddPaymentScreen} options={{ title: 'Record Payment' }} />
      <Stack.Screen name="CashRegister" component={CashRegisterScreen} options={{ title: 'Cash Register' }} />
      <Stack.Screen name="Expenses" component={ExpensesScreen} options={{ title: 'Expenses' }} />
      <Stack.Screen name="ProductionQueue" component={ProductionQueueScreen} options={{ title: 'Production Queue' }} />
      <Stack.Screen name="CompletedTasks" component={CompletedTasksScreen} options={{ title: 'Completed Tasks' }} />
      <Stack.Screen name="ProduceProduct" component={ProduceScreen} options={{ title: 'Produce Products' }} />
      <Stack.Screen name="DeliveryDetail" component={DeliveryDetailScreen} options={{ title: 'Delivery' }} />
    </Stack.Navigator>
  );
}

// ─── Orders Stack (Manager — Sales, Deliveries, Pickups, Settlements) ──
function OrdersStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen name="OrdersHub" component={OrdersHubScreen} options={{ title: 'Orders' }} />
      <Stack.Screen name="SalesList" component={SalesScreen} options={{ title: 'Sales' }} />
      <Stack.Screen name="DeliveriesList" component={DeliveriesScreen} options={{ title: 'Deliveries' }} />
      <Stack.Screen name="DeliveryDetail" component={DeliveryDetailScreen} options={{ title: 'Delivery' }} />
      <Stack.Screen name="PickupOrders" component={PickupOrdersScreen} options={{ title: 'Pickup Orders' }} />
      <Stack.Screen name="Settlements" component={SettlementsScreen} options={{ title: 'Settlements' }} />
      <Stack.Screen name="SaleDetail" component={SaleDetailScreen} options={{ title: 'Sale Details' }} />
      <Stack.Screen name="RefundSale" component={RefundSaleScreen} options={{ title: 'Refund' }} />
      <Stack.Screen name="AddPayment" component={AddPaymentScreen} options={{ title: 'Record Payment' }} />
      <Stack.Screen name="CashRegister" component={CashRegisterScreen} options={{ title: 'Cash Register' }} />
      <Stack.Screen name="Expenses" component={ExpensesScreen} options={{ title: 'Expenses' }} />
      <Stack.Screen name="ProductionQueue" component={ProductionQueueScreen} options={{ title: 'Production Queue' }} />
      <Stack.Screen name="CompletedTasks" component={CompletedTasksScreen} options={{ title: 'Completed Tasks' }} />
      <Stack.Screen name="ProduceProduct" component={ProduceScreen} options={{ title: 'Produce Products' }} />
    </Stack.Navigator>
  );
}

// ─── Pickups Stack (Owner/Manager) ──────────────────────
function PickupsStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen name="PickupOrdersList" component={PickupOrdersScreen} options={{ title: 'Pickup Orders' }} />
      <Stack.Screen name="SaleDetail" component={SaleDetailScreen} options={{ title: 'Sale Details' }} />
      <Stack.Screen name="RefundSale" component={RefundSaleScreen} options={{ title: 'Refund' }} />
      <Stack.Screen name="AddPayment" component={AddPaymentScreen} options={{ title: 'Record Payment' }} />
      <Stack.Screen name="DeliveryDetail" component={DeliveryDetailScreen} options={{ title: 'Delivery' }} />
    </Stack.Navigator>
  );
}

// ─── More Stack (Owner/Manager — Customers, Locations, Staff, Settings) ──
function MoreStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen name="MoreHome" component={MoreScreen} options={{ title: 'More' }} />
      <Stack.Screen name="Customers" component={CustomersScreen} options={{ title: 'Customers' }} />
      <Stack.Screen name="CustomerDetail" component={CustomerDetailScreen} options={{ title: 'Customer' }} />
      <Stack.Screen
        name="CustomerForm"
        component={CustomerFormScreen}
        options={({ route }) => ({ title: route.params?.customer ? 'Edit Customer' : 'New Customer', presentation: 'modal' })}
      />
      <Stack.Screen name="Locations" component={LocationsScreen} options={{ title: 'Locations' }} />
      <Stack.Screen name="LocationDetail" component={LocationDetailScreen} options={{ title: 'Location Details' }} />
      <Stack.Screen
        name="LocationForm"
        component={LocationFormScreen}
        options={({ route }) => ({ title: route.params?.location ? 'Edit Location' : 'New Location', presentation: 'modal' })}
      />
      <Stack.Screen name="Staff" component={UsersScreen} options={{ title: 'Staff' }} />
      <Stack.Screen
        name="UserForm"
        component={UserFormScreen}
        options={({ route }) => ({ title: route.params?.user ? 'Edit Staff' : 'Add Staff', presentation: 'modal' })}
      />
      <Stack.Screen name="Settlements" component={SettlementsScreen} options={{ title: 'Settlements' }} />
      <Stack.Screen name="CashRegister" component={CashRegisterScreen} options={{ title: 'Cash Register' }} />
      <Stack.Screen name="Expenses" component={ExpensesScreen} options={{ title: 'Expenses' }} />
      <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
      <Stack.Screen name="DataManagement" component={DataManagementScreen} options={{ title: 'Data Management' }} />
      <Stack.Screen name="SaleDetail" component={SaleDetailScreen} options={{ title: 'Sale Details' }} />
      <Stack.Screen name="RefundSale" component={RefundSaleScreen} options={{ title: 'Refund' }} />
      <Stack.Screen name="AddPayment" component={AddPaymentScreen} options={{ title: 'Record Payment' }} />
      <Stack.Screen name="DeliveryDetail" component={DeliveryDetailScreen} options={{ title: 'Delivery' }} />
      <Stack.Screen name="RecurringOrders" component={RecurringOrdersScreen} options={{ title: 'Recurring Orders' }} />
      <Stack.Screen name="AddRecurringOrder" component={AddRecurringOrderScreen} options={{ title: 'New Recurring Order' }} />
      <Stack.Screen name="RecurringOrderDetail" component={AddRecurringOrderScreen} options={{ title: 'Edit Recurring Order' }} />
      {/* Attendance sub-screens */}
      <Stack.Screen name="Attendance" component={AttendanceScreen} options={{ title: 'Attendance' }} />
      <Stack.Screen name="StaffAttendance" component={StaffAttendanceScreen} options={{ title: 'Staff Today' }} />
      <Stack.Screen name="AttendanceReport" component={AttendanceReportScreen} options={{ title: 'Attendance Report' }} />
      <Stack.Screen name="SalaryAdvances" component={SalaryAdvancesScreen} options={{ title: 'Salary Advances' }} />
      <Stack.Screen name="ShiftManagement" component={ShiftManagementScreen} options={{ title: 'Shift Management' }} />
      <Stack.Screen name="SalaryManagement" component={SalaryManagementScreen} options={{ title: 'Salary Management' }} />
      <Stack.Screen name="LiveDeliveryMap" component={LiveDeliveryMapScreen} options={{ title: 'Live Tracking' }} />
      {/* Reports */}
      <Stack.Screen name="Reports" component={ReportsHubScreen} options={{ title: 'Reports' }} />
      <Stack.Screen name="SalesReport" component={SalesReportScreen} options={{ title: 'Sales Report' }} />
      <Stack.Screen name="InventoryReport" component={InventoryReportScreen} options={{ title: 'Inventory Report' }} />
      <Stack.Screen name="CustomerInsights" component={CustomerInsightsScreen} options={{ title: 'Customer Insights' }} />
      <Stack.Screen name="EmployeePerformance" component={EmployeePerformanceScreen} options={{ title: 'Employee Performance' }} />
      {/* Profile */}
      <Stack.Screen name="Profile" component={ProfileScreen} options={{ title: 'Profile' }} />
    </Stack.Navigator>
  );
}

// ─── Attendance Stack ───────────────────────────────────────
function AttendanceStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen name="AttendanceHome" component={AttendanceScreen} options={{ title: 'Attendance' }} />
      <Stack.Screen name="StaffAttendance" component={StaffAttendanceScreen} options={{ title: 'Staff Today' }} />
      <Stack.Screen name="AttendanceReport" component={AttendanceReportScreen} options={{ title: 'Attendance Report' }} />
      <Stack.Screen name="SalaryAdvances" component={SalaryAdvancesScreen} options={{ title: 'Salary Advances' }} />
      <Stack.Screen name="ShiftManagement" component={ShiftManagementScreen} options={{ title: 'Shift Management' }} />
      <Stack.Screen name="SalaryManagement" component={SalaryManagementScreen} options={{ title: 'Salary Management' }} />
      <Stack.Screen name="LiveDeliveryMap" component={LiveDeliveryMapScreen} options={{ title: 'Live Tracking' }} />
    </Stack.Navigator>
  );
}

// ─── Delivery Partner Stack ─────────────────────────────────
function DeliveryPartnerStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen
        name="MyDeliveries"
        component={DeliveriesScreen}
        options={({ navigation }) => ({
          title: 'My Deliveries',
          headerRight: () => <NotificationBell navigation={navigation} />,
        })}
      />
      <Stack.Screen name="DeliveryDetail" component={DeliveryDetailScreen} options={{ title: 'Delivery' }} />
      <Stack.Screen name="Notifications" component={NotificationCenterScreen} options={{ title: 'Notifications' }} />
    </Stack.Navigator>
  );
}

// ─── Customer Orders Stack ──────────────────────────────────
function CustomerOrdersStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen
        name="MyOrders"
        component={CustomerOrdersScreen}
        options={({ navigation }) => ({
          title: 'My Orders',
          headerRight: () => <NotificationBell navigation={navigation} />,
        })}
      />
      <Stack.Screen name="Shop" component={CustomerShopScreen} options={{ title: 'Shop' }} />
      <Stack.Screen name="Notifications" component={NotificationCenterScreen} options={{ title: 'Notifications' }} />
      <Stack.Screen name="CustomerOrderDetail" component={SaleDetailScreen} options={{ title: 'Order Details' }} />
    </Stack.Navigator>
  );
}

// ─── Tab config per role ────────────────────────────────────
const TAB_ICONS = {
  Dashboard: { active: 'grid', inactive: 'grid-outline' },
  POS: { active: 'cart', inactive: 'cart-outline' },
  Orders: { active: 'clipboard', inactive: 'clipboard-outline' },
  Inventory: { active: 'leaf', inactive: 'leaf-outline' },
  Deliveries: { active: 'bicycle', inactive: 'bicycle-outline' },
  MyOrders: { active: 'receipt', inactive: 'receipt-outline' },
  Shop: { active: 'storefront', inactive: 'storefront-outline' },
  Attendance: { active: 'time', inactive: 'time-outline' },
  More: { active: 'apps', inactive: 'apps-outline' },
  Profile: { active: 'person-circle', inactive: 'person-circle-outline' },
};

export default function MainNavigator() {
  const { user, locations } = useAuth();
  const role = user?.role;
  const isExpoGo = Constants.appOwnership === 'expo';
  const insets = useSafeAreaInsets();

  // Auto geofence for staff (not owner/customer)
  useGeofence({
    user,
    locations: locations || [],
    enabled: !isExpoGo && !!user && user.role !== 'owner' && user.role !== 'customer',
  });

  // Auto delivery tracking for delivery partners
  useDeliveryTracking({
    user,
    enabled: !isExpoGo && !!user && user.role === 'delivery_partner',
  });

  // Push notifications
  usePushNotifications(isExpoGo);

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused, color, size }) => {
          const icons = TAB_ICONS[route.name] || TAB_ICONS.Profile;
          return (
            <Ionicons
              name={focused ? icons.active : icons.inactive}
              size={size}
              color={color}
            />
          );
        },
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.textLight,
        tabBarLabelStyle: { fontSize: FontSize.sm, fontWeight: '700' },
        tabBarStyle: {
          backgroundColor: Colors.surface,
          borderTopColor: Colors.border,
          borderTopWidth: 1,
          paddingBottom: insets.bottom > 0 ? insets.bottom + 4 : 8,
          paddingTop: 8,
          height: insets.bottom > 0 ? 60 + insets.bottom : 70,
          elevation: 0, // premium flat look
          shadowOpacity: 0,
        },
        headerShown: false,
      })}
    >
      <Tab.Screen
        name="Dashboard"
        component={DashboardStack}
        options={{ tabBarLabel: 'Home' }}
      />

      {/* POS tab — Owner, Manager, Employee */}
      {(role === 'owner' || role === 'manager' || role === 'employee') && (
        <Tab.Screen
          name="POS"
          component={POSStack}
          options={{ tabBarLabel: 'POS' }}
          listeners={({ navigation }) => ({
            tabPress: () => {
              navigation.navigate('POS', { screen: 'POSHome' });
            },
          })}
        />
      )}

      {/* Orders tab — Owner, Manager (combines Sales, Deliveries, Pickups) */}
      {(role === 'owner' || role === 'manager') && (
        <Tab.Screen
          name="Orders"
          component={OrdersStack}
          options={{ tabBarLabel: 'Orders' }}
          listeners={({ navigation }) => ({
            tabPress: () => {
              navigation.navigate('Orders', { screen: 'OrdersHub' });
            },
          })}
        />
      )}

      {/* Owner, Manager, and Employee see Inventory tab */}
      {(role === 'owner' || role === 'manager' || role === 'employee') && (
        <Tab.Screen
          name="Inventory"
          component={InventoryStack}
          options={{ tabBarLabel: 'Inventory' }}
          listeners={({ navigation }) => ({
            tabPress: () => {
              navigation.navigate('Inventory', { screen: 'StockOverview' });
            },
          })}
        />
      )}

      {/* Deliveries tab — Delivery Partner */}
      {role === 'delivery_partner' && (
        <Tab.Screen
          name="Deliveries"
          component={DeliveryPartnerStack}
          options={{ tabBarLabel: 'Deliveries' }}
        />
      )}

      {/* Attendance tab — Employee & Delivery Partner only (owner/manager access from More) */}
      {(role === 'employee' || role === 'delivery_partner') && (
        <Tab.Screen
          name="Attendance"
          component={AttendanceStack}
          options={{ tabBarLabel: 'Attendance' }}
        />
      )}

      {/* Shop tab — Customer */}
      {role === 'customer' && (
        <Tab.Screen
          name="Shop"
          component={CustomerShopScreen}
          options={{ tabBarLabel: 'Shop' }}
        />
      )}

      {/* My Orders tab — Customer */}
      {role === 'customer' && (
        <Tab.Screen
          name="MyOrders"
          component={CustomerOrdersStack}
          options={{ tabBarLabel: 'My Orders' }}
        />
      )}

      {/* More tab — Owner and Manager (includes Attendance, Customers, Staff, etc.) */}
      {(role === 'owner' || role === 'manager') && (
        <Tab.Screen
          name="More"
          component={MoreStack}
          options={{ tabBarLabel: 'More' }}
          listeners={({ navigation }) => ({
            tabPress: () => {
              navigation.navigate('More', { screen: 'MoreHome' });
            },
          })}
        />
      )}

      {/* Profile tab — only for roles that don't have it in More */}
      {(role !== 'owner' && role !== 'manager') && (
        <Tab.Screen
          name="Profile"
          component={ProfileStack}
          options={{ tabBarLabel: 'Profile' }}
        />
      )}
    </Tab.Navigator>
  );
}
