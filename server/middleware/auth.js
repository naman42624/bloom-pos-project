const jwt = require('jsonwebtoken');
const { getDb } = require('../config/database');

/**
 * Authentication middleware - verifies JWT token and attaches user to request
 */
function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.',
      });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch full user to ensure they still exist and are active
    const db = getDb();
    const user = db
      .prepare('SELECT id, phone, email, name, role, is_active FROM users WHERE id = ?')
      .get(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User no longer exists.',
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: 'Account has been deactivated. Contact your manager.',
      });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token has expired. Please login again.',
      });
    }
    return res.status(401).json({
      success: false,
      message: 'Invalid token.',
    });
  }
}

/**
 * Role-based authorization middleware.
 * Usage: authorize('owner', 'manager')
 * Ensures the authenticated user has one of the specified roles.
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.',
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to perform this action.',
      });
    }

    next();
  };
}

/**
 * Optional authentication — attaches user if token present, but doesn't block if absent.
 * Useful for endpoints accessible by both guests and logged-in users (e.g., scanning QR).
 */
function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const db = getDb();
    const user = db
      .prepare('SELECT id, phone, email, name, role, is_active FROM users WHERE id = ?')
      .get(decoded.id);

    if (user && user.is_active) {
      req.user = user;
    }
    next();
  } catch {
    next();
  }
}

module.exports = { authenticate, authorize, optionalAuth };
