/* Builds the files that go back out: the Freshservice update import, the
   change log that documents it, and the site verification packs. */
(function (global) {
  'use strict';

  var U = global.U, N = global.Norm, R = global.Rules;

  /* Freshservice's import expects your instance's own column labels, and
     those differ between tenants (and between the default and custom fields).
     Every header here is editable in the UI and remembered. */
  var DEFAULT_HEADERS = {
    name:      'Name',
    assetTag:  'Asset Tag',
    serial:    'Serial Number',
    user:      'Used By',
    location:  'Location',
    state:     'Asset State',
    model:     'Product',
    os:        'OS',
    osVersion: 'OS Version',
    department:'Department'
  };

  var UPDATABLE = [
    { field: 'user',      label: 'Assigned user (Used By)', sources: ['intune', 'verification'], defaultSource: 'intune' },
    { field: 'location',  label: 'Location',                sources: ['verification'],           defaultSource: 'verification' },
    { field: 'state',     label: 'Asset state',             sources: ['verification', 'manual'], defaultSource: 'verification' },
    { field: 'serial',    label: 'Serial number',           sources: ['intune'],                 defaultSource: 'intune' },
    { field: 'model',     label: 'Model',                   sources: ['intune'],                 defaultSource: 'intune' },
    { field: 'os',        label: 'Operating system',        sources: ['intune'],                 defaultSource: 'intune' },
    { field: 'osVersion', label: 'OS version',              sources: ['intune'],                 defaultSource: 'intune' }
  ];

  var SOURCE_LABELS = {
    intune: 'Intune',
    verification: 'Site verification return',
    manual: 'Fixed value'
  };

  /* Columns that appear on every row regardless of what is being corrected.

     Freshservice rejects an asset import that is missing a mandatory field, so
     these are not decoration: an instance that requires Workspace, Name and
     Product needs all three present on every line, including lines where none
     of them is the thing being changed. A column can take a fixed value or the
     value Freshservice already holds for a field. Where a column names a field
     that is also being corrected, the corrected value wins for the rows that
     have one and the current value fills the rest, so the column is never
     blank. */

  var FS_FIELDS = [
    { field: 'name',        label: 'Device name (Display Name)' },
    { field: 'model',       label: 'Product / model' },
    { field: 'assetTag',    label: 'Asset tag' },
    { field: 'serial',      label: 'Serial number' },
    { field: 'location',    label: 'Location' },
    { field: 'user',        label: 'Assigned user' },
    { field: 'state',       label: 'Asset state' },
    { field: 'assetType',   label: 'Asset type' },
    { field: 'department',  label: 'Department' },
    { field: 'os',          label: 'Operating system' },
    { field: 'osVersion',   label: 'OS version' },
    { field: 'lastCheckIn', label: 'Last Intune check-in' }
  ];

  function fsFieldValue(row, field) {
    if (field === 'name') return row.name;
    if (field === 'assetTag') return row.assetTag;
    if (field === 'assetType') return row.assetType;
    if (field === 'department') return row.department;
    if (field === 'lastCheckIn') return row.lastCheckIn ? U.fmtDate(row.lastCheckIn) : '';
    return R.currentValue(row, field);
  }

  /* The three columns a stock Freshservice asset import will not accept a file
     without. Editable, removable, and extendable for instances that mandate
     more. */
  function defaultAlwaysColumns() {
    return [
      { header: 'Workspace', kind: 'fixed', value: 'IT' },
      { header: 'Name',      kind: 'field', field: 'name' },
      { header: 'Product',   kind: 'field', field: 'model' }
    ];
  }

  function defaultConfig() {
    return {
      matchField: 'name',
      headers: Object.assign({}, DEFAULT_HEADERS),
      fields: {
        user:      { enabled: true,  source: 'intune' },
        location:  { enabled: true,  source: 'verification' },
        state:     { enabled: false, source: 'verification', manualValue: '' },
        serial:    { enabled: false, source: 'intune' },
        model:     { enabled: false, source: 'intune' },
        os:        { enabled: false, source: 'intune' },
        osVersion: { enabled: false, source: 'intune' }
      },
      onlyChanged: true,
      requireIntuneMatch: true,
      skipRetired: true,
      alwaysColumns: defaultAlwaysColumns()
    };
  }

  function matchValue(row, matchField) {
    if (matchField === 'assetTag') return row.assetTag;
    if (matchField === 'serial') return N.clean(row.fs && row.fs.serial) || row.serial;
    return row.name;
  }

  /* Work out every change the current configuration would make.
     Returns [{ row, key, changes: [{field, current, proposed, source, reason}] }] */
  function buildProposals(rows, cfg) {
    cfg = cfg || defaultConfig();
    var out = [];

    rows.forEach(function (row) {
      if (!row.fs) return;                                   // nothing to update
      // Skipping retired assets is about not disturbing genuinely dead kit. An
      // asset flagged "retired but still in use" is demonstrably not dead, and
      // correcting that state is the whole point of the row - so the skip must
      // not remove exactly the assets the rule was written to find.
      if (cfg.skipRetired && N.isRetiredState(row.state) &&
          row.issues.indexOf('state-conflict-active') < 0) return;
      if (cfg.requireIntuneMatch && !row.intune && !row.ver) return;

      var key = matchValue(row, cfg.matchField);
      if (N.isBlank(key)) return;                            // cannot be matched on import

      var changes = [];
      Object.keys(cfg.fields).forEach(function (field) {
        var fcfg = cfg.fields[field];
        if (!fcfg || !fcfg.enabled) return;

        var proposed;
        if (fcfg.source === 'manual') {
          proposed = N.clean(fcfg.manualValue);
          // A fixed value only applies where the rule that motivated it fired.
          if (field === 'state' && row.issues.indexOf('state-conflict-active') < 0) return;
        } else {
          proposed = R.proposedValue(row, field, fcfg.source);
        }
        if (proposed === null || proposed === undefined || N.isBlank(proposed)) return;

        var current = R.currentValue(row, field);
        if (cfg.onlyChanged) {
          if (field === 'user') {
            if (N.comparePeople(current, proposed) === 'match') return;
          } else if (N.text(current) === N.text(proposed)) return;
        }

        changes.push({
          field: field,
          label: (UPDATABLE.filter(function (u) { return u.field === field; })[0] || {}).label || field,
          current: current === null || current === undefined ? '' : String(current),
          proposed: String(proposed),
          source: fcfg.source,
          reason: reasonFor(row, field)
        });
      });

      if (changes.length) out.push({ row: row, key: key, changes: changes });
    });

    return out;
  }

  function reasonFor(row, field) {
    var codes = row.issues.filter(function (c) {
      var rule = R.BY_CODE[c];
      return rule && rule.fix && rule.fix.field === field;
    });
    if (!codes.length) return '';
    return codes.map(function (c) { return R.BY_CODE[c].label; }).join('; ');
  }

  /* The file to upload to Freshservice: the match column plus one column per
     field being corrected. Rows carry only the fields that actually change,
     so an unrelated blank never overwrites good data. */
  function toImportCsv(proposals, cfg) {
    cfg = cfg || defaultConfig();
    var H = cfg.headers;
    var matchHeader = H[cfg.matchField] || 'Name';

    var fieldsUsed = [];
    proposals.forEach(function (p) {
      p.changes.forEach(function (c) {
        if (fieldsUsed.indexOf(c.field) < 0) fieldsUsed.push(c.field);
      });
    });
    var order = UPDATABLE.map(function (u) { return u.field; });
    fieldsUsed.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });

    /* Build the column list once, each with its own accessor, so headers and
       values cannot drift apart. Order: the match column, then the always-on
       columns, then whatever is left of the corrections. */
    var columns = [];
    var taken = {};

    function add(header, get) {
      header = String(header || '').trim();
      if (!header || taken[header]) return;      // never emit a duplicate heading
      taken[header] = true;
      columns.push({ header: header, get: get });
    }

    function changeFor(p, field) {
      return p.changes.filter(function (c) { return c.field === field; })[0] || null;
    }

    add(matchHeader, function (p) { return p.key; });

    (cfg.alwaysColumns || []).forEach(function (col) {
      if (col.kind === 'fixed') {
        add(col.header, function () { return col.value === undefined ? '' : col.value; });
        return;
      }
      add(col.header, function (p) {
        // A corrected value for this field takes precedence; otherwise the
        // column carries what Freshservice already has, so it is never empty.
        var ch = changeFor(p, col.field);
        return ch ? ch.proposed : fsFieldValue(p.row, col.field);
      });
    });

    fieldsUsed.forEach(function (f) {
      add(H[f] || f, function (p) {
        var ch = changeFor(p, f);
        return ch ? ch.proposed : fsFieldValue(p.row, f);
      });
    });

    var headers = columns.map(function (c) { return c.header; });
    var rows = proposals.map(function (p) {
      var obj = {};
      columns.forEach(function (c) { obj[c.header] = c.get(p); });
      return obj;
    });
    return global.CSV.stringify(rows, headers);
  }

  /* Which mandatory columns are missing from the current configuration. */
  function missingRequired(cfg) {
    var have = {};
    var matchHeader = (cfg.headers[cfg.matchField] || '').trim().toLowerCase();
    if (matchHeader) have[matchHeader] = true;
    (cfg.alwaysColumns || []).forEach(function (c) {
      var h = String(c.header || '').trim().toLowerCase();
      if (h) have[h] = true;
    });
    return ['Workspace', 'Name', 'Product'].filter(function (r) {
      return !have[r.toLowerCase()];
    });
  }

  /* A separate audit file: what changed, from what, to what, and why. */
  function toChangeLogCsv(proposals, cfg) {
    var headers = ['Device name', 'Asset tag', 'Match value', 'Field', 'Current value in Freshservice',
                   'Proposed value', 'Source of proposed value', 'Reason', 'Location', 'Last Intune check-in'];
    var rows = [];
    proposals.forEach(function (p) {
      p.changes.forEach(function (c) {
        rows.push({
          'Device name': p.row.name,
          'Asset tag': p.row.assetTag,
          'Match value': p.key,
          'Field': c.label,
          'Current value in Freshservice': c.current,
          'Proposed value': c.proposed,
          'Source of proposed value': SOURCE_LABELS[c.source] || c.source,
          'Reason': c.reason,
          'Location': p.row.location,
          'Last Intune check-in': p.row.lastCheckIn ? U.fmtDate(p.row.lastCheckIn) : ''
        });
      });
    });
    return global.CSV.stringify(rows, headers);
  }

  /* The sheet that goes out to a service. Freshservice's view of each device
     plus blank columns for the site to complete; drop the completed file back
     in as a verification return and the answers feed the import builder. */
  var PACK_BLANKS = ['Device present?', 'Confirmed location', 'Confirmed user', 'Confirmed status', 'Notes'];

  function sitePackCsv(rows, siteName) {
    var headers = ['Device name', 'Asset tag', 'Serial number', 'Freshservice location',
                   'Freshservice user', 'Intune user', 'Freshservice status',
                   'Last seen by Intune', 'What we think is wrong'].concat(PACK_BLANKS);

    var data = rows.map(function (r) {
      var obj = {
        'Device name': r.name,
        'Asset tag': r.assetTag,
        'Serial number': r.serial,
        'Freshservice location': r.locationRaw,
        'Freshservice user': r.fsUser,
        'Intune user': r.intuneUser,
        'Freshservice status': r.state,
        'Last seen by Intune': r.lastCheckIn ? U.fmtDate(r.lastCheckIn) : 'never',
        'What we think is wrong': r.issues.map(function (c) {
          return (R.BY_CODE[c] || {}).label || c;
        }).join('; ')
      };
      PACK_BLANKS.forEach(function (b) { obj[b] = ''; });
      return obj;
    });
    return global.CSV.stringify(data, headers);
  }

  /* Export whatever the user is currently looking at. */
  function viewCsv(rows, columnKeys) {
    var V = global.Views;
    var headers = columnKeys.map(function (k) {
      return (V.COL_BY_KEY[k] || { label: k }).label;
    });
    var data = rows.map(function (r) {
      var obj = {};
      columnKeys.forEach(function (k, i) {
        var v = V.colValue(r, k);
        if (Array.isArray(v)) {
          v = v.map(function (c) { return (R.BY_CODE[c] || {}).label || c; }).join('; ');
        } else if (v instanceof Date) {
          v = U.fmtDate(v);
        }
        obj[headers[i]] = v === null || v === undefined ? '' : v;
      });
      return obj;
    });
    return global.CSV.stringify(data, headers);
  }

  /* Re-export the location lookup with any coordinates that were found, so
     geocoding is a one-time job. */
  function locationsCsv(locations) {
    var headers = ['Location', 'Address', 'Town', 'Postcode', 'Latitude', 'Longitude',
                   'Expected devices', 'Region', 'Site type', 'Contact'];
    var rows = locations.map(function (l) {
      return {
        'Location': l.location,
        'Address': l.address || '',
        'Town': l.town || '',
        'Postcode': l.postcode || '',
        'Latitude': typeof l.lat === 'number' ? l.lat : '',
        'Longitude': typeof l.lon === 'number' ? l.lon : '',
        'Expected devices': typeof l.expected === 'number' ? l.expected : '',
        'Region': l.region || '',
        'Site type': l.siteType || '',
        'Contact': l.contact || ''
      };
    });
    return global.CSV.stringify(rows, headers);
  }

  global.FSExport = {
    DEFAULT_HEADERS: DEFAULT_HEADERS,
    UPDATABLE: UPDATABLE,
    FS_FIELDS: FS_FIELDS,
    fsFieldValue: fsFieldValue,
    defaultAlwaysColumns: defaultAlwaysColumns,
    missingRequired: missingRequired,
    SOURCE_LABELS: SOURCE_LABELS,
    defaultConfig: defaultConfig,
    buildProposals: buildProposals,
    toImportCsv: toImportCsv,
    toChangeLogCsv: toChangeLogCsv,
    sitePackCsv: sitePackCsv,
    viewCsv: viewCsv,
    locationsCsv: locationsCsv,
    matchValue: matchValue
  };
})(window);
