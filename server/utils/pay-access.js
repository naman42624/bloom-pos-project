// Every route that returns salary, payroll or advance data must use this file,
// and must be added to the route list in scripts/verify-pay-access.js.
//
// Owner sees all pay. A manager sees their own plus the employees the owner
// switched on for them (pay_viewers). Everyone else sees only their own.
// Reads pay_viewers fresh on every call, never cached.

async function payVisibleIds(db, viewer) {
  if (viewer.role === 'owner') return 'all';
  const own = Number(viewer.id);
  if (viewer.role !== 'manager') return [own];
  const rows = await db.prepare('SELECT employee_id FROM pay_viewers WHERE manager_id = ?').all(own);
  const ids = [own];
  for (const r of rows) {
    const n = Number(r.employee_id);
    if (!ids.includes(n)) ids.push(n);
  }
  return ids;
}

async function canSeePay(db, viewer, employeeId) {
  const visible = await payVisibleIds(db, viewer);
  return visible === 'all' || visible.includes(Number(employeeId));
}

// Extra WHERE text for a query over expenses (or similar) rows: salary rows
// only for visible people. Placeholders ? with params in the same order.
function salarySqlFilter(visible, alias = 'e') {
  if (visible === 'all') return { sql: '', params: [] };
  if (!visible.length) return { sql: ` AND ${alias}.category <> 'salary'`, params: [] };
  return {
    sql: ` AND (${alias}.category <> 'salary' OR ${alias}.employee_id IN (${visible.map(() => '?').join(',')}))`,
    params: visible.map(Number),
  };
}

module.exports = { payVisibleIds, canSeePay, salarySqlFilter };
