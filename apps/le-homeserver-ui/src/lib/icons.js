// Kleine, handgeschriebene Icon-Sammlung (24x24, stroke currentColor) -
// vermeidet eine zusaetzliche Icon-Font/Library-Abhaengigkeit.
const ICONS = {
  chart: '<path d="M4 19V5M4 19h16M9 19v-7M14 19v-10M19 19v-4"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  siren: '<path d="M7 18v-6a5 5 0 0 1 10 0v6"/><path d="M3 18h18v3H3z"/><path d="M12 2v3"/><path d="M5.6 5.6l1.8 1.8"/><path d="M18.4 5.6l-1.8 1.8"/>',
  shield: '<path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-4z"/>',
  bell: '<path d="M18 16v-5a6 6 0 0 0-12 0v5l-2 2h16z"/><path d="M9.5 20a2.5 2.5 0 0 0 5 0"/>',
  cube: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5"/><path d="M12 22V12"/>',
  sync: '<path d="M20 11A8 8 0 0 0 6 6.3L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14 4.7l2-1.7"/><path d="M20 20v-4h-4"/>',
  terminal: '<path d="M4 17l5-5-5-5"/><path d="M12 19h8"/>',
  box: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
};

function icon(name, className) {
  const inner = ICONS[name] || ICONS.alert;
  const cls = className ? ` ${className}` : '';
  return `<svg class="icon${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

module.exports = { icon };
