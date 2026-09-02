/* Normalisation used for matching records across the two systems.

   The two exports rarely agree on formatting: Freshservice tends to hold a
   person's display name, Intune a UPN; device names may or may not carry a
   domain suffix; locations may be a full hierarchy path. Everything is
   compared through these functions rather than raw strings. */
(function (global) {
  'use strict';

  var BLANKS = ['', '-', '--', 'n/a', 'na', 'none', 'null', 'unknown', 'not set', 'not assigned', 'unassigned', 'tbc', 'tbd', 'blank', '#n/a'];

  function isBlank(v) {
    if (v === null || v === undefined) return true;
    return BLANKS.indexOf(String(v).trim().toLowerCase()) >= 0;
  }

  function clean(v) { return isBlank(v) ? '' : String(v).trim(); }

  /* -------------------------------------------------------- device names */

  function deviceName(v) {
    var s = clean(v);
    if (!s) return '';
    s = s.replace(/^\\\\/, '');                    // \\HOSTNAME
    s = s.split(/[\\\/]/)[0];                      // DOMAIN\HOST
    s = s.replace(/\.(local|internal|lan|corp|ad|net|com|co\.uk|onmicrosoft\.com)$/i, '');
    s = s.split('.')[0];                           // any remaining FQDN tail
    return s.toUpperCase().replace(/\s+/g, '');
  }

  /* --------------------------------------------------------- serials */

  function serial(v) {
    var s = clean(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Placeholder serials that several manufacturers ship; never match on these.
    if (!s || s.length < 4) return '';
    if (/^(0+|X+|N\/?A|DEFAULTSTRING|SYSTEMSERIALNUMBER|TOBEFILLEDBYOEM.*|NONE|NOTSPECIFIED|NOTAPPLICABLE|INVALID)$/.test(s)) return '';
    if (/^0+$/.test(s)) return '';
    return s;
  }

  /* --------------------------------------------------------- people */

  var TITLES = ['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir'];

  /* Reduce a person reference (display name, "Surname, First", or an email /
     UPN) to comparable tokens. */
  function personTokens(v) {
    var s = clean(v);
    if (!s) return [];
    if (s.indexOf('@') >= 0) s = s.split('@')[0];
    s = dropAccountSuffix(s);
    s = s.replace(/[._\-]+/g, ' ');
    if (s.indexOf(',') >= 0) {                     // "Smith, John" -> "John Smith"
      var parts = s.split(',');
      s = parts.slice(1).join(' ') + ' ' + parts[0];
    }
    s = s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    var toks = s.split(' ').filter(function (t) {
      return t && TITLES.indexOf(t) < 0;
    });
    // Drop trailing service/account qualifiers that only one system carries.
    toks = toks.filter(function (t) { return ['admin', 'account', 'user', 'test'].indexOf(t) < 0 || toks.length <= 1; });
    return toks;
  }

  function personKey(v) {
    return personTokens(v).slice().sort().join(' ');
  }

  /* Windows caps a local account name at 20 characters, so an Entra-joined
     machine turns a long UPN into a truncated name plus a short uniqueness
     suffix: patience.osemwegie@... arrives as PatienceOsem_yb1wybb.

     The suffix has to be told apart from a legitimate underscore-separated
     name like john_smith. Two things distinguish it: it is random, so it
     almost always carries a digit, and the whole string lands on the 20
     character cap. Requiring one of those leaves real names alone - the cost
     of missing an all-letter suffix is a name that fails to match, which is
     recoverable; wrongly stripping "smith" off "john_smith" is not. */
  function dropAccountSuffix(s) {
    var m = /^([A-Za-z0-9]{4,})_([A-Za-z0-9]{3,})$/.exec(String(s).trim());
    if (!m) return s;
    var looksRandom = /\d/.test(m[2]);
    var atTheCap = s.length === 20;
    return (looksRandom || atTheCap) ? m[1] : s;
  }

  function stripAccountSuffix(token) { return dropAccountSuffix(token); }

  /* Is `stem` a truncation of this person's name? Requires the whole forename
     to be present, so "patienceosem" matches "Patience Osemwegie" while a
     short common prefix does not match half the organisation. */
  function truncationOf(stem, tokens) {
    if (!stem || tokens.length < 2) return false;
    var full = tokens.join('');
    if (stem.length < 6 || stem.length >= full.length) return false;
    if (full.indexOf(stem) !== 0) return false;
    return stem.length >= tokens[0].length;
  }

  /* Compare two person references.
     -> 'match' | 'mismatch' | 'partial' | 'unknown' */
  function comparePeople(a, b) {
    var ta = personTokens(a), tb = personTokens(b);
    if (!ta.length || !tb.length) return 'unknown';
    if (ta.slice().sort().join(' ') === tb.slice().sort().join(' ')) return 'match';

    var longTokensA = ta.filter(function (t) { return t.length > 1; });
    var longTokensB = tb.filter(function (t) { return t.length > 1; });

    // All the significant tokens of one appear in the other ("John Smith" vs
    // "John Andrew Smith").
    if (longTokensA.length && longTokensB.length) {
      var aInB = longTokensA.every(function (t) { return longTokensB.indexOf(t) >= 0; });
      var bInA = longTokensB.every(function (t) { return longTokensA.indexOf(t) >= 0; });
      if (aInB || bInA) return 'match';
    }

    // Account-name forms: "jsmith" / "smithj" / "john.s" against "John Smith".
    var single = ta.length === 1 ? ta[0] : tb.length === 1 ? tb[0] : null;
    var multi  = ta.length === 1 ? tb : tb.length === 1 ? ta : null;

    /* Two account names rather than an account name against a display name:
       "TomaszMensah" from the device against "tmensah" in the asset record.
       Same initial and same surname tail is the same person. */
    if (ta.length === 1 && tb.length === 1) {
      var x = ta[0], y = tb[0];
      var shortT = x.length <= y.length ? x : y;
      var longT = x.length <= y.length ? y : x;
      var tail = shortT.slice(1);
      if (shortT !== longT && tail.length >= 3 &&
          longT.charAt(0) === shortT.charAt(0) &&
          longT.slice(-tail.length) === tail) {
        return tail.length >= 4 ? 'match' : 'partial';
      }
    }

    // A Windows account name, whole or truncated, against a display name.
    if (single && multi && multi.length >= 2) {
      var stem = single;
      if (stem === multi.join('')) return 'match';
      if (truncationOf(stem, multi)) {
        // A long stem is conclusive; a short one is worth a human glance.
        return stem.length >= 10 ? 'match' : 'partial';
      }
    }

    if (single && multi && multi.length >= 2) {
      var first = multi[0], last = multi[multi.length - 1];
      var forms = [
        first[0] + last, last + first[0], first + last[0], last[0] + first,
        first + last, last + first, first.slice(0, 3) + last, last
      ];
      if (forms.indexOf(single) >= 0) return 'match';
      if (single.indexOf(last) >= 0 || last.indexOf(single) >= 0) return 'partial';
    }

    // A shared surname but a different forename is worth flagging softly - it
    // is usually a genuine reassignment within a family-name collision.
    if (longTokensA.length && longTokensB.length &&
        longTokensA[longTokensA.length - 1] === longTokensB[longTokensB.length - 1]) {
      return 'partial';
    }
    return 'mismatch';
  }

  /* Pick the friendliest available rendering of a person. */
  function personDisplay() {
    for (var i = 0; i < arguments.length; i++) {
      var v = clean(arguments[i]);
      if (v && v.indexOf('@') < 0) return v;
    }
    for (var j = 0; j < arguments.length; j++) {
      var w = clean(arguments[j]);
      if (w) return w;
    }
    return '';
  }

  /* The addressable form of a person - the opposite preference to
     personDisplay, which deliberately avoids the email. Systems match people
     on an address far more reliably than on a display name, so this is what
     goes into an import. */
  function personEmail() {
    for (var i = 0; i < arguments.length; i++) {
      var v = clean(arguments[i]);
      if (v && v.indexOf('@') > 0) return v;
    }
    return '';
  }

  /* ------------------------------------------------------- locations */

  var SEPARATORS = /\s*(?:>|»|\/|\\|\||::)\s*/;

  /* strategy: 'leaf' (default), 'full', 'root' */
  function location(v, strategy) {
    var s = clean(v);
    if (!s) return '';
    if (strategy === 'full') return s.replace(/\s+/g, ' ').trim();
    var parts = s.split(SEPARATORS).filter(function (p) { return p.trim(); });
    if (!parts.length) return '';
    var pick = strategy === 'root' ? parts[0] : parts[parts.length - 1];
    return pick.replace(/\s+/g, ' ').trim();
  }

  function locationKey(v, strategy) {
    return location(v, strategy).toLowerCase()
      .replace(/\b(care\s*home|care\s*centre|care\s*center|the)\b/g, '')
      .replace(/[^a-z0-9]+/g, '')
      .trim();
  }

  /* --------------------------------------------------------- values */

  function text(v) { return clean(v).toLowerCase().replace(/\s+/g, ' '); }

  /* Loose equality for descriptive values (model, OS) where the two systems
     word the same thing differently. */
  function looseEqual(a, b) {
    var x = text(a).replace(/[^a-z0-9]/g, '');
    var y = text(b).replace(/[^a-z0-9]/g, '');
    if (!x || !y) return true;                      // nothing to disagree about
    if (x === y) return true;
    return x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
  }

  /* Is this Freshservice asset state one that implies the device should be
     out in a service and running? */
  function isActiveState(state) {
    var s = text(state);
    if (!s) return null;
    if (/in use|deployed|assigned|active|live/.test(s)) return true;
    if (/stock|store|spare|retired|disposed|scrap|lost|stolen|missing|repair|returned|decommission|end of life|written off/.test(s)) return false;
    return null;
  }

  function isRetiredState(state) {
    return /retired|disposed|scrap|written off|end of life|decommission|lost|stolen/.test(text(state));
  }

  global.Norm = {
    isBlank: isBlank,
    clean: clean,
    deviceName: deviceName,
    serial: serial,
    personTokens: personTokens,
    personKey: personKey,
    comparePeople: comparePeople,
    stripAccountSuffix: stripAccountSuffix,
    personDisplay: personDisplay,
    personEmail: personEmail,
    location: location,
    locationKey: locationKey,
    text: text,
    looseEqual: looseEqual,
    isActiveState: isActiveState,
    isRetiredState: isRetiredState
  };
})(window);
