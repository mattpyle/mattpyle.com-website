// The Steward console's findings page: the client over GET /api/findings and POST /api/verdict.
// Built from the approved findings mock (round three, mock 4 "Focus c"). No framework and no build step.
//
// The top half is pure: it turns the model and a state object into HTML strings, and the tests run it in a
// Node vm. The bottom half places that HTML in the page and wires the clicks. Every value from the model is
// escaped here except `body` and `sections[].html`, which the server renders as safe HTML.
(function () {
  'use strict';

  // ---------- Words and symbols ----------

  // The lifecycle, in order. Reopened shows only when a finding has it.
  const STATUSES = ['proposed', 'reopened', 'approved', 'fixing', 'resolved', 'rejected'];
  const WORD = { proposed: 'Proposed', reopened: 'Reopened', approved: 'Approved', fixing: 'Fixing', resolved: 'Resolved', rejected: 'Rejected' };
  const PRI = { high: 'High', medium: 'Medium', low: 'Low' };
  const LEVELS = ['high', 'medium', 'low'];
  const KIND = { defect: 'Defect', opportunity: 'Opportunity', direction: 'Direction' };
  const TYPE = { accessibility: 'Accessibility', 'agent-readiness': 'Agent readiness', content: 'Content', seo: 'SEO', security: 'Security', ux: 'UX', feature: 'Feature' };
  // The sites the console knows: the name on the page, the mark the console serves, and whether an approval
  // starts a fix (mattpyle.com) or only records the verdict (temporal.io stops at the verdict).
  const SITES = {
    'mattpyle-com': { name: 'mattpyle.com', icon: '/icons/mattpyle-com-16.png', fixes: true },
    'temporal-io': { name: 'temporal.io', icon: '/icons/temporal-io.svg', fixes: false },
  };
  const SORTS = { priority: 'Priority', oldest: 'Oldest first', newest: 'Newest first' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Only the next-step sentence uses this: the CLI writes it with markdown backticks, and the foot shows plain text.
  const plain = (s) => String(s ?? '').replace(/`/g, '');
  const siteName = (site) => (SITES[site] ? SITES[site].name : site);
  const idOf = (row) => `${row.site}/${row.key}`;
  const prNum = (url) => (url ? String(url).replace(/\/+$/, '').split('/').pop() : null);
  const safeUrl = (url) => (/^https?:\/\//i.test(String(url ?? '')) ? esc(url) : null);

  // ---------- Dates, in the console's time zone ----------

  const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v));
  const runIso = (v) => {
    const m = String(v).match(/^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})Z$/); // run ids: 2026-10-23T0416Z
    return m ? `${m[1]}T${m[2]}:${m[3]}:00Z` : String(v);
  };
  const dayParts = (v) => String(v).split('-').map(Number);

  function clock(tz) {
    const fmt = (v, o) => new Date(runIso(v)).toLocaleString('en-GB', { ...o, timeZone: tz });
    const part = (v, o) => +fmt(v, o);
    // A bare day is a date with no time: shown as it is, never shifted by a zone.
    const day = (v) => {
      if (isDay(v)) { const [, m, d] = dayParts(v); return `${d} ${MONTHS[m - 1]}`; }
      return `${part(v, { day: 'numeric' })} ${MONTHS[part(v, { month: 'numeric' }) - 1]}`;
    };
    const time = (v) => new Date(runIso(v)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
    const full = (v) => (isDay(v)
      ? new Date(`${v}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
      : fmt(v, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
    const dayTime = (v) => (isDay(v) ? day(v) : `${day(v)}, ${time(v)}`);
    const today = (now) => new Date(now).toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
    // "2h", "3d", then the date past seven days. A bare day counts whole days.
    const age = (v, now) => {
      if (isDay(v)) {
        const [y, m, d] = dayParts(v);
        const [ty, tm, td] = dayParts(today(now));
        const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)) / 864e5);
        if (days <= 0) return 'today';
        return days <= 7 ? `${days}d` : day(v);
      }
      const mins = Math.max(0, Math.round((new Date(now) - new Date(runIso(v))) / 6e4));
      if (mins < 60) return `${Math.max(1, mins)}m`;
      const h = Math.floor(mins / 60);
      if (h < 24) return `${h}h`;
      const days = Math.floor(h / 24);
      return days <= 7 ? `${days}d` : day(v);
    };
    return { day, time, full, dayTime, age };
  }

  // ---------- The rows and the state ----------

  function rowsOf(model) {
    return (model && model.sites ? model.sites : []).flatMap((s) => s.rows.map((r) => ({ ...r, site: r.site || s.site })));
  }

  function createState() {
    return {
      status: 'proposed', site: 'all', pri: 'all', sort: 'priority', drift: false, q: '', menu: null,
      appMenu: false, // the header's menu
      restart: null, // null, 'restarting', or the sentence a failed restart left
      sync: null, // null, 'running', { text } or { error }: the last Sync findings
      ran: {}, // id -> { verb, workflowId, nextStep } or { verb, error }: Fix or Verify started from the page since it opened
      current: null, // the open row's id, site/key
      decided: {}, // id -> { status, reason, at, result }: verdicts sent from this page since the last load
      foot: { error: null, sending: false, reasonError: false },
    };
  }

  // What the page shows for a row: the short fields when Argus writes them, else the long ones.
  const shortTitle = (r) => r.titleShort || r.title || r.key;
  const refOf = (r) => r.keyShort || r.key;
  const statusOf = (r, state) => (state.decided[idOf(r)] ? state.decided[idOf(r)].status : r.status);

  function knownStatuses(rows) {
    const present = new Set(rows.map((r) => r.status));
    const extra = [...present].filter((s) => !STATUSES.includes(s)).sort();
    return [...STATUSES.filter((s) => s !== 'reopened' || present.has(s)), ...extra];
  }

  const inSite = (state) => (r) => state.site === 'all' || r.site === state.site;
  // The chosen tab applies whether or not the box holds text: a query searches within the status, and the All tab searches everything.
  const shownStatus = (state) => state.status;
  const inStatus = (state) => (r) => shownStatus(state) === 'all' || r.status === shownStatus(state);
  const inPri = (state) => (r) => state.pri === 'all' || r.priority === state.pri;
  const matchesQuery = (state) => {
    const q = state.q.trim().toLowerCase();
    return (r) => !q || `${refOf(r)} ${shortTitle(r)} ${r.title} ${r.key} ${siteName(r.site)}`.toLowerCase().includes(q);
  };
  // The Clear filters button shows while a query, a tab other than the default (Proposed), the drift chip, a site or a priority narrows the list.
  const filtering = (state) => !!state.q.trim() || state.status !== 'proposed' || state.drift || state.site !== 'all' || state.pri !== 'all';
  // What Clear filters sets: every control back to All, the query empty, and the drift chip's remembered tab forgotten so a later toggle cannot restore it.
  const clearedFilters = () => ({ site: 'all', pri: 'all', drift: false, statusBeforeDrift: null, status: 'all', q: '', menu: null });

  // A count moves with a verdict sent from this page; the list keeps the row where it was until the next load.
  // A tab's count reads how many rows it will show, so it follows the query as well as the site and priority.
  function count(rows, state, { site = inSite(state), status = (s) => shownStatus(state) === 'all' || s === shownStatus(state), pri = inPri(state), query = matchesQuery(state) } = {}) {
    return rows.filter((r) => site(r) && status(statusOf(r, state)) && pri(r) && query(r)).length;
  }

  const openedKey = (r) => `${r.opened || ''}|${String(r.index ?? 0).padStart(6, '0')}`;
  const PO = { high: 0, medium: 1, low: 2 };
  const priOrder = (r) => (r.priority in PO ? PO[r.priority] : 3);

  function visible(rows, state) {
    const out = rows.filter((r) => inSite(state)(r) && inStatus(state)(r) && inPri(state)(r) && (!state.drift || r.drift.length > 0) && matchesQuery(state)(r));
    const newest = (a, b) => (openedKey(b) > openedKey(a) ? 1 : openedKey(b) < openedKey(a) ? -1 : 0);
    if (state.sort === 'oldest') out.sort((a, b) => -newest(a, b));
    else if (state.sort === 'newest') out.sort(newest);
    else out.sort((a, b) => priOrder(a) - priOrder(b) || newest(a, b));
    return out;
  }

  // ---------- Symbols as HTML ----------

  const statusHTML = (s) => `<span class="status"><i class="dot" data-s="${esc(s)}"></i>${esc(WORD[s] || s)}</span>`;
  const priHTML = (p) => {
    if (!PRI[p]) return '';
    const n = { high: 3, medium: 2, low: 1 }[p];
    const bars = [0, 1, 2].map((i) => `<rect x="${i * 5}" y="${8 - i * 3}" width="3" height="${4 + i * 3}" rx="1" ${i < n ? '' : 'class="off"'}/>`).join('');
    return `<span class="pri" data-p="${p}"><svg class="pri-mark" width="13" height="12" viewBox="0 0 13 12" aria-hidden="true">${bars}</svg>${PRI[p]}</span>`;
  };
  const ICON = {
    accessibility: '<circle cx="8" cy="3.6" r="1.4"/><path d="M3.5 6.2l4.5 1 4.5-1M8 7.2v3.3M8 10.5l-2 3.5M8 10.5l2 3.5" fill="none"/>',
    content: '<path d="M4 2.5h5.5L12 5v8.5H4z M9.5 2.5V5H12 M6 8h4 M6 10.5h4" fill="none"/>',
    seo: '<circle cx="7" cy="7" r="4" fill="none"/><path d="M10 10l3.5 3.5" fill="none"/>',
    'agent-readiness': '<rect x="3" y="5" width="10" height="8" rx="2" fill="none"/><path d="M8 5V2.5" fill="none"/><circle cx="6" cy="9" r="0.9"/><circle cx="10" cy="9" r="0.9"/>',
    security: '<path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" fill="none"/>',
    ux: '<path d="M4 3l8 4.5-3.6.9L7 12z" fill="none"/>',
    feature: '<path d="M8 2.5v11M2.5 8h11" fill="none"/>',
  };
  const catHTML = (t) => (t ? `<span class="cat" data-t="${esc(t)}" title="${esc(TYPE[t] || t)}"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="currentColor">${ICON[t] || ICON.feature}</svg>${esc(TYPE[t] || t)}</span>` : '');
  // The list hides the label at narrow widths (`.lbl`); the facet menu and the panel header always show it.
  const siteHTML = (site, { alwaysShowLabel = false } = {}) => {
    const known = SITES[site];
    const mark = known ? `<img class="site-mark" src="${known.icon}" width="20" height="20" alt="">` : '';
    return `<span class="site" title="${esc(siteName(site))}">${mark}<span${alwaysShowLabel ? '' : ' class="lbl"'}>${esc(siteName(site))}</span></span>`;
  };
  const KIND_ICON = {
    defect: '<ellipse cx="8" cy="9.5" rx="3.6" ry="4.2" fill="none"/><path d="M8 5.3v8.4M4.4 9H2.5M13.5 9h-1.9M4.8 6.3L3 5M11.2 6.3L13 5M4.8 12.4L3 13.6M11.2 12.4l1.8 1.2M6.3 5.6a1.8 1.8 0 0 1 3.4 0" fill="none"/>',
    opportunity: '<path d="M5.6 10.4A4.3 4.3 0 1 1 10.4 10.4c-.6.5-.9 1-.9 1.7v.4h-3v-.4c0-.7-.3-1.2-.9-1.7z M6.5 14.5h3" fill="none"/>',
    direction: '<path d="M8 1.8v12.4M8 3.5h4.5l1.5 1.7-1.5 1.7H8M8 8.5H3.5L2 10.2l1.5 1.7H8" fill="none"/>',
  };
  const kindHTML = (k) => (k ? `<span class="kind" data-k="${esc(k)}" title="${esc(KIND[k] || k)}"><svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${KIND_ICON[k] || ''}</svg><span class="lbl">${esc(KIND[k] || k)}</span></span>` : '');
  const DRIFT_ICON = '<svg class="drift-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2l6.2 11H1.8z" fill="currentColor"/><path class="mark" d="M8 6.5v3" stroke-width="1.5" stroke-linecap="round"/><circle class="mark-dot" cx="8" cy="11.4" r="0.85"/></svg>';
  const driftTip = (r) => `Drift: ${r.drift.join('; ')}`;
  const driftHTML = (r) => (r.drift.length ? `<span class="drift" title="${esc(driftTip(r))}" aria-label="${esc(driftTip(r))}">${DRIFT_ICON}</span>` : '');
  const CHEV = '<svg class="chev" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const TICK = '<svg class="tick" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // A run's link in the Temporal Web UI, built from the two values the server gives the page and the workflow id.
  // Without them (a page opened some other way) the id shows as text.
  function runLinker(options) {
    const base = safeUrl(options.webUi);
    const ns = options.namespace;
    return (id) => {
      if (!base || !ns) return `<code>${esc(id)}</code>`;
      const href = `${String(options.webUi).replace(/\/+$/, '')}/namespaces/${encodeURIComponent(ns)}/workflows/${encodeURIComponent(id)}`;
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(id)}</a>`;
    };
  }

  // ---------- Signals the rows do not carry ----------

  // Per site: open runs with no INDEX.md line, and verify runs closed other than Completed in the last seven days.
  function siteSignals(model, state) {
    // `model` is null after a failed load; the page still paints its controls.
    const sites = ((model && model.sites) || []).filter((s) => state.site === 'all' || s.site === state.site);
    const failed = ((model && model.failedVerifies) || []).filter((f) => state.site === 'all' || f.site === state.site);
    return { orphans: sites.flatMap((s) => (s.orphanRuns || []).map((id) => ({ site: s.site, id }))), failed };
  }
  const signalCount = (model, state) => {
    const s = siteSignals(model, state);
    return s.orphans.length + s.failed.length;
  };

  function renderSignals(model, state, link, c) {
    const { orphans, failed } = siteSignals(model, state);
    if (!orphans.length && !failed.length) return '';
    const lines = [
      ...orphans.map((o) => `<li>${esc(siteName(o.site))}: open run with no INDEX.md line: ${link(o.id)}</li>`),
      ...failed.map((f) => `<li>${esc(siteName(f.site))}: verify run closed as ${esc(f.status)}${f.closeTime ? ` on ${esc(c.dayTime(f.closeTime))}` : ''}: ${link(f.workflowId)}</li>`),
    ];
    return `<div class="drift-box" role="note"><p class="drift-title">${DRIFT_ICON}Drift</p><ul class="drift-lines">${lines.join('')}</ul></div>`;
  }

  // ---------- The toolbar ----------

  // Site, priority, sort and (when narrow) status each fold into one chip that opens a short menu.
  function facetHTML(state, name, label, options, value, word) {
    const on = value !== 'all';
    const open = state.menu === name;
    return `<div class="facet${name === 'status' ? ' facet-status' : ''}" data-facet="${name}">
      <button class="facet-btn" type="button" aria-haspopup="menu" aria-expanded="${open}" data-on="${on}"${name === 'sort' ? ' title="Sort"' : ''}>${on ? word(value) : label}${CHEV}</button>
      ${open ? `<div class="menu" role="menu">${options.map(([v, text, n]) =>
        `<button class="menu-item" type="button" role="menuitemradio" aria-checked="${value === v || (name === 'sort' && state.sort === v)}" data-${name}="${esc(v)}">${text}<span class="count">${n}</span>${TICK}</button>`).join('')}</div>` : ''}
    </div>`;
  }

  function renderStatuses(rows, state) {
    return [...knownStatuses(rows), 'all'].map((s) => {
      const n = count(rows, state, { status: (x) => s === 'all' || x === s });
      return `<button class="stab" type="button" role="tab" data-status="${esc(s)}" aria-selected="${shownStatus(state) === s}">${s === 'all' ? 'All' : esc(WORD[s] || s)}<span class="count">${n}</span></button>`;
    }).join('');
  }

  function renderFacets(model, rows, state) {
    const sites = ((model && model.sites) || []).map((s) => s.site);
    const siteOpts = [['all', 'All sites', count(rows, state, { site: () => true })],
      ...sites.map((x) => [x, esc(siteName(x)), count(rows, state, { site: (r) => r.site === x })])];
    const priOpts = [['all', 'All priorities', count(rows, state, { pri: () => true })],
      ...LEVELS.map((p) => [p, priHTML(p), count(rows, state, { pri: (r) => r.priority === p })])];
    const sortOpts = Object.entries(SORTS).map(([v, w]) => [v, w, '']);
    const statusOpts = [...knownStatuses(rows), 'all'].map((x) => [x, x === 'all' ? 'All' : esc(WORD[x] || x), count(rows, state, { status: (y) => x === 'all' || y === x })]);
    const drifting = rows.filter((r) => r.drift.length > 0 && inSite(state)(r)).length + signalCount(model, state);
    const siteWord = (v) => siteHTML(v, { alwaysShowLabel: true });
    // First in the row: the open search box covers the right-hand end, and the row is anchored right, so a button added here grows leftward and moves nothing.
    const clear = filtering(state) ? '<button class="linkish clear-filters" type="button" data-act="clear">Clear filters</button>' : '';
    return clear + facetHTML(state, 'status', 'All', statusOpts, shownStatus(state), (v) => `${esc(WORD[v] || v)}<span class="count">${count(rows, state, { status: (y) => y === v })}</span>`)
      + (drifting ? `<button class="drift-chip" type="button" data-act="drift" aria-pressed="${state.drift}" title="Findings whose index, file and run disagree, and runs no finding accounts for">${DRIFT_ICON}Drift<span class="count">${drifting}</span></button>` : '')
      + facetHTML(state, 'site', 'Site', siteOpts, state.site, siteWord)
      + facetHTML(state, 'pri', 'Priority', priOpts, state.pri, priHTML)
      + facetHTML(state, 'sort', 'Sort', sortOpts, state.sort === 'priority' ? 'all' : state.sort, (v) => SORTS[v]);
  }

  // ---------- The list ----------

  function rowHTML(r, state, c, now) {
    const id = idOf(r);
    return `<li><button class="row cols" type="button" data-id="${esc(id)}" ${state.current === id ? 'aria-current="true"' : ''}>
      <span class="c-ref" title="${esc(r.key)}">${esc(refOf(r))}</span>
      <span class="c-title" title="${esc(r.title || r.key)}"><span class="t">${esc(shortTitle(r))}</span>${driftHTML(r)}</span>
      <span class="c-pri">${priHTML(r.priority)}</span>
      <span class="c-site">${siteHTML(r.site)}</span>
      <span class="c-cat">${catHTML(r.type)}</span>
      <span class="c-kind">${kindHTML(r.kind)}</span>
      <span class="c-status">${statusHTML(statusOf(r, state))}</span>
      <span class="c-age">${r.opened ? `<time datetime="${esc(r.opened)}" title="Opened ${esc(c.full(r.opened))}">${c.age(r.opened, now)}</time>` : ''}</span>
    </button></li>`;
  }

  // Sorted by priority, the list groups under High, Medium and Low with their counts. Sorted by age, it is one list.
  function renderList(rows, state, c, now) {
    const shown = visible(rows, state);
    if (!shown.length) {
      return '<div class="empty"><p>No findings match.</p><button class="linkish" type="button" data-act="clear">Clear filters</button></div>';
    }
    const row = (r) => rowHTML(r, state, c, now);
    if (state.sort !== 'priority') return `<ul class="list">${shown.map(row).join('')}</ul>`;
    const groups = LEVELS.map((p) => {
      const g = shown.filter((r) => r.priority === p);
      if (!g.length) return '';
      return `<section class="group"><h2 class="group-head">${priHTML(p)}<span class="count">${count(rows, state, { pri: (r) => r.priority === p })}</span></h2><ul class="list">${g.map(row).join('')}</ul></section>`;
    });
    const rest = shown.filter((r) => !LEVELS.includes(r.priority));
    if (rest.length) groups.push(`<section class="group"><ul class="list">${rest.map(row).join('')}</ul></section>`);
    return groups.join('');
  }

  // ---------- The finding ----------

  // The timeline lists events only, oldest first, each with its date. A verdict sent from this page joins it.
  function timeline(r, state) {
    const events = [...(r.events || [])];
    const d = state.decided[idOf(r)];
    if (d) events.push({ kind: 'verdict', at: d.at, label: d.status === 'rejected' ? 'Rejected' : 'Approved', detail: d.reason || undefined });
    return events;
  }

  function eventHTML(e, c, link) {
    let text;
    const url = safeUrl(e.url);
    if (e.kind === 'pr' && url) text = `PR <a href="${url}" target="_blank" rel="noopener noreferrer">#${esc(prNum(e.url))}</a> opened`;
    else text = `${esc(e.label)}${e.detail ? `: ${esc(e.detail)}` : ''}${e.workflowId ? ` (${link(e.workflowId)})` : ''}`;
    return `<li><span>${text}</span>${e.at ? `<time title="${esc(c.full(e.at))}">${esc(c.dayTime(e.at))}</time>` : '<span></span>'}</li>`;
  }

  const KEY_COPY = (key) => `<button class="key-copy" type="button" title="Click to copy" aria-label="Copy key ${esc(key)}"><span class="key">${esc(key)}</span><span class="copy-state" aria-hidden="true"><svg class="i-copy" width="16" height="16" viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg><svg class="i-done" width="16" height="16" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="copied-word">Copied</span></span></button><span class="sr-only" role="status" aria-live="polite"></span>`;

  function renderDoc(r, state, c, link) {
    const s = statusOf(r, state);
    const d = state.decided[idOf(r)];
    const facts = [
      ['Status', statusHTML(s)],
      r.priority ? ['Priority', priHTML(r.priority)] : null,
      ['Site', siteHTML(r.site)],
      r.type ? ['Type', catHTML(r.type)] : null,
      r.kind ? ['Kind', kindHTML(r.kind)] : null,
      r.opened ? ['Opened', `<time title="${esc(c.full(r.opened))}">${esc(c.dayTime(r.opened))}</time>`] : null,
    ];
    const verdictAt = d ? d.at : r.verdictAt;
    if (verdictAt) facts.push(['Verdict', `<time title="${esc(c.full(verdictAt))}">${esc(c.dayTime(verdictAt))}</time>`]);
    else if (s === 'proposed' || s === 'reopened') facts.push(['Verdict', 'Pending']);
    const pr = safeUrl(r.prUrl);
    if (pr) facts.push(['PR', `<a href="${pr}" target="_blank" rel="noopener noreferrer">#${esc(prNum(r.prUrl))}</a>`]);
    const reason = d ? d.reason : s === 'rejected' ? r.reason : '';
    if (reason) facts.push(['Reason', esc(reason)]);
    if (r.run && r.run.open) facts.push(['Run', link(`finding/${r.site}/${r.key}`)]);
    if (r.holdLine) facts.push(['Holding', esc(r.holdLine)]);
    facts.push(['Key', KEY_COPY(r.key)]);

    const summary = r.summary || (r.titleShort ? r.title : '');
    const heading = (h) => esc(String(h).replace(/^Seen again (\S+)$/, (_, run) => `Seen again on ${c.day(runIso(run))}`));
    return `
      <header class="doc-head">
        <p class="doc-ref">${siteHTML(r.site, { alwaysShowLabel: true })}<span class="sep" aria-hidden="true">/</span><span class="ref">${esc(refOf(r))}</span></p>
        <h2 class="doc-title">${esc(shortTitle(r))}</h2>
        ${summary ? `<p class="doc-summary">${esc(summary)}</p>` : ''}
      </header>
      ${r.drift.length ? `<div class="drift-box" role="note"><p class="drift-title">${DRIFT_ICON}Drift</p><ul class="drift-lines">${r.drift.map((x) => `<li>${esc(x)}${driftRemedy(r, x, state)}</li>`).join('')}</ul></div>` : ''}
      <dl class="facts">${facts.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${(r.sections || []).map((x) => `<section class="section"><h3>${heading(x.heading)}</h3><div class="prose">${x.html}</div></section>`).join('')}
      <section class="section"><h3>Timeline</h3><ol class="timeline">${timeline(r, state).map((e) => eventHTML(e, c, link)).join('')}</ol></section>`;
  }

  // ---------- The verbs run from the page ----------

  // The line "proposed with no open run" offers Sync, and "approved with no open run" offers Fix: the same buttons the menu and the foot hold.
  function driftRemedy(r, line, state) {
    if (line === 'proposed with no open run') {
      if (state.sync === 'running') return '<button class="btn" type="button" data-act="sync" disabled>Syncing</button>';
      const said = state.sync && (state.sync.error || state.sync.text);
      return said ? `<span class="drift-run" role="status">${esc(said)}</span>` : '<button class="btn" type="button" data-act="sync" title="Runs the findings reconcile now">Sync</button>';
    }
    const ran = state.ran[idOf(r)];
    if (line === 'approved with no open run' && r.actions && r.actions.fix && !(ran && ran.workflowId)) {
      return `<button class="btn" type="button" data-act="fix" title="Opens the fix issue and waits for its PR"${state.foot.sending ? ' disabled' : ''}>Fix</button>`;
    }
    return '';
  }

  // What Fix or Verify answered, in the foot: the run's id and what happens next, or the refusal.
  function ranHTML(ran, link) {
    if (!ran) return '';
    if (ran.error) return `<div class="result"><p class="reason-error" role="alert">${esc(ran.error)}</p></div>`;
    return `<div class="result" role="status"><p>${ran.verb === 'fix' ? 'Fix' : 'Verify'} started: ${link(ran.workflowId)}</p><p>${esc(plain(ran.nextStep))}</p></div>`;
  }

  // The next proposed finding after a verdict, in the list's order and within the chosen site.
  function nextProposed(rows, state, after) {
    const order = visible(rows, { ...state, status: 'proposed', pri: 'all', drift: false, q: '', sort: 'priority' });
    return order.find((r) => idOf(r) !== idOf(after) && !state.decided[idOf(r)]) || null;
  }

  // The foot holds the controls. After a verdict it shows what was recorded, the commit and the next step.
  function renderFoot(r, rows, state, link) {
    const s = statusOf(r, state);
    const d = state.decided[idOf(r)];
    const f = state.foot;
    if (d) {
      const res = d.result || {};
      const n = nextProposed(rows, state, r);
      const lines = [];
      if (res.recorded && res.recorded.source && res.recorded.source !== 'cli') lines.push('An earlier verdict in the file was recorded first, so nothing was written.');
      if (res.commitSha) lines.push(`Commit <code>${esc(res.commitSha)}</code>`);
      if (res.nextStepError) lines.push(`The next step is unknown: <code>steward finding status ${esc(r.key)}</code> shows it.`);
      if (res.nextStep) lines.push(esc(plain(res.nextStep)));
      return `${lines.length ? `<div class="result">${lines.map((l) => `<p>${l}</p>`).join('')}</div>` : ''}
        <div class="actions actions-split">
          <p class="next">${statusHTML(d.status)}</p>
          <span class="spacer"></span>
          ${n ? `<button class="btn btn-fill" type="button" data-act="next" data-id="${esc(idOf(n))}">Next</button>` : ''}
        </div>`;
    }
    if (s === 'proposed' || s === 'reopened') {
      const fixes = SITES[r.site] && SITES[r.site].fixes;
      const approveTip = fixes ? 'Steward starts a fix and opens a PR' : `Records your verdict; nothing is sent to ${siteName(r.site)}`;
      const message = f.reasonError ? 'Add a reason to reject.' : f.error || '';
      return `
        <div class="reason"${f.reasonError ? ' data-error' : ''}>
          <textarea id="reason" rows="2" placeholder="Reason" aria-label="Reason" title="Optional to approve, needed to reject" aria-describedby="reason-error"${f.reasonError ? ' aria-invalid="true"' : ''}></textarea>
          <p class="reason-error" id="reason-error"${message ? '' : ' hidden'}>${esc(message)}</p>
        </div>
        <div class="actions">
          <button class="btn" type="button" data-act="reject" title="Closes the finding with your reason"${f.sending ? ' disabled' : ''}>Reject</button>
          <button class="btn btn-fill" type="button" data-act="approve" title="${esc(approveTip)}"${f.sending ? ' disabled' : ''}>${fixes ? 'Approve and fix' : 'Approve'}</button>
        </div>`;
    }
    const pr = safeUrl(r.prUrl);
    const ran = state.ran[idOf(r)];
    const started = !!(ran && ran.workflowId);
    const can = r.actions || {};
    const busy = f.sending ? ' disabled' : '';
    const buttons = [
      (s === 'fixing' || s === 'resolved') && pr ? `<a class="btn" href="${pr}" target="_blank" rel="noopener noreferrer">Open PR #${esc(prNum(r.prUrl))}</a>` : '',
      !started && s === 'approved' && can.fix ? `<button class="btn btn-fill" type="button" data-act="fix" title="Opens the fix issue and waits for its PR"${busy}>Fix</button>` : '',
      !started && s === 'fixing' && can.verify ? `<button class="btn btn-fill" type="button" data-act="verify" title="Measures the finding's checks on production"${busy}>Verify</button>` : '',
    ].filter(Boolean);
    const note = ranHTML(ran, link || ((id) => `<code>${esc(id)}</code>`));
    return buttons.length || note ? `${note}${buttons.length ? `<div class="actions">${buttons.join('')}</div>` : ''}` : '';
  }

  // ---------- The header menu: the running commit and a restart ----------

  // Empty while the menu is closed. The restart never pulls, so the note shows only when master has moved on.
  function menuHtml(model, state) {
    if (!state.appMenu) return '';
    const commit = model && model.commit ? model.commit : 'unknown';
    const note = model && model.behindMaster ? '<p class="menu-note">master has moved on. Restart does not pull: run <code>steward update</code> first.</p>' : '';
    const syncing = state.sync === 'running';
    const synced = state.sync && !syncing ? state.sync : null;
    const sync = `<button class="menu-item" type="button" role="menuitem" data-act="sync"${syncing ? ' disabled' : ''}><span>${syncing ? 'Syncing findings' : 'Sync findings'}</span></button>${synced ? `<p class="menu-note${synced.error ? ' menu-error' : ''}" role="${synced.error ? 'alert' : 'status'}">${esc(synced.error || synced.text)}</p>` : ''}`;
    const action = state.restart === 'restarting'
      ? '<p class="menu-note" role="status">Restarting</p>'
      : `${sync}<button class="menu-item" type="button" role="menuitem" data-act="restart"><span>Restart console</span></button>${state.restart ? `<p class="menu-note menu-error" role="alert">${esc(state.restart)}</p>` : ''}`;
    return `<div class="menu menu-app" role="menu"><p class="menu-note">Running commit <code>${esc(commit)}</code></p>${note}${action}</div>`;
  }

  // ---------- The whole view ----------

  function view(model, state, options) {
    const c = clock(options.timeZone);
    const now = options.now;
    const link = runLinker(options);
    const rows = rowsOf(model);
    const current = rows.find((r) => idOf(r) === state.current) || null;
    const foot = current ? renderFoot(current, rows, state, link) : '';
    return {
      sort: state.sort,
      ageSort: state.sort === 'oldest' ? 'ascending' : state.sort === 'newest' ? 'descending' : 'none',
      open: !!current,
      statuses: renderStatuses(rows, state),
      facets: renderFacets(model, rows, state),
      list: renderSignals(model, state, link, c) + renderList(rows, state, c, now),
      doc: current ? renderDoc(current, state, c, link) : '',
      foot,
      menu: menuHtml(model, state),
    };
  }

  // A load that failed leaves no open finding and no foot: a verdict never goes out against a model that did not load.
  function loadFailed(state) {
    state.current = null;
    state.foot = { error: null, sending: false, reasonError: false };
    return { open: false, doc: '', foot: '' };
  }

  const api = { STATUSES, SITES, rowsOf, createState, visible, clearedFilters, view, nextProposed, loadFailed, clock, esc, menuHtml };
  globalThis.StewardFindings = api;

  if (typeof document === 'undefined' || !document.querySelector('.app')) return;

  // ---------- The page ----------

  const $ = (sel) => document.querySelector(sel);
  const zone = document.documentElement.dataset.timeZone;
  const timeZone = zone && !zone.includes('{') ? zone : 'America/Vancouver';
  // The Web UI origin and namespace the server put on the page; absent, run ids show as text.
  const given = (v) => (v && !v.includes('{') ? v : '');
  const webUi = given(document.documentElement.dataset.webUi);
  const namespace = given(document.documentElement.dataset.namespace);
  const state = createState();
  let model = null;
  let token = '';

  const el = {
    statuses: $('.statuses'), facets: $('.facets'), groups: $('.groups'), doc: $('.doc'), foot: $('.foot'),
    search: $('.search'), input: $('.search input'), refresh: $('.refresh'), menuBtn: $('.menu-btn'), menuPop: $('.app-menu-pop'), age: $('[data-sort-by="age"]'),
  };

  function paint(parts) {
    const v = view(model, state, { timeZone, webUi, namespace, now: new Date() });
    document.body.dataset.sort = v.sort;
    document.body.classList.toggle('is-open', v.open);
    el.age.setAttribute('aria-sort', v.ageSort);
    if (parts.includes('controls')) { el.statuses.innerHTML = v.statuses; el.facets.innerHTML = v.facets; }
    if (parts.includes('list')) el.groups.innerHTML = v.list;
    if (parts.includes('doc')) { el.doc.innerHTML = v.doc; el.doc.scrollTop = 0; }
    if (parts.includes('menu')) { el.menuPop.innerHTML = v.menu; el.menuBtn.setAttribute('aria-expanded', String(state.appMenu)); }
    if (parts.includes('foot')) { el.foot.innerHTML = v.foot; el.foot.hidden = !v.foot; }
  }
  const render = () => paint(['controls', 'list']);

  // With a finding open the frame is pinned and the window cannot scroll, so closing returns the list to where it was.
  let listScroll = 0;
  function open(id) {
    if (!state.current) listScroll = window.scrollY;
    state.current = id;
    state.foot = { error: null, sending: false, reasonError: false };
    paint(['controls', 'list', 'doc', 'foot']);
  }
  function close() {
    state.current = null;
    paint(['list']);
    window.scrollTo(0, listScroll);
  }

  async function load() {
    el.refresh.setAttribute('aria-busy', 'true');
    el.refresh.disabled = true;
    try {
      const res = await fetch('/api/findings', { cache: 'no-store', headers: { accept: 'application/json' } });
      const data = await res.json().catch(() => ({ error: `The console answered ${res.status}.` }));
      if (!res.ok) throw new Error(data.error || `The console answered ${res.status}.`);
      model = data;
      token = data.token;
      state.decided = {};
      const rows = rowsOf(model);
      // The page opens on the list, with no finding selected and the panel closed.
      if (!rows.some((r) => idOf(r) === state.current)) state.current = null;
      paint(['controls', 'list', 'doc', 'foot', 'menu']);
    } catch (err) {
      const gone = loadFailed(state);
      model = null;
      document.body.classList.toggle('is-open', gone.open);
      el.doc.innerHTML = gone.doc;
      el.foot.innerHTML = gone.foot;
      el.foot.hidden = true;
      el.groups.innerHTML = `<div class="empty"><p>The findings did not load: ${esc(err.message)}</p><button class="linkish" type="button" data-act="reload">Try again</button></div>`;
    } finally {
      el.refresh.removeAttribute('aria-busy');
      el.refresh.disabled = false;
    }
  }

  async function sendVerdict(act) {
    const r = model && rowsOf(model).find((x) => idOf(x) === state.current);
    if (!r) return;
    const textarea = el.foot.querySelector('textarea');
    const reason = textarea.value.trim();
    if (act === 'reject' && !reason) {
      state.foot = { error: null, sending: false, reasonError: true };
      el.foot.querySelector('.reason').dataset.error = '';
      const msg = el.foot.querySelector('.reason-error');
      msg.textContent = 'Add a reason to reject.';
      msg.hidden = false;
      textarea.setAttribute('aria-invalid', 'true');
      textarea.focus();
      return;
    }
    const verdict = act === 'approve' ? 'approved' : 'rejected';
    el.foot.querySelectorAll('.btn').forEach((b) => { b.disabled = true; });
    try {
      const res = await fetch('/api/verdict', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ token, site: r.site, key: r.key, verdict, reason }),
      });
      const data = await res.json().catch(() => ({ error: `The console answered ${res.status}.` }));
      if (!res.ok) throw new Error(data.error || `The console answered ${res.status}.`);
      const recorded = data.recorded || { status: verdict, at: new Date().toISOString() };
      state.decided[idOf(r)] = { status: recorded.status, reason, at: recorded.at, result: data };
      paint(['controls', 'list', 'doc', 'foot']);
    } catch (err) {
      const msg = el.foot.querySelector('.reason-error');
      msg.textContent = err.message;
      msg.hidden = false;
      el.foot.querySelectorAll('.btn').forEach((b) => { b.disabled = false; });
    }
  }

  // Sync findings, Fix and Verify post to /api/run/<verb>: the CLI's own functions, answered as JSON.
  async function runPost(verb, fields) {
    const res = await fetch(`/api/run/${verb}`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ token, ...fields }),
    });
    const data = await res.json().catch(() => ({ error: `The console answered ${res.status}.` }));
    if (!res.ok) throw new Error(data.error || `The console answered ${res.status}.`);
    return data;
  }
  // A repaint that leaves the open finding where the reader scrolled it.
  function repaint(parts) {
    const top = el.doc.scrollTop;
    paint(parts);
    el.doc.scrollTop = top;
  }
  async function runSync() {
    if (state.sync === 'running') return;
    state.sync = 'running';
    repaint(['menu', 'doc']);
    try {
      const data = await runPost('sync', {});
      state.sync = { text: data.summary };
      repaint(['menu', 'doc']);
      await load();
    } catch (err) {
      state.sync = { error: err.message };
      repaint(['menu', 'doc']);
    }
  }
  async function runRow(verb) {
    const r = model && rowsOf(model).find((x) => idOf(x) === state.current);
    if (!r || state.foot.sending) return;
    delete state.ran[idOf(r)];
    state.foot = { error: null, sending: true, reasonError: false };
    repaint(['foot', 'doc']);
    try {
      const data = await runPost(verb, { site: r.site, key: r.key });
      state.ran[idOf(r)] = { verb, workflowId: data.workflowId, nextStep: data.nextStep };
    } catch (err) {
      state.ran[idOf(r)] = { verb, error: err.message };
    }
    state.foot = { error: null, sending: false, reasonError: false };
    repaint(['foot', 'doc']);
  }

  // ---------- Events ----------

  // Empties the box and returns every control to All.
  function clearFilters() {
    Object.assign(state, clearedFilters());
    el.input.value = '';
    render();
  }
  el.groups.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="clear"]')) { clearFilters(); return; }
    if (e.target.closest('[data-act="reload"]')) { load(); return; }
    const b = e.target.closest('.row');
    if (b) open(b.dataset.id);
  });
  el.statuses.addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    state.status = b.dataset.status;
    render();
  });
  el.facets.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="clear"]')) { clearFilters(); return; }
    const item = e.target.closest('.menu-item');
    if (item) {
      const d = item.dataset;
      if (d.site) state.site = d.site;
      if (d.pri) state.pri = d.pri;
      if (d.status) state.status = d.status;
      if (d.sort) state.sort = d.sort;
      state.menu = null;
      render();
      return;
    }
    if (e.target.closest('[data-act="drift"]')) {
      // The chip counts drift in every status, so turning it on shows them all; turning it off returns to the tab.
      state.drift = !state.drift;
      if (state.drift) { state.statusBeforeDrift = state.status; state.status = 'all'; }
      else if (state.statusBeforeDrift) { state.status = state.statusBeforeDrift; state.statusBeforeDrift = null; }
      render();
      return;
    }
    const btn = e.target.closest('.facet-btn');
    if (btn) {
      const name = btn.parentElement.dataset.facet;
      state.menu = state.menu === name ? null : name;
      paint(['controls']);
      const first = el.facets.querySelector(`[data-facet="${name}"] .menu-item`);
      if (first) first.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (state.menu && !e.target.closest('.facet')) { state.menu = null; paint(['controls']); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.menu) {
      const name = state.menu;
      state.menu = null;
      paint(['controls']);
      const btn = el.facets.querySelector(`[data-facet="${name}"] .facet-btn`);
      if (btn) btn.focus();
    }
  });
  // Search sits behind an icon; it stays open while it holds a query.
  $('.search-btn').addEventListener('click', () => { el.search.dataset.open = 'true'; el.input.focus(); });
  el.input.addEventListener('blur', () => { if (!el.input.value.trim()) delete el.search.dataset.open; });
  el.input.addEventListener('input', () => { state.q = el.input.value; paint(['controls', 'list']); });
  $('.close').addEventListener('click', close);
  el.refresh.addEventListener('click', () => load());

  // The header menu: the running commit and Restart console. The restart posts, then waits for a process
  // with a new token (each process draws its own) to answer /api/commit, then reloads the page.
  function setAppMenu(on) {
    state.appMenu = on;
    paint(['menu']);
    if (on) { const first = el.menuPop.querySelector('.menu-item'); if (first) first.focus(); }
  }
  async function restart() {
    const oldToken = token;
    state.restart = 'restarting';
    paint(['menu']);
    try {
      const res = await fetch('/api/restart', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `The console answered ${res.status}.`);
    } catch (err) {
      state.restart = `The restart did not start: ${err.message}`;
      paint(['menu']);
      return;
    }
    for (let waited = 0; waited < 60000; waited += 500) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        const res = await fetch('/api/commit', { cache: 'no-store', headers: { accept: 'application/json' } });
        const data = res.ok ? await res.json() : null;
        if (data && data.token && data.token !== oldToken) { location.reload(); return; }
      } catch (err) { /* the old process has closed and the new one is not listening yet */ }
    }
    state.restart = 'The console did not come back. See agents/steward/.cache/console-restart.log.';
    paint(['menu']);
  }
  el.menuBtn.addEventListener('click', () => setAppMenu(!state.appMenu));
  el.menuPop.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="restart"]')) restart();
    else if (e.target.closest('[data-act="sync"]')) runSync();
  });
  document.addEventListener('click', (e) => {
    // The path, not `e.target`: Sync repaints the menu inside its own click, which detaches the button before this runs.
    const inside = e.composedPath().some((n) => n.classList && n.classList.contains('app-menu'));
    if (state.appMenu && state.restart !== 'restarting' && !inside) setAppMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.appMenu && state.restart !== 'restarting') { setAppMenu(false); el.menuBtn.focus(); }
  });
  // The Age heading sorts: oldest first, then newest first.
  el.age.addEventListener('click', () => { state.sort = state.sort === 'oldest' ? 'newest' : 'oldest'; render(); });

  el.doc.addEventListener('click', (e) => {
    const b = e.target.closest('.key-copy');
    if (!b) return;
    const key = b.querySelector('.key').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(key).catch(() => {});
    b.dataset.copied = '';
    b.title = 'Copied';
    b.parentElement.querySelector('[role="status"]').textContent = 'Key copied';
    clearTimeout(b._t);
    b._t = setTimeout(() => { delete b.dataset.copied; b.title = 'Click to copy'; }, 1600);
  });
  el.foot.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'next') { open(btn.dataset.id); return; }
    if (act === 'approve' || act === 'reject') sendVerdict(act);
    if (act === 'fix' || act === 'verify') runRow(act);
  });
  // The drift box's remedies are the same buttons.
  el.doc.addEventListener('click', (e) => {
    const btn = e.target.closest('.drift-lines [data-act]');
    if (!btn || btn.disabled) return;
    if (btn.dataset.act === 'sync') runSync();
    else if (btn.dataset.act === 'fix') runRow('fix');
  });
  el.foot.addEventListener('input', (e) => {
    if (!e.target.matches('textarea') || !e.target.value.trim() || !state.foot.reasonError) return;
    state.foot.reasonError = false;
    delete el.foot.querySelector('.reason').dataset.error;
    el.foot.querySelector('.reason-error').hidden = true;
    e.target.removeAttribute('aria-invalid');
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    document.body.classList.add('resizing');
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => document.body.classList.remove('resizing'), 200);
  });

  // Open without the slide on first paint.
  load().finally(() => requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('no-motion'))));
})();
