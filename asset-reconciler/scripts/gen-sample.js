/* Generates the sample CSVs used by the "Load sample data" button.
   Deterministic, so re-running produces identical files. */
const fs = require('fs');
const path = require('path');

let seed = 20260828;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }
function int(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }

/* Each site gets a /24. Two are deliberately left without one so the tool has
   something to report as unchecked. */
function subnetFor(i) { return i >= 10 ? '' : '10.' + (20 + i) + '.10.0/24'; }

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

const FIRST = ['Sarah','James','Aisha','Michael','Priya','David','Emma','Tomasz','Grace','Daniel','Chloe','Ibrahim','Rachel','Liam','Nia','Peter','Zoe','Callum','Fatima','Owen','Hannah','Marcus','Leah','Joseph','Christopher','Alexandra','Bartholomew'];
const LAST  = ['Bennett','Okafor','Kaur','Thompson','Patel','Walsh','Nowak','Ahmed','Robinson','Fletcher','Mensah','Doyle','Hughes','Sinclair','Byrne','Marsh','Ellis','Quinn','Adeyemi','Barlow','Chapman','Frost','Osemwegie','Featherstonehaugh','Abernathy'];

const MODELS = [
  ['Latitude 5440', 'Dell Inc.'], ['Latitude 3540', 'Dell Inc.'], ['OptiPlex 7010', 'Dell Inc.'],
  ['EliteBook 640 G10', 'HP'], ['ProDesk 400 G9', 'HP'], ['ThinkPad L14 Gen 4', 'LENOVO'],
  ['Surface Laptop 5', 'Microsoft Corporation']
];

function pad(n, w) { return String(n).padStart(w, '0'); }

/* The Windows logon name the discovery agent reads off the machine. Entra-joined
   devices cap it at 20 characters and add a random uniqueness suffix, so long
   names arrive truncated and mangled - which is what the matcher has to cope
   with. */
function logonName(person) {
  const joined = person.first + person.last;
  if (joined.length <= 20) return joined;
  const suffix = '_' + Math.floor(rnd() * 1e10).toString(36).slice(0, 7);
  return joined.slice(0, 20 - suffix.length) + suffix;
}

function siteIp(i) {                       // an address inside site i's range
  return '10.' + (20 + i) + '.10.' + int(20, 240);
}
function homeIp() {                        // a remote worker's own broadband
  return '192.168.' + pick([0, 1, 8, 50]) + '.' + int(2, 250);
}
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
  const siteIdx = SITES.indexOf(site);
  const ip = opts.ip !== undefined ? opts.ip
           : (subnetFor(siteIdx) ? siteIp(siteIdx) : homeIp());
  return { id, name, site, person, model, vendor, serial, checkIn, audit, ip, siteIdx, opts };
}

function pushFs(d, over = {}) {
  fsRows.push(Object.assign({
    'Display Name': d.name,
    'Asset Tag': 'IVL-' + pad(d.id, 5),
    'Asset Type': 'Computer',
    'Asset State': 'In Use',
    'Used By': d.person.name,
    'Used By Email': d.person.upn,
    'Last Login By': d.opts.logon !== undefined ? d.opts.logon : logonName(d.person),
    'Location': d.site[0],
    'Department': d.site[8] === 'Office' ? 'Corporate Services' : 'Operations',
    'Product': d.model,
    'Vendor': d.vendor,
    'Serial Number': d.serial,
    'OS': 'Windows 11',
    'OS Version': '10.0.22631',
    'IP Address': d.ip,
    'MAC Address': macFor(d.id),
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
    'IP Address': d.ip,
    'MAC Address': macFor(d.id),
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

// Assigned to one person, but somebody else signs in - the account name is the
// only clue, and it arrives in Windows' mangled form.
for (let i = 0; i < 8; i++) {
  const d = newDevice(pick(SITES));
  const other = pick(people);
  pushFs(d, { 'Last Login By': logonName(other) });
  pushIntune(d, { 'Primary user UPN': other.upn, 'Primary user display name': other.name });
}

// Last seen on another site's network: the device has physically moved.
for (let i = 0; i < 9; i++) {
  const home = SITES[int(0, 9)];
  let elsewhere = SITES[int(0, 9)];
  while (elsewhere === home) elsewhere = SITES[int(0, 9)];
  const d = newDevice(home, { ip: siteIp(SITES.indexOf(elsewhere)) });
  pushFs(d);
  pushIntune(d);
}

// Remote workers on their own broadband.
for (let i = 0; i < 12; i++) {
  const d = newDevice(pick(SITES), { ip: homeIp() });
  pushFs(d);
  pushIntune(d);
}

// No location in Freshservice, but the address names a site.
for (let i = 0; i < 5; i++) {
  const idx = int(0, 9);
  const d = newDevice(SITES[idx], { ip: siteIp(idx) });
  pushFs(d, { 'Location': '' });
  pushIntune(d);
}

// Freshservice holds an older address than Intune - the newer one should win.
for (let i = 0; i < 4; i++) {
  const idx = int(0, 9);
  const d = newDevice(SITES[idx], { ip: siteIp(idx), fsAuditDays: 30, staleDays: 1 });
  pushFs(d, { 'IP Address': siteIp((idx + 3) % 10) });
  pushIntune(d);
}

// No address recorded at all.
for (let i = 0; i < 6; i++) {
  const d = newDevice(pick(SITES), { ip: '' });
  pushFs(d, { 'IP Address': '' });
  pushIntune(d, { 'IP Address': '' });
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
      'IP Address': d.ip,
      'OS': '',
      'OS Version': '',
      'Last Audit Date': ukDate(daysAgo(int(1, 40))),
      'Created Time': ukDate(daysAgo(int(100, 800)))
    });
  });
});

