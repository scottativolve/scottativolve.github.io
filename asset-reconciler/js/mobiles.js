/* Mobiles and tablets, from SOTI MobiControl.

   The other three populations reconcile two systems against each other. This
   one has nothing to reconcile against yet: none of these devices is in
   Freshservice, so the job is to work out where each one lives and produce a
   file that creates it. That makes the site resolution the whole game.

   SOTI files a device by its folder in a UNC-style hierarchy:

     \\Support Worker Devices\Region 1\Wolsey House    a site
     \\Office Worker Devices\Region 1                  a region, and no site

   Care-site devices are filed by place; office-worker devices are filed by
   region only, because they follow a person rather than a building. So the
   last path segment is a site only at depth three, and reading it as one
   unconditionally would file six hundred devices at a site called
   "Region 1". */
(function (global) {
  'use strict';

  var U = global.U, N = global.Norm;

  var DEFAULTS = {
    staleDays: 30,          // no check-in this long looks neglected
    lostDays: 90,           // no check-in this long looks gone
    minOs: 13,              // Android below this no longer gets security patches
    homeLocation: 'Remote/Home Worker',
    testState: 'Reserved',
    inUseState: 'In Use'
  };

  function settings(saved) { return Object.assign({}, DEFAULTS, saved || {}); }

  var SEVERITY_ORDER = { low: 1, medium: 2, high: 3 };

  /* Top-level folders that hold stock and pilots rather than deployed
     devices. Everything under them is somebody's test handset or a phone
     still in its box at the supplier. */
  var TEST_CLASSES = ['Testing', 'Ice Telecommunications'];

  /* Models seen in the estate, with the Freshservice product name and whether
     the thing is a phone or a tablet. SOTI reports only the model code, and a
     code is not a product name — "SM-A165F" in a Freshservice Product field
     would be a new product nobody recognises. Both mappings are seeds: the
     import dialog lets you change any of them, and a code that is not here
     is flagged rather than guessed at. */
  var MODELS = {
    'SM-A135F':  { product: 'Galaxy A13',        kind: 'Phone' },
    'SM-A137F':  { product: 'Galaxy A13',        kind: 'Phone' },
    'SM-A145R':  { product: 'Galaxy A14 4G',     kind: 'Phone' },
    'SM-A146P':  { product: 'Galaxy A14 5G',     kind: 'Phone' },
    'SM-A155F':  { product: 'Galaxy A15 4G',     kind: 'Phone' },
    'SM-A156B':  { product: 'Galaxy A15 5G',     kind: 'Phone' },
    'SM-A165F':  { product: 'Galaxy A16 4G',     kind: 'Phone' },
    'SM-A166B':  { product: 'Galaxy A16 5G',     kind: 'Phone' },
    'SM-A175F':  { product: 'Galaxy A17 4G',     kind: 'Phone' },
    'SM-A176B':  { product: 'Galaxy A17 5G',     kind: 'Phone' },
    'SM-A226B':  { product: 'Galaxy A22 5G',     kind: 'Phone' },
    'SM-A236B':  { product: 'Galaxy A23 5G',     kind: 'Phone' },
    'SM-G525F':  { product: 'Galaxy XCover 5',   kind: 'Phone' },
    'SM-T290':   { product: 'Galaxy Tab A 8.0 (2019) Wi-Fi', kind: 'Tablet' },
    'SM-T295':   { product: 'Galaxy Tab A 8.0 (2019) LTE',   kind: 'Tablet' },
    'SM-T575':   { product: 'Galaxy Tab Active3', kind: 'Tablet' },
    'SM-X306B':  { product: 'Galaxy Tab Active5 5G', kind: 'Tablet' },
    '8094X_EEA': { product: 'Alcatel 3T',        kind: 'Tablet' },
    '9160G':     { product: 'TCL Tab10',         kind: 'Tablet' }
  };

  /* SOTI folder names that do not match a site name and never will, with the
     site code they belong to. Three of these are the reason this table exists
     rather than a cleverer matcher: "Whitley Park" is Garmsway, "Cannon
     Court" is Ripon and "Wolsey Camascope Pilot" is Wolsey House. No string
     similarity connects those names, so anything claiming to find them
     automatically would be guessing. */
  var SEED_OVERRIDES = {
    'oak view lodge sl':      '225',   // Oakview Lodge — spacing only
    'lady ediths sl':         '222',   // Lady Edith
    'lodge park':             '237',   // Lodge Park Offices
    'gables':                 '090',   // The Gables
    'cranbourne sl':          '072',   // Cranbourne House
    'whitley park':           '092',   // Garmsway
    'cannon court':           '223',   // Ripon
    'wolsey camascope pilot': '060',   // Wolsey House
    /* A folder created in Region 1 by mistake: the service is in Region 2.
       Mapped so the two devices land at the right site meanwhile, and the
       region cross-check below still reports the misfiling. */
    'fairways':               '119'
  };

  /* Fieldbay was the company's name in Wales before the rebrand, so the two
     words mean one region. SOTI uses "Wales" under the support-worker branch
     and "Fieldbay" under the office-worker one; the site list says Fieldbay.
     Region 1 is split into North and Midlands in the site list but not in
     SOTI, so it compares at the coarser level. */
  var REGION_SYNONYMS = { 'fieldbay': 'wales' };
  var REGION_WILDCARDS = { 'various': true, 'group': true, 'ivolve central': true };

  /* Words, not a squashed key: locationKey strips the spaces, so
     "Region 1 - North" arrives as "region1north" with no boundary left to
     match "region 1" against, and every Region 1 device reads as a mismatch. */
  function regionKey(v) {
    var k = N.clean(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!k) return '';
    var reg = k.match(/^region \d+/);
    if (reg) k = reg[0];
    return REGION_SYNONYMS[k] || k;
  }

  /* ---------------------------------------------------------------- paths */

  /* \\Support Worker Devices\Region 1\Wolsey House -> the three names.
     Leading slashes vary between exports, and an empty segment from a double
     separator is not a folder. */
  function pathSegments(p) {
    return String(p == null ? '' : p)
      .replace(/\//g, '\\')
      .split('\\')
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function folderKey(v) { return N.locationKey(v); }

  /* Both tables above are written the way a person reads them, then keyed the
     way folders are keyed. Writing the keys by hand is how the first version
     of this silently did nothing: folderKey strips spaces and punctuation, so
     "whitley park" never matches the key "whitleypark". */
  var OVERRIDE_KEYS = {};
  Object.keys(SEED_OVERRIDES).forEach(function (name) {
    OVERRIDE_KEYS[folderKey(name)] = SEED_OVERRIDES[name];
  });

  var TEST_CLASS_KEYS = {};
  TEST_CLASSES.forEach(function (name) { TEST_CLASS_KEYS[folderKey(name)] = true; });

  /* Strip a trailing " SL" for a second attempt at a site name.

     Only ever a fallback. Six names in the site list exist in both forms as
     genuinely separate services — Alverthorpe 069 and Alverthorpe SL 062,
     Leeds 082 and Leeds SL 063, and four more — so stripping the suffix up
     front would merge pairs of real sites. */
  function withoutSL(v) {
    /* Cut the suffix off the readable name, not the key: folderKey strips
       punctuation and spaces, so by the time it is a key "Oak View Lodge SL"
       reads "oakviewlodgesl" and there is no word boundary left to anchor to.
       Stripping a bare trailing "sl" from a key would eat the end of any name
       that happens to finish with those letters. */
    var raw = N.clean(v).replace(/\s+SL\s*$/i, '').trim();
    return raw ? folderKey(raw) : '';
  }

  function modelInfo(code) {
    var k = N.clean(code);
    return MODELS[k] || MODELS[k.toUpperCase()] || null;
  }

  /* Android versions arrive as a bare major number. */
  function osMajor(v) {
    var m = String(v == null ? '' : v).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  function isYes(v) { return /^(true|yes|1|enabled)$/i.test(String(v == null ? '' : v).trim()); }
  function isNo(v)  { return /^(false|no|0|disabled)$/i.test(String(v == null ? '' : v).trim()); }

  /* Dotted version numbers compare part by part as numbers: "2026.1.5.1204"
     is behind "2026.2.1.1003" even though it sorts after it as text. */
  function olderThan(a, b) {
    var x = String(a).split('.'), y = String(b).split('.');
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var p = parseInt(x[i], 10) || 0, q = parseInt(y[i], 10) || 0;
      if (p !== q) return p < q;
    }
    return false;
  }

  /* Their asset numbers are five digits with a leading zero. A name that is
     not one has had somebody's name or a project written into it. */
  function isAssetNumber(v) { return /^\d{4,6}$/.test(String(v == null ? '' : v).trim()); }

  /* ---------------------------------------------------------------- rules */

  var RULES = [
    {
      code: 'site-unresolved',
      label: 'Site folder not in the site list',
      severity: 'high',
      hint: 'The device is filed under a site folder whose name matches no site, even allowing for a missing ' +
            '"SL". Either the site is missing from your site codes file or the folder needs an override.',
      test: function (r) { return r.hasSiteFolder && !r.site; }
    },
    {
      code: 'site-region-differs',
      label: 'Filed in the wrong region',
      severity: 'medium',
      hint: 'The region folder the device sits in is not the region your site list gives for that site. Usually ' +
            'a folder created in the wrong place rather than a device in the wrong building.',
      test: function (r) {
        if (!r.site || !r.regionFolder) return false;
        // Under Testing the second segment is "Support Worker Test", not a
        // region, so there is nothing for the site's region to disagree with.
        if (r.isTest) return false;
        var a = regionKey(r.regionFolder), b = regionKey(r.site.region);
        if (!a || !b || REGION_WILDCARDS[a] || REGION_WILDCARDS[b]) return false;
        return a !== b;
      },
      detail: function (r) { return 'SOTI says ' + r.regionFolder + ', the site list says ' + r.site.region; }
    },
    {
      code: 'no-serial',
      label: 'No serial number',
      severity: 'high',
      hint: 'Nothing identifies this device. It cannot be imported and it cannot be matched later.',
      test: function (r) { return !r.serial; }
    },
    {
      code: 'no-model',
      label: 'No model reported',
      severity: 'high',
      hint: 'Without a model there is no Product, and Freshservice rejects an asset import without one.',
      test: function (r) { return !r.model; }
    },
    {
      code: 'model-unknown',
      label: 'Model not in the product list',
      severity: 'medium',
      hint: 'SOTI reports a model code this build has never seen, so there is no Freshservice product name for ' +
            'it. Fill it in on the import dialog — normally a handset bought since the last export.',
      test: function (r) { return !!r.model && !r.modelKnown; },
      detail: function (r) { return r.model + ' from ' + (r.manufacturer || 'an unnamed maker'); }
    },
    {
      code: 'never-checked-in',
      label: 'Never checked in',
      severity: 'high',
      hint: 'Enrolled in SOTI but has never reported. Usually a record created for a device that was never ' +
            'handed out.',
      test: function (r) { return !r.checkIn; }
    },
    {
      code: 'long-silent',
      label: 'Silent for months',
      severity: 'high',
      hint: 'No check-in for long enough that the device is probably lost, broken or in a drawer.',
      test: function (r, cfg) { return r.daysSince !== null && r.daysSince > cfg.lostDays; },
      detail: function (r) { return 'last checked in ' + U.agoLabel(r.checkIn); }
    },
    {
      code: 'stale',
      label: 'Not checked in recently',
      severity: 'medium',
      hint: 'Past the staleness window in Settings but not yet long enough to assume it is gone.',
      test: function (r, cfg) {
        return r.daysSince !== null && r.daysSince > cfg.staleDays && r.daysSince <= cfg.lostDays;
      },
      detail: function (r) { return 'last checked in ' + U.agoLabel(r.checkIn); }
    },
    {
      code: 'not-encrypted',
      label: 'Not encrypted',
      severity: 'high',
      hint: 'A care worker’s handset holds people’s records. An unencrypted one is a reportable loss ' +
            'the moment it goes missing.',
      test: function (r) { return r.encrypted === false; }
    },
    {
      code: 'os-unsupported',
      label: 'Android version out of support',
      severity: 'medium',
      hint: 'Below the minimum in Settings, so it no longer receives Android security updates.',
      test: function (r, cfg) { return r.osMajor !== null && r.osMajor < cfg.minOs; },
      detail: function (r) { return 'Android ' + r.osMajor; }
    },
    {
      code: 'agent-behind',
      label: 'SOTI agent behind the fleet',
      severity: 'low',
      /* Off by default. A quarter of the estate is a version or two behind at
         any time, which is agent rollout doing its job rather than a fault,
         and letting it flag four hundred devices would drown everything in
         "Needs attention". Its own view lists them when you want the picture. */
      defaultOff: true,
      hint: 'Running an older MobiControl agent than most of the estate. Normal during a rollout; a device that ' +
            'never upgrades is usually one that never connects.',
      test: function (r, cfg, ctx) {
        return !!r.agentVersion && !!ctx.commonAgent && olderThan(r.agentVersion, ctx.commonAgent);
      },
      detail: function (r, cfg, ctx) { return r.agentVersion + ' against ' + ctx.commonAgent; }
    },
    {
      code: 'name-not-asset-number',
      label: 'Named after a person or a project',
      severity: 'low',
      hint: 'Your naming convention is the five-digit asset number. This one has a name or a pilot written ' +
            'into it, so it will import under that name.',
      test: function (r) { return !!r.name && !isAssetNumber(r.name); }
    },
    {
      code: 'no-imei',
      label: 'No IMEI',
      severity: 'low',
      hint: 'Nothing to give the network operator if the device is lost or needs barring.',
      test: function (r) { return !!r.serial && !r.imei; }
    },
    {
      code: 'test-stock',
      label: 'Test or supplier stock',
      severity: 'low',
      hint: 'Filed under Testing or at the supplier rather than issued to anyone, so it imports as Reserved.',
      test: function (r) { return r.isTest; }
    },
    {
      code: 'duplicate-serial',
      label: 'Serial appears more than once',
      severity: 'high',
      hint: 'Two rows in the export carry the same serial. In a paged SOTI export sorted on a live column this ' +
            'is the export duplicating a record, not two devices — sort the search on Device Name.',
      test: function (r, cfg, ctx) { return !!r.serial && ctx.serialCount[r.serial] > 1; }
    },
    {
      code: 'duplicate-name',
      label: 'Device name appears more than once',
      severity: 'high',
      hint: 'Two rows share a device name, so an import would create one record and overwrite it with the other.',
      test: function (r, cfg, ctx) { return !!r.name && ctx.nameCount[N.locationKey(r.name)] > 1; }
    },
    {
      code: 'site-closed',
      label: 'At a site marked closed',
      severity: 'medium',
      hint: 'The site list says this service is closed, so devices still filed there need collecting or moving.',
      test: function (r) { return !!r.site && /closed/i.test(N.clean(r.site.status)); }
    },
    {
      code: 'no-sites-loaded',
      label: 'No site list loaded',
      severity: 'low',
      hint: 'Load the location lookup and every device gets a site code and a place on the map.',
      test: function (r, cfg, ctx) { return !ctx.hasSites && r.hasSiteFolder; }
    }
  ];

  var RULE_BY_CODE = {};
  RULES.forEach(function (r) { RULE_BY_CODE[r.code] = r; });

  function isEnabled(rule, enabled) {
    if (!enabled) return !rule.defaultOff;
    if (Object.prototype.hasOwnProperty.call(enabled, rule.code)) return !!enabled[rule.code];
    return !rule.defaultOff;
  }

  /* ------------------------------------------------------------- resolve */

  /* One row per SOTI device, with its site worked out.

     overrides is folder key -> site code, seeded with SEED_OVERRIDES and
     extended by the user. sites is the site index by code. */
  function resolve(records, cfg, sites, overrides) {
    cfg = settings(cfg);
    sites = sites || {};
    /* User overrides come in already keyed, and win over the seeds. */
    var ov = Object.assign({}, OVERRIDE_KEYS, overrides || {});

    /* Two ways into the site list: by name, and by name with " SL" removed.
       The second is a fallback and is only trusted where it is unambiguous,
       because six names exist in both forms as separate services. */
    var byName = {}, byBase = {};
    Object.keys(sites).forEach(function (code) {
      var site = sites[code];
      var k = folderKey(site.name);
      if (k && !byName[k]) byName[k] = site;
      var b = withoutSL(site.name);
      if (b) (byBase[b] = byBase[b] || []).push(site);
    });

    var rows = records.map(function (rec, i) {
      var segs = pathSegments(rec.path);
      var cls = segs.length ? segs[0] : '';
      var row = {
        id: 'm' + (i + 1),
        soti: rec,
        name: N.clean(rec.name),
        serial: N.clean(rec.serial).toUpperCase(),
        imei: N.clean(rec.imei),
        model: N.clean(rec.model),
        manufacturer: N.clean(rec.manufacturer),
        family: N.clean(rec.family),
        osVersion: N.clean(rec.osVersion),
        ip: N.clean(rec.ipAddress),
        mac: N.clean(rec.mac),
        agentVersion: N.clean(rec.agentVersion),
        storage: typeof rec.storage === 'number' ? rec.storage : null,
        memory: typeof rec.memory === 'number' ? rec.memory : null,
        path: N.clean(rec.path),
        pathSegments: segs,
        deviceClass: cls,
        // Depth two is a region folder and nothing more; depth three names a site.
        regionFolder: segs.length >= 2 ? segs[1] : '',
        folder: segs.length >= 3 ? segs[segs.length - 1] : '',
        hasSiteFolder: segs.length >= 3,
        isTest: !!TEST_CLASS_KEYS[folderKey(cls)],
        // SOTI stamps its timestamps month-first.
        checkIn: U.parseDate(rec.checkIn, 'mdy'),
        connected: U.parseDate(rec.connected, 'mdy'),
        disconnected: U.parseDate(rec.disconnected, 'mdy'),
        encrypted: isYes(rec.encrypted) ? true : isNo(rec.encrypted) ? false : null,
        osMajor: osMajor(rec.osVersion)
      };
      row.daysSince = row.checkIn ? U.daysSince(row.checkIn) : null;
      // Connected more recently than it disconnected means it is on now.
      row.online = !!(row.connected && (!row.disconnected || row.connected > row.disconnected));

      var info = modelInfo(row.model);
      row.modelKnown = !!info;
      row.modelName = info ? info.product : '';
      row.formFactor = info ? info.kind : '';

      resolveSite(row, ov, byName, byBase);

      /* What the Freshservice Location will say. A site name where there is
         one; the home-worker label where the device is filed by region,
         because those follow a person and SOTI does not say which.

         A device under a site folder that did not resolve gets nothing. It is
         emphatically not a home worker — it is at a real building whose name
         we could not place — and labelling it one would bury the problem
         under six hundred rows that legitimately say the same thing. */
      row.location = row.siteName ? row.siteName
                   : (row.isTest || row.hasSiteFolder) ? ''
                   : cfg.homeLocation;
      row.stateShould = row.isTest ? cfg.testState : cfg.inUseState;
      // The map keys on this, so it has to be the site's own key or nothing.
      row.locationKey = row.site ? folderKey(row.site.name) : '';
      return row;
    });

    return { rows: rows, sites: sites, overrides: ov, cfg: cfg };
  }

  /* Exact name, then an override, then " SL" treated as optional.

     The override is consulted before the SL fallback so a folder you have
     answered for is never quietly resolved a different way. */
  function resolveSite(row, ov, byName, byBase) {
    row.site = null;
    row.siteCode = '';
    row.siteName = '';
    row.siteMatch = '';
    if (!row.hasSiteFolder) return;

    var k = folderKey(row.folder);
    if (byName[k]) { set(row, byName[k], 'exact'); return; }

    var code = ov[k];
    if (code) {
      var byCode = null;
      Object.keys(byName).forEach(function (n) {
        if (!byCode && byName[n].code === code) byCode = byName[n];
      });
      if (byCode) { set(row, byCode, 'override'); return; }
      // The override names a code the site list does not have, which is worth
      // saying rather than silently falling through to a fuzzier match.
      row.overrideMissing = code;
      return;
    }

    var cands = byBase[withoutSL(row.folder)] || [];
    if (cands.length === 1) { set(row, cands[0], 'SL optional'); return; }
    if (cands.length > 1) row.siteAmbiguous = cands.length;
  }

  function set(row, site, how) {
    row.site = site;
    row.siteCode = site.code;
    row.siteName = site.name;
    row.siteMatch = how;
  }

  /* ---------------------------------------------------------- rule pass */

  function apply(result, cfg, enabled) {
    cfg = settings(cfg);
    var rows = result.rows;

    var serialCount = {}, nameCount = {}, agentVotes = {};
    rows.forEach(function (r) {
      if (r.serial) serialCount[r.serial] = (serialCount[r.serial] || 0) + 1;
      var nk = N.locationKey(r.name);
      if (nk) nameCount[nk] = (nameCount[nk] || 0) + 1;
      if (r.agentVersion) agentVotes[r.agentVersion] = (agentVotes[r.agentVersion] || 0) + 1;
    });
    var commonAgent = '', best = 0;
    Object.keys(agentVotes).forEach(function (v) {
      if (agentVotes[v] > best) { best = agentVotes[v]; commonAgent = v; }
    });

    var ctx = {
      hasSites: result.sites && Object.keys(result.sites).length > 0,
      serialCount: serialCount,
      nameCount: nameCount,
      commonAgent: commonAgent
    };

    var active = RULES.filter(function (r) { return isEnabled(r, enabled); });
    var tally = {};
    active.forEach(function (r) { tally[r.code] = 0; });

    rows.forEach(function (row) {
      row.issues = [];
      row.details = {};
      var worst = null;
      active.forEach(function (rule) {
        var hit = false;
        try { hit = !!rule.test(row, cfg, ctx); } catch (e) { hit = false; }
        if (!hit) return;
        row.issues.push(rule.code);
        try { row.details[rule.code] = rule.detail ? rule.detail(row, cfg, ctx) : ''; }
        catch (e) { row.details[rule.code] = ''; }
        tally[rule.code]++;
        if (!worst || SEVERITY_ORDER[rule.severity] > SEVERITY_ORDER[worst]) worst = rule.severity;
      });
      row.severity = worst;
      row.issueCount = row.issues.length;
    });

    result.tally = tally;
    result.rulesUsed = active.map(function (r) { return r.code; });
    result.commonAgent = commonAgent;
    result.counts = {
      total: rows.length,
      atSite: rows.filter(function (r) { return !!r.site; }).length,
      homeWorker: rows.filter(function (r) { return !r.hasSiteFolder && !r.isTest; }).length,
      test: rows.filter(function (r) { return r.isTest; }).length,
      unresolved: rows.filter(function (r) { return r.hasSiteFolder && !r.site; }).length,
      sites: Object.keys(rows.reduce(function (acc, r) {
        if (r.siteCode) acc[r.siteCode] = true;
        return acc;
      }, {})).length,
      tablets: rows.filter(function (r) { return r.formFactor === 'Tablet'; }).length,
      phones: rows.filter(function (r) { return r.formFactor === 'Phone'; }).length
    };
    return result;
  }

  /* Every distinct site folder in the export, with how it resolved. This is
     what the overrides dialog lists, so it includes the ones that worked. */
  function folders(rows) {
    var seen = {};
    (rows || []).forEach(function (r) {
      if (!r.hasSiteFolder) return;
      var k = folderKey(r.folder);
      if (!seen[k]) {
        seen[k] = {
          key: k, folder: r.folder, regionFolder: r.regionFolder,
          count: 0, siteCode: r.siteCode, siteName: r.siteName, match: r.siteMatch,
          examples: []
        };
      }
      seen[k].count++;
      if (seen[k].examples.length < 3) seen[k].examples.push(r.name);
    });
    return Object.keys(seen).sort().map(function (k) { return seen[k]; });
  }

  global.Mobiles = {
    DEFAULTS: DEFAULTS,
    RULES: RULES,
    RULE_BY_CODE: RULE_BY_CODE,
    SEVERITY_ORDER: SEVERITY_ORDER,
    MODELS: MODELS,
    SEED_OVERRIDES: SEED_OVERRIDES,
    TEST_CLASSES: TEST_CLASSES,
    settings: settings,
    isEnabled: isEnabled,
    resolve: resolve,
    apply: apply,
    folders: folders,
    pathSegments: pathSegments,
    folderKey: folderKey,
    withoutSL: withoutSL,
    regionKey: regionKey,
    modelInfo: modelInfo,
    isAssetNumber: isAssetNumber,
    olderThan: olderThan,
    OVERRIDE_KEYS: OVERRIDE_KEYS
  };
})(window);
