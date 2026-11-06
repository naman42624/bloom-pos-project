/**
 * Global error handling middleware
 */
function errorHandler(err, req, res, _next) {
  console.error('Error:', err.message);
  console.error('Stack:', err.stack);

  const statusCode = err.statusCode || 500;
  const message =
    process.env.NODE_ENV === 'production' && statusCode === 500
      ? 'Internal server error'
      : err.message;

  res.status(statusCode).json({
    success: false,
    message,
    // A machine-readable reason the app can act on (e.g. DISCOUNT_NEEDS_OK
    // shows "Ask a manager"). Only set on deliberate, non-500 errors.
    ...(err.code && statusCode !== 500 && typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code) && { code: err.code }),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

/**
 * 404 handler for unmatched routes
 */
function notFound(req, res) {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
}

module.exports = { errorHandler, notFound };
