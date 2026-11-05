/* GST bill maths (bill_version 2, 2026-11-05). KEEP IN SYNC: this file is
 * copied byte for byte to app/src/utils/gst.js (server/scripts/verify-gst.js
 * fails if the two differ). Pure functions, whole paise, no imports.
 *
 * Rules (owner decisions, 2026-11-05): shelf prices include GST; a discount is
 * taken off the GST-inclusive price and shared over the lines in proportion to
 * their value; GST is then worked out on what is left (taxable value =
 * amount x 100 / (100 + rate)); CGST and SGST are half each; delivery charges
 * include GST at the owner's delivery rate and are never discounted; the
 * payable total is rounded to the nearest rupee with a round-off line.
 */

function toPaise(rupees) {
  const n = Number(rupees);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function fromPaise(paise) {
  return Math.round(Number(paise) || 0) / 100;
}

function rateOf(r) {
  const n = Number(r);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Splits an amount that includes GST into taxable value and tax.
function splitInclusive(amountP, ratePct) {
  const rate = rateOf(ratePct);
  if (rate === 0 || amountP === 0) {
    return { taxableP: amountP, taxP: 0, cgstP: 0, sgstP: 0 };
  }
  const taxableP = Math.round((amountP * 100) / (100 + rate));
  const taxP = amountP - taxableP;
  const cgstP = Math.round(taxP / 2);
  return { taxableP, taxP, cgstP, sgstP: taxP - cgstP };
}

// Shares totalP over weights (largest remainder), so the parts add up exactly.
function shareOut(totalP, weights) {
  const sum = weights.reduce((t, w) => t + w, 0);
  if (sum <= 0 || totalP <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (totalP * w) / sum);
  const parts = raw.map((x) => Math.floor(x));
  let left = totalP - parts.reduce((t, p) => t + p, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
  for (let k = 0; k < order.length && left > 0; k += 1) {
    parts[order[k].i] += 1;
    left -= 1;
  }
  return parts;
}

/**
 * lines:    [{ unitPrice, qty, taxRate }]  unitPrice includes GST (rupees)
 * discount: null | { type: 'percentage' | 'fixed', value }
 * delivery: null | { amount, taxRate }    amount includes GST (rupees)
 * options:  { roundOff: true }
 *
 * Returns paise integers (suffix P) plus rupee copies of the main figures.
 * error is set (and nothing should be saved) when the discount is more than
 * the items are worth or a value is not a number.
 */
function computeBill(lines, discount, delivery, options) {
  const opts = options || {};
  const roundOff = opts.roundOff !== false;
  const rows = (lines || []).map((l) => {
    const qty = Number(l.qty);
    const unitP = toPaise(l.unitPrice);
    return { qty: Number.isFinite(qty) && qty > 0 ? qty : 0, unitP, rate: rateOf(l.taxRate) };
  });
  let error = null;
  if (rows.some((r) => r.unitP < 0)) error = 'A price can\'t be below zero.';

  const grossPs = rows.map((r) => Math.round(r.unitP * r.qty));
  const itemsGrossP = grossPs.reduce((t, g) => t + g, 0);

  let discountP = 0;
  const dv = discount ? Number(discount.value) : 0;
  if (discount && Number.isFinite(dv) && dv > 0) {
    if (discount.type === 'percentage') {
      if (dv > 100) error = error || "The discount can't be more than the price.";
      else discountP = Math.round((itemsGrossP * dv) / 100);
    } else if (discount.type === 'fixed') {
      discountP = toPaise(dv);
      if (discountP > itemsGrossP) error = error || "The discount can't be more than the price.";
    }
  }
  if (discountP > itemsGrossP) discountP = itemsGrossP;
  const lineDiscounts = shareOut(discountP, grossPs);

  const outLines = rows.map((r, i) => {
    const netP = grossPs[i] - lineDiscounts[i];
    const split = splitInclusive(netP, r.rate);
    // Taxable price of one unit before the discount (what older screens
    // called unit_price), in rupees with 4 decimals.
    const unitTaxable = r.rate > 0 ? (r.unitP * 100) / (100 + r.rate) / 100 : r.unitP / 100;
    return {
      unitP: r.unitP,
      qty: r.qty,
      taxRate: r.rate,
      grossP: grossPs[i],
      discountP: lineDiscounts[i],
      netP,
      taxableP: split.taxableP,
      taxP: split.taxP,
      cgstP: split.cgstP,
      sgstP: split.sgstP,
      unitTaxable: Math.round(unitTaxable * 10000) / 10000,
    };
  });

  const deliveryP = delivery ? Math.max(0, toPaise(delivery.amount)) : 0;
  const deliveryRate = delivery ? rateOf(delivery.taxRate) : 0;
  const del = splitInclusive(deliveryP, deliveryRate);

  const sum = (k) => outLines.reduce((t, l) => t + l[k], 0);
  const itemsNetP = itemsGrossP - discountP;
  const taxableP = sum('taxableP') + del.taxableP;
  const taxP = sum('taxP') + del.taxP;
  const cgstP = sum('cgstP') + del.cgstP;
  const sgstP = sum('sgstP') + del.sgstP;
  const totalP = itemsNetP + deliveryP;
  const payableP = roundOff ? Math.round(totalP / 100) * 100 : totalP;

  // Tax summary by rate (for the bill)
  const byRate = {};
  const addRate = (rate, t) => {
    const k = String(rate);
    if (!byRate[k]) byRate[k] = { rate, taxableP: 0, cgstP: 0, sgstP: 0, taxP: 0 };
    byRate[k].taxableP += t.taxableP;
    byRate[k].cgstP += t.cgstP;
    byRate[k].sgstP += t.sgstP;
    byRate[k].taxP += t.taxP;
  };
  outLines.forEach((l) => addRate(l.taxRate, l));
  if (deliveryP > 0) addRate(deliveryRate, del);
  const taxByRate = Object.keys(byRate).map((k) => byRate[k]).sort((a, b) => a.rate - b.rate);

  return {
    error,
    lines: outLines,
    itemsGrossP,
    discountP,
    discountPct: itemsGrossP > 0 ? (discountP * 100) / itemsGrossP : 0,
    itemsNetP,
    delivery: { amountP: deliveryP, taxRate: deliveryRate, taxableP: del.taxableP, taxP: del.taxP, cgstP: del.cgstP, sgstP: del.sgstP },
    taxableP,
    taxP,
    cgstP,
    sgstP,
    totalP,
    roundOffP: payableP - totalP,
    payableP,
    taxByRate,
    // Rupee copies of the figures screens show most
    itemsGross: fromPaise(itemsGrossP),
    discount: fromPaise(discountP),
    tax: fromPaise(taxP),
    roundOff: fromPaise(payableP - totalP),
    payable: fromPaise(payableP),
  };
}

// "Rupees One Hundred Ninety Two and Fifty Paise Only" (Indian grouping)
function amountInWords(rupees) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ''}`);
  const three = (n) => {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return [h ? `${ones[h]} Hundred` : '', r ? two(r) : ''].filter(Boolean).join(' ');
  };
  const words = (n) => {
    if (n === 0) return 'Zero';
    const parts = [];
    const crore = Math.floor(n / 10000000);
    const lakh = Math.floor((n % 10000000) / 100000);
    const thousand = Math.floor((n % 100000) / 1000);
    const rest = n % 1000;
    if (crore) parts.push(`${words(crore)} Crore`);
    if (lakh) parts.push(`${two(lakh)} Lakh`);
    if (thousand) parts.push(`${two(thousand)} Thousand`);
    if (rest) parts.push(three(rest));
    return parts.join(' ');
  };
  const p = Math.max(0, toPaise(rupees));
  const r = Math.floor(p / 100);
  const ps = p % 100;
  return `Rupees ${words(r)}${ps ? ` and ${two(ps)} Paise` : ''} Only`;
}

module.exports = { computeBill, splitInclusive, shareOut, amountInWords, toPaise, fromPaise };
