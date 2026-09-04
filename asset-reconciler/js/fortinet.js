/* FortiManager's managed-device export is a rendered tree, not a table: the
   hierarchy lives in the leading spaces of the Device Name column, section
   rows carry nothing but a label, and an HA row stands for two physical
   firewalls with both serials packed into one cell.

   This module turns that into one record per physical device, and says out
   loud everywhere it could not be sure. */
(function (global) {
  'use strict';

  var U = global.U, N = global.Norm;

  /* Section labels FortiManager uses for the two managed-device families.
     Anything else at that depth is a grouping row we do not recognise —
     a Security Fabric group, for instance — and we say so rather than
     assuming its children are switches.

     Each carries two names. family is FortiManager's own word for the product
     line; kind is what the device *is*, in words that do not name a vendor,
     because the network population also holds kit no FortiManager has ever
     seen — Ubiquiti access points, for one — and calling those a FortiAP would
     be plainly wrong. */
  var SECTIONS = {
    FSW: { family: 'FortiSwitch', kind: 'Switch' },
    FAP: { family: 'FortiAP', kind: 'Access point' }
  };

  var GATE = { family: 'FortiGate', kind: 'Firewall' };

  var VENDOR = 'Fortinet';

  /* ------------------------------------------------------------ firmware */

  /* One version, four spellings across the two environments:
       FortiGate 7.6.7,build3704 (GA) (Mature)
       S108FF-v7.6.6-build1137,251212 (GA)
       FP431F-v7.6.5-build1105
       Enforced Version 7.4.11-b2878,Low Vulnerability
     A lone "-" (sometimes Excel-guarded as "'-") means the device is
     registered but has never reported in. */
  function firmware(raw) {
    var s = String(raw == null ? '' : raw).trim().replace(/^'/, '');
    if (!s || s === '-') return { version: '', build: '', text: s, reported: false };
    var v = s.match(/(\d+\.\d+(?:\.\d+)?)/);
    var b = s.match(/build\s*(\d+)/i) || s.match(/-b(\d+)/i);
    return {
      version: v ? v[1] : '',
      build: b ? b[1] : '',
      text: s,
      reported: !!v
    };
  }

  /* Compare two firmware strings on version and build only, so
     "S148FF-v7.4.6-build895,250129 (GA)" and "7.4.6 build 895" agree. */
  function sameFirmware(a, b) {
    var x = firmware(a), y = firmware(b);
    if (!x.version || !y.version) return false;
    if (x.version !== y.version) return false;
    if (x.build && y.build) return x.build === y.build;
    return true;
  }

  /* ------------------------------------------------------------------ HA */

  /* An HA row's Serial Number is "SER1 (Primary),SER2 (Secondary)" and its
     HA Status is "name1 (Primary, Synchronized),name2 (Secondary, Out of
     Sync)". The status field has commas inside its brackets, so it cannot be
     split on commas — match the bracketed groups instead. */
  function haMembers(serialCell, statusCell) {
    var serials = String(serialCell || '').split(',').map(function (s) {
      var t = s.trim();
      var m = t.match(/^(.*?)\s*\((Primary|Secondary)\)\s*$/i);
      return m ? { serial: m[1].trim(), role: cap(m[2]) } : { serial: t, role: '' };
    }).filter(function (s) { return s.serial; });

    var members = [];
    var re = /([^,(]+)\(([^)]*)\)/g, m;
    while ((m = re.exec(String(statusCell || '')))) {
      var inner = m[2].split(',').map(function (x) { return x.trim(); });
      members.push({
        name: m[1].trim().replace(/^,\s*/, ''),
        role: cap(inner[0] || ''),
        sync: inner.slice(1).join(', ')
      });
    }
    return { serials: serials, members: members };
  }

  function cap(s) {
    s = String(s || '').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
  }

  function isHaRow(rec) {
    return String(rec.serial || '').indexOf(',') >= 0 ||
           /\(\s*(Primary|Secondary)\s*[,)]/i.test(String(rec.haStatus || ''));
  }

  /* -------------------------------------------------------------- site */

  /* The leading number in a device name is the site code, zero-padded to
     three. It is right for the overwhelming majority and wrong in a handful
     of named cases, which is what the override table is for — this never
     tries to be clever about the rest. */
  function codeFromName(name) {
    var m = String(name || '').match(/^(\d{1,5})[-_ ]/);
    if (!m) return '';
    var n = m[1].replace(/^0+/, '');
    return n ? n.padStart(3, '0') : '';
  }

  /* Words that say what a device is, or who owns it, rather than where it is.
     A name built only from these carries no location evidence at all, so
     there is nothing for the site to agree or disagree with. */
  var NOISE = ('fw fw1 fw01 fwa fwb sw sw1 sw01 sws ap wap aps fs fgt gate ' +
               'pri sec ha hq poe fpoe lan wan vlan ' +
               'ivo ivolve std shr site network ' +
               // Address words shared by half the estate: "Stanley Road" and
               // "Stenson Road" agree on "road" and on nothing that matters.
               'road street avenue close lane court house lodge cottage the ' +
               'view park gardens garden way drive hill place mews bungalow').split(' ');

  function nameTokens(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
      .filter(Boolean)
      .map(function (t) { return t.replace(/\d+$/, ''); })   // "ap04" -> "ap", "sw01" -> "sw"
      .filter(function (t) {
        return t.length > 2 && NOISE.indexOf(t) < 0 && !/^\d+$/.test(t);
      });
  }

  /* A Fortinet serial is a single unbroken run of letters and digits, with no
     separators at all — "S108FFTV25016309". A device still named after one
     tells you nothing about where it is. The no-separator test matters:
     stripping punctuation first made "113-117-StanleyRoad-FW1" look like a
     serial and exempted the very case this is here to catch. */
  function looksLikeSerial(s) {
    var t = String(s || '').trim();
    return /^[A-Za-z0-9]{10,}$/.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t);
  }

  /* Do a device name and the site it resolved to have any word in common?
     Only judged when the name actually offers a word to judge: this is meant
     to catch "113-117-StanleyRoad-FW1" resolving to Moorgreen, not to complain
     about "IVO-111-AP-03", which names no place at all. */
  function nameAgrees(deviceName, siteName) {
    if (looksLikeSerial(deviceName)) return true;
    var a = nameTokens(deviceName);
    var b = nameTokens(siteName);
    if (!a.length || !b.length) return true;          // no evidence either way
    return a.some(function (t) {
      return b.some(function (u) { return u.indexOf(t) >= 0 || t.indexOf(u) >= 0 || near(t, u); });
    });
  }

  /* "Gorefield" against "Gorefeld", "Spinnyfield" against "Spinneyfield":
     one system has a typo, but the device is still at that site, so this is
     not the kind of disagreement the flag is for. Only long tokens qualify —
     two characters of slack on a short word matches almost anything. */
  function near(a, b) {
    if (a.length < 6 || b.length < 6) return false;
    if (Math.abs(a.length - b.length) > 2) return false;
    return distance(a, b, 2) <= 2;
  }

  /* Levenshtein, abandoned as soon as every cell in a row exceeds the cap. */
  function distance(a, b, cap) {
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      var best = cur[0];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)
        );
        if (cur[j] < best) best = cur[j];
      }
      if (best > cap) return cap + 1;
      prev = cur.slice();
    }
    return prev[b.length];
  }

  /* ---------------------------------------------------------- flattening */

  /* records: projected fortimanager rows, in file order, each carrying its
              indent depth and environment tag on _raw.
     opts.sites:     { code: { code, name, ... } } from the location lookup
     opts.overrides: { deviceNameLower: siteCode } the user maintains
  */
  function flatten(records, opts) {
    opts = opts || {};
    var sites = opts.sites || {};
    var overrides = {};
    Object.keys(opts.overrides || {}).forEach(function (k) {
      overrides[String(k).trim().toLowerCase()] = String(opts.overrides[k]).trim();
    });
    var indentKey = (global.CSV && global.CSV.INDENT) || '__indent';

    var out = [], warnings = [];
    var gate = null, section = null, sectionEnv = null;

    (records || []).forEach(function (rec) {
      var raw = rec._raw || {};
      var depth = Number(raw[indentKey] || 0);
      var env = raw.__env || '';
      var name = String(rec.name || '').trim();
      if (!name) return;

      if (depth === 0) {
        section = null;
        gate = { name: name, env: env };
        if (isHaRow(rec)) {
          var ha = haMembers(rec.serial, rec.haStatus);
          var count = Math.max(ha.serials.length, ha.members.length);
          if (ha.serials.length !== ha.members.length) {
            warnings.push({
              kind: 'ha-mismatch', device: name, env: env,
              text: name + ': the HA row lists ' + ha.serials.length + ' serial(s) but ' +
                    ha.members.length + ' cluster member(s), so they were paired as far as they go.'
            });
          }
          for (var i = 0; i < count; i++) {
            var s = ha.serials[i] || { serial: '', role: '' };
            var mem = ha.members[i] || { name: '', role: '', sync: '' };
            out.push(device(rec, {
              kind: GATE.kind,
              family: GATE.family,
              name: mem.name || s.serial || name,
              serial: s.serial,
              env: env,
              parent: '',
              haRow: name,
              haRole: s.role || mem.role,
              haSync: mem.sync
            }));
          }
        } else {
          out.push(device(rec, {
            kind: GATE.kind, family: GATE.family, name: name,
            serial: String(rec.serial || '').trim(), env: env, parent: ''
          }));
        }
        return;
      }

      if (depth <= 4) {
        section = name;
        sectionEnv = env;
        if (!SECTIONS[name]) {
          warnings.push({
            kind: 'unknown-section', device: name, env: env,
            text: 'Unrecognised grouping row "' + name + '"' +
                  (gate ? ' under ' + gate.name : '') + '. Anything listed beneath it is ' +
                  'reported as "' + label(name) + '" rather than guessed at.'
          });
        }
        return;
      }

      out.push(device(rec, {
        kind: (SECTIONS[section] || {}).kind || label(section),
        family: (SECTIONS[section] || {}).family || label(section),
        name: name,
        serial: String(rec.serial || '').trim(),
        env: env || sectionEnv,
        parent: gate ? gate.name : ''
      }));
    });

    // Resolve the site for every device, then say where the answer looks wrong.
    var byName = {};
    out.forEach(function (d) { byName[d.name.toLowerCase()] = d; });

    out.forEach(function (d) {
      var ov = overrides[d.name.toLowerCase()];
      var own = codeFromName(d.name);
      var parent = d.parent ? codeFromName(d.parent) : '';

      if (ov) {
        d.siteCode = ov;
        d.siteSource = 'override';
      } else if (own && sites[own]) {
        d.siteCode = own;
        d.siteSource = 'name';
      } else if (parent && sites[parent]) {
        d.siteCode = parent;
        d.siteSource = 'parent';
      } else {
        d.siteCode = '';
        d.siteSource = own || parent ? 'unknown-code' : 'none';
      }

      var site = d.siteCode ? sites[d.siteCode] : null;
      d.siteName = site ? site.name : '';
      d.site = site || null;
      d.siteAgrees = !site || d.siteSource === 'override' || d.namedBySerial ||
                     nameAgrees(d.name, site.name);
    });

    return { devices: out, warnings: warnings };
  }

  function label(section) {
    return section ? 'Unknown (' + section + ')' : 'Unknown';
  }

  function device(rec, over) {
    var fw = firmware(rec.firmware);
    var d = {
      kind: over.kind,
      family: over.family || over.kind,
      vendor: VENDOR,
      name: over.name,
      serial: over.serial,
      serialKey: N.serial(over.serial),
      env: over.env || '',
      parent: over.parent || '',
      haRow: over.haRow || '',
      haRole: over.haRole || '',
      haSync: over.haSync || '',
      platform: String(rec.platform || '').trim(),
      firmwareText: fw.text,
      firmwareVersion: fw.version,
      firmwareBuild: fw.build,
      reported: fw.reported,
      hostName: String(rec.hostName || '').trim(),
      configStatus: String(rec.configStatus || '').trim(),
      ipAddress: String(rec.ipAddress || '').trim(),
      description: String(rec.description || '').trim(),
      controllers: String(rec.controllers || '').trim(),
      policyPkg: String(rec.policyPkg || '').trim(),
      fortiguard: String(rec.fortiguard || '').trim(),
      mgmtMode: String(rec.mgmtMode || '').trim(),
      upgrade: String(rec.upgrade || '').trim(),
      fwTemplate: String(rec.fwTemplate || '').trim(),
      fabric: String(rec.fabric || '').trim(),
      autoLink: String(rec.autoLink || '').trim(),
      row: rec._row
    };
    // A device still carrying its factory name has never been renamed after
    // joining the fabric — worth seeing, and harmless for matching.
    d.namedBySerial = !!d.serial && N.serial(d.name) === N.serial(d.serial);
    return d;
  }

  global.Fortinet = {
    SECTIONS: SECTIONS,
    GATE: GATE,
    VENDOR: VENDOR,
    flatten: flatten,
    firmware: firmware,
    sameFirmware: sameFirmware,
    codeFromName: codeFromName,
    nameAgrees: nameAgrees,
    looksLikeSerial: looksLikeSerial,
    nameTokens: nameTokens,
    haMembers: haMembers,
    isHaRow: isHaRow
  };
})(window);
