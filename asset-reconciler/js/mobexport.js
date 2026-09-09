/* The Freshservice import for mobiles and tablets.

   This one creates records rather than correcting them — none of these
   devices is in Freshservice yet — so the mandatory columns matter more than
   anywhere else in the tool: Workspace, Name, Asset Type and Product are all
   required, and two of those have to match a list Freshservice keeps its own
   way. A value invented here either fails the import or quietly creates a
   product nobody recognises, so both mappings are explicit and the export
   refuses to run while either is blank.

   Freshservice imports one asset type at a time, so this writes one file per
   type: the phones and the tablets go up separately. */
(function (global) {
  'use strict';

  var U = global.U, N = global.Norm, MB = global.Mobiles;

  var DEFAULT_HEADERS = {
    workspace:  'Workspace',
    name:       'Name',
    assetType:  'Asset Type',
    product:    'Product',
    serial:     'Serial Number',
    location:   'Location',
    state:      'Asset State',
    vendor:     'Vendor',
    imei:       'IMEI',
    os:         'OS Version',
    ip:         'IP Address',
    mac:        'MAC Address',
    tag:        'Asset Tag',
    description:'Description'
  };

  var COLUMNS = [
    { key: 'workspace',  label: 'Workspace',     required: true, fixed: true },
    { key: 'name',       label: 'Name',          required: true,
      help: 'The five-digit asset number SOTI holds as the device name.' },
    { key: 'assetType',  label: 'Asset Type',    required: true, lookup: 'assetTypes' },
    { key: 'product',    label: 'Product',       required: true, lookup: 'products' },
    { key: 'serial',     label: 'Serial Number',
      help: 'The hardware serial. Unique across the estate, and what a later reconciliation will match on.' },
    { key: 'location',   label: 'Location',
      help: 'The site the SOTI folder resolved to, or your home-worker label where SOTI files by region.' },
    { key: 'state',      label: 'Asset State',
      help: 'In Use, except test and supplier stock, which is Reserved. Both words are set in Settings.' },
    { key: 'vendor',     label: 'Vendor',        fixed: false,
      help: 'As SOTI reports it, capitalised — it arrives as "samsung".' },
    { key: 'imei',       label: 'IMEI',
      help: 'What the network operator needs to bar a lost handset.' },
    { key: 'os',         label: 'OS Version' },
    { key: 'ip',         label: 'IP Address',
      help: 'Off by default: a mobile’s address is whatever network it was last on, so it dates immediately.' },
    { key: 'mac',        label: 'MAC Address' },
    { key: 'tag',        label: 'Asset Tag',
      help: 'The same asset number as the name. Off by default — switch it on if you key on Asset Tag.' },
    { key: 'description',label: 'Description' }
  ];

  var COL_BY_KEY = {};
  COLUMNS.forEach(function (c) { COL_BY_KEY[c.key] = c; });

  /* Two lookups, deliberately keyed differently.

     Product is per model code, because that is the granularity Freshservice
     records: nineteen codes across the estate. Asset Type is per form factor,
     because there are only two answers and asking nineteen times for the same
     two would be a way of introducing typos. */
  var LOOKUPS = [
    { id: 'assetTypes', label: 'Phone or tablet → Asset Type',
      keyOf: function (r) { return r.formFactor; },
      keyLabel: 'What it is', valueLabel: 'Freshservice Asset Type' },
    { id: 'products',   label: 'Model code → Product',
      keyOf: function (r) { return r.model; },
      keyLabel: 'SOTI model code', valueLabel: 'Freshservice Product',
      hint: function (r) { return r.modelName; } }
  ];

  var LOOKUP_BY_ID = {};
  LOOKUPS.forEach(function (l) { LOOKUP_BY_ID[l.id] = l; });

  /* Seeded from the model table so the common case needs no typing, and every
     value stays editable: these are Freshservice's words, not ours. */
  function seedLookups(config) {
    var products = Object.assign({}, (config && config.products) || {});
    Object.keys(MB.MODELS).forEach(function (code) {
      if (!products[code]) products[code] = MB.MODELS[code].product;
    });
    var types = Object.assign({ Phone: 'Mobile', Tablet: 'Tablet' },
                              (config && config.assetTypes) || {});
    return { products: products, assetTypes: types };
  }

  function defaultConfig() {
    var seeded = seedLookups(null);
    return {
      headers: Object.assign({}, DEFAULT_HEADERS),
      include: {
        workspace: true, name: true, assetType: true, product: true, serial: true,
        location: true, state: true, vendor: true, imei: true, os: true,
        ip: false, mac: false, tag: false, description: true
      },
      fixed: { workspace: 'IT' },
      vendorText: 'Samsung',
      products: seeded.products,
      assetTypes: seeded.assetTypes,
      describeSoti: true
    };
  }

  /* --------------------------------------------------------------- values */

  function cellValue(row, key, config) {
    var col = COL_BY_KEY[key];
    if (!col) return '';
    if (col.fixed) return N.clean(config.fixed[key]);
    if (col.lookup) {
      var l = LOOKUP_BY_ID[col.lookup];
      var k = l.keyOf(row);
      return k ? N.clean((config[col.lookup] || {})[k]) : '';
    }
    switch (key) {
      case 'name':     return N.clean(row.name);
      case 'serial':   return N.clean(row.serial);
      case 'location': return N.clean(row.location);
      case 'state':    return N.clean(row.stateShould);
      case 'vendor':   return vendorOf(row, config);
      case 'imei':     return N.clean(row.imei);
      case 'os':       return row.osMajor === null ? '' : 'Android ' + row.osMajor;
      case 'ip':       return N.clean(row.ip);
      case 'mac':      return N.clean(row.mac);
      // Only where the name really is the asset number; a device called
      // "03564 Adam Stallwood - A165F" has no clean tag to write.
      case 'tag':      return MB.isAssetNumber(row.name) ? N.clean(row.name) : '';
      case 'description': return description(row, config);
      default: return '';
    }
  }

  /* SOTI reports "samsung" in lower case, which is not how a manufacturer is
     written in an asset register. One configured spelling covers the fleet;
     anything else is passed through with its first letter raised rather than
     replaced, because guessing at a second maker's house style is worse than
     leaving it as reported. */
  function vendorOf(row, config) {
    var m = N.clean(row.manufacturer);
    if (!m) return '';
    if (/^samsung$/i.test(m)) return N.clean(config.vendorText) || 'Samsung';
    return m.charAt(0).toUpperCase() + m.slice(1);
  }

  /* Where SOTI has it filed, and when it last reported. Both are the sort of
     thing somebody looking at the Freshservice record will want and would
     otherwise have to open SOTI for. */
  function description(row, config) {
    if (!config.describeSoti) return '';
    var bits = [];
    if (row.deviceClass) bits.push(row.deviceClass);
    if (row.folder && row.folder !== row.siteName) bits.push('SOTI folder: ' + row.folder);
    if (row.siteCode) bits.push('Site ' + row.siteCode);
    if (row.checkIn) bits.push('SOTI check-in ' + U.fmtDate(row.checkIn));
    else bits.push('never checked in to SOTI');
    return bits.join('; ');
  }

  function header(col, config) {
    return N.clean((config.headers || {})[col.key]) || col.label;
  }

  function activeColumns(config) {
    return COLUMNS.filter(function (c) { return config.include[c.key]; });
  }

  /* ------------------------------------------------------------- lookups */

  /* Every distinct key these rows need, with what we know about it. */
  function lookupKeys(rows, config, lookupId) {
    var l = LOOKUP_BY_ID[lookupId];
    if (!l) return [];
    var seen = {};
    (rows || []).forEach(function (r) {
      var k = l.keyOf(r);
      if (!k) return;
      if (!seen[k]) seen[k] = { key: k, count: 0, hint: '', examples: [] };
      seen[k].count++;
      if (!seen[k].hint && l.hint) seen[k].hint = N.clean(l.hint(r));
      if (seen[k].examples.length < 3) seen[k].examples.push(r.name);
    });
    var map = (config && config[lookupId]) || {};
    return Object.keys(seen).sort().map(function (k) {
      return Object.assign(seen[k], { value: N.clean(map[k]) });
    });
  }

  function unmapped(rows, config) {
    var out = [];
    LOOKUPS.forEach(function (l) {
      var col = COLUMNS.filter(function (c) { return c.lookup === l.id; })[0];
      if (col && config.include && !config.include[col.key]) return;
      lookupKeys(rows, config, l.id).forEach(function (k) {
        if (k.value) return;
        out.push({ lookup: l.id, lookupLabel: l.label, key: k.key, hint: k.hint,
                   count: k.count, required: !!(col && col.required) });
      });
    });
    return out;
  }

  /* Rows with no model code at all cannot reach a Product however the lookups
     are filled in, so they are reported separately rather than blocking the
     rest of the estate for ever. */
  function unimportable(rows) {
    return (rows || []).filter(function (r) { return !r.model || !r.serial; });
  }

  function importable(rows) {
    return (rows || []).filter(function (r) { return !!r.model && !!r.serial; });
  }

  function missingRequired(config) {
    return COLUMNS.filter(function (c) { return c.required && !config.include[c.key]; })
                  .map(function (c) { return header(c, config); });
  }

  function blankRequired(rows, config) {
    var out = [];
    activeColumns(config).forEach(function (c) {
      if (!c.required) return;
      var n = 0;
      rows.forEach(function (r) { if (!cellValue(r, c.key, config)) n++; });
      if (n) out.push({ key: c.key, label: header(c, config), rows: n });
    });
    return out;
  }

  /* A blank Location is not a rejected import, but it is a device that lands
     nowhere, so it is worth saying out loud before anyone uploads the file. */
  function blankLocation(rows, config) {
    if (!config.include.location) return 0;
    return rows.filter(function (r) { return !cellValue(r, 'location', config); }).length;
  }

  /* ---------------------------------------------------------------- output */

  function toImportCsv(rows, config) {
    var seen = {}, keep = [];
    activeColumns(config).forEach(function (c) {
      var h = header(c, config);
      if (seen[h]) return;               // two columns sharing a header is ambiguous
      seen[h] = true;
      keep.push({ col: c, header: h });
    });
    var headers = keep.map(function (k) { return k.header; });
    var out = rows.map(function (r) {
      var o = {};
      keep.forEach(function (k) { o[k.header] = cellValue(r, k.col.key, config); });
      return o;
    });
    return global.CSV.stringify(out, headers);
  }

  /* Split by the Freshservice Asset Type the rows will carry — the mapped
     value, not our internal form factor, because that is what the import is
     keyed on — and sort within each file by site so it reads in order. */
  function splitByAssetType(rows, config) {
    var groups = {};
    (rows || []).forEach(function (r) {
      var type = cellValue(r, 'assetType', config) || '(no asset type)';
      (groups[type] = groups[type] || []).push(r);
    });
    return Object.keys(groups).sort().map(function (type) {
      return {
        type: type,
        rows: groups[type].slice().sort(function (a, b) {
          var sa = (a.siteCode || 'zzz') + (a.location || ''), sb = (b.siteCode || 'zzz') + (b.location || '');
          if (sa !== sb) return sa < sb ? -1 : 1;
          return String(a.name || '') < String(b.name || '') ? -1 : 1;
        })
      };
    });
  }

  function typeSlug(type) {
    return String(type || 'asset').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'asset';
  }

  /* What the import claimed, for the record — and for checking a site's
     devices against what actually turned up there. */
  function toManifestCsv(rows, config) {
    var headers = ['Device name', 'Serial', 'IMEI', 'Model code', 'Product', 'Asset Type',
                   'SOTI class', 'SOTI folder', 'Site code', 'Site', 'Matched by',
                   'Location', 'Asset State', 'Last check-in'];
    var out = rows.map(function (r) {
      return {
        'Device name': r.name, 'Serial': r.serial, 'IMEI': r.imei,
        'Model code': r.model, 'Product': cellValue(r, 'product', config),
        'Asset Type': cellValue(r, 'assetType', config),
        'SOTI class': r.deviceClass, 'SOTI folder': r.folder,
        'Site code': r.siteCode, 'Site': r.siteName,
        'Matched by': r.hasSiteFolder ? (r.siteMatch || 'nothing') : 'no site folder',
        'Location': cellValue(r, 'location', config),
        'Asset State': cellValue(r, 'state', config),
        'Last check-in': r.checkIn ? U.fmtDate(r.checkIn) : 'never'
      };
    });
    return global.CSV.stringify(out, headers);
  }

  global.MobExport = {
    COLUMNS: COLUMNS,
    LOOKUPS: LOOKUPS,
    LOOKUP_BY_ID: LOOKUP_BY_ID,
    DEFAULT_HEADERS: DEFAULT_HEADERS,
    defaultConfig: defaultConfig,
    seedLookups: seedLookups,
    lookupKeys: lookupKeys,
    unmapped: unmapped,
    unimportable: unimportable,
    importable: importable,
    cellValue: cellValue,
    activeColumns: activeColumns,
    header: header,
    missingRequired: missingRequired,
    blankRequired: blankRequired,
    blankLocation: blankLocation,
    toImportCsv: toImportCsv,
    splitByAssetType: splitByAssetType,
    typeSlug: typeSlug,
    toManifestCsv: toManifestCsv
  };
})(window);
