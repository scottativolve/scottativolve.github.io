/* Generates the sample CSVs used by the "Load sample data" button.
   Deterministic, so re-running produces identical files. */
const fs = require('fs');
const path = require('path');

let seed = 20260828;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }
function int(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }

const SITES = [
  ['Ashfield House',      '14 Ashfield Road',    'Manchester', 'M14 6JN', 53.4457, -2.2270, 12, 'North West',  'Supported living'],
  ['Beechwood Lodge',     '2 Beech Grove',       'Leeds',      'LS6 2AN', 53.8175, -1.5720, 8,  'Yorkshire',   'Residential'],
  ['Cedar Court',         '77 Cedar Avenue',     'Birmingham', 'B29 6NA', 52.4392, -1.9412, 15, 'Midlands',    'Supported living'],
  ['Dovecote Mews',       '5 Dovecote Lane',     'Nottingham', 'NG9 1HG', 52.9270, -1.2130, 6,  'Midlands',    'Residential'],
  ['Elmtree House',       '31 Elm Street',       'Liverpool',  'L15 3HW', 53.3925, -2.9130, 10, 'North West',  'Residential'],
  ['Fernbank',            '8 Fern Road',         'Sheffield',  'S7 1RQ',  53.3552, -1.4920, 7,  'Yorkshire',   'Supported living'],
  ['Greenacres',          '112 Green Lane',      'Bristol',    'BS7 8LT', 51.4830, -2.5840, 9,  'South West',  'Residential'],
  ['Hazel Grove Villas',  '3 Hazel Close',       'Stoke',      'ST4 2QG', 53.0020, -2.1860, 5,  'Midlands',    'Supported living'],
  ['Ivy House',           '46 Ivy Bank',         'Newcastle',  'NE3 1TN', 55.0060, -1.6250, 11, 'North East',  'Residential'],
  ['Juniper Court',       '9 Juniper Way',       'Cardiff',    'CF14 4XW',51.5090, -3.1930, 8,  'Wales',       'Supported living'],
  ['Kingsley Lodge',      '20 Kingsley Road',    'Preston',    'PR2 1BQ', 53.7720, -2.7080, 6,  'North West',  'Residential'],
  ['Head Office',         'Unit 4 Waterside',    'Derby',      'DE1 3QT', 52.9270, -1.4820, 24, 'Corporate',   'Office']
];

const FIRST = ['Sarah','James','Aisha','Michael','Priya','David','Emma','Tomasz','Grace','Daniel','Chloe','Ibrahim','Rachel','Liam','Nia','Peter','Zoe','Callum','Fatima','Owen','Hannah','Marcus','Leah','Joseph'];
const LAST  = ['Bennett','Okafor','Kaur','Thompson','Patel','Walsh','Nowak','Ahmed','Robinson','Fletcher','Mensah','Doyle','Hughes','Sinclair','Byrne','Marsh','Ellis','Quinn','Adeyemi','Barlow','Chapman','Frost'];

const MODELS = [
  ['Latitude 5440', 'Dell Inc.'], ['Latitude 3540', 'Dell Inc.'], ['OptiPlex 7010', 'Dell Inc.'],
  ['EliteBook 640 G10', 'HP'], ['ProDesk 400 G9', 'HP'], ['ThinkPad L14 Gen 4', 'LENOVO'],
  ['Surface Laptop 5', 'Microsoft Corporation']
];

function pad(n, w) { return String(n).padStart(w, '0'); }
function ukDate(d) { return `${pad(d.getDate(),2)}/${pad(d.getMonth()+1,2)}/${d.getFullYear()} ${pad(d.getHours(),2)}:${pad(d.getMinutes(),2)}`; }
function isoDate(d) { return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function daysAgo(n) { return new Date(Date.now() - n * 86400000 - int(0, 20) * 3600000); }

const people = [];
for (let i = 0; i < 70; i++) {
  const f = pick(FIRST), l = pick(LAST);
  people.push({ first: f, last: l, name: `${f} ${l}`, upn: `${f.toLowerCase()}.${l.toLowerCase()}@example-care.org` });
}

const fsRows = [], intuneRows = [];
let n = 1000;

function newDevice(site, opts = {}) {
  opts = opts || {};
  const id = n++;
  const code = site[0].split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 3);
  const name = `${code}-PC-${pad(id % 1000, 3)}`;
  const person = pick(people);
  const [model, vendor] = pick(MODELS);
  const serial = (vendor === 'Dell Inc.' ? 'D' : vendor === 'HP' ? 'H' : 'L') +
                 Math.floor(rnd() * 9e6 + 1e6).toString(36).toUpperCase() + pad(id, 4);
  const checkIn = daysAgo(opts.staleDays !== undefined ? opts.staleDays : int(0, 12));
  const audit = daysAgo(opts.fsAuditDays !== undefined ? opts.fsAuditDays : int(0, 20));
  return { id, name, site, person, model, vendor, serial, checkIn, audit, opts };
}

