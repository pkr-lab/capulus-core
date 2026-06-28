const express = require('express');
const { loadServices } = require('../lib/config');

const router = express.Router();

router.get('/', (req, res) => {
  const services = loadServices();
  res.render('einsatz', {
    cards: services.einsatz,
    activeNav: 'einsatz',
    title: 'Einsatz',
    subtitle: 'Einsatz-Dashboard',
    theme: 'einsatz',
  });
});

module.exports = router;
