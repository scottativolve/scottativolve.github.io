/* Columns and views for mobiles and tablets. Same filter engine as the other
   three populations.

   The emphasis is different, though: nothing here is in Freshservice yet, so
   there are no fields to correct. What matters is whether each device can be
   imported at all, where it is going to land, and which handsets have stopped
   reporting. */
(function (global) {
  'use strict';

  var U = global.U, N = global.Norm, PH = global.Phone;

  function yesNo(v) { return v === null || v === undefined ? '' : (v ? 'yes' : 'no'); }

  var COLUMNS = [
    { key: 'notes',      label: 'Notes',        width: 64, type: 'notes',
      get: function (r) { return global.Notes.countFor(r); },
      sortKey: function (r) { return -global.Notes.countFor(r); } },
    { key: 'name',       label: 'Device',       width: 130, get: function (r) { return r.name; }, strong: true },
    { key: 'serial',     label: 'Serial',       width: 150, get: function (r) { return r.serial; } },
    { key: 'severity',   label: 'Severity',     width: 90,
      get: function (r) { return r.severity || ''; },
      sortKey: function (r) { return r.severity ? -global.Mobiles.SEVERITY_ORDER[r.severity] : 9; } },
    { key: 'issues',     label: 'Issues',       width: 300, type: 'issues', get: function (r) { return r.issues; },
      sortKey: function (r) { return -r.issueCount; } },
    { key: 'issueCount', label: 'Issue count',  width: 70, type: 'number', get: function (r) { return r.issueCount; } },

    { key: 'model',      label: 'Model code',   width: 110, get: function (r) { return r.model; } },
    { key: 'modelName',  label: 'Product',      width: 190, get: function (r) { return r.modelName; } },
    { key: 'formFactor', label: 'Type',         width: 90,  get: function (r) { return r.formFactor; } },
    { key: 'manufacturer', label: 'Make',       width: 100, get: function (r) { return r.manufacturer; } },
    { key: 'imei',       label: 'IMEI',         width: 150, get: function (r) { return r.imei; } },
    { key: 'phone',      label: 'Phone number', width: 130,
      // The way a person writes it, not E.164: this column gets read aloud.
      get: function (r) { return r.phoneKey ? PH.national(r.phoneKey) : r.phone; } },
    { key: 'phoneKey',   label: 'Phone (E.164)', width: 130, get: function (r) { return r.phoneKey; } },

    { key: 'ownerName',  label: 'Held by',      width: 170, get: function (r) { return r.ownerName; } },
    { key: 'ownerEmail', label: 'Email',        width: 210,
      get: function (r) { return r.owner ? r.owner.email : ''; } },
    { key: 'ownerTitle', label: 'Job title',    width: 190,
      get: function (r) { return r.owner ? r.owner.jobTitle : ''; } },
    { key: 'ownerDept',  label: 'Department',   width: 140,
      get: function (r) { return r.owner ? r.owner.department : ''; } },
    { key: 'ownerOffice',label: 'Office (Entra)', width: 170,
      get: function (r) { return r.owner ? r.owner.office : ''; } },
    { key: 'ownerManager', label: 'Manager',    width: 170,
      get: function (r) { return r.owner ? r.owner.manager : ''; } },
    { key: 'ownerEnabled', label: 'Account',    width: 100,
      get: function (r) {
        if (!r.owner || r.owner.enabled === null) return '';
        return r.owner.enabled ? 'enabled' : 'disabled';
      } },
    { key: 'ownerCount', label: 'People with this number', width: 90, type: 'number',
      get: function (r) { return (r.ownerCandidates || []).length; } },
    { key: 'osVersion',  label: 'Android',      width: 80,  type: 'number', get: function (r) { return r.osMajor; } },
    { key: 'encrypted',  label: 'Encrypted',    width: 95,  get: function (r) { return yesNo(r.encrypted); } },

    { key: 'siteCode',   label: 'Site code',    width: 80,  get: function (r) { return r.siteCode; } },
    { key: 'siteName',   label: 'Site',         width: 190, get: function (r) { return r.siteName; } },
    { key: 'location',   label: 'Location for FS', width: 190, get: function (r) { return r.location; } },
    { key: 'folder',     label: 'SOTI folder',  width: 180, get: function (r) { return r.folder; } },
    { key: 'regionFolder', label: 'SOTI region', width: 120, get: function (r) { return r.regionFolder; } },
    { key: 'deviceClass', label: 'Device class', width: 170, get: function (r) { return r.deviceClass; } },
    { key: 'path',       label: 'SOTI path',    width: 300, get: function (r) { return r.path; } },
    { key: 'siteMatch',  label: 'Site matched by', width: 120,
      get: function (r) { return r.hasSiteFolder ? (r.siteMatch || 'nothing') : 'no site folder'; } },
    { key: 'hasSiteFolder', label: 'Filed at a site', width: 110,
      get: function (r) { return r.hasSiteFolder ? 'yes' : 'no'; } },
    { key: 'region',     label: 'Region (site list)', width: 150,
      get: function (r) { return r.site ? N.clean(r.site.region) : ''; } },
    { key: 'town',       label: 'Town',         width: 130,
      get: function (r) { return r.site ? N.clean(r.site.town) : ''; } },
    { key: 'postcode',   label: 'Postcode',     width: 95,
      get: function (r) { return r.site ? N.clean(r.site.postcode) : ''; } },
    { key: 'siteStatus', label: 'Site status',  width: 100,
      get: function (r) { return r.site ? N.clean(r.site.status) : ''; } },

    { key: 'stateShould', label: 'Asset state', width: 100, get: function (r) { return r.stateShould; } },
    { key: 'checkIn',    label: 'Last check-in', width: 120, type: 'date', get: function (r) { return r.checkIn; },
      sortKey: function (r) { return r.checkIn ? r.checkIn.getTime() : 0; } },
    { key: 'daysSince',  label: 'Days silent',  width: 95, type: 'number', get: function (r) { return r.daysSince; } },
    { key: 'connected',  label: 'Last connected', width: 130, type: 'date', get: function (r) { return r.connected; },
      sortKey: function (r) { return r.connected ? r.connected.getTime() : 0; } },
    { key: 'online',     label: 'Connected now', width: 110, get: function (r) { return yesNo(r.online); } },
    { key: 'agentVersion', label: 'SOTI agent', width: 130, get: function (r) { return r.agentVersion; } },
    { key: 'ip',         label: 'IP address',   width: 130, get: function (r) { return r.ip; } },
    { key: 'mac',        label: 'MAC address',  width: 140, get: function (r) { return r.mac; } },
    { key: 'storage',    label: 'Storage free', width: 110, type: 'number',
      get: function (r) { return r.storage === null ? null : Math.round(r.storage / 1073741824 * 10) / 10; } },
    { key: 'family',     label: 'Device family', width: 110, get: function (r) { return r.family; } },
    { key: 'isTest',     label: 'Test stock',   width: 95, get: function (r) { return r.isTest ? 'yes' : 'no'; } },
    { key: 'modelKnown', label: 'Product known', width: 110, get: function (r) { return r.modelKnown ? 'yes' : 'no'; } }
  ];

  var BASE_COLS = ['name', 'serial', 'modelName', 'formFactor', 'phone', 'ownerName',
                   'siteCode', 'location', 'checkIn', 'issues'];

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
      id: 'mb-attention',
      name: 'Needs attention',
      description: 'Every mobile with at least one open flag, worst first.',
      columns: ['name', 'serial', 'severity', 'modelName', 'siteCode', 'location', 'checkIn', 'issues'],
      filter: { match: 'all', conditions: [{ field: '__anyIssue', op: 'is' }] },
      sort: { key: 'severity', dir: 'asc' }
    },
    {
      id: 'mb-import-blocked',
      name: 'Cannot be imported',
      description: 'Freshservice needs a name and a Product on every row. These rows have no serial, no model, ' +
        'or a model code with no product name against it, so they would be rejected or create a product ' +
        'nobody recognises.',
      columns: ['name', 'serial', 'model', 'modelName', 'manufacturer', 'folder', 'checkIn', 'issues'],
      filter: { match: 'any', conditions: [
        { field: '__issue', op: 'is', value: 'no-serial' },
        { field: '__issue', op: 'is', value: 'no-model' },
        { field: '__issue', op: 'is', value: 'model-unknown' }
      ] },
      sort: { key: 'severity', dir: 'asc' }
    },
    issueView('mb-site-unresolved', 'Site not recognised',
      'Filed under a site folder whose name matches no site in your list, even allowing for a missing "SL". ' +
      'Either add the site or map the folder under Site folders.',
      ['site-unresolved'],
      ['name', 'serial', 'folder', 'regionFolder', 'deviceClass', 'checkIn', 'issues']),
    issueView('mb-wrong-region', 'Filed in the wrong region',
      'The SOTI region folder disagrees with the region your site list gives for that site — usually a folder ' +
      'created in the wrong place rather than a device in the wrong building.',
      ['site-region-differs'],
      ['name', 'folder', 'regionFolder', 'region', 'siteCode', 'siteName', 'issues']),
    {
      id: 'mb-home',
      name: 'Home and office workers',
      description: 'Filed by region rather than by site, which is how SOTI holds a device that follows a person. ' +
        'These import with the location set in Settings rather than a building.',
      columns: ['name', 'serial', 'modelName', 'formFactor', 'deviceClass', 'regionFolder', 'location', 'checkIn'],
      filter: { match: 'all', conditions: [
        { field: 'hasSiteFolder', op: 'is', value: 'no' },
        { field: 'isTest', op: 'is', value: 'no' }
      ] },
      sort: { key: 'regionFolder', dir: 'asc' }
    },
    {
      id: 'mb-at-site',
      name: 'At a site',
      description: 'Every device SOTI files against a building, with the site code it resolved to.',
      columns: ['name', 'serial', 'modelName', 'formFactor', 'siteCode', 'siteName', 'siteMatch', 'checkIn'],
      filter: { match: 'all', conditions: [{ field: 'siteCode', op: 'notEmpty' }] },
      sort: { key: 'siteName', dir: 'asc' }
    },
    issueView('mb-silent', 'Silent for months',
      'No check-in for longer than the "lost" window in Settings. Lost, broken, or in a drawer — but not in ' +
      'somebody’s hand.',
      ['long-silent', 'never-checked-in'],
      ['name', 'serial', 'modelName', 'checkIn', 'daysSince', 'siteCode', 'location', 'issues']),
    issueView('mb-stale', 'Not checked in recently',
      'Past the staleness window but not yet long enough to assume the device is gone.',
      ['stale'],
      ['name', 'serial', 'modelName', 'checkIn', 'daysSince', 'siteCode', 'location', 'online']),
    issueView('mb-security', 'Security',
      'Unencrypted, or running an Android version that no longer receives security updates. These handsets hold ' +
      'people’s care records.',
      ['not-encrypted', 'os-unsupported'],
      ['name', 'serial', 'modelName', 'encrypted', 'osVersion', 'siteCode', 'location', 'issues']),
    {
      id: 'mb-agents',
      name: 'SOTI agent versions',
      description: 'Every device by agent version, oldest first. A device that never upgrades is usually one ' +
        'that never connects.',
      columns: ['name', 'serial', 'agentVersion', 'modelName', 'checkIn', 'daysSince', 'siteCode', 'location'],
      filter: null,
      sort: { key: 'agentVersion', dir: 'asc' }
    },
    issueView('mb-test', 'Test and supplier stock',
      'Filed under Testing or sitting at the supplier rather than issued to anyone. These import as Reserved.',
      ['test-stock'],
      ['name', 'serial', 'modelName', 'deviceClass', 'folder', 'stateShould', 'checkIn', 'issues']),
    issueView('mb-naming', 'Named after a person',
      'Your convention is the five-digit asset number. These carry a name or a pilot instead, and would import ' +
      'under that name.',
      ['name-not-asset-number'],
      ['name', 'serial', 'modelName', 'deviceClass', 'folder', 'checkIn']),
    issueView('mb-duplicates', 'Duplicated in the export',
      'Two rows carrying the same serial or the same device name. In a paged SOTI export sorted on a live ' +
      'column this is the export duplicating records rather than two real devices.',
      ['duplicate-serial', 'duplicate-name'],
      ['name', 'serial', 'imei', 'model', 'folder', 'checkIn', 'issues']),
    issueView('mb-closed', 'At a closed site',
      'The site list marks the service closed, so devices still filed there need collecting or moving.',
      ['site-closed'],
      ['name', 'serial', 'modelName', 'siteCode', 'siteName', 'siteStatus', 'checkIn']),
    issueView('mb-dup-number', 'One number, two devices',
      'The same phone number on more than one handset. Usually the SIM has moved into a replacement and the ' +
      'old device record was left behind, so the stale half of each pair is a device to retire.',
      ['duplicate-number'],
      ['name', 'serial', 'phone', 'modelName', 'deviceClass', 'folder', 'checkIn', 'daysSince', 'issues']),
    {
      id: 'mb-owners',
      name: 'Who holds what',
      description: 'Every handset the phone number placed with a member of staff, from their Entra profile. ' +
        'Load the Entra export to fill this in.',
      columns: ['name', 'phone', 'ownerName', 'ownerTitle', 'ownerDept', 'ownerOffice', 'ownerManager',
                'modelName', 'deviceClass', 'checkIn'],
      filter: { match: 'all', conditions: [{ field: 'ownerName', op: 'notEmpty' }] },
      sort: { key: 'ownerName', dir: 'asc' }
    },
    issueView('mb-owner-gaps', 'Owner not established',
      'A handset with a number that matches nobody in Entra, or matches two people, or no number at all. ' +
      'These are the ones somebody has to ask about.',
      ['owner-not-found', 'owner-ambiguous', 'no-phone-number'],
      ['name', 'serial', 'phone', 'ownerCount', 'modelName', 'deviceClass', 'regionFolder', 'checkIn', 'issues']),
    issueView('mb-owner-left', 'Out with a leaver',
      'The number is recorded against somebody whose Entra account is switched off, so the handset needs ' +
      'collecting.',
      ['owner-left'],
      ['name', 'serial', 'phone', 'ownerName', 'ownerTitle', 'ownerManager', 'checkIn', 'daysSince']),
    issueView('mb-site-phone-owned', 'Site phone against a person',
      'The number is in somebody’s Entra profile but the handset is filed at a service, so it is probably a ' +
      'shared site phone they answer rather than their own. Worth checking before a record says they own it.',
      ['owner-at-site'],
      ['name', 'phone', 'ownerName', 'ownerTitle', 'siteCode', 'siteName', 'folder', 'checkIn']),
    {
      id: 'mb-tablets',
      name: 'Tablets',
      description: 'The tablets, which import into Freshservice as their own asset type and so become their own file.',
      columns: ['name', 'serial', 'modelName', 'model', 'siteCode', 'location', 'checkIn', 'issues'],
      filter: { match: 'all', conditions: [{ field: 'formFactor', op: 'is', value: 'Tablet' }] },
      sort: { key: 'siteName', dir: 'asc' }
    },
    {
      id: 'mb-models',
      name: 'By model',
      description: 'Every device grouped by what it is — the handset mix, and which models are nearly retired.',
      columns: ['name', 'serial', 'model', 'modelName', 'formFactor', 'osVersion', 'siteCode', 'location'],
      filter: null,
      sort: { key: 'modelName', dir: 'asc' }
    },
    {
      id: 'mb-all',
      name: 'All mobiles',
      description: 'Everything SOTI reported, with the site each one resolved to.',
      columns: ['name', 'serial', 'modelName', 'formFactor', 'siteCode', 'location', 'stateShould', 'checkIn', 'issues'],
      filter: null,
      sort: { key: 'name', dir: 'asc' }
    }
  ];

  /* ------------------------------------------------- order and names */

  var ORDER = [
    ['mb-all',              'all',       'All mobiles'],

    ['mb-models',           'breakdown', 'By model'],
    ['mb-tablets',          'breakdown', 'Tablets'],
    ['mb-agents',           'breakdown', 'By agent version'],
    ['mb-at-site',          'breakdown', 'At a site'],
    ['mb-home',             'breakdown', 'Home and office'],
    ['mb-owners',           'breakdown', 'Who holds what'],

    ['mb-attention',        'issue',     'Needs attention'],
    ['mb-site-unresolved',  'issue',     'Location to fix'],
    ['mb-wrong-region',     'issue',     'Location: wrong region'],
    ['mb-closed',           'issue',     'Location: site closed'],
    ['mb-owner-gaps',       'issue',     'Owner to establish'],
    ['mb-owner-left',       'issue',     'Owner has left'],
    ['mb-site-phone-owned', 'issue',     'Owner: site phone'],
    ['mb-import-blocked',   'issue',     'Cannot be imported'],
    ['mb-silent',           'issue',     'Silent for months'],
    ['mb-stale',            'issue',     'Not checked in recently'],
    ['mb-security',         'issue',     'Security'],
    ['mb-dup-number',       'issue',     'Duplicate phone numbers'],
    ['mb-duplicates',       'issue',     'Duplicate records'],
    ['mb-test',             'issue',     'Test and stock'],
    ['mb-naming',           'issue',     'Named after a person']
  ];

  global.MobViews = Object.assign({
    engine: global.Views.engine, ORDER: ORDER,
    BUILT_IN: global.Views.order(BUILT_IN, ORDER)
  }, E);
})(window);
