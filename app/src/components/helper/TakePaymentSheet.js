// Take payment (spec §9.2) for the helper's Sell screen.
//
// Steps: choose (total, Discount ▸, CASH / UPI, Part cash part UPI ▸,
// Customer phone ▸) -> cash | upi | split -> success. Over the helper's
// discount limit the server answers "This discount needs the counter's OK."
// and the step offers "Ask counter to approve" -> OverridePad.
//
// The sale goes to POST /api/sales with the basket's client_ref, so a retry
// after a dropped answer returns the same sale instead of making a second
// one. Server messages are shown as they come; a network failure shows the
// spec's "Couldn't save — ... tap Take payment again" with that button.
//
// <TakePaymentSheet visible basket clientRef locationId shopInfo taxReady
//    onRetryTaxes onClose onSaved={(sale) => …} onNextCustomer
//    onAccessEnded={(err) => bool} />
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView, TextInput, Image,
  ActivityIndicator, Linking, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import api from '../../services/api';
import useSubmitGuard from '../../hooks/useSubmitGuard';
import { printHtml } from '../../utils/printHelpers';
import { formatRupees } from '../../utils/scanAddLine';
import {
  basketTotal, toSalePayload, changeDue, splitPayments, parseAmount,
} from '../../utils/helperBasket';
import OverridePad from './OverridePad';
import { Colors, FontSize, Spacing, BorderRadius, Shadows } from '../../constants/theme';

export const SAVE_FAILED = "Couldn't save — check the internet and tap Take payment again. Nothing was charged twice.";
const NEEDS_OK = "This discount needs the counter's OK.";
const REGISTER_CLOSED = "The counter hasn't opened the register yet. Ask them to open it, then try again.";
const NO_QR = "Ask the customer to pay to the shop's UPI at the counter.";
const AUTO_NEXT_SECONDS = 4;

const DISCOUNT_CHIPS = [
  { key: 'p5', label: '5%', type: 'percentage', value: 5 },
  { key: 'p10', label: '10%', type: 'percentage', value: 10 },
  { key: 'f50', label: '₹50', type: 'fixed', value: 50 },
  { key: 'f100', label: '₹100', type: 'fixed', value: 100 },
];

const METHOD_LABEL = { cash: 'Cash', upi: 'UPI' };

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function discountLabel(d) {
  if (!d) return '';
  return d.type === 'percentage' ? `${d.value}% off` : `${formatRupees(d.value)} off`;
}

// What the bill shows, from the POST /sales answer (helpers cannot read
// GET /sales/:id). sale_items.unit_price is stored pre-tax, so the line amount
// is line_total, or quantity x price + tax when line_total was stored as 0.
function billLines(sale) {
  return (sale?.items || []).map((i) => {
    const qty = Number(i.quantity) || 0;
    const amount = Number(i.line_total) || (Number(i.unit_price) * qty + (Number(i.tax_amount) || 0));
    return { name: i.product_name || 'Item', qty, amount: Math.round(amount * 100) / 100 };
  });
}

function methodsText(sale) {
  const methods = [...new Set((sale?.payments || []).map((p) => p.method))];
  return methods.map((m) => METHOD_LABEL[m] || m).join(' + ');
}

function billText(sale, shopName) {
  const lines = billLines(sale).map((l) => `${l.name} × ${l.qty}  ${formatRupees(l.amount)}`);
  const disc = Number(sale?.discount_amount) || 0;
  return [
    shopName || 'Flower Point',
    `Bill ${sale?.sale_number || ''}`.trim(),
    '',
    ...lines,
    ...(disc > 0 ? [`Discount −${formatRupees(disc)}`] : []),
    `Total ${formatRupees(sale?.grand_total)} · Paid by ${methodsText(sale)}`,
    '',
    'Thank you!',
  ].join('\n');
}

