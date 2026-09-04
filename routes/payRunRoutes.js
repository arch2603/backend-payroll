const express = require('express');
const multer = require('multer');
const { authenticateToken, authorizeRoles } = require('../middleware/authMiddleware');
const payRunCtrl = require('../controllers/payRunController');

const router = express.Router();
const payrollAccess = [authenticateToken, authorizeRoles('admin', 'hr')];
const adminOnly = [authenticateToken, authorizeRoles('admin')];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const accepted = file.mimetype === 'text/csv' || /\.csv$/i.test(file.originalname);
    cb(accepted ? null : new Error('Only CSV files are accepted'), accepted);
  },
});

router.get('/current', ...payrollAccess, payRunCtrl.getCurrent);
router.get('/current/summary', ...payrollAccess, payRunCtrl.getCurrentSummary);
router.get('/current/items', ...payrollAccess, payRunCtrl.getCurrentItems);
router.get('/current/validation', ...payrollAccess, payRunCtrl.getCurrentValidation);
router.get('/current/export/stp-preview', ...payrollAccess, payRunCtrl.getStpPreview);
router.get('/current/export/bank-file', ...payrollAccess, payRunCtrl.exportBankFile);
router.get('/current/export/super-file', ...payrollAccess, payRunCtrl.exportSuperFile);
router.get('/current/export/payslips', ...payrollAccess, payRunCtrl.exportPayslipsPdfCurrent);
router.get('/current/:runId/payslip/:employeeId', ...payrollAccess, payRunCtrl.viewPayslipInline);
router.get('/current/samoa-summary', ...payrollAccess, payRunCtrl.getCurrentSamoaSummary);

router.post('/current/start', ...payrollAccess, payRunCtrl.startCurrent);
router.post('/current/recalculate', ...payrollAccess, payRunCtrl.recalculateCurrent);
router.post('/current/approve', ...payrollAccess, payRunCtrl.approveCurrent);
router.post('/current/post', ...payrollAccess, payRunCtrl.postCurrent);
router.post('/current/reopen', ...adminOnly, payRunCtrl.reopenCurrent);
router.post('/current/import-timesheets', ...payrollAccess, upload.single('file'), payRunCtrl.importTimesheets);
router.post('/start', ...payrollAccess, payRunCtrl.startForPeriod);

router.patch('/current/items/:id', ...payrollAccess, payRunCtrl.updateCurrentItem);
router.post('/current/items', ...payrollAccess, payRunCtrl.addCurrentItem);
router.delete('/current/items/:id', ...payrollAccess, payRunCtrl.deleteCurrentItem);

// Parameterised routes stay last so "current" can never be parsed as an ID.
router.get('/:id/export/payslips', ...payrollAccess, payRunCtrl.exportPayslipsPdfById);
router.get('/:runId/samoa-summary', ...payrollAccess, payRunCtrl.getSamoaSummaryByRunId);

module.exports = router;
