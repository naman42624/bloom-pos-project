// Pure logic for the Usual now 1-tap line (spec §4.3). No React Native
// imports, so app/scripts/test-usual-now.js can load it in plain node.
// UsualNowLine.js re-exports everything here.
import { pickDefaults, suggestionSections } from '../../utils/expenseBook';

export const UNDO_MS = 15000;
const METHOD_TEXT = { cash: 'Cash', upi: 'UPI' };
const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// state.saving: an Add is on its way (a second Add tap is ignored).
// state.bar: the Undo bar, null | { expense, text, expiresAt, undoing }.
// state.message: a server refusal of Undo still to be shown.
// state.added: item ids shown as a disabled "Added ✓" in place while the
//   bar shows and until the reload after it closes has answered, so a quick
//   second tap lands on the same, disabled button.
// state.reloadDue: the line is reloaded only once the bar has closed, so no
//   row moves under the finger meanwhile (see needsReload).
export const initialUndoState = { saving: false, bar: null, message: null, added: [], reloadDue: false };

const withAdded = (s, itemId) => {
  const list = s.added || [];
  if (itemId == null || list.includes(Number(itemId))) return list;
  return list.concat(Number(itemId));
};
// The bar closes: the line reloads. Rows stay "Added" until that reload's
// answer arrives (rows_loaded), so a tap in between cannot save a duplicate.
const closed = (s, extra) => ({ ...s, ...extra, bar: null, reloadDue: true });

export function undoReducer(state, action) {
  const s = state || initialUndoState;
  switch (action && action.type) {
    case 'add_start':
      return s.saving ? s : { ...s, saving: true };
    case 'add_done':
      // Only one bar at a time: a new add replaces the old one.
      return {
        ...s,
        saving: false,
        bar: { expense: action.expense, text: action.text, expiresAt: action.now + UNDO_MS, undoing: false },
        added: withAdded(s, action.itemId),
        reloadDue: true,
      };
    case 'mark_added':
      // Saved another way (the full sheet) while the bar shows: that row is
      // locked as added too, until the bar closes.
      if (!s.bar) return s;
      return { ...s, added: withAdded(s, action.itemId), reloadDue: true };
    case 'rows_loaded':
      // The reload answered (or failed): rows go back to normal. A newer
      // bar's rows stay locked.
      if (s.bar || !(s.added || []).length) return s;
      return { ...s, added: [] };
    case 'reload_later':
      return s.reloadDue ? s : { ...s, reloadDue: true };
    case 'reload_taken':
      return s.reloadDue ? { ...s, reloadDue: false } : s;
    case 'add_failed':
      return s.saving ? { ...s, saving: false } : s;
    case 'expire':
      // A timer from an older bar never closes a newer one, and a bar whose
      // Undo is on its way stays until the answer comes.
      if (!s.bar || s.bar.undoing || action.now < s.bar.expiresAt) return s;
      return closed(s);
    case 'undo_start':
      if (!s.bar || s.bar.undoing) return s;
      return { ...s, bar: { ...s.bar, undoing: true } };
    case 'undo_done':
      return closed(s, { message: null });
    case 'undo_failed':
      // The entry stays in the list; the bar closes and the server's plain
      // message is shown.
      return closed(s, {
        message: action.message || 'It was not removed. Check the connection, then remove it from the list.',
      });
    case 'message_shown':
      return s.message ? { ...s, message: null } : s;
    case 'dismiss':
      return s.bar ? closed(s) : s;
    default:
      return s;
  }
}

// Reload the line now: the bar has closed and a reload is owed.
export function needsReload(state) {
  return !!(state && !state.bar && state.reloadDue);
}

// What a row's button shows: 'added' (disabled "Added ✓"), 'saving'
// (an add is on its way, every button waits) or 'ready' ("+ Add").
export function rowState(state, itemId) {
  if (state && (state.added || []).includes(Number(itemId))) return 'added';
  if (state && state.saving) return 'saving';
  return 'ready';
}

// "Added Tea ₹50 · Cash"
export function undoBarText(name, amount, method) {
  return `Added ${name} ${rupees(amount)} · ${METHOD_TEXT[method] || method}`;
}

// The body + Add sends: the same as the add sheet with this item picked and
// nothing changed. null when the item has no amount to add at once (the
// row then opens the sheet instead).
export function usualNowBody(item, locationId) {
  if (!item || !item.id) return null;
  const d = pickDefaults(item);
  if (!d.amount) return null;
  const who = d.givenTo;
  const label = who ? String(who.display_name || who.name || '').trim() : '';
  const given = who && who.user_id
    ? { given_to_user_id: Number(who.user_id) }
    : who && label ? { given_to_name: label } : { given_to_user_id: null, given_to_name: null };
  const body = {
    location_id: locationId,
    item_id: Number(item.id),
    amount: Math.round(Number(d.amount) * 100) / 100,
    payment_method: d.method || 'cash',
    is_return: false,
    note: null,
    employee_id: null,
    ...given,
  };
  if (item.category) body.category = item.category;
  return body;
}

// Up to 3 Usual now rows. Salary items are never added in one tap (they
// need an employee picked; counter staff use Salary advance).
export function usualNowRows(res, max = 3) {
  return suggestionSections(res, { hideSalary: true }).usualNow.slice(0, max);
}
