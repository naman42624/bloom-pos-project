// Short, permanent scan codes for product labels. Once set, a code never changes.
const crypto = require('crypto');
const { PUBLIC_APP_URL } = require('./public-url');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function generateLabelCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

function labelUrl(code) {
  return `${PUBLIC_APP_URL}/p/${code}`;
}

// db: async layer handle (prepare().get/run). Returns the existing code, or sets one.
// The UPDATE only writes when label_code IS NULL, so parallel callers converge on
// whichever code landed first; a unique violation on a random clash retries.
async function ensureLabelCode(db, productId, gen = generateLabelCode) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await db.prepare('SELECT label_code FROM products WHERE id = ?').get(productId);
    if (!row) throw new Error('Product not found');
    if (row.label_code) return row.label_code;
    try {
      await db.prepare('UPDATE products SET label_code = ? WHERE id = ? AND label_code IS NULL')
        .run(gen(), productId);
    } catch (err) {
      // database-async rethrows a plain Error, so .code is lost: match the message too
      if (err && (err.code === '23505' || /duplicate key|idx_products_label_code/i.test(err.message || ''))) continue;
      throw err;
    }
    const after = await db.prepare('SELECT label_code FROM products WHERE id = ?').get(productId);
    if (after && after.label_code) return after.label_code;
  }
  throw new Error('Could not assign a label code');
}

module.exports = { ALPHABET, CODE_LENGTH, generateLabelCode, ensureLabelCode, labelUrl };