function billHtml(sale, shopName) {
  const rows = billLines(sale).map((l) => (
    `<tr><td>${esc(l.name)} × ${esc(l.qty)}</td><td style="text-align:right">${esc(formatRupees(l.amount))}</td></tr>`
  )).join('');
  const disc = Number(sale?.discount_amount) || 0;
  const when = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  return `
    <div style="font-family: Arial, sans-serif; width: 280px; font-size: 13px;">
      <div style="text-align:center; font-size:18px; font-weight:bold;">${esc(shopName || 'Flower Point')}</div>
      <div style="text-align:center; margin: 4px 0 8px;">BILL ${esc(sale?.sale_number || '')}<br/>${esc(when)}</div>
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
      <hr/>
      ${disc > 0 ? `<div style="display:flex; justify-content:space-between;"><span>Discount</span><span>−${esc(formatRupees(disc))}</span></div>` : ''}
      <div style="display:flex; justify-content:space-between; font-size:16px; font-weight:bold;"><span>Total</span><span>${esc(formatRupees(sale?.grand_total))}</span></div>
      <div>Paid by ${esc(methodsText(sale))}</div>
      <div style="text-align:center; margin-top:10px;">Thank you!</div>
    </div>`;
}

function waNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return digits.length >= 10 ? digits : '';
}

