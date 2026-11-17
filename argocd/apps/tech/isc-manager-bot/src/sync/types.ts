export type SewobePerson = {
  vorname: string;
  nachname: string;
  geburtstag: string;
  anrede: string;
  mitgliedsnummer: string;
  strasse: string;
  plz: string;
  ort: string;
  land: string;
};

export type Gender = "0" | "1" | "2";

export type Target = {
  vorname: string;
  nachname: string;
  gebdate: string;
  gender: Gender | undefined;
  dlrgManagerId: string;
  strasse: string | undefined;
  plz: string | undefined;
  ort: string | undefined;
  land: string | undefined;
};

export type Candidate = {
  uid: string;
  vorname: string;
  nachname: string;
  gebdate: string;
  dlrgManagerId: string;
};

export type IscAddress = {
  locId: string | undefined;
  strasse: string;
  plz: string;
  ort: string;
  land: string;
};

export type IscState = {
  vorname: string;
  nachname: string;
  gebdate: string;
  gender: string;
  dlrgManagerId: string;
  hasMembership: boolean;
  address: IscAddress | undefined;
};

export type FieldChange = {
  field: string;
  old: string;
  new: string;
};

export type GrunddatenValues = {
  vorname?: string;
  nachname?: string;
  gebdate?: string;
  gender?: Gender;
  dlrgManagerId?: string;
};

export type AddressValues = {
  strasse: string;
  plz: string;
  ort: string;
  land: string;
};

export type Plan = {
  changes: FieldChange[];
  grunddaten: GrunddatenValues;
  address: { kind: "none" } | { kind: "update" | "create"; values: AddressValues };
  membership: boolean;
};

export type SyncOutcome = "created" | "updated" | "unchanged" | "skipped" | "error";
