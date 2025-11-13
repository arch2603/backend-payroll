const { z } = require('zod');
let payRunService;
try {
  payRunService = require('../service/payRunService');
} catch (error) {
  console.warn('[payRun] payRunService not found - using safe fallbacks');
  console.warn("[payRun] require error was:", error);
  payRunService = null;
};

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
  super: numLike.min(0).max(1e9).optional(),
  note: z.string().max(500).optional()
}).refine(obj => {

  if (obj._recalc) return true;
  return Object.keys(obj).some(k =>
    ['hours', 'rate', 'allowance', 'ot_15_hours', 'ot_20_hours', 'tax', 'deductions', 'super', 'note'].includes(k)
  );
}, { message: 'No fields to update' });

const { resolveRunId } = require('./utils/resolverRunId');


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
    const summary = await payRunService?.getCurrentRunSummary?.() ?? null;

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
    const result = await payRunService?.getCurrentRunItems?.({
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
    const data = await payRunService?.getCurrentRun?.() ?? null;
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
    const result = (await payRunService?.startCurrentRun?.()) ?? { ok: true };
    return res.json(result);
  } catch (err) {
    console.error('[payRun] startCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.recalculateCurrent = async (req, res) => {
  try {
    const result = (await payRunService?.recalcCurrentRun?.()) ?? { ok: true };
    return res.json(result);
  } catch (err) {
    console.error('[payRun] recalculateCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
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
    const result = await payRunService?.postCurrentRun?.() ?? { ok: true };
    return res.json(result);
  } catch (err) {
    console.error('[payRun] postCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
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
      return res.status(400).json({ message: error.errors?.[0]?.message || 'Invalid payload' });
    }

    if (!payRunService?.updateCurrentItem) {
      console.warn('[payRun] updateCurrentItem not implemented; returning ok:true');
      return res.json({ ok: true });
    }
    const result = await payRunService?.updateCurrentItem?.(Number(id), body, req.user?.user_id)
    return res.json(result ?? { ok: true });
  } catch (err) {
    console.error('[payRun] updateCurrentItem error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.updateStatus = async (req, res) => {
  console.log('[updateStatus] body =', req.body);
  try {
    const { status } = req.body; // expect 'Draft'|'Approved'|'Posted'
    if (!status) return res.status(400).json({ message: 'status required' });
    if (!payRunService?.updateCurrentRunStatus) {
      console.warn('[payRun] updateCurrentRunStatus not implemented; echoing');
      return res.json({ ok: true, status });
    }

    const allowApprovedToDraft = Boolean(
      req.body.allowApprovedToDraft ??
      req.body.allowApprovedDraft ??   // <- your earlier payload used this
      req.body.allowRollback ??        // optional alias if you ever used it
      false
    );

    const result = await payRunService?.updateCurrentRunStatus?.(status, req.user?.user_id, { allowApprovedToDraft });

    return res.json(result ?? { ok: true, status });
  } catch (err) {
    console.error('[payRun] updateStatus error:', err);
    return res.status(500).json({ message: 'Internal server error' });
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
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getCurrentValidation = async (req, res) => {
  try {
    // 1) service not loaded? return safe default
    if (!payRunService) {
      console.warn("[payRun] validateCurrentRun called but payRunService is NULL");
      return res.json({ ok: true, errors: [] });
    }
    if (typeof payRunService.validateCurrentRun !== "function") {
      console.warn("[payRun] validateCurrentRun is missing on service");
      return res.json({ ok: true, errors: [] });
    }
    const result = await payRunService.validateCurrentRun();
    return res.json(result);
  } catch (err) {
    console.error('[payRun] getCurrentValidation error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.addCurrentItem = async (req, res) => {
  try {
    if (!payRunService?.addCurrentRunItem) {
      return res.status(501).json({ message: 'addCurrentRunItem not implemented' });
    }
    const item = await payRunService.addCurrentRunItem(req.body, req.user?.user_id);
    return res.status(201).json(item);
  } catch (err) {
    console.error('[payRun] addCurrentRunItem error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.deleteCurrentItem = async (req, res) => {
  try {
    if (!payRunService?.deleteCurrentItem) {
      return res.status(501).json({ message: 'deleteCurrentItem not implemented' });
    }
    await payRunService.deleteCurrentItem(Number(req.params.id), req.user?.user_id);
    return res.status(204).send();
  } catch (err) {
    console.error('[payRun] deleteCurrentItem error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getStpPreview = async (_req, res) => {
  try {
    const data = await payRunService?.getStpPreview?.();
    return res.json(data ?? { ok: true, employees: [], totals: {} });
  } catch (err) {
    console.error('[payRun] getStpPreview error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.exportBankFile = async (req, res) => {
  try {
    if (!payRunService?.buildBankCsvForCurrentRun) {
      return res.status(501).json({ message: 'Bank export failed' });
    }
    const runId = req.query.run_id ? Number(req.query.run_id) : null;
    const { filename, csv } = await payRunService.buildBankCsvForCurrentRun({ runId });

    if (!csv || !csv.length) {
      return res.status(400).json({ message: 'No rows to export' });
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
    if (!payRunService?.streamPayslipsPdfForCurrentRun) {
      return res.status(501).json({ message: 'Payslips export not implemented' });
    }
    const runId = await resolveRunId(req);

    console.log('[pay-runs/export/payslips]',
      'param.id=', req.params?.id,
      'query.run_id=', req.query?.run_id,
      'resolved runId=', runId
    );

    if (!runId) return res.status(404).json({ message: 'No current run found' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payslips-run-${runId}.pdf"`);

    await payRunService.streamPayslipsPdfForCurrentRun(res);

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

    console.log('[pay-runs/export/payslips]',
      'param.id=', req.params?.id,
      'resolved runId=', runId
    );

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
    const employeeId = Number(req.params.empId);

    if (!Number.isFinite(runId) || runId <= 0) {
      return res.status(400).json({ message: 'Invalid Run id' });
    }

    if (!Number.isFinite(employeeId) || employeeId <= 0) {
      return res.status(400).json({ message: 'Invalid Employee id' });
    }

    console.log('[pay-runs/export/payslips]',
      'param.id=', req.params?.id,
      'resolved runId=', runId
    );

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





