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

By default the loaded data is also **kept in that browser** so you can close the
tab and pick the work up later. That is a local database on your own machine,
not a server, and it can be switched off or wiped from Settings. See
[Settings and what is stored](#settings-and-what-is-stored).

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
`Asset State`, `Used By`, `Last Login By`, `Location`, `Department`, `Product`,
`Vendor`, `OS`, `IP Address`, `Last Audit Date`. Only the device name is
strictly required.

#### About "Last Login By"

This is **not** a Freshservice requester record. The Discovery Agent reads the
Windows logon name off the machine and stores it as the `sAMAccountName` — so it
tells you who actually signs in, but it is not an email address and there is no
UPN behind it in Freshservice to export. Adding UPN to the agent is an open
feature request with Freshworks, not a setting you can switch on.

On Entra-joined machines there is no on-premises `sAMAccountName`, so Windows
derives a local account name from the identity, strips the punctuation, and caps
it at 20 characters with a short random suffix for uniqueness. That is why
`patience.osemwegie@…` arrives as `PatienceOsem_yb1wybb` — twelve characters of
name, then `_` and seven random ones, twenty in total.

The tool handles all of these forms when comparing people:

| In the export | Matches |
|---|---|
| `PatienceOsemwegie` | Patience Osemwegie |
| `PatienceOsem_yb1wybb` | Patience Osemwegie (truncated, suffix stripped) |
| `tmensah` | Tomasz Mensah, and `TomaszMensah` |
| `patience.osemwegie@ivolve.care` | Patience Osemwegie |
| `john_smith` | John Smith (a real underscore, left alone) |

A suffix is only stripped when it looks random — it contains a digit, or the
whole string sits on the 20-character cap — so a genuine underscored name is not
mangled. A truncation only matches when the whole forename is present, and a
short stem is reported as *similar* rather than *equal* so you can eyeball it.

Because the value is an account name rather than an address, use it as
**evidence** that an assignment is wrong and take the corrected value from the
Intune primary user, which is a proper UPN. That is what the *Someone else logs
into it* check does.

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
| `IP Subnet` | The site's network range(s) — see below |
| `Address`, `Town`, `Postcode` | Used for geocoding and shown in site packs |
| `Latitude`, `Longitude` | Used directly if present — no lookup needed |
| `Expected Devices` | Drives the variance colouring and the "furthest from expected" chart |
| `Region` | Groups sites into areas |
| `Site Type`, `Contact` | Carried through for reference |

A worked example of each file is in [`sample-data/`](sample-data/).

### Locating devices by IP address

If your site list carries an `IP Subnet` column and the exports carry a last-seen
IP address, the tool can tell you which devices were last seen on a network
belonging to a *different* site than Freshservice has them assigned to. That is
the strongest evidence available that kit has physically moved, and it needs
nobody to walk round a building.

Subnets can be written as CIDR (`10.20.30.0/24`), a dotted mask
(`10.20.30.0/255.255.255.0`), a wildcard (`10.20.30.*`), a range
(`10.20.30.10-10.20.30.50`), or a bare network address, which is read as a `/24`.
A site with more than one range takes them all in the same cell, separated by
semicolons: `10.20.30.0/24; 10.20.31.0/24`.

Where the two systems disagree on the address, the tool uses whichever system
saw the device **most recently** — the point is where it is now, not where it
used to be.

Four outcomes, from an address the device was last seen on:

| Outcome | Meaning |
|---|---|
| In the assigned site's range | Nothing to do |
| In another site's range | **Moved** — high severity, and the location can be corrected from it |
| Names a site Freshservice doesn't | No location recorded, or one missing from the lookup |
| Matches no site range | Off the site network |

**Remote workers are handled by not crying wolf.** A device on a home
`192.168.x.x` range, or any private address matching none of your sites, is
reported as *off the site network* at low severity — not as having moved. It
means the machine was last used somewhere that isn't one of your buildings,
which for a remote worker is simply true and needs no action. Only an address
inside a *different site's* range raises the high-severity flag, because that is
the case where the asset register is genuinely wrong.

Sites with no subnet recorded are not checked rather than guessed at. The
dashboard shows how much of the estate the check actually covers, and a
device-level list is available by turning on **Assigned site has no subnet
recorded** in Settings.

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
| Someone else logs into it | Medium | The account signing in is not the assigned person |
| No user anywhere | Medium | Marked in use, but nobody is recorded |
| No location set | High | The asset has no location at all |
| Location not in lookup | Medium | The location is not a site the lookup knows |
| Not checked in recently | Medium | Intune silence for longer than the threshold |
| Freshservice agent silent | Low | The agent has stopped auditing |
| Retired but still in use | High | Marked retired or in stock, yet checking in |
| In use but silent | Medium | Marked in use, but long gone quiet |
| Serial number differs | Medium | Matched on name, but the serials disagree |
| No serial in Freshservice | Low | Blocks reliable future matching |
| Model / OS differs | Low | Inventory drift — **off by default**, see below |
| Duplicate device name | Medium | Usually a rebuild whose old record was never retired |
| Not compliant in Intune | Medium | Intune reports a policy failure |
| Site confirmed a different location | High | From a returned verification sheet |
| Site reported device missing | High | From a returned verification sheet |

**Model differs** and **OS differs** ship switched off. The two systems populate
those fields from different agents — Freshservice discovery typically records
`Windows 11` and a full product name where Intune reports `Windows` and its own
model string — so they disagree on almost every device without anything being
wrong. Flagging that is noise, and acting on it would overwrite the better data.
Turn them on in Settings only if you have deliberately aligned how both systems
name hardware.

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

**Which devices.** The file covers either the view you were just looking at
(including any site or issue filter you had set) or the whole estate. Coming in
via **Build import file** from the Devices tab selects the current view; the
choice is at the top of the page, with the device count beside each option.

**What to update.** For each field, choose whether to correct it and where the
correct value comes from — Intune, a site verification return, or a fixed value.
The preview lists every proposed change with the current value beside the new
one, and the reason it is being proposed. Nothing is included unless it would
actually change, so a field where the two systems already agree produces no
column.

**Columns on every row.** Freshservice rejects an asset import that is missing
a mandatory field, so some columns have to be present whether or not they are
what you are correcting. The tool ships with the three a stock instance
requires:

| Column | Value |
|---|---|
| `Workspace` | fixed, `IT` |
| `Name` | the Display Name from Freshservice |
| `Product` | the Product already recorded in Freshservice |

Each row's heading and its value are editable, and you can add more for an
instance that mandates others. A column takes a fixed value, **any field
Freshservice holds, or any field Intune holds** — the picker is grouped by
system. If one of the required three is missing, the page says so before you
download, and it warns when a column would be blank on some rows.

**Which system is authoritative is per column, and the tool won't guess.**
`Product` defaults to the Freshservice value on purpose: Freshservice populates
it from its own discovery agent and Intune reports hardware separately, so
copying Intune over it would rewrite good data on every row. The assigned user
is the opposite — Intune is the fresher of the two. Set each column to whichever
system is right for it.

A column's declared source is what it gets; a correction never silently
overrides it. If you switch on a correction for a field that a column also
names, the column wins and the page says so, so a correction can't disappear
without explanation. Duplicate headings collapse to one column, so making `Name`
the match column doesn't produce two.

If nothing comes out, the page says which switched-off fields would produce
changes for those devices, and how many, with a button to turn each one on.
The most significant field is offered first — a wrong asset state ranks above a
cosmetic OS difference, however many rows the latter touches.

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
- **"Skip assets already marked retired or disposed" has one exception.** It
  leaves alone assets that really are dead, but not the ones flagged *retired
  but still in use* — correcting those is the entire point of that check, so
  they stay in.

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

Two separate things are stored, both on your own machine:

**Settings** — column mappings, thresholds, saved views, import configuration
and geocoding results — live in the browser's local storage. Small, and not
sensitive.

**The working set** — the actual rows from your exports — is kept in a local
database (IndexedDB) in the same browser, so closing the tab and coming back
tomorrow picks up where you left off, with your files, your settings and your
filters intact. This is on by default and holds real device and user data.
It stays in that browser profile on that machine: it is not uploaded, and
someone signing in on another machine sees nothing.

Turn it off with **Keep the loaded data in this browser between visits** in
Settings, which also wipes what is already stored; the tab you have open keeps
working. **Clear and start again** on the Data tab does both at once. If the
browser blocks local databases, the tool says so and falls back to holding data
in the open tab only.

Bear in mind what that means in practice: on a shared or kiosk machine, the next
person using the same browser profile opens the tool and sees your estate. Turn
the setting off there, or clear it when you finish.

**Save project** is the separate, deliberate export: it writes everything
currently loaded to a `.json` file you choose, for handing work to a colleague
or moving between machines. Treat that file the way you would treat the original
exports.

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
│   ├── ipnet.js            IPv4 parsing and site-subnet matching
│   ├── match.js            the reconciliation engine
│   ├── rules.js            the discrepancy checks
│   ├── views.js            columns, the filter engine, built-in views
│   ├── table.js            the data grid and the detail drawer
│   ├── charts.js           inline-SVG bar charts
│   ├── map.js              Leaflet map and site aggregation
│   ├── geocode.js          postcodes.io and Nominatim lookups
│   ├── fsexport.js         import file, change log and site packs
│   ├── store.js            local storage for settings
│   ├── db.js               IndexedDB store for the loaded working set
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
