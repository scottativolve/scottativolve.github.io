/* Columns and views for printers. Same filter engine as the other two
   populations, and the emphasis is on corrections: the register is complete,
   so almost every view is a field to put right. */
(function (global) {
  'use strict';

  var U = global.U, N = global.Norm;

  var COLUMNS = [
    { key: 'notes',      label: 'Notes',        width: 64, type: 'notes',
      get: function (r) { return global.Notes.countFor(r); },
      sortKey: function (r) { return -global.Notes.countFor(r); } },
    { key: 'name',       label: 'Printer',      width: 150, get: function (r) { return r.name; }, strong: true },
    { key: 'serial',     label: 'Serial',       width: 140, get: function (r) { return r.serial; } },
    { key: 'severity',   label: 'Severity',     width: 90,  get: function (r) { return r.severity || ''; },
      sortKey: function (r) { return r.severity ? -global.Printers.SEVERITY_ORDER[r.severity] : 9; } },
    { key: 'issues',     label: 'Issues',       width: 300, type: 'issues', get: function (r) { return r.issues; },
      sortKey: function (r) { return -r.issueCount; } },
    { key: 'issueCount', label: 'Issue count',  width: 70, type: 'number', get: function (r) { return r.issueCount; } },
    { key: 'status',     label: 'Present in',   width: 130,
      get: function (r) {
        return r.status === 'matched' ? 'both'
             : r.status === 'onestop-only' ? 'OneStop only' : 'Freshservice only';
      } },

    { key: 'model',      label: 'Model (OneStop)', width: 170, get: function (r) { return r.model; } },
    { key: 'fsProduct',  label: 'Product (FS)',  width: 150, get: function (r) { return r.fsProduct; } },
    { key: 'productShould', label: 'Product should be', width: 150, get: function (r) { return r.productShould; } },
    { key: 'fsVendor',   label: 'Vendor (FS)',   width: 110, get: function (r) { return r.fsVendor; } },
    { key: 'vendorShould', label: 'Vendor should be', width: 110, get: function (r) { return r.vendorShould; } },
    { key: 'fsState',    label: 'Asset state',   width: 110, get: function (r) { return r.fsState; } },
    { key: 'fsAssetType',label: 'Asset type',    width: 110, get: function (r) { return r.fsAssetType; } },
    { key: 'printerType',label: 'Printer type',  width: 110, get: function (r) { return r.fsPrinterType; } },

    { key: 'siteCode',   label: 'Site code',     width: 80,  get: function (r) { return r.siteCode; } },
    { key: 'siteResolved', label: 'Site',        width: 180, get: function (r) { return r.siteResolved; } },
    { key: 'fsLocation', label: 'Location (FS)', width: 170, get: function (r) { return r.fsLocation; } },
    { key: 'siteName',   label: 'Site (OneStop)',width: 220, get: function (r) { return r.siteName; } },
    { key: 'spot',       label: 'Where in the building', width: 170, get: function (r) { return r.spot; } },
    { key: 'town',       label: 'Town',          width: 130, get: function (r) { return r.site ? N.clean(r.site.town) : ''; } },
    { key: 'postcode',   label: 'Postcode',      width: 95,  get: function (r) { return r.site ? N.clean(r.site.postcode) : r.postcode; } },
    { key: 'region',     label: 'Region',        width: 130, get: function (r) { return r.site ? N.clean(r.site.region) : ''; } },

    { key: 'ipOnestop',  label: 'IP (OneStop)',  width: 130, get: function (r) { return r.ipOnestop; } },
    { key: 'ipFs',       label: 'IP (FS)',       width: 130, get: function (r) { return r.ipFs; } },
    { key: 'macOnestop', label: 'MAC (OneStop)', width: 150, get: function (r) { return r.macOnestop; } },
    { key: 'macFs',      label: 'MAC (FS)',      width: 150, get: function (r) { return r.macFs; } },

    { key: 'mono',       label: 'Mono pages',    width: 100, type: 'number', get: function (r) { return r.mono; } },
    { key: 'colour',     label: 'Colour pages',  width: 100, type: 'number', get: function (r) { return r.colour; } },
    { key: 'pages',      label: 'Pages, total',  width: 105, type: 'number', get: function (r) { return r.pages; } },
    { key: 'lastSeen',   label: 'Last reported', width: 120, type: 'date', get: function (r) { return r.lastSeen; },
      sortKey: function (r) { return r.lastSeen ? r.lastSeen.getTime() : 0; } },
    { key: 'monitored',  label: 'Monitored',     width: 100,
      get: function (r) { return r.monitored === null ? '' : (r.monitored ? 'yes' : 'no'); } },
    { key: 'proactive',  label: 'Proactive toner', width: 120,
      get: function (r) { return r.proactive === null ? '' : (r.proactive ? 'yes' : 'no'); } },

    { key: 'fsTag',      label: 'Asset tag (FS)', width: 110, get: function (r) { return r.fsTag; } },
    { key: 'siteNum',    label: 'Site no. (OneStop)', width: 120, get: function (r) { return r.siteNum; } },
    { key: 'contract',   label: 'Contract',      width: 100, get: function (r) { return r.contract; } },
    { key: 'matchedBy',  label: 'Matched on',    width: 100, get: function (r) { return r.matchedBy; } }
  ];

  var BASE_COLS = ['name', 'serial', 'severity', 'model', 'siteResolved', 'fsState', 'issues'];

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
      id: 'pr-attention',
      name: 'Needs attention',
      description: 'Every printer with at least one open discrepancy, worst first.',
      columns: ['name', 'serial', 'severity', 'siteResolved', 'fsState', 'pages', 'lastSeen', 'issues'],
      filter: { match: 'all', conditions: [{ field: '__anyIssue', op: 'is' }] },
      sort: { key: 'severity', dir: 'asc' }
    },
    issueView('pr-state', 'Fix: asset state',
      'Marked In Stock in Freshservice while OneStop has them reporting with pages on the meter. The page count is the evidence.',
      ['state-wrong'],
      ['name', 'serial', 'fsState', 'pages', 'mono', 'colour', 'lastSeen', 'siteResolved']),
    issueView('pr-serial', 'Fix: serial number',
      'The serial is in the Name field but the Serial Number field is empty. One column, and everything else keys on it.',
      ['serial-missing'],
      ['name', 'serial', 'model', 'siteResolved', 'fsTag', 'fsState']),
    issueView('pr-ip', 'Fix: IP address',
      'OneStop polls the printer, so its address is the current one. Includes the Region 2 sites that moved from 10.16 to 10.17.',
      ['ip-differs', 'ip-missing', 'mac-missing'],
      ['name', 'serial', 'ipFs', 'ipOnestop', 'macFs', 'macOnestop', 'siteResolved', 'issues']),
    issueView('pr-product', 'Fix: product',
      'Spelt differently from the rest of your own records for the same model, or recorded as the wrong model entirely.',
      ['product-inconsistent'],
      ['name', 'serial', 'model', 'fsProduct', 'productShould', 'siteResolved', 'issues']),
    issueView('pr-vendor', 'Fix: vendor',
      'No manufacturer recorded. Every one of these is an HP, so it is a single bulk correction.',
      ['vendor-missing'],
      ['name', 'model', 'fsProduct', 'fsVendor', 'vendorShould', 'siteResolved']),
    issueView('pr-location', 'Location to check',
      'The two systems name different sites, no location is recorded, or the site is not in your site list.',
      ['location-conflict', 'location-missing', 'site-unresolved'],
      ['name', 'serial', 'fsLocation', 'siteName', 'siteCode', 'siteResolved', 'postcode', 'issues']),
    issueView('pr-silent', 'Not reporting',
      'On the contract but silent. OneStop cannot read the meters or ship toner for a printer it cannot see.',
      ['not-reporting'],
      ['name', 'serial', 'lastSeen', 'ipOnestop', 'siteResolved', 'fsState', 'pages']),
    issueView('pr-unwatched', 'Monitoring and toner',
      'Monitoring switched off, or toner not shipped automatically — somebody has to notice these run low.',
      ['not-monitored', 'no-proactive-toner'],
      ['name', 'serial', 'monitored', 'proactive', 'siteResolved', 'lastSeen', 'pages', 'issues']),
    issueView('pr-questionable', 'Worth questioning',
      'Barely used, at a closed or non-care site, still on a legacy address, or not a printer at all. The candidates for coming off the contract.',
      ['barely-used', 'closed-site', 'legacy-subnet', 'not-a-printer'],
      ['name', 'serial', 'model', 'siteName', 'pages', 'lastSeen', 'ipOnestop', 'issues']),
    issueView('pr-contract', 'Contract mismatches',
      'On the OneStop contract with no Freshservice record, or a Freshservice printer OneStop has never seen. ' +
      'Both directions, because either one means the two registers disagree about what you have.',
      ['onestop-only', 'fs-only'],
      ['name', 'serial', 'status', 'model', 'fsState', 'siteResolved', 'issues']),
    issueView('pr-tags', 'Asset tag oddities',
      'Freshservice uses Asset Tag to hold the OneStop site number, so it disagrees or is shared between printers.',
      ['tag-differs', 'tag-shared'],
      ['name', 'serial', 'fsTag', 'siteNum', 'siteResolved', 'issues']),
    {
      id: 'pr-volume',
      name: 'By volume',
      description: 'Every printer by lifetime page count, busiest first — the other end of the list is where the savings are.',
      columns: ['name', 'model', 'siteResolved', 'mono', 'colour', 'pages', 'lastSeen', 'monitored'],
      filter: null,
      sort: { key: 'pages', dir: 'desc' }
    },
    {
      id: 'pr-all',
      name: 'All printers',
      description: 'Everything from both systems after matching.',
      columns: ['name', 'serial', 'model', 'status', 'siteResolved', 'spot', 'fsState', 'pages', 'issues'],
      filter: null,
      sort: { key: 'siteResolved', dir: 'asc' }
    }
  ];

  /* ------------------------------------------------- order and names */

  var ORDER = [
    ['pr-all',          'all',       'All printers'],

    ['pr-volume',       'breakdown', 'By volume'],

    ['pr-attention',    'issue',     'Needs attention'],
    ['pr-location',     'issue',     'Location to fix'],
    ['pr-contract',     'issue',     'In one system only'],
    ['pr-state',        'issue',     'Asset state to fix'],
    ['pr-serial',       'issue',     'Serial number to fix'],
    ['pr-ip',           'issue',     'IP address to fix'],
    ['pr-product',      'issue',     'Product to fix'],
    ['pr-vendor',       'issue',     'Vendor to fix'],
    ['pr-tags',         'issue',     'Asset tag to fix'],
    ['pr-silent',       'issue',     'Not reporting'],
    ['pr-unwatched',    'issue',     'Monitoring and toner'],
    ['pr-questionable', 'issue',     'Worth questioning']
  ];

  global.PrintViews = Object.assign({
    engine: global.Views.engine, ORDER: ORDER,
    BUILT_IN: global.Views.order(BUILT_IN, ORDER)
  }, E);
})(window);
