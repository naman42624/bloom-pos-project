// Who can be recorded as the seller of a sale.
const SELLER_ROLES = ['owner', 'manager', 'employee', 'counter_staff', 'florist_staff', 'helper'];
const SELLER_INVALID_MESSAGE = "That person can't be picked as the seller.";

// db is the sync db object (db.prepare(sql).get(...)). Throws a 400 error when
// the person cannot be the seller; returns nothing when fine.
function assertValidSeller(db, sellerId, locationId) {
  const fail = () => {
    const err = new Error(SELLER_INVALID_MESSAGE);
    err.statusCode = 400;
    throw err;
  };
  const id = Number(sellerId);
  if (!Number.isInteger(id) || id <= 0) fail();
  const user = db.prepare('SELECT id, role, is_active FROM users WHERE id = ?').get(id);
  if (!user || !Number(user.is_active) || !SELLER_ROLES.includes(user.role)) fail();
  if (user.role === 'owner') return;
  const link = db.prepare('SELECT 1 AS ok FROM user_locations WHERE user_id = ? AND location_id = ?').get(id, locationId);
  if (!link) fail();
}

module.exports = { assertValidSeller, SELLER_ROLES, SELLER_INVALID_MESSAGE };
