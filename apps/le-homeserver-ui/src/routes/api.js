const express = require('express');
const { getHealthByJob, getSystemStats } = require('../lib/grafana');

const router = express.Router();

router.get('/health', async (req, res) => {
  const { byJob, error } = await getHealthByJob();
  res.json({ byJob, error });
});

router.get('/stats', async (req, res) => {
  const { nodes, error } = await getSystemStats();
  res.json({ nodes, error });
});

module.exports = router;
