# Asset Reconciler — Freshservice ↔ Intune ↔ FortiManager

A browser tool for reconciling the Freshservice asset register against the
systems that actually know what is on the network. Drop in the exports (plus a
location lookup), and it matches the records, flags everything the systems
disagree about, drives the views you send out to services, builds the
Freshservice import that corrects the data, and plots the estate on a map.

It handles **two separate populations**, reconciled independently:

| Population | Compared against | Answers |
|---|---|---|
| **PCs** | Freshservice ↔ Intune ↔ Arctic Wolf | who has it, where is it, is it stale, is it at risk |
| **Network assets** | FortiManager ↔ Freshservice | what has been added since, what has been replaced, what firmware is recorded |

They share the site list, the map, the notes and the duplicate finder, but they
have their own tabs, views, checks and import builder — a firewall and a laptop
have almost nothing in common to compare.

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
- [The input files](#the-input-files)
- [Network assets](#network-assets)
- [How records are matched](#how-records-are-matched)
- [What it checks for](#what-it-checks-for)
- [The working views](#the-working-views)
- [The site verification loop](#the-site-verification-loop)
- [Building the Freshservice import](#building-the-freshservice-import)
- [The map](#the-map)
- [Network assets](#network-assets)
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

## The input files

Drop all of them on the big box at the top and the tool works out which is
which from the column headings. If a file is not recognised, drop it on the
labelled box instead.

Column names are never hard-coded. Each file is auto-mapped, and **Check
columns** shows what was matched to what, with an example value from your data,
so you can correct anything it got wrong. Corrections are remembered for any
future export with the same columns.

The dialog lists any field it could not match, since an unmatched field shows as
blank in the views rather than announcing itself. **Detect again** throws away
the remembered choices and re-reads the headings, which is the way out of a
mapping that has gone stale.

When the tool gains a new field, a mapping remembered from before — including
the one inside a kept working set — says nothing about it. Those gaps are filled
by re-detection on load and the new matches are named in a message, so a column
added to the tool starts working without you re-importing. A field you
deliberately left unmapped stays unmapped.

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

### 3. Arctic Wolf vulnerability scan (optional)

The asset export from Arctic Wolf, carrying `Risk Score` and `Risks` per device.

Useful columns: `Device Name`, `Hostname`, `Risk Score`, `Risks`,
`Last Successful Scan`, `Last Seen`, `IP Addresses`, `MAC Address`,
`Asset Criticality`, `Category`. Only the device name is required.

**How it joins.** Arctic Wolf carries no serial number, so it matches on device
name first and **MAC address** second — which means a machine Arctic Wolf knows
under a different name still joins, provided one of the other exports carries
its MAC. Include the MAC column in your Freshservice or Intune export to get
that fallback; without it, the join is name-only.

A scan record matching nothing becomes a row in its own right rather than being
dropped, flagged as *Scanned but not in either system* — worth knowing, since it
means something is on the network that neither the asset register nor Intune
holds.

The scan is also a third sighting of the device, so its IP and timestamp join
the [location-by-IP](#locating-devices-by-ip-address) check on the same "most
recently seen wins" basis as the other two.

### 4. Location lookup (optional, but it unlocks the map)

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

### 5. FortiManager managed devices (optional)

Device Manager → Table View → Export, with every column included. Drop **both**
environments on the same box if you have more than one. See
[Network assets](#network-assets) — this file is a rendered tree and needs
explaining properly.

### 6. Freshservice network assets (optional)

The network asset export, which has a different column set from the PC one
(`Physical Subtype`, `Ports`, `Subnet Mask`, `Firmware Version`). Keep it as a
separate export from the PC file — the tool tells the two apart by their
columns, but a single export containing both makes the PC reconciliation report
switches as missing from Intune.

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

**This column is the data VLAN — the range the PCs sit on.** It is used only
for the PC population, which is correct: network equipment lives on a different
range, so the same column cannot place a switch. Network assets take their site
from the FortiManager device name instead, and never from an IP address. If you
add a management range to the site list later it will be read as a separate
column rather than overloading this one.

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

### Reading a file you have loaded

**View file**, beside *Check columns* on each loaded source, shows the file
exactly as it was parsed — every column under its own heading, with the field
it feeds named underneath, before any mapping is applied. It is the answer to
"is that really what the export said?".

It is searchable across every column, paged, and can export just what you are
looking at. Two details worth knowing:

- FortiManager's **tree indentation is shown**, so the firewall / `FSW` / switch
  structure is visible in the raw rows as well as in the reconciliation.
- A source loaded from more than one file gets a **file selector**, and the
  *Line* column is the line within that row's own file, so it points at the
  right place in the right export.

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

**Both populations work the same way.** *Device views* and *Network views* are
separate sections with separate lists, but the same builder, the same read-only
inspection of built-ins, the same *Save as a copy*, and the same **+** for a new
one. A network view filters on network columns and network checks — *Not in
Freshservice*, *HA member out of sync*, *Site looks wrong* — rather than the PC
ones.

Press **+** next to either section to build your own from any field, any issue,
and any combination of conditions ("region is North West **and** no user in
Freshservice"). Saved views appear in the sidebar for whoever is using that
browser.

### Keeping the sidebar usable

With thirty-odd views across the two populations the list gets long, so:

- **Every section collapses.** Click its heading to fold it away; the tool
  remembers which are closed.
- **Star a view to make it a favourite.** Starred views from both populations
  gather in a **Favourites** section at the top, tagged *PC* or *Net* so it is
  clear which list each one belongs to. The section only appears once you have
  starred something.

**Every view can be opened and read.** The gear beside a view in the sidebar,
or the button above the list, shows how it is defined, with a live count of how
many devices match as you change it:

- **Your own views** open for editing — change the conditions, the name or the
  description and save over it.
- **Built-in views** open read-only, so you can see exactly what
  *Status conflicts* or *Stale devices* actually tests. **Save as a copy** turns
  one into an ordinary custom view you can then edit freely, which is usually
  the quickest way to build something close to a built-in but not quite.

One built-in, *Other asset types*, is driven by code rather than conditions —
it lists Freshservice assets whose type falls outside the computer types in
Settings — so it can be read but not copied, and the dialog says so.

Columns are separate from conditions: set them with the **Columns** button on
the list, and they are remembered per view.

To share a set of views with colleagues, use **Settings → Export configuration**
and have them import the file. That carries your views (both populations),
favourites, thresholds, site overrides and import settings, and nothing else.

Every view can be exported to CSV with whatever columns you have chosen, so a
view is also the way you hand a list to somebody who does not use the tool.

---

## Duplicates within each export

Reconciliation produces one row per physical device, which deliberately hides
the fact that a file held that device twice. The **Duplicates** tab asks the
opposite question: which rows in *this particular export* are stale copies that
should be deleted from the system that produced it. The lists are therefore per
file, not reconciled together.

Rows are grouped on **serial number**. Where a build names a machine after its
serial with a build-type prefix — `STD-5CD4092H17`, `SHR-5CD4092H17` — the
serial is read back out of the name, which is what makes a machine rebuilt
under a different build type show up as the duplicate it is rather than as two
unrelated devices. It is also the only way to group Arctic Wolf, which carries
no serial column at all.

A record's own serial column is always used where it has one; the name is only
the fallback. Set the prefixes at the top of the tab — leave the box empty and
name-derivation is off entirely, which for Arctic Wolf means nothing can be
grouped, and the tab says so rather than reporting a clean file.

For each source you get the count of serials with copies, how many rows would
go, how many need a human decision, and how many are renamed rebuilds. The
table lists every copy with the date each system last saw it, and marks the
most recent as **Keep** and the rest as **Remove**. Where the dates are equal or
missing the entry is marked **Check** instead of guessed at.

Two exports per source: the removal list on its own, and every copy including
the keeps. Both carry the row number in the original export and a few
identifying fields from that system, so a row can be found and deleted without
cross-referencing anything.

---

## Vulnerability risk

Two views rank the estate once an Arctic Wolf export is loaded:

- **Vulnerability: worst risk score** — highest score first. The score reflects
  the *severity* of the worst finding on a machine, not how many there are, so a
  high score on a device with few risks still means something serious is open.
- **Vulnerability: most open risks** — most findings first. A long tail is
  usually a machine that is badly behind on patching, which makes it a rebuild
  or update candidate rather than an incident.

The two answer different questions and rarely rank the same, which is why they
are separate views rather than one combined score. Both columns are sortable
anywhere they appear, so any other view can be ranked by risk by adding the
column.

**No vulnerability scan** is the coverage view: live devices with no Arctic Wolf
record at all, plus those whose last successful scan has gone stale. That is a
gap in scanning rather than a data mismatch — normally the agent is not
deployed — and it is the one worth clearing first, because an unscanned machine
reports no risk at all and so never appears in the other two views.

Thresholds for all three are in Settings: the score that counts as high
(default 9), the number of open risks that counts as a lot (default 500), and
how long a scan can go without being repeated (default 21 days).

---

## Notes and the audit trail

Every device carries a running, timestamped set of notes recording what you did
about it. They are append-only: adding a note never overwrites what was there,
so the entries read as a history rather than a status field.

**Adding them.** On the Devices tab, click the flag in the Notes column to open
one device's trail and add to it — the dialog stays open so you see the entry
land. For several devices at once, tick the rows and use **Add note to N
selected**, or **Add note to all N in view** to cover the whole filtered list.
A bulk note goes to every chosen device with the same timestamp, so a round of
phone calls or a batch email is recorded once and shows up on each machine.

**Seeing them.** The Notes column carries a flag and a count, and it is added to
every view whether or not the view asks for it, so you always know which devices
have history behind them. Clicking a row opens the detail drawer, which shows
the full trail alongside the reconciliation detail. The column sorts and filters
like any other, so a custom view can be built for "devices I have already
actioned" or the reverse.

**Keeping them.** Notes are matched to a device by serial number, then device
name, then asset tag, and every note records all three. That is what makes them
survive loading next month's exports, when every row is rebuilt from scratch:
a machine that gets renamed keeps its notes through the serial, and one whose
serial is filled in later keeps them through the name.

They are stored separately from the loaded data, so turning off the working-set
setting does not remove them, and they travel inside **Save project**. Opening a
project file merges its notes with what is already in the browser rather than
replacing them, so nobody's work is lost by opening someone else's file.

**Exporting them.** *Export notes* on the Devices tab writes one row per note
for the devices in view — device, serial, location, timestamp, note — which is
the audit trail in a form you can hand to somebody. Settings has the same for
every note held.

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

**Which devices.** Three options at the top of the page, with a live count
against each:

- **The devices you ticked** — appears when you have rows selected, and is
  chosen automatically when you arrive with a selection.
- **The devices shown in \<view\>** — *exactly* what the table was displaying,
  including the quick-search box as well as the view's own filter and any site
  or issue filter. The line beneath spells out what narrowed it, so a view of
  106 filtered to 56 reads as "56 of 106" rather than quietly exporting 106.

  The search box looks at **every field**, not only the columns on screen, so
  you can search a serial number or an asset type without adding its column
  first — and the export always covers the same rows the table showed. Column
  choices you make in the picker are remembered per view.
- **Every device** — the whole reconciled estate, ignoring the view.

The results header repeats the number of devices in scope, so the file is never
ambiguous about what it covers.

**What to update.** For each field, choose whether to correct it and where the
correct value comes from — Intune, a site verification return, or a fixed value.

For the assigned user there is a second choice: whether to write the person's
**email / UPN** or their **display name**. It defaults to the UPN, because
Freshservice matches a requester on their address and a display name only lands
if your instance is set up that way. Where Intune has no UPN for someone, the
display name is used rather than nothing.

A device already assigned to the right person is left alone whichever form you
pick — `Joseph Sinclair` in Freshservice against `joseph.sinclair@…` in Intune
is recognised as the same person and produces no change. If you want to
*normalise* existing assignments to addresses rather than only fix wrong ones,
turn off **Only include rows where the value actually changes**.
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
devices recorded there.

### Which population

Both populations share the map. **Show** picks what the dots count:

- **PCs** — the Freshservice/Intune reconciliation.
- **Network assets** — firewalls, switches and access points, placed by the
  site their FortiManager name resolves to.
- **Both** — one dot per site sized by the combined total, with the popup
  splitting it out.

The selector only appears once both populations are loaded, and switching
re-fits the view, because the two cover different sets of sites.

The map opens on **Great Britain**, fitted corner to corner rather than set to
a fixed zoom, so it is framed correctly whatever size the window is. It fills
the height the window gives it, and **Expand** takes the whole window (Escape
comes back).

It is also **always light, whatever theme the rest of the tool is in**.
Inverting the tiles for dark mode turned motorways white and water black, which
made the geography harder to read rather than easier — and the dark sequential
ramps are tuned for a dark ground they would no longer be sitting on.

### Colour

The options depend on the population, since not all of them mean anything for
both:

- **Device count only** — one colour; size carries everything.
- **Variance vs expected** — red where there are more devices than the lookup's
  `Expected Devices` says there should be, blue where there are fewer. This is
  the view for finding services holding more kit than they should. Always
  measured against the **PC** count, since the allowance is a PC allowance —
  a variance that counted switches would be meaningless.
- **Share of devices with issues** — darker where a higher proportion of that
  site's devices are flagged.
- **Network kit not in Freshservice** — darker where more of the site's
  network kit has no Freshservice record at all. This is the map for deciding
  where the register is worst, and it goes straight to the import list.

### Clicking a dot

The popup always shows the split — how many PCs, how many network devices, and
the network kit broken down into firewalls, switches and access points — plus
how many of that site's network devices are missing from Freshservice.

Because a dot can stand for two separate lists, it offers a button per
population rather than guessing. **View N network** filters the Network tab to
that site, shows a *Site: …* pill you can clear, and scopes the import builder
to it — so building a Freshservice import for one site is three clicks from the
map.

Sites that cannot be drawn are never silently dropped — they are counted and
listed underneath, split into "in the lookup but no coordinates" and "used in
Freshservice but not in the lookup at all". Network devices whose site could not
be resolved at all are counted separately, with a pointer to the site
overrides.

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

## Network assets

The network side answers a different question from the PC side. Freshservice's
network register was imported by hand and has not been maintained, so what
matters is **presence**, not field-by-field agreement:

- **New since last import** — managed by FortiManager, absent from
  Freshservice. This is the list you build an import from.
- **Possibly replaced** — on a Freshservice record but managed by neither
  environment. Replaced, decommissioned, or never removed.

Everything else — firmware drift, locations, duplicates — is secondary, and
only matters once those two lists are dealt with.

### The FortiManager export

Export from **Device Manager → Table View → Export**, and include every column
offered. Two things about that file are worth knowing, because both used to
break naive handling of it:

**It is a rendered tree, not a table.** The hierarchy lives in the *leading
spaces* of the Device Name column: a firewall at the left margin, then a `FSW`
or `FAP` section row, then the switches and access points indented beneath it.
Trim those spaces and you lose the structure entirely. The parser reads the
indent depth before anything else touches the row, and a section label it does
not recognise (a Security Fabric group, say) is reported as unknown rather than
assumed to be switches.

**An HA row is two firewalls.** A cluster is exported as one line with both
serials packed into one cell — `FGT70GTK26066915 (Primary),FGT70GTK26061507
(Secondary)` — and the member names and sync states in another. Each member
becomes its own asset, with its own serial, role, sync state and **its own
location**: an HA pair can span two buildings, and inheriting the site from the
parent row would put one member at the wrong one.

### Two environments

If you run more than one FortiManager, **drop both exports on the same box**.
They are held together and unioned by column name, with each row tagged with
the environment it came from, and you can name the environments on the Data tab
so the tables and the import read *Current supplier* rather than
`managed_devices_root_20260902153522`.

Do not append them in a spreadsheet. Two environments rarely export the same
columns — one may carry the WAN `IP Address` and the other not — and because
the shared columns sit at different positions, pasting one under the other
shifts every field silently. The union is by name for exactly that reason, and
it means a column you gain in a later export simply appears.

A serial found in both environments is flagged rather than merged: expected
mid-migration, worth a look otherwise.

### Kit that is not Fortinet

The network register holds more than FortiManager manages — Ubiquiti UniFi
access points, and whatever else has been bought over the years. Those are
first-class network assets here:

- **Type** is what a device *is* — *Firewall*, *Switch*, *Access point* — not a
  Fortinet product line, so a UniFi AP is an access point and appears in the
  *Access points* view alongside the FortiAPs.
- **Vendor** and **Platform / product** come from the Freshservice record, so
  the real make and model are what you see.
- **Forti family** is a separate column, holding FortiManager's own word for
  the product line, and is blank for anything it does not manage.

They are also kept out of *Possibly replaced*, which would otherwise fill up
with kit FortiManager was never going to have. **Other vendors** lists them
instead — which, while UniFi is being replaced, is the list of what is left to
do. A record with no Vendor and no Product stays in *Possibly replaced*: an
empty column far more often means nobody filled it in than that the device came
from somewhere else.

---

### Which site a device is at

The site comes from the number at the front of the device name, zero-padded to
three, matched against your site list — right for the great majority. Where it
is not, the tool never guesses harder:

1. **A site override** — device name to site code, kept in the project file —
   wins over everything.
2. Otherwise the **number in the device's own name**, if it matches a site.
3. Otherwise the site of the **firewall it sits under**.

Then it sanity-checks the answer: if the device name and the site name share no
word, the row is flagged **Site looks wrong** rather than quietly accepted. That
is what catches a house number masquerading as a site code — `113-117-Stanley
Road` resolving to site 113, which is somewhere else entirely — and a campus
firewall whose switches belong to neighbouring sites. Near-miss spellings
(*Gorefield* against *Gorefeld*) are treated as the same place, so the flag
stays worth reading.

**Site overrides** on the Network tab lists everything unresolved or suspect,
with a dropdown of your real site codes. Clearing that list is the one piece of
manual setup the network side needs.

### Building the network import

**One file per asset type.** Freshservice imports assets one type at a time, so
a single file holding routers, switches and access points cannot be uploaded at
all. The builder splits the rows by the Asset Type they will carry, sorts each
by site, and names the file for the type —
`freshservice-network-import-switch-2026-09-04.csv`. **Download import files**
writes them all; there is also a button per type if you would rather take them
one at a time.

Most network rows *create* an asset rather than correct one, so Workspace,
Name, Asset Type and Product must all be present — and three of those have to
be spelled the way Freshservice spells them. A Product name the tool invented
would either fail the import or quietly create a second product.

So the builder keeps three mappings, and **learns them from your own data**:
where a matched device already has a Freshservice Product, that is by definition
a value Freshservice accepts for that platform, so it is adopted. In practice
that fills nearly all of them on the first run, and the boxes it cannot fill
are highlighted. The export button refuses to run while any required mapping is
blank, and shows the first rows exactly as they will be written.

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
currently loaded — sources, settings and notes — to a `.json` file you choose,
for handing work to a colleague or moving between machines. See
[Working as a team](#working-as-a-team). Treat that file the way you would treat
the original exports: it contains the device and user data in full.

---

## Working as a team

Everything the tool holds lives in the browser profile of the person using it —
there is no server, so nothing is shared automatically. Two people running it
see two separate sets of data and two separate sets of notes.

The supported way to work together is a **project file on a shared drive**.

**Set your name once.** Settings → *Your name, recorded against notes you
write*, or answer the prompt the first time you add a note. Every note you write
is then signed, so a shared trail says who did what.

**The routine.**

1. One person loads the exports and saves a project file to the shared drive
   (`Save project`). The file records who saved it and when.
2. Anyone else opens it (`Open`). Their own notes are **merged, never
   replaced** — the tool reports how many arrived and how many were already
   there, and says explicitly that nothing of theirs was overwritten.
3. Work the list, add notes.
4. Save back to the shared drive when finished, keeping the file name and
   letting it overwrite.

**What merging guarantees.** Notes are a union of both sides. An entry is only
treated as a duplicate when the same author wrote the same text at the same
instant, which is the same entry rather than a coincidence — so re-opening the
same file twice adds nothing, and two people who noted the same device both keep
their entry. Notes on a device match on serial number, then name, then asset
tag, so the two files agreeing about a machine is enough; they do not have to
have keyed it the same way.

**What it does not do.** There is no locking and no live sync. If two people
save over each other within the same session, the last save wins for the *data
and settings* — though notes survive, because whoever opens next merges rather
than replaces. Treat it like a shared spreadsheet: agree who is holding it, or
have each person save to their own file and merge them in when you regroup.
That is the honest limit of a tool with no server behind it; if you need
concurrent editing, it needs a backend, which is a different piece of work.

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
│   ├── dupes.js            duplicate rows within each source file
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
│   ├── notes.js            per-device notes, keyed so they survive re-imports
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
