export const SEWOBE = {
  login: {
    form: 'form[name="formular"]',
    user: "#USERNAME",
    pass: "#PASSWORT",
    submitText: "Anmelden",
  },
  twoFactor: {
    input: 'input[name="2FA"]',
    submitText: "Anmeldecode prüfen",
  },
  search: "#SEARCH",
  logout: "#logout",
  hierarchie: "select#HIERARCHIE",
  frames: {
    main: "iframe#iframemain",
    results: "iframe#SEARCHCONTENT",
    detail: "iframe#DETAIL",
  },
  results: {
    card: "div.card.contacts",
    empty: "div.emptyresponse",
    status: ".status",
    statusActive: ".status_aktiv",
    company: ".company",
    number: ".nr",
    open: 'a[href*="/module/adressen/personen.php"]',
  },
  detail: {
    anrede: "#BS_ANREDE",
    vorname: "#BS_VORNAME",
    nachname: "#BS_NAME",
    land: "#LAND_ID",
    plz: "#PLZ",
    ort: "#ORT",
    strasse: "#STRASSE",
    geburtstag: "#GEBURTSTAG",
  },
} as const;
