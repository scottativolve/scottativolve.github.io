/* Builds the files that go back out: the Freshservice update import, the
   change log that documents it, and the site verification packs. */
(function (global) {
  'use strict';

  var U = global.U, N = global.Norm, R = global.Rules;

  /* Freshservice's import expects your instance's own column labels, and
     those differ between tenants (and between the default and custom fields).
     Every header here is editable in the UI and remembered. */
  var DEFAULT_HEADERS = {
    name:      'Display Name',
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

  /* Columns carried through for identification and context rather than to
     change anything. They are written with the value Freshservice already
     holds, so mapping one on import is a no-op, and leaving it unmapped just
     gives whoever reviews the file something to recognise the asset by. */
  var REFERENCE = [
    { field: 'name',        label: 'Device name',        header: 'Display Name' },
    { field: 'assetTag',    label: 'Asset tag',          header: 'Asset Tag' },
    { field: 'serial',      label: 'Serial number',      header: 'Serial Number' },
    { field: 'location',    label: 'Location',           header: 'Location' },
    { field: 'user',        label: 'Assigned user',      header: 'Used By' },
    { field: 'state',       label: 'Asset state',        header: 'Asset State' },
    { field: 'lastCheckIn', label: 'Last Intune check-in', header: 'Last Check-in' }
  ];

  function referenceValue(row, field) {
    if (field === 'name') return row.name;
    if (field === 'assetTag') return row.assetTag;
    if (field === 'lastCheckIn') return row.lastCheckIn ? U.fmtDate(row.lastCheckIn) : '';
    return R.currentValue(row, field);
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
      reference: { serial: false, assetTag: false, name: false, location: false,
                   user: false, state: false, lastCheckIn: false },
      referenceHeaders: REFERENCE.reduce(function (acc, r) { acc[r.field] = r.header; return acc; }, {})
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
    var matchHeader = H[cfg.matchField] || 'Display Name';

    var fieldsUsed = [];
    proposals.forEach(function (p) {
      p.changes.forEach(function (c) {
        if (fieldsUsed.indexOf(c.field) < 0) fieldsUsed.push(c.field);
      });
    });
    // Keep a stable, human-sensible column order.
    var order = UPDATABLE.map(function (u) { return u.field; });
    fieldsUsed.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });

    // Reference columns sit between the match column and the updates. A field
    // being updated already has a column, so it never doubles up here.
    var refCfg = cfg.reference || {};
    var refHeaders = cfg.referenceHeaders || {};
    var refs = REFERENCE.filter(function (r) {
      if (!refCfg[r.field]) return false;
      if (fieldsUsed.indexOf(r.field) >= 0) return false;
      return (refHeaders[r.field] || r.header) !== matchHeader;
    });

    var headers = [matchHeader]
      .concat(refs.map(function (r) { return refHeaders[r.field] || r.header; }))
      .concat(fieldsUsed.map(function (f) { return H[f] || f; }));

    var rows = proposals.map(function (p) {
      var obj = {};
      obj[matchHeader] = p.key;
      refs.forEach(function (r) {
        obj[refHeaders[r.field] || r.header] = referenceValue(p.row, r.field);
      });
      fieldsUsed.forEach(function (f) {
        var ch = p.changes.filter(function (c) { return c.field === f; })[0];
        obj[H[f] || f] = ch ? ch.proposed : '';
      });
      return obj;
    });
    return global.CSV.stringify(rows, headers);
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
    REFERENCE: REFERENCE,
    referenceValue: referenceValue,
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
