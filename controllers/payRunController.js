const { z } = require('zod');
const payRunService = require('../service/payRunService');

// ---- Validation schema for PATCH body
const UpdateLineSchema = z.object({
  hours: z.number().finite().min(0).max(1000).optional(),
  allowance: z.number().finite().min(0).max(1e9).optional(),
  note: z.string().max(500).optional()
}).refine(obj => Object.keys(obj).length > 0, { message: 'No fields to update' });

/**
 * PATCH /api/pay-runs/current/items/:line_id
 * Body: { hours?, allowance?, note? }
 * Delegates to payRunService.updateCurrentRunLine and returns updated line + refreshed summary
 */
exports.updateCurrentRunLine = async (req, res) => {
  try {
    const { line_id } = req.params;

    const parsed = UpdateLineSchema.safeParse({
      hours: req.body.hours !== undefined ? Number(req.body.hours) : undefined,
      allowance: req.body.allowance !== undefined ? Number(req.body.allowance) : undefined,
      note: req.body.note
    });

    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid payload',
        errors: parsed.error.flatten()
      });
    }

    const userId = req.user?.id; // set by authenticateToken middleware
    const data = await payRunService.updateCurrentRunLine({
      lineId: line_id,
      patch: parsed.data,
      userId
    });

    if (!data) {
      return res.status(404).json({ message: 'Line not found or not in current run' });
    }

    // shape: { ok, line, summary }
    return res.json({ ok: true, line: data.line, summary: data.summary });
  } catch (err) {
    console.error('[payRun] updateCurrentRunLine error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /api/pay-runs/current/summary
 * Returns current run summary (or 404 if none)
 */
exports.getCurrentSummary = async (req, res) => {
  try {
    const summary = await payRunService.getCurrentRunSummary(); // implement in service
    if (!summary) return res.status(404).json({ message: 'No current run' });
    return res.json(summary);
  } catch (err) {
    console.error('[payRun] getCurrentSummary error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /api/pay-runs/current/items?search=&limit=25&offset=0
 * Returns paged items for the current run
 */
exports.getCurrentItems = async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const limit  = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const data = await payRunService.getCurrentRunItems({ search, limit, offset }); // implement in service
    return res.json(data); // expected shape: { items, paging: { search, limit, offset, total } }
  } catch (err) {
    console.error('[payRun] getCurrentItems error:', err);
    return res.status(500).json({ message: 'Internal server error', detail: String(err.message || err) });
  }
};

exports.getCurrent = async (req, res) => {
  try {
    const cur = await payRunService.getCurrentRunView();
    if (!cur) return res.json({ status: 'None' });
    return res.json(cur);
  } catch (err) {
    console.error('[payRun] getCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.startCurrent = async (req, res) => {
  try {
    const out = await payRunService.startCurrentRun({ userId: req.user?.id });
    return res.json(out);
  } catch (err) {
    console.error('[payRun] startCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.recalculateCurrent = async (req, res) => {
  try {
    const out = await payRunService.recalculateCurrentRun();
    return res.json(out);
  } catch (err) {
    console.error('[payRun] recalcCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.approveCurrent = async (req, res) => {
  try {
    const out = await payRunService.approveCurrentRun({ userId: req.user?.id });
    if (out?.conflict) return res.status(409).json(out);
    return res.json(out);
  } catch (err) {
    console.error('[payRun] approveCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.postCurrent = async (req, res) => {
  try {
    const out = await payRunService.postCurrentRun({ userId: req.user?.id });
    if (out?.conflict) return res.status(409).json(out);
    return res.json(out);
  } catch (err) {
    console.error('[payRun] postCurrent error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
