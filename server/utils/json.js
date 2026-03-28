function safeParseJSON(val, fallback = []) {
  if (!val) return fallback;
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed === null ? fallback : parsed;
  } catch (e) {
    console.error("JSON Parse Error:", e.message, "Value:", val);
    return fallback;
  }
}

module.exports = {
  safeParseJSON,
};
