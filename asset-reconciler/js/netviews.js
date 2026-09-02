/* Columns and views for network assets. Same filter engine as the PC side,
   a wholly different set of columns and questions. */
(function (global) {
  'use strict';

  var U = global.U, N = global.Norm;

  var KIND_ORDER = { FortiGate: 1, FortiSwitch: 2, FortiAP: 3 };

  /* Rows carry the export file they came from, which is unique but unreadable.
     The app supplies the name the user gave that environment. */
  var labelEnv = function (key) { return key; };
  function envLabel(key) { return labelEnv(key); }

  var COLUMNS = [
    { key: 'notes',      label: 'Notes',        width: 64, type: 'notes',
      get: function (r) { return global.Notes.countFor(r); },
      sortKey: function (r) { return -global.Notes.countFor(r); } },
    { key: 'name',       label: 'Device name',  width: 190, get: function (r) { return r.name; }, strong: true },
    { key: 'kind',       label: 'Type',         width: 100, get: function (r) { return r.kind; },
      sortKey: function (r) { return (KIND_ORDER[r.kind] || 9) + r.name; } },
    { key: 'severity',   label: 'Severity',     width: 90,  get: function (r) { return r.severity || ''; },
      sortKey: function (r) { return r.severity ? -global.NetMatch.SEVERITY_ORDER[r.severity] : 9; } },
    { key: 'issues',     label: 'Issues',       width: 300, type: 'issues', get: function (r) { return r.issues; },
      sortKey: function (r) { return -r.issueCount; } },
    { key: 'issueCount', label: 'Issue count',  width: 70, type: 'number', get: function (r) { return r.issueCount; } },
    { key: 'status',     label: 'Present in',   width: 120,
      get: function (r) {
        return r.status === 'matched' ? 'both' : (r.status === 'forti-only' ? 'FortiManager only' : 'Freshservice only');
      } },
    { key: 'serial',     label: 'Serial',       width: 150, get: function (r) { return r.serial; } },
    { key: 'platform',   label: 'Platform',     width: 160, get: function (r) { return r.platform; } },
    { key: 'env',        label: 'Environment',  width: 130,
      get: function (r) { return r.envs.map(envLabel).join(', '); } },

    { key: 'siteCode',   label: 'Site code',    width: 80,  get: function (r) { return r.siteCode; } },
    { key: 'siteName',   label: 'Site',         width: 180, get: function (r) { return r.siteName; } },
    { key: 'siteSource', label: 'Site from',    width: 100, get: function (r) { return r.siteSource; } },
    { key: 'town',       label: 'Town',         width: 130, get: function (r) { return r.site ? N.clean(r.site.town) : ''; } },
    { key: 'postcode',   label: 'Postcode',     width: 95,  get: function (r) { return r.site ? N.clean(r.site.postcode) : ''; } },
    { key: 'region',     label: 'Region',       width: 130, get: function (r) { return r.site ? N.clean(r.site.region) : ''; } },

    { key: 'parent',     label: 'Under firewall', width: 190, get: function (r) { return r.parent; } },
    { key: 'haRole',     label: 'HA role',      width: 90,  get: function (r) { return r.haRole; } },
    { key: 'haSync',     label: 'HA sync',      width: 120, get: function (r) { return r.haSync; } },
    { key: 'configStatus', label: 'Config status', width: 150, get: function (r) { return r.configStatus; } },

    { key: 'firmware',   label: 'Firmware (Forti)', width: 120, get: function (r) { return r.firmware; } },
    { key: 'firmwareText', label: 'Firmware (full)', width: 260, get: function (r) { return r.firmwareText; } },
    { key: 'fsFirmware', label: 'Firmware (FS)', width: 120, get: function (r) { return r.fsFirmware; } },
    { key: 'reported',   label: 'Reported in?', width: 100,
      get: function (r) { return r.forti ? (r.reported ? 'yes' : 'never') : ''; } },

    { key: 'fsName',     label: 'FS name',      width: 190, get: function (r) { return r.fsName; } },
    { key: 'fsLocation', label: 'FS location',  width: 180, get: function (r) { return r.fsLocation; } },
    { key: 'fsState',    label: 'FS state',     width: 110, get: function (r) { return r.fsState; } },
    { key: 'fsAssetType',label: 'FS asset type',width: 130, get: function (r) { return r.fsAssetType; } },
    { key: 'fsProduct',  label: 'FS product',   width: 170, get: function (r) { return r.fsProduct; } },
    { key: 'fsTag',      label: 'FS asset tag', width: 110, get: function (r) { return r.fsTag; } },
    { key: 'lastAudit',  label: 'FS last audit',width: 120, type: 'date', get: function (r) { return r.lastAudit; },
      sortKey: function (r) { return r.lastAudit ? r.lastAudit.getTime() : 0; } },

    { key: 'ipForti',    label: 'IP (Forti)',   width: 130, get: function (r) { return r.ipForti; } },
    { key: 'ipFs',       label: 'IP (FS)',      width: 130, get: function (r) { return r.ipFs; } },
    { key: 'matchedBy',  label: 'Matched on',   width: 100, get: function (r) { return r.matchedBy; } }
  ];

  var BASE_COLS = ['name', 'kind', 'severity', 'status', 'serial', 'siteName', 'firmware', 'issues'];

  var E = global.Views.engine(COLUMNS, BASE_COLS);

  function issueView(id, name, description, codes, columns) {
    return {
      id: id, name: name, description: description, columns: columns || BASE_COLS,
      filter: { match: 'any', conditions: codes.map(function (c) { return { field: '__issue', op: 'is', value: c }; }) },
      sort: { key: 'severity', dir: 'asc' }
    };
  }

  var BUILT_IN = [
    {
      id: 'net-attention',
      name: 'Needs attention',
      description: 'Every network device with at least one open discrepancy, worst first.',
      columns: ['name', 'kind', 'severity', 'status', 'siteName', 'firmware', 'fsFirmware', 'issues'],
      filter: { match: 'all', conditions: [{ field: '__anyIssue', op: 'is' }] },
      sort: { key: 'severity', dir: 'asc' }
    },
    issueView('net-new', 'New since last import',
      'Managed by FortiManager with no Freshservice record at all. These are the rows to build an import from.',
      ['missing-from-fs'],
      ['name', 'kind', 'serial', 'platform', 'siteCode', 'siteName', 'env', 'firmware', 'parent']),
    issueView('net-replaced', 'Possibly replaced',
      'On a Freshservice record but managed by neither FortiManager environment — replaced, decommissioned, or never removed.',
      ['missing-from-forti'],
      ['fsName', 'kind', 'serial', 'fsProduct', 'fsLocation', 'fsState', 'lastAudit', 'fsTag']),
    issueView('net-retired-managed', 'Retired but still managed',
      'Freshservice says retired or disposed; FortiManager is still managing it.',
      ['retired-but-managed'],
      ['name', 'kind', 'serial', 'fsState', 'siteName', 'fsLocation', 'env', 'issues']),
    issueView('net-dupes', 'Duplicates',
      'One serial on more than one record, in FortiManager or in Freshservice, or managed by both environments.',
      ['duplicate-in-forti', 'duplicate-in-fs', 'cross-environment'],
      ['name', 'kind', 'serial', 'env', 'parent', 'siteName', 'issues']),
    issueView('net-firmware', 'Firmware to update',
      'What FortiManager reports does not match what Freshservice records — including records with no firmware at all.',
      ['firmware-drift', 'firmware-missing-in-fs'],
      ['name', 'kind', 'serial', 'firmware', 'fsFirmware', 'platform', 'siteName', 'issues']),
    issueView('net-location', 'Location to fix',
      'The site the device name resolves to disagrees with Freshservice, is missing, or could not be worked out at all.',
      ['location-mismatch', 'location-missing-in-fs', 'site-unresolved', 'site-name-suspect'],
      ['name', 'kind', 'siteCode', 'siteName', 'siteSource', 'fsLocation', 'parent', 'issues']),
    issueView('net-never-reported', 'Never reported in',
      'Authorised in FortiManager but has never reported a firmware version — pre-staged, or it never came online.',
      ['never-reported'],
      ['name', 'kind', 'serial', 'platform', 'siteName', 'parent', 'env', 'configStatus']),
    {
      id: 'net-ha',
      name: 'HA clusters',
      description: 'Both members of every high-availability pair, split out of the single row FortiManager exports.',
      columns: ['name', 'serial', 'haRole', 'haSync', 'siteCode', 'siteName', 'platform', 'firmware', 'env'],
      filter: { match: 'all', conditions: [{ field: 'haRole', op: 'notEmpty' }] },
      sort: { key: 'name', dir: 'asc' }
    },
    issueView('net-unnamed', 'Still named after serial',
      'Never renamed after joining the fabric.',
      ['named-by-serial'],
      ['name', 'kind', 'serial', 'platform', 'siteName', 'parent', 'env']),
    {
      id: 'net-firewalls',
      name: 'Firewalls',
      description: 'Every FortiGate, one row per physical unit.',
      columns: ['name', 'severity', 'status', 'serial', 'platform', 'siteName', 'firmware', 'configStatus', 'ipForti'],
      filter: { match: 'all', conditions: [{ field: 'kind', op: 'is', value: 'FortiGate' }] },
      sort: { key: 'siteCode', dir: 'asc' }
    },
    {
      id: 'net-switches',
      name: 'Switches',
      description: 'Every FortiSwitch, with the firewall it sits under.',
      columns: ['name', 'severity', 'status', 'serial', 'platform', 'siteName', 'parent', 'firmware'],
      filter: { match: 'all', conditions: [{ field: 'kind', op: 'is', value: 'FortiSwitch' }] },
      sort: { key: 'siteCode', dir: 'asc' }
    },
    {
      id: 'net-aps',
      name: 'Access points',
      description: 'Every FortiAP, with the firewall it sits under.',
      columns: ['name', 'severity', 'status', 'serial', 'platform', 'siteName', 'parent', 'firmware'],
      filter: { match: 'all', conditions: [{ field: 'kind', op: 'is', value: 'FortiAP' }] },
      sort: { key: 'siteCode', dir: 'asc' }
    },
    {
      id: 'net-all',
      name: 'All network devices',
      description: 'Everything from both systems after matching, whether or not anything is wrong with it.',
      columns: ['name', 'kind', 'status', 'serial', 'platform', 'siteName', 'env', 'firmware', 'issues'],
      filter: null,
      sort: { key: 'siteCode', dir: 'asc' }
    }
  ];

  global.NetViews = Object.assign({
    engine: global.Views.engine,
    BUILT_IN: BUILT_IN,
    setEnvLabeller: function (fn) { labelEnv = fn || function (k) { return k; }; }
  }, E);
})(window);
