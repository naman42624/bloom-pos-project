// Write-off limits, kept the same as server/utils/write-off.js: never more
// than is still due, and counter staff / employees at most ₹10 (rounding,
// small change). Owner and manager: up to what is due.
export const STAFF_WRITE_OFF_MAX = 10;

export function writeOffLimitFor(role) {
  return role === 'owner' || role === 'manager' ? null : STAFF_WRITE_OFF_MAX;
}

export function writeOffLabel(role) {
  const max = writeOffLimitFor(role);
  return max == null ? 'Write-off Amount (Optional)' : `Write-off Amount (Optional, up to ₹${max})`;
}

// '' when allowed, else what to do next
export function writeOffProblem(role, amount) {
  const max = writeOffLimitFor(role);
  if (max != null && Number(amount) > max + 0.001) {
    return `You can write off up to ₹${max}. Take the money, or ask a manager or the owner.`;
  }
  return '';
}