export default function TakePaymentSheet({
  visible, basket, clientRef, locationId, shopInfo, taxReady = true, onRetryTaxes,
  onClose, onSaved, onNextCustomer, onAccessEnded,
}) {
  const insets = useSafeAreaInsets();
  const guard = useSubmitGuard();

  const [step, setStep] = useState('choose'); // choose | cash | upi | split | override | success
  const [discount, setDiscount] = useState(null);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [otherText, setOtherText] = useState('');
  const [otherType, setOtherType] = useState('fixed');
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [given, setGiven] = useState('');
  const [upiRef, setUpiRef] = useState('');
  const [splitCash, setSplitCash] = useState('');
  const [registerOpen, setRegisterOpen] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null); // { text, kind: 'network' | 'needsOk' | 'other' }
  const [overrideError, setOverrideError] = useState('');
  const [returnStep, setReturnStep] = useState('cash');
  const [sale, setSale] = useState(null);
  const [duplicate, setDuplicate] = useState(false);
  const [autoLeft, setAutoLeft] = useState(null);
  const lastPayments = useRef(null);
  const basketAtSave = useRef(null);

  // Fresh sheet every time it opens (the basket and its client_ref stay).
  useEffect(() => {
    if (!visible) return;
    setStep('choose');
    setDiscount(null);
    setDiscountOpen(false);
    setOtherText('');
    setOtherType('fixed');
    setPhoneOpen(false);
    setPhone('');
    setGiven('');
    setUpiRef('');
    setSplitCash('');
    setSaving(false);
    setError(null);
    setOverrideError('');
    setSale(null);
    setDuplicate(false);
    setAutoLeft(null);
    lastPayments.current = null;
    setRegisterOpen(null);
    let alive = true;
    if (locationId) {
      api.getRegisterStatus(locationId)
        .then((res) => { if (alive) setRegisterOpen(!!res?.isOpen); })
        .catch((err) => { if (onAccessEnded) onAccessEnded(err); });
    }
    return () => { alive = false; };
    // Only on open: locationId / onAccessEnded do not change while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const totals = useMemo(() => basketTotal(basket, discount), [basket, discount]);
  const total = totals.total;

  // Next customer by itself after a few seconds, unless the helper is
  // sharing or printing the bill (or typed a phone to share it to).
  useEffect(() => {
    if (step !== 'success' || autoLeft == null) return undefined;
    if (autoLeft <= 0) { onNextCustomer(); return undefined; }
    const t = setTimeout(() => setAutoLeft((n) => (n == null ? null : n - 1)), 1000);
    return () => clearTimeout(t);
  }, [step, autoLeft, onNextCustomer]);

  const goStep = (next) => {
    setError(null);
    setStep(next);
  };

  const applyDiscount = (d) => {
    setDiscount(d);
    setDiscountOpen(false);
    setError(null);
  };

  const applyOther = () => {
    const v = parseAmount(otherText);
    if (v == null || v <= 0) {
      setError({ kind: 'other', text: otherType === 'percentage' ? 'Type the % off, e.g. 10.' : 'Type the ₹ off, e.g. 50.' });
      return;
    }
    applyDiscount({ type: otherType, value: v });
    setOtherText('');
  };

  const submit = async (payments, override) => {
    lastPayments.current = payments;
    setSaving(true);
    setError(null);
    if (override) setOverrideError('');
    basketAtSave.current = basket;
    try {
      const res = await api.createSale(toSalePayload(basket, {
        locationId, payments, discount, override, clientRef,
      }));
      const saved = res?.data || null;
      setSale(saved);
      setDuplicate(!!res?.duplicate);
      setStep('success');
      setAutoLeft(phone.trim() ? null : AUTO_NEXT_SECONDS);
      if (onSaved) onSaved(saved);
    } catch (err) {
      if (onAccessEnded && onAccessEnded(err)) return;
      const status = err?.status || 0;
      const message = err?.message || '';
      if (status === 0 || status >= 500) {
        const e = { kind: 'network', text: SAVE_FAILED };
        if (override) { setOverrideError(SAVE_FAILED); } else setError(e);
      } else if (status === 403 && message === NEEDS_OK && !override) {
        setError({ kind: 'needsOk', text: message });
      } else if (override) {
        // Wrong PIN, locked, wrong shop, needs a manager: on the pad.
        setOverrideError(message);
      } else {
        setError({ kind: 'other', text: message });
      }
    } finally {
      setSaving(false);
    }
  };

  const payCash = guard(async () => submit([{ method: 'cash', amount: total }]));
  const payUpi = guard(async () => submit([{ method: 'upi', amount: total, reference: upiRef }]));
  const paySplit = guard(async () => {
    const s = splitPayments(total, splitCash);
    if (s.error) { setError({ kind: 'other', text: s.error }); return; }
    const ps = s.payments.map((p) => (p.method === 'upi' ? { ...p, reference: upiRef } : p));
    await submit(ps);
  });
  const retry = guard(async () => { if (lastPayments.current) await submit(lastPayments.current); });
  const approve = guard(async (code, pin) => {
    if (!lastPayments.current) return;
    await submit(lastPayments.current, { employee_code: code, pin });
  });

  const askCounter = () => {
    setReturnStep(step);
    setOverrideError('');
    setStep('override');
  };

  const shareBill = () => {
    setAutoLeft(null);
    const text = billText(sale, shopInfo?.shop_name);
    const num = waNumber(phone);
    const url = `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
    Linking.openURL(url).catch(() => {});
  };

  const printBill = () => {
    setAutoLeft(null);
    printHtml(billHtml(sale, shopInfo?.shop_name), `Bill ${sale?.sale_number || ''}`.trim());
  };

  const discountBlocked = !!totals.error;
  const qrUrl = shopInfo?.upi_qr_image_url ? api.getMediaUrl(shopInfo.upi_qr_image_url) : null;

  // ── Pieces ──
  const errorBox = error ? (
    <View style={[styles.errorBox, error.kind === 'needsOk' && styles.warnBox]} accessibilityLiveRegion="assertive">
      <Ionicons name={error.kind === 'needsOk' ? 'shield-outline' : 'alert-circle'} size={24} color={error.kind === 'needsOk' ? Colors.warning : Colors.error} />
      <Text style={styles.errorText}>{error.text}</Text>
    </View>
  ) : null;

  // The step's big button: its own action, or (after a failure) the retry /
  // ask-the-counter action the message talks about.
  const primary = (label, onPress, icon = 'checkmark-circle') => {
    let text = label;
    let handler = onPress;
    let ic = icon;
    if (error?.kind === 'network') { text = `Take payment ${formatRupees(total)}`; handler = retry; ic = 'refresh'; }
    if (error?.kind === 'needsOk') { text = 'Ask counter to approve'; handler = askCounter; ic = 'shield-checkmark'; }
    return (
      <TouchableOpacity
        style={[styles.primary, saving && styles.disabled]}
        onPress={handler}
        disabled={saving}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={text}
        accessibilityState={{ disabled: saving }}
      >
        {saving ? <ActivityIndicator color={Colors.white} /> : <Ionicons name={ic} size={28} color={Colors.white} />}
        <Text style={styles.primaryText}>{saving ? 'Saving…' : text}</Text>
      </TouchableOpacity>
    );
  };

  const backBtn = (label = 'Back', onPress = () => goStep('choose')) => (
    <TouchableOpacity
      style={styles.secondary}
      onPress={onPress}
      disabled={saving}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.secondaryText}>{label}</Text>
    </TouchableOpacity>
  );

  const discountLine = discount && !totals.error ? (
    <Text style={styles.discountLine}>
      {`−${formatRupees(totals.discount)} (${discountLabel(discount)}) · was ${formatRupees(totals.subtotal)}`}
    </Text>
  ) : null;

  let content;
  if (step === 'choose') {
    content = (
      <>
        <Text style={styles.label}>Total</Text>
        <Text style={styles.hero}>{formatRupees(total)}</Text>
        {discountLine}

        {/* Discount ▸ */}
        <TouchableOpacity
          style={[styles.rowBtn, !taxReady && styles.disabled]}
          onPress={() => (taxReady ? setDiscountOpen((o) => !o) : onRetryTaxes && onRetryTaxes())}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Discount"
          accessibilityState={{ expanded: discountOpen }}
        >
          <Ionicons name="pricetag-outline" size={22} color={Colors.primary} />
          <Text style={styles.rowText}>
            {!taxReady ? 'Discount needs the internet — tap to try again' : discount ? `Discount: ${discountLabel(discount)}` : 'Discount'}
          </Text>
          <Ionicons name={discountOpen ? 'chevron-up' : 'chevron-forward'} size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        {discountOpen ? (
          <View style={styles.discountBox}>
            <View style={styles.chips}>
              {DISCOUNT_CHIPS.map((c) => {
                const on = discount && discount.type === c.type && Number(discount.value) === c.value;
                return (
                  <TouchableOpacity
                    key={c.key}
                    style={[styles.chip, on && styles.chipOn]}
                    onPress={() => applyDiscount({ type: c.type, value: c.value })}
                    accessibilityRole="button"
                    accessibilityLabel={`${c.label} off`}
                    accessibilityState={{ selected: !!on }}
                  >
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{c.label}</Text>
                  </TouchableOpacity>
                );
              })}
              {discount ? (
                <TouchableOpacity
                  style={styles.chip}
                  onPress={() => applyDiscount(null)}
                  accessibilityRole="button"
                  accessibilityLabel="No discount"
                >
                  <Text style={styles.chipText}>No discount</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <Text style={styles.smallLabel}>Other amount</Text>
            <View style={styles.otherRow}>
              <View style={styles.toggle}>
                {[['fixed', '₹'], ['percentage', '%']].map(([t, l]) => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.toggleBtn, otherType === t && styles.toggleOn]}
                    onPress={() => setOtherType(t)}
                    accessibilityRole="button"
                    accessibilityLabel={t === 'fixed' ? 'Rupees off' : 'Percent off'}
                    accessibilityState={{ selected: otherType === t }}
                  >
                    <Text style={[styles.toggleText, otherType === t && styles.toggleTextOn]}>{l}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TextInput
                style={styles.otherInput}
                value={otherText}
                onChangeText={setOtherText}
                keyboardType="decimal-pad"
                placeholder={otherType === 'fixed' ? '₹ off' : '% off'}
                placeholderTextColor={Colors.textLight}
                onSubmitEditing={applyOther}
                accessibilityLabel={otherType === 'fixed' ? 'Rupees off' : 'Percent off'}
              />
              <TouchableOpacity style={styles.applyBtn} onPress={applyOther} accessibilityRole="button" accessibilityLabel="Use this discount">
                <Text style={styles.applyText}>Use</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
        {totals.error ? (
          <View style={styles.errorBox}><Ionicons name="alert-circle" size={22} color={Colors.error} /><Text style={styles.errorText}>{totals.error}</Text></View>
        ) : null}
        {errorBox}

        {registerOpen === false ? (
          <View style={styles.warnBox}>
            <Ionicons name="information-circle" size={22} color={Colors.warning} />
            <Text style={styles.errorText}>{`Cash: ${REGISTER_CLOSED} UPI works now.`}</Text>
          </View>
        ) : null}

        <View style={styles.methods}>
          <TouchableOpacity
            style={[styles.methodBtn, discountBlocked && styles.disabled]}
            onPress={() => goStep('cash')}
            disabled={discountBlocked}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={`Cash, ${formatRupees(total)}`}
          >
            <Ionicons name="cash-outline" size={34} color={Colors.white} />
            <Text style={styles.methodText}>CASH</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.methodBtn, styles.methodUpi, discountBlocked && styles.disabled]}
            onPress={() => goStep('upi')}
            disabled={discountBlocked}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={`UPI, ${formatRupees(total)}`}
          >
            <Ionicons name="qr-code-outline" size={34} color={Colors.white} />
            <Text style={styles.methodText}>UPI</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={styles.rowBtn}
          onPress={() => goStep('split')}
          disabled={discountBlocked}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Part cash, part UPI"
        >
          <Ionicons name="git-compare-outline" size={22} color={Colors.primary} />
          <Text style={styles.rowText}>Part cash, part UPI</Text>
          <Ionicons name="chevron-forward" size={22} color={Colors.textSecondary} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.rowBtn}
          onPress={() => setPhoneOpen((o) => !o)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Customer phone, optional, for a WhatsApp bill"
          accessibilityState={{ expanded: phoneOpen }}
        >
          <Ionicons name="logo-whatsapp" size={22} color={Colors.primary} />
          <Text style={styles.rowText}>{phone.trim() ? `Bill to ${phone.trim()}` : 'Customer phone (optional, for a WhatsApp bill)'}</Text>
          <Ionicons name={phoneOpen ? 'chevron-up' : 'chevron-forward'} size={22} color={Colors.textSecondary} />
        </TouchableOpacity>
        {phoneOpen ? (
          <TextInput
            style={styles.input}
            value={phone}
            onChangeText={(t) => setPhone(t.replace(/[^\d+ ]/g, ''))}
            keyboardType="phone-pad"
            placeholder="10-digit mobile number"
            placeholderTextColor={Colors.textLight}
            accessibilityLabel="Customer phone number"
            autoComplete="off"
          />
        ) : null}
      </>
    );
  } else if (step === 'cash') {
    const due = changeDue(total, given);
    content = (
      <>
        <Text style={styles.label}>Take this from the customer</Text>
        <Text style={styles.hero}>{formatRupees(total)}</Text>
        {discountLine}
        <Text style={styles.smallLabel}>Customer gave ₹ (optional)</Text>
        <TextInput
          style={styles.input}
          value={given}
          onChangeText={setGiven}
          keyboardType="decimal-pad"
          placeholder="e.g. 500"
          placeholderTextColor={Colors.textLight}
          accessibilityLabel="Customer gave, in rupees"
        />
        {due != null && due >= 0 ? (
          <View style={styles.changeBox}>
            <Text style={styles.changeLabel}>Give back</Text>
            <Text style={styles.changeAmount}>{formatRupees(due)}</Text>
          </View>
        ) : null}
        {due != null && due < 0 ? (
          <View style={styles.warnBox}>
            <Ionicons name="alert-circle" size={22} color={Colors.warning} />
            <Text style={styles.errorText}>{`That's ${formatRupees(-due)} short. Take ${formatRupees(total)}.`}</Text>
          </View>
        ) : null}
        {errorBox}
        {primary('Done', payCash)}
        {backBtn()}
      </>
    );
  } else if (step === 'upi' || step === 'split') {
    const split = step === 'split' ? splitPayments(total, splitCash) : null;
    const upiAmount = step === 'split' ? (split.payments ? split.payments[1].amount : null) : total;
    content = (
      <>
        {step === 'split' ? (
          <>
            <Text style={styles.label}>Total {formatRupees(total)}</Text>
            <Text style={styles.smallLabel}>Cash part ₹</Text>
            <TextInput
              style={styles.input}
              value={splitCash}
              onChangeText={(t) => { setSplitCash(t); if (error) setError(null); }}
              keyboardType="decimal-pad"
              placeholder="e.g. 500"
              placeholderTextColor={Colors.textLight}
              autoFocus
              accessibilityLabel="Cash part, in rupees"
            />
            <Text style={styles.label}>UPI part</Text>
            <Text style={styles.heroSmall}>{upiAmount != null ? formatRupees(upiAmount) : '—'}</Text>
          </>
        ) : (
          <>
            <Text style={styles.label}>Ask the customer to scan and pay</Text>
            <Text style={styles.hero}>{formatRupees(total)}</Text>
            {discountLine}
          </>
        )}
        {qrUrl ? (
          <View style={styles.qrWrap}>
            <Image
              source={{ uri: qrUrl }}
              style={styles.qr}
              resizeMode="contain"
              accessibilityLabel="The shop's UPI QR code"
            />
          </View>
        ) : (
          <View style={styles.warnBox}>
            <Ionicons name="information-circle" size={22} color={Colors.warning} />
            <Text style={styles.errorText}>{NO_QR}</Text>
          </View>
        )}
        <Text style={styles.smallLabel}>UPI reference (optional)</Text>
        <TextInput
          style={styles.input}
          value={upiRef}
          onChangeText={setUpiRef}
          placeholder="Last digits from the customer's screen"
          placeholderTextColor={Colors.textLight}
          autoCapitalize="characters"
          maxLength={64}
          accessibilityLabel="UPI reference, optional"
        />
        {errorBox}
        {primary('Customer has paid', step === 'split' ? paySplit : payUpi)}
        {backBtn()}
      </>
    );
  } else if (step === 'override') {
    content = (
      <OverridePad
        discountText={discountLabel(discount)}
        busy={saving}
        error={overrideError}
        onApprove={approve}
        onCancel={() => { setOverrideError(''); setError(null); setStep('choose'); }}
      />
    );
  } else if (step === 'success') {
    const savedTotal = Number(sale?.grand_total) || 0;
    const askedTotal = basketTotal(basketAtSave.current || [], discount).total;
    content = (
      <>
        <View style={styles.tick}><Ionicons name="checkmark" size={72} color={Colors.white} /></View>
        <Text style={styles.successTitle}>{`${formatRupees(savedTotal)} collected · ${methodsText(sale) || 'Cash'}`}</Text>
        {sale?.sale_number ? <Text style={styles.successSub}>{`Bill ${sale.sale_number}`}</Text> : null}
        {duplicate && Math.round(savedTotal * 100) !== Math.round(askedTotal * 100) ? (
          <View style={styles.warnBox}>
            <Ionicons name="information-circle" size={22} color={Colors.warning} />
            <Text style={styles.errorText}>
              {`This basket was already saved earlier for ${formatRupees(savedTotal)}. Ask the counter to check it.`}
            </Text>
          </View>
        ) : null}
        <View style={styles.shareRow}>
          <TouchableOpacity style={styles.shareBtn} onPress={shareBill} accessibilityRole="button" accessibilityLabel="Share bill on WhatsApp">
            <Ionicons name="logo-whatsapp" size={22} color={Colors.primary} />
            <Text style={styles.shareText}>Share bill on WhatsApp</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.shareBtn} onPress={printBill} accessibilityRole="button" accessibilityLabel="Print the bill">
            <Ionicons name="print-outline" size={22} color={Colors.primary} />
            <Text style={styles.shareText}>Print</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          style={styles.primary}
          onPress={onNextCustomer}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Next customer"
        >
          <Ionicons name="arrow-forward-circle" size={28} color={Colors.white} />
          <Text style={styles.primaryText}>Next customer</Text>
        </TouchableOpacity>
        {autoLeft != null ? (
          <Text style={styles.autoText}>{`Starts by itself in ${Math.max(autoLeft, 0)}…`}</Text>
        ) : null}
      </>
    );
  }

  const titles = {
    choose: 'Take payment', cash: 'Cash', upi: 'UPI', split: 'Part cash, part UPI', override: 'Discount OK', success: 'Done',
  };
  const canClose = !saving && step !== 'success';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={() => { if (step === 'success') onNextCustomer(); else if (canClose) onClose(); }}>
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.header, { paddingTop: Math.max(insets.top, Spacing.sm) }]}>
          <Text style={styles.title}>{titles[step]}</Text>
          {step === 'choose' ? (
            <TouchableOpacity
              style={styles.closeBtn}
              onPress={onClose}
              disabled={!canClose}
              accessibilityRole="button"
              accessibilityLabel="Back to the basket"
            >
              <Ionicons name="arrow-back" size={22} color={Colors.text} />
              <Text style={styles.closeText}>Basket</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <ScrollView
          contentContainerStyle={[styles.body, { paddingBottom: Math.max(insets.bottom, Spacing.lg) + Spacing.lg }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.column}>{content}</View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.md, paddingBottom: Spacing.sm, backgroundColor: Colors.surface,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  title: { fontSize: FontSize.xl, fontWeight: '700', color: Colors.text },
  closeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 48, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border,
  },
  closeText: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  body: { padding: Spacing.md },
  column: { width: '100%', maxWidth: 520, alignSelf: 'center' },
  label: { fontSize: FontSize.md, fontWeight: '600', color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.sm },
  smallLabel: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, marginTop: Spacing.md, marginBottom: Spacing.xs },
  hero: { fontSize: FontSize.hero, fontWeight: '800', color: Colors.text, textAlign: 'center', fontVariant: ['tabular-nums'] },
  heroSmall: { fontSize: FontSize.xxl, fontWeight: '800', color: Colors.text, textAlign: 'center', fontVariant: ['tabular-nums'] },
  discountLine: { fontSize: FontSize.md, color: Colors.success, fontWeight: '700', textAlign: 'center', marginBottom: Spacing.sm },
  rowBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 56, paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.md, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, marginTop: Spacing.sm,
  },
  rowText: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  discountBox: { backgroundColor: Colors.surface, borderRadius: BorderRadius.md, padding: Spacing.md, marginTop: Spacing.xs, borderWidth: 1, borderColor: Colors.border },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    minHeight: 48, minWidth: 72, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.full,
    borderWidth: 2, borderColor: Colors.primary, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surface,
  },
  chipOn: { backgroundColor: Colors.primary },
  chipText: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.primaryDark },
  chipTextOn: { color: Colors.white },
  otherRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  toggle: { flexDirection: 'row', borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, overflow: 'hidden' },
  toggleBtn: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surface },
  toggleOn: { backgroundColor: Colors.primary },
  toggleText: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  toggleTextOn: { color: Colors.white },
  otherInput: {
    flex: 1, minWidth: 60, minHeight: 48, borderWidth: 1, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm, fontSize: FontSize.lg, color: Colors.text, backgroundColor: Colors.background,
  },
  applyBtn: { minHeight: 48, paddingHorizontal: Spacing.md, borderRadius: BorderRadius.md, backgroundColor: Colors.primary, justifyContent: 'center' },
  applyText: { color: Colors.white, fontSize: FontSize.md, fontWeight: '700' },
  methods: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.md },
  methodBtn: {
    flex: 1, minHeight: 104, borderRadius: BorderRadius.lg, backgroundColor: Colors.secondaryDark,
    alignItems: 'center', justifyContent: 'center', gap: Spacing.xs, ...Shadows.sm,
  },
  methodUpi: { backgroundColor: Colors.info },
  methodText: { color: Colors.white, fontSize: FontSize.xl, fontWeight: '800', letterSpacing: 1 },
  input: {
    minHeight: 56, borderWidth: 2, borderColor: Colors.border, borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md, fontSize: FontSize.lg, color: Colors.text, backgroundColor: Colors.surface,
    marginTop: Spacing.xs, fontVariant: ['tabular-nums'],
  },
  changeBox: {
    marginTop: Spacing.md, padding: Spacing.md, borderRadius: BorderRadius.md, backgroundColor: Colors.successLight,
    alignItems: 'center',
  },
  changeLabel: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  changeAmount: { fontSize: FontSize.xxl, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] },
  qrWrap: { alignItems: 'center', marginVertical: Spacing.md },
  qr: { width: 300, height: 300, maxWidth: '100%', backgroundColor: Colors.white, borderRadius: BorderRadius.md },
  errorBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm, backgroundColor: Colors.errorLight,
    borderRadius: BorderRadius.md, padding: Spacing.md, marginTop: Spacing.md,
  },
  warnBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm, backgroundColor: Colors.warningLight,
    borderRadius: BorderRadius.md, padding: Spacing.md, marginTop: Spacing.md,
  },
  errorText: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.text, lineHeight: 22 },
  primary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    minHeight: 64, borderRadius: BorderRadius.md, backgroundColor: Colors.primary, marginTop: Spacing.lg, ...Shadows.sm,
  },
  disabled: { opacity: 0.5 },
  primaryText: { color: Colors.white, fontSize: FontSize.lg, fontWeight: '800' },
  secondary: {
    minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: Spacing.sm,
    borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface,
  },
  secondaryText: { color: Colors.textSecondary, fontSize: FontSize.lg, fontWeight: '600' },
  tick: {
    width: 120, height: 120, borderRadius: BorderRadius.full, backgroundColor: Colors.success,
    alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginTop: Spacing.lg,
  },
  successTitle: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, textAlign: 'center', marginTop: Spacing.md },
  successSub: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.xs },
  shareRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.lg },
  shareBtn: {
    flexGrow: 1, flexBasis: 160, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    minHeight: 56, borderRadius: BorderRadius.md, borderWidth: 2, borderColor: Colors.primary, backgroundColor: Colors.surface,
  },
  shareText: { color: Colors.primary, fontSize: FontSize.md, fontWeight: '700' },
  autoText: { fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.sm },
});
