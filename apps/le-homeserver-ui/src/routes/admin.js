const express = require('express');
const { loadServices } = require('../lib/config');
const { isInAdminGroup } = require('../lib/authentik');

const router = express.Router();

router.get('/', (req, res) => {
  const adminGroup = req.app.locals.adminGroup;

  // Verteidigung in der Tiefe: selbst wenn Ingress/Authentik die Trennung
  // nicht korrekt durchsetzen, blockt die App admin.homeserver serverseitig.
  if (!isInAdminGroup(res.locals.user, adminGroup)) {
    return res.status(403).render('403', { title: 'Kein Zugriff' });
  }

  const services = loadServices();
  res.render('admin', {
    cards: services.apps,
    title: 'Admin',
    subtitle: 'Admin-Dashboard',
  });
});

module.exports = router;
