/**
 * BloomCart POS — API Service
 */
import { Platform } from 'react-native';

// const LAN_IP = '159.89.173.40';

function getBaseUrl() {
  if (Platform.OS === 'web') return 'http://localhost:3001/api';
  return `https://api.gifttojalandhar.com/api`;
}

const API_BASE_URL = getBaseUrl();

export function getApiOrigin() {
  try {
    return new URL(API_BASE_URL).origin;
  } catch (e) {
    return API_BASE_URL.replace(/\/api\/?$/, '');
  }
}

class ApiService {
  constructor() {
    this.token = null;
  }

  setToken(token) {
    this.token = token;
  }

  clearToken() {
    this.token = null;
  }

  getMediaUrl(path) {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;
    const normalized = String(path).startsWith('/') ? String(path) : `/${String(path)}`;
    return `${getApiOrigin()}${normalized}`;
  }

  async request(endpoint, options = {}) {
    const url = `${API_BASE_URL}${endpoint}`;
    const isFormData = options.body instanceof FormData;
    const headers = {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const response = await fetch(url, { ...options, headers });
      const data = await response.json();

      if (!response.ok) {
        throw {
          status: response.status,
          message: data.message || 'Something went wrong',
          errors: data.errors,
        };
      }

      return data;
    } catch (error) {
      if (error.status) throw error;
      throw {
        status: 0,
        message: 'Network error. Please check your connection.',
      };
    }
  }

  // ─── Auth ────────────────────────────────────────────────
  getSetupStatus() {
    return this.request('/auth/setup-status');
  }

