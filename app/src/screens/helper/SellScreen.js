// Helper's Sell tab (spec §9.1): camera always scanning at the top, the
// basket below, and one big "Take payment ₹X" bar at the bottom.
//
// - Scan a label: a fixed-price item goes straight into the basket; a sized
//   item asks "Which size?"; a "type the price" item asks for the price
//   (shared SizeOrPriceSheet).
// - Find by name (photo grid) and Price cards (big buttons for the products in
//   the "Price cards" category) for things without a label.
// - The basket and its client_ref are kept on the phone
//   (@petal_helper_basket, with the helper's user id: a basket saved for
//   someone else is ignored) so a lock or reload does not lose it. The
//   client_ref is new for every basket and kept across retries until the sale
//   is saved, so a retry never makes a second sale.
// - Take payment first reloads every product in the basket: new prices are
//   used and named ("Price updated: …"), and an item no longer for sale is
//   marked on its line and must be removed before taking payment.
// - Clear basket sits small at the bottom, with Undo.
// - First use shows a 3-step card (@petal_helper_help_seen), re-opened by Help.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator, useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import ProductScanner from '../../components/scan/ProductScanner';
import SizeOrPriceSheet from '../../components/scan/SizeOrPriceSheet';
import { SCANNER_COPY } from '../../components/scan/scanCooldown';
import { unlockAudio } from '../../components/scan/scanFeedback';
import { sheetModeFor, formatRupees } from '../../utils/scanAddLine';
import {
  addLine, changeQty, basketTotal, basketCount, setTaxRate, taxesKnown, newClientRef, refreshPrices,
} from '../../utils/helperBasket';
import TakePaymentSheet from '../../components/helper/TakePaymentSheet';
import PriceCardsSheet from '../../components/helper/PriceCardsSheet';
import FindByNameSheet from '../../components/helper/FindByNameSheet';
import useHelperSession from '../../components/helper/useHelperSession';
import { Colors, FontSize, Spacing, BorderRadius, Shadows } from '../../constants/theme';

const BASKET_KEY = '@petal_helper_basket';
const HELP_KEY = '@petal_helper_help_seen';
const PRICE_CARDS_CATEGORY = 'Price cards';
const LOOKUP_FAILED = 'Could not look up this item. Check the connection and scan it again.';
const SOLD = 'This one-off item is already sold. Check with the counter.';
const CARDS_FAILED = "Couldn't load the price cards. Check the internet and tap Try again.";
const UNDO_CLEAR_MS = 6000;
const NOT_FOR_SALE = 'Not for sale right now — ask the counter.';

const taxOf = (p) => (p && p.tax_percentage != null && p.tax_percentage !== '' ? Number(p.tax_percentage) || 0 : null);

