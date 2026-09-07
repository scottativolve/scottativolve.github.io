/* The Freshservice import for printers.

   These rows all correct records that already exist, so unlike the network
   import there is nothing to create: the file carries the key Freshservice
   matches on plus only the columns being put right. Each field names the side
   that is authoritative for it, which is not the same side throughout —
   OneStop polls the device, so it owns the serial, the addresses, the meters
   and the monitoring flags; Freshservice knows which building rather than
   which campus, so it owns the location. */
(function (global) {
  'use strict';

  var U = global.U, N = global.Norm, P = global.Printers;

  var DEFAULT_HEADERS = {
    workspace: 'Workspace',
    name:      'Name',
    assetType: 'Asset Type',
    product:   'Product',
    serial:    'Serial Number',
    state:     'Asset State',
    location:  'Location',
    vendor:    'Vendor',
    ip:        'IP Address',
    mac:       'MAC Address',
    tag:       'Asset Tag',
    description: 'Description'
  };

  /* Every column the import can carry.
       required : Freshservice rejects an asset import without it
       fixes    : the rule code this column exists to put right
       from     : which system the value comes from */
  var COLUMNS = [
    { key: 'workspace', label: 'Workspace',     required: true, fixed: true, from: 'fixed' },
    { key: 'name',      label: 'Name',          required: true, from: 'fs',
      help: 'The key Freshservice matches the row on. Never changed.' },
    { key: 'assetType', label: 'Asset Type',    required: true, fixed: true, from: 'fixed' },
    { key: 'product',   label: 'Product',       required: true, from: 'house',
      fixes: 'product-inconsistent', help: 'The spelling most of your own records already use for this model.' },
    { key: 'serial',    label: 'Serial Number', from: 'onestop', fixes: 'serial-missing' },
    { key: 'state',     label: 'Asset State',   from: 'derived', fixes: 'state-wrong',
      help: 'Set to In Use where OneStop shows the printer reporting with pages on the meter.' },
    { key: 'location',  label: 'Location',      from: 'fs', fixes: 'location-missing',
      help: 'Freshservice wins on location, so this only fills a blank.' },
    { key: 'vendor',    label: 'Vendor',        from: 'derived', fixes: 'vendor-missing' },
    { key: 'ip',        label: 'IP Address',    from: 'onestop', fixes: 'ip-differs' },
    { key: 'mac',       label: 'MAC Address',   from: 'onestop', fixes: 'mac-missing' },
    { key: 'tag',       label: 'Asset Tag',     from: 'onestop', fixes: 'tag-differs',
      help: 'The OneStop site number, which is what Freshservice holds here.' },
    { key: 'description', label: 'Description', from: 'derived',
      help: 'Where in the building, and the meter reading it was set from.' }
  ];

  var SOURCE_LABELS = {
    fixed:   'the same on every row',
    fs:      'Freshservice',
    onestop: 'OneStop',
    house:   'your own majority spelling',
    derived: 'worked out from both'
  };

  function defaultConfig() {
    return {
      headers: Object.assign({}, DEFAULT_HEADERS),
      include: {
        workspace: true, name: true, assetType: true, product: true, serial: true,
        state: true, location: false, vendor: true, ip: true, mac: true,
        tag: false, description: false
      },
      fixed: { workspace: 'IT', assetType: 'Printer' },
      inUseState: 'In Use',
      // Only write a column on the rows that actually need it, leaving the
      // rest blank. Freshservice treats a blank cell as "leave alone", so a
      // narrow file is a safer file.
      onlyChanged: true
    };
  }

  /* --------------------------------------------------------------- values */

  function cellValue(row, key, config) {
    var col = byKey(key);
    if (!col) return '';
    if (col.fixed) return N.clean(config.fixed[key]);

    switch (key) {
      case 'name':
        // The match key: whatever Freshservice already calls the record.
        return N.clean(row.fsName) || N.clean(row.serial);
      case 'product':
        return N.clean(row.productShould) || N.clean(row.fsProduct);
      case 'serial':
        return only(row, config, 'serial-missing', N.clean(row.serial));
      case 'state':
        return only(row, config, 'state-wrong', config.inUseState);
      case 'location':
        return only(row, config, 'location-missing',
          N.clean(row.fsLocation) || N.clean(P.stripCompany(row.siteName)));
      case 'vendor':
        return only(row, config, 'vendor-missing', N.clean(row.vendorShould));
      case 'ip':
        return only(row, config, ['ip-differs', 'ip-missing'], P.usable(row.ipOnestop));
      case 'mac':
        return only(row, config, 'mac-missing', N.clean(row.macOnestop));
      case 'tag':
        return only(row, config, 'tag-differs', N.clean(row.siteNum));
      case 'description':
        return description(row);
      default: return '';
    }
  }

  /* With onlyChanged on, a column is written only for the rows whose issue it
     exists to fix. Freshservice reads a blank cell as "leave this field as it
     is", so writing a value everywhere would overwrite fields nobody asked to
     change — the Product column being the exception, since the import is
     rejected without it. */
  function only(row, config, codes, value) {
    if (!config.onlyChanged) return value;
    var list = Array.isArray(codes) ? codes : [codes];
    var hit = list.some(function (c) { return row.issues && row.issues.indexOf(c) >= 0; });
    return hit ? value : '';
  }

  function description(row) {
    var bits = [];
    if (row.spot) bits.push(row.spot);
    if (row.pages) bits.push(U.num(row.pages) + ' pages at ' + (row.lastSeen ? U.fmtDate(row.lastSeen) : 'last read'));
    if (row.monitored === false) bits.push('not monitored by OneStop');
    return bits.join('; ');
  }

  function byKey(key) {
    return COLUMNS.filter(function (c) { return c.key === key; })[0] || null;
  }

  function header(col, config) {
    return N.clean((config.headers || {})[col.key]) || col.label;
  }

  function activeColumns(config) {
    return COLUMNS.filter(function (c) { return config.include[c.key]; });
  }

  /* Which rows this file would actually change, and what it would change. */
  function changeSummary(rows, config) {
    var out = [];
    activeColumns(config).forEach(function (col) {
      if (col.fixed || col.key === 'name') return;
      var n = 0;
      rows.forEach(function (r) {
        var v = cellValue(r, col.key, config);
        if (!v) return;
        if (col.key === 'product' && !r.productDiffers) return;   // present but unchanged
        n++;
      });
      if (n) out.push({ key: col.key, label: header(col, config), rows: n, fixes: col.fixes || '' });
    });
    return out;
  }

  function missingRequired(config) {
    return COLUMNS.filter(function (c) { return c.required && !config.include[c.key]; })
                  .map(function (c) { return header(c, config); });
  }

  /* A required column blank on any row is a rejected import. */
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

  /* Rows worth writing at all: a correction file for a row with nothing to
     correct is noise, and Freshservice would rewrite it for no reason. */
  function rowsWithChanges(rows, config) {
    if (!config.onlyChanged) return rows.slice();
    var fixable = {};
    activeColumns(config).forEach(function (c) { if (c.fixes) fixable[c.fixes] = true; });
    // Product is not gated on onlyChanged, so include a row whose product differs.
    return rows.filter(function (r) {
      if (r.productDiffers && config.include.product) return true;
      return (r.issues || []).some(function (code) { return fixable[code]; });
    });
  }

  /* ---------------------------------------------------------------- output */

  function toImportCsv(rows, config) {
    var seen = {}, keep = [];
    activeColumns(config).forEach(function (c) {
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

  /* What the import claimed to change, field by field, for the change log. */
  function toChangeLogCsv(rows, config) {
    var headers = ['Printer', 'Serial', 'Field', 'Was', 'Set to', 'Because'];
    var out = [];
    rows.forEach(function (r) {
      activeColumns(config).forEach(function (col) {
        if (col.fixed || col.key === 'name') return;
        var to = cellValue(r, col.key, config);
        if (!to) return;
        var was = currentValue(r, col.key);
        if (N.clean(was) === N.clean(to)) return;
        out.push({
          'Printer': r.fsName || r.name,
          'Serial': r.serial,
          'Field': header(col, config),
          'Was': was,
          'Set to': to,
          'Because': col.fixes ? ((P.RULE_BY_CODE[col.fixes] || {}).label || col.fixes) : (col.help || '')
        });
      });
    });
    return global.CSV.stringify(out, headers);
  }

  function currentValue(row, key) {
    switch (key) {
      case 'product':  return row.fsProduct;
      case 'serial':   return row.fs ? N.clean(row.fs.serial) : '';
      case 'state':    return row.fsState;
      case 'location': return row.fsLocation;
      case 'vendor':   return row.fsVendor;
      case 'ip':       return row.ipFs;
      case 'mac':      return row.macFs;
      case 'tag':      return row.fsTag;
      default:         return '';
    }
  }

  global.PrintExport = {
    COLUMNS: COLUMNS,
    DEFAULT_HEADERS: DEFAULT_HEADERS,
    SOURCE_LABELS: SOURCE_LABELS,
    defaultConfig: defaultConfig,
    cellValue: cellValue,
    currentValue: currentValue,
    activeColumns: activeColumns,
    changeSummary: changeSummary,
    missingRequired: missingRequired,
    blankRequired: blankRequired,
    rowsWithChanges: rowsWithChanges,
    header: header,
    toImportCsv: toImportCsv,
    toChangeLogCsv: toChangeLogCsv
  };
})(window);
