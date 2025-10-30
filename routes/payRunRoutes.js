const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middleware/authMiddleware');
const payRunCtrl = require('../controllers/payRunController');

console.log('[payRunRoutes] typeof authenticateToken =', typeof authenticateToken);
console.log('[payRunRoutes] typeof payRunCtrl =', typeof payRunCtrl);
['getCurrentSummary','getCurrentItems'].forEach(fn => {
  console.log(`[payRunRoutes] typeof ${fn} =`, typeof payRunCtrl?.[fn]);
})

router.get('/current/summary', authenticateToken, payRunCtrl.getCurrentSummary);
router.get('/__debug/current/summary', payRunCtrl.getCurrentSummary);
router.get('/current/items', authenticateToken, payRunCtrl.getCurrentItems);
router.get('/current', authenticateToken, payRunCtrl.getCurrent);

router.post('/current/start', authenticateToken, authorizeRoles('admin','hr'), payRunCtrl.startCurrent);
router.post('/current/recalculate', authenticateToken, authorizeRoles('admin','hr'), payRunCtrl.recalculateCurrent);
router.post('/current/approve', authenticateToken, authorizeRoles('admin','hr'), payRunCtrl.approveCurrent);
router.post('/current/post', authenticateToken, authorizeRoles('admin','hr'), payRunCtrl.postCurrent);
router.post(
  "/start",
  authenticateToken,
  authorizeRoles("admin","hr"),
  payRunCtrl.startForPeriod
);

router.patch(
  '/current/items/:line_id',
  authenticateToken,
  authorizeRoles('admin', 'hr'),     // only payroll-capable roles
  payRunCtrl.updateCurrentRunLine    // delegate to controller
);
router.patch(
  '/current/status', 
  authenticateToken, 
  authorizeRoles('admin', 'hr'),
  payRunCtrl.updateStatus);

router.get('/ping', (req, res) => res.json({ ok: true, where: 'pay-runs' }));

module.exports = router;
