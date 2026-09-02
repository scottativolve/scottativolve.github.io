/* Columns, the filter engine, and the built-in + saved views. */
(function (global) {
  'use strict';

  var U = global.U, N = global.Norm;

  /* ------------------------------------------------------------ columns */

  var COLUMNS = [
    { key: 'notes',       label: 'Notes',         width: 64, type: 'notes',
      get: function (r) { return global.Notes.countFor(r); },
      sortKey: function (r) { return -global.Notes.countFor(r); } },
    { key: 'name',        label: 'Device name',   width: 150, get: function (r) { return r.name; }, strong: true },
    { key: 'severity',    label: 'Severity',      width: 90,  get: function (r) { return r.severity || ''; },
      sortKey: function (r) { return r.severity ? -global.Rules.SEVERITY_ORDER[r.severity] : 9; } },
    { key: 'issues',      label: 'Issues',        width: 300, type: 'issues', get: function (r) { return r.issues; },
      sortKey: function (r) { return -r.issueCount; } },
    { key: 'issueCount',  label: 'Issue count',   width: 70,  type: 'number', get: function (r) { return r.issueCount; } },
    { key: 'location',    label: 'Location',      width: 150, get: function (r) { return r.location; } },
    { key: 'locationRaw', label: 'Location (raw)',width: 190, get: function (r) { return r.locationRaw; } },
    { key: 'region',      label: 'Region',        width: 120, get: function (r) { return r.region; } },
    { key: 'fsUser',      label: 'FS user',       width: 150, get: function (r) { return r.fsUser; } },
    { key: 'intuneUser',  label: 'Intune user',   width: 150, get: function (r) { return r.intuneUser; } },
    { key: 'userStatus',  label: 'User agrees?',  width: 100, get: function (r) { return r.userStatus; } },
    { key: 'lastLoginBy', label: 'Last login by', width: 150, get: function (r) { return r.lastLoginBy; } },
    { key: 'loginVsAssigned', label: 'Login vs assigned', width: 120, get: function (r) { return r.loginVsAssigned; } },
    { key: 'state',       label: 'FS state',      width: 110, get: function (r) { return r.state; } },
    { key: 'assetType',   label: 'Asset type',    width: 120, get: function (r) { return r.assetType; } },
    { key: 'serial',      label: 'Serial',        width: 130, get: function (r) { return r.serial; } },
    { key: 'assetTag',    label: 'Asset tag',     width: 110, get: function (r) { return r.assetTag; } },
    { key: 'model',       label: 'Model',         width: 160, get: function (r) { return r.model; } },
    { key: 'os',          label: 'OS',            width: 130, get: function (r) { return r.os; } },
    { key: 'osVersion',   label: 'OS version',    width: 110, get: function (r) { return r.osVersion; } },
    { key: 'compliance',  label: 'Compliance',    width: 110, get: function (r) { return r.compliance; } },
    { key: 'ownership',   label: 'Ownership',     width: 100, get: function (r) { return r.ownership; } },
    { key: 'riskScore',   label: 'Risk score',    width: 80, type: 'number', get: function (r) { return r.riskScore; } },
    { key: 'risks',       label: 'Open risks',    width: 85, type: 'number', get: function (r) { return r.risks; } },
    { key: 'awLastScan',  label: 'Last scan',     width: 115, type: 'date', get: function (r) { return r.awLastScan; } },
    { key: 'awCriticality', label: 'AW criticality', width: 110, get: function (r) { return r.awCriticality; } },
    { key: 'awCategory',  label: 'AW category',   width: 100, get: function (r) { return r.awCategory; } },
    { key: 'ip',          label: 'Last seen IP',  width: 120, get: function (r) { return r.ip; } },
    { key: 'ipSiteName',  label: 'Site by IP',    width: 150, get: function (r) { return r.ipSiteName; } },
    { key: 'ipStatus',    label: 'IP vs location',width: 130, get: function (r) { return r.ipStatus; } },
    { key: 'ipSubnet',    label: 'Matched subnet',width: 170, get: function (r) { return r.ipSubnet; } },
    { key: 'ipFrom',      label: 'IP reported by',width: 110, get: function (r) { return r.ipFrom; } },
    { key: 'lastCheckIn', label: 'Intune check-in', width: 120, type: 'date', get: function (r) { return r.lastCheckIn; } },
    { key: 'daysSinceCheckIn', label: 'Days since check-in', width: 90, type: 'number', get: function (r) { return r.daysSinceCheckIn; } },
    { key: 'lastAudit',   label: 'FS last audit', width: 120, type: 'date', get: function (r) { return r.lastAudit; } },
    { key: 'department',  label: 'Department',    width: 130, get: function (r) { return r.department; } },
    { key: 'matchType',   label: 'Matched on',    width: 100, get: function (r) { return r.matchType; } },
    { key: 'verLocation', label: 'Site confirmed location', width: 150, get: function (r) { return r.ver ? N.clean(r.ver.confirmedLocation) : ''; } },
    { key: 'verUser',     label: 'Site confirmed user', width: 150, get: function (r) { return r.ver ? N.clean(r.ver.confirmedUser) : ''; } },
    { key: 'verNotes',    label: 'Site notes',    width: 200, get: function (r) { return r.ver ? N.clean(r.ver.notes) : ''; } },
    { key: 'address',     label: 'Address',       width: 220, get: function (r) { return r.site ? [N.clean(r.site.address), N.clean(r.site.town), N.clean(r.site.postcode)].filter(Boolean).join(', ') : ''; } },
    { key: 'postcode',    label: 'Postcode',      width: 90,  get: function (r) { return r.site ? N.clean(r.site.postcode) : ''; } }
  ];

  var OPERATORS = [
    { op: 'is',          label: 'is',             needsValue: true },
    { op: 'isNot',       label: 'is not',         needsValue: true },
    { op: 'contains',    label: 'contains',       needsValue: true },
    { op: 'notContains', label: 'does not contain', needsValue: true },
    { op: 'empty',       label: 'is empty',       needsValue: false },
    { op: 'notEmpty',    label: 'is not empty',   needsValue: false },
    { op: 'gt',          label: 'is more than',   needsValue: true, numeric: true },
    { op: 'lt',          label: 'is less than',   needsValue: true, numeric: true },
    { op: 'olderThan',   label: 'is older than (days)', needsValue: true, numeric: true },
    { op: 'newerThan',   label: 'is newer than (days)', needsValue: true, numeric: true }
  ];

  /* ------------------------------------------------------ filter engine */

  /* The engine is the same whatever the rows are: it only ever reaches a row
     through the column registry it is given. Network assets have their own
     columns and their own views, so they build their own engine over the same
     code rather than a second copy of it. */
  function engine(columns, baseCols) {
    var COL_BY_KEY = {};
    columns.forEach(function (c) { COL_BY_KEY[c.key] = c; });

    function colValue(row, key) {
      var c = COL_BY_KEY[key];
      return c ? c.get(row) : '';
    }

    /* ------------------------------------------------------ filter engine */

    function testCondition(row, cond) {
      // Pseudo-field: issue codes.
      if (cond.field === '__issue') {
        var has = row.issues.indexOf(cond.value) >= 0;
        return cond.op === 'isNot' ? !has : has;
      }
      if (cond.field === '__anyIssue') {
        return cond.op === 'isNot' ? row.issueCount === 0 : row.issueCount > 0;
      }

      var v = colValue(row, cond.field);
      var col = COL_BY_KEY[cond.field] || {};
      var isDate = col.type === 'date' || v instanceof Date;
      var target = cond.value;

      switch (cond.op) {
        case 'empty':    return v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
        case 'notEmpty': return !(v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length));
        case 'gt':       return v !== null && v !== '' && Number(v) > Number(target);
        case 'lt':       return v !== null && v !== '' && Number(v) < Number(target);
        case 'olderThan': {
          var d1 = U.daysSince(v);
          return d1 !== null && d1 > Number(target);
        }
        case 'newerThan': {
          var d2 = U.daysSince(v);
          return d2 !== null && d2 < Number(target);
        }
        default: {
          var s = (Array.isArray(v) ? v.join(' ') : (isDate ? U.fmtDate(v) : String(v === null || v === undefined ? '' : v))).toLowerCase();
          var t = String(target === null || target === undefined ? '' : target).toLowerCase().trim();
          if (cond.op === 'is') return s === t;
          if (cond.op === 'isNot') return s !== t;
          if (cond.op === 'contains') return s.indexOf(t) >= 0;
          if (cond.op === 'notContains') return s.indexOf(t) < 0;
          return true;
        }
      }
    }

    function testFilter(row, filter) {
      if (!filter || !filter.conditions || !filter.conditions.length) return true;
      var results = filter.conditions.map(function (c) { return testCondition(row, c); });
      return filter.match === 'any' ? results.some(Boolean) : results.every(Boolean);
    }

    /* ------------------------------------------------------- built-in views */

    var SEARCHABLE = null;
    function searchRows(rows, q) {
      q = String(q || '').toLowerCase().trim();
      if (!q) return rows;
      if (!SEARCHABLE) SEARCHABLE = columns.map(function (c) { return c.key; });
      return rows.filter(function (r) {
        for (var i = 0; i < SEARCHABLE.length; i++) {
          var v = colValue(r, SEARCHABLE[i]);
          if (v === null || v === undefined || v === '') continue;
          if (Array.isArray(v)) v = v.join(' ');
          else if (v instanceof Date) v = global.U.fmtDate(v);
          if (String(v).toLowerCase().indexOf(q) >= 0) return true;
        }
        return false;
      });
    }

    function applyView(view, rows) {
      var out = rows;
      if (view.custom) out = view.custom(out);
      else if (view.filter) out = out.filter(function (r) { return testFilter(r, view.filter); });
      if (view.sort) {
        var col = COL_BY_KEY[view.sort.key];
        var keyFn = col && col.sortKey ? col.sortKey : function (r) { return colValue(r, view.sort.key); };
        out = U.sortBy(out, keyFn, view.sort.dir);
      }
      return out;
    }

    return {
      COLUMNS: columns,
      COL_BY_KEY: COL_BY_KEY,
      BASE_COLS: (baseCols || []).slice(),
      OPERATORS: OPERATORS,
      colValue: colValue,
      testCondition: testCondition,
      testFilter: testFilter,
      searchRows: searchRows,
      applyView: applyView
    };
  }

  var BASE_COLS = ['name', 'location', 'fsUser', 'intuneUser', 'state', 'lastCheckIn', 'issues'];

  var BUILT_IN = [
    {
      id: 'all',
      name: 'All devices',
      description: 'Every record from both systems after matching, whether or not anything is wrong with it.',
      columns: ['name', 'severity', 'location', 'fsUser', 'intuneUser', 'state', 'serial', 'lastCheckIn', 'matchType', 'issues'],
      filter: null
    },
    {
      id: 'attention',
      name: 'Needs attention',
      description: 'Anything with at least one open discrepancy, worst first. The general working list.',
      columns: ['name', 'severity', 'location', 'fsUser', 'intuneUser', 'state', 'lastCheckIn', 'issues'],
      filter: { match: 'all', conditions: [{ field: '__anyIssue', op: 'is' }] },
      sort: { key: 'severity', dir: 'asc' }
    },
    {
      id: 'fix-user',
      name: 'Fix: assigned user',
      description: 'Freshservice disagrees with Intune about who has the device, or has nobody recorded at all. These are the rows the import file can correct automatically.',
      columns: ['name', 'location', 'fsUser', 'intuneUser', 'lastLoginBy', 'userStatus', 'lastCheckIn', 'issues'],
      filter: { match: 'any', conditions: [
        { field: '__issue', op: 'is', value: 'user-mismatch' },
        { field: '__issue', op: 'is', value: 'login-differs-from-assigned' },
        { field: '__issue', op: 'is', value: 'user-missing-fs' },
        { field: '__issue', op: 'is', value: 'user-similar' }
      ] }
    },
    {
      id: 'fix-location',
      name: 'Fix: location',
      description: 'Assets with no location, or a location that is not in the lookup file. These are the ones to send out to services to confirm.',
      columns: ['name', 'locationRaw', 'fsUser', 'intuneUser', 'state', 'lastCheckIn', 'issues'],
      filter: { match: 'any', conditions: [
        { field: '__issue', op: 'is', value: 'location-missing' },
        { field: '__issue', op: 'is', value: 'location-unknown' }
      ] }
    },
    {
      id: 'not-in-intune',
      name: 'Missing from Intune',
      description: 'Freshservice holds the asset but Intune does not manage it. Not enrolled, disposed of without an update, or switched off long-term.',
      columns: ['name', 'location', 'fsUser', 'state', 'assetType', 'serial', 'lastAudit', 'issues'],
      filter: { match: 'all', conditions: [{ field: '__issue', op: 'is', value: 'not-in-intune' }] }
    },
    {
      id: 'not-in-fs',
      name: 'Missing from Freshservice',
      description: 'Intune manages the device but there is no asset record. Usually a missing Freshservice agent.',
      columns: ['name', 'intuneUser', 'model', 'os', 'serial', 'lastCheckIn', 'ownership', 'issues'],
      filter: { match: 'all', conditions: [{ field: '__issue', op: 'is', value: 'not-in-freshservice' }] }
    },
    {
      id: 'stale',
      name: 'Stale devices',
      description: 'Nothing heard from Intune for longer than the staleness threshold. Candidates for a physical check.',
      columns: ['name', 'location', 'fsUser', 'state', 'lastCheckIn', 'daysSinceCheckIn', 'issues'],
      filter: { match: 'all', conditions: [{ field: '__issue', op: 'is', value: 'stale-intune' }] },
      sort: { key: 'daysSinceCheckIn', dir: 'desc' }
    },
    {
      id: 'state-conflicts',
      name: 'Status conflicts',
      description: 'The asset state in Freshservice contradicts what Intune sees — retired machines still in use, or in-use machines that went quiet.',
      columns: ['name', 'location', 'state', 'fsUser', 'intuneUser', 'lastCheckIn', 'daysSinceCheckIn', 'issues'],
      filter: { match: 'any', conditions: [
        { field: '__issue', op: 'is', value: 'state-conflict-active' },
        { field: '__issue', op: 'is', value: 'state-conflict-idle' }
      ] }
    },
    {
      id: 'site-check',
      name: 'Site verification pack',
      description: 'One row per device grouped by service, with blank columns for the site to complete. Export this and send it out.',
      columns: ['location', 'name', 'assetTag', 'fsUser', 'intuneUser', 'state', 'lastCheckIn'],
      filter: { match: 'all', conditions: [{ field: '__anyIssue', op: 'is' }] },
      group: 'location',
      pack: true
    },
    {
      id: 'moved-by-ip',
      name: 'Moved: IP says elsewhere',
      description: 'The network each device was last seen on belongs to a different site than Freshservice has it ' +
                   'assigned to. The strongest evidence you have that kit has physically moved.',
      columns: ['name', 'location', 'ipSiteName', 'ip', 'ipSubnet', 'fsUser', 'lastCheckIn', 'issues'],
      filter: { match: 'any', conditions: [
        { field: '__issue', op: 'is', value: 'ip-location-mismatch' },
        { field: '__issue', op: 'is', value: 'ip-suggests-location' }
      ] }
    },
    {
      id: 'off-network',
      name: 'Off the site network',
      description: 'Last seen on an address matching none of your site ranges — usually remote workers on home ' +
                   'broadband, but also sites whose subnet is missing from the lookup.',
      columns: ['name', 'location', 'ip', 'fsUser', 'intuneUser', 'lastCheckIn', 'issues'],
      filter: { match: 'all', conditions: [{ field: '__issue', op: 'is', value: 'ip-off-network' }] }
    },
    {
      id: 'risk-score',
      name: 'Vulnerability: worst risk score',
      description: 'Devices ranked by the Arctic Wolf risk score, highest first. The score reflects the severity ' +
                   'of the worst finding on the machine rather than how many there are.',
      columns: ['name', 'riskScore', 'risks', 'location', 'fsUser', 'awLastScan', 'lastCheckIn', 'issues'],
      filter: { match: 'all', conditions: [{ field: 'riskScore', op: 'notEmpty' }] },
      sort: { key: 'riskScore', dir: 'desc' }
    },
    {
      id: 'most-risks',
      name: 'Vulnerability: most open risks',
      description: 'Devices ranked by how many open findings they carry, most first. A long tail usually means ' +
                   'the machine is behind on patching.',
      columns: ['name', 'risks', 'riskScore', 'location', 'fsUser', 'awLastScan', 'lastCheckIn', 'issues'],
      filter: { match: 'all', conditions: [{ field: 'risks', op: 'notEmpty' }] },
      sort: { key: 'risks', dir: 'desc' }
    },
    {
      id: 'not-scanned',
      name: 'No vulnerability scan',
      description: 'Live devices with no Arctic Wolf record at all — a scanning coverage gap rather than a data ' +
                   'mismatch, usually meaning the agent is not deployed.',
      columns: ['name', 'location', 'fsUser', 'os', 'lastCheckIn', 'state', 'issues'],
      filter: { match: 'any', conditions: [
        { field: '__issue', op: 'is', value: 'not-scanned' },
        { field: '__issue', op: 'is', value: 'scan-stale' }
      ] }
    },
    {
      id: 'duplicates',
      name: 'Duplicate names',
      description: 'The same device name appears more than once in a source export.',
      columns: ['name', 'location', 'fsUser', 'state', 'serial', 'lastCheckIn', 'matchType', 'issues'],
      filter: { match: 'all', conditions: [{ field: '__issue', op: 'is', value: 'duplicate-name' }] },
      sort: { key: 'name', dir: 'asc' }
    },
    {
      id: 'clean',
      name: 'Clean records',
      description: 'Matched in both systems with nothing flagged. Useful as a denominator, and for sense-checking the rules.',
      columns: ['name', 'location', 'fsUser', 'state', 'serial', 'model', 'lastCheckIn'],
      filter: { match: 'all', conditions: [{ field: '__anyIssue', op: 'isNot' }] }
    },
    {
      id: 'other-assets',
      name: 'Other asset types',
      description: 'Freshservice assets outside the computer types — network hardware, phones, screens. Not compared against Intune, but counted and mapped.',
      columns: ['name', 'assetType', 'location', 'fsUser', 'state', 'serial', 'model', 'assetTag'],
      filter: null,
      custom: function (rows) { return rows.filter(function (r) { return r.fs && !r.inScope; }); }
    }
  ];

  /* The quick-search box over a list of rows.

     It searches every field, not only the columns currently on screen. Tying
     it to the visible columns made the result depend on the column picker,
     which meant the table and the export could disagree about what "shown"
     meant - and typing a value whose column you had not added found nothing.
     Searching everything is both more useful (a serial number is findable
     without adding the column) and impossible to get out of step. */
  var PC = engine(COLUMNS, BASE_COLS);

  global.Views = Object.assign({ engine: engine, BUILT_IN: BUILT_IN }, PC);
})(window);