function pushFs(d, over = {}) {
  fsRows.push(Object.assign({
    'Display Name': d.name,
    'Asset Tag': 'IVL-' + pad(d.id, 5),
    'Asset Type': 'Computer',
    'Asset State': 'In Use',
    'Used By': d.person.name,
    'Used By Email': d.person.upn,
    'Location': d.site[0],
    'Department': d.site[8] === 'Office' ? 'Corporate Services' : 'Operations',
    'Product': d.model,
    'Vendor': d.vendor,
    'Serial Number': d.serial,
    'OS': 'Windows 11',
    'OS Version': '10.0.22631',
    'Last Audit Date': ukDate(d.audit),
    'Created Time': ukDate(daysAgo(int(200, 900)))
  }, over));
}

function pushIntune(d, over = {}) {
  intuneRows.push(Object.assign({
    'Device name': d.name,
    'Managed by': 'MDM',
    'Ownership': 'Corporate',
    'Compliance': 'Compliant',
    'OS': 'Windows',
    'OS version': '10.0.26100.1742',
    'Primary user UPN': d.person.upn,
    'Primary user display name': d.person.name,
    'Last check-in': isoDate(d.checkIn),
    'Serial number': d.serial,
    'Manufacturer': d.vendor,
    'Model': d.model,
    'Intune Device ID': 'a' + pad(d.id, 6) + '-3f2b-4c1d-9e8a-' + pad(d.id * 7, 12),
    'Category': 'Staff device',
    'Encrypted': 'Yes'
  }, over));
}

/* ---- the clean majority ---------------------------------------------- */
SITES.forEach(site => {
  const count = Math.max(3, Math.round(site[6] * (0.6 + rnd() * 0.6)));
  for (let i = 0; i < count; i++) {
    const d = newDevice(site);
    pushFs(d);
    pushIntune(d);
  }
});

/* ---- deliberate problems --------------------------------------------- */

// User differs between the two systems (someone left, device reassigned).
for (let i = 0; i < 9; i++) {
  const d = newDevice(pick(SITES));
  const other = pick(people);
  pushFs(d);
  pushIntune(d, { 'Primary user UPN': other.upn, 'Primary user display name': other.name });
}

// Freshservice has no user, Intune does.
for (let i = 0; i < 11; i++) {
  const d = newDevice(pick(SITES));
  pushFs(d, { 'Used By': '', 'Used By Email': '' });
  pushIntune(d);
}

// Freshservice holds a login name, Intune the display name - same person.
for (let i = 0; i < 4; i++) {
  const d = newDevice(pick(SITES));
  pushFs(d, { 'Used By': d.person.first[0].toLowerCase() + d.person.last.toLowerCase() });
  pushIntune(d);
}

// No location at all.
for (let i = 0; i < 7; i++) {
  const d = newDevice(pick(SITES));
  pushFs(d, { 'Location': '' });
  pushIntune(d);
}

// A location that is not in the lookup file.
['Oakdene House', 'Old Head Office', 'Willow Bank'].forEach(loc => {
  for (let i = 0; i < 2; i++) {
    const d = newDevice(SITES[0]);
    pushFs(d, { 'Location': loc });
    pushIntune(d);
  }
});

// In Freshservice, never seen by Intune.
for (let i = 0; i < 13; i++) {
  const d = newDevice(pick(SITES), { fsAuditDays: int(60, 400) });
  pushFs(d, { 'Asset State': pick(['In Use', 'In Use', 'In Stock']) });
}

// In Intune, missing from Freshservice.
for (let i = 0; i < 8; i++) {
  const d = newDevice(pick(SITES));
  pushIntune(d);
}

// Stale: nothing heard for months.
for (let i = 0; i < 10; i++) {
  const d = newDevice(pick(SITES), { staleDays: int(45, 260) });
  pushFs(d);
  pushIntune(d);
}

// Marked retired or in stock, but plainly still in use.
for (let i = 0; i < 6; i++) {
  const d = newDevice(pick(SITES), { staleDays: int(0, 5) });
  pushFs(d, { 'Asset State': pick(['Retired', 'In Stock', 'Disposed']) });
  pushIntune(d);
}

