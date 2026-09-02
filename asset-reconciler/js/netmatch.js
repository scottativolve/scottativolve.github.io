/* Reconciling network assets is a different job from reconciling PCs: there
   are two systems rather than three, the question is mostly presence rather
   than field agreement, and the answer drives a Freshservice import of kit
   that was never recorded in the first place.

   One row per physical device, keyed on serial number — which on Fortinet
   hardware is clean, unique and printed on the box. */
(function (global) {
  'use strict';

  var U = global.U, N = global.Norm, F = global.Fortinet;

  var DEFAULTS = {
    firmwareDrift: true,          // report a Freshservice firmware that has gone stale
    treatUnreportedAsIssue: true, // a device that has never phoned home
    staleAuditDays: 365           // a Freshservice record not audited in this long
  };

  function settings(saved) {
    return Object.assign({}, DEFAULTS, saved || {});
  }

  /* ---------------------------------------------------------------- rules */

  var SEVERITY_ORDER = { low: 1, medium: 2, high: 3 };

  var RULES = [
    {
      code: 'missing-from-fs',
      label: 'Not in Freshservice',
      severity: 'high',
      hint: 'FortiManager manages this device and Freshservice has no record of it. These are the rows to import.',
      test: function (r) { return !!r.forti && !r.fs; }
    },
    {
      code: 'missing-from-forti',
      label: 'Not in FortiManager',
      severity: 'high',
      hint: 'Freshservice holds this device but no FortiManager environment manages it — it may have been replaced or decommissioned.',
      test: function (r) { return !!r.fs && !r.forti && !r.fsRetired; }
    },
    {
      code: 'retired-but-managed',
      label: 'Retired in FS, still managed',
      severity: 'high',
      hint: 'Freshservice says this is retired or disposed, but FortiManager is still managing it.',
      test: function (r) { return !!r.forti && !!r.fs && r.fsRetired; }
    },
    {
      code: 'duplicate-in-forti',
      label: 'Duplicate in FortiManager',
      severity: 'high',
      hint: 'This serial appears more than once across the FortiManager exports — usually a stale record left behind by a rebuild or a migration.',
      test: function (r) { return r.fortiCount > 1; },
      detail: function (r) {
        return r.fortiAll.map(function (d) {
          return d.name + ' (' + (d.env || 'unknown environment') + (d.parent ? ', under ' + d.parent : '') + ')';
        }).join(' vs ');
      }
    },
    {
      code: 'duplicate-in-fs',
      label: 'Duplicate in Freshservice',
      severity: 'medium',
      hint: 'This serial appears on more than one Freshservice asset.',
      test: function (r) { return r.fsCount > 1; },
      detail: function (r) { return r.fsAll.map(function (a) { return a.name; }).join(' vs '); }
    },
    {
      code: 'cross-environment',
      label: 'In both FortiManager environments',
      severity: 'medium',
      hint: 'The same serial is managed by both environments — expected mid-migration, worth checking otherwise.',
      test: function (r) { return r.envCount > 1; },
      detail: function (r) { return r.envs.join(' and '); }
    },
    {
      code: 'firmware-drift',
      label: 'Firmware differs from Freshservice',
      severity: 'medium',
      hint: 'The version FortiManager reports is not the version recorded in Freshservice.',
      test: function (r, cfg) {
        if (!cfg.firmwareDrift) return false;
        if (!r.forti || !r.fs) return false;
        if (!r.forti.firmwareVersion) return false;
        var recorded = r.fs.firmwareVersion || r.fs.firmware;
        if (N.isBlank(recorded)) return false;
        return !F.sameFirmware(r.forti.firmwareText, recorded);
      },
      detail: function (r) {
        return 'FortiManager ' + (r.forti.firmwareVersion || '?') +
               ' vs Freshservice ' + (r.fs.firmwareVersion || r.fs.firmware || '?');
      }
    },
    {
      code: 'firmware-missing-in-fs',
      label: 'Firmware not recorded',
      severity: 'low',
      hint: 'FortiManager knows the firmware version and the Freshservice record has none.',
      test: function (r) {
        return !!r.forti && !!r.fs && !!r.forti.firmwareVersion &&
               N.isBlank(r.fs.firmwareVersion) && N.isBlank(r.fs.firmware);
      }
    },
    {
      code: 'never-reported',
      label: 'Never reported in',
      severity: 'medium',
      hint: 'Authorised in FortiManager but has never reported a firmware version — pre-registered, or it never came online.',
      test: function (r, cfg) { return cfg.treatUnreportedAsIssue && !!r.forti && !r.forti.reported; }
    },
    {
      code: 'location-mismatch',
      label: 'Location disagrees',
      severity: 'medium',
      hint: 'The site derived from the FortiManager name is not the location on the Freshservice record.',
      test: function (r) {
        if (!r.forti || !r.fs) return false;
        if (!r.siteName || N.isBlank(r.fs.location)) return false;
        return N.locationKey(r.siteName) !== N.locationKey(r.fs.location);
      },
      detail: function (r) { return r.siteName + ' vs ' + r.fs.location; }
    },
    {
      code: 'location-missing-in-fs',
      label: 'No location in Freshservice',
      severity: 'low',
      test: function (r) { return !!r.forti && !!r.fs && N.isBlank(r.fs.location); }
    },
    {
      code: 'site-unresolved',
      label: 'Site not resolved',
      severity: 'medium',
      hint: 'The device name carries no site code that matches your site list, and it inherits nothing usable from its firewall. Add it to the site overrides.',
      test: function (r, cfg, ctx) { return ctx.hasSites && !!r.forti && !r.siteCode; }
    },
    {
      code: 'site-name-suspect',
      label: 'Site looks wrong',
      severity: 'medium',
      hint: 'The site code resolved, but the device name and the site name have no word in common — the number may be a house number rather than a site code.',
      test: function (r) { return !!r.forti && !!r.siteCode && r.forti.siteAgrees === false; },
      detail: function (r) { return r.forti.name + ' resolved to ' + r.siteCode + ' ' + r.siteName; }
    },
    {
      code: 'named-by-serial',
      label: 'Still named after its serial',
      severity: 'low',
      hint: 'Never renamed after joining the fabric.',
      test: function (r) { return !!r.forti && r.forti.namedBySerial; }
    },
    {
      code: 'name-differs',
      label: 'Name differs',
      severity: 'low',
      test: function (r) {
        if (!r.forti || !r.fs) return false;
        return N.deviceName(r.forti.name) !== N.deviceName(r.fs.name);
      },
      detail: function (r) { return r.forti.name + ' vs ' + r.fs.name; }
    },
    {
      code: 'product-missing-in-fs',
      label: 'No product on the FS record',
      severity: 'low',
      test: function (r) { return !!r.fs && N.isBlank(r.fs.product); }
    },
    {
      code: 'ha-out-of-sync',
      label: 'HA member out of sync',
      severity: 'high',
      hint: 'The cluster reports this member as anything other than synchronized.',
      test: function (r) {
        return !!r.forti && !!r.forti.haSync && !/^synchronized$/i.test(r.forti.haSync.trim());
      },
      detail: function (r) { return r.forti.haRole + ': ' + r.forti.haSync; }
    },
    {
      code: 'no-serial',
      label: 'No serial number',
      severity: 'medium',
      hint: 'Matched on name only, because one side has no serial. Every other check on this row is weaker as a result.',
      test: function (r) { return !r.serial; }
    },
    {
      code: 'stale-audit',
      label: 'Freshservice record is stale',
      severity: 'low',
      test: function (r, cfg) {
        if (!r.fs || !r.fs.lastAudit) return false;
        var days = U.daysSince(r.fs.lastAudit);
        return days !== null && days > cfg.staleAuditDays;
      },
      detail: function (r) { return 'last audited ' + U.agoLabel(r.fs.lastAudit); }
    }
  ];

  var RULE_BY_CODE = {};
  RULES.forEach(function (r) { RULE_BY_CODE[r.code] = r; });

  function isEnabled(rule, enabled) {
    if (enabled && Object.prototype.hasOwnProperty.call(enabled, rule.code)) return !!enabled[rule.code];
    return !rule.defaultOff;
  }

  /* -------------------------------------------------------- reconciliation */

  /* fortiDevices: the output of Fortinet.flatten
     fsRecords:    projected fsnetwork rows
     sites:        { code: site }
  */
  function reconcile(fortiDevices, fsRecords, cfg, sites) {
    cfg = settings(cfg);
    sites = sites || {};
    var forti = fortiDevices || [], fs = fsRecords || [];

    // Index both sides on serial, then on name for the rows with no serial.
    var fortiBySerial = groupBy(forti, function (d) { return d.serialKey; });
    var fortiByName = groupBy(forti, function (d) { return N.deviceName(d.name); });
    var fsBySerial = groupBy(fs, function (a) { return N.serial(a.serial); });
    var fsByName = groupBy(fs, function (a) { return N.deviceName(a.name); });

    var rows = [], seenFs = {}, id = 0;

    forti.forEach(function (d) {
      var key = d.serialKey;
      var group = key ? fortiBySerial[key] : [d];
      // Only the first of a duplicated serial builds a row; the rest are
      // reported on it, so a stale twin cannot look like a separate device.
      if (key && group[0] !== d) return;

      var matches = key ? (fsBySerial[key] || []) : (fsByName[N.deviceName(d.name)] || []);
      var matchedBy = key && matches.length ? 'serial' : (matches.length ? 'name' : '');
      if (!matches.length && key) {
        // A Freshservice record with no serial can still be the same device.
        var byName = fsByName[N.deviceName(d.name)] || [];
        matches = byName.filter(function (a) { return N.isBlank(a.serial); });
        if (matches.length) matchedBy = 'name';
      }
      matches.forEach(function (a) { seenFs[a._row] = true; });
      rows.push(build(++id, group, matches, matchedBy, sites));
    });

    fs.forEach(function (a) {
      if (seenFs[a._row]) return;
      var key = N.serial(a.serial);
      var group = key ? (fsBySerial[key] || [a]) : [a];
      if (key && group[0] !== a) return;
      if (!key && (fsByName[N.deviceName(a.name)] || [])[0] !== a) return;
      rows.push(build(++id, [], group, '', sites));
    });

    return {
      rows: rows,
      counts: {
        forti: forti.length,
        fs: fs.length,
        rows: rows.length,
        environments: distinct(forti.map(function (d) { return d.env; }))
      },
      sites: sites
    };
  }

  function build(id, fortiGroup, fsGroup, matchedBy, sites) {
    var d = fortiGroup[0] || null;
    var a = fsGroup[0] || null;
    var envs = distinct(fortiGroup.map(function (x) { return x.env; }).filter(Boolean));

    var row = {
      id: 'n' + id,
      forti: d,
      fs: a,
      fortiAll: fortiGroup,
      fsAll: fsGroup,
      fortiCount: fortiGroup.length,
      fsCount: fsGroup.length,
      matchedBy: matchedBy,
      envs: envs,
      envCount: envs.length,
      env: envs.join(', '),

      name: d ? d.name : (a ? a.name : ''),
      serial: d ? d.serial : (a ? a.serial : ''),
      kind: d ? d.kind : kindFromFs(a),
      platform: d ? d.platform : (a ? a.product : ''),

      siteCode: d ? d.siteCode : '',
      siteName: d ? d.siteName : '',
      siteSource: d ? d.siteSource : '',
      site: d ? d.site : null,

      firmware: d ? d.firmwareVersion : '',
      firmwareText: d ? d.firmwareText : '',
      reported: d ? d.reported : null,

      parent: d ? d.parent : '',
      haRole: d ? d.haRole : '',
      haSync: d ? d.haSync : '',
      configStatus: d ? d.configStatus : '',
      ipForti: d ? d.ipAddress : '',
      ipFs: a ? a.ipAddress : '',

      fsName: a ? a.name : '',
      fsLocation: a ? a.location : '',
      fsState: a ? a.state : '',
      fsAssetType: a ? a.assetType : '',
      fsProduct: a ? a.product : '',
      fsTag: a ? a.assetTag : '',
      // Notes key a device on serial, then name, then asset tag; giving the
      // row the tag under the name Notes looks for keeps a note attached
      // through a rename on either side.
      assetTag: a ? a.assetTag : '',
      fsFirmware: a ? (a.firmwareVersion || a.firmware) : '',
      fsRetired: a ? N.isRetiredState(a.state) : false,
      lastAudit: a ? U.parseDate(a.lastAudit) : null
    };
    row.status = d && a ? 'matched' : (d ? 'forti-only' : 'fs-only');
    row.locationKey = row.siteName ? N.locationKey(row.siteName) : N.locationKey(row.fsLocation);
    return row;
  }

  /* Freshservice's own asset type, when there is no FortiManager side to
     take the kind from. */
  function kindFromFs(a) {
    if (!a) return '';
    var t = (a.assetType || a.ciType || '').toLowerCase();
    if (t.indexOf('access point') >= 0 || t.indexOf('wireless') >= 0) return 'FortiAP';
    if (t.indexOf('switch') >= 0) return 'FortiSwitch';
    if (t.indexOf('firewall') >= 0 || t.indexOf('router') >= 0) return 'FortiGate';
    return a.assetType || '';
  }

  function groupBy(list, keyFn) {
    var out = {};
    list.forEach(function (x) {
      var k = keyFn(x);
      if (!k) return;
      (out[k] = out[k] || []).push(x);
    });
    return out;
  }

  function distinct(list) {
    var seen = {}, out = [];
    list.forEach(function (x) { if (x && !seen[x]) { seen[x] = true; out.push(x); } });
    return out;
  }

  /* ------------------------------------------------------------ rule pass */

  function apply(result, cfg, enabled) {
    cfg = settings(cfg);
    var ctx = { hasSites: result.sites && Object.keys(result.sites).length > 0 };
    var active = RULES.filter(function (r) { return isEnabled(r, enabled); });
    var tally = {};
    active.forEach(function (r) { tally[r.code] = 0; });

    result.rows.forEach(function (row) {
      row.issues = [];
      row.details = {};
      var worst = null;
      active.forEach(function (rule) {
        var hit = false;
        try { hit = !!rule.test(row, cfg, ctx); } catch (e) { hit = false; }
        if (!hit) return;
        row.issues.push(rule.code);
        try { row.details[rule.code] = rule.detail ? rule.detail(row) : ''; } catch (e) { row.details[rule.code] = ''; }
        tally[rule.code]++;
        if (!worst || SEVERITY_ORDER[rule.severity] > SEVERITY_ORDER[worst]) worst = rule.severity;
      });
      row.severity = worst;
      row.issueCount = row.issues.length;
    });

    result.tally = tally;
    result.rulesUsed = active.map(function (r) { return r.code; });
    return result;
  }

  global.NetMatch = {
    DEFAULTS: DEFAULTS,
    RULES: RULES,
    RULE_BY_CODE: RULE_BY_CODE,
    SEVERITY_ORDER: SEVERITY_ORDER,
    settings: settings,
    isEnabled: isEnabled,
    reconcile: reconcile,
    apply: apply
  };
})(window);
