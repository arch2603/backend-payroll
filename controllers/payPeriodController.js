const payPeriodService = require("../service/payPeriodService");

exports.list = async (req, res) => {
    try {
        const periods = await payPeriodService.list();
        return res.json(periods);
    } catch (error) {
        console.error("[payPeriod] list error:", error);
        return res.status(500).json({message: "Internal Server error"});
    }
};

exports.create = async (req, res) => {
  const { start_date, end_date, make_current } = req.body;

  if (!start_date || !end_date) {
    return res
      .status(400)
      .json({ message: "start_date and end_date are required" });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
    return res.status(400).json({ message: 'Dates must use YYYY-MM-DD' });
  }
  if (start_date > end_date) {
    return res.status(400).json({ message: 'start_date must be on or before end_date' });
  }

  try {
    const period = await payPeriodService.create({
      start_date,
      end_date,
      make_current: !!make_current,
    }, req.user?.user_id);
    return res.status(201).json(period);
  } catch (err) {
    console.error("[payPeriod] create error:", err);
    if (err.code === '23P01' || err.code === '23505' || err.code === '23514') {
      return res.status(409).json({ message: 'Pay period conflicts with an existing period' });
    }
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.setCurrent = async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ message: "id is required" });
  }

  try {
    const ok = await payPeriodService.setCurrent(id, req.user?.user_id);
    if (!ok) {
      return res.status(404).json({ message: "Period not found" });
    }
    return res.json({ message: "Current period updated", id });
  } catch (err) {
    console.error("[payPeriod] setCurrent error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
