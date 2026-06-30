const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.SERVICES_CONFIG_PATH || '/app/config/services.json';
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'services.default.json');

function loadServices() {
  const sourcePath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : DEFAULT_CONFIG_PATH;
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    apps: parsed.apps || [],
  };
}

module.exports = { loadServices };