/* ---- Arctic Wolf vulnerability scan ------------------------------------
   Shaped like the real export: a UUID asset id, the device name, a risk score
   out of 10 and a count of open findings, with a scan date that is sometimes
   well behind the last-seen date. Most machines are covered; some deliberately
   are not, and a couple are scanned that neither other system knows about. */
const awRows = [];
function macFor(id) {
  const h = (n) => n.toString(16).padStart(2, '0');
  return [0x30, 0xf6, (id >> 8) & 255, id & 255, (id * 7) & 255, (id * 13) & 255].map(h).join(':');
}
function awRow(name, ip, opts = {}) {
  const id = n++;
  const risks = opts.risks !== undefined ? opts.risks : int(0, 180);
  // A high score means something severe is open, which is not the same as a
  // long tail of minor findings - so the two are only loosely related.
  const score = opts.score !== undefined ? opts.score
              : (risks > 900 ? 9.9 : risks > 400 ? pick([8.8, 9.1, 9.9]) : pick([3.9, 5.5, 6.8, 7.5]));
  const seen = daysAgo(int(0, 4));
  const scan = daysAgo(opts.scanDays !== undefined ? opts.scanDays : int(0, 10));
  return {
    'Asset ID': [8,4,4,4,12].map(len => Math.floor(rnd() * 16 ** Math.min(len, 8))
      .toString(16).padStart(len, '0').slice(0, len)).join('-'),
    'Device Name': name,
    'Asset State': 'Active',
    'Low Signal': 'No',
    'Category': 'Desktop',
    'Tags': '',
    'Sources': 'Agent',
    'Asset Criticality': opts.criticality || 'Unassigned',
    'Last Successful Scan': isoDate(scan),
    'Last Seen': isoDate(seen),
    'IP Addresses': ip || '',
    'MAC Address': macFor(id),
    'Hostname': name,
    'NetBIOS': '',
    'Operating System': 'Name: Microsoft Windows 11 Enterprise, Version: 10.0.26100',
    'OS Type': 'windows',
    'Manufacturer': '',
    'Risks': risks,
    'Risk Score': score
  };
}

// Scan most of the machines Intune knows about.
const scanned = intuneRows.filter(() => rnd() > 0.18);
scanned.forEach((d, i) => {
  let opts = {};
  if (i < 6) opts = { risks: int(950, 2100), score: 9.9 };            // the worst offenders
  else if (i < 14) opts = { risks: int(420, 900) };                    // badly behind on patching
  else if (i % 17 === 0) opts = { scanDays: int(40, 120) };            // scan long out of date
  awRows.push(awRow(d['Device name'], d['IP Address'], opts));
});

// Two machines scanned that neither other system holds.
awRows.push(awRow('ivolve-d9911zz', '10.20.10.201', { risks: 640 }));
awRows.push(awRow('shr-unknown01', '10.24.10.44', { risks: 88 }));

/* ---- location lookup -------------------------------------------------- */
const locRows = SITES.map((s, i) => ({
  'Location': s[0], 'Address': s[1], 'Town': s[2], 'Postcode': s[3],
  'IP Subnet': subnetFor(i),
  'Latitude': s[4], 'Longitude': s[5], 'Expected Devices': s[6],
  'Region': s[7], 'Site Type': s[8]
}));
// One site in the lookup with no coordinates, to exercise the geocoding path.
locRows.push({ 'Location': 'Larchfield House', 'Address': '18 Larch Road', 'Town': 'Wigan',
               'IP Subnet': '10.90.10.0/24',
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
const fsCsv = csv(fsRows), inCsv = csv(intuneRows), locCsv = csv(locRows), awCsv = csv(awRows);

fs.writeFileSync(path.join(outDir, 'sample-data', 'freshservice-assets-sample.csv'), fsCsv);
fs.writeFileSync(path.join(outDir, 'sample-data', 'intune-devices-sample.csv'), inCsv);
fs.writeFileSync(path.join(outDir, 'sample-data', 'location-lookup-sample.csv'), locCsv);
fs.writeFileSync(path.join(outDir, 'sample-data', 'arctic-wolf-sample.csv'), awCsv);

const js = `/* Sample data for the "Load sample data" button.

   Entirely invented: fictional sites, fictional people, fictional serials.
   It is shaped like the real exports and carries the same kinds of problems
   on purpose, so the tool can be demonstrated without anyone's estate data.

   Generated by scripts/gen-sample.js - edit that, not this. */
window.SampleData = {
  freshservice: ${JSON.stringify(fsCsv)},
  intune: ${JSON.stringify(inCsv)},
  locations: ${JSON.stringify(locCsv)},
  arcticwolf: ${JSON.stringify(awCsv)}
};
`;
fs.writeFileSync(path.join(outDir, 'js', 'sampledata.js'), js);

console.log('freshservice rows:', fsRows.length);
console.log('intune rows:', intuneRows.length);
console.log('location rows:', locRows.length);
console.log('arctic wolf rows:', awRows.length);
