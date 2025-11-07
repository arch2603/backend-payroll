const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middleware/authMiddleware');
const payRunCtrl = require('../controllers/payRunController');

console.log('[payRunRoutes] typeof authenticateToken =', typeof authenticateToken);
console.log('[payRunRoutes] typeof payRunCtrl =', typeof payRunCtrl);
['getCurrentSummary','getCurrentItems','getCurrent','startCurrent','recalculateCurrent','approveCurrent','postCurrent'].forEach(fn => {
  console.log(`[payRunRoutes] typeof ${fn} =`, typeof payRunCtrl?.[fn]);
})
router.get('/__debug/current/summary', payRunCtrl.getCurrentSummary);

router.get('/current', authenticateToken, payRunCtrl.getCurrent);
router.get('/current/summary', authenticateToken, payRunCtrl.getCurrentSummary);
router.get('/current/items', authenticateToken, payRunCtrl.getCurrentItems);
router.get('/current/export/stp-preview', authenticateToken, authorizeRoles('admin','hr'), payRunCtrl.getStpPreview);
router.get(
  '/current/validation',
  authenticateToken,
  authorizeRoles('admin','hr'),
  payRunCtrl.getCurrentValidation
);

router.get('/current/export/bank-file', authenticateToken, authorizeRoles('admin','hr'), payRunCtrl.exportBankFile);
router.get('/current/export/payslips', authenticateToken, authorizeRoles('admin','hr'), payRunCtrl.exportPayslipsPdf);


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
  '/current/items/:id',             // <-- use :id to match your table
  authenticateToken,
  authorizeRoles('admin','hr'),
  payRunCtrl.updateCurrentItem      // <-- rename to match controller I gave
);

router.patch(
  '/current/status', 
  authenticateToken, 
  authorizeRoles('admin', 'hr'),
  payRunCtrl.updateStatus);

router.post(
  '/current/items',
  authenticateToken,
  authorizeRoles('admin','hr'),
  payRunCtrl.addCurrentItem
);

router.delete(
  '/current/items/:id',
  authenticateToken,
  authorizeRoles('admin','hr'),
  payRunCtrl.deleteCurrentItem
);

router.get('/ping', (req, res) => res.json({ ok: true, where: 'pay-runs' }));

module.exports = router;
