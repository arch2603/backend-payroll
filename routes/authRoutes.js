const express = require("express");
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

// Register route (only Admin can access)
router.post("/register", authenticateToken, authorizeRoles("admin"), registerUser);

router.post("/login", login);

router.post("/change-password", authenticateToken, changePassword);

router.post("/request-password-reset", requestPasswordReset);

router.post("/reset-password", resetPassword);

router.post("/request-password-otp", oneTimePasswordReset);

router.post("/reset-password-otp", resetOtpPassword);

module.exports = router;
