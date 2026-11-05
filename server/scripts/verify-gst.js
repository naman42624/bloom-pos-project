#!/usr/bin/env node
/**
 * GST bill maths (utils/gst.js). No server or database needed.
 * Also checks that app/src/utils/gst.js is the same file.
 */
const fs = require('fs');
const path = require('path');
const { computeBill, splitInclusive, shareOut, amountInWords } = require('../utils/gst');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); pass += 1; } catch (e) { console.log(`FAIL ${name}\n   ${e.message}`); fail += 1; }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

check('app copy is the same file', () => {
  const server = fs.readFileSync(path.join(__dirname, '../utils/gst.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../app/src/utils/gst.js'), 'utf8');
  eq(app === server, true, 'app/src/utils/gst.js differs from server/utils/gst.js');
});

check('a 5% item at ₹105: taxable 100, CGST 2.50, SGST 2.50', () => {
  const b = computeBill([{ unitPrice: 105, qty: 1, taxRate: 5 }]);
  eq([b.taxableP, b.cgstP, b.sgstP, b.payableP, b.roundOffP], [10000, 250, 250, 10500, 0], 'split');
});

check('a 0% item still has a tax line of 0', () => {
  const b = computeBill([{ unitPrice: 250, qty: 2, taxRate: 0 }]);
  eq([b.taxableP, b.taxP, b.taxByRate.length, b.taxByRate[0].rate], [50000, 0, 1, 0], 'zero rate');
});

check('10% off ₹105 at 5%: pay ₹94.50 -> round to ₹95 (round-off +0.50), GST on ₹94.50', () => {
  const b = computeBill([{ unitPrice: 105, qty: 1, taxRate: 5 }], { type: 'percentage', value: 10 });
  eq([b.discountP, b.itemsNetP, b.taxableP, b.taxP, b.totalP, b.roundOffP, b.payableP], [1050, 9450, 9000, 450, 9450, 50, 9500], 'discount');
});

check('a fixed discount is shared over the lines by value and adds up exactly', () => {
  const b = computeBill([
    { unitPrice: 100, qty: 1, taxRate: 0 },
    { unitPrice: 200, qty: 1, taxRate: 5 },
    { unitPrice: 33.33, qty: 3, taxRate: 18 },
  ], { type: 'fixed', value: 50 });
  eq(b.lines.reduce((t, l) => t + l.discountP, 0), 5000, 'discount sum');
  b.lines.forEach((l) => { if (l.taxableP + l.taxP !== l.netP) throw new Error('line split'); });
});

check('a discount bigger than the items is an error', () => {
  const b = computeBill([{ unitPrice: 50, qty: 1, taxRate: 0 }], { type: 'fixed', value: 60 });
  eq(b.error, "The discount can't be more than the price.", 'error');
  eq(computeBill([{ unitPrice: 50, qty: 1, taxRate: 0 }], { type: 'percentage', value: 101 }).error, "The discount can't be more than the price.", 'pct');
});

check('delivery includes GST at its own rate and is never discounted', () => {
  const b = computeBill([{ unitPrice: 500, qty: 1, taxRate: 0 }], { type: 'percentage', value: 10 }, { amount: 118, taxRate: 18 });
  eq([b.discountP, b.delivery.taxableP, b.delivery.taxP, b.totalP], [5000, 10000, 1800, 56800], 'delivery');
  eq(b.taxByRate.map((r) => r.rate), [0, 18], 'rates');
});

check('round-off can be turned off', () => {
  const b = computeBill([{ unitPrice: 45.5, qty: 1, taxRate: 0 }], null, null, { roundOff: false });
  eq([b.payableP, b.roundOffP], [4550, 0], 'no round');
  const r = computeBill([{ unitPrice: 45.5, qty: 1, taxRate: 0 }]);
  eq([r.payableP, r.roundOffP], [4600, 50], 'round half up');
  const d = computeBill([{ unitPrice: 45.49, qty: 1, taxRate: 0 }]);
  eq([d.payableP, d.roundOffP], [4500, -49], 'round down');
});

check('shareOut and splitInclusive add up', () => {
  eq(shareOut(100, [1, 1, 1]), [34, 33, 33], 'thirds');
  const s = splitInclusive(14900, 5);
  eq([s.taxableP, s.cgstP, s.sgstP], [14190, 355, 355], 'blinkit-like');
});

check('2000 random baskets always add up to the paisa', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const rates = [0, 5, 12, 18, 28];
  for (let n = 0; n < 2000; n += 1) {
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => ({
      unitPrice: Math.round(rnd() * 200000) / 100, qty: 1 + Math.floor(rnd() * 6), taxRate: rates[Math.floor(rnd() * 5)],
    }));
    const gross = lines.reduce((t, l) => t + Math.round(l.unitPrice * 100) * l.qty, 0);
    const discount = rnd() < 0.5 ? { type: 'percentage', value: Math.floor(rnd() * 40) } : { type: 'fixed', value: Math.floor(rnd() * gross / 100) };
    const delivery = rnd() < 0.4 ? { amount: Math.floor(rnd() * 300), taxRate: rates[Math.floor(rnd() * 5)] } : null;
    const b = computeBill(lines, discount, delivery);
    if (b.error) throw new Error(`unexpected error ${b.error} ${JSON.stringify({ lines, discount })}`);
    const netSum = b.lines.reduce((t, l) => t + l.netP, 0);
    if (netSum !== b.itemsNetP || b.itemsNetP !== b.itemsGrossP - b.discountP) throw new Error('net');
    if (b.taxableP + b.taxP !== b.totalP) throw new Error(`taxable+tax ${b.taxableP}+${b.taxP} vs ${b.totalP}`);
    if (b.cgstP + b.sgstP !== b.taxP) throw new Error('cgst+sgst');
    if (Math.abs(b.roundOffP) > 50 || b.payableP % 100 !== 0) throw new Error('round');
    const byRateTotal = b.taxByRate.reduce((t, r) => t + r.taxableP + r.taxP, 0);
    if (byRateTotal !== b.totalP) throw new Error('by rate');
  }
});

check('amount in words', () => {
  eq(amountInWords(192), 'Rupees One Hundred Ninety Two Only', '192');
  eq(amountInWords(125050.5), 'Rupees One Lakh Twenty Five Thousand Fifty and Fifty Paise Only', 'lakh');
  eq(amountInWords(0), 'Rupees Zero Only', 'zero');
});

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
