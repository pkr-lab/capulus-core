const express = require('express');
const { getHealthByJob } = require('../lib/grafana');

const router = express.Router();

router.get('/health', async (req, res) => {
  const { byJob, error } = await getHealthByJob();
  res.json({ byJob, error });
});

module.exports = router;
