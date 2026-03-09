import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';

import DashboardScreen from '../screens/DashboardScreen';
import LocationsScreen from '../screens/LocationsScreen';
import LocationDetailScreen from '../screens/LocationDetailScreen';
import LocationFormScreen from '../screens/LocationFormScreen';
import UsersScreen from '../screens/UsersScreen';
import UserFormScreen from '../screens/UserFormScreen';
import ProfileScreen from '../screens/ProfileScreen';
import SettingsScreen from '../screens/SettingsScreen';

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
import CheckoutScreen from '../screens/CheckoutScreen';
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
        options={{ title: 'Dashboard' }}
      />
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
      <Stack.Screen name="ProfileHome" component={ProfileScreen} options={{ title: 'Profile' }} />
      <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
    </Stack.Navigator>
  );
}

// ─── POS Stack ──────────────────────────────────────────────
function POSStack() {
  return (
    <Stack.Navigator screenOptions={stackScreenOptions}>
      <Stack.Screen name="POSHome" component={POSScreen} options={{ title: 'Point of Sale' }} />
      <Stack.Screen name="Checkout" component={CheckoutScreen} options={{ title: 'Checkout' }} />
      <Stack.Screen name="SaleDetail" component={SaleDetailScreen} options={{ title: 'Sale Details' }} />
      <Stack.Screen name="RefundSale" component={RefundSaleScreen} options={{ title: 'Refund' }} />
      <Stack.Screen name="AddPayment" component={AddPaymentScreen} options={{ title: 'Record Payment' }} />
      <Stack.Screen name="QRScanner" component={QRScannerScreen} options={{ title: 'Scan QR' }} />
      <Stack.Screen name="CashRegister" component={CashRegisterScreen} options={{ title: 'Cash Register' }} />
      <Stack.Screen name="Expenses" component={ExpensesScreen} options={{ title: 'Expenses' }} />
      <Stack.Screen name="ProductionQueue" component={ProductionQueueScreen} options={{ title: 'Production Queue' }} />
      <Stack.Screen name="ProduceProduct" component={ProduceScreen} options={{ title: 'Produce Products' }} />
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
      <Stack.Screen name="ProduceProduct" component={ProduceScreen} options={{ title: 'Produce Products' }} />
    </Stack.Navigator>
  );
}

// ─── Tab config per role ────────────────────────────────────
const TAB_ICONS = {
  Dashboard: { active: 'grid', inactive: 'grid-outline' },
  POS: { active: 'cart', inactive: 'cart-outline' },
  Sales: { active: 'receipt', inactive: 'receipt-outline' },
  Inventory: { active: 'leaf', inactive: 'leaf-outline' },
  Locations: { active: 'location', inactive: 'location-outline' },
  Staff: { active: 'people', inactive: 'people-outline' },
  Customers: { active: 'people', inactive: 'people-outline' },
  Profile: { active: 'person-circle', inactive: 'person-circle-outline' },
};

export default function MainNavigator() {
  const { user } = useAuth();
  const role = user?.role;

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
        tabBarLabelStyle: { fontSize: FontSize.xs, fontWeight: '500' },
        tabBarStyle: {
          backgroundColor: Colors.surface,
          borderTopColor: Colors.border,
          paddingBottom: 4,
          height: 60,
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
        />
      )}

      {/* Sales tab — Owner, Manager */}
      {(role === 'owner' || role === 'manager') && (
        <Tab.Screen
          name="Sales"
          component={SalesStack}
          options={{ tabBarLabel: 'Sales' }}
        />
      )}

      {/* Owner, Manager, and Employee see Inventory tab */}
      {(role === 'owner' || role === 'manager' || role === 'employee') && (
        <Tab.Screen
          name="Inventory"
          component={InventoryStack}
          options={{ tabBarLabel: 'Inventory' }}
        />
      )}

      {/* Customers tab — Owner, Manager */}
      {(role === 'owner' || role === 'manager') && (
        <Tab.Screen
          name="Customers"
          component={CustomersStack}
          options={{ tabBarLabel: 'Customers' }}
        />
      )}

      {/* Owner and Manager see Locations and Staff tabs */}
      {(role === 'owner' || role === 'manager') && (
        <>
          <Tab.Screen
            name="Locations"
            component={LocationsStack}
            options={{ tabBarLabel: 'Locations' }}
          />
          <Tab.Screen
            name="Staff"
            component={UsersStack}
            options={{ tabBarLabel: 'Staff' }}
          />
        </>
      )}

      <Tab.Screen
        name="Profile"
        component={ProfileStack}
        options={{ tabBarLabel: 'Profile' }}
      />
    </Tab.Navigator>
  );
}