export default function SellScreen() {
  const { locked, user } = useAuth();
  const userId = user?.id ?? null;
  const isFocused = useIsFocused();
  const { height } = useWindowDimensions();
  const { locationId, handleAccessEnded } = useHelperSession();
  const guard = useSubmitGuard();

  const [basket, setBasket] = useState([]);
  const [clientRef, setClientRef] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState(null); // { kind: 'ok' | 'error', text }
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // { product, mode, source: 'scan' | 'find' | 'cards' }
  const [showHelp, setShowHelp] = useState(false);
  const [showFind, setShowFind] = useState(false);
  const [findNotice, setFindNotice] = useState(null);
  const [showCards, setShowCards] = useState(false);
  const [cards, setCards] = useState(null);
  const [cardsLoading, setCardsLoading] = useState(false);
  const [cardsError, setCardsError] = useState('');
  const [cardsNotice, setCardsNotice] = useState(null);
  const [showPay, setShowPay] = useState(false);
  const [opening, setOpening] = useState(false);
  const [taxReady, setTaxReady] = useState(true);
  const [priceNotes, setPriceNotes] = useState([]);
  const [shopInfo, setShopInfo] = useState(null);
  const [cleared, setCleared] = useState(null); // { basket, clientRef } for Undo

  const busyRef = useRef(false);
  const committingRef = useRef(false);
  const taxCache = useRef(new Map());
  const taxInflight = useRef(new Set());
  const basketRef = useRef(basket);
  basketRef.current = basket;
  const clearTimer = useRef(null);

  // ── Load the kept basket + first-use card ──
  useEffect(() => {
    let alive = true;
    (async () => {
      let lines = [];
      let ref = null;
      try {
        const raw = await AsyncStorage.getItem(BASKET_KEY);
        const saved = raw ? JSON.parse(raw) : null;
        // Only this helper's own basket (a phone can change hands)
        if (saved && saved.userId === userId && Array.isArray(saved.lines)) {
          lines = saved.lines;
          if (typeof saved.clientRef === 'string') ref = saved.clientRef;
        }
      } catch { /* storage unavailable — start empty */ }
      let seen = false;
      try { seen = (await AsyncStorage.getItem(HELP_KEY)) === '1'; } catch { /* show it */ }
      if (!alive) return;
      setBasket(lines);
      setClientRef(ref || newClientRef());
      setShowHelp(!seen);
      setLoaded(true);
    })();
    return () => { alive = false; };
    // Once: MainNavigator remounts for a different user (keyed by user id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Keep the basket on the phone ──
  useEffect(() => {
    if (!loaded || !clientRef) return;
    (async () => {
      try {
        if (basket.length === 0) await AsyncStorage.removeItem(BASKET_KEY);
        else await AsyncStorage.setItem(BASKET_KEY, JSON.stringify({ userId, lines: basket, clientRef }));
      } catch { /* storage unavailable — the basket lives in memory only */ }
    })();
  }, [basket, clientRef, loaded, userId]);

  // ── Shop name + UPI QR ──
  useEffect(() => {
    api.getShopInfo()
      .then((res) => setShopInfo(res?.data || null))
      .catch((err) => { handleAccessEnded(err); });
  }, [handleAccessEnded]);

  useEffect(() => () => { if (clearTimer.current) clearTimeout(clearTimer.current); }, []);

  // ── Tax % per product (needed only for the discount maths) ──
  const fetchTax = useCallback(async (productId) => {
    if (taxCache.current.has(productId) || taxInflight.current.has(productId)) return;
    taxInflight.current.add(productId);
    try {
      const res = await api.getProduct(productId);
      const rate = taxOf(res?.data) ?? 0;
      taxCache.current.set(productId, rate);
      setBasket((b) => setTaxRate(b, productId, rate));
    } catch (err) {
      handleAccessEnded(err);
    } finally {
      taxInflight.current.delete(productId);
    }
  }, [handleAccessEnded]);

  const putInBasket = useCallback((product, { option = null, price = null } = {}) => {
    const known = taxOf(product);
    if (known != null) taxCache.current.set(product.id, known);
    const rate = taxCache.current.has(product.id) ? taxCache.current.get(product.id) : null;
    const name = option ? `${product.name} (${option.label})` : product.name;
    const unitPrice = option ? Number(option.price) : (price != null ? Number(price) : Number(product.selling_price) || 0);
    setBasket((b) => addLine(b, {
      product_id: product.id,
      option_id: option ? option.id : null,
      name,
      unit_price: unitPrice,
      price_mode: product.price_mode || 'fixed',
      tax_rate: rate,
    }));
    if (rate == null) fetchTax(product.id);
    if (cleared) setCleared(null);
    return `Added ${name} · ${formatRupees(unitPrice)}`;
  }, [fetchTax, cleared]);

  // ── Scan ──
  const handleCode = async (raw) => {
    if (busyRef.current || pending) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.scanProductQR(raw, locationId || undefined);
      const product = res && res.data;
      if (!product) throw new Error(LOOKUP_FAILED);
      const mode = sheetModeFor(product);
      if (mode) setPending({ product, mode, source: 'scan' });
      else setMessage({ kind: 'ok', text: putInBasket(product) });
    } catch (err) {
      if (!handleAccessEnded(err)) setMessage({ kind: 'error', text: (err && err.message) || LOOKUP_FAILED });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // ── Size / price answer (from scan, Find by name or Price cards) ──
  const commitPending = (answer) => {
    if (committingRef.current || !pending) return;
    committingRef.current = true;
    const { product, source } = pending;
    const text = putInBasket(product, answer);
    setPending(null);
    if (source === 'cards') setCardsNotice({ kind: 'ok', text });
    else if (source === 'find') { setShowFind(false); setMessage({ kind: 'ok', text }); }
    else setMessage({ kind: 'ok', text });
    setTimeout(() => { committingRef.current = false; }, 0);
  };

  const cancelPending = () => {
    const source = pending && pending.source;
    setPending(null);
    if (source === 'scan') setMessage({ kind: 'ok', text: 'Nothing added. Scan the next item.' });
  };

  // ── Find by name ──
  const openFind = () => { unlockAudio(); setFindNotice(null); setShowFind(true); };
  const pickFromFind = async (item) => {
    if (busyRef.current) return;
    if (item.available === false) { setFindNotice({ kind: 'error', text: SOLD }); return; }
    busyRef.current = true;
    setFindNotice({ kind: 'ok', text: `Opening ${item.name}…` });
    try {
      // The list has no sizes, so load the product itself.
      const res = await api.getProduct(item.id);
      const product = res?.data || item;
      const mode = sheetModeFor(product);
      if (mode) { setFindNotice(null); setPending({ product, mode, source: 'find' }); return; }
      const text = putInBasket(product);
      setShowFind(false);
      setMessage({ kind: 'ok', text });
    } catch (err) {
      if (!handleAccessEnded(err)) setFindNotice({ kind: 'error', text: (err && err.message) || LOOKUP_FAILED });
    } finally {
      busyRef.current = false;
    }
  };

  // ── Price cards ──
  const loadCards = useCallback(async () => {
    setCardsLoading(true);
    setCardsError('');
    try {
      const params = { category: PRICE_CARDS_CATEGORY, limit: 100 };
      if (locationId) params.location_id = locationId;
      const res = await api.getProducts(params);
      const list = Array.isArray(res?.data) ? res.data.slice(0, 30) : [];
      // Sizes are only on the single-product answer.
      const details = await Promise.all(list.map((p) => api.getProduct(p.id).then((r) => r?.data || p).catch(() => p)));
      const out = [];
      for (const p of details) {
        if (p.available === false) continue;
        if (Array.isArray(p.options) && p.options.length > 0) {
          for (const o of p.options) {
            out.push({ key: `${p.id}:${o.id}`, product: p, option: o, title: `${p.name} · ${o.label}`, priceText: formatRupees(o.price) });
          }
        } else if (p.price_mode === 'open') {
          out.push({ key: `${p.id}`, product: p, option: null, title: p.name, priceText: p.price_hint || 'Type the price' });
        } else {
          out.push({ key: `${p.id}`, product: p, option: null, title: p.name, priceText: formatRupees(p.selling_price) });
        }
      }
      setCards(out);
    } catch (err) {
      if (!handleAccessEnded(err)) setCardsError(CARDS_FAILED);
    } finally {
      setCardsLoading(false);
    }
  }, [locationId, handleAccessEnded]);

  const openCards = () => {
    unlockAudio();
    setCardsNotice(null);
    setShowCards(true);
    if (!cards) loadCards();
  };

  const pickCard = (card) => {
    if (card.option) { setCardsNotice({ kind: 'ok', text: putInBasket(card.product, { option: card.option }) }); return; }
    const mode = sheetModeFor(card.product);
    if (mode) { setPending({ product: card.product, mode, source: 'cards' }); return; }
    setCardsNotice({ kind: 'ok', text: putInBasket(card.product) });
  };

  // ── Basket actions ──
  const clearBasket = () => {
    if (basket.length === 0) return;
    setCleared({ basket, clientRef });
    setBasket([]);
    setClientRef(newClientRef());
    setMessage(null);
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setCleared(null), UNDO_CLEAR_MS);
  };

  const undoClear = () => {
    if (!cleared) return;
    setBasket(cleared.basket);
    setClientRef(cleared.clientRef);
    setCleared(null);
  };

  const closeHelp = async () => {
    unlockAudio();
    setShowHelp(false);
    try { await AsyncStorage.setItem(HELP_KEY, '1'); } catch { /* shows again next time */ }
  };

  // ── Take payment ──
  // Reloads every product in the basket (in parallel): current prices, sizes
  // and tax, and whether each is still for sale. -> refreshPrices result.
  const refreshBasket = useCallback(async () => {
    const current = basketRef.current;
    const ids = [...new Set(current.map((l) => l.product_id))];
    const byId = {};
    let ended = false;
    await Promise.all(ids.map((id) => api.getProduct(id)
      .then((r) => { byId[id] = r?.data || null; })
      .catch((err) => {
        if (handleAccessEnded(err)) { ended = true; return; }
        // 404: switched off or gone. Anything else (network): leave the line.
        if (err && err.status === 404) byId[id] = null;
      })));
    if (ended) return null;
    for (const [id, p] of Object.entries(byId)) {
      const rate = taxOf(p);
      if (p && rate != null) taxCache.current.set(Number(id), rate);
    }
    // Lines added while loading are kept as they are.
    const r = refreshPrices(basketRef.current, byId);
    setBasket(r.basket);
    basketRef.current = r.basket;
    setTaxReady(taxesKnown(r.basket));
    setPriceNotes(r.changes);
    return r;
  }, [handleAccessEnded]);

  const openPay = guard(async () => {
    unlockAudio();
    if (basketRef.current.length === 0) return;
    setOpening(true);
    let r = null;
    try { r = await refreshBasket(); } finally { setOpening(false); }
    if (!r) return; // access ended: the PIN pad is showing
    if (r.blocked.length > 0) {
      const repick = r.basket.find((l) => l.unavailable && l.repick);
      setMessage({
        kind: 'error',
        text: repick
          ? `${repick.blocked_text} Remove it from the basket first.`
          : `${NOT_FOR_SALE} Remove it from the basket first.`,
      });
      return;
    }
    setShowPay(true);
  });

  // The saved sale (an earlier try of this basket) held other items: keep
  // what it did not include as a new basket with a new basket number.
  const onKeepLeftover = useCallback((lines) => {
    setBasket(lines);
    setClientRef(newClientRef());
    setShowPay(false);
    setPriceNotes([]);
    setMessage({ kind: 'ok', text: 'The other items are in the basket. Take payment for them.' });
  }, []);

  // The earlier sale of this basket was undone: same items, new basket
  // number (saved with the basket), so the next payment makes a new sale.
  const onNewClientRef = useCallback(() => {
    setClientRef(newClientRef());
  }, []);

  const onSaved = useCallback(() => {
    // Saved: this basket is done. A new one gets a new client_ref.
    setBasket([]);
    setClientRef(newClientRef());
    setCleared(null);
  }, []);

  const onNextCustomer = useCallback(() => {
    unlockAudio();
    setShowPay(false);
    setMessage(null);
    setPriceNotes([]);
  }, []);

  // ── Render ──
  // A line that is not for sale is never counted in the total.
  const sellable = basket.filter((l) => !l.unavailable);
  const { total } = basketTotal(sellable, null);
  const count = basketCount(sellable);
  const blocked = sellable.length !== basket.length;
  const cameraHeight = Math.round(Math.min(Math.max(height * 0.34, 200), 340));
  const paused = !isFocused || locked || showPay || showFind || showCards || showHelp || !!pending || !loaded;

  let pill;
  if (busy) {
    pill = (
      <View style={styles.pill}>
        <ActivityIndicator color={Colors.white} />
        <Text style={styles.pillText}>Looking up the item…</Text>
      </View>
    );
  } else if (message) {
    const isError = message.kind === 'error';
    pill = (
      <View style={[styles.pill, isError ? styles.pillError : styles.pillOk]} accessibilityLiveRegion={isError ? 'assertive' : 'polite'}>
        <Ionicons name={isError ? 'alert-circle' : 'checkmark-circle'} size={24} color={isError ? Colors.warning : Colors.success} />
        <Text style={styles.pillText}>{message.text}</Text>
      </View>
    );
  } else {
    pill = (
      <View style={styles.pill}>
        <Ionicons name="qr-code-outline" size={22} color={Colors.white} />
        <Text style={styles.pillText}>{SCANNER_COPY.hint}</Text>
      </View>
    );
  }

  const sizeSheet = (
    <SizeOrPriceSheet
      pending={pending}
      onPickOption={(o) => commitPending({ option: o })}
      onSubmitPrice={(price) => commitPending({ price })}
      onCancel={cancelPending}
    />
  );

  const renderLine = ({ item }) => (item.unavailable ? (
    <View style={[styles.line, styles.lineBlocked]}>
      <View style={styles.lineTop}>
        <Text style={[styles.lineName, styles.lineNameBlocked]}>{item.name}</Text>
        <Text style={styles.lineAmount}>{`× ${item.qty}`}</Text>
      </View>
      <View style={styles.blockedRow}>
        <Ionicons name="alert-circle" size={22} color={Colors.error} />
        <Text style={styles.blockedText}>{item.blocked_text || NOT_FOR_SALE}</Text>
      </View>
      <TouchableOpacity
        style={styles.removeBtn}
        onPress={() => setBasket((b) => changeQty(b, item.key, -item.qty))}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${item.name} from the basket`}
      >
        <Ionicons name="trash-outline" size={20} color={Colors.white} />
        <Text style={styles.removeText}>Remove</Text>
      </TouchableOpacity>
    </View>
  ) : (
    <View style={styles.line}>
      <View style={styles.lineTop}>
        <Text style={styles.lineName}>{item.name}</Text>
        <Text style={styles.lineAmount}>{formatRupees(item.unit_price * item.qty)}</Text>
      </View>
      <View style={styles.lineBottom}>
        <Text style={styles.lineEach}>{`${formatRupees(item.unit_price)} each`}</Text>
        <View style={styles.qtyRow}>
          <TouchableOpacity
            style={styles.qtyBtn}
            onPress={() => setBasket((b) => changeQty(b, item.key, -1))}
            accessibilityRole="button"
            accessibilityLabel={item.qty === 1 ? `Remove ${item.name}` : `One less ${item.name}`}
          >
            <Ionicons name={item.qty === 1 ? 'trash-outline' : 'remove'} size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.qty} accessibilityLabel={`Quantity ${item.qty}`}>{`× ${item.qty}`}</Text>
          <TouchableOpacity
            style={styles.qtyBtn}
            onPress={() => setBasket((b) => changeQty(b, item.key, 1))}
            accessibilityRole="button"
            accessibilityLabel={`One more ${item.name}`}
          >
            <Ionicons name="add" size={22} color={Colors.text} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.qtyBtn, styles.qtyBtnWide]}
            onPress={() => setBasket((b) => changeQty(b, item.key, 10))}
            accessibilityRole="button"
            accessibilityLabel={`Ten more ${item.name}`}
          >
            <Text style={styles.plusTen}>+10</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  ));

  return (
    <View style={styles.root}>
      <View style={[styles.camera, { height: cameraHeight }]}>
        <ProductScanner onCode={handleCode} paused={paused}>
          <View style={styles.pillWrap} pointerEvents="none">{pill}</View>
        </ProductScanner>
      </View>

      <View style={styles.tools}>
        <TouchableOpacity style={styles.toolBtn} onPress={openFind} accessibilityRole="button" accessibilityLabel="Find by name">
          <Ionicons name="search" size={22} color={Colors.primary} />
          <Text style={styles.toolText}>Find by name</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.toolBtn} onPress={openCards} accessibilityRole="button" accessibilityLabel="Price cards">
          <Ionicons name="pricetags-outline" size={22} color={Colors.primary} />
          <Text style={styles.toolText}>Price cards</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.helpBtn} onPress={() => setShowHelp(true)} accessibilityRole="button" accessibilityLabel="Help">
          <Ionicons name="information-circle-outline" size={22} color={Colors.primary} />
          <Text style={styles.toolText}>Help</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        style={styles.list}
        data={basket}
        keyExtractor={(l) => l.key}
        renderItem={renderLine}
        contentContainerStyle={{ padding: Spacing.md, paddingBottom: Spacing.lg }}
        ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
        ListEmptyComponent={loaded ? (
          <View style={styles.empty}>
            <Ionicons name="basket-outline" size={40} color={Colors.textLight} />
            <Text style={styles.emptyText}>Basket is empty. Scan the QR on each product.</Text>
          </View>
        ) : <ActivityIndicator color={Colors.primary} style={{ marginTop: Spacing.lg }} />}
        ListFooterComponent={basket.length > 0 ? (
          <TouchableOpacity style={styles.clearBtn} onPress={clearBasket} accessibilityRole="button" accessibilityLabel="Clear basket">
            <Ionicons name="close-circle-outline" size={18} color={Colors.textSecondary} />
            <Text style={styles.clearText}>Clear basket</Text>
          </TouchableOpacity>
        ) : null}
      />

      {cleared ? (
        <View style={styles.toast} accessibilityLiveRegion="polite">
          <Text style={styles.toastText}>Basket cleared.</Text>
          <TouchableOpacity style={styles.toastBtn} onPress={undoClear} accessibilityRole="button" accessibilityLabel="Undo, bring the basket back">
            <Text style={styles.toastBtnText}>Undo</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={styles.bar}>
        <Text style={styles.barSummary}>
          {blocked
            ? (basket.some((l) => l.unavailable && !l.repick)
              ? 'Remove the item that is not for sale, then take payment.'
              : 'Remove the item marked in red, then take payment.')
            : count > 0 ? `${count} ${count === 1 ? 'item' : 'items'} · ${formatRupees(total)}` : 'Scan an item to start'}
        </Text>
        <TouchableOpacity
          style={[styles.payBtn, (count === 0 || opening || blocked) && styles.payBtnOff]}
          onPress={openPay}
          disabled={count === 0 || opening || blocked}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={count > 0 ? `Take payment ${formatRupees(total)}` : 'Take payment, basket is empty'}
          accessibilityState={{ disabled: count === 0 || opening || blocked }}
        >
          {opening ? <ActivityIndicator color={Colors.white} /> : null}
          <Text style={styles.payText}>{count > 0 ? `Take payment ${formatRupees(total)}` : 'Take payment'}</Text>
        </TouchableOpacity>
      </View>

      {!showFind && !showCards ? sizeSheet : null}

      {showHelp ? (
        <View style={styles.helpOverlay}>
          <View style={styles.helpCard}>
            <Text style={styles.helpTitle}>How to sell</Text>
            {[
              'Scan the QR on each product.',
              'Tap Take payment.',
              'Take Cash or show the UPI code. That\'s it.',
            ].map((t, i) => (
              <View key={t} style={styles.helpRow}>
                <View style={styles.helpNum}><Text style={styles.helpNumText}>{i + 1}</Text></View>
                <Text style={styles.helpText}>{t}</Text>
              </View>
            ))}
            <TouchableOpacity style={styles.helpOk} onPress={closeHelp} accessibilityRole="button" accessibilityLabel="Got it">
              <Text style={styles.helpOkText}>Got it</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      <FindByNameSheet
        visible={showFind}
        locationId={locationId}
        onPick={pickFromFind}
        onClose={() => { setPending(null); setShowFind(false); }}
        onError={handleAccessEnded}
        notice={findNotice}
      >
        {showFind ? sizeSheet : null}
      </FindByNameSheet>

      <PriceCardsSheet
        visible={showCards}
        cards={cards}
        loading={cardsLoading}
        error={cardsError}
        onRetry={loadCards}
        onPick={pickCard}
        onClose={() => { setPending(null); setShowCards(false); }}
        notice={cardsNotice}
      >
        {showCards ? sizeSheet : null}
      </PriceCardsSheet>

      <TakePaymentSheet
        visible={showPay}
        basket={basket}
        clientRef={clientRef}
        locationId={locationId}
        shopInfo={shopInfo}
        taxReady={taxReady}
        onRetryTaxes={refreshBasket}
        priceNotes={priceNotes}
        onRefreshPrices={refreshBasket}
        onClose={() => setShowPay(false)}
        onSaved={onSaved}
        onNextCustomer={onNextCustomer}
        onKeepLeftover={onKeepLeftover}
        onAccessEnded={handleAccessEnded}
        onNewClientRef={onNewClientRef}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  camera: { backgroundColor: Colors.black, overflow: 'hidden' },
  pillWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: Spacing.sm, alignItems: 'center' },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, maxWidth: 520,
  },
  pillOk: { borderWidth: 2, borderColor: Colors.success },
  pillError: { backgroundColor: 'rgba(0,0,0,0.85)', borderWidth: 2, borderColor: Colors.warning },
  pillText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '600', flexShrink: 1 },
  tools: {
    flexDirection: 'row', gap: Spacing.sm, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  toolBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    minHeight: 48, borderRadius: BorderRadius.md, borderWidth: 2, borderColor: Colors.primary, backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.xs,
  },
  helpBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    minHeight: 48, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.surface, paddingHorizontal: Spacing.md,
  },
  toolText: { fontSize: FontSize.md, fontWeight: '700', color: Colors.primaryDark },
  list: { flex: 1 },
  line: {
    backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md,
    borderWidth: 1, borderColor: Colors.border,
  },
  lineTop: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  lineBlocked: { borderWidth: 2, borderColor: Colors.error, backgroundColor: Colors.errorLight },
  lineNameBlocked: { textDecorationLine: 'line-through' },
  blockedRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.sm },
  blockedText: { flex: 1, fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  removeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs, alignSelf: 'flex-start',
    minHeight: 48, paddingHorizontal: Spacing.lg, borderRadius: BorderRadius.md, backgroundColor: Colors.error, marginTop: Spacing.sm,
  },
  removeText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '700' },
  lineName: { flex: 1, fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  lineAmount: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] },
  lineBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.sm, flexWrap: 'wrap', gap: Spacing.sm },
  lineEach: { fontSize: FontSize.md, color: Colors.textSecondary, fontVariant: ['tabular-nums'] },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  qtyBtn: {
    width: 48, height: 48, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
    alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surfaceAlt,
  },
  qtyBtnWide: { width: 56 },
  plusTen: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  qty: { minWidth: 48, textAlign: 'center', fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] },
  empty: { alignItems: 'center', padding: Spacing.lg, gap: Spacing.sm },
  emptyText: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center' },
  clearBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xs,
    alignSelf: 'center', minHeight: 44, paddingHorizontal: Spacing.md, marginTop: Spacing.md,
  },
  clearText: { fontSize: FontSize.md, color: Colors.textSecondary, textDecorationLine: 'underline' },
  toast: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm,
    marginHorizontal: Spacing.md, marginBottom: Spacing.sm, paddingLeft: Spacing.md, borderRadius: BorderRadius.md,
    backgroundColor: Colors.text,
  },
  toastText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '600' },
  toastBtn: { minHeight: 48, paddingHorizontal: Spacing.lg, justifyContent: 'center' },
  toastBtnText: { color: Colors.primaryLight, fontSize: FontSize.md, fontWeight: '800' },
  bar: {
    paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: Spacing.sm,
    backgroundColor: Colors.surface, borderTopWidth: 1, borderTopColor: Colors.border, gap: Spacing.xs,
  },
  barSummary: { fontSize: FontSize.md, fontWeight: '600', color: Colors.textSecondary, textAlign: 'center' },
  payBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    minHeight: 60, borderRadius: BorderRadius.md, backgroundColor: Colors.primary, ...Shadows.sm,
  },
  payBtnOff: { opacity: 0.45 },
  payText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '800', fontVariant: ['tabular-nums'] },
  helpOverlay: {
    ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: Spacing.md,
  },
  helpCard: { width: '100%', maxWidth: 440, backgroundColor: Colors.surface, borderRadius: BorderRadius.xl, padding: Spacing.lg },
  helpTitle: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, marginBottom: Spacing.md },
  helpRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginBottom: Spacing.md },
  helpNum: { width: 40, height: 40, borderRadius: BorderRadius.full, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  helpNumText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '800' },
  helpText: { flex: 1, fontSize: FontSize.lg, color: Colors.text, lineHeight: 26 },
  helpOk: { minHeight: 56, borderRadius: BorderRadius.md, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', marginTop: Spacing.sm },
  helpOkText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '800' },
});
