import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput, Image,
  TouchableOpacity, Alert, Platform, ScrollView, Modal, ActivityIndicator,
  KeyboardAvoidingView, useWindowDimensions
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Colors, FontSize, Spacing, BorderRadius } from '../constants/theme';
import ImageModal from '../components/ImageModal';


export default function POSScreen({ navigation, route }) {
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const numColumns = useMemo(() => {
    if (width >= 1200) return 4;
    if (width >= 900) return 3;
    if (width >= 600) return 2;
    return 1;
  }, [width]);

  const { user } = useAuth();
  const isManager = user?.role === 'owner' || user?.role === 'manager';
  
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  const [products, setProducts] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [resumingDraft, setResumingDraft] = useState(false);
  const [cart, setCart] = useState([]);
  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [activeTab, setActiveTab] = useState('products'); // 'products' or 'materials'
  const [selectedCategory, setSelectedCategory] = useState(null); // null = all
  const [viewedImage, setViewedImage] = useState(null);

  // Order type selection (Step 1)
  const [orderType, setOrderType] = useState('walk_in');

  const ORDER_TYPES = [
    { key: 'walk_in', label: 'Walk-in', icon: 'person', color: Colors.success },
    { key: 'pickup', label: 'Pickup', icon: 'bag-handle', color: Colors.info || '#2196F3' },
    { key: 'delivery', label: 'Delivery', icon: 'bicycle', color: Colors.warning || '#FF9800' },
    { key: 'pre_order', label: 'Pre-Order', icon: 'calendar', color: Colors.primary },
  ];

  const PRODUCT_CATEGORIES = [
    { key: null, label: 'All' },
    { key: 'bouquet', label: 'Bouquets' },
    { key: 'arrangement', label: 'Arrangements' },
    { key: 'basket', label: 'Baskets' },
    { key: 'single_stem', label: 'Single Stem' },
    { key: 'gift_combo', label: 'Gift Combos' },
    { key: 'other', label: 'Other' },
  ];

  // Quick-add product modal
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [qaName, setQaName] = useState('');
  const [qaPrice, setQaPrice] = useState('');
  const [qaCategory, setQaCategory] = useState('other');
  const [qaSubmitting, setQaSubmitting] = useState(false);
  const [qaMaterials, setQaMaterials] = useState([]); // [{material_id, name, qty}]
  const [allMaterialsList, setAllMaterialsList] = useState([]);

  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: isTablet ? null : () => (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginRight: Spacing.md }}>
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.warning + '15', paddingHorizontal: 8, paddingVertical: 4, borderRadius: BorderRadius.sm }}
            onPress={() => navigation.navigate('QuickCheckout')}
          >
            <Ionicons name="flash" size={18} color={Colors.warning} />
            <Text style={{ fontSize: FontSize.xs, color: Colors.warning, fontWeight: '700' }}>Quick Sale</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
            onPress={() => navigation.navigate('SaleDrafts', { locationId: selectedLocation })}
          >
            <Ionicons name="document-text" size={18} color={Colors.warning} />
            <Text style={{ fontSize: FontSize.xs, color: Colors.warning, fontWeight: '600' }}>Drafts</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
            onPress={() => navigation.navigate('ProduceProduct')}
          >
            <Ionicons name="hammer" size={18} color={Colors.success} />
            <Text style={{ fontSize: FontSize.xs, color: Colors.success, fontWeight: '600' }}>Make</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
            onPress={() => navigation.navigate('ProductionQueue')}
          >
            <Ionicons name="list" size={18} color={Colors.primary} />
            <Text style={{ fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600' }}>Queue</Text>
          </TouchableOpacity>
        </View>
      ),
    });
  }, [navigation, isTablet, selectedLocation]);

  useFocusEffect(
    useCallback(() => {
      fetchProducts();
      fetchMaterials();
      fetchLocations();

      // Clear cart if returning from successful sale
      if (route.params?.clearCart) {
        setCart([]);
        navigation.setParams({ clearCart: undefined });
      }
    }, [selectedLocation, route.params?.clearCart])
  );


  const fetchProducts = async (q) => {
    try {
      const params = { search: q || '', is_active: 1 };
      if (selectedLocation) params.location_id = selectedLocation;
      const res = await api.getProducts(params);
      setProducts(res.data || []);
    } catch {
    } finally {
      setLoading(false);
    }
  };

  const fetchMaterials = async (q) => {
    try {
      const params = {};
      if (selectedLocation) params.location_id = selectedLocation;
      if (q) params.search = q;
      const res = await api.getMaterials(params);
      setMaterials(res.data || []);
    } catch {}
  };

  const fetchLocations = async () => {
    try {
      const res = await api.getLocations();
      const locs = res.data?.locations || res.data || [];
      setLocations(locs);
      if (locs.length > 0 && !selectedLocation) {
        setSelectedLocation(locs[0].id);
      }
    } catch {}
  };

  const handleSearch = (text) => {
    setSearch(text);
    if (activeTab === 'products') fetchProducts(text);
    else fetchMaterials(text);
  };

  const addToCart = (product) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.product_id === product.id && !c.material_id);
      if (existing) {
        return prev.map((c) =>
          c.product_id === product.id && !c.material_id
            ? { ...c, quantity: c.quantity + 1, line_total: (c.quantity + 1) * c.unit_price + ((c.quantity + 1) * c.unit_price * c.tax_rate / 100) }
            : c
        );
      }
      const taxRate = product.tax_percentage || 0;
      const unitPrice = product.selling_price || 0;
      const taxAmount = (unitPrice * taxRate) / 100;
      return [...prev, {
        product_id: product.id,
        material_id: null,
        product_name: product.name,
        product_sku: product.sku,
        quantity: 1,
        unit_price: unitPrice,
        tax_rate: taxRate,
        tax_amount: taxAmount,
        line_total: unitPrice + taxAmount,
        image_url: product.image_url,
        stock_quantity: product.ready_qty || product.stock_quantity || 0,
        fulfill_from_stock: (product.ready_qty || product.stock_quantity || 0) > 0,
        custom_materials: [],
        special_instructions: '',
      }];
    });
  };

  const addMaterialToCart = (material) => {
    setCart((prev) => {
      const cartKey = `mat_${material.id}`;
      const existing = prev.find((c) => c.material_id === material.id);
      if (existing) {
        return prev.map((c) =>
          c.material_id === material.id
            ? { ...c, quantity: c.quantity + 1, line_total: (c.quantity + 1) * c.unit_price }
            : c
        );
      }
      const unitPrice = material.selling_price || material.avg_cost || 0;
      return [...prev, {
        product_id: null,
        material_id: material.id,
        product_name: material.name,
        product_sku: material.sku,
        quantity: 1,
        unit_price: unitPrice,
        tax_rate: 0,
        tax_amount: 0,
        line_total: unitPrice,
        image_url: material.image_url,
      }];
    });
  };

  const cartItemKey = (c) => c.material_id ? `mat_${c.material_id}` : `prod_${c.product_id}`;

  const updateCartQty = (item, delta) => {
    const key = cartItemKey(item);
    setCart((prev) => {
      return prev.map((c) => {
        if (cartItemKey(c) !== key) return c;
        const newQty = c.quantity + delta;
        if (newQty <= 0) return null;
        const taxAmt = (c.unit_price * newQty * c.tax_rate) / 100;
        return { ...c, quantity: newQty, tax_amount: taxAmt, line_total: (c.unit_price * newQty) + taxAmt };
      }).filter(Boolean);
    });
  };

  const updateCartPrice = (item, newPrice) => {
    const key = cartItemKey(item);
    const price = parseFloat(newPrice) || 0;
    setCart((prev) => {
      return prev.map((c) => {
        if (cartItemKey(c) !== key) return c;
        const taxAmt = (price * c.quantity * c.tax_rate) / 100;
        return { ...c, unit_price: price, tax_amount: taxAmt, line_total: (price * c.quantity) + taxAmt };
      });
    });
  };

  const removeFromCart = (item) => {
    const key = cartItemKey(item);
    setCart((prev) => prev.filter((c) => cartItemKey(c) !== key));
  };

  const clearCart = () => {
    if (cart.length === 0) return;
    const doClear = () => setCart([]);
    if (Platform.OS === 'web') {
      if (window.confirm('Clear entire cart?')) doClear();
    } else {
      Alert.alert('Clear Cart', 'Remove all items?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: doClear },
      ]);
    }
  };

  const subtotal = cart.reduce((s, c) => s + (c.unit_price * c.quantity), 0);
  const taxTotal = cart.reduce((s, c) => s + ((c.unit_price * c.quantity * c.tax_rate) / 100), 0);
  const grandTotal = subtotal + taxTotal;
  const itemCount = cart.reduce((s, c) => s + c.quantity, 0);

  const handleQuickAdd = async () => {
    if (!qaName.trim()) { Alert.alert('Required', 'Enter product name'); return; }
    const price = parseFloat(qaPrice) || 0;
    if (price <= 0) { Alert.alert('Required', 'Enter a valid price'); return; }
    setQaSubmitting(true);
    try {
      const res = await api.createProduct({
        name: qaName.trim(),
        selling_price: price,
        category: qaCategory,
        type: 'standard',
        location_id: selectedLocation,
      });
      if (res.success && res.data) {
        // Add BOM materials if any selected
        for (const m of qaMaterials) {
          if (m.material_id && (parseFloat(m.qty) || 0) > 0) {
            try {
              await api.addProductMaterial(res.data.id, {
                material_id: m.material_id,
                quantity: parseFloat(m.qty),
              });
            } catch {}
          }
        }
        addToCart(res.data);
        setShowQuickAdd(false);
        setQaName(''); setQaPrice(''); setQaCategory('other'); setQaMaterials([]);
        fetchProducts(search);
      }
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to create product');
    } finally {
      setQaSubmitting(false);
    }
  };

  const openQuickAdd = async () => {
    setShowQuickAdd(true);
    try {
      const res = await api.getMaterials({ location_id: selectedLocation });
      setAllMaterialsList(res.data || []);
    } catch {}
  };

  const addQaMaterial = () => {
    setQaMaterials([...qaMaterials, { material_id: null, name: '', qty: '1' }]);
  };

  const updateQaMaterial = (idx, field, value) => {
    setQaMaterials(qaMaterials.map((m, i) => i === idx ? { ...m, [field]: value } : m));
  };

  const selectQaMaterial = (idx, material) => {
    setQaMaterials(qaMaterials.map((m, i) => i === idx ? { ...m, material_id: material.id, name: material.name } : m));
  };

  const removeQaMaterial = (idx) => {
    setQaMaterials(qaMaterials.filter((_, i) => i !== idx));
  };

  const goToCheckout = () => {
    if (cart.length === 0) {
      Alert.alert('Empty Cart', 'Add items before checkout');
      return;
    }
    if (!selectedLocation) {
      Alert.alert('Location', 'Please select a location');
      return;
    }

    navigation.navigate('QuickCheckout', {
      prefillCart: cart,
      locationId: selectedLocation,
      orderType,
      prefillToken: Date.now(),
    });
  };

  const handleScanQR = () => {
    navigation.navigate('QRScanner', { fromPOS: true });
  };

  const handleResumeLatestDraft = async () => {
    if (resumingDraft) return;
    setResumingDraft(true);
    try {
      const params = selectedLocation ? { location_id: selectedLocation } : {};
      const res = await api.getSaleDrafts(params);
      const latest = (res?.data || [])[0];
      if (!latest) {
        Alert.alert('No Drafts', 'No saved drafts were found for this location.');
        return;
      }

      const target = latest.context === 'quick_checkout' ? 'QuickCheckout' : 'Checkout';
      navigation.navigate(target, { draftId: latest.id });
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to load latest draft');
    } finally {
      setResumingDraft(false);
    }
  };

  // Handle scanned product returned from QR scanner
  useEffect(() => {
    if (route.params?.scannedProduct) {
      addToCart(route.params.scannedProduct);
      navigation.setParams({ scannedProduct: undefined });
    }
  }, [route.params?.scannedProduct]);

  const renderProduct = ({ item, index }) => {
    const inCart = cart.find((c) => c.product_id === item.id && !c.material_id);
    const readyQty = item.ready_qty || 0;
    const canMakeQty = item.available_qty;
    
    // On tablet grid, use a tile design (vertical)
    if (numColumns > 1) {
      return (
        <TouchableOpacity style={styles.productTile} onPress={() => addToCart(item)} activeOpacity={0.7}>
          <TouchableOpacity 
            style={styles.tileIconWrap}
            onPress={(e) => { e.stopPropagation(); if (item.image_url) setViewedImage(api.getMediaUrl(item.image_url)); }}
          >
            {item.image_url ? (
              <Image source={{ uri: api.getMediaUrl(item.image_url) }} style={styles.tileImg} />
            ) : (
              <Ionicons name="gift" size={32} color={Colors.primary} />
            )}
            {inCart && (
              <View style={styles.qtyBadge}>
                <Text style={styles.qtyBadgeText}>{inCart.quantity}</Text>
              </View>
            )}
          </TouchableOpacity>
          <View style={styles.tileInfo}>
            <Text style={styles.tileName} numberOfLines={2}>{item.name}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              <Text style={styles.tilePrice}>₹{(item.selling_price || 0).toFixed(0)}</Text>
              {readyQty > 0 && <View style={styles.readyBadgeIcon}><Text style={styles.readyBadgeText}>{readyQty}R</Text></View>}
            </View>
          </View>
        </TouchableOpacity>
      );
    }

    return (
      <TouchableOpacity style={[styles.productCard]} onPress={() => addToCart(item)} activeOpacity={0.7}>
        <TouchableOpacity 
          style={styles.productIconWrap}
          onPress={(e) => { e.stopPropagation(); if (item.image_url) setViewedImage(api.getMediaUrl(item.image_url)); }}
        >
          {item.image_url ? (
            <Image source={{ uri: api.getMediaUrl(item.image_url) }} style={styles.productImg} />
          ) : (
            <Ionicons name="gift" size={28} color={Colors.primary} />
          )}
          {inCart && (
            <View style={styles.qtyBadge}>
              <Text style={styles.qtyBadgeText}>{inCart.quantity}</Text>
            </View>
          )}
        </TouchableOpacity>
        <View style={styles.productInfo}>
          <Text style={styles.productName} numberOfLines={1}>{item.name}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            {readyQty > 0 && (
              <View style={styles.readyBadge}>
                <Text style={styles.readyBadgeText}>{readyQty} ready</Text>
              </View>
            )}
            {canMakeQty !== null && canMakeQty !== undefined && canMakeQty > 0 && (
              <Text style={styles.canMakeText}>+{canMakeQty} makeable</Text>
            )}
            {readyQty <= 0 && (canMakeQty === null || canMakeQty === undefined || canMakeQty <= 0) && (
              <Text style={[styles.canMakeText, { color: Colors.error }]}>Out of Stock</Text>
            )}
          </View>
        </View>
        <Text style={styles.productPrice}>₹{(item.selling_price || 0).toFixed(0)}</Text>
      </TouchableOpacity>
    );
  };

  const renderMaterial = ({ item, index }) => {
    const inCart = cart.find((c) => c.material_id === item.id);
    const stockQty = item.stock_quantity ?? null;
    const outOfStock = stockQty !== null && stockQty <= 0;

    // Use tile design on grid views for consistency
    if (numColumns > 1) {
      return (
        <TouchableOpacity 
          style={[styles.productTile, outOfStock && { opacity: 0.6 }]} 
          onPress={() => addMaterialToCart(item)} 
          activeOpacity={0.7}
        >
          <TouchableOpacity 
            style={[styles.tileIconWrap, { backgroundColor: Colors.success + '12' }]}
            onPress={(e) => { e.stopPropagation(); if (item.image_url) setViewedImage(api.getMediaUrl(item.image_url)); }}
          >
            {item.image_url ? (
              <Image source={{ uri: api.getMediaUrl(item.image_url) }} style={styles.tileImg} />
            ) : (
              <Ionicons name="leaf" size={32} color={Colors.success} />
            )}
            {inCart && (
              <View style={styles.qtyBadge}>
                <Text style={styles.qtyBadgeText}>{inCart.quantity}</Text>
              </View>
            )}
          </TouchableOpacity>
          <View style={styles.tileInfo}>
            <Text style={styles.tileName} numberOfLines={2}>{item.name}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={styles.tilePrice}>₹{(item.selling_price || item.avg_cost || 0).toFixed(0)}</Text>
              {stockQty !== null && (
                <Text style={{ fontSize: 10, color: outOfStock ? Colors.error : Colors.textLight }}>
                  • {stockQty} units
                </Text>
              )}
            </View>
          </View>
        </TouchableOpacity>
      );
    }

    return (
      <TouchableOpacity style={[styles.productCard, outOfStock && styles.productCardDimmed]} onPress={() => addMaterialToCart(item)} activeOpacity={0.7}>
        <TouchableOpacity 
          style={[styles.productIconWrap, { backgroundColor: Colors.success + '12' }]}
          onPress={(e) => { e.stopPropagation(); if (item.image_url) setViewedImage(api.getMediaUrl(item.image_url)); }}
        >
          {item.image_url ? (
            <Image source={{ uri: api.getMediaUrl(item.image_url) }} style={styles.productImg} />
          ) : (
            <Ionicons name="leaf" size={24} color={Colors.success} />
          )}
          {inCart && (
            <View style={styles.qtyBadge}>
              <Text style={styles.qtyBadgeText}>{inCart.quantity}</Text>
            </View>
          )}
        </TouchableOpacity>
        <View style={styles.productInfo}>
          <Text style={styles.productName} numberOfLines={1}>{item.name}</Text>
          <Text style={styles.productSku}>
            {item.sku}{item.category_name ? `  •  ${item.category_name}` : ''}
            {stockQty !== null ? (outOfStock ? '  •  Out of Stock' : `  •  Stock: ${stockQty}`) : ''}
          </Text>
        </View>
        <Text style={styles.productPrice}>₹{(item.selling_price || item.avg_cost || 0).toFixed(0)}</Text>
      </TouchableOpacity>
    );
  };

  // Components for reorganization
  const renderLocationPicker = (vertical = false) => (
    <View style={vertical ? { gap: Spacing.xs, paddingHorizontal: Spacing.sm } : null}>
      {vertical && <Text style={styles.sidebarSectionTitle}>Locations</Text>}
      {locations.length > 1 ? (
        <ScrollView 
          horizontal={!vertical} 
          showsHorizontalScrollIndicator={false} 
          style={!vertical && styles.locRow} 
          contentContainerStyle={!vertical ? { paddingHorizontal: Spacing.md, gap: Spacing.xs } : { gap: Spacing.xs }}
        >
          {locations.map((loc) => (
            <TouchableOpacity
              key={loc.id}
              style={[styles.locChip, selectedLocation === loc.id && styles.locChipActive, vertical && { width: '100%', minHeight: 40 }]}
              onPress={() => setSelectedLocation(loc.id)}
            >
              <Text style={[styles.locChipText, selectedLocation === loc.id && styles.locChipTextActive]}>{loc.name}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );

  const renderOrderTypePicker = (vertical = false) => (
    <View style={vertical ? { gap: Spacing.xs, paddingHorizontal: Spacing.sm, marginTop: Spacing.md } : null}>
      {vertical && <Text style={styles.sidebarSectionTitle}>Order Type</Text>}
      <ScrollView 
        horizontal={!vertical} 
        showsHorizontalScrollIndicator={false} 
        style={!vertical && styles.orderTypeRow} 
        contentContainerStyle={!vertical ? { paddingHorizontal: Spacing.md, gap: Spacing.sm } : { gap: Spacing.xs }}
      >
        {ORDER_TYPES.map((t) => (
          <TouchableOpacity
            key={t.key}
            style={[
              styles.orderTypeBtn, 
              orderType === t.key && { backgroundColor: t.color, borderColor: t.color, elevation: 4, shadowOpacity: 0.2 },
              vertical && { width: '100%', minHeight: 44, justifyContent: 'flex-start', paddingHorizontal: Spacing.md }
            ]}
            onPress={() => setOrderType(t.key)}
          >
            <Ionicons name={t.icon} size={18} color={orderType === t.key ? Colors.white : t.color} />
            <Text style={[styles.orderTypeBtnText, orderType === t.key && { color: Colors.white }]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );

  const renderCategoryList = (vertical = false) => (
    <View style={vertical ? { gap: Spacing.xs, paddingHorizontal: Spacing.sm, marginTop: Spacing.md, flex: 1 } : null}>
      {vertical && <Text style={styles.sidebarSectionTitle}>Categories</Text>}
      <ScrollView 
        horizontal={!vertical} 
        showsHorizontalScrollIndicator={false} 
        style={!vertical && styles.catFilterRow} 
        contentContainerStyle={!vertical ? { paddingHorizontal: Spacing.md, gap: Spacing.xs } : { gap: Spacing.xs }}
      >
        {PRODUCT_CATEGORIES.map((cat) => (
          <TouchableOpacity
            key={cat.key || 'all'}
            style={[
              styles.locChip, 
              selectedCategory === cat.key && styles.locChipActive,
              vertical && { width: '100%', minHeight: 40, justifyContent: 'flex-start' }
            ]}
            onPress={() => setSelectedCategory(cat.key)}
          >
            <Text style={[styles.locChipText, selectedCategory === cat.key && styles.locChipTextActive]}>{cat.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );

  const renderUnifiedTopBar = () => (
    <View style={styles.unifiedTopBar}>
      {/* Search row */}
      <View style={[styles.searchRow, { flex: 1, backgroundColor: 'transparent', paddingHorizontal: 0, paddingVertical: 0 }]}>
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={20} color={Colors.textLight} style={{ marginRight: 6 }} />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={handleSearch}
            placeholder={activeTab === 'products' ? 'Search products...' : 'Search materials...'}
            placeholderTextColor={Colors.textLight}
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => handleSearch('')}>
              <Ionicons name="close-circle" size={20} color={Colors.textLight} />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity style={[styles.scanBtn, { width: 44, height: 44 }]} onPress={handleScanQR}>
          <Ionicons name="qr-code" size={20} color={Colors.white} />
        </TouchableOpacity>
        {isManager && (
          <TouchableOpacity style={[styles.scanBtn, { backgroundColor: Colors.success, width: 44, height: 44 }]} onPress={openQuickAdd}>
            <Ionicons name="add" size={20} color={Colors.white} />
          </TouchableOpacity>
        )}
      </View>

      {/* Tabs */}
      <View style={[styles.tabRow, { backgroundColor: 'transparent', borderBottomWidth: 0, paddingHorizontal: 0, paddingVertical: 0, marginLeft: Spacing.md, minWidth: 260 }]}>
        <TouchableOpacity
          style={[styles.tabBtn, activeTab === 'products' && styles.tabBtnActive, { height: 44 }]}
          onPress={() => { setActiveTab('products'); setSearch(''); }}
        >
          <Ionicons name="gift" size={16} color={activeTab === 'products' ? Colors.white : Colors.textSecondary} />
          <Text style={[styles.tabBtnText, activeTab === 'products' && styles.tabBtnTextActive]}>Products</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabBtn, activeTab === 'materials' && styles.tabBtnActive, { height: 44 }]}
          onPress={() => { setActiveTab('materials'); setSearch(''); }}
        >
          <Ionicons name="leaf" size={16} color={activeTab === 'materials' ? Colors.white : Colors.textSecondary} />
          <Text style={[styles.tabBtnText, activeTab === 'materials' && styles.tabBtnTextActive]}>Raw</Text>
        </TouchableOpacity>
      </View>

      {/* Quick shortcuts on tablet */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginLeft: Spacing.md }}>
        <TouchableOpacity 
          style={styles.headerShortCut}
          onPress={() => navigation.navigate('QuickCheckout')}
        >
          <Ionicons name="flash" size={18} color={Colors.warning} />
        </TouchableOpacity>
        <TouchableOpacity 
          style={styles.headerShortCut}
          onPress={() => navigation.navigate('SaleDrafts', { locationId: selectedLocation })}
        >
          <Ionicons name="document-text" size={18} color={Colors.warning} />
        </TouchableOpacity>
        <TouchableOpacity 
          style={styles.headerShortCut}
          onPress={() => navigation.navigate('ProduceProduct')}
        >
          <Ionicons name="hammer" size={18} color={Colors.success} />
        </TouchableOpacity>
        <TouchableOpacity 
          style={styles.headerShortCut}
          onPress={() => navigation.navigate('ProductionQueue')}
        >
          <Ionicons name="list" size={18} color={Colors.primary} />
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderProductList = () => (
    <View style={{ flex: 1 }}>
      {!isTablet && renderCategoryList(false)}
      <FlatList
        data={activeTab === 'products' 
          ? (selectedCategory ? products.filter(p => p.category === selectedCategory) : products)
          : materials
        }
        key={`pos-grid-${numColumns}-${activeTab}`}
        numColumns={numColumns}
        keyExtractor={(item) => `${activeTab}_${item.id}`}
        renderItem={activeTab === 'products' ? renderProduct : renderMaterial}
        columnWrapperStyle={numColumns > 1 ? { paddingHorizontal: Spacing.md, gap: Spacing.md } : null}
        contentContainerStyle={[styles.listContent, numColumns > 1 && { paddingHorizontal: 0 }]}
        style={{ flex: 1 }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name={activeTab === 'products' ? "gift-outline" : "leaf-outline"} size={48} color={Colors.textLight} />
            <Text style={styles.emptyText}>{loading ? 'Loading...' : `No ${activeTab} found`}</Text>
          </View>
        }
      />
    </View>
  );

  const renderCartSidebar = () => (
    <View style={isTablet ? styles.sideCart : styles.cartPanel}>
      <View style={styles.cartPanelHeader}>
        <Text style={styles.cartPanelTitle}>Order Summary</Text>
        <View style={styles.cartHeaderActions}>
          <TouchableOpacity
            onPress={handleResumeLatestDraft}
            style={styles.resumeDraftBtn}
            disabled={resumingDraft}
          >
            {resumingDraft ? (
              <ActivityIndicator size="small" color={Colors.warning} />
            ) : (
              <>
                <Ionicons name="play-circle-outline" size={16} color={Colors.warning} />
                <Text style={styles.resumeDraftText}>Resume Latest</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={clearCart} style={styles.clearBtn}>
            <Ionicons name="trash-outline" size={16} color={Colors.error} />
            <Text style={styles.clearText}>Clear</Text>
          </TouchableOpacity>
        </View>
      </View>
      <ScrollView style={[styles.cartItemsList, isTablet && { maxHeight: 'none', flex: 1 }]} nestedScrollEnabled>
        {cart.map((c) => (
          <View key={cartItemKey(c)} style={styles.cartItem}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cartItemName} numberOfLines={2}>
                {c.material_id ? '🌿 ' : ''}{c.product_name}
              </Text>
              <Text style={styles.cartItemPrice}>₹{c.unit_price} × {c.quantity} = ₹{(c.unit_price * c.quantity).toFixed(0)}</Text>
            </View>
            <View style={styles.qtyControls}>
              <TouchableOpacity style={styles.qtyBtn} onPress={() => updateCartQty(c, -1)}>
                <Ionicons name={c.quantity === 1 ? 'trash-outline' : 'remove'} size={20} color={c.quantity === 1 ? Colors.error : Colors.primary} />
              </TouchableOpacity>
              <Text style={styles.qtyText}>{c.quantity}</Text>
              <TouchableOpacity style={styles.qtyBtn} onPress={() => updateCartQty(c, 1)}>
                <Ionicons name="add" size={20} color={Colors.primary} />
              </TouchableOpacity>
            </View>
            {orderType === 'walk_in' && !c.material_id && (c.stock_quantity || 0) > 0 && !c.special_instructions && (
              <TouchableOpacity
                style={{
                  flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
                  marginTop: 6, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12,
                  backgroundColor: c.fulfill_from_stock ? Colors.success + '15' : Colors.textLight + '10',
                  borderWidth: 1, borderColor: c.fulfill_from_stock ? Colors.success + '40' : Colors.textLight + '30',
                  gap: 4, width: '100%', justifyContent: 'center'
                }}
                onPress={() => setCart(prev => prev.map(it => cartItemKey(it) === cartItemKey(c) ? { ...it, fulfill_from_stock: !it.fulfill_from_stock } : it))}
              >
                <Ionicons
                  name={c.fulfill_from_stock ? 'checkmark-circle' : 'cube-outline'}
                  size={14}
                  color={c.fulfill_from_stock ? Colors.success : Colors.textSecondary}
                />
                <Text style={{ fontSize: 11, fontWeight: '600', color: c.fulfill_from_stock ? Colors.success : Colors.textSecondary }}>
                  {c.fulfill_from_stock ? 'From Stock' : 'Use Stock?'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
      </ScrollView>
      <View style={styles.cartTotals}>
        <View style={styles.cartTotalRow}>
          <Text style={styles.cartGrandLabel}>Total</Text>
          <Text style={styles.cartGrandVal}>₹{grandTotal.toFixed(0)}</Text>
        </View>
      </View>
      <TouchableOpacity style={styles.checkoutBtn} onPress={goToCheckout}>
        <Ionicons name="cart" size={22} color={Colors.white} />
        <Text style={styles.checkoutBtnText}>Checkout  ₹{grandTotal.toFixed(0)}</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={[styles.container, isTablet && { flexDirection: 'row' }]}>
      {/* Tablet Left Sidebar */}
      {isTablet && (
        <View style={[styles.sideFilters, isSidebarCollapsed && { width: 60 }]}>
          <TouchableOpacity 
            style={styles.collapseToggle} 
            onPress={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          >
            <Ionicons name={isSidebarCollapsed ? "chevron-forward" : "chevron-back"} size={20} color={Colors.textSecondary} />
          </TouchableOpacity>
          
          {!isSidebarCollapsed && (
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
              {renderLocationPicker(true)}
              {renderOrderTypePicker(true)}
              {renderCategoryList(true)}
            </ScrollView>
          )}
          {isSidebarCollapsed && (
            <View style={{ alignItems: 'center', gap: Spacing.md }}>
              <Ionicons name="location" size={22} color={Colors.primary} />
              <Ionicons name="list" size={22} color={Colors.primary} />
              <Ionicons name="grid" size={22} color={Colors.primary} />
            </View>
          )}
        </View>
      )}

      {/* Main Center Area */}
      <View style={[{ flex: 1 }]}>
        {!isTablet ? (
          <View style={styles.headerContainer}>
            {renderLocationPicker(false)}
            {renderOrderTypePicker(false)}
            <View style={styles.searchRow}>
              <View style={styles.searchWrap}>
                <Ionicons name="search" size={20} color={Colors.textLight} style={{ marginRight: 6 }} />
                <TextInput
                  style={styles.searchInput}
                  value={search}
                  onChangeText={handleSearch}
                  placeholder={activeTab === 'products' ? 'Search products...' : 'Search materials...'}
                  placeholderTextColor={Colors.textLight}
                />
                {search.length > 0 && (
                  <TouchableOpacity onPress={() => handleSearch('')}>
                    <Ionicons name="close-circle" size={20} color={Colors.textLight} />
                  </TouchableOpacity>
                )}
              </View>
              <TouchableOpacity style={styles.scanBtn} onPress={handleScanQR}>
                <Ionicons name="qr-code" size={24} color={Colors.white} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.scanBtn, { backgroundColor: Colors.warning }]}
                onPress={() => navigation.navigate('SaleDrafts', { locationId: selectedLocation })}
              >
                <Ionicons name="document-text" size={22} color={Colors.white} />
              </TouchableOpacity>
              {isManager && (
                <TouchableOpacity style={[styles.scanBtn, { backgroundColor: Colors.success }]} onPress={openQuickAdd}>
                  <Ionicons name="add" size={24} color={Colors.white} />
                </TouchableOpacity>
              )}
            </View>
            <View style={styles.tabRow}>
              <TouchableOpacity
                style={[styles.tabBtn, activeTab === 'products' && styles.tabBtnActive]}
                onPress={() => { setActiveTab('products'); setSearch(''); }}
              >
                <Ionicons name="gift" size={18} color={activeTab === 'products' ? Colors.white : Colors.textSecondary} />
                <Text style={[styles.tabBtnText, activeTab === 'products' && styles.tabBtnTextActive]}>Products</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.tabBtn, activeTab === 'materials' && styles.tabBtnActive]}
                onPress={() => { setActiveTab('materials'); setSearch(''); }}
              >
                <Ionicons name="leaf" size={18} color={activeTab === 'materials' ? Colors.white : Colors.textSecondary} />
                <Text style={[styles.tabBtnText, activeTab === 'materials' && styles.tabBtnTextActive]}>Raw Materials</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          renderUnifiedTopBar()
        )}

        {/* List area */}
        {renderProductList()}
      </View>

      {/* Responsive Cart Panel */}
      {cart.length > 0 && (
        renderCartSidebar()
      )}

      {/* Quick-add Product Modal */}
      <Modal visible={showQuickAdd} transparent animationType="slide">
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Quick Add Product</Text>
                <TouchableOpacity onPress={() => { setShowQuickAdd(false); setQaMaterials([]); }}>
                  <Ionicons name="close" size={24} color={Colors.text} />
                </TouchableOpacity>
              </View>
              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                <Text style={styles.fieldLabel}>Name *</Text>
                <TextInput
                  style={styles.modalInput}
                  value={qaName}
                  onChangeText={setQaName}
                  placeholder="Product name"
                  placeholderTextColor={Colors.textLight}
                  autoFocus
                />
                <Text style={styles.fieldLabel}>Selling Price (₹) *</Text>
                <TextInput
                  style={styles.modalInput}
                  value={qaPrice}
                  onChangeText={setQaPrice}
                  placeholder="0"
                  placeholderTextColor={Colors.textLight}
                  keyboardType="numeric"
                />
                <Text style={styles.fieldLabel}>Category</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: Spacing.xs, paddingBottom: Spacing.sm }}>
                  {['bouquet', 'arrangement', 'basket', 'single_stem', 'gift_combo', 'other'].map((cat) => (
                    <TouchableOpacity
                      key={cat}
                      style={[styles.catChip, qaCategory === cat && styles.catChipActive]}
                      onPress={() => setQaCategory(cat)}
                    >
                      <Text style={[styles.catChipText, qaCategory === cat && styles.catChipTextActive]}>
                        {cat.replace(/_/g, ' ')}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                {/* BOM Materials */}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: Spacing.sm }}>
                  <Text style={styles.fieldLabel}>Materials Used (optional)</Text>
                  <TouchableOpacity onPress={addQaMaterial} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Ionicons name="add-circle" size={18} color={Colors.primary} />
                    <Text style={{ fontSize: FontSize.xs, color: Colors.primary, fontWeight: '600' }}>Add</Text>
                  </TouchableOpacity>
                </View>
                {qaMaterials.map((m, idx) => (
                  <View key={idx} style={{ flexDirection: 'row', gap: Spacing.xs, alignItems: 'center', marginBottom: Spacing.xs }}>
                    <View style={{ flex: 2 }}>
                      {m.material_id ? (
                        <TouchableOpacity
                          style={[styles.modalInput, { justifyContent: 'center', paddingVertical: Spacing.xs + 4 }]}
                          onPress={() => {
                            const filtered = allMaterialsList.filter(
                              (mat) => !qaMaterials.some((qm, qi) => qi !== idx && qm.material_id === mat.id)
                            );
                            if (filtered.length === 0) { Alert.alert('No materials', 'All materials already added'); return; }
                            Alert.alert('Select Material', '', filtered.map((mat) => ({
                              text: mat.name,
                              onPress: () => selectQaMaterial(idx, mat),
                            })).concat([{ text: 'Cancel', style: 'cancel' }]));
                          }}
                        >
                          <Text style={{ color: Colors.text, fontSize: FontSize.sm }}>{m.name}</Text>
                        </TouchableOpacity>
                      ) : (
                        <TouchableOpacity
                          style={[styles.modalInput, { justifyContent: 'center', paddingVertical: Spacing.xs + 4 }]}
                          onPress={() => {
                            const filtered = allMaterialsList.filter(
                              (mat) => !qaMaterials.some((qm, qi) => qi !== idx && qm.material_id === mat.id)
                            );
                            if (filtered.length === 0) { Alert.alert('No materials', 'No materials available'); return; }
                            Alert.alert('Select Material', '', filtered.map((mat) => ({
                              text: mat.name,
                              onPress: () => selectQaMaterial(idx, mat),
                            })).concat([{ text: 'Cancel', style: 'cancel' }]));
                          }}
                        >
                          <Text style={{ color: Colors.textLight, fontSize: FontSize.sm }}>Select material...</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                    <TextInput
                      style={[styles.modalInput, { flex: 1 }]}
                      value={m.qty}
                      onChangeText={(v) => updateQaMaterial(idx, 'qty', v)}
                      placeholder="Qty"
                      placeholderTextColor={Colors.textLight}
                      keyboardType="numeric"
                    />
                    <TouchableOpacity onPress={() => removeQaMaterial(idx)}>
                      <Ionicons name="close-circle" size={22} color={Colors.error} />
                    </TouchableOpacity>
                  </View>
                ))}

                <TouchableOpacity
                  style={[styles.qaSubmitBtn, qaSubmitting && { opacity: 0.6 }]}
                  onPress={handleQuickAdd}
                  disabled={qaSubmitting}
                >
                  {qaSubmitting ? (
                    <ActivityIndicator color={Colors.white} />
                  ) : (
                    <>
                      <Ionicons name="add-circle" size={18} color={Colors.white} />
                      <Text style={styles.qaSubmitText}>Create & Add to Cart</Text>
                    </>
                  )}
                </TouchableOpacity>
              </ScrollView>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <ImageModal 
        visible={!!viewedImage} 
        imageUrl={viewedImage} 
        onClose={() => setViewedImage(null)} 
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  headerContainer: {
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 4,
    zIndex: 10,
  },
  locRow: { maxHeight: 48, paddingVertical: Spacing.xs },
  locChip: {
    paddingHorizontal: Spacing.md, paddingVertical: 6,
    borderRadius: BorderRadius.full, backgroundColor: Colors.surfaceAlt,
    borderWidth: 1, borderColor: Colors.border,
    justifyContent: 'center', alignItems: 'center', minHeight: 32,
  },
  locChipActive: { 
    backgroundColor: Colors.primary, borderColor: Colors.primary,
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 4,
  },
  locChipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  locChipTextActive: { color: Colors.white, fontWeight: '700' },

  orderTypeRow: {
    maxHeight: 70, paddingVertical: Spacing.sm,
    backgroundColor: Colors.surface,
  },
  orderTypeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs, borderRadius: BorderRadius.md,
    backgroundColor: Colors.surfaceAlt, borderWidth: 1.5, borderColor: Colors.border,
    minWidth: 100, minHeight: 40,
  },
  orderTypeBtnText: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary },

  searchRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    gap: Spacing.sm, backgroundColor: Colors.surface,
  },
  searchWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surfaceAlt, borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.md, height: 48,
  },
  searchInput: { flex: 1, fontSize: FontSize.md, color: Colors.text },
  scanBtn: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center',
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 8, elevation: 4,
  },

  tabRow: {
    flexDirection: 'row', paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    gap: Spacing.sm, backgroundColor: Colors.surface,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  tabBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: Spacing.sm, borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceAlt,
  },
  tabBtnActive: { backgroundColor: Colors.primary, shadowColor: Colors.primary, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 2 },
  tabBtnText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  tabBtnTextActive: { color: Colors.white, fontWeight: '700' },

  catFilterRow: { maxHeight: 50, backgroundColor: Colors.background, paddingVertical: Spacing.xs },

  listContent: { padding: Spacing.md, paddingBottom: 20 },
  productCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.md, marginBottom: Spacing.md,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.04, shadowRadius: 8, elevation: 2,
    minHeight: 80,
  },
  productCardDimmed: { opacity: 0.5 },
  productIconWrap: {
    width: 80, height: 80, borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary + '12', justifyContent: 'center', alignItems: 'center',
    marginRight: Spacing.md,
  },
  productInfo: { flex: 1 },
  productName: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  productSku: { fontSize: FontSize.sm, color: Colors.textLight, marginTop: 2 },
  productPrice: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.success },
  productImg: { width: 80, height: 80, borderRadius: BorderRadius.md },

  readyBadge: {
    backgroundColor: Colors.success + '20', paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: BorderRadius.sm,
  },
  readyBadgeText: { fontSize: 11, fontWeight: '700', color: Colors.success },
  readyBadgeIcon: {
    backgroundColor: Colors.success + '12', paddingHorizontal: 4, paddingVertical: 1,
    borderRadius: 4, borderWeight: 0.5, borderColor: Colors.success + '30'
  },
  canMakeText: { fontSize: 11, color: Colors.textLight, fontStyle: 'italic' },

  empty: { alignItems: 'center', paddingTop: 80 },
  emptyText: { color: Colors.textLight, marginTop: Spacing.sm, fontSize: FontSize.md },

  qtyBadge: {
    position: 'absolute', top: -6, right: -6,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center',
    zIndex: 2,
  },
  qtyBadgeText: { color: Colors.white, fontSize: 11, fontWeight: '700' },

  cartPanel: {
    backgroundColor: Colors.surface, 
    borderTopLeftRadius: BorderRadius.xl, borderTopRightRadius: BorderRadius.xl,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.05, shadowRadius: 12, elevation: 12,
    maxHeight: 360, paddingBottom: Spacing.sm,
  },
  sideCart: {
    width: 320, backgroundColor: Colors.surface,
    borderLeftWidth: 1, borderLeftColor: Colors.border,
    paddingTop: Spacing.sm,
  },
  sideFilters: {
    width: 200, backgroundColor: Colors.surface,
    borderRightWidth: 1, borderRightColor: Colors.border,
    paddingTop: Spacing.lg,
  },
  sidebarSectionTitle: {
    fontSize: 10, fontWeight: '800', color: Colors.textLight,
    textTransform: 'uppercase', letterSpacing: 1,
    marginBottom: Spacing.sm, paddingHorizontal: 4,
  },
  collapseToggle: {
    alignSelf: 'flex-end', padding: 8, marginRight: 4, marginBottom: 8,
  },
  unifiedTopBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  headerShortCut: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.surfaceAlt, 
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: Colors.border,
  },
  cartPanelHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: Spacing.xs,
  },
  cartPanelTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  cartHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  resumeDraftBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    padding: 8, backgroundColor: Colors.warning + '15', borderRadius: BorderRadius.sm,
    borderWidth: 1, borderColor: Colors.warning + '35',
  },
  resumeDraftText: { fontSize: FontSize.sm, color: Colors.warning, fontWeight: '700' },
  clearBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, padding: 8, backgroundColor: Colors.errorLight, borderRadius: BorderRadius.sm },
  clearText: { fontSize: FontSize.sm, color: Colors.error, fontWeight: '700' },
  cartItemsList: { maxHeight: 160, paddingHorizontal: Spacing.md },
  cartItem: {
    flexDirection: 'row', alignItems: 'flex-start', flexWrap: 'wrap',
    paddingVertical: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border,
    gap: 12,
  },
  cartItemName: { fontSize: FontSize.md, color: Colors.text, fontWeight: '700', flexShrink: 1 },
  cartItemPrice: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  qtyControls: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 'auto' },
  qtyBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: Colors.surfaceAlt, 
    justifyContent: 'center', alignItems: 'center',
  },
  qtyText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, minWidth: 24, textAlign: 'center' },
  cartTotals: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.md },
  cartTotalRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  cartGrandLabel: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  cartGrandVal: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.primary },
  checkoutBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.primary, marginHorizontal: Spacing.md,
    marginBottom: Spacing.md, paddingVertical: Spacing.md, borderRadius: BorderRadius.full,
    shadowColor: Colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 8, elevation: 6,
  },
  checkoutBtnText: { color: Colors.white, fontWeight: '800', fontSize: FontSize.lg },

  // Tile styles for Grid
  productTile: {
    flex: 1, backgroundColor: Colors.surface, borderRadius: BorderRadius.lg,
    padding: Spacing.sm, marginBottom: Spacing.sm, minHeight: 220,
    borderWidth: 1, borderColor: Colors.border,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.04, shadowRadius: 8, elevation: 2,
  },
  tileIconWrap: {
    width: '100%', aspectRatio: 1, borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary + '12', justifyContent: 'center', alignItems: 'center',
    marginBottom: Spacing.sm, overflow: 'hidden',
  },
  tileImg: { width: '100%', height: '100%' },
  tileInfo: { paddingHorizontal: 2 },
  tileName: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, marginBottom: 4 },
  tilePrice: { fontSize: FontSize.md, fontWeight: '700', color: Colors.success },

  // Quick-add modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: Spacing.lg, maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.md,
  },
  modalTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  fieldLabel: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.text, marginTop: Spacing.sm, marginBottom: Spacing.xs },
  modalInput: {
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs + 2, fontSize: FontSize.sm, color: Colors.text,
  },
  catChip: {
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
    borderRadius: BorderRadius.full, backgroundColor: Colors.background,
    borderWidth: 1, borderColor: Colors.border,
  },
  catChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  catChipText: { fontSize: FontSize.xs, color: Colors.textSecondary, textTransform: 'capitalize' },
  catChipTextActive: { color: Colors.white, fontWeight: '600' },
  qaSubmitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: Colors.success, paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md, marginTop: Spacing.md, marginBottom: Spacing.sm,
  },
  qaSubmitText: { color: Colors.white, fontWeight: '600', fontSize: FontSize.sm },
});
