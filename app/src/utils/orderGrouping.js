// Pure grouping logic for the Orders Inbox SectionList — no React/RN/api
// dependency, so it's directly requireable from a plain Node assert script
// (app/scripts/verify-order-grouping.js), matching the established pattern
// in app/src/utils/registerSessions.js and app/src/utils/contact.js.
// See docs/superpowers/specs/2026-09-09-orders-inbox-redesign-design.md §2.
const { extractShopDateKey, formatShopDateLabel } = require('./datetime');
const { matchSessionLabel } = require('./registerSessions');

function getSingleLocationId(orders) {
  if (!orders || orders.length === 0) return null;
  const first = orders[0].location_id;
  for (const o of orders) {
    if (o.location_id !== first) return null;
  }
  return first ?? null;
}

function groupOrdersByDay(orders) {
  const groups = [];
  const byKey = new Map();
  for (const order of orders || []) {
    const dateKey = extractShopDateKey(order.created_at);
    let group = byKey.get(dateKey);
    if (!group) {
      group = { dateKey, dateLabel: dateKey ? formatShopDateLabel(order.created_at) : '', orders: [] };
      byKey.set(dateKey, group);
      groups.push(group);
    }
    group.orders.push(order);
  }
  return groups;
}

function groupOrdersBySession(dayOrders, sessions) {
  const groups = [];
  const byLabel = new Map();
  for (const order of dayOrders || []) {
    const sessionLabel = matchSessionLabel(sessions, order.created_at);
    let group = byLabel.get(sessionLabel);
    if (!group) {
      group = { sessionLabel, orders: [] };
      byLabel.set(sessionLabel, group);
      groups.push(group);
    }
    group.orders.push(order);
  }
  return groups;
}

function sumGrandTotal(orders) {
  return (orders || []).reduce((sum, o) => sum + (Number(o.grand_total) || 0), 0);
}

module.exports = { getSingleLocationId, groupOrdersByDay, groupOrdersBySession, sumGrandTotal };
