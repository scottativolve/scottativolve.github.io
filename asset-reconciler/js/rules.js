/* Discrepancy rules.

   Each rule inspects one reconciled row and decides whether it is a problem.
   `fix` names the Freshservice field the rule can correct and where the
   correct value comes from, which is what drives the import builder. */
(function (global) {
  'use strict';

  var N = global.Norm;

  var RULES = [
    {
      code: 'not-in-intune',
      label: 'Not in Intune',
      severity: 'high',
      help: 'Freshservice holds this asset but Intune has no matching device. Either it was never enrolled, it has been disposed of without updating Freshservice, or it is sitting switched off somewhere.',
      test: function (r, cfg) {
        return r.inScope && r.fs && !r.intune && !N.isRetiredState(r.state);
      },
      detail: function (r) {
        return 'Freshservice state "' + (r.state || 'not set') + '", last audit ' + global.U.ageLabel(r.lastAudit) + ' ago';
      }
    },
    {
      code: 'not-in-freshservice',
      label: 'Not in Freshservice',
      severity: 'high',
      help: 'Intune manages this device but Freshservice has no asset record. The Freshservice agent is probably not installed, or the asset was never created.',
      test: function (r) { return r.intune && !r.fs; },
      detail: function (r) {
        return 'Enrolled to ' + (r.intuneUser || 'nobody') + ', last check-in ' + global.U.ageLabel(r.lastCheckIn) + ' ago';
      }
    },
    {
      code: 'user-mismatch',
      label: 'Assigned user differs',
      severity: 'high',
      help: 'Freshservice and Intune disagree about who has this device. Intune is normally the more current of the two because it updates on sign-in.',
      test: function (r) { return r.fs && r.intune && r.userStatus === 'mismatch'; },
      detail: function (r) { return 'Freshservice: ' + (r.fsUser || 'blank') + ' · Intune: ' + (r.intuneUser || 'blank'); },
      fix: { field: 'user', from: 'intune' }
    },
    {
      code: 'user-similar',
      label: 'Assigned user close but not equal',
      severity: 'low',
      help: 'The two names look like the same person written differently (an account name against a display name, or a shared surname). Worth an eye before bulk-updating.',
      test: function (r) { return r.fs && r.intune && r.userStatus === 'partial'; },
      detail: function (r) { return 'Freshservice: ' + (r.fsUser || 'blank') + ' · Intune: ' + (r.intuneUser || 'blank'); },
      fix: { field: 'user', from: 'intune' }
    },
    {
      code: 'user-missing-fs',
      label: 'No user in Freshservice',
      severity: 'medium',
      help: 'Intune knows the primary user but the Freshservice asset is unassigned. This is the easiest class of fix: the value can be copied straight across.',
      test: function (r) {
        return r.fs && r.intune && N.isBlank(r.fsUser) && !N.isBlank(r.intuneUser);
      },
      detail: function (r) { return 'Intune primary user: ' + r.intuneUser; },
      fix: { field: 'user', from: 'intune' }
    },
    {
      code: 'login-differs-from-assigned',
      label: 'Someone else logs into it',
      severity: 'medium',
      help: 'The account that last signed in to this machine is not the person the asset is assigned to. ' +
            'Freshservice reads this straight off the device, so it reflects who actually uses it. Note that ' +
            'the value is a Windows account name rather than an email address, so correct the assignment using ' +
            'the Intune primary user rather than writing this string back.',
      test: function (r) { return r.loginVsAssigned === 'mismatch'; },
      detail: function (r) {
        return 'Last signed in as "' + r.lastLoginBy + '", assigned to ' + (r.fsUser || 'nobody') +
               (r.loginVsIntune === 'match' ? ' — and Intune agrees with the sign-in, so Freshservice is the odd one out' : '');
      },
      fix: { field: 'user', from: 'intune' }
    },
    {
      code: 'user-missing-both',
      label: 'No user anywhere',
      severity: 'medium',
      help: 'Neither system has an assigned user. Usually a shared or spare device — but if the asset state says it is in use, someone has it.',
      test: function (r) {
        return r.inScope && N.isBlank(r.fsUser) && N.isBlank(r.intuneUser) && N.isActiveState(r.state) === true;
      },
      detail: function (r) { return 'State is "' + r.state + '" but no user is recorded in either system'; }
    },
    {
      code: 'location-missing',
      label: 'No location set',
      severity: 'high',
      help: 'The Freshservice asset has no location, so it cannot be counted against a service or put on the map.',
      test: function (r) { return r.fs && N.isBlank(r.locationRaw); },
      detail: function () { return 'Freshservice location is empty'; },
      fix: { field: 'location', from: 'verification' }
    },
    {
      code: 'location-unknown',
      label: 'Location not in lookup',
      severity: 'medium',
      help: 'Freshservice holds a location that does not appear in the location lookup file, so it cannot be mapped. Either the lookup needs the site adding, or the asset carries a stale or misspelled location.',
      test: function (r, cfg, ctx) {
        return r.fs && !N.isBlank(r.locationRaw) && ctx.hasLocations && !r.site;
      },
      detail: function (r) { return 'Location "' + r.location + '" has no matching row in the lookup'; }
    },
    {
      code: 'stale-intune',
      label: 'Not checked in recently',
      severity: 'medium',
      help: 'Intune has not heard from this device for a while. It may be switched off, in a drawer, or gone.',
      test: function (r, cfg) {
        return r.intune && r.daysSinceCheckIn !== null && r.daysSinceCheckIn > cfg.staleDays;
      },
      detail: function (r) { return 'Last Intune check-in ' + global.U.ageLabel(r.lastCheckIn) + ' ago'; }
    },
    {
      code: 'stale-fs-agent',
      label: 'Freshservice agent silent',
      severity: 'low',
      help: 'The Freshservice agent has not audited this machine recently, so its inventory data is going stale.',
      test: function (r, cfg) {
        return r.fs && r.daysSinceAudit !== null && r.daysSinceAudit > cfg.fsStaleDays;
      },
      detail: function (r) { return 'Last Freshservice audit ' + global.U.ageLabel(r.lastAudit) + ' ago'; }
    },
    {
      code: 'state-conflict-active',
      label: 'Retired but still in use',
      severity: 'high',
      help: 'Freshservice says this device is retired, in stock or disposed of, but Intune shows it checking in. Someone is using a machine the asset register believes is gone.',
      test: function (r, cfg) {
        return r.fs && r.intune && N.isActiveState(r.state) === false &&
               r.daysSinceCheckIn !== null && r.daysSinceCheckIn <= cfg.activeDays;
      },
      detail: function (r) {
        return 'State "' + r.state + '" but checked in ' + global.U.ageLabel(r.lastCheckIn) + ' ago';
      },
      fix: { field: 'state', from: 'manual' }
    },
    {
      code: 'state-conflict-idle',
      label: 'In use but silent',
      severity: 'medium',
      help: 'Freshservice says this device is in use, but Intune has not seen it for a long time. Worth asking the service whether it is still there.',
      test: function (r, cfg) {
        return r.fs && r.intune && N.isActiveState(r.state) === true &&
               r.daysSinceCheckIn !== null && r.daysSinceCheckIn > cfg.staleDays * 2;
      },
      detail: function (r) {
        return 'State "' + r.state + '" but no check-in for ' + global.U.ageLabel(r.lastCheckIn);
      }
    },
    {
      code: 'serial-mismatch',
      label: 'Serial number differs',
      severity: 'medium',
      help: 'The two systems matched on device name but hold different serial numbers. Either one is wrong, or the name has been reused on replacement hardware.',
      test: function (r) {
        if (!r.fs || !r.intune) return false;
        var a = N.serial(r.fs.serial), b = N.serial(r.intune.serial);
        return a && b && a !== b;
      },
      detail: function (r) { return 'Freshservice ' + r.fs.serial + ' · Intune ' + r.intune.serial; },
      fix: { field: 'serial', from: 'intune' }
    },
    {
      code: 'serial-missing',
      label: 'No serial in Freshservice',
      severity: 'low',
      help: 'Freshservice has no serial number, so this asset can only ever be matched on name. Copying the serial across makes future reconciliation far more reliable.',
      test: function (r) {
        return r.fs && r.intune && !N.serial(r.fs.serial) && N.serial(r.intune.serial);
      },
      detail: function (r) { return 'Intune serial: ' + r.intune.serial; },
      fix: { field: 'serial', from: 'intune' }
    },
    {
      code: 'model-mismatch',
      label: 'Model differs',
      severity: 'low',
      defaultOff: true,
      help: 'The recorded hardware model does not agree between the two systems. Off by default: ' +
            'Freshservice takes this from its own discovery agent and Intune reports it separately, so the ' +
            'wording differs on almost every device without anything being wrong. Turn it on only if you have ' +
            'aligned how both systems name hardware.',
      test: function (r) {
        return r.fs && r.intune && !N.looseEqual(r.fs.model, r.intune.model);
      },
      detail: function (r) { return 'Freshservice "' + r.fs.model + '" · Intune "' + r.intune.model + '"'; },
      fix: { field: 'model', from: 'intune' }
    },
    {
      code: 'os-mismatch',
      label: 'OS differs',
      severity: 'low',
      defaultOff: true,
      help: 'The operating system recorded in Freshservice does not match what Intune reports. Off by default: ' +
            'the two are populated from different agents — Freshservice discovery typically gives "Windows 11" ' +
            'where Intune gives "Windows" — so they disagree structurally rather than meaningfully.',
      test: function (r) {
        return r.fs && r.intune && !N.isBlank(r.fs.os) && !N.isBlank(r.intune.os) &&
               !N.looseEqual(r.fs.os, r.intune.os);
      },
      detail: function (r) { return 'Freshservice "' + r.fs.os + '" · Intune "' + r.intune.os + '"'; },
      fix: { field: 'os', from: 'intune' }
    },
    {
      code: 'ip-location-mismatch',
      label: 'IP says it is at another site',
      severity: 'high',
      help: 'The address this device was last seen on belongs to a different site than the one Freshservice has ' +
            'it assigned to. Devices move between services and the paperwork rarely follows, so this is usually ' +
            'the asset register being out of date rather than anything wrong with the device.',
      test: function (r) { return r.ipStatus === 'other-site'; },
      detail: function (r) {
        return 'Last seen on ' + r.ip + ' (' + r.ipSubnet + ') which belongs to ' + r.ipSiteName +
               ', but Freshservice says ' + (r.location || 'no location');
      },
      fix: { field: 'location', from: 'ip' }
    },
    {
      code: 'ip-suggests-location',
      label: 'IP names a site Freshservice does not',
      severity: 'medium',
      help: 'The address this device was last seen on belongs to a known site, but Freshservice either has no ' +
            'location for it or holds one that is not in your lookup. Either way the network says where it is. ' +
            'Where the existing location is simply missing from the lookup, check whether the lookup needs the ' +
            'site adding before you overwrite it.',
      test: function (r) { return r.ipStatus === 'suggests'; },
      detail: function (r) {
        return r.locationRaw
          ? 'Freshservice says "' + r.locationRaw + '", which is not in the lookup; last seen on ' + r.ip +
            ' (' + r.ipSubnet + '), which is ' + r.ipSiteName
          : 'No location in Freshservice; last seen on ' + r.ip + ' (' + r.ipSubnet + '), which is ' + r.ipSiteName;
      },
      fix: { field: 'location', from: 'ip' }
    },
    {
      code: 'ip-off-network',
      label: 'Last seen off the site network',
      severity: 'low',
      help: 'The address is a private or home one that matches none of your site ranges — normally a remote ' +
            'worker on their own broadband, or a site whose subnet is not in the lookup yet. It says nothing ' +
            'about the device being lost, so it is informational rather than something to chase.',
      test: function (r) { return r.ipStatus === 'off-network'; },
      detail: function (r) {
        return 'Last seen on ' + r.ip +
               (r.ipClass === 'home' ? ' (a 192.168 home range)'
                : r.ipClass === 'public' ? ' (a public address)' : ' (no matching site range)');
      }
    },
    {
      code: 'ip-site-no-subnet',
      label: 'Assigned site has no subnet recorded',
      severity: 'low',
      defaultOff: true,
      help: 'The device has an address but the site it is assigned to has no IP range in the location lookup, so ' +
            'there is nothing to check it against. Off by default because it fires once per device at every ' +
            'such site; use the subnet coverage figure on the dashboard instead, and turn this on when you want ' +
            'the device-level list.',
      test: function (r) { return r.ipStatus === 'unassigned'; },
      detail: function (r) { return 'Last seen on ' + r.ip + '; no range recorded for ' + r.location; }
    },
    {
      code: 'duplicate-name',
      label: 'Duplicate device name',
      severity: 'medium',
      help: 'This device name appears more than once in one of the exports. Usually a rebuilt machine whose old record was never retired.',
      test: function (r) { return r.dupNames > 0; },
      detail: function (r) { return 'Name "' + r.name + '" is not unique in one of the source files'; }
    },
    {
      code: 'non-compliant',
      label: 'Not compliant in Intune',
      severity: 'medium',
      help: 'Intune reports this device as non-compliant with policy.',
      test: function (r) {
        var c = N.text(r.compliance);
        return !!c && /non[- ]?compliant|not compliant|in grace|error|conflict/.test(c);
      },
      detail: function (r) { return 'Intune compliance: ' + r.compliance; }
    },
    {
      code: 'verification-moved',
      label: 'Site confirmed a different location',
      severity: 'high',
      help: 'A returned verification sheet gives a location that differs from Freshservice. The site has told you where the device actually is.',
      test: function (r) {
        if (!r.ver || N.isBlank(r.ver.confirmedLocation)) return false;
        return N.locationKey(r.ver.confirmedLocation, 'leaf') !== r.locationKey;
      },
      detail: function (r) {
        return 'Freshservice "' + (r.location || 'blank') + '" · site confirmed "' + r.ver.confirmedLocation + '"';
      },
      fix: { field: 'location', from: 'verification' }
    },
    {
      code: 'verification-missing',
      label: 'Site reported device missing',
      severity: 'high',
      help: 'A returned verification sheet says this device could not be found at the site.',
      test: function (r) {
        return r.ver && /^(n|no|not found|missing|gone)/i.test(N.clean(r.ver.confirmedPresent));
      },
      detail: function (r) { return 'Site note: ' + (r.ver.notes || 'not found on site'); }
    }
  ];

  var BY_CODE = {};
  RULES.forEach(function (r) { BY_CODE[r.code] = r; });

  var SEVERITY_ORDER = { high: 3, medium: 2, low: 1 };

  /* A rule with no stored preference falls back to its own default, so a check
     that is noise for most estates can ship switched off without preventing
     anyone turning it on. */
  function isEnabled(rule, enabled) {
    var stored = enabled ? enabled[rule.code] : undefined;
    if (stored === undefined) return !rule.defaultOff;
    return stored !== false;
  }

  /* Run every enabled rule over every row, writing `issues` and `severity`. */
  function apply(result, cfg, enabled) {
    var ctx = { hasLocations: result.sites && result.sites.size > 0 };
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

  /* What would we propose to change in Freshservice for this row and field? */
  function proposedValue(row, field, sourcePref) {
    var pick = sourcePref || 'auto';
    var ver = row.ver;

    if (field === 'user') {
      if ((pick === 'verification' || pick === 'auto') && ver && !N.isBlank(ver.confirmedUser)) return ver.confirmedUser;
      if (pick === 'verification') return null;
      return row.intune ? global.Norm.personDisplay(row.intune.primaryUser, row.intune.primaryUpn) || null : null;
    }
    if (field === 'location') {
      // A site's own answer beats an inference from the network, but the IP is
      // a good deal better than nothing.
      if (pick !== 'ip' && ver && !N.isBlank(ver.confirmedLocation)) return ver.confirmedLocation;
      if (pick === 'verification') return null;
      if (row.ipSite && (row.ipStatus === 'other-site' || row.ipStatus === 'suggests')) {
        return N.clean(row.ipSite.location) || null;
      }
      if (pick === 'ip') return null;
      return null;
    }
    if (field === 'state') {
      if (ver && !N.isBlank(ver.confirmedState)) return ver.confirmedState;
      return null;
    }
    if (field === 'serial') return row.intune ? N.clean(row.intune.serial) || null : null;
    if (field === 'model') return row.intune ? N.clean(row.intune.model) || null : null;
    if (field === 'os') return row.intune ? N.clean(row.intune.os) || null : null;
    if (field === 'osVersion') return row.intune ? N.clean(row.intune.osVersion) || null : null;
    if (field === 'lastSeen') return row.lastCheckIn || null;
    return null;
  }

  function currentValue(row, field) {
    var fs = row.fs;
    if (!fs) return '';
    if (field === 'user') return row.fsUser;
    if (field === 'location') return N.clean(fs.location);
    if (field === 'state') return N.clean(fs.state);
    if (field === 'serial') return N.clean(fs.serial);
    if (field === 'model') return N.clean(fs.model);
    if (field === 'os') return N.clean(fs.os);
    if (field === 'osVersion') return N.clean(fs.osVersion);
    if (field === 'lastSeen') return fs.lastAudit;
    return '';
  }

  global.Rules = {
    RULES: RULES,
    BY_CODE: BY_CODE,
    apply: apply,
    isEnabled: isEnabled,
    proposedValue: proposedValue,
    currentValue: currentValue,
    SEVERITY_ORDER: SEVERITY_ORDER
  };
})(window);
