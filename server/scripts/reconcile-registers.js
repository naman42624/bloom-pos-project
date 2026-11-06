#!/usr/bin/env node
/**
 * Read-only register check (2026-11-05). Recomputes every closed register
 * session with the same calculation close uses (utils/register-close.js),
 * bounded to that session's own open-to-close window, and lists the sessions
 * whose saved figures disagree. Writes nothing: everything runs in one
 * READ ONLY transaction.
 *
 * Usage:
 *   node scripts/reconcile-registers.js                 all closed sessions
 *   node scripts/reconcile-registers.js --location 4    one shop
 *   node scripts/reconcile-registers.js --since 2026-10-01
 *   node scripts/reconcile-registers.js --open          also show the open session(s)
 *
 * A difference does not always mean money is missing: sessions closed before
 * a fix (for example the past-day refund fix, 2026-11-05) were saved with the
 * old maths. Read the reason column, then look at the session.
 */
require('dotenv').config();
const { withMoneyTx, closeDb } = require('../config/database-async');
const { computeRegisterClose, computeShutTimePayments } = require('../utils/register-close');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const locationId = opt('--location') ? Number(opt('--location')) : null;
const since = opt('--since');
const showOpen = args.includes('--open');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rupees = (n) => `₹${r2(n).toFixed(2)}`;

(async () => {
  const rows = await withMoneyTx(async (tx) => {
    await tx.prepare('SET TRANSACTION READ ONLY').run();
    const where = ['1=1'];
    const params = [];
    if (locationId) { where.push('cr.location_id = ?'); params.push(locationId); }
    if (since) { where.push('cr.opened_at >= ?'); params.push(since); }
    if (!showOpen) where.push('cr.closed_at IS NOT NULL');
    const sessions = await tx.prepare(`
      SELECT cr.*, l.name AS location_name
      FROM cash_registers cr LEFT JOIN locations l ON l.id = cr.location_id
      WHERE ${where.join(' AND ')}
      ORDER BY cr.location_id, cr.id
    `).all(...params);

    const out = [];
    for (const reg of sessions) {
      const until = reg.closed_at || null;
      const calc = await computeRegisterClose(tx, reg, reg.location_id, { until });
      const shut = await computeShutTimePayments(tx, reg, reg.location_id);
      const diffs = [];
      const cmp = (label, saved, now) => {
        if (Math.abs(r2(saved) - r2(now)) >= 0.01) diffs.push(`${label} saved ${rupees(saved)} now ${rupees(now)}`);
      };
      cmp('expected cash', reg.expected_cash, calc.expectedCash);
      cmp('cash sales', reg.total_cash_sales, calc.paymentTotals.cash_total);
      cmp('UPI', reg.total_upi_sales, calc.paymentTotals.upi_total);
      cmp('card', reg.total_card_sales, calc.paymentTotals.card_total);
      cmp('cash refunds', reg.total_refunds_cash, calc.refundTotal);
      // Past-day refunds that were also saved as an expense (the old double count)
      const dup = await tx.prepare(`
        SELECT COUNT(*) AS n, COALESCE(SUM(e.amount), 0) AS total FROM expenses e
        WHERE e.register_id IS NULL AND e.location_id = ? AND e.description LIKE 'Refund for past sale %'
          AND e.created_at >= ? AND (? IS NULL OR e.created_at < ?)
      `).get(reg.location_id, reg.opening_time || reg.opened_at, until, until);
      out.push({ reg, calc, shut, diffs, dup });
    }
    return out;
  });

  let bad = 0;
  for (const { reg, calc, shut, diffs, dup } of rows) {
    const label = `#${reg.id} ${reg.location_name || 'shop ' + reg.location_id} ${String(reg.opened_at).slice(0, 16)}${reg.closed_at ? ' to ' + String(reg.closed_at).slice(0, 16) : ' (open)'}`;
    const notes = [];
    if (Number(dup.n) > 0) notes.push(`${dup.n} old past-day refund expense row(s) ${rupees(dup.total)}, now left out of the maths`);
    if (shut.upi > 0 || shut.card > 0) notes.push(`taken while shut before this session: UPI ${rupees(shut.upi)}, card ${rupees(shut.card)}`);
    if (diffs.length === 0) {
      if (notes.length) console.log(`OK    ${label} | ${notes.join('; ')}`);
      continue;
    }
    bad += 1;
    console.log(`DIFF  ${label}`);
    for (const d of diffs) console.log(`        ${d}`);
    if (reg.closed_at) console.log(`        counted ${rupees(reg.actual_cash)}; saved difference ${rupees(reg.discrepancy)}; recomputed difference ${rupees(calc.expectedCash - Number(reg.actual_cash || 0))}`);
    for (const n of notes) console.log(`        note: ${n}`);
  }
  console.log(`\n${rows.length} session(s) checked, ${bad} with a difference. Nothing was changed.`);
  await closeDb();
  process.exit(0);
})().catch(async (err) => {
  console.error('reconcile failed:', err.message);
  try { await closeDb(); } catch (_) { /* ignore */ }
  process.exit(1);
});
