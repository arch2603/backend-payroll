const express = require("express");
const { rateLimit } = require('express-rate-limit');
const router = express.Router();


const { authenticateToken, authorizeRoles } = require("../middleware/authMiddleware");
const {
  login,
  registerUser,
  changePassword,
  resetPassword,
  requestPasswordReset,
  oneTimePasswordReset,
  resetOtpPassword } = require("../controllers/authController");
const authCtrl = require('../controllers/authController');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please try again later.' },
});

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many reset attempts. Please try again later.' },
});

// Register route (only Admin can access)
router.post("/register", authenticateToken, authorizeRoles("admin"), registerUser);

router.post("/login", loginLimiter, login);

router.post("/change-password", authenticateToken, changePassword);

router.post("/request-password-reset", resetLimiter, requestPasswordReset);

router.post("/reset-password", resetLimiter, resetPassword);

router.post("/request-password-otp", resetLimiter, oneTimePasswordReset);

router.post("/reset-password-otp", resetLimiter, resetOtpPassword);

module.exports = router;
