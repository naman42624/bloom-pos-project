// Helpers are refused by default: a helper token reaches only the routes
// listed here (spec 8.2). Everything else answers 403 HELPER_DENIED_MESSAGE,
// even routes that only check for a login. Add a route here only together
// with helper in its authorize() list.
const HELPER_DENIED_MESSAGE = "Helpers can't open this. Ask the counter.";

// [method, pattern on the full path (req.baseUrl + req.path), why]
const HELPER_ROUTES = [
  ['GET', /^\/api\/auth\/me\/?$/, 'session check on app start'],
  ['GET', /^\/api\/products\/?$/, 'find by name / photo grid'],
  ['GET', /^\/api\/products\/\d+\/?$/, 'product sizes and photo'],
  ['POST', /^\/api\/products\/scan\/?$/, 'scanning'],
  ['GET', /^\/api\/settings\/shop-info\/?$/, 'shop name and UPI QR'],
  ['POST', /^\/api\/sales\/?$/, 'helper sale'],
  ['GET', /^\/api\/sales\/register\/status\/?$/, 'register open hint'],
  ['POST', /^\/api\/quick-sale\/\d+\/undo\/?$/, 'undo own sale'],
  ['GET', /^\/api\/quick-sale\/my-sales\/?$/, 'own sales today'],
  ['GET', /^\/api\/helper-cash\/bags\/?$/, 'own cash bag (masked); handler returns only their own'],
  ['POST', /^\/api\/helper-cash\/bags\/\d+\/reveal\/?$/, 'own cash bag exact; handler refuses anyone else'],
];

function isHelperRouteAllowed(method, fullPath) {
  const m = String(method || '').toUpperCase();
  const p = String(fullPath || '');
  return HELPER_ROUTES.some(([routeMethod, pattern]) => routeMethod === m && pattern.test(p));
}

module.exports = { HELPER_ROUTES, HELPER_DENIED_MESSAGE, isHelperRouteAllowed };
