const { z } = require('zod');
const payRunService = require('../service/payRunService');
const { resolveRunId } = require('./utils/resolverRunId');


const numLike = z.coerce.number();

const UpdateLineSchema = z.object({
  _recalc: z.any().optional(),
  hours: numLike.min(0).max(1000).optional(),
  rate: numLike.min(0).max(1e9).optional(),
  allowance: numLike.min(0).max(1e9).optional(),
  ot_15_hours: numLike.min(0).max(1000).optional(),
  ot_20_hours: numLike.min(0).max(1000).optional(),
  tax: numLike.min(0).max(1e9).optional(),
  deductions: numLike.min(0).max(1e9).optional(),       // we'll map this below
  note: z.string().max(500).optional()
}).refine((obj) => obj._recalc || Object.keys(obj).length > 0, { message: 'No fields to update' });

const AddLineSchema = z.object({
  employee_id: z.coerce.number().int().positive(),
  hours: numLike.min(0).max(1000).default(0),
  rate: numLike.min(0).max(1e9).optional(),
  allowance: numLike.min(0).max(1e9).default(0),
  ot_15_hours: numLike.min(0).max(1000).default(0),
  ot_20_hours: numLike.min(0).max(1000).default(0),
  deductions: numLike.min(0).max(1e9).optional(),
  deductions_total: numLike.min(0).max(1e9).optional(),
  note: z.string().max(500).optional(),
});



function emptySummary() {
  return {
    status: 'None',
    period: null,
    totals: { employees: 0, gross: 0, tax: 0, deductions: 0, net: 0 },
    items: []
  };
}

const ensureArray = v => Array.isArray(v) ? v : [];
const ensureTotals = v => v ?? { employees: 0, gross: 0, tax: 0, deductions: 0, net: 0 };


