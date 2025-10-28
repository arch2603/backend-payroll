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

console.log('[authRoutes] typeof authenticateToken =', typeof authenticateToken);
console.log('[authRoutes] typeof authorizeRoles  =', typeof authorizeRoles);
console.log('[authRoutes] typeof authCtrl?.login =', typeof (authCtrl && authCtrl.login));
console.log('[authRoutes] typeof authCtrl?.register =', typeof (authCtrl && authCtrl.register));

// router.all('/__debug', (req, res) => {
//   res.json({ method: req.method, url: req.originalUrl, mounted: '/api/auth' });
// });

// Register route (only Admin can access)
router.post("/register", authenticateToken, authorizeRoles("admin"), registerUser);

router.post("/login", login);

router.get('/__debug', (req,res)=>res.json({ok:true, at:'/api/auth'}));

router.post("/change-password", authenticateToken, changePassword);

router.post("/request-password-reset", requestPasswordReset);

router.post("/reset-password", resetPassword);

router.post("/request-password-otp", oneTimePasswordReset);

router.post("/reset-password-otp", resetOtpPassword);

module.exports = router;
