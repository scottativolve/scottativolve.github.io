/* Inline-SVG charts. No chart library: two forms are all this tool needs, and
   hand-rolling them keeps the page dependency-free and theme-aware.

   Specs follow the house data-viz rules - bars capped at 24px with a 4px
   rounded data-end squared off at the baseline, hairline solid axes, one hue
   per single-series chart, values direct-labelled at the tip, and a table
   twin behind a toggle so no value is reachable only by hover. */
(function (global) {
  'use strict';

  var U = global.U;
  var SVGNS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  /* A rectangle with only its data-end rounded. Horizontal bars round the
     right edge; the baseline edge stays square. */
  function barPath(x, y, w, h, r, dir) {
    r = Math.max(0, Math.min(r, h / 2, Math.abs(w)));
    if (Math.abs(w) < 0.5) return 'M' + x + ',' + y + 'h0';
    if (dir === 'left') {
      var xe = x - w;
      return 'M' + x + ',' + y +
             'H' + (xe + r) + 'a' + r + ',' + r + ' 0 0 0 ' + (-r) + ',' + r +
             'V' + (y + h - r) + 'a' + r + ',' + r + ' 0 0 0 ' + r + ',' + r +
             'H' + x + 'Z';
    }
    return 'M' + x + ',' + y +
           'H' + (x + w - r) + 'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
           'V' + (y + h - r) + 'a' + r + ',' + r + ' 0 0 1 ' + (-r) + ',' + r +
           'H' + x + 'Z';
  }

  function measureText(text, size, weight) {
    // Rough advance-width estimate; good enough to decide whether a label fits.
    return String(text).length * size * (weight >= 600 ? 0.58 : 0.53);
  }

  function shell(container, opts) {
    U.clear(container);
    var wrap = U.el('div');
    container.appendChild(wrap);
    return wrap;
  }

  function tableTwin(rows, headers) {
    var t = U.el('table', { class: 'grid', style: { fontSize: '12px' } });
    var thead = U.el('thead');
    var tr = U.el('tr');
    headers.forEach(function (h, i) { tr.appendChild(U.el('th', { class: 'nosort' }, h)); });
    thead.appendChild(tr);
    t.appendChild(thead);
    var tb = U.el('tbody');
    rows.forEach(function (r) {
      var row = U.el('tr');
      r.forEach(function (c, i) {
        row.appendChild(U.el('td', { class: i > 0 ? 'num' : '' }, c));
      });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    return t;
  }

  /* The table twin sits behind a toggle placed *below* the plot: anchoring it
     over the chart would cover the first bar's value label. */
  function addToggle(container, svgNode, tableNode) {
    var showing = 'chart';
    var btn = U.el('button', {
      class: 'btn sm ghost no-print',
      onclick: function () {
        showing = showing === 'chart' ? 'table' : 'chart';
        svgNode.style.display = showing === 'chart' ? '' : 'none';
        tableNode.style.display = showing === 'table' ? '' : 'none';
        btn.textContent = showing === 'chart' ? 'Show as table' : 'Show as chart';
      }
    }, 'Show as table');
    tableNode.style.display = 'none';
    container.appendChild(U.el('div', {
      class: 'no-print',
      style: { display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }
    }, btn));
  }

  /* Swatch + label rows. Present whenever colour carries meaning, so identity
     never rests on hue alone. */
  function legendRow(items) {
    return U.el('div', {
      class: 'row tight',
      style: { marginBottom: '10px', fontSize: '11.5px', color: 'var(--text-secondary)' }
    }, items.map(function (it) {
      return U.el('span', { class: 'row tight', style: { gap: '5px' } }, [
        U.el('span', {
          style: {
            width: '10px', height: '10px', borderRadius: '2px',
            background: it.color, display: 'inline-block', flex: 'none'
          }
        }),
        it.label
      ]);
    }));
  }

  /* ------------------------------------------------------- ranked bars */

  /* data: [{ label, value, sub, onClick }] - one series, one colour. */
  function barChart(container, data, opts) {
    opts = opts || {};
    var wrap = shell(container);
    if (!data.length) {
      wrap.appendChild(U.el('div', { class: 'empty' }, opts.emptyText || 'Nothing to show.'));
      return;
    }
    if (opts.legend) wrap.appendChild(legendRow(opts.legend));

    var width = Math.max(320, container.clientWidth || 560);
    var barH = Math.min(24, opts.barHeight || 18);
    var band = barH + 8;                       // >= 2px surface gap between bars
    var padT = 4, padB = 4;
    var labelW = Math.min(opts.labelWidth || 190, Math.round(width * 0.42));
    var valueW = 54;
    var plotW = Math.max(60, width - labelW - valueW - 12);
    var height = padT + padB + data.length * band;

    var max = Math.max.apply(null, data.map(function (d) { return Math.abs(d.value); }));
    if (!max) max = 1;

    var svg = svgEl('svg', {
      class: 'chart', width: '100%', height: height,
      viewBox: '0 0 ' + width + ' ' + height, role: 'img',
      'aria-label': opts.ariaLabel || 'Bar chart'
    });

    data.forEach(function (d, i) {
      var y = padT + i * band;
      var w = (Math.abs(d.value) / max) * plotW;

      var label = svgEl('text', { x: labelW - 8, y: y + barH / 2 + 4, 'text-anchor': 'end' });
      label.textContent = U.truncate(d.label, Math.floor(labelW / 6.4));
      svg.appendChild(label);

      var bar = svgEl('path', {
        d: barPath(labelW, y, w, barH, 4, 'right'),
        fill: d.color || 'var(--series-1)',
        class: 'bar'
      });
      svg.appendChild(bar);

      var val = svgEl('text', {
        x: labelW + w + 7, y: y + barH / 2 + 4, class: 'value'
      });
      val.textContent = opts.format ? opts.format(d.value) : U.num(d.value);
      svg.appendChild(val);

      // Hit area spans the whole band so the target clears 24px.
      var hit = svgEl('rect', {
        x: 0, y: y - 4, width: width, height: band, class: 'hit'
      });
      hit.addEventListener('mousemove', function (ev) {
        bar.classList.add('hot');
        U.tooltip(
          '<div class="tt-title">' + U.escapeHtml(d.label) + '</div>' +
          '<div class="tt-row">' + U.escapeHtml(opts.valueLabel || 'Devices') + ': ' +
          (opts.format ? opts.format(d.value) : U.num(d.value)) + '</div>' +
          (d.sub ? '<div class="tt-row">' + U.escapeHtml(d.sub) + '</div>' : ''),
          ev.clientX, ev.clientY
        );
      });
      hit.addEventListener('mouseleave', function () { bar.classList.remove('hot'); U.tooltip(null); });
      if (d.onClick) {
        hit.style.cursor = 'pointer';
        hit.addEventListener('click', function () { U.tooltip(null); d.onClick(d); });
      }
      svg.appendChild(hit);
    });

    wrap.appendChild(svg);
    var twin = tableTwin(
      data.map(function (d) { return [d.label, opts.format ? opts.format(d.value) : U.num(d.value)]; }),
      [opts.categoryLabel || 'Item', opts.valueLabel || 'Devices']
    );
    wrap.appendChild(twin);
    addToggle(container, svg, twin);
  }

  /* ---------------------------------------------------- diverging bars */

  /* Signed values around a neutral zero line: two poles that read as opposite
     (red above expectation, blue below), grey axis as the "nothing" midpoint. */
  function divergingBarChart(container, data, opts) {
    opts = opts || {};
    var wrap = shell(container);
    if (!data.length) {
      wrap.appendChild(U.el('div', { class: 'empty' }, opts.emptyText || 'Nothing to show.'));
      return;
    }

    var width = Math.max(320, container.clientWidth || 560);
    var barH = Math.min(24, opts.barHeight || 18);
    var band = barH + 8;
    var padT = 18, padB = 4;
    var labelW = Math.min(opts.labelWidth || 170, Math.round(width * 0.38));
    var valueW = 44;
    var plotW = Math.max(80, width - labelW - valueW - 16);
    var mid = labelW + plotW / 2;
    var height = padT + padB + data.length * band;

    var max = Math.max.apply(null, data.map(function (d) { return Math.abs(d.value); })) || 1;
    var half = plotW / 2;

    var svg = svgEl('svg', {
      class: 'chart', width: '100%', height: height,
      viewBox: '0 0 ' + width + ' ' + height, role: 'img',
      'aria-label': opts.ariaLabel || 'Variance chart'
    });

    // Neutral midpoint rule.
    var axis = svgEl('line', { x1: mid, y1: padT - 6, x2: mid, y2: height - padB, class: 'axis-line' });
    svg.appendChild(axis);

    var capLeft = svgEl('text', { x: mid - 6, y: padT - 9, 'text-anchor': 'end', class: 'tick' });
    capLeft.textContent = opts.negLabel || 'fewer than expected';
    svg.appendChild(capLeft);
    var capRight = svgEl('text', { x: mid + 6, y: padT - 9, class: 'tick' });
    capRight.textContent = opts.posLabel || 'more than expected';
    svg.appendChild(capRight);

    data.forEach(function (d, i) {
      var y = padT + i * band;
      var w = (Math.abs(d.value) / max) * half;
      var positive = d.value >= 0;

      var label = svgEl('text', { x: labelW - 8, y: y + barH / 2 + 4, 'text-anchor': 'end' });
      label.textContent = U.truncate(d.label, Math.floor(labelW / 6.4));
      svg.appendChild(label);

      var bar = svgEl('path', {
        d: positive ? barPath(mid, y, w, barH, 4, 'right') : barPath(mid, y, w, barH, 4, 'left'),
        fill: positive ? 'var(--div-pos-strong)' : 'var(--div-neg-strong)',
        class: 'bar'
      });
      svg.appendChild(bar);

      var vx = positive ? mid + w + 6 : mid - w - 6;
      var val = svgEl('text', {
        x: vx, y: y + barH / 2 + 4, class: 'value',
        'text-anchor': positive ? 'start' : 'end'
      });
      val.textContent = (d.value > 0 ? '+' : '') + U.num(d.value);
      svg.appendChild(val);

      var hit = svgEl('rect', { x: 0, y: y - 4, width: width, height: band, class: 'hit' });
      hit.addEventListener('mousemove', function (ev) {
        bar.classList.add('hot');
        U.tooltip(
          '<div class="tt-title">' + U.escapeHtml(d.label) + '</div>' +
          '<div class="tt-row">' + U.escapeHtml(d.sub || '') + '</div>',
          ev.clientX, ev.clientY
        );
      });
      hit.addEventListener('mouseleave', function () { bar.classList.remove('hot'); U.tooltip(null); });
      if (d.onClick) {
        hit.style.cursor = 'pointer';
        hit.addEventListener('click', function () { U.tooltip(null); d.onClick(d); });
      }
      svg.appendChild(hit);
    });

    wrap.appendChild(svg);
    var twin = tableTwin(
      data.map(function (d) { return [d.label, (d.value > 0 ? '+' : '') + U.num(d.value), d.sub || '']; }),
      [opts.categoryLabel || 'Site', 'Variance', 'Detail']
    );
    wrap.appendChild(twin);
    addToggle(container, svg, twin);
  }

  /* --------------------------------------------------------- stat tiles */

  function tile(label, value, foot, onClick) {
    return U.el('div', {
      class: 'tile' + (onClick ? ' clickable' : ''),
      onclick: onClick || null,
      role: onClick ? 'button' : null,
      tabindex: onClick ? '0' : null,
      onkeydown: onClick ? function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : null
    }, [
      U.el('div', { class: 'label' }, label),
      U.el('div', { class: 'value' }, typeof value === 'number' ? U.num(value) : value),
      foot ? U.el('div', { class: 'foot' }, foot) : null
    ]);
  }

  global.Charts = { barChart: barChart, divergingBarChart: divergingBarChart, tile: tile };
})(window);