  ownerSetup(data) {
    return this.request('/auth/setup', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  register(data) {
    return this.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  login(phone, password) {
    return this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ phone, password }),
    });
  }

  getProfile() {
    return this.request('/auth/me');
  }

  updateProfile(data) {
    return this.request('/auth/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  changePassword(currentPassword, newPassword) {
    return this.request('/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  // ─── Users ───────────────────────────────────────────────
  getUsers(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/users${query ? `?${query}` : ''}`);
  }

  getUser(id) {
    return this.request(`/users/${id}`);
  }

  createUser(data) {
    return this.request('/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  updateUser(id, data) {
    return this.request(`/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  resetUserPassword(id, newPassword) {
    return this.request(`/users/${id}/reset-password`, {
      method: 'PUT',
      body: JSON.stringify({ newPassword }),
    });
  }

  // ─── Locations ───────────────────────────────────────────
  getLocations() {
    return this.request('/locations');
  }

  getLocation(id) {
    return this.request(`/locations/${id}`);
  }

  createLocation(data) {
    return this.request('/locations', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  updateLocation(id, data) {
    return this.request(`/locations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  assignStaff(locationId, userIds) {
    return this.request(`/locations/${locationId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ user_ids: userIds }),
    });
  }

  unassignStaff(locationId, userIds) {
    return this.request(`/locations/${locationId}/unassign`, {
      method: 'POST',
      body: JSON.stringify({ user_ids: userIds }),
    });
  }

  // ─── Settings ────────────────────────────────────────────
  getSettings() {
    return this.request('/settings');
  }

  updateSettings(settings) {
    return this.request('/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    });
  }

  getTaxRates() {
    return this.request('/settings/tax-rates');
  }

  createTaxRate(data) {
    return this.request('/settings/tax-rates', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  updateTaxRate(id, data) {
    return this.request(`/settings/tax-rates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // ─── Health ──────────────────────────────────────────────
  healthCheck() {
    return this.request('/health');
  }

  // ─── Material Categories ────────────────────────────────
  getCategories(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/categories${query ? `?${query}` : ''}`);
  }

  getCategory(id) {
    return this.request(`/categories/${id}`);
  }

  createCategory(data) {
    return this.request('/categories', { method: 'POST', body: JSON.stringify(data) });
  }

  updateCategory(id, data) {
    return this.request(`/categories/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  deleteCategory(id) {
    return this.request(`/categories/${id}`, { method: 'DELETE' });
  }

  // ─── Materials ──────────────────────────────────────────
  getMaterials(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/materials${query ? `?${query}` : ''}`);
  }

  getMaterial(id) {
    return this.request(`/materials/${id}`);
  }

  createMaterial(data) {
    return this.request('/materials', { method: 'POST', body: JSON.stringify(data) });
  }

  updateMaterial(id, data) {
    return this.request(`/materials/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  deleteMaterial(id) {
    return this.request(`/materials/${id}`, { method: 'DELETE' });
  }

  getLowStockMaterials(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/materials/low-stock${query ? `?${query}` : ''}`);
  }

  async uploadMaterialImage(materialId, imageUri) {
    const formData = new FormData();
    const filename = imageUri.split('/').pop();
    const match = /\.(\w+)$/.exec(filename);
    const ext = match ? match[1] : 'jpg';
    formData.append('image', { uri: imageUri, name: filename, type: `image/${ext}` });

    const url = `${API_BASE_URL}/materials/${materialId}/image`;
    const headers = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    const response = await fetch(url, { method: 'POST', headers, body: formData });
    const data = await response.json();
    if (!response.ok) throw { status: response.status, message: data.message || 'Upload failed' };
    return data;
  }

  // ─── Suppliers ──────────────────────────────────────────
  getSuppliers(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/suppliers${query ? `?${query}` : ''}`);
  }

  getSupplier(id) {
    return this.request(`/suppliers/${id}`);
  }

  createSupplier(data) {
    return this.request('/suppliers', { method: 'POST', body: JSON.stringify(data) });
  }

  updateSupplier(id, data) {
    return this.request(`/suppliers/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  deleteSupplier(id) {
    return this.request(`/suppliers/${id}`, { method: 'DELETE' });
  }

  linkSupplierMaterial(supplierId, data) {
    return this.request(`/suppliers/${supplierId}/materials`, { method: 'POST', body: JSON.stringify(data) });
  }

  unlinkSupplierMaterial(supplierId, materialId) {
    return this.request(`/suppliers/${supplierId}/materials/${materialId}`, { method: 'DELETE' });
  }

  // ─── Purchase Orders ───────────────────────────────────
  getPurchaseOrders(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/purchase-orders${query ? `?${query}` : ''}`);
  }

  getPurchaseOrder(id) {
    return this.request(`/purchase-orders/${id}`);
  }

  createPurchaseOrder(data) {
    return this.request('/purchase-orders', { method: 'POST', body: JSON.stringify(data) });
  }

  updatePurchaseOrder(id, data) {
    return this.request(`/purchase-orders/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  receivePurchaseOrder(id, data) {
    return this.request(`/purchase-orders/${id}/receive`, { method: 'POST', body: JSON.stringify(data) });
  }

  // ─── Stock ──────────────────────────────────────────────
  getStock(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/stock${query ? `?${query}` : ''}`);
  }

  adjustStock(data) {
    return this.request('/stock/adjust', { method: 'POST', body: JSON.stringify(data) });
  }

  getStockTransactions(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/stock/transactions${query ? `?${query}` : ''}`);
  }

  // ─── Stock Reconciliation ──────────────────────────────
  getReconciliation(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/stock/reconcile${query ? `?${query}` : ''}`);
  }

  submitReconciliation(data) {
    return this.request('/stock/reconcile', { method: 'POST', body: JSON.stringify(data) });
  }

  // ─── Stock Transfers ───────────────────────────────────
  getStockTransfers(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/stock/transfers${query ? `?${query}` : ''}`);
  }

  createStockTransfer(data) {
    return this.request('/stock/transfer', { method: 'POST', body: JSON.stringify(data) });
  }

  receiveStockTransfer(id) {
    return this.request(`/stock/transfers/${id}/receive`, { method: 'PUT' });
  }

  cancelStockTransfer(id) {
    return this.request(`/stock/transfers/${id}/cancel`, { method: 'PUT' });
  }

  // ─── Products ───────────────────────────────────────────
  getProducts(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/products${query ? `?${query}` : ''}`);
  }

  getProduct(id) {
    return this.request(`/products/${id}`);
  }

  createProduct(data) {
    return this.request('/products', { method: 'POST', body: JSON.stringify(data) });
  }

  updateProduct(id, data) {
    return this.request(`/products/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  deleteProduct(id) {
    return this.request(`/products/${id}`, { method: 'DELETE' });
  }

  // ─── Product Materials ─────────────────────────────────
  async getProductMaterials(productId) {
    const res = await this.request(`/products/${productId}`);
    return { success: true, data: res.data?.materials || [] };
  }

  addProductMaterial(productId, data) {
    return this.request(`/products/${productId}/materials`, { method: 'POST', body: JSON.stringify(data) });
  }

  updateProductMaterial(productId, materialId, data) {
    return this.request(`/products/${productId}/materials/${materialId}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  removeProductMaterial(productId, materialId) {
    return this.request(`/products/${productId}/materials/${materialId}`, { method: 'DELETE' });
  }

  // ─── Product Images ────────────────────────────────────
  async uploadProductImage(productId, imageUri, isPrimary = false) {
    const formData = new FormData();
    const filename = imageUri.split('/').pop();
    const match = /\.(\w+)$/.exec(filename);
    const ext = match ? match[1] : 'jpg';
    formData.append('image', { uri: imageUri, name: filename, type: `image/${ext}` });
    if (isPrimary) formData.append('is_primary', '1');

    const url = `${API_BASE_URL}/products/${productId}/images`;
    const headers = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    const response = await fetch(url, { method: 'POST', headers, body: formData });
    const data = await response.json();
    if (!response.ok) throw { status: response.status, message: data.message || 'Upload failed' };
    return data;
  }

  deleteProductImage(productId, imageId) {
    return this.request(`/products/${productId}/images/${imageId}`, { method: 'DELETE' });
  }

  // ─── Product QR ─────────────────────────────────────────
  getProductQR(productId, size = 300) {
    return this.request(`/products/${productId}/qr?size=${size}`);
  }

  scanProductQR(payload) {
    return this.request('/products/scan', { method: 'POST', body: JSON.stringify({ payload }) });
  }

  // ═══════════════════════════════════════════════════════════
  // Phase 4 — POS & Sales
  // ═══════════════════════════════════════════════════════════

  // ─── Sales ──────────────────────────────────────────────
  getSales(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/sales${query ? `?${query}` : ''}`);
  }

  getSale(id) {
    return this.request(`/sales/${id}`);
  }

  getTodaySummary(locationId) {
    return this.request(`/sales/today-summary${locationId ? `?location_id=${locationId}` : ''}`);
  }

  customerLookup(phone) {
    return this.request(`/sales/customer-lookup?phone=${encodeURIComponent(phone)}`);
  }

  createSale(data) {
    return this.request('/sales', { method: 'POST', body: JSON.stringify(data) });
  }

  addPaymentToSale(saleId, data) {
    return this.request(`/sales/${saleId}/payments`, { method: 'POST', body: JSON.stringify(data) });
  }

  cancelSale(saleId) {
    return this.request(`/sales/${saleId}/cancel`, { method: 'PUT' });
  }

  updateOrderStatus(saleId, status) {
    return this.request(`/sales/${saleId}/status`, { method: 'PUT', body: JSON.stringify({ status }) });
  }

  fulfillFromStock(saleId, saleItemId) {
    return this.request(`/sales/${saleId}/fulfill-from-stock`, { method: 'POST', body: JSON.stringify({ sale_item_id: saleItemId }) });
  }

  convertOrderType(saleId, data) {
    return this.request(`/sales/${saleId}/convert-type`, { method: 'PUT', body: JSON.stringify(data) });
  }

  createCustomItem(data) {
    return this.request('/sales/custom-item', { method: 'POST', body: JSON.stringify(data) });
  }

  getProductionQueue(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/sales/production-queue${query ? `?${query}` : ''}`);
  }

  // ─── Refunds ────────────────────────────────────────────
  refundSale(saleId, data) {
    return this.request(`/sales/${saleId}/refund`, { method: 'POST', body: JSON.stringify(data) });
  }

  // ─── Cash Register ─────────────────────────────────────
  getRegisterStatus(locationId) {
    return this.request(`/sales/register/status?location_id=${locationId}`);
  }

  openRegister(data) {
    return this.request('/sales/register/open', { method: 'POST', body: JSON.stringify(data) });
  }

  closeRegister(data) {
    return this.request('/sales/register/close', { method: 'PUT', body: JSON.stringify(data) });
  }

  getRegisterHistory(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/sales/register/history${query ? `?${query}` : ''}`);
  }

  // ─── Expenses ───────────────────────────────────────────
  getExpenses(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/expenses${query ? `?${query}` : ''}`);
  }

  createExpense(data) {
    return this.request('/expenses', { method: 'POST', body: JSON.stringify(data) });
  }

  deleteExpense(id) {
    return this.request(`/expenses/${id}`, { method: 'DELETE' });
  }

  getExpenseSummary(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/expenses/summary${query ? `?${query}` : ''}`);
  }

  // ─── Customers ──────────────────────────────────────────
  getCustomers(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/customers${query ? `?${query}` : ''}`);
  }

  getCustomer(id) {
    return this.request(`/customers/${id}`);
  }

  createCustomer(data) {
    return this.request('/customers', { method: 'POST', body: JSON.stringify(data) });
  }

  updateCustomer(id, data) {
    return this.request(`/customers/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  customerLookupEnhanced(phone) {
    return this.request(`/customers/lookup?phone=${encodeURIComponent(phone)}`);
  }

  customerSearch(query) {
    return this.request(`/customers/search?q=${encodeURIComponent(query)}`);
  }

  getCustomerAddresses(customerId) {
    return this.request(`/customers/${customerId}/addresses`);
  }

  getUpcomingDates(days = 30) {
    return this.request(`/customers/upcoming-dates?days=${days}`);
  }

  getCustomerOrders(id, params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/customers/${id}/orders${query ? `?${query}` : ''}`);
  }

  // Addresses
  addCustomerAddress(customerId, data) {
    return this.request(`/customers/${customerId}/addresses`, { method: 'POST', body: JSON.stringify(data) });
  }

  updateCustomerAddress(customerId, addressId, data) {
    return this.request(`/customers/${customerId}/addresses/${addressId}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  deleteCustomerAddress(customerId, addressId) {
    return this.request(`/customers/${customerId}/addresses/${addressId}`, { method: 'DELETE' });
  }

  // Credit payments
  getCustomerCredits(customerId) {
    return this.request(`/customers/${customerId}/credits`);
  }

  addCreditPayment(customerId, data) {
    return this.request(`/customers/${customerId}/credits`, { method: 'POST', body: JSON.stringify(data) });
  }

  // Special dates
  addSpecialDate(customerId, data) {
    return this.request(`/customers/${customerId}/special-dates`, { method: 'POST', body: JSON.stringify(data) });
  }

  deleteSpecialDate(customerId, dateId) {
    return this.request(`/customers/${customerId}/special-dates/${dateId}`, { method: 'DELETE' });
  }

  // ─── Production ───────────────────────────────────────────
  produceProduct(data) {
    return this.request('/production/produce', { method: 'POST', body: JSON.stringify(data) });
  }

  customProduceProduct(data) {
    return this.request('/production/produce/custom', { method: 'POST', body: JSON.stringify(data) });
  }

  getProductStock(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/production/product-stock${q ? `?${q}` : ''}`);
  }

  adjustProductStock(data) {
    return this.request('/production/product-stock/adjust', { method: 'POST', body: JSON.stringify(data) });
  }

  getProductionTasks(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/production/tasks${q ? `?${q}` : ''}`);
  }

  getMyTasks() {
    return this.request('/production/my-tasks');
  }

  assignTask(taskId, data) {
    return this.request(`/production/tasks/${taskId}/assign`, { method: 'PUT', body: JSON.stringify(data) });
  }

  pickTask(taskId) {
    return this.request(`/production/tasks/${taskId}/pick`, { method: 'PUT' });
  }

  startTask(taskId) {
    return this.request(`/production/tasks/${taskId}/start`, { method: 'PUT' });
  }

  completeTask(taskId) {
    return this.request(`/production/tasks/${taskId}/complete`, { method: 'PUT' });
  }

  getProductionStats(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/production/stats${q ? `?${q}` : ''}`);
  }

  getMaterialAlerts(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/production/material-alerts${q ? `?${q}` : ''}`);
  }

  getDashboardSummary(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/production/dashboard-summary${q ? `?${q}` : ''}`);
  }

  getProductionLogs(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/production/logs${q ? `?${q}` : ''}`);
  }

  // ─── Recurring Orders ──────────────────────────────────────
  getRecurringOrders(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/recurring-orders${q ? `?${q}` : ''}`);
  }

  getRecurringOrder(id) {
    return this.request(`/recurring-orders/${id}`);
  }

  createRecurringOrder(data) {
    return this.request('/recurring-orders', { method: 'POST', body: JSON.stringify(data) });
  }

  updateRecurringOrder(id, data) {
    return this.request(`/recurring-orders/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  deleteRecurringOrder(id) {
    return this.request(`/recurring-orders/${id}`, { method: 'DELETE' });
  }

  // ─── Deliveries ───────────────────────────────────────────
  getDeliveries(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/deliveries${q ? `?${q}` : ''}`);
  }

  getAtRiskOrders(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/deliveries/at-risk${q ? `?${q}` : ''}`);
  }

  getDelivery(id) {
    return this.request(`/deliveries/${id}`);
  }

  assignDelivery(deliveryId, data) {
    return this.request(`/deliveries/${deliveryId}/assign`, { method: 'PUT', body: JSON.stringify(data) });
  }

  batchAssignDeliveries(data) {
    return this.request('/deliveries/batch-assign', { method: 'POST', body: JSON.stringify(data) });
  }

  pickupDelivery(deliveryId) {
    return this.request(`/deliveries/${deliveryId}/pickup`, { method: 'PUT' });
  }

  markInTransit(deliveryId) {
    return this.request(`/deliveries/${deliveryId}/in-transit`, { method: 'PUT' });
  }

  deliverOrder(deliveryId, data) {
    return this.request(`/deliveries/${deliveryId}/deliver`, { method: 'PUT', body: JSON.stringify(data) });
  }

  failDelivery(deliveryId, data) {
    return this.request(`/deliveries/${deliveryId}/fail`, { method: 'PUT', body: JSON.stringify(data) });
  }

  reattemptDelivery(deliveryId) {
    return this.request(`/deliveries/${deliveryId}/reattempt`, { method: 'PUT' });
  }

  cancelDelivery(deliveryId, data = {}) {
    return this.request(`/deliveries/${deliveryId}/cancel`, { method: 'PUT', body: JSON.stringify(data) });
  }

  uploadDeliveryProof(deliveryId, formData) {
    return this.request(`/deliveries/${deliveryId}/proof`, {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    });
  }

  // Generic Media Upload
  async uploadGenericMedia(imageUri) {
    const formData = new FormData();
    const filename = imageUri.split('/').pop();
    const match = /\.(\w+)$/.exec(filename);
    const type = match ? `image/${match[1]}` : `image`;

    formData.append('image', { uri: imageUri, name: filename, type });

    return this.request(`/upload`, {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type automatically
    });
  }

  // ─── COD Settlements ─────────────────────────────────────
  getUnsettledDeliveries(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/deliveries/settlements/unsettled${q ? `?${q}` : ''}`);
  }

  getSettlements(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/deliveries/settlements${q ? `?${q}` : ''}`);
  }

  createSettlement(data) {
    return this.request('/deliveries/settlements', { method: 'POST', body: JSON.stringify(data) });
  }

  verifySettlement(settlementId) {
    return this.request(`/deliveries/settlements/${settlementId}/verify`, { method: 'PUT' });
  }

  // ─── Pickup Orders ───────────────────────────────────────
  markPickupReady(saleId) {
    return this.request(`/deliveries/pickup/${saleId}/ready`, { method: 'PUT' });
  }

  markPickedUp(saleId, paymentData) {
    return this.request(`/deliveries/pickup/${saleId}/picked-up`, {
      method: 'PUT',
      body: paymentData || undefined,
    });
  }

  // ─── Customer Orders & Dues ───────────────────────────────
  getMyOrders() {
    return this.request('/deliveries/customer/orders');
  }

  getCustomerDues(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/deliveries/customer/dues${q ? `?${q}` : ''}`);
  }

  // ─── Customer Order Placement ─────────────────────────────
  placeCustomerOrder(data) {
    return this.request('/sales/customer-order', { method: 'POST', body: JSON.stringify(data) });
  }

  // ─── Attendance ───────────────────────────────────────────
  clockIn(data) {
    return this.request('/attendance/clock-in', { method: 'POST', body: JSON.stringify(data) });
  }

  clockOut(data) {
    return this.request('/attendance/clock-out', { method: 'POST', body: JSON.stringify(data) });
  }

  getTodayAttendance() {
    return this.request('/attendance/today');
  }

  getAttendanceHistory(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/attendance${q ? `?${q}` : ''}`);
  }

  getAttendanceReport(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/attendance/report${q ? `?${q}` : ''}`);
  }

  getStaffToday(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/attendance/staff-today${q ? `?${q}` : ''}`);
  }

  // ─── Outdoor Duty ─────────────────────────────────────────
  requestOutdoorDuty(data) {
    return this.request('/attendance/outdoor-duty', { method: 'POST', body: JSON.stringify(data) });
  }

  getOutdoorDutyRequests(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/attendance/outdoor-duty${q ? `?${q}` : ''}`);
  }

  approveOutdoorDuty(id) {
    return this.request(`/attendance/outdoor-duty/${id}/approve`, { method: 'PUT' });
  }

  rejectOutdoorDuty(id) {
    return this.request(`/attendance/outdoor-duty/${id}/reject`, { method: 'PUT' });
  }

  completeOutdoorDuty(id) {
    return this.request(`/attendance/outdoor-duty/${id}/complete`, { method: 'PUT' });
  }

  // ─── Salary Advances ─────────────────────────────────────
  requestSalaryAdvance(data) {
    return this.request('/attendance/salary-advance', { method: 'POST', body: JSON.stringify(data) });
  }

  getSalaryAdvances(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/attendance/salary-advances${q ? `?${q}` : ''}`);
  }

  approveSalaryAdvance(id) {
    return this.request(`/attendance/salary-advance/${id}/approve`, { method: 'PUT' });
  }

  rejectSalaryAdvance(id) {
    return this.request(`/attendance/salary-advance/${id}/reject`, { method: 'PUT' });
  }

  repaySalaryAdvance(id, data) {
    return this.request(`/attendance/salary-advance/${id}/repay`, { method: 'PUT', body: JSON.stringify(data) });
  }

  // ─── Shift Management ────────────────────────────────────
  getShifts(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/staff/shifts${q ? `?${q}` : ''}`);
  }

  createShift(data) {
    return this.request('/staff/shifts', { method: 'POST', body: JSON.stringify(data) });
  }

  deleteShift(id) {
    return this.request(`/staff/shifts/${id}`, { method: 'DELETE' });
  }

  // ─── Salary Management ───────────────────────────────────
  getSalaries(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/staff/salaries${q ? `?${q}` : ''}`);
  }

  setSalary(data) {
    return this.request('/staff/salaries', { method: 'POST', body: JSON.stringify(data) });
  }

  getSalaryHistory(userId) {
    return this.request(`/staff/salaries/${userId}/history`);
  }

  // ─── Payroll ─────────────────────────────────────────────
  calculatePayroll(data) {
    return this.request('/staff/payroll/calculate', { method: 'POST', body: JSON.stringify(data) });
  }

  disburseSalary(data) {
    return this.request('/staff/payroll/disburse', { method: 'POST', body: JSON.stringify(data) });
  }

  getPayrollHistory(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/staff/payroll/history${q ? `?${q}` : ''}`);
  }

  // ─── Geofence Events ─────────────────────────────────────
  recordGeofenceEvent(data) {
    return this.request('/staff/geofence-event', { method: 'POST', body: JSON.stringify(data) });
  }

  // ─── Delivery Tracking ───────────────────────────────────
  recordDeliveryLocation(data) {
    return this.request('/delivery-tracking/location', { method: 'POST', body: JSON.stringify(data) });
  }

  getActiveDeliveryPartners() {
    return this.request('/delivery-tracking/active-partners');
  }

  getDeliveryRoute(deliveryId) {
    return this.request(`/delivery-tracking/route/${deliveryId}`);
  }

  getDeliveryDailySummary(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/delivery-tracking/daily-summary${q ? `?${q}` : ''}`);
  }

  getPartnerLatestPosition(userId) {
    return this.request(`/delivery-tracking/latest/${userId}`);
  }

  getPartnerPerformance(userId, days = 30) {
    return this.request(`/delivery-tracking/performance/${userId}?days=${days}`);
  }

  // ─── Reports ─────────────────────────────────────────────
  getReportsDashboard(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/reports/dashboard${q ? `?${q}` : ''}`);
  }

  getSalesSummary(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/reports/sales-summary${q ? `?${q}` : ''}`);
  }

  getInventoryReport(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/reports/inventory${q ? `?${q}` : ''}`);
  }

  getCustomerInsights(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/reports/customer-insights${q ? `?${q}` : ''}`);
  }

  getEmployeePerformance(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/reports/employee-performance${q ? `?${q}` : ''}`);
  }

  // ─── Notifications ─────────────────────────────────────────
  registerPushToken(token, platform = 'expo') {
    return this.request('/notifications/register-token', { method: 'POST', body: JSON.stringify({ token, platform }) });
  }

  unregisterPushToken(token) {
    return this.request('/notifications/unregister-token', { method: 'DELETE', body: JSON.stringify({ token }) });
  }

  getNotifications(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.request(`/notifications${q ? `?${q}` : ''}`);
  }

  getUnreadCount() {
    return this.request('/notifications/unread-count');
  }

  markNotificationRead(id) {
    return this.request(`/notifications/${id}/read`, { method: 'PUT' });
  }

  markAllNotificationsRead() {
    return this.request('/notifications/read-all', { method: 'PUT' });
  }
}

export default new ApiService();
