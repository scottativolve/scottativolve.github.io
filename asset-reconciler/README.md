# Asset Reconciler — Freshservice ↔ Intune

A browser tool for reconciling the Freshservice asset register against Intune.
Drop in the two exports (plus a location lookup), and it matches the records,
flags everything the two systems disagree about, drives the views you send out
to services, builds the Freshservice import that corrects the data, and plots
the estate on a map.

It replaces the export-to-CSV, VLOOKUP, filter, re-export cycle.

**Everything runs in the browser.** The files are read by JavaScript in the
page; no device or user data is uploaded anywhere, and there is no server
component. The one exception is optional geocoding, which sends *site addresses
only* — never device or user data — and only when you press the button.

---

## Contents

- [Getting started](#getting-started)
- [The three input files](#the-three-input-files)
- [How records are matched](#how-records-are-matched)
- [What it checks for](#what-it-checks-for)
- [The working views](#the-working-views)
- [The site verification loop](#the-site-verification-loop)
- [Building the Freshservice import](#building-the-freshservice-import)
- [The map](#the-map)
- [Other asset types](#other-asset-types)
- [Settings and what is stored](#settings-and-what-is-stored)
- [Where to host it](#where-to-host-it)
- [Working on the code](#working-on-the-code)

---

## Getting started

Open the tool and press **Load sample data** on the Data tab. That fills it with
made-up devices across made-up sites, with the usual problems built in, so you
can see every screen working before you put real data anywhere near it.

When you are ready, drop your own exports on the same page.

---

## The three input files

Drop all of them on the big box at the top and the tool works out which is
which from the column headings. If a file is not recognised, drop it on the
labelled box instead.

Column names are never hard-coded. Each file is auto-mapped, and **Check
columns** shows what was matched to what, with an example value from your data,
so you can correct anything it got wrong. Corrections are remembered for any
future export with the same columns.

### 1. Freshservice assets

Assets → filter to what you want → Export → CSV.

Useful columns: `Display Name`, `Asset Tag`, `Serial Number`, `Asset Type`,
`Asset State`, `Used By`, `Location`, `Department`, `Product`, `Vendor`, `OS`,
`Last Audit Date`. Only the device name is strictly required.

### 2. Intune devices

Intune admin centre → Devices → All devices → Export.

Useful columns: `Device name`, `Serial number`, `Primary user display name`,
`Primary user UPN`, `OS`, `OS version`, `Model`, `Manufacturer`,
`Last check-in`, `Compliance`, `Ownership`. Only the device name is required.

### 3. Location lookup (optional, but it unlocks the map)

One row per site. The location name must match what Freshservice holds.

| Column | Notes |
|---|---|
| `Location` | **Required.** Exactly as it appears in Freshservice |
| `Address`, `Town`, `Postcode` | Used for geocoding and shown in site packs |
| `Latitude`, `Longitude` | Used directly if present — no lookup needed |
| `Expected Devices` | Drives the variance colouring and the "furthest from expected" chart |
| `Region` | Groups sites into areas |
| `Site Type`, `Contact` | Carried through for reference |

A worked example of each file is in [`sample-data/`](sample-data/).

If your Freshservice locations are stored as a hierarchy (`North West >
Ashfield House`), set **Settings → How to read Freshservice locations** to
match.

---

## How records are matched

Two passes, in order:

1. **Serial number.** The strongest signal — it survives a rename or a rebuild.
   Placeholder serials (`0000000`, `To Be Filled By O.E.M.` and friends) are
   ignored rather than matched to each other.
2. **Device name.** Normalised first: case, whitespace, `DOMAIN\HOST` prefixes
   and FQDN suffixes are all stripped.

Anything left over is reported as being in one system only. The **Matched on**
column tells you which pass caught each row, and either pass can be turned off
in Settings.

People are compared rather than string-matched, because the two systems store
them differently. `Smith, John`, `John Smith`, `jsmith` and
`john.smith@…` are all recognised as the same person; a shared surname with a
different forename is flagged as *similar* rather than *different*, so you can
eyeball those before bulk-updating.

---

## What it checks for

Each check can be switched off in Settings, and every threshold is adjustable.

| Check | Severity | What it means |
|---|---|---|
| Not in Intune | High | Freshservice holds it, Intune has never seen it |
| Not in Freshservice | High | Intune manages it, no asset record exists |
| Assigned user differs | High | The two systems name different people |
| No user in Freshservice | Medium | Intune knows the user, the asset is unassigned |
| No user anywhere | Medium | Marked in use, but nobody is recorded |
| No location set | High | The asset has no location at all |
| Location not in lookup | Medium | The location is not a site the lookup knows |
| Not checked in recently | Medium | Intune silence for longer than the threshold |
| Freshservice agent silent | Low | The agent has stopped auditing |
| Retired but still in use | High | Marked retired or in stock, yet checking in |
| In use but silent | Medium | Marked in use, but long gone quiet |
| Serial number differs | Medium | Matched on name, but the serials disagree |
| No serial in Freshservice | Low | Blocks reliable future matching |
| Model / OS differs | Low | Inventory drift |
| Duplicate device name | Medium | Usually a rebuild whose old record was never retired |
| Not compliant in Intune | Medium | Intune reports a policy failure |
| Site confirmed a different location | High | From a returned verification sheet |
| Site reported device missing | High | From a returned verification sheet |

---

## The working views

Views are filtered lists down the left-hand side. The built-in ones cover the
routine work — *Fix: assigned user*, *Fix: location*, *Missing from Intune*,
*Stale devices*, *Status conflicts*, and so on.

Press **+** next to Views to build your own from any field, any issue, and any
combination of conditions ("region is North West **and** no user in
Freshservice"). Saved views appear in the sidebar for whoever is using that
browser.

To share a set of views with colleagues, use **Settings → Export configuration**
and have them import the file. That carries your views, thresholds and import
settings, and nothing else.

Every view can be exported to CSV with whatever columns you have chosen, so a
view is also the way you hand a list to somebody who does not use the tool.

---

## The site verification loop

This is the workflow for "go and check where these actually are":

1. Pick a view — usually *Fix: location* or *Site verification pack* — and turn
   on **Group by site**.
2. **Site check sheet** exports what Freshservice believes, per site, with blank
   `Device present?`, `Confirmed location`, `Confirmed user`, `Confirmed status`
   and `Notes` columns for the service to complete. Each site group also has its
   own export button, so services get only their own devices.
3. Send them out. Get them back.
4. Drop the completed sheets back in, on the **Verification returns** box.

What the site told you now shows on each device, raises its own flags where it
contradicts Freshservice, and — importantly — becomes available as a source of
truth in the import builder. So the answers you got back turn straight into the
correction file.

---

## Building the Freshservice import

The **Freshservice import** tab is where corrections become an upload.

For each field, choose whether to update it and where the correct value comes
from — Intune, a site verification return, or a fixed value. The preview lists
every proposed change with the current value beside the new one, and the reason
it is being proposed. Nothing is included unless it would actually change.

Two files come out:

- **The import file** — the match column plus one column per corrected field,
  and only the rows that change. No BOM, so the column names arrive clean.
- **The change log** — old value, new value, source and reason for every change,
  for the audit trail.

Three things worth knowing:

- **Check the column headings against your own instance.** They are editable at
  the top of each column and remembered. A custom field will use its own label.
- **Pick a match column that is filled in and unique** on the assets you are
  updating. Device name is the default; asset tag is safer if your names repeat.
- **Spot-check before you upload.** Read a few rows of the change log. The tool
  is confident about what the two systems say; it cannot know which one is right.

---

## The map

Each site is a dot, with the **area** of the dot proportional to the number of
devices recorded there. Colour is switchable:

- **Device count only** — one colour; size carries everything.
- **Variance vs expected** — red where there are more devices than the lookup's
  `Expected Devices` says there should be, blue where there are fewer. This is
  the view for finding services holding more kit than they should.
- **Share of devices with issues** — darker where a higher proportion of that
  site's devices are flagged.

Clicking a dot filters the device table to that site.

Sites that cannot be drawn are never silently dropped — they are counted and
listed underneath, split into "in the lookup but no coordinates" and "used in
Freshservice but not in the lookup at all".

### Coordinates

Supply `Latitude` and `Longitude` in the lookup and the map draws immediately,
with no network calls.

Otherwise, **Find missing coordinates** looks them up:

- UK postcodes go to [postcodes.io](https://postcodes.io) in bulk — free, no
  account, no rate limit worth worrying about.
- Anything without a usable postcode can optionally be searched by address via
  OpenStreetMap's Nominatim, which is throttled to one site per second in line
  with its usage policy. That one is off by default.

Only address text is sent. Results are cached in the browser, and **Export
lookup** saves your lookup file with the coordinates filled in — do that once
and the job never needs repeating.

Map background tiles come from OpenStreetMap, so the map itself needs internet
access. Everything else in the tool works offline.

---

## Other asset types

Freshservice exports usually contain more than computers. Anything whose asset
type does not look like a computer — network hardware, phones, printers,
screens — is kept, counted and mapped, but **not** compared against Intune,
since it was never going to be there. Those records appear under the *Other
asset types* view.

The list of types treated as computers is a setting, so you can widen or narrow
it. This is also the hook for bringing more asset classes onto the map later:
they already flow through the location lookup and appear on the map with the
**Include non-computer assets** toggle.

---

## Settings and what is stored

The tool keeps your column mappings, thresholds, saved views, import settings
and geocoding results in the browser's local storage. Device data is never
written to disk.

The deliberate exception is **Save project**, which writes everything currently
loaded — including the device data — to a `.json` file you choose, so you can
close the tab and pick the work up later, or hand the whole state to a
colleague. Treat that file the way you would treat the original exports.

If your browser blocks local storage, the tool says so in Settings and falls
back to keeping settings for the session only.

---

## Where to host it

It is a static site — no build step, no server, no database.

- **Any web server or static host.** Copy the `asset-reconciler/` folder.
- **GitHub Pages.** Serves the folder as-is at `/asset-reconciler/`. Note that
  on a GitHub Enterprise Cloud tenant with managed users, Pages sites are always
  private, so viewers need an enterprise seat — which is fine for IT, but not if
  you want service managers opening it themselves.
- **No hosting at all.** `dist/asset-reconciler.html` is the whole tool in one
  self-contained file. Put it on a file share, email it, or open it from
  Downloads; it works from `file://`. This is usually the easiest way to get it
  in front of people who do not have a GitHub account.

---

## Working on the code

No build tooling and no dependencies to install. Edit the files and reload.

```
asset-reconciler/
├── index.html              page shell and script order
├── css/app.css             all styling, light and dark themes
├── js/
│   ├── util.js             DOM, dates, formatting, downloads, toasts
│   ├── csv.js              CSV/TSV parser and writer, optional .xlsx reader
│   ├── schema.js           canonical fields and the column auto-mapper
│   ├── normalize.js        name, serial, person and location normalisation
│   ├── match.js            the reconciliation engine
│   ├── rules.js            the discrepancy checks
│   ├── views.js            columns, the filter engine, built-in views
│   ├── table.js            the data grid and the detail drawer
│   ├── charts.js           inline-SVG bar charts
│   ├── map.js              Leaflet map and site aggregation
│   ├── geocode.js          postcodes.io and Nominatim lookups
│   ├── fsexport.js         import file, change log and site packs
│   ├── store.js            local storage
│   └── sampledata.js       generated — do not edit by hand
├── lib/leaflet/            Leaflet 1.9.4, vendored so there is no CDN dependency
├── sample-data/            example input files
├── scripts/                sample-data generator and single-file build
└── dist/                   the single-file build
```

To add a check, add an entry to `RULES` in `js/rules.js`; it appears in the
dashboard, the filters, the settings list and the row detail automatically. To
add a column, add one to `COLUMNS` in `js/views.js`.

Two scripts, both plain Node with no dependencies:

```sh
node scripts/gen-sample.js .        # regenerate the sample data
node scripts/build-single-file.js   # rebuild dist/asset-reconciler.html
```

Rebuild the single-file version after any change to `js/`, `css/` or
`index.html`, or it will drift from the source.

### Third-party code

[Leaflet](https://leafletjs.com) 1.9.4, BSD-2-Clause, vendored under
`lib/leaflet/` with its licence. The `.xlsx` reader (SheetJS) is loaded from
a CDN only if you actually drop a spreadsheet in; if it cannot be reached, the
tool says so and asks for a CSV.