// Serial numbers that disagree, and serials missing from Freshservice.
for (let i = 0; i < 4; i++) {
  const d = newDevice(pick(SITES));
  pushFs(d, { 'Serial Number': d.serial.split('').reverse().join('') });
  pushIntune(d);
}
for (let i = 0; i < 6; i++) {
  const d = newDevice(pick(SITES));
  pushFs(d, { 'Serial Number': '' });
  pushIntune(d);
}

// Non-compliant devices.
for (let i = 0; i < 5; i++) {
  const d = newDevice(pick(SITES));
  pushFs(d);
  pushIntune(d, { 'Compliance': 'Noncompliant', 'Encrypted': 'No' });
}

// A rebuilt machine whose old record was never retired.
{
  const d = newDevice(SITES[2]);
  pushFs(d);
  pushFs(d, { 'Asset Tag': 'IVL-' + pad(d.id + 5000, 5), 'Used By': pick(people).name,
              'Serial Number': d.serial + 'B', 'Last Audit Date': ukDate(daysAgo(300)) });
  pushIntune(d);
}

// Model recorded differently in the two systems.
for (let i = 0; i < 3; i++) {
  const d = newDevice(pick(SITES));
  pushFs(d, { 'Product': 'Dell Laptop' });
  pushIntune(d);
}

// Assets that are not computers - these stay out of the Intune comparison.
[['Network switch', 'Cisco', 'CBS350-24P'], ['Mobile phone', 'Apple', 'iPhone SE'],
 ['Printer', 'Brother', 'MFC-L3750CDW'], ['Monitor', 'Dell Inc.', 'P2422H']].forEach(kit => {
  SITES.slice(0, 6).forEach(site => {
    const d = newDevice(site);
    fsRows.push({
      'Display Name': kit[0].split(' ')[0].toUpperCase().slice(0, 3) + '-' + pad(d.id, 4),
      'Asset Tag': 'IVL-' + pad(d.id, 5),
      'Asset Type': kit[0],
      'Asset State': 'In Use',
      'Used By': '',
      'Used By Email': '',
      'Location': site[0],
      'Department': 'Operations',
      'Product': kit[2],
      'Vendor': kit[1],
      'Serial Number': 'K' + pad(d.id, 7),
      'OS': '',
      'OS Version': '',
      'Last Audit Date': ukDate(daysAgo(int(1, 40))),
      'Created Time': ukDate(daysAgo(int(100, 800)))
    });
  });
});

/* ---- location lookup -------------------------------------------------- */
const locRows = SITES.map(s => ({
  'Location': s[0], 'Address': s[1], 'Town': s[2], 'Postcode': s[3],
  'Latitude': s[4], 'Longitude': s[5], 'Expected Devices': s[6],
  'Region': s[7], 'Site Type': s[8]
}));
// One site in the lookup with no coordinates, to exercise the geocoding path.
locRows.push({ 'Location': 'Larchfield House', 'Address': '18 Larch Road', 'Town': 'Wigan',
               'Postcode': 'WN1 1XX', 'Latitude': '', 'Longitude': '', 'Expected Devices': 6,
               'Region': 'North West', 'Site Type': 'Residential' });

/* ---- write ------------------------------------------------------------ */
function csv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const cell = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers.join(',')].concat(rows.map(r => headers.map(h => cell(r[h])).join(','))).join('\n') + '\n';
}

const outDir = process.argv[2];
const fsCsv = csv(fsRows), inCsv = csv(intuneRows), locCsv = csv(locRows);

fs.writeFileSync(path.join(outDir, 'sample-data', 'freshservice-assets-sample.csv'), fsCsv);
fs.writeFileSync(path.join(outDir, 'sample-data', 'intune-devices-sample.csv'), inCsv);
fs.writeFileSync(path.join(outDir, 'sample-data', 'location-lookup-sample.csv'), locCsv);

const js = `/* Sample data for the "Load sample data" button.

   Entirely invented: fictional sites, fictional people, fictional serials.
   It is shaped like the real exports and carries the same kinds of problems
   on purpose, so the tool can be demonstrated without anyone's estate data.

   Generated by scripts/gen-sample.js - edit that, not this. */
window.SampleData = {
  freshservice: ${JSON.stringify(fsCsv)},
  intune: ${JSON.stringify(inCsv)},
  locations: ${JSON.stringify(locCsv)}
};
`;
fs.writeFileSync(path.join(outDir, 'js', 'sampledata.js'), js);

console.log('freshservice rows:', fsRows.length);
console.log('intune rows:', intuneRows.length);
console.log('location rows:', locRows.length);
