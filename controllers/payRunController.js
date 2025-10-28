const { z } = require('zod');
const payRunService = require('../service/payRunService');

// ---- Validation schema for PATCH body
const UpdateLineSchema = z.object({
  hours: z.number().finite().min(0).max(1000).optional(),
  allowance: z.number().finite().min(0).max(1e9).optional(),
  note: z.string().max(500).optional()
}).refine(obj => Object.keys(obj).length > 0, { message: 'No fields to update' });


function emptySummary() {
  return {
    status: 'None',
    period: null,
    totals: { employees: 0, gross: 0, tax: 0, deductions: 0, net: 0 },
    items: []
  };
}

exports.getCurrentSummary = async (req, res) => {
  try {
    const summary = await req.app.locals.payRunService?.getCurrentRunSummary?.() 
                 ?? await (await import('../service/payRunService')).default?.getCurrentRunSummary?.()
                 ?? null;

    if (!summary) {
      return res.json(emptySummary());
    }
    // Ensure minimum shape (tolerant to partial service results)
    return res.json({
      status: summary.status ?? 'Draft',
      period: summary.period ?? null,
      totals: summary.totals ?? { employees: 0, gross: 0, tax: 0, deductions: 0, net: 0 },
      items: Array.isArray(summary.items) ? summary.items : []
    });
  } catch (err) {
    console.error('[payRun] getCurrentSummary error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getCurrentItems = async (req, res) => {
  try {
    const items = await req.app.locals.payRunService?.getCurrentRunItems?.()
               ?? await (await import('../service/payRunService')).default?.getCurrentRunItems?.()
               ?? null;
    if (!items) {
      return res.json({ status: 'None', items: [] });
    }
    return res.json({ status: 'Draft', items: Array.isArray(items) ? items : [] });
  } catch (err) {
    console.error('[payRun] getCurrentItems error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getCurrent = async (req, res) => {
  try {
    const data = await req.app.locals.payRunService?.getCurrentRun?.()
              ?? await (await import('../service/payRunService')).default?.getCurrentRun?.()
              ?? null;
    if (!data) return res.json(emptySummary());
    return res.json({
      status: data.status ?? 'Draft',
      period: data.period ?? null,
      totals: data.totals ?? { employees: 0, gross: 0, tax: 0, deductions: 0, net: 0 },
      items: Array.isArray(data.items) ? data.items : []
    });
  } catch (err) {
    console.error('[payRun] getCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.startCurrent = async (req, res) => {
  try {
    const result = await req.app.locals.payRunService?.startCurrentRun?.()
                ?? await (await import('../service/payRunService')).default?.startCurrentRun?.();
    return res.json(result ?? { ok: true });
  } catch (err) {
    console.error('[payRun] startCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.recalculateCurrent = async (req, res) => {
  try {
    const result = await req.app.locals.payRunService?.recalcCurrentRun?.()
                ?? await (await import('../service/payRunService')).default?.recalcCurrentRun?.();
    return res.json(result ?? { ok: true });
  } catch (err) {
    console.error('[payRun] recalculateCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.approveCurrent = async (req, res) => {
  try {
    const result = await req.app.locals.payRunService?.approveCurrentRun?.()
                ?? await (await import('../service/payRunService')).default?.approveCurrentRun?.();
    return res.json(result ?? { ok: true });
  } catch (err) {
    console.error('[payRun] approveCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.postCurrent = async (req, res) => {
  try {
    const result = await req.app.locals.payRunService?.postCurrentRun?.()
                ?? await (await import('../service/payRunService')).default?.postCurrentRun?.();
    return res.json(result ?? { ok: true });
  } catch (err) {
    console.error('[payRun] postCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// PATCH /api/pay-runs/current/items/:line_id { hours }
exports.updateCurrentRunLine = async (req, res) => {
  try {
    const { line_id } = req.params;
    const { hours } = req.body;
    if (hours == null || Number.isNaN(Number(hours))) {
      return res.status(400).json({ message: 'hours is required and must be numeric' });
    }
    const result = await req.app.locals.payRunService?.updateCurrentRunLine?.(Number(line_id), Number(hours))
                ?? await (await import('../service/payRunService')).default?.updateCurrentRunLine?.(Number(line_id), Number(hours));
    return res.json(result ?? { ok: true });
  } catch (err) {
    console.error('[payRun] updateCurrentRunLine error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// PATCH /api/pay-runs/current/status { status }
exports.updateStatus = async (req, res) => {
  try {
    const { status } = req.body; // expect 'Draft'|'Approved'|'Posted'
    if (!status) return res.status(400).json({ message: 'status required' });
    const result = await req.app.locals.payRunService?.updateCurrentRunStatus?.(status)
                ?? await (await import('../service/payRunService')).default?.updateCurrentRunStatus?.(status);
    return res.json(result ?? { ok: true, status });
  } catch (err) {
    console.error('[payRun] updateStatus error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