exports.getCurrentSummary = async (req, res) => {
  try {
    const summary = await payRunService.getCurrentRunSummary();

    if (!summary) {
      return res.json(emptySummary());
    }
    // Ensure minimum shape (tolerant to partial service results)
    return res.json({
      run_id: summary.run_id ?? null,
      status: summary.status ?? 'Draft',
      period: summary.period ?? null,
      totals: ensureTotals(summary.totals),
      items: ensureArray(summary.items)
    });
  } catch (err) {
    console.error('[payRun] getCurrentSummary error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getCurrentItems = async (req, res) => {
  try {
    const { search = '', limit = 25, offset = 0 } = req.query;
    const result = await payRunService.getCurrentRunItems({
      search: String(search),
      limit: Number(limit) || 25,
      offset: Number(offset) || 0
    });

    if (!result) {
      return res.json({ status: 'None', items: [] });
    }
    const status = result.status ?? 'Draft';
    return res.json({ status, items: result.items ?? [], paging: result.paging });
  } catch (err) {
    console.error('[payRun] getCurrentItems error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getCurrent = async (req, res) => {
  try {
    const data = await payRunService.getCurrentRun();
    if (!data) return res.json(emptySummary());
    return res.json({
      run_id: data.run_id ?? null,
      status: data.status ?? 'Draft',
      period: data.period ?? null,
      totals: ensureTotals(data.totals),
      items: ensureArray(data.items)
    });
  } catch (err) {
    console.error('[payRun] getCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.startCurrent = async (req, res) => {
  try {
    const result = await payRunService.startCurrentRun(req.user?.user_id);
    return res.json(result);
  } catch (err) {
    console.error('[payRun] startCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.recalculateCurrent = async (req, res) => {
  try {
    const result = await payRunService.recalcCurrentRun(req.user?.user_id);
    if (!result?.ok) return res.status(404).json(result);
    return res.json(result);
  } catch (err) {
    console.error('[payRun] recalculateCurrent error:', err);
    return res.status(err.status || 500).json({ message: err.status ? err.message : 'Internal server error' });
  }
};

exports.approveCurrent = async (req, res) => {
  try {

    const result = await payRunService.approveCurrentRun(req.user?.user_id);
    if (result?.ok === false) {
      return res.status(400).json({ message: result.message });
    }
    return res.json(result);
  } catch (err) {
    console.error('[payRun] approveCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.postCurrent = async (req, res) => {
  try {
    const result = await payRunService.postCurrentRun(req.user?.user_id);
    return res.json(result);
  } catch (err) {
    console.error('[payRun] postCurrent error:', err);
    return res.status(400).json({ message: err.message || 'Unable to post pay run' });
  }
};

// PATCH /api/pay-runs/current/items/:line_id { hours }
exports.updateCurrentItem = async (req, res) => {
  try {
    const { id } = req.params;
    let body;
    try {
      body = UpdateLineSchema.parse(req.body);

    } catch (error) {
      return res.status(400).json({ message: error.issues?.[0]?.message || 'Invalid payload' });
    }

    const result = await payRunService.updateCurrentItem(Number(id), body, req.user?.user_id);
    if (!result) return res.status(404).json({ message: 'Draft pay-run item not found' });
    return res.json(result);
  } catch (err) {
    console.error('[payRun] updateCurrentItem error:', err);
    return res.status(err.status || 500).json({ message: err.status ? err.message : 'Internal server error' });
  }
};

exports.reopenCurrent = async (req, res) => {
  try {
    const result = await payRunService.reopenCurrentRun(req.user?.user_id);
    return res.json(result);
  } catch (err) {
    console.error('[payRun] reopenCurrent error:', err);
    return res.status(400).json({ message: err.message || 'Unable to reopen pay run' });
  }
};
exports.startForPeriod = async (req, res) => {
  const { period_id } = req.body;
  const userId = req.user?.user_id || null;

  if (!period_id) {
    return res.status(400).json({ message: "period_id is required" });
  }

  try {
    const run = await payRunService.startForPeriod(period_id, userId);
    return res.json(run);
  } catch (err) {
    console.error("[payRun] startForPeriod error:", err);
    const status = err.message === 'Period not found' ? 404 : 400;
    return res.status(status).json({ message: err.message || 'Unable to start pay run' });
  }
};

exports.getCurrentValidation = async (req, res) => {
  try {
    const result = await payRunService.validateCurrentRun();
    return res.json(result);
  } catch (err) {
    console.error('[payRun] getCurrentValidation error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.addCurrentItem = async (req, res) => {
  try {
    const payload = AddLineSchema.parse(req.body);
    const item = await payRunService.addCurrentRunItem(payload, req.user?.user_id);
    return res.status(201).json(item);
  } catch (err) {
    console.error('[payRun] addCurrentRunItem error:', err);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: err.issues?.[0]?.message || 'Invalid payload' });
    }
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.deleteCurrentItem = async (req, res) => {
  try {
    await payRunService.deleteCurrentItem(Number(req.params.id), req.user?.user_id);
    return res.status(204).send();
  } catch (err) {
    console.error('[payRun] deleteCurrentItem error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getStpPreview = async (_req, res) => {
  try {
    const data = await payRunService.getStpPreview();
    return res.json(data);
  } catch (err) {
    console.error('[payRun] getStpPreview error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.exportBankFile = async (req, res) => {
  try {
    const runId = req.query.run_id ? Number(req.query.run_id) : null;
    if (runId !== null && (!Number.isInteger(runId) || runId <= 0)) {
      return res.status(400).json({ message: 'Invalid run_id' });
    }
    const { filename, csv, warnings = [] } = await payRunService.buildBankCsvForCurrentRun({ runId });

    if (!csv || !csv.length) {
      return res.status(400).json({ message: warnings[0] || 'No rows to export' });
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'bank_export.csv'}"`);
    return res.send(csv);

  } catch (error) {
    console.error('[payRun] exportBankFile error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }

};

exports.exportPayslipsPdfCurrent = async (req, res, next) => {

  try {
    const runId = await resolveRunId(req);

    if (!runId) return res.status(404).json({ message: 'No current run found' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payslips-run-${runId}.pdf"`);

    await payRunService.streamPayslipsPdfForRunById(runId, res);

  } catch (err) {
    console.error('[payRun] exportPayslipsPdf error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ message: 'Internal server error' });
    }
    try { res.end(); } catch (e) {
      next(e);
    }
  }
};

exports.exportPayslipsPdfById = async (req, res, next) => {
  try {
    const runId = Number(req.params.id);

    if (!Number.isFinite(runId) || runId <= 0) {
      return res.status(400).json({ message: 'Invalid Run id' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payslips-run-${runId}.pdf"`);

    await payRunService.streamPayslipsPdfForRunById(runId, res);

  } catch (err) {
    console.error('[payRun] exportPayslipsPdf error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ message: 'Internal server error' });
    }
    try { res.end(); } catch (e) {
      next(e);
    }
  }
};

exports.viewPayslipInline = async (req, res, next) => {
  try {
    const runId = Number(req.params.runId);
    const employeeId = Number(req.params.employeeId);

    if (!Number.isFinite(runId) || runId <= 0) {
      return res.status(400).json({ message: 'Invalid Run id' });
    }

    if (!Number.isFinite(employeeId) || employeeId <= 0) {
      return res.status(400).json({ message: 'Invalid Employee id' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payslips-run-${employeeId}-${runId}.pdf"`);

    await payRunService.viewPayslipInline(runId, employeeId, res);

  } catch (err) {
    console.error('[payRun] exportPayslipsPdf error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ message: 'Internal server error' });
    }
    try { res.end(); } catch (e) {
      next(e);
    }
  }
};

exports.getCurrentSamoaSummary = async (req, res, next) => {
  try {
    const result = await payRunService.getSamoaContributionsSummary(undefined);
    if (!result.ok) {
      return res.status(400).json({ message: result.message || 'Unable to compute Samoa contributions' });
    }
    return res.json(result);
  } catch (err) {
    console.error('[payRun] getCurrentSamoaSummary error', err);
    next(err);
  }
};

exports.getSamoaSummaryByRunId = async (req, res, next) => {
  try {
    const runId = Number(req.params.runId);
    if (!Number.isFinite(runId) || runId <= 0) {
      return res.status(400).json({ message: 'Invalid run id' });
    }
    const result = await payRunService.getSamoaContributionsSummary(runId);
    if (!result.ok) {
      return res.status(400).json({ message: result.message || 'Unable to compute Samoa contributions' });
    }
    return res.json(result);
  } catch (err) {
    console.error('[payRun] getSamoaSummaryByRunId error', err);
    next(err);
  }
};

exports.exportSuperFile = async (req, res) => {

  try {
    const runId = req.query.run_id ? Number(req.query.run_id) : null;
    if (runId !== null && (!Number.isInteger(runId) || runId <= 0)) {
      return res.status(400).json({ message: 'Invalid run_id' });
    }
    const { filename, csv, warnings = [] } = await payRunService.buildSuperCsvForCurrentRun({ runId });
    
    if (!csv || !csv.length) {
      return res.status(400).json({ message: warnings[0] || 'No rows to export' });
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'npf_export.csv'}"`);
    return res.send(csv);

  } catch (error) {
    console.error('[payRun] exportSuperFile error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  } 
};

exports.importTimesheets = async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ message: 'CSV file is required' });
    const runId = await resolveRunId(req);
    if (!runId) return res.status(404).json({ message: 'No current pay run found' });
    const result = await payRunService.importTimesheetsFromCsv(runId, req.file.buffer, req.user?.user_id);
    return res.json(result);
  } catch (err) {
    console.error('[payRun] importTimesheets error:', err);
    return res.status(400).json({ message: err.message || 'Timesheet import failed' });
  }
};
