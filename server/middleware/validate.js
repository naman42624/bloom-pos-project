/**
 * Request Validation Middleware
 *
 * Centralizes express-validator usage.
 * Import validators for specific routes.
 */

const { validationResult, body, param, query } = require('express-validator');

/**
 * Middleware to check validation results and return 400 if invalid
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map(e => ({
        field: e.path,
        message: e.msg,
      })),
    });
  }
  next();
}

// ─── Common Validators ───────────────────────────────────────

const loginRules = [
  body('phone').trim().notEmpty().withMessage('Phone is required'),
  body('password').notEmpty().withMessage('Password is required'),
];

const registerRules = [
  body('phone').trim().notEmpty().withMessage('Phone is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('name').trim().notEmpty().withMessage('Name is required'),
];

const createUserRules = [
  body('phone').trim().notEmpty().withMessage('Phone is required'),
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('role').isIn(['manager', 'employee', 'delivery_partner']).withMessage('Invalid role'),
];

const createProductRules = [
  body('name').trim().notEmpty().withMessage('Product name is required'),
  body('selling_price').isFloat({ min: 0 }).withMessage('Selling price must be a positive number'),
];

const createSaleRules = [
  body('location_id').isInt({ min: 1 }).withMessage('Location is required'),
  body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
  body('items.*.product_name').notEmpty().withMessage('Product name is required'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('items.*.unit_price').isFloat({ min: 0 }).withMessage('Unit price must be positive'),
];

const paginationRules = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be 1-100'),
];

const idParam = [
  param('id').isInt({ min: 1 }).withMessage('Invalid ID'),
];

module.exports = {
  validate,
  loginRules,
  registerRules,
  createUserRules,
  createProductRules,
  createSaleRules,
  paginationRules,
  idParam,
  body,
  param,
  query,
};
