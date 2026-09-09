/* Phone numbers, normalised so two systems can be compared on them.

   SOTI reports a handset's number in strict E.164 — "+447821680115", every
   row the same. Entra's mobile field is free text maintained for email
   signatures, so the same number arrives as "07821 680115", and sometimes
   with a note, an extension, a second number, or the leading zero eaten by a
   spreadsheet on the way out.

   Everything is reduced to E.164 and compared on that. A number that cannot
   be read as a valid UK number is returned as nothing rather than guessed at:
   an unmatched handset is a small problem, and a handset matched to the wrong
   member of staff is a bigger one. */
(function (global) {
  'use strict';

  /* Several numbers in one field, which people do when they have two. */
  var SPLIT = /\s*(?:[\/,;]|\bor\b|\band\b|\n)\s*/i;

  /* "07821 680115 ext 204", "x204" on the end. Cut before the digits are
     pulled out, or the extension joins the number and nothing matches. */
  var EXTENSION = /\b(?:ext|extn|extension|x)\.?\s*\d{1,6}\s*$/i;

  /* Words that mean "no number" and would otherwise contribute stray digits. */
  var NOTHING = /^(?:n\/?a|none|nil|tbc|tba|unknown|-+|\.+|0)$/i;

  function clean(v) {
    return String(v === undefined || v === null ? '' : v).trim();
  }

  /* One candidate string -> E.164, or '' if it is not a number we can trust.

     UK rules only, deliberately. The estate is England and Wales, so a local
     format can be resolved with confidence; anything that is neither an
     explicit international number nor a UK local one is left alone rather
     than prefixed with a country code on a hunch. */
  function one(raw) {
    var s = clean(raw).replace(EXTENSION, '').trim();
    if (!s || NOTHING.test(s)) return '';

    var explicit = /^\s*(?:\+|00)/.test(s);
    var d = s.replace(/\D/g, '');
    if (!d) return '';

    if (explicit) {
      // 00 44 ... and + 44 ... both arrive here as digits only.
      if (d.indexOf('00') === 0) d = d.slice(2);
      return plausible('+' + d) ? '+' + d : '';
    }

    // 44 7821 680115 written without its plus.
    if (d.indexOf('44') === 0 && (d.length === 12 || d.length === 13)) {
      return plausible('+' + d) ? '+' + d : '';
    }
    // A UK local number: 07821 680115, 0121 123 4567.
    if (d.charAt(0) === '0' && (d.length === 11 || d.length === 10)) {
      return plausible('+44' + d.slice(1)) ? '+44' + d.slice(1) : '';
    }
    /* Ten digits and no leading zero is almost always a spreadsheet having
       eaten it — 07821680115 saved as a number comes back as 7821680115.
       Only accept the leading digits a UK number can actually start with. */
    if (d.length === 10 && /^[1-9]/.test(d)) {
      return plausible('+44' + d) ? '+44' + d : '';
    }
    return '';
  }

  /* Long enough to be a real number, short enough not to be two run
     together. UK national numbers are nine or ten digits after the country
     code — and a mobile is always ten, so "07821 68011" is a typo rather than
     a short landline. Getting that wrong would let a mistyped number match. */
  function plausible(e164) {
    if (!/^\+\d{8,15}$/.test(e164)) return false;
    if (e164.indexOf('+44') === 0) {
      var nat = e164.slice(3);
      if (nat.length < 9 || nat.length > 10) return false;
      if (nat.charAt(0) === '0') return false;      // no national trunk zero after +44
      if (nat.charAt(0) === '7' && nat.length !== 10) return false;
    }
    return true;
  }

  /* Every number a free-text field holds, in the order written. */
  function candidates(v) {
    var out = [], seen = {};
    clean(v).split(SPLIT).forEach(function (part) {
      var e = one(part);
      if (e && !seen[e]) { seen[e] = true; out.push(e); }
    });
    return out;
  }

  /* The first readable number, which is what a single-value field means. */
  function normalise(v) {
    var list = candidates(v);
    return list.length ? list[0] : '';
  }

  /* A UK mobile: +44 7xxx xxxxxx. Worth testing separately, because a
     landline typed into somebody's mobile field can never be a handset and
     comparing it can only produce a wrong answer. */
  function isMobile(e164) {
    return /^\+447[1-9]\d{8}$/.test(clean(e164));
  }

  function isUk(e164) { return clean(e164).indexOf('+44') === 0; }

  /* Back to the way a person writes it, for display: 07821 680115.

     Only mobiles are grouped. Landline grouping depends on the length of the
     area code, and inventing one would print 0121 numbers as "01211 234567" —
     wrong in a way that looks deliberate. */
  function national(e164) {
    var s = clean(e164);
    if (!isUk(s)) return s;
    var nat = '0' + s.slice(3);
    return isMobile(s) ? nat.slice(0, 5) + ' ' + nat.slice(5) : nat;
  }

  /* The match key: only ever a mobile, because only a mobile can be a
     handset. Everything else keys on nothing and therefore matches nothing. */
  function mobileKey(v) {
    var list = candidates(v).filter(isMobile);
    return list.length ? list[0] : '';
  }

  /* Every mobile in the field, for a person who has two recorded. */
  function mobileKeys(v) { return candidates(v).filter(isMobile); }

  global.Phone = {
    normalise: normalise,
    candidates: candidates,
    plausible: plausible,
    isMobile: isMobile,
    isUk: isUk,
    national: national,
    mobileKey: mobileKey,
    mobileKeys: mobileKeys
  };
})(window);
