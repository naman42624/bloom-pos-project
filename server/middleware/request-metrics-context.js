const { AsyncLocalStorage } = require('async_hooks');

const requestStore = new AsyncLocalStorage();

function runWithRequest(req, fn) {
  return requestStore.run({ req }, fn);
}

function getCurrentRequest() {
  const store = requestStore.getStore();
  return store?.req || null;
}

function addDbTiming(durationMs) {
  const req = getCurrentRequest();
  if (!req) return;

  const safeDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  req.dbTime = (req.dbTime || 0) + safeDuration;
  req.queryCount = (req.queryCount || 0) + 1;
}

module.exports = {
  runWithRequest,
  getCurrentRequest,
  addDbTiming,
};