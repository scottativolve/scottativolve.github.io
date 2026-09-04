/* The Freshservice import for network assets.

   Unlike the PC import this mostly *creates* records rather than correcting
   them, which changes what matters: Workspace, Name, Asset Type and Product
   are mandatory, and three of those have to match a list Freshservice keeps
   its own way. A value the tool invents there either fails the import or
   quietly creates a duplicate product, so the mappings are explicit, seeded
   from what Freshservice already holds, and the export refuses to run while
   any of them is blank. */
(function (global) {
  'use strict';

  var U = global.U, N = global.Norm;

  /* Rows carry the export file they came from; the app supplies the name the
     user gave that environment, which is what belongs in a Freshservice
     record rather than "managed_devices_root_20260902153522". */
  var labelEnv = function (k) { return k; };

  var DEFAULT_HEADERS = {
    workspace:  'Workspace',
    name:       'Name',
    assetType:  'Asset Type',
    product:    'Product',
    serial:     'Serial Number',
    location:   'Location',
    state:      'Asset State',
    vendor:     'Vendor',
    firmware:   'Firmware Version',
    ip:         'IP Address',
    tag:        'Asset Tag',
    description:'Description'
  };

  /* Every column the import can carry, in the order Freshservice reads them.
     required marks the ones an asset import is rejected without. */
  var COLUMNS = [
    { key: 'workspace',  label: 'Workspace',        required: true,  fixed: true },
    { key: 'name',       label: 'Name',             required: true },
    { key: 'assetType',  label: 'Asset Type',       required: true,  lookup: 'assetTypes' },
    { key: 'product',    label: 'Product',          required: true,  lookup: 'products' },
    { key: 'serial',     label: 'Serial Number' },
    { key: 'location',   label: 'Location',                          lookup: 'locations' },
    { key: 'state',      label: 'Asset State',      fixed: true },
    { key: 'vendor',     label: 'Vendor',           fixed: true },
    { key: 'firmware',   label: 'Firmware Version' },
    { key: 'ip',         label: 'IP Address' },
    { key: 'tag',        label: 'Asset Tag' },
    { key: 'description',label: 'Description' }
  ];

  var LOOKUPS = [
    { id: 'products',   label: 'Platform → Product',
      keyOf: function (r) { return r.platform; },
      keyLabel: 'FortiManager platform', valueLabel: 'Freshservice Product',
      fsValue: function (r) { return r.fsProduct; } },
    { id: 'assetTypes', label: 'Device type → Asset Type',
      keyOf: function (r) { return r.kind; },
      keyLabel: 'Device type', valueLabel: 'Freshservice Asset Type',
      fsValue: function (r) { return r.fsAssetType; } },
    { id: 'locations',  label: 'Site → Location',
      keyOf: function (r) { return r.siteCode; },
      keyLabel: 'Site code', valueLabel: 'Freshservice Location',
      fsValue: function (r) { return r.fsLocation; },
      hint: function (r) { return r.siteName; } }
  ];

  var LOOKUP_BY_ID = {};
  LOOKUPS.forEach(function (l) { LOOKUP_BY_ID[l.id] = l; });

  function defaultConfig() {
    return {
      headers: Object.assign({}, DEFAULT_HEADERS),
      include: {
        workspace: true, name: true, assetType: true, product: true, serial: true,
        location: true, state: true, vendor: true, firmware: true, ip: true,
        tag: false, description: true
      },
      fixed: { workspace: 'IT', state: 'In Use', vendor: 'Fortinet' },
      products: {},
      assetTypes: {},
      locations: {},
      // Fall back to the site list's own name where no Freshservice location
      // has been mapped. Off by default: a name Freshservice does not know
      // is an import error, and a blank is at least visible.
      locationFallback: false,
      describeParent: true
    };
  }

  /* ------------------------------------------------------------- lookups */

  /* Learn each mapping from the records Freshservice already holds: where a
     matched device has a Product, that is by definition a value Freshservice
     accepts for that platform. The most common value wins, and anything with
     no matched example at all is left blank for the user to fill. */
  function seedLookups(rows, config) {
    var out = {};
    LOOKUPS.forEach(function (l) {
      var votes = {};
      (rows || []).forEach(function (r) {
        if (!r.forti || !r.fs) return;                 // only matched rows teach us anything
        var k = l.keyOf(r);
        var v = N.clean(l.fsValue(r));
        if (!k || !v) return;
        votes[k] = votes[k] || {};
        votes[k][v] = (votes[k][v] || 0) + 1;
      });
      var map = Object.assign({}, (config && config[l.id]) || {});
      Object.keys(votes).forEach(function (k) {
        if (map[k]) return;                            // never overwrite a user's own answer
        var best = '', n = 0;
        Object.keys(votes[k]).forEach(function (v) {
          if (votes[k][v] > n) { n = votes[k][v]; best = v; }
        });
        if (best) map[k] = best;
      });
      out[l.id] = map;
    });
    return out;
  }

  /* Every distinct key a set of rows needs, with what we know about it. */
  function lookupKeys(rows, config, lookupId) {
    var l = LOOKUP_BY_ID[lookupId];
    if (!l) return [];
    var seen = {};
    (rows || []).forEach(function (r) {
      if (!r.forti) return;                            // only rows we would export
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

  /* Which lookup keys are still unanswered for these rows. The export is
     blocked while any remain, because a blank Product or Asset Type is a
     rejected import and a blank Location silently loses the site. */
  function unmapped(rows, config) {
    var out = [];
    LOOKUPS.forEach(function (l) {
      var col = COLUMNS.filter(function (c) { return c.lookup === l.id; })[0];
      if (col && config.include && !config.include[col.key]) return;
      lookupKeys(rows, config, l.id).forEach(function (k) {
        if (k.value) return;
        if (l.id === 'locations' && config.locationFallback && k.hint) return;
        out.push({ lookup: l.id, lookupLabel: l.label, key: k.key, hint: k.hint,
                   count: k.count, required: !!(col && col.required) });
      });
    });
    return out;
  }

  /* --------------------------------------------------------------- values */

  function cellValue(row, key, config) {
    var col = COLUMNS.filter(function (c) { return c.key === key; })[0];
    if (!col) return '';
    if (col.fixed) return N.clean(config.fixed[key]);
    if (col.lookup) {
      var l = LOOKUP_BY_ID[col.lookup];
      var k = l.keyOf(row);
      var v = k ? N.clean((config[col.lookup] || {})[k]) : '';
      if (!v && col.lookup === 'locations' && config.locationFallback) v = N.clean(row.siteName);
      return v;
    }
    switch (key) {
      case 'name':     return N.clean(row.name);
      case 'serial':   return N.clean(row.serial);
      case 'firmware': return row.forti ? N.clean(row.forti.firmwareText) : '';
      case 'ip':       return N.clean(row.ipForti || row.ipFs);
      case 'tag':      return N.clean(row.fsTag);
      case 'description': return description(row, config);
      default: return '';
    }
  }

  /* What a switch or AP is plugged into is the single most useful thing to
     record about it, and Freshservice has nowhere better to put it. */
  function description(row, config) {
    if (!config.describeParent) return '';
    var bits = [];
    if (row.parent) bits.push('Managed by ' + row.parent);
    if (row.haRole) bits.push('HA ' + row.haRole.toLowerCase() + (row.haSync ? ' (' + row.haSync + ')' : ''));
    if (row.envs && row.envs.length) {
      bits.push('FortiManager: ' + row.envs.map(labelEnv).join(' and '));
    }
    if (row.siteCode) bits.push('Site ' + row.siteCode);
    return bits.join('; ');
  }

  function activeColumns(config) {
    return COLUMNS.filter(function (c) { return config.include[c.key]; });
  }

  /* A required column left blank on any row is a rejected import, so say
     which rows and which column before anyone uploads it. */
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

  function missingRequired(config) {
    return COLUMNS.filter(function (c) { return c.required && !config.include[c.key]; })
                  .map(function (c) { return header(c, config); });
  }

  function header(col, config) {
    return N.clean((config.headers || {})[col.key]) || col.label;
  }

  /* ---------------------------------------------------------------- output */

  function toImportCsv(rows, config) {
    var cols = activeColumns(config);
    // Two columns carrying the same Freshservice header would make the import
    // ambiguous; the first one wins, as it does on the PC side.
    var seen = {}, keep = [];
    cols.forEach(function (c) {
      var h = header(c, config);
      if (seen[h]) return;
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

  /* Freshservice imports one asset type at a time, so a single file holding
     routers, switches and access points cannot be uploaded at all. Split the
     rows by the Asset Type they will carry — the mapped Freshservice value,
     not our internal kind, because that is what the import is keyed on — and
     sort within each so a file reads by site. */
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
          var sa = (a.siteCode || '') + (a.siteName || ''), sb = (b.siteCode || '') + (b.siteName || '');
          if (sa !== sb) return sa < sb ? -1 : 1;
          return String(a.name || '') < String(b.name || '') ? -1 : 1;
        })
      };
    });
  }

  /* A safe, readable filename fragment for an asset type. */
  function typeSlug(type) {
    return String(type || 'asset').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'asset';
  }

  /* A record of what the import claimed, for the change log. */
  function toManifestCsv(rows, config) {
    var headers = ['Device name', 'Type', 'Serial', 'Platform', 'Site code', 'Site',
                   'Under firewall', 'Environment', 'Firmware', 'Asset Type', 'Product', 'Location'];
    var out = rows.map(function (r) {
      return {
        'Device name': r.name, 'Type': r.kind, 'Serial': r.serial, 'Platform': r.platform,
        'Site code': r.siteCode, 'Site': r.siteName, 'Under firewall': r.parent,
        'Environment': (r.envs || []).map(labelEnv).join(' and '), 'Firmware': r.firmwareText,
        'Asset Type': cellValue(r, 'assetType', config),
        'Product': cellValue(r, 'product', config),
        'Location': cellValue(r, 'location', config)
      };
    });
    return global.CSV.stringify(out, headers);
  }

  global.NetExport = {
    setEnvLabeller: function (fn) { labelEnv = fn || function (k) { return k; }; },
    COLUMNS: COLUMNS,
    LOOKUPS: LOOKUPS,
    LOOKUP_BY_ID: LOOKUP_BY_ID,
    DEFAULT_HEADERS: DEFAULT_HEADERS,
    defaultConfig: defaultConfig,
    seedLookups: seedLookups,
    lookupKeys: lookupKeys,
    unmapped: unmapped,
    cellValue: cellValue,
    activeColumns: activeColumns,
    blankRequired: blankRequired,
    missingRequired: missingRequired,
    header: header,
    toImportCsv: toImportCsv,
    splitByAssetType: splitByAssetType,
    typeSlug: typeSlug,
    toManifestCsv: toManifestCsv
  };
})(window);
