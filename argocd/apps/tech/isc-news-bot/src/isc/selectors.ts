export const SEL = {
  login: {
    form: 'form[name="Login"]',
    user: 'input[name="auth[user]"]',
    pass: "#passwordInput",
    stayLoggedIn: "#stayLoggedInBig",
    submitText: "Anmelden",
  },
  logout: "#LogoutButton",
  gliederung: {
    navbarTitle: "a#navbarDropdownMenuLink[title]",
    activeItem: "#gldPickerMenu .dropdown-item.active",
    changeInput: "input#edvnummer",
    changeForm: "form#changeGliederung",
    edvSuffix: "#gld",
  },
  news: {
    form: 'form[name="newsForm"]',
    id: 'input[name="ID"]',
    idView: "input#idAznzeige",
    startDate: "#STARTDATE",
    archiveDate: "#ARCHIVEDATE",
    endDate: "#ENDDATE",
    type: "select#TYP",
    categories: "select#CATEGORIES__",
    title: "#TITLE",
    link: "#LINK",
    typo3Id: "#TYPO3ID",
    subtitle: "textarea#SUBTITLE",
    text: "textarea#TEXT",
    author: "#AUTHOR",
    authorEmail: "#AUTHOR_EMAIL",
    save: 'button#save[name="save"]',
    release: "button#release",
    success: ".alert-success",
    danger: ".alert-danger",
    parsleyErrors: ".parsley-errors-list",
    lockIcon: ".fa-lock",
    lockedText: "gesperrt",
    socialText: "#social-text",
  },
  tabs: {
    start: 'a[href="#tab-start"]',
    asset: 'a[href="#tab-asset"]',
    social: 'a[href="#tab-social"]',
  },
  typeBlocks: ["#nt0", "#nt1", "#nt2"],
  successText: "Erfolgreich gespeichert!",
  media: {
    disallowResize: 'input#disallowResizeImage[name="disallowResizeImage"]',
    firstAssetOnlyTeaser: 'input#firstAssetOnlyTeaser[name="firstAssetOnlyTeaser"]',
    uploadRibbonButton: "button#uploadRibbonButton",
    uploadRibbon: "#uploadRibbon",
    dropzone: "#mainUpload",
    dropzoneInput: "#mainUpload input.dz-hidden-input",
    keywordValue: "#mainUploadUploadKeywordTk",
    keywordTokenInput: "#mainUpload input.token-input-input-token",
    keywordDelete: "#mainUpload span.token-input-delete-token",
    assetRows: "tbody#assetContentTableBody tr",
  },
  ckeditor4Instance: "TEXT",
  ckeditor5Editable: ".ck-editor__editable",
} as const;

export const TYPE_VALUE = { text: "0", link: "1", typo3: "2" } as const;

export function createUrl(baseUrl: string): string {
  return `${baseUrl}/apps/news?page=uebersicht&create`;
}

export function editUrl(baseUrl: string, newsId: number): string {
  return `${baseUrl}/apps/news?page=uebersicht&action=edit&ID=${newsId}`;
}

export function finderUrl(baseUrl: string, edv: string, search: string): string {
  return `${baseUrl}/apps/news?page=finder&db=${encodeURIComponent(edv)}&str=${encodeURIComponent(search)}`;
}
