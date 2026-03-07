/**
 * BloomCart POS — API Service
 */
import { Platform } from 'react-native';

const LAN_IP = '192.168.29.160';

function getBaseUrl() {
  if (Platform.OS === 'web') return 'http://localhost:3001/api';
  return `http://${LAN_IP}:3001/api`;
}

const API_BASE_URL = getBaseUrl();

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

  async request(endpoint, options = {}) {
    const url = `${API_BASE_URL}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
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
}

export default new ApiService();
