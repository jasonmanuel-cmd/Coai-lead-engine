// api/stats.js — Orchestrator dashboard stats
const { query, initSchema } = require('../lib/db');
const { resolveCaller } = require('../lib/saas');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const caller = await resolveCaller(req);
  if (!caller) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Owner-only: this exposes the private orchestrator pipeline, not customer data.
  if (!caller.admin) {
    return res.status(403).json({ error: 'Owner access only.' });
  }

  try {
    await initSchema();
    const [
      discovered,
      audited,
      qualified,
      messaged,
      followed_up,
      markets,
      today_discovered,
      last_outreach
    ] = await Promise.all([
      query("SELECT COUNT(*) as count FROM leads WHERE pipeline_stage = 'discovered'"),
      query("SELECT COUNT(*) as count FROM leads WHERE pipeline_stage IN ('audited', 'qualified', 'messaged', 'followed_up') AND audit_score IS NOT NULL"),
      query("SELECT COUNT(*) as count FROM leads WHERE pipeline_stage = 'qualified'"),
      query("SELECT COUNT(*) as count FROM leads WHERE pipeline_stage = 'messaged'"),
      query("SELECT COUNT(*) as count FROM leads WHERE pipeline_stage = 'followed_up'"),
      query("SELECT COUNT(*) as count FROM markets WHERE active = true"),
      query("SELECT COUNT(*) as count FROM leads WHERE DATE(created_at) = CURRENT_DATE"),
      query("SELECT MAX(sent_at) as last_sent FROM outreach_log")
    ]);

    const pipelineStats = {
      discovered: discovered.rows[0].count,
      audited: audited.rows[0].count,
      qualified: qualified.rows[0].count,
      messaged: messaged.rows[0].count,
      followed_up: followed_up.rows[0].count
    };

    const totalInPipeline = Object.values(pipelineStats).reduce((a, b) => a + b, 0);
    const conversionRate = totalInPipeline > 0 ? ((pipelineStats.qualified / pipelineStats.discovered) * 100).toFixed(1) : 0;

    res.status(200).json({
      status: 'OK',
      pipeline: pipelineStats,
      totals: {
        inPipeline: totalInPipeline,
        markets: markets.rows[0].count,
        discoveredToday: today_discovered.rows[0].count,
        conversionRate: `${conversionRate}%`
      },
      lastOutreach: last_outreach.rows[0]?.last_sent || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
