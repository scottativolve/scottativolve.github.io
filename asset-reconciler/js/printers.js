/* Printers, reconciled between OneStop and Freshservice.

   Unlike the network side there is nothing much to discover: the register is
   complete. What is wrong is the fields — asset states left at In Stock on
   machines that have printed forty thousand pages, serials sitting in the Name
   column and nowhere else, IP addresses left behind by a re-IP. So this is a
   correction job, and each field has its own authoritative side:

     serial, IP, meter reads, monitoring  -> OneStop, which polls the device
     location                             -> Freshservice, which knows the
                                             building rather than the campus

   OneStop is the managed print service's monitoring app: it reads the meters
   and ships toner when a printer runs low, so a printer it is not monitoring
   is one nobody is watching. */
(function (global) {
  'use strict';

  var U = global.U, N = global.Norm;

  var DEFAULTS = {
    staleDays: 30,            // no report from OneStop in this long
    idleMono: 500,            // lifetime pages below which a printer looks unused
    locationSource: 'fs'      // 'fs' | 'onestop' — who wins on location
  };

  function settings(saved) { return Object.assign({}, DEFAULTS, saved || {}); }

  var SEVERITY_ORDER = { low: 1, medium: 2, high: 3 };

  /* A Freshservice state that says the printer is not in service. */
  function idleState(v) {
    return /^(in stock|stock|spare|store|stored)$/i.test(String(v || '').trim());
    }

  var RULES = [
    {
      code: 'state-wrong',
      label: 'Marked In Stock but printing',
      severity: 'high',
      hint: 'Freshservice has this in stock, and OneStop has it reporting with pages on the meter. The state is simply out of date.',
      fix: { field: 'state' },
      test: function (r, cfg) {
        return !!r.os && !!r.fs && idleState(r.fsState) && r.reporting && (r.mono || r.colour);
      },
      detail: function (r) {
        return 'last reported ' + U.agoLabel(r.lastSeen) + ', ' +
          U.num((r.mono || 0) + (r.colour || 0)) + ' pages on the meter';
      }
    },
    {
      code: 'serial-missing',
      label: 'No serial on the FS record',
      severity: 'high',
      hint: 'The serial is in the Name field but the Serial Number field is empty, so nothing else can key on it.',
      fix: { field: 'serial' },
      test: function (r) { return !!r.fs && !!r.serial && N.isBlank(r.fs.serial); }
    },
    {
      code: 'ip-differs',
      label: 'IP address out of date',
      severity: 'medium',
      hint: 'OneStop polls the printer, so its address is the current one.',
      fix: { field: 'ipAddress' },
      test: function (r) {
        if (!r.os || !r.fs) return false;
        var a = usable(r.ipOnestop), b = N.clean(r.ipFs);
        return !!a && !!b && a !== b;
      },
      detail: function (r) { return 'Freshservice ' + r.ipFs + ', OneStop ' + r.ipOnestop; }
    },
    {
      code: 'ip-missing',
      label: 'No IP on the FS record',
      severity: 'low',
      fix: { field: 'ipAddress' },
      test: function (r) { return !!r.os && !!r.fs && !!usable(r.ipOnestop) && N.isBlank(r.ipFs); }
    },
    {
      code: 'mac-missing',
      label: 'No MAC on the FS record',
      severity: 'low',
      fix: { field: 'mac' },
      test: function (r) { return !!r.os && !!r.fs && !!N.clean(r.macOnestop) && N.isBlank(r.macFs); }
    },
    {
      code: 'product-inconsistent',
      label: 'Product spelt differently from the rest',
      severity: 'medium',
      hint: 'Most of your Freshservice records spell this model another way. The majority spelling is taken as the house one.',
      fix: { field: 'product' },
      test: function (r) { return !!r.productDiffers; },
      detail: function (r) { return N.clean(r.fsProduct) + ' \u2192 ' + r.productShould; }
    },
    {
      code: 'product-has-make',
      label: 'Product still names the make',
      severity: 'low',
      hint: 'Most product names here are the model on its own. This one carries the manufacturer as well, which is only a naming difference \u2014 no correction is proposed, because your own records are unanimous for this model.',
      test: function (r) {
        var v = N.clean(r.fsProduct);
        return !!v && v !== stripMake(v) && !r.productDiffers;
      }
    },
    {
      code: 'vendor-missing',
      label: 'No vendor recorded',
      severity: 'low',
      fix: { field: 'vendor' },
      test: function (r) { return !!r.fs && N.isBlank(r.fsVendor) && !!r.vendorShould; }
    },
    {
      code: 'location-conflict',
      label: 'The two systems name different sites',
      severity: 'medium',
      hint: 'Both place this printer at a site in your list, and they are not the same site. One of them is wrong.',
      test: function (r) {
        return !!r.fsSite && !!r.osSite && r.fsSite.code !== r.osSite.code;
      },
      detail: function (r) {
        return 'Freshservice ' + r.fsSite.code + ' ' + r.fsSite.name +
               ', OneStop ' + r.osSite.code + ' ' + r.osSite.name;
      }
    },
    {
      code: 'location-wording',
      label: 'Location worded differently',
      severity: 'low',
      defaultOff: true,
      hint: 'The two systems say the same thing in different words \u2014 OneStop usually names the campus where Freshservice names the building. Off by default: it is a wording difference, not a disagreement about where the printer is.',
      test: function (r) {
        if (!r.os || !r.fs) return false;
        if (r.fsSite && r.osSite && r.fsSite.code !== r.osSite.code) return false;  // the conflict above
        var a = N.clean(r.fsLocation), b = stripCompany(r.siteName);
        if (!a || !b) return false;
        return N.locationKey(a) !== N.locationKey(b);
      },
      detail: function (r) { return 'Freshservice "' + r.fsLocation + '", OneStop "' + r.siteName + '"'; }
    },
    {
      code: 'location-missing',
      label: 'No location on the FS record',
      severity: 'medium',
      fix: { field: 'location' },
      test: function (r) { return !!r.fs && N.isBlank(r.fsLocation); }
    },
    {
      code: 'site-unresolved',
      label: 'Site not in the lookup',
      severity: 'medium',
      hint: 'Neither system places this printer at a site in your site list, so it cannot be mapped.',
      test: function (r, cfg, ctx) { return ctx.hasSites && !r.site; }
    },
    {
      code: 'not-reporting',
      label: 'Not reporting to OneStop',
      severity: 'high',
      hint: 'On the contract but silent. Toner will not be shipped for a printer OneStop cannot see.',
      test: function (r, cfg) { return !!r.os && !r.reporting; },
      detail: function (r) {
        return r.lastSeen ? 'last reported ' + U.agoLabel(r.lastSeen) : 'has never reported';
      }
    },
    {
      code: 'not-monitored',
      label: 'Monitoring switched off',
      severity: 'high',
      hint: 'OneStop is not monitoring this printer, so nobody is watching its meters or its toner.',
      test: function (r) { return !!r.os && r.monitored === false; }
    },
    {
      code: 'no-proactive-toner',
      label: 'No proactive consumables',
      severity: 'medium',
      hint: 'Toner is not shipped automatically for this printer — somebody has to notice and order it.',
      test: function (r) { return !!r.os && r.proactive === false; }
    },
    {
      code: 'legacy-subnet',
      label: 'Still on a legacy 192.168 address',
      severity: 'medium',
      hint: 'Pre-migration addressing. Usually a printer that was left behind rather than moved.',
      test: function (r) { return /^192\.168\./.test(N.clean(r.ipOnestop) || N.clean(r.ipFs)); }
    },
    {
      code: 'closed-site',
      label: 'At a closed or non-care site',
      severity: 'medium',
      hint: 'The site name says closed, or it is pool stock or an office rather than a service.',
      test: function (r) { return !!r.siteName && /\(closed\)|pool stock|business centre|business plaza/i.test(r.siteName); }
    },
    {
      code: 'barely-used',
      label: 'Barely used',
      severity: 'low',
      hint: 'A low lifetime page count for a printer that is still on the contract.',
      test: function (r, cfg) {
        if (!r.os || !r.reporting) return false;
        var total = (r.mono || 0) + (r.colour || 0);
        return total > 0 && total < cfg.idleMono;
      },
      detail: function (r) { return U.num((r.mono || 0) + (r.colour || 0)) + ' pages in its life'; }
    },
    {
      code: 'not-a-printer',
      label: 'Not a printer',
      severity: 'low',
      hint: 'On the print contract but not a device — print management software, for instance.',
      test: function (r) {
        return /print ?logic|printerlogic|vasion/i.test(N.clean(r.model) + ' ' + N.clean(r.fsProduct));
      }
    },
    {
      code: 'tag-differs',
      label: 'Asset tag is not the OneStop site',
      severity: 'low',
      hint: 'Freshservice uses Asset Tag to hold the OneStop site number, and the two disagree here.',
      test: function (r) {
        if (!r.os || !r.fs) return false;
        var a = tagKey(r.fsTag), b = tagKey(r.siteNum);
        return !!a && !!b && a !== b;
      },
      detail: function (r) { return 'Freshservice ' + r.fsTag + ', OneStop ' + r.siteNum; }
    },
    {
      code: 'tag-shared',
      label: 'Asset tag used by several printers',
      severity: 'low',
      hint: 'Asset Tag is holding a site reference rather than identifying the device, so the same value turns up on more than one record.',
      test: function (r) { return r.tagShared > 1; },
      detail: function (r) { return r.fsTag + ' is on ' + r.tagShared + ' records'; }
    },
    {
      code: 'onestop-only',
      label: 'Not in Freshservice',
      severity: 'high',
      hint: 'On the print contract with no Freshservice record at all.',
      test: function (r) { return !!r.os && !r.fs; }
    },
    {
      code: 'fs-only',
      label: 'Not on the print contract',
      severity: 'medium',
      hint: 'A Freshservice printer OneStop does not list — a spare, or one that has left the contract.',
      test: function (r) { return !!r.fs && !r.os; }
    }
  ];

  var RULE_BY_CODE = {};
  RULES.forEach(function (r) { RULE_BY_CODE[r.code] = r; });

  function isEnabled(rule, enabled) {
    if (enabled && Object.prototype.hasOwnProperty.call(enabled, rule.code)) return !!enabled[rule.code];
    return !rule.defaultOff;
  }

  /* ------------------------------------------------------------- helpers */

  /* 0.0.0.0 is OneStop saying it has no address, not an address. */
  function usable(ip) {
    var v = N.clean(ip);
    return v && v !== '0.0.0.0' ? v : '';
  }

  function tagKey(v) {
    return String(v || '').trim().replace(/\\/g, '/').toUpperCase();
  }

  /* OneStop prefixes every site with the operating company. */
  function stripCompany(v) {
    return String(v || '').replace(/^\s*(ivolve care|tlc care homes ltd|tlc care homes)\s*-?\s*/i, '').trim();
  }

  /* Strip the make off a product name. */
  function stripMake(model) {
    var m = N.clean(model);
    if (!m) return '';
    return m.replace(/^(hp|hewlett[- ]packard|canon|xerox|ricoh|brother|kyocera|lexmark|epson)\s+/i, '').trim();
  }

  /* The house spelling of a product, learnt from Freshservice rather than
     invented: whichever spelling most of your own records already use for that
     model is the one the rest should match. Inventing a convention instead
     flagged thirteen records for a capital letter and would have "corrected"
     the majority spelling to my own. */
  function houseProducts(osRecords, fsRecords, keyOf) {
    var votes = {};
    (fsRecords || []).forEach(function (a) {
      var v = N.clean(a.product);
      if (!v) return;
      var k = keyOf(a);
      if (!k) return;
      votes[k] = votes[k] || {};
      votes[k][v] = (votes[k][v] || 0) + 1;
    });
    var out = {};
    Object.keys(votes).forEach(function (k) {
      var best = '', n = 0;
      Object.keys(votes[k]).forEach(function (v) { if (votes[k][v] > n) { n = votes[k][v]; best = v; } });
      out[k] = best;
    });
    return out;
  }

  function modelKey(v) { return stripMake(v).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  function vendorOf(model) {
    var m = N.clean(model).toLowerCase();
    if (/^hp\b|hewlett/.test(m)) return 'HP';
    if (/^canon/.test(m)) return 'Canon';
    if (/^xerox/.test(m)) return 'Xerox';
    if (/^ricoh/.test(m)) return 'Ricoh';
    if (/^brother/.test(m)) return 'Brother';
    if (/^kyocera/.test(m)) return 'Kyocera';
    if (/^lexmark/.test(m)) return 'Lexmark';
    if (/^epson/.test(m)) return 'Epson';
    return '';
  }

  function yesNo(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return null;
    if (/^(1|y|yes|true|on|enabled)$/.test(s)) return true;
    if (/^(0|n|no|false|off|disabled)$/.test(s)) return false;
    return null;
  }

  /* -------------------------------------------------------- reconciliation */

  /* osRecords: projected onestop rows
     fsRecords: projected fsprinter rows
     sites:     { code: site } from the location lookup
  */
  function reconcile(osRecords, fsRecords, cfg, sites) {
    cfg = settings(cfg);
    sites = sites || {};
    var os = osRecords || [], fs = fsRecords || [];

    /* Sites reachable by name and by postcode. Printers carry neither a site
       code nor a device name that encodes one, so the name is the join and the
       postcode is the tiebreak — except where a postcode covers a whole campus,
       in which case it settles nothing and is left alone. */
    var byName = {}, byPostcode = {};
    Object.keys(sites).forEach(function (code) {
      var s = sites[code];
      siteKeys(s.name).forEach(function (nk) {
        if (nk && !byName[nk]) byName[nk] = s;
      });
      var pk = postKey(s.postcode);
      if (pk) (byPostcode[pk] = byPostcode[pk] || []).push(s);
    });

    function findSite(v) {
      var ks = siteKeys(v);
      for (var i = 0; i < ks.length; i++) {
        if (ks[i] && byName[ks[i]]) return byName[ks[i]];
      }
      return null;
    }

    /* The Freshservice serial lives in Serial Number when it is filled in and
       in Name when it is not — Name is the serial on every record in the
       export, which is what makes the match complete. */
    function fsKey(a) { return N.serial(a.serial) || N.serial(a.name); }

    /* The house spelling per model, voted for by your own records. Keyed on
       the model with the make stripped and punctuation and case removed, so
       "HP E57540dn", "E57540DN" and "E57540 DN" are one model. */
    var house = houseProducts(os, fs, function (a) { return modelKey(a.product); });

    var fsBySerial = {}, tagCount = {};
    fs.forEach(function (a) {
      var k = fsKey(a);
      if (k) (fsBySerial[k] = fsBySerial[k] || []).push(a);
      var t = tagKey(a.assetTag);
      if (t) tagCount[t] = (tagCount[t] || 0) + 1;
    });
    var fsByMac = {};
    fs.forEach(function (a) {
      var m = N.clean(a.mac).toUpperCase().replace(/[^0-9A-F]/g, '');
      if (m) (fsByMac[m] = fsByMac[m] || []).push(a);
    });

    var rows = [], seen = {}, id = 0;

    os.forEach(function (d) {
      var key = N.serial(d.serial);
      var matches = (key && fsBySerial[key]) || [];
      var on = matches.length ? 'serial' : '';
      if (!matches.length) {
        var mac = N.clean(d.mac).toUpperCase().replace(/[^0-9A-F]/g, '');
        if (mac && fsByMac[mac]) { matches = fsByMac[mac]; on = 'mac'; }
      }
      matches.forEach(function (a) { seen[a._row] = true; });
      rows.push(build(++id, d, matches[0] || null, on, findSite, byPostcode, tagCount, cfg, house));
    });

    fs.forEach(function (a) {
      if (seen[a._row]) return;
      rows.push(build(++id, null, a, '', findSite, byPostcode, tagCount, cfg, house));
    });

    return {
      rows: rows,
      counts: { onestop: os.length, fs: fs.length, rows: rows.length },
      sites: sites
    };
  }

  function postKey(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  /* The keys a site name can be matched under. Ninety-three of the site names
     end in " SL" — supported living, a service type rather than part of the
     name — and Freshservice writes the same place both with and without it, so
     both spellings are indexed. Only SL: House, Lodge and Cottage really are
     part of the names they end. */
  function siteKeys(v) {
    var raw = N.clean(v);
    if (!raw) return [];
    var out = [N.locationKey(raw)];
    var trimmed = raw.replace(/\s+SL\s*$/i, '').trim();
    if (trimmed && trimmed !== raw) out.push(N.locationKey(trimmed));
    return out.filter(Boolean);
  }

  function build(id, d, a, matchedBy, findSite, byPostcode, tagCount, cfg, house) {
    var model = d ? d.model : (a ? a.product : '');
    var row = {
      id: 'p' + id,
      os: d, fs: a,
      matchedBy: matchedBy,

      name: a ? a.name : (d ? d.serial : ''),
      serial: d ? N.clean(d.serial) : (a ? (N.clean(a.serial) || N.clean(a.name)) : ''),
      model: N.clean(model),
      vendorShould: vendorOf(d ? d.model : (a ? a.product : '')),

      siteNum: d ? N.clean(d.siteNum) : '',
      siteName: d ? N.clean(d.siteName) : '',
      spot: d ? N.clean(d.location) : '',
      postcode: d ? N.clean(d.postcode) : '',
      contract: d ? N.clean(d.contract) : '',

      ipOnestop: d ? N.clean(d.ipAddress) : '',
      ipFs: a ? N.clean(a.ipAddress) : '',
      macOnestop: d ? N.clean(d.mac) : '',
      macFs: a ? N.clean(a.mac) : '',

      mono: d && typeof d.mono === 'number' ? d.mono : null,
      colour: d && typeof d.colour === 'number' ? d.colour : null,
      monitored: d ? yesNo(d.monitored) : null,
      proactive: d ? yesNo(d.proactive) : null,
      lastSeen: d ? U.parseDate(d.lastSeen) : null,

      fsName: a ? N.clean(a.name) : '',
      fsState: a ? N.clean(a.state) : '',
      fsLocation: a ? N.clean(a.location) : '',
      fsProduct: a ? N.clean(a.product) : '',
      fsVendor: a ? N.clean(a.vendor) : '',
      fsTag: a ? N.clean(a.assetTag) : '',
      fsAssetType: a ? N.clean(a.assetType) : '',
      fsPrinterType: a ? N.clean(a.printerType) : ''
    };

    /* What this model should be called, and whether this record differs. The
       comparison ignores case and punctuation so a capital letter is not
       reported as an inconsistency; the proposed value keeps the majority
       spelling exactly. */
    var mk = modelKey(model);
    row.productShould = (house && house[mk]) || stripMake(d ? d.model : '');
    row.productDiffers = !!(a && row.productShould &&
      modelKey(row.fsProduct) === mk && N.clean(row.fsProduct) !== row.productShould);
    if (!row.productDiffers && a && row.productShould &&
        modelKey(row.fsProduct) !== mk) {
      // Different model recorded altogether, not just spelt differently.
      row.productDiffers = true;
    }
    if (!row.productDiffers) row.productShould = N.clean(row.fsProduct) || row.productShould;

    row.pages = (row.mono || 0) + (row.colour || 0);
    row.reporting = !!(row.lastSeen && U.daysSince(row.lastSeen) !== null &&
                       U.daysSince(row.lastSeen) <= cfg.staleDays);
    row.tagShared = row.fsTag ? (tagCount[tagKey(row.fsTag)] || 0) : 0;
    row.status = d && a ? 'matched' : (d ? 'onestop-only' : 'fs-only');

    /* Which location to believe is a setting, because neither side is reliably
       right: OneStop names the campus where Freshservice names the building,
       and Freshservice occasionally names a department instead of a place. */
    var preferred = cfg.locationSource === 'onestop'
      ? (stripCompany(row.siteName) || row.fsLocation)
      : (row.fsLocation || stripCompany(row.siteName));
    row.location = preferred;
    row.locationKey = N.locationKey(preferred);

    /* Resolve each side on its own as well as the preferred one: only when
       both land on a site, and on different sites, is there a real
       disagreement about where the printer is. */
    row.fsSite = findSite(row.fsLocation);
    row.osSite = findSite(stripCompany(row.siteName));

    var site = findSite(preferred) || row.fsSite || row.osSite || null;
    if (!site) {
      // A postcode that belongs to exactly one site can settle it; one that
      // covers a campus cannot, so it is left unresolved rather than guessed.
      var pl = byPostcode[postKey(row.postcode)] || [];
      if (pl.length === 1) site = pl[0];
      else if (pl.length > 1) row.postcodeAmbiguous = pl.length;
    }
    row.site = site;
    row.siteCode = site ? site.code : '';
    row.siteResolved = site ? site.name : '';
    return row;
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

  global.Printers = {
    DEFAULTS: DEFAULTS,
    RULES: RULES,
    RULE_BY_CODE: RULE_BY_CODE,
    SEVERITY_ORDER: SEVERITY_ORDER,
    settings: settings,
    isEnabled: isEnabled,
    reconcile: reconcile,
    apply: apply,
    stripMake: stripMake,
    modelKey: modelKey,
    stripCompany: stripCompany,
    usable: usable,
    siteKeys: siteKeys
  };
})(window);
