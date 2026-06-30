// Authentik trennt Gruppen im Forward-Auth-Header per "|", manche Setups
// liefern stattdessen Kommas - beide Trennzeichen werden akzeptiert.
function parseGroups(header) {
  return header.split(/[|,]/).map((g) => g.trim()).filter(Boolean);
}

function userFromHeaders(req) {
  const groupsHeader = req.get('X-authentik-groups') || '';
  return {
    username: req.get('X-authentik-username') || '',
    name: req.get('X-authentik-name') || req.get('X-authentik-username') || 'Unbekannt',
    email: req.get('X-authentik-email') || '',
    groups: parseGroups(groupsHeader),
  };
}

function isInAdminGroup(user, adminGroup) {
  return user.groups.includes(adminGroup);
}

module.exports = { userFromHeaders, isInAdminGroup };
