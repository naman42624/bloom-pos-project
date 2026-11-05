// One id per tap of a money action (float, handover). Sent with the request
// and reused if the same action is tried again, so the server can tell a
// repeat (lost response, second tap) from a new action and never moves the
// cash twice. Letters, digits, - and _ only, 8 to 64 long (server rule).
export function newRequestId() {
  const rand = Math.random().toString(36).slice(2, 12);
  return `r${Date.now().toString(36)}${rand}`.slice(0, 40);
}
