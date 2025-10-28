const { z } = require('zod');
let payRunService;
try {
    payRunService = require('../service/payRunService');
} catch (error) {
    console.warn('[payRun] payRunService not found - using safe fallbacks');
    payRunService = null;
};

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

const ensureArray  = v => Array.isArray(v) ? v : [];
const ensureTotals = v => v ?? { employees: 0, gross: 0, tax: 0, deductions: 0, net: 0 };


exports.getCurrentSummary = async (req, res) => {
  try {
    const summary = await payRunService?.getCurrentRunSummary?.() ?? null;

    if (!summary) {
      return res.json(emptySummary());
    }
    // Ensure minimum shape (tolerant to partial service results)
    return res.json({
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
    const result = await payRunService?.getCurrentRunItems?.() ?? null;
    if(!result) {
        return res.json({status: 'None', items: []});
    }
    
    const list = Array.isArray(result) ? result : Array.isArray(result{ status: 'Draft', items: list }.items) ? result.items : [];
    return res.json({ status: 'Draft', items: list });
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
    const result = (await payRunService?.startCurrentRun?.()) ?? {ok: true};
    return res.json(result);
  } catch (err) {
    console.error('[payRun] startCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.recalculateCurrent = async (req, res) => {
  try {
    const result = (await payRunService?.recalcCurrentRun?.()) ?? {ok : true};
    return res.json(result);
  } catch (err) {
    console.error('[payRun] recalculateCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.approveCurrent = async (req, res) => {
  try {
    const result = await payRunService?.approveCurrentRun?.()?? {ok: true};
    return res.json(result);
  } catch (err) {
    console.error('[payRun] approveCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.postCurrent = async (req, res) => {
  try {
    const result = await payRunService?.postCurrentRun?.()?? {ok: true};
    return res.json(result);
  } catch (err) {
    console.error('[payRun] postCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// PATCH /api/pay-runs/current/items/:line_id { hours }
exports.updateCurrentRunLine = async (req, res) => {
  try {
    const { line_id } = req.params;
    let body;
    try {
        body = UpdateLineSchema.parse(req.body);

    } catch (error) {
        return res.status(400).json({message: error.errors?.[0]?.message || 'Invalid payload'});
    }

     if (!payRunService?.updateCurrentRunLine) {
      console.warn('[payRun] updateCurrentRunLine not implemented; returning ok:true');
      return res.json({ ok: true });
    }
    const result = await payRunService?.updateCurrentRunLine?.(Number(line_id), body, req.user?.user_id)
    return res.json(result ?? { ok: true });
  } catch (err) {
    console.error('[payRun] updateCurrentRunLine error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.updateStatus = async (req, res) => {
  try {
    const { status } = req.body; // expect 'Draft'|'Approved'|'Posted'
    if (!status) return res.status(400).json({ message: 'status required' });
    if (!payRunService?.updateCurrentRunStatus) {
      console.warn('[payRun] updateCurrentRunStatus not implemented; echoing');
      return res.json({ ok: true, status });
    }
    const result = await payRunService?.updateCurrentRunStatus?.(status, req.user?.user_id);
    return res.json(result ?? { ok: true, status });
  } catch (err) {
    console.error('[payRun] updateStatus error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


