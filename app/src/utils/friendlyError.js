/**
 * Plain-language error text (2026-11-06, D45).
 *
 * services/api.js passes every failed request through friendlyMessage(), so
 * staff never see "Invalid token.", "Validation failed", "Internal server
 * error" or "Route POST /api/x not found". Each message says what happened
 * and what to do next.
 *
 * Only known technical messages are replaced. A deliberate, already-plain
 * server message ("Register isn't open ...", "Your access ended on ...") is
 * passed through unchanged, because some screens match on those exact words.
 * The original text stays on the error as raw_message for logs.
 */

export const NETWORK_MESSAGE =
  "Couldn't reach the shop's system. Check the internet connection, then tap again.";
export const SERVER_MESSAGE =
  'Something went wrong on our side. Check whether it saved, then try again. If it keeps happening, tell the owner.';
const SERVER_NEXT_STEP = 'Check whether it saved, then try again. If it keeps happening, tell the owner.';
export const LOGIN_ENDED_MESSAGE =
  'Your login has ended. Log in again, then try once more.';
export const NO_PERMISSION_MESSAGE =
  "Your account isn't allowed to do this. Ask a manager or the owner to do it.";
export const OLD_APP_MESSAGE =
  'This needs a newer version of the app. Close the app and open it again. If that does not help, tell the owner.';
export const TOO_BIG_MESSAGE =
  'That file is too big. Pick a smaller photo or a shorter recording.';
export const TOO_MANY_MESSAGE =
  'Too many tries in a short time. Wait a minute, then try again.';

// Field names as staff would say them. Anything not listed is turned into
// words ("delivery_address" -> "delivery address").
const FIELD_WORDS = {
  name: 'name',
  phone: 'phone number',
  email: 'email',
  password: 'password',
  pin: 'PIN',
  employee_code: 'employee code',
  location_id: 'shop',
  to_location_id: 'shop it goes to',
  from_location_id: 'shop it comes from',
  amount: 'amount',
  quantity: 'quantity',
  items: 'items',
  'items.quantity': 'item quantity',
  'items.product_id': 'item',
  'items.unit_price': 'item price',
  payments: 'payment',
  'payments.amount': 'payment amount',
  'payments.method': 'payment method',
  method: 'payment method',
  payment_method: 'payment method',
  write_off_amount: 'write-off amount',
  selling_price: 'selling price',
  cost_per_unit: 'cost',
  sku: 'SKU',
  gst_number: 'GSTIN',
  tax_rate_id: 'GST rate',
  tax_percentage: 'GST %',
  category: 'category',
  category_id: 'category',
  material_id: 'material',
  supplier_id: 'supplier',
  delivery_address: 'delivery address',
  sender_phone: "sender's phone number",
  sender_name: "sender's name",
  receiver_phone: "receiver's phone number",
  receiver_name: "receiver's name",
  customer_phone: "customer's phone number",
  customer_name: "customer's name",
  scheduled_date: 'date',
  scheduled_time: 'time',
  expense_date: 'date',
  actual_cash: 'counted cash',
  opening_balance: 'opening cash',
  pincode: 'PIN code',
  reason: 'reason',
  role: 'role',
  access_until: 'last working day',
  date: 'date',
};

// "items[0].quantity" / "items.*.quantity" -> "items.quantity"
function fieldKey(path) {
  return String(path || '').replace(/\[\d+\]/g, '').replace(/\.\*\./g, '.').replace(/\.\d+\./g, '.');
}

export function fieldLabel(path) {
  const key = fieldKey(path);
  if (FIELD_WORDS[key]) return FIELD_WORDS[key];
  const last = key.split('.').pop();
  if (FIELD_WORDS[last]) return FIELD_WORDS[last];
  return key.replace(/[._]+/g, ' ').replace(/\bid\b/g, '').replace(/\s+/g, ' ').trim() || 'details';
}

// express-validator's own default texts: they name no field and no fix
const VALIDATOR_DEFAULTS = /^(invalid value|invalid value\(s\)|invalid|required)$/i;

function validationMessage(errors) {
  const list = Array.isArray(errors) ? errors.filter(Boolean) : [];
  if (list.length === 0) return 'Some details are missing or wrong. Check the form and try again.';
  const lines = [];
  const seen = new Set();
  for (const e of list) {
    const path = e.path || e.param || '';
    const msg = String(e.msg || '').trim();
    const line = !msg || VALIDATOR_DEFAULTS.test(msg)
      ? `Check the ${fieldLabel(path)}.`
      : (/[.!?]$/.test(msg) ? msg : `${msg}.`);
    if (!seen.has(line)) { seen.add(line); lines.push(line); }
    if (lines.length === 3) break;
  }
  return lines.join('\n');
}

const LOGIN_ENDED = /^(invalid token\.?|token has expired\..*|access denied\. no token provided\.?|authentication required\.?|jwt (expired|malformed)|user no longer exists\.?)$/i;
const NO_PERMISSION = /^you do not have permission to perform this action\.?$/i;
const SERVER_TEXT = /^(internal server error|something went wrong|server error)\.?$/i;
const ROUTE_MISSING = /^Route [A-Z]+ \S+ not found$/;
// Database / code errors that reach the app in development builds
const TECHNICAL = /(violates|constraint|column ".*" |relation ".*"|syntax error|ECONN|SQLITE|psql|TypeError|ReferenceError|Cannot read propert|undefined is not|is not a function|duplicate key|invalid input syntax|null value in column)/i;

/**
 * err: { status, message, errors, code }. Returns the text to show staff.
 */
export function friendlyMessage(err) {
  const status = Number(err && err.status) || 0;
  const message = String((err && err.message) || '').trim();

  if (status === 0) return NETWORK_MESSAGE;
  if (message === 'Validation failed') return validationMessage(err.errors);
  if (status === 401 && LOGIN_ENDED.test(message)) return LOGIN_ENDED_MESSAGE;
  if (status === 403 && NO_PERMISSION.test(message)) return NO_PERMISSION_MESSAGE;
  if (status === 404 && ROUTE_MISSING.test(message)) return OLD_APP_MESSAGE;
  if (status === 413) return TOO_BIG_MESSAGE;
  if (status === 429 && (!message || SERVER_TEXT.test(message) || /too many requests/i.test(message))) return TOO_MANY_MESSAGE;
  if (!message || SERVER_TEXT.test(message) || TECHNICAL.test(message)) return SERVER_MESSAGE;
  // A short "Failed to clock in." from the server: keep what failed, add the next step
  if (status >= 500) return `${/[.!?]$/.test(message) ? message : `${message}.`} ${SERVER_NEXT_STEP}`;
  return message;
}
