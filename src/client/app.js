(() => {
  'use strict';

  const app = document.getElementById('app');
  const shareMatch = location.pathname.match(/^\/r\/([a-f0-9]{48})$/);
  const COST_PER_POINT = 0.0006;
  let config = { live: false, spent: 0, cap: 10 };
  let maps = [];
  let renderId = 0;

  /* ---------- Checklist content (from the research brief, in priority order) ---------- */

  const CHECKLIST = [
    ['Profile basics', [
      ['verified', 'Profile verified, and you have owner access', 'You can only fix what you control. Use manager access for staff.'],
      ['name', 'Name matches signage, website and invoices', 'Extra keywords or towns in the name break Google rules and risk suspension.'],
      ['pin', 'Exact address and map pin', 'Pin placement is a top-10 factor. Show the address if customers visit.'],
      ['hours', 'Opening hours, plus holiday hours', '"Open at the time of search" is a top-5 factor.'],
      ['phone', 'Local phone number that matches the website', 'Consistency builds trust in the listing.'],
      ['website-link', 'Website link goes to the right location or service page', 'A matching landing page backs up relevance.'],
    ]],
    ['Relevance', [
      ['primary-category', 'Primary category is your core service', 'The #1 ranking factor you control.'],
      ['extra-categories', 'Only accurate extra categories', 'Unrelated categories confuse Google ("category confusion").'],
      ['services', 'Predefined services added, then custom ones', 'Tests showed services can lift rankings for those terms.'],
      ['attributes', 'Attributes filled in', 'Part of profile completeness (top-20 factor).'],
      ['description', 'Description written (no links, no promo spam)', 'Completeness and conversion. Promo text breaks policy.'],
    ]],
    ['Website', [
      ['page-title', 'Landing page title has the service and town', 'Page title keywords are a top-20 factor.'],
      ['nap', 'Name, address and phone on the page match GBP exactly', 'Matching on-page NAP is a top-15 factor.'],
      ['service-pages', 'One page per main service', 'Dedicated service pages are a top-25 factor.'],
      ['faqs', 'FAQs live on the website, not in GBP Q&A', 'Google wound down public Q&A in 2025.'],
    ]],
    ['Reviews', [
      ['review-link', 'Review link ready, and asked after every visit or job', 'Count, recency and a steady flow all matter.'],
      ['review-replies', 'Reply to every review', 'Mostly trust and conversion: 37% of people check for replies.'],
      ['review-rules', 'No scripted keywords, no rewards, no fake reviews', 'Keyword-stuffed reviews did nothing in tests. Fakes risk penalties.'],
    ]],
    ['Photos', [
      ['photos', 'Real photos: outside, inside, team, work', 'Helps people choose you. Geotagging does nothing.'],
    ]],
    ['Citations and prominence', [
      ['apple', 'Apple Business Connect listing matches', 'Consistency across Google, Apple and Bing maps is a top-30 factor.'],
      ['bing', 'Bing Places listing matches', 'Same as above.'],
      ['directories', 'Main UK and industry directories match (fix mismatches first)', 'Consistency beats volume. Bulk cheap citations fade.'],
      ['links', 'A few local links or mentions (clubs, venues, local news)', 'Google says links count towards prominence.'],
    ]],
    ['Competitive set', [
      ['spam', 'Spam listings in your area reported', 'Removing fake rivals can win back spots (#19 factor).'],
    ]],
  ];

  /* ---------- Helpers ---------- */

  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    node.append(...kids.flat(Infinity).filter((c) => c != null && c !== false));
    return node;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...kids) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) node.setAttribute(k, v);
    node.append(...kids.flat(Infinity).filter((c) => c != null));
    return node;
  }

  async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}). Try reloading the page.`);
    return data;
  }

  function render(...nodes) {
    maps.forEach((m) => m.remove());
    maps = [];
    app.replaceChildren(...nodes.flat().filter((n) => n instanceof Node));
  }

  const fail = (err) => render(el('p', { class: 'notice notice--warn', role: 'alert' }, err.message));
  const toDate = (s) => new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  const fmtDate = (s) => (s ? toDate(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const fmtDay = (s) => (s ? toDate(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const today = () => new Date().toISOString().slice(0, 10);
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  const money = (n) => `$${Number(n || 0).toFixed(n > 0 && n < 0.1 ? 4 : 2)}`;

  let uid = 0;
  function field(label, control, hint) {
    const id = `f${++uid}`;
    control.id = id;
    if (hint) control.setAttribute('aria-describedby', `${id}-hint`);
    return el('div', { class: 'field' }, el('label', { class: 'field__label', for: id }, label), control, hint && el('p', { class: 'field__hint', id: `${id}-hint` }, hint));
  }
  const input = (attrs) => el('input', { class: 'field__input', ...attrs });
  const select = (attrs, options) => el('select', { class: 'field__input', ...attrs }, options.map(([value, label, selected]) => el('option', { value, selected: Boolean(selected) }, label)));
  const busy = (form, on) => form.querySelectorAll('button, input, select, textarea').forEach((n) => (n.disabled = on));
  const section = (title, ...kids) => {
    const id = `s${++uid}`;
    return el('section', { class: 'section', 'aria-labelledby': id }, el('h2', { class: 'section__title', id }, title), ...kids);
  };
  const table = (caption, heads, rows, numCols = []) =>
    el('div', { class: 'table-wrap' },
      el('table', { class: 'table' },
        el('caption', { class: 'visually-hidden' }, caption),
        el('thead', null, el('tr', null, heads.map((h, i) => el('th', { class: `table__cell table__cell--head${numCols.includes(i) ? ' table__cell--num' : ''}`, scope: 'col' }, h)))),
        el('tbody', null, rows)));
  const td = (content, num) => el('td', { class: `table__cell${num ? ' table__cell--num' : ''}` }, content ?? '–');

  function baseMap(node, centre, zoom) {
    const map = L.map(node, { scrollWheelZoom: false, zoomSnap: 0.25 }).setView(centre, zoom);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    maps.push(map);
    return map;
  }
  const homeIcon = () => L.divIcon({ className: 'pin pin--home', iconSize: [22, 22], iconAnchor: [11, 40] });

  const rankClass = (p) => (p.status === 'pending' ? 'wait' : p.status === 'error' ? 'error' : p.rank == null ? 'none' : p.rank <= 3 ? 'top' : p.rank <= 10 ? 'mid' : 'low');
  const rankLabel = (p) => (p.status === 'pending' ? '…' : p.status === 'error' ? '!' : p.rank == null ? '20+' : String(p.rank));

  function scanStats(points) {
    const done = points.filter((p) => p.status === 'done');
    const found = done.filter((p) => p.rank != null);
    const top3 = found.filter((p) => p.rank <= 3);
    return {
      done: done.length,
      avg: found.length ? found.reduce((a, p) => a + p.rank, 0) / found.length : null,
      // "Solv-style" average: not found counts as 21, so coverage gaps show up.
      avgAll: done.length ? done.reduce((a, p) => a + (p.rank ?? 21), 0) / done.length : null,
      top3: pct(top3.length, done.length),
      found: pct(found.length, done.length),
    };
  }

  /* ---------- Location form (add + edit) ---------- */

  function locationForm(initial, onSave) {
    const name = input({ name: 'name', required: true, maxlength: 120, autocomplete: 'organization', value: initial?.name || '' });
    const placeId = input({ name: 'place_id', maxlength: 200, spellcheck: 'false', value: initial?.place_id || '' });
    const cid = input({ name: 'cid', inputmode: 'numeric', spellcheck: 'false', value: initial?.cid || '' });
    const lat = input({ name: 'lat', required: true, inputmode: 'decimal', value: initial?.lat ?? '' });
    const lng = input({ name: 'lng', required: true, inputmode: 'decimal', value: initial?.lng ?? '' });
    const find = input({ name: 'find', type: 'search', autocomplete: 'off', enterkeyhint: 'search' });
    const findBtn = el('button', { class: 'button button--ghost finder__button', type: 'button' }, 'Find');
    const mapNode = el('div', { class: 'map map--small', role: 'application', 'aria-label': 'Click to set the business pin' });
    const error = el('p', { class: 'form__error', role: 'alert' });
    const gQuery = input({ name: 'gbp-search', type: 'search', autocomplete: 'off', enterkeyhint: 'search', value: initial?.name || '' });
    const gBtn = el('button', { class: 'button finder__button', type: 'button' }, 'Search Google');
    const gStatus = el('p', { class: 'field__hint', role: 'status' });
    const gList = el('ul', { class: 'places' });
    let marker;
    let map;

    const placePin = (ll) => {
      if (marker) marker.setLatLng(ll);
      else marker = L.marker(ll, { icon: homeIcon(), keyboard: false }).addTo(map);
    };
    const setPin = (a, b, z) => {
      lat.value = a.toFixed(6);
      lng.value = b.toFixed(6);
      placePin([a, b]);
      map.setView([a, b], z || 16);
    };

    async function locate() {
      const q = find.value.trim();
      if (!q) return;
      error.textContent = '';
      const m = q.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || q.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || q.match(/^(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)$/);
      if (m) return setPin(parseFloat(m[1]), parseFloat(m[2]));
      if (/^https?:/i.test(q)) {
        error.textContent = 'That link has no coordinates. Open the place in Google Maps, then copy the address bar link.';
        return;
      }
      findBtn.disabled = true;
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=gb&q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error('Search is busy. Try again, or click the map.');
        const data = await res.json();
        if (!data.length) throw new Error('No match. Try the postcode, or click the map.');
        setPin(parseFloat(data[0].lat), parseFloat(data[0].lon), 17);
      } catch (err) {
        error.textContent = err.message;
      } finally {
        findBtn.disabled = false;
      }
    }
    // Find on Google: pick the real listing, then fill in its IDs and pin.
    const linked = () => {
      const has = placeId.value.trim() || cid.value.trim();
      gStatus.textContent = has ? 'Linked to a Google profile. Scans will match it exactly.' : 'Not linked yet. Scans will match by name only, which can miss.';
    };
    const usePlace = (r) => {
      placeId.value = r.place_id || '';
      cid.value = r.cid || '';
      if (!name.value.trim()) name.value = r.title;
      if (Number.isFinite(r.lat) && Number.isFinite(r.lng) && map) setPin(r.lat, r.lng, 17);
      gList.replaceChildren();
      linked();
      gStatus.textContent = `Linked to "${r.title}". Check the pin, then save.`;
    };
    async function searchGoogle() {
      const q = gQuery.value.trim();
      if (q.length < 3) return (gStatus.textContent = 'Type the group name and town, e.g. "Slimming World Haxby".');
      gBtn.disabled = true;
      gStatus.textContent = 'Searching…';
      try {
        const d = await api('/places/find', { method: 'POST', body: { q, lat: lat.value, lng: lng.value } });
        gList.replaceChildren(...d.results.map((r) =>
          el('li', { class: 'places__item' },
            el('button', { class: 'places__pick', type: 'button', onclick: () => usePlace(r) },
              el('span', { class: 'places__title' }, r.title),
              el('span', { class: 'places__meta' }, [r.address, r.category, r.reviews != null ? `${r.rating ?? '–'}★ · ${r.reviews} reviews` : 'No reviews'].filter(Boolean).join(' · ')),
              el('span', { class: 'places__use' }, 'Use this')))));
        gStatus.textContent = d.results.length
          ? `Pick the right one${d.cost ? ` (search cost ${money(d.cost)})` : ''}.`
          : d.live ? 'No match. Try fewer words, or add the town.' : 'No match in past scans. Live search needs DataForSEO.';
        if (d.warning) gStatus.textContent = d.warning;
        if (d.cost) config.spent = (config.spent || 0) + d.cost;
      } catch (err) {
        gStatus.textContent = err.message;
      } finally {
        gBtn.disabled = false;
      }
    }
    gBtn.addEventListener('click', searchGoogle);
    gQuery.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        searchGoogle();
      }
    });
    // Accept a pasted Google Maps link in the ID fields.
    const readLink = () => {
      const v = placeId.value.trim();
      let m;
      if ((m = v.match(/(ChIJ[\w-]{10,})/))) placeId.value = m[1];
      else if ((m = v.match(/[?&]cid=(\d{5,30})/))) [placeId.value, cid.value] = ['', m[1]];
      else if ((m = v.match(/0x[0-9a-f]+:0x([0-9a-f]+)/i))) [placeId.value, cid.value] = ['', BigInt(`0x${m[1]}`).toString()];
      linked();
    };
    placeId.addEventListener('change', readLink);
    cid.addEventListener('change', linked);
    linked();

    findBtn.addEventListener('click', locate);
    find.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        locate();
      }
    });

    const form = el('form', { class: 'form', novalidate: true },
      el('fieldset', { class: 'fieldset places-box' },
        el('legend', { class: 'field__label' }, 'Find the Google profile'),
        el('div', { class: 'finder' },
          field('Group name and town', gQuery, 'Pick the right listing. It fills in the IDs and the pin for you.'),
          gBtn),
        gStatus,
        gList),
      el('div', { class: 'form__row' },
        field('Business name', name, 'Your label for this location.'),
        field('Place ID', placeId, 'Filled in by the search above. You can also paste a Google Maps link.'),
        field('CID (optional)', cid, 'Filled in by the search above.')),
      el('div', { class: 'finder' },
        field('Or find a spot on the map', find, 'Postcode, address, or a Google Maps link. Click the map to fine-tune.'),
        findBtn),
      el('div', { class: 'form__row' }, field('Latitude', lat), field('Longitude', lng)),
      mapNode,
      error,
      el('div', { class: 'form__actions' }, el('button', { class: 'button', type: 'submit' }, initial ? 'Save changes' : 'Add location')));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      if (!lat.value.trim() || !lng.value.trim()) {
        error.textContent = 'Drop the pin on the business first: search above, or click the map.';
        return;
      }
      busy(form, true);
      try {
        await onSave({ name: name.value, place_id: placeId.value, cid: cid.value, lat: lat.value, lng: lng.value });
      } catch (err) {
        error.textContent = err.message;
        busy(form, false);
      }
    });

    return {
      node: form,
      init() {
        const has = initial && Number.isFinite(initial.lat);
        map = baseMap(mapNode, has ? [initial.lat, initial.lng] : [54.5, -2.5], has ? 15 : 5);
        if (has) placePin([initial.lat, initial.lng]);
        map.on('click', (e) => {
          lat.value = e.latlng.lat.toFixed(6);
          lng.value = e.latlng.lng.toFixed(6);
          placePin(e.latlng);
        });
        [lat, lng].forEach((n) =>
          n.addEventListener('change', () => {
            const a = parseFloat(lat.value);
            const b = parseFloat(lng.value);
            if (Number.isFinite(a) && Number.isFinite(b)) {
              placePin([a, b]);
              map.setView([a, b], 15);
            }
          }),
        );
      },
    };
  }

  /* ---------- Header ---------- */

  let locCache = null;
  async function updateHeader(currentId) {
    const sw = document.getElementById('loc-switch');
    const spend = document.getElementById('spend');
    spend.textContent = `${money(config.spent)} of ${money(config.cap)} this month`;
    spend.hidden = false;
    spend.title = 'DataForSEO spend this month vs your cap';
    try {
      locCache = locCache || (await api('/locations'));
    } catch {
      return;
    }
    if (!locCache.length) {
      sw.hidden = true;
      return;
    }
    sw.replaceChildren(
      el('option', { value: '' }, 'All locations'),
      ...locCache.map((l) => el('option', { value: l.id, selected: l.id === currentId }, l.name)),
    );
    sw.hidden = false;
    sw.onchange = () => (location.hash = sw.value ? `#/loc/${sw.value}` : '#/');
  }

  /* ---------- AI prompt panel ---------- */

  function aiPanel(prompt, label = 'Do this faster with AI') {
    if (!prompt) return null;
    const text = el('textarea', { class: 'ai__text', readonly: true, rows: 10, 'aria-label': 'AI prompt' });
    text.value = prompt;
    const copy = el('button', { class: 'button button--small', type: 'button' }, 'Copy prompt');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(prompt);
      } catch {
        text.select();
        document.execCommand('copy');
      }
      copy.textContent = 'Copied ✓';
      setTimeout(() => (copy.textContent = 'Copy prompt'), 2000);
    });
    const q = encodeURIComponent(prompt);
    return el('details', { class: 'ai' },
      el('summary', { class: 'ai__summary' }, label),
      el('div', { class: 'ai__body' },
        el('p', { class: 'ai__note' }, 'Ready-made prompt with your business details filled in. AI writes the copy or plan. You still make the change in Google Business Profile. Check facts before you publish.'),
        text,
        el('div', { class: 'ai__actions' },
          copy,
          el('a', { class: 'button button--ghost button--small', href: `https://claude.ai/new?q=${q}`, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Claude ↗'),
          el('a', { class: 'button button--ghost button--small', href: `https://chatgpt.com/?q=${q}`, target: '_blank', rel: 'noopener noreferrer' }, 'Open in ChatGPT ↗'))));
  }

  /* ---------- Home ---------- */

  async function viewHome() {
    const locs = await api('/locations');
    locCache = locs;
    updateHeader(null);
    const list = locs.length
      ? el('ul', { class: 'cards' }, locs.map((l) =>
          el('li', null, el('a', { class: 'card', href: `#/loc/${l.id}` },
            el('h3', { class: 'card__title' }, l.name),
            l.last_scan
              ? el('div', { class: 'card__stat' }, el('span', { class: 'card__big' }, `${l.last_top3 ?? 0}%`), el('span', { class: 'card__meta' }, `top 3 for "${l.last_keyword}"`))
              : el('p', { class: 'card__meta' }, 'No scans yet'),
            el('p', { class: 'card__meta' }, `${l.scans} ${l.scans === 1 ? 'scan' : 'scans'}${l.last_scan ? ` · last ${fmtDay(l.last_scan)}` : ''}`),
            el('span', { class: 'card__cta' }, 'Open action plan →')))))
      : el('p', { class: 'empty' }, 'No locations yet. Add your first one below.');
    const form = locationForm(null, async (body) => {
      const d = await api('/locations', { method: 'POST', body });
      locCache = null;
      location.hash = `#/loc/${d.id}/scan`;
    });
    render(
      el('section', { class: 'section', 'aria-labelledby': 'loc-title' },
        el('div', { class: 'section__head' }, el('h1', { class: 'page-title', id: 'loc-title' }, 'Your locations')),
        el('p', { class: 'section__lead' }, 'Pick a location to see its action plan, run scans and track progress.'),
        list),
      section('Add a location', form.node));
    form.init();
  }

  /* ---------- Location shell + tabs ---------- */

  const TABS = [['plan', 'Action plan'], ['scan', 'Run a scan'], ['progress', 'Progress'], ['checklist', 'Checklist'], ['pack', 'Print pack'], ['settings', 'Settings']];
  const CHECKLIST_TOTAL = () => CHECKLIST.reduce((n, [, items]) => n + items.length, 0);

  async function viewLocation(id, tab, extra) {
    const d = await api(`/locations/${id}`);
    const loc = d.location;
    updateHeader(id);
    const latest = d.scans.find((s) => s.status === 'done' && s.mode === 'live' && s.done_points) || d.scans.find((s) => s.status === 'done' && s.done_points);
    const checkDone = d.checklist.filter((c) => c.done && !c.item.startsWith('plan-')).length;
    const exact = Boolean(loc.place_id || loc.cid);
    const header = el('section', { class: 'section hero', 'aria-labelledby': 'loc-name' },
      el('div', { class: 'hero__top' },
        el('div', null,
          el('h1', { class: 'page-title', id: 'loc-name' }, loc.name),
          el('span', { class: `hero__match${exact ? ' hero__match--exact' : ''}` }, exact ? 'Matched by Place ID' : 'Matched by name. Add a Place ID in Settings for exact matching.')),
        el('div', { class: 'hero__actions' },
          el('a', { class: 'button', href: `#/loc/${id}/scan` }, 'Run a scan'),
          latest && el('a', { class: 'button button--ghost', href: `#/scan/${latest.id}` }, 'Latest map'))),
      latest
        ? el('dl', { class: 'stats' },
            stat(`Top 3 · "${latest.keyword}"`, `${pct(latest.top3, latest.done_points)}%`),
            stat('In top 20', `${pct(latest.found, latest.done_points)}%`),
            stat('Average rank', latest.avg_rank == null ? '–' : latest.avg_rank.toFixed(1)),
            stat('Checklist', `${checkDone}/${CHECKLIST_TOTAL()}`))
        : el('p', { class: 'notice notice--info' }, 'No scans yet. Run your first scan to get a map and an action plan.'),
      el('nav', { class: 'tabs', 'aria-label': 'Location sections' }, TABS.map(([key, label]) =>
        el('a', { class: `tabs__link${key === tab ? ' tabs__link--active' : ''}`, href: `#/loc/${id}/${key}`, 'aria-current': key === tab ? 'page' : null }, label))));
    const views = { plan: tabPlan, scan: tabScan, progress: tabProgress, checklist: tabChecklist, pack: tabPack, settings: tabSettings };
    await (views[tab] || tabPlan)(d, header, extra);
  }

  /* ---------- Action plan (guided steps) ---------- */

  async function tabPlan(d, header, scanId) {
    const loc = d.location;
    const done = d.scans.filter((s) => s.status === 'done');
    if (!done.length) {
      render(header, section('Your action plan',
        el('p', { class: 'section__lead' }, 'Run a live scan first. The plan compares your listing with the businesses beating you, then gives you steps to close the gaps.'),
        el('a', { class: 'button', href: `#/loc/${loc.id}/scan` }, 'Run your first scan')));
      return;
    }
    const latestByKw = new Map();
    done.forEach((s) => {
      const k = s.keyword.toLowerCase();
      const cur = latestByKw.get(k);
      if (!cur || (cur.mode === 'demo' && s.mode === 'live')) latestByKw.set(k, s);
    });
    const chosen = done.find((s) => s.id === scanId) || [...latestByKw.values()].find((s) => s.mode === 'live') || done[0];
    const picker = select({ name: 'plan-scan', id: 'plan-scan' }, [...latestByKw.values()].map((s) => [s.id, `"${s.keyword}"${s.mode === 'demo' ? ' (demo)' : ''} · ${fmtDay(s.created_at)}`, s.id === chosen.id]));
    picker.addEventListener('change', () => (location.hash = `#/loc/${loc.id}/plan/${picker.value}`));

    const data = await api(`/scans/${chosen.id}`);
    const a = data.analysis;
    if (!a) {
      render(header, section('Your action plan', el('p', { class: 'empty' }, 'That scan is still running. Check back in a few minutes.')));
      return;
    }
    const ctx = window.GR_PROMPTS?.context(loc, a, chosen.keyword);
    const status = new Map(d.checklist.filter((c) => c.item.startsWith('plan-')).map((c) => [c.item.slice(5), c]));
    const recs = a.recommendations;
    const stateOf = (r) => (status.get(r.id)?.done ? (status.get(r.id).note === 'skipped' ? 'skipped' : 'done') : 'todo');
    const bar = el('div', { class: 'progress__bar' });
    const label = el('span');
    const updateProgress = () => {
      const handled = recs.filter((r) => stateOf(r) !== 'todo').length;
      bar.style.width = `${pct(handled, recs.length)}%`;
      label.replaceChildren(el('strong', null, `${handled} of ${recs.length}`), ' steps handled');
    };
    updateProgress();
    const firstTodo = recs.findIndex((r) => stateOf(r) === 'todo');

    const steps = recs.length
      ? el('ol', { class: 'steps' }, recs.map((r, i) => stepCard(r, i, { loc, ctx, status, scanAt: chosen.created_at, open: i === firstTodo, onChange: updateProgress })))
      : el('p', { class: 'empty' }, 'No gaps found against the current leaders. Keep reviews flowing and re-scan monthly.');

    render(
      header,
      chosen.mode === 'demo' && el('p', { class: 'notice notice--warn' }, 'This plan uses DEMO (made-up) data. Run a live scan before acting on it.'),
      a.legacy && el('p', { class: 'notice notice--info' }, 'This scan ran before competitor data was collected. Run a new live scan for the full plan.'),
      el('section', { class: 'section', 'aria-labelledby': 'plan-title' },
        el('div', { class: 'section__head' },
          el('h2', { class: 'section__title', id: 'plan-title' }, 'Your optimisation steps'),
          el('div', { class: 'field' }, el('label', { class: 'visually-hidden', for: 'plan-scan' }, 'Keyword'), picker)),
        el('p', { class: 'section__lead' },
          `From the ${chosen.mode === 'demo' ? 'demo' : 'live'} scan for "${chosen.keyword}" on ${fmtDate(chosen.created_at)}. Work top to bottom. Do one or two, mark them done, then re-scan in 2–3 weeks. `,
          el('a', { href: `#/scan/${chosen.id}` }, 'See the map')),
        recs.length > 0 && el('div', { class: 'plan-progress' },
          el('div', { class: 'plan-progress__label' }, label, el('span', null, 'Highest impact first')),
          el('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Steps handled' }, bar)),
        steps),
      a.strengths.length > 0 && section('Already working', el('ul', { class: 'strengths' }, a.strengths.map((t) => el('li', null, t)))),
      section('You vs the leaders', el('p', { class: 'section__lead' }, 'The businesses most often in the top 3 on your grid.'), leaderTable(a)),
      section('How far your ranking reaches', reachView(a)),
    );
  }

  /* ---------- Print pack (a hand-out for the group's consultant) ---------- */

  // One-off fixes in plain words, pointing to the SW guide rather than repeating it.
  const PACK_FIXES = {
    claim: ['Claim your profile', 'Google shows it as unclaimed. Until you own it, you cannot change anything.', 'New profile guide, steps 1–10'],
    'primary-category': ['Set your main category to "Weight-loss service"', 'It is the biggest signal you control. It tells Google what you do.', 'Existing profile guide, step 2'],
    'extra-categories': ['Add "Health consultant" as a second category', 'The groups beating you use extra categories. Only add ones that are true.', 'Existing profile guide, step 2'],
    hours: ['Add your group times as opening hours', 'Google favours places that are "open" when someone searches.', 'Existing profile guide, step 9'],
    website: ['Link your SW group page', 'A matching web page backs up your location and times.', 'Existing profile guide, step 5'],
    photos: ['Add more real photos', 'The groups ahead of you have far more. Photos help people pick you.', 'Existing profile guide, photos section'],
    description: ['Write a fuller description', 'Yours is short. Say "weight loss group in [area]", your day, time and venue.', 'Existing profile guide, step 3'],
  };

  function campaignDates(now = new Date()) {
    const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const d = (m, day) => new Date(Date.UTC(m > 11 ? y + 1 : y, m % 12, day));
    return { start: d(11, 20), newYear: d(12, 4), peakEnd: d(12, 25) };
  }
  const addDays = (date, n) => new Date(date.getTime() + n * 864e5);
  const shortDay = (date) => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const firstName = (name) => (String(name).match(/\bwith\s+([A-Z][a-z]+)/) || [])[1];

  function packWins(p) {
    const wins = [];
    const own = p.own;
    const self = p.scan?.analysis?.self;
    const t = p.team;
    const swCount = p.york.team.count;
    const reviews = own ? own.reviews ?? 0 : self?.reviews ?? 0;
    const rating = own?.rating ?? self?.rating;
    if (rating >= 4.5 && reviews > 0) wins.push([`${rating.toFixed(1)}★`, `Your Google rating from ${reviews} review${reviews === 1 ? '' : 's'}. Members clearly rate you.`]);
    if (own?.reviewRank === 1 && reviews > 0) wins.push(['#1', `Most Google reviews of the ${swCount} York SW groups we track.`]);
    if (t?.selfTop3) wins.push([`${t.selfTop3}/${t.points}`, `Spots where you are in Google's top 3 for "${p.scan.scan.keyword}".`]);
    if (t?.selfFirst) wins.push(['#1', `You are first on Google at ${t.selfFirst} spot${t.selfFirst === 1 ? '' : 's'} around you.`]);
    if (own?.photos && own.photoRank <= 3) wins.push([own.photoRank === 1 ? '#1' : `Top ${own.photoRank}`, `For photos among ${swCount} York SW groups (${own.photos} photos).`]);
    const radius = p.scan?.analysis?.reach?.strongRadius;
    if (radius >= 1) wins.push([`${radius} km`, 'You are strong on Google this far from your venue.']);
    if (t?.teamTop3 && t.groups > 1) wins.push([`${pct(t.teamTop3, t.points)}%`, `Of spots near you show a SW group in Google's top 3. You are part of that.`]);
    if (!wins.length) wins.push(self ? ['Live', 'Your profile shows up in Google searches near you. That is the base everything builds on.'] : ['Started', 'Your profile is live on Google. Every step from here adds to it.']);
    return wins.slice(0, 4);
  }

  function packFixes(p) {
    const done = new Set(p.plan.filter((c) => c.done).map((c) => c.item.slice(5)));
    const ids = (p.scan?.analysis?.recommendations || []).map((r) => r.id).filter((id) => PACK_FIXES[id] && !done.has(id));
    const own = p.own;
    if (own) {
      if (own.has_hours === 0) ids.push('hours');
      if (!own.website) ids.push('website');
      if (own.photos != null && own.photos < 10) ids.push('photos');
      if (own.desc_len != null && own.desc_len < 250) ids.push('description');
      if (own.claimed === 0) ids.push('claim');
    }
    return [...new Set(ids)].map((id) => PACK_FIXES[id]);
  }

  function reviewGoal(p, weeks) {
    const mine = p.own ? p.own.reviews ?? 0 : p.scan?.analysis?.self?.reviews ?? 0;
    const leaders = (p.scan?.analysis?.competitors || []).filter((c) => c.top3 > 0).map((c) => c.reviews ?? 0);
    const target = Math.max(10, ...leaders);
    const perWeek = Math.min(3, Math.max(1, Math.ceil((target - mine) / Math.max(1, weeks))));
    return { mine, perWeek, by: mine + perWeek * weeks };
  }

  async function tabPack(d, header, scanId) {
    const loc = d.location;
    const p = await api(`/locations/${loc.id}/pack${scanId ? `?scan=${encodeURIComponent(scanId)}` : ''}`);
    const now = new Date();
    const c = campaignDates(now);
    const weeksToStart = Math.max(1, Math.round((c.start - now) / (7 * 864e5)));
    const goal = reviewGoal(p, weeksToStart);
    const fixes = packFixes(p);
    const who = firstName(loc.name);
    const york = p.york.team;
    const chosen = p.scan?.scan;

    const picker = p.scans.length > 1 && select({ name: 'pack-scan', id: 'pack-scan' },
      p.scans.map((s) => [s.id, `"${s.keyword}"${s.mode === 'demo' ? ' (demo)' : ''} · ${fmtDay(s.created_at)}`, s.id === chosen?.id]));
    picker && picker.addEventListener('change', () => (location.hash = `#/loc/${loc.id}/pack/${picker.value}`));

    const box = (label) => el('span', { class: 'pack__box', role: 'img', 'aria-label': label });
    const block = (title, ...kids) => {
      const id = `p${++uid}`;
      return el('section', { class: `pack__block${title.startsWith('New Year') ? ' pack__block--break' : ''}`, 'aria-labelledby': id }, el('h2', { class: 'pack__title', id }, title), ...kids);
    };

    const phases = [
      [now, addDays(c.start, -14), 'Get ready', ['Finish your fix list above.', 'Set Christmas and New Year hours, including any moved groups.', 'Start the weekly review habit now. Reviews take weeks to count.']],
      [addDays(c.start, -13), addDays(c.start, -1), 'Build up', ['Post your January group dates and any offer.', 'Add fresh photos of your group in the run-up to Christmas.', 'Ask members who did well in December for a review.']],
      [c.start, c.newYear, 'Doors open', ['Post a "new year, fresh start" update with your first January group.', 'Reply to every review and message the same day.', 'Check your hours each week while dates move.']],
      [addDays(c.newYear, 1), c.peakEnd, 'Peak joining', ['Post an update every week.', 'Share a member story, with their permission.', 'Keep asking long-standing members for reviews.']],
    ].filter(([, end]) => end >= addDays(now, -1));

    const routine = [
      ['Group day (10 minutes)', [
        `Ask ${goal.perWeek} member${goal.perWeek === 1 ? '' : 's'} face to face for a review, right after a good weigh-in.`,
        'Reply to every new review. Mention the group and area in your own words.',
        'Take one real photo (room, celebration, team) and add it. Get permission first.',
      ]],
      ['Mid-week (10 minutes)', [
        'Post one Google update: group news, a milestone, or your times.',
        'Send your review link to anyone who said they would leave one.',
        'Check your hours and details are still right.',
      ]],
    ];

    const pack = el('article', { class: 'pack', 'aria-labelledby': 'pack-title' },
      el('header', { class: 'pack__head' },
        el('p', { class: 'pack__kicker' }, 'Google profile action pack'),
        el('h1', { class: 'pack__name', id: 'pack-title' }, loc.name),
        el('p', { class: 'pack__meta' }, `Prepared ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`,
          chosen && ` · Based on a ${chosen.mode === 'demo' ? 'DEMO' : 'live'} Google check for "${chosen.keyword}" on ${fmtDay(chosen.created_at)}`)),

      block(who ? `${who}, here is what is going well` : 'What is going well',
        el('ul', { class: 'pack__wins' }, packWins(p).map(([big, text]) =>
          el('li', { class: 'pack__win' }, el('span', { class: 'pack__win-value' }, big), el('span', { class: 'pack__win-text' }, text))))),

      block('Fix once',
        fixes.length
          ? [el('p', { class: 'pack__lead' }, 'Do these one time. Your SW guide shows you how, so each one says where to look.'),
             el('ul', { class: 'pack__list' }, fixes.map(([title, why, ref]) =>
               el('li', { class: 'pack__item' }, box('Tick when done'),
                 el('span', null, el('strong', null, title), el('span', { class: 'pack__why' }, `${why} `), el('span', { class: 'pack__ref' }, `See: ${ref}`)))))]
          : el('p', { class: 'pack__lead' }, p.own || p.scan?.analysis?.self
            ? 'Nothing big to fix. Your profile basics are in good shape, so put your time into the weekly routine.'
            : 'We have not checked this profile yet. Run a Google check, or add it on the Profiles page, to find fixes.')),

      block('Your twice-a-week routine',
        el('p', { class: 'pack__lead' },
          `Little and often beats one big push. Google trusts a steady flow. Goal: ${goal.perWeek} new review${goal.perWeek === 1 ? '' : 's'} a week. `,
          `That takes you from ${goal.mine} to about ${goal.by} by ${shortDay(c.start)}.`),
        el('table', { class: 'pack__grid' },
          el('caption', { class: 'visually-hidden' }, 'Four-week tick sheet'),
          el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Task'), [1, 2, 3, 4].map((w) => el('th', { scope: 'col' }, `Wk ${w}`)))),
          el('tbody', null, routine.flatMap(([when, tasks]) => [
            el('tr', { class: 'pack__grid-group' }, el('th', { scope: 'rowgroup', colspan: 5 }, when)),
            ...tasks.map((t) => el('tr', null, el('th', { scope: 'row' }, t), [1, 2, 3, 4].map((w) => el('td', null, box(`Week ${w}`))))),
          ]))),
        el('p', { class: 'pack__note' }, 'Never offer rewards for reviews, and never ask for set words. Honest, specific reviews work best.')),

      block(`New Year push: starts ${shortDay(c.start)}`,
        el('p', { class: 'pack__lead' }, 'The busiest joining weeks of the year. Google needs time to notice changes, so the work starts now.'),
        el('ol', { class: 'pack__timeline' }, phases.map(([from, to, title, tasks]) =>
          el('li', { class: 'pack__phase' },
            el('p', { class: 'pack__phase-when' }, `${shortDay(from > now ? from : now)} – ${shortDay(to)}`),
            el('h3', { class: 'pack__phase-title' }, title),
            el('ul', { class: 'pack__phase-tasks' }, tasks.map((t) => el('li', null, t))))))),

      block('Team York: a rising tide lifts all boats',
        el('p', { class: 'pack__lead' },
          'Every York group runs on its own day and time, so we are not rivals. When someone searches "Slimming World York", strong profiles make the whole brand look busy and trusted. They then pick the night that suits them.'),
        el('dl', { class: 'pack__team' },
          york.count > 0 && el('div', null, el('dt', null, 'York SW groups tracked'), el('dd', null, york.count)),
          york.count > 0 && el('div', null, el('dt', null, 'Have Google reviews'), el('dd', null, `${york.withReviews} of ${york.count}`)),
          york.count > 0 && el('div', null, el('dt', null, 'Team reviews in total'), el('dd', null, york.reviews)),
          p.team?.groups > 1 && el('div', null, el('dt', null, 'Spots near you with SW in the top 3'), el('dd', null, `${pct(p.team.teamTop3, p.team.points)}%`))),
        york.count > 1 && el('p', { class: 'pack__goal' },
          `If every York group gets 2 reviews a week until ${shortDay(c.start)}, the team adds about ${york.count * 2 * weeksToStart} reviews. Your share helps everyone.`)),

      block('Notes from today',
        el('div', { class: 'pack__notes', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Notes from today' })),

      el('footer', { class: 'pack__foot' }, `Next check-up: ${addDays(now, 28).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}. We will re-run the Google check and compare.`));

    render(header,
      el('section', { class: 'section pack-controls', 'aria-label': 'Pack options' },
        el('p', { class: 'section__lead pack-controls__lead' }, 'A hand-out for the group\'s consultant. Type notes into the pack, then print or save as PDF.'),
        el('div', { class: 'form__actions' },
          picker && el('div', { class: 'field' }, el('label', { class: 'visually-hidden', for: 'pack-scan' }, 'Google check to use'), picker),
          el('button', { class: 'button', type: 'button', onclick: () => window.print() }, 'Print or save as PDF')),
        !chosen && el('p', { class: 'notice notice--info' }, 'No scan yet, so the pack uses profile data only. Run a live scan for map stats.'),
        chosen?.mode === 'demo' && el('p', { class: 'notice notice--warn' }, 'This uses a DEMO scan. Pick a live one before printing.')),
      pack);
  }

  function stepCard(r, i, { loc, ctx, status, scanAt, open, onChange }) {
    const impactLabel = { high: 'High impact', medium: 'Medium impact', low: 'Low impact' }[r.impact];
    const node = el('details', { class: 'step', open });
    const chips = el('span', { class: 'step__chips' });
    const msg = el('p', { class: 'form__ok', role: 'status' });
    const actions = el('div', { class: 'step__actions' });

    const current = () => (status.get(r.id)?.done ? (status.get(r.id).note === 'skipped' ? 'skipped' : 'done') : 'todo');
    const paint = () => {
      const s = current();
      node.className = `step step--${s}`;
      chips.replaceChildren(...[
        el('span', { class: `chip chip--${r.impact}` }, impactLabel),
        s === 'done' && (status.get(r.id)?.updated_at && status.get(r.id).updated_at < scanAt
          ? el('span', { class: 'chip chip--flag', title: 'You marked this done before this scan, but the scan still shows the gap. Check the change went live.' }, 'Done · still flagged')
          : el('span', { class: 'chip chip--done' }, 'Done')),
        s === 'skipped' && el('span', { class: 'chip chip--skipped' }, 'Skipped'),
        el('span', { class: 'step__chevron', 'aria-hidden': 'true' })].filter(Boolean));
      actions.replaceChildren(...(s === 'todo'
        ? [
            el('button', { class: 'button button--ok button--small', type: 'button', onclick: () => save('done') }, 'Mark as done'),
            el('button', { class: 'button button--ghost button--small', type: 'button', onclick: () => save('skipped') }, 'Not relevant – skip'),
          ]
        : [el('button', { class: 'button button--ghost button--small', type: 'button', onclick: () => save('todo') }, 'Move back to to-do')]),
        msg);
    };

    async function save(next) {
      actions.querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        await api(`/locations/${loc.id}/checklist/plan-${r.id}`, { method: 'PUT', body: { done: next !== 'todo', note: next === 'skipped' ? 'skipped' : '' } });
        if (next === 'done') await api(`/locations/${loc.id}/changes`, { method: 'POST', body: { happened_on: today(), note: r.title } });
        status.set(r.id, { done: next !== 'todo' ? 1 : 0, note: next === 'skipped' ? 'skipped' : '', updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
        paint();
        onChange();
        msg.textContent = next === 'done' ? 'Logged in Progress. Re-scan in 2–3 weeks to see the effect.' : '';
        if (next !== 'todo') {
          node.open = false;
          const nextStep = node.nextElementSibling;
          if (nextStep?.classList.contains('step--todo')) nextStep.open = true;
        }
      } catch (err) {
        msg.textContent = err.message;
        actions.querySelectorAll('button').forEach((b) => (b.disabled = false));
      }
    }

    node.append(
      el('summary', { class: 'step__head' },
        el('span', { class: 'step__num', 'aria-hidden': 'true' }, String(i + 1)),
        el('span', null, el('h3', { class: 'step__title' }, r.title), el('span', { class: 'step__summary' }, r.evidence)),
        chips),
      el('div', { class: 'step__body' },
        el('p', { class: 'step__why' }, el('strong', null, 'Why it matters: '), r.why),
        el('div', null, el('p', { class: 'step__howtitle' }, 'How to do it'), el('ol', { class: 'step__how' }, r.how.map((h) => el('li', null, h)))),
        ctx && aiPanel(window.GR_PROMPTS.rec(r, ctx)),
        el('span', { class: 'chip chip--basis', title: 'Strength of evidence behind this step' }, `Evidence: ${r.basis}`),
        actions));
    paint();
    return node;
  }

  const deltaClass = (d) => (typeof d === 'string' && d.startsWith('▲') ? ' stats__delta--up' : typeof d === 'string' && d.startsWith('▼') ? ' stats__delta--down' : '');
  const stat = (label, value, delta) => el('div', { class: 'stats__item' }, el('dt', { class: 'stats__label' }, label), el('dd', { class: 'stats__value' }, value, delta && el('span', { class: `stats__delta${deltaClass(delta)}` }, delta)));

  function leaderTable(a) {
    const rows = [];
    if (a.self) rows.push(listingRow({ ...a.self, top3Share: pct(a.self.top3, a.points), appearShare: pct(a.self.found, a.points), distanceKm: 0 }, true));
    a.competitors.slice(0, 8).forEach((c) => rows.push(listingRow(c, false)));
    if (!rows.length) return el('p', { class: 'empty' }, 'No competitor data in this scan.');
    return table('Your listing compared with the leaders', ['Business', 'Primary category', 'Rating', 'Reviews', 'Photos', 'Top 3 at', 'In top 20 at', 'Distance'], rows, [2, 3, 4, 5, 6, 7]);
  }

  function listingRow(c, self) {
    return el('tr', { class: self ? 'table__row--self' : null },
      td(self ? `${c.title} (you)` : c.title),
      td(c.category),
      td(c.rating != null ? `${c.rating}★` : 'None', true),
      td(c.reviews ?? (c.rating == null ? 'None' : null), true),
      td(c.photos, true),
      td(`${c.top3Share}%`, true),
      td(`${c.appearShare}%`, true),
      td(self ? '–' : c.distanceKm != null ? `${c.distanceKm} km${c.direction ? ` ${c.direction}` : ''}` : null, true));
  }

  function reachView(a) {
    const r = a.reach;
    return el('div', { class: 'grid-2' },
      el('div', null,
        el('h3', { class: 'section__title' }, 'By distance from your pin'),
        table('Rank by distance band', ['Distance', 'In top 20', 'In top 3'], r.bands.map((b) =>
          el('tr', null, td(b.to == null || b.to === Infinity ? `${b.from}+ km` : `${b.from}–${b.to} km`), td(`${b.foundShare}%`, true), td(`${b.top3Share}%`, true))), [1, 2]),
        el('p', { class: 'field__hint' }, 'Distance is one of Google’s three official factors. Drop-off with distance is normal.')),
      el('div', null,
        el('h3', { class: 'section__title' }, 'By direction'),
        table('Rank by direction', ['Direction', 'Avg rank', 'Top 3', 'Most often #1'], r.sectors.map((s) =>
          el('tr', null, td(s.name), td(s.avgRank, true), td(`${s.top3} of ${s.n}`, true), td(s.winner || 'You'))), [1, 2]),
        el('p', { class: 'field__hint' }, 'Average rank counts "not in top 20" as 21.')));
  }

  /* ---------- Run a scan ---------- */

  function tabScan(d, header) {
    const loc = d.location;
    const keywords = [...new Set(d.scans.map((s) => s.keyword))];
    const keyword = input({ name: 'keyword', required: true, maxlength: 80, list: 'kw-list' });
    const size = select({ name: 'size' }, [3, 5, 7, 9].map((n) => [n, `${n} × ${n} (${n * n} points)`, n === 7]));
    const spacing = input({ name: 'spacing', type: 'number', min: 0.1, max: 5, step: 0.1, value: 1, required: true });
    const zoom = input({ name: 'zoom', type: 'number', min: 11, max: 18, step: 1, value: 13, required: true });
    const repeat = el('input', { type: 'checkbox', name: 'repeat', id: 'repeat' });
    const every = select({ name: 'every', 'aria-label': 'Repeat interval', class: 'field__input field__input--inline' }, [[7, 'every week', true], [14, 'every 2 weeks'], [30, 'every month']]);
    const error = el('p', { class: 'form__error', role: 'alert' });
    const cost = el('p', { class: 'field__hint' });

    const option = (value, title, desc, disabled) =>
      el('label', { class: 'choice__item' },
        el('input', { type: 'radio', name: 'mode', value, checked: value === (config.live ? 'live' : 'demo'), disabled }),
        el('span', null, el('span', { class: 'choice__title' }, title), el('span', { class: 'choice__desc' }, desc)));

    const updateCost = () => {
      const n = Number(size.value) ** 2;
      cost.textContent = `Live cost about ${money(n * COST_PER_POINT)} (${n} × $0.0006). This month: ${money(config.spent)} of ${money(config.cap)}. Results take a few minutes.`;
    };
    size.addEventListener('change', updateCost);
    updateCost();

    const form = el('form', { class: 'form', novalidate: true },
      el('datalist', { id: 'kw-list' }, keywords.map((k) => el('option', { value: k }))),
      el('div', { class: 'form__row' },
        field('Keyword', keyword, 'What a NEW customer types, e.g. "weight loss group". Avoid your brand name.'),
        field('Grid', size),
        field('Spacing (km)', spacing, '1 km suits towns. Use 0.3–0.5 in cities.'),
        field('Map zoom', zoom, '13 suits most towns.')),
      el('fieldset', { class: 'fieldset' },
        el('legend', { class: 'fieldset__legend' }, 'Data'),
        el('div', { class: 'choice' },
          option('live', 'Live Google Maps data', config.live ? 'Real rankings from DataForSEO. Feeds your action plan.' : 'Not set up yet. Add your DataForSEO login in Cloudflare.', !config.live),
          option('demo', 'Demo', 'Made-up data to try the tool. Free.', false)),
        cost),
      el('div', { class: 'fieldset__option' }, repeat, el('label', { for: 'repeat' }, 'Repeat this live scan automatically'), every),
      error,
      el('div', { class: 'form__actions' }, el('button', { class: 'button', type: 'submit' }, 'Run scan')));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const mode = form.querySelector('input[name=mode]:checked').value;
      const body = { location_id: loc.id, keyword: keyword.value, size: size.value, spacing_km: spacing.value, zoom: zoom.value, mode };
      if (repeat.checked && mode !== 'live') {
        error.textContent = 'Only live scans can repeat. Pick Live, or untick Repeat.';
        return;
      }
      busy(form, true);
      try {
        const r = await api('/scans', { method: 'POST', body });
        if (repeat.checked) await api('/schedules', { method: 'POST', body: { ...body, every_days: every.value } });
        location.hash = `#/scan/${r.id}`;
      } catch (err) {
        error.textContent = err.message;
        busy(form, false);
      }
    });

    render(header, section('Run a scan', form), section('Picking keywords',
      el('ul', { class: 'tips' },
        el('li', null, 'Track 2–3 service keywords per location, the ones that bring paying customers.'),
        el('li', null, 'Brand searches ("slimming world") show one listing only. They make the map look perfect and teach you nothing.'),
        el('li', null, 'Keep the same keyword, grid and spacing over time, so scans can be compared.'))));
  }

  /* ---------- Progress ---------- */

  function tabProgress(d, header) {
    const loc = d.location;
    const done = d.scans.filter((s) => s.status === 'done' && s.done_points);
    const liveCount = done.reduce((m, s) => (s.mode === 'live' ? m.set(s.keyword.toLowerCase(), (m.get(s.keyword.toLowerCase()) || 0) + 1) : m), new Map());
    // Default to the keyword with the most live scans: that is the one with a trend to show.
    const keywords = [...new Set(done.map((s) => s.keyword.toLowerCase()))].sort((a, b) => (liveCount.get(b) || 0) - (liveCount.get(a) || 0));
    const kwPicker = select({ name: 'trend-kw', 'aria-label': 'Keyword' }, keywords.map((k, i) => [k, k, i === 0]));
    const chartBox = el('div');
    const drawChart = () => {
      const series = done.filter((s) => s.keyword.toLowerCase() === kwPicker.value && s.mode === 'live').slice().reverse();
      chartBox.replaceChildren(series.length >= 2
        ? trendChart(series, d.changes)
        : el('p', { class: 'empty' }, series.length ? 'One live scan so far. Run another (or set it to repeat) to see a trend.' : 'No live scans for this keyword yet.'));
    };
    kwPicker.addEventListener('change', drawChart);
    if (keywords.length) drawChart();

    // Change log
    const noteIn = el('textarea', { class: 'field__input', name: 'note', rows: 2, maxlength: 500, required: true });
    const dayIn = input({ name: 'day', type: 'date', value: today(), max: today(), required: true });
    const changeErr = el('p', { class: 'form__error', role: 'alert' });
    const changeForm = el('form', { class: 'form', novalidate: true },
      el('div', { class: 'form__row' }, field('What did you change?', noteIn, 'e.g. "Primary category to Weight loss service" or "New service page live".'), field('When', dayIn)),
      changeErr,
      el('div', { class: 'form__actions' }, el('button', { class: 'button', type: 'submit' }, 'Log change')));
    changeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      busy(changeForm, true);
      try {
        await api(`/locations/${loc.id}/changes`, { method: 'POST', body: { note: noteIn.value, happened_on: dayIn.value } });
        route();
      } catch (err) {
        changeErr.textContent = err.message;
        busy(changeForm, false);
      }
    });
    const changes = d.changes.length
      ? el('ol', { class: 'changes' }, d.changes.map((c, i) =>
          el('li', { class: 'changes__item' },
            el('span', { class: 'changes__num' }, String(d.changes.length - i)),
            el('div', null, el('span', { class: 'changes__date' }, fmtDay(c.happened_on)), c.note),
            el('button', { class: 'link-button', type: 'button', 'aria-label': `Delete change: ${c.note}`, onclick: async () => {
              if (!confirm('Delete this change?')) return;
              await api(`/changes/${c.id}`, { method: 'DELETE' }).catch(fail);
              route();
            } }, 'Delete'))))
      : el('p', { class: 'empty' }, 'Nothing logged yet. Log every change, so you can tell what worked.');

    // History with compare
    const picked = new Set();
    const compareBtn = el('button', { class: 'button', type: 'button', disabled: true }, 'Compare 2 selected');
    compareBtn.addEventListener('click', () => {
      const [a, b] = [...picked];
      location.hash = `#/compare/${a}/${b}`;
    });
    const rows = d.scans.map((s) => {
      const box = el('input', { type: 'checkbox', 'aria-label': `Select scan from ${fmtDate(s.created_at)} for comparison`, disabled: s.status !== 'done' });
      box.addEventListener('change', () => {
        if (box.checked) picked.add(s.id);
        else picked.delete(s.id);
        if (picked.size > 2) {
          box.checked = false;
          picked.delete(s.id);
        }
        compareBtn.disabled = picked.size !== 2;
      });
      return el('tr', null,
        el('td', { class: 'table__cell' }, box),
        td(el('a', { href: `#/scan/${s.id}` }, fmtDate(s.created_at))),
        td(s.keyword),
        td(`${s.size}×${s.size} · ${s.spacing_km} km`),
        td(s.mode === 'live' ? 'Live' : 'Demo'),
        td(s.status === 'done' ? 'Done' : 'Waiting'),
        td(s.done_points ? `${pct(s.top3, s.done_points)}%` : null, true),
        td(s.done_points ? `${pct(s.found, s.done_points)}%` : null, true),
        td(s.avg_rank == null ? null : s.avg_rank.toFixed(1), true),
        td(money(s.cost), true));
    });

    render(
      header,
      el('section', { class: 'section', 'aria-labelledby': 'trend-title' },
        el('div', { class: 'section__head' },
          el('h2', { class: 'section__title', id: 'trend-title' }, 'Share of points where you are top 3'),
          keywords.length > 1 && kwPicker),
        keywords.length ? chartBox : el('p', { class: 'empty' }, 'Run a live scan to start tracking.'),
        el('p', { class: 'field__hint' }, 'Dashed lines are logged changes (numbers match the change log). Live scans only.')),
      el('div', { class: 'grid-2' },
        section('Change log', changes),
        section('Log a change', changeForm)),
      el('section', { class: 'section', 'aria-labelledby': 'hist-title' },
        el('div', { class: 'section__head' }, el('h2', { class: 'section__title', id: 'hist-title' }, 'Scan history'), compareBtn),
        d.scans.length
          ? table(`Scan history for ${loc.name}`, ['', 'Date', 'Keyword', 'Grid', 'Data', 'Status', 'Top 3', 'Top 20', 'Avg rank', 'Cost'], rows, [6, 7, 8, 9])
          : el('p', { class: 'empty' }, 'No scans yet.')),
    );
  }

  function trendChart(series, changes) {
    const W = 680, H = 240, padL = 40, padR = 16, padT = 20, padB = 30;
    const times = series.map((s) => toDate(s.created_at).getTime());
    const changeTimes = changes.map((c) => toDate(`${c.happened_on}T12:00:00Z`).getTime());
    const t0 = Math.min(...times);
    const t1 = Math.max(...times);
    const span = Math.max(t1 - t0, 864e5);
    const x = (t) => padL + ((t - t0) / span) * (W - padL - padR);
    const y = (v) => padT + (1 - v / 100) * (H - padT - padB);
    const vals = series.map((s) => pct(s.top3, s.done_points));
    const tip = el('div', { class: 'chart__tip', hidden: true });
    const box = el('div', { class: 'chart' });

    const grid = [0, 25, 50, 75, 100].map((v) => [
      svg('line', { class: 'chart__grid', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }),
      svg('text', { class: 'chart__axis', x: padL - 6, y: y(v) + 4, 'text-anchor': 'end' }, `${v}%`),
    ]);
    const xLabels = [t0, t1].map((t, i) => svg('text', { class: 'chart__axis', x: x(t), y: H - 8, 'text-anchor': i ? 'end' : 'start' }, fmtDay(new Date(t).toISOString())));
    const marks = changes
      .map((c, i) => ({ t: changeTimes[i], n: changes.length - i }))
      .filter((c) => c.t >= t0 && c.t <= t1)
      .map((c) => [
        svg('line', { class: 'chart__change', x1: x(c.t), x2: x(c.t), y1: padT, y2: H - padB }),
        svg('text', { class: 'chart__change-label', x: x(c.t) + 3, y: padT - 6 }, String(c.n)),
      ]);
    const path = svg('path', { class: 'chart__line', d: series.map((_, i) => `${i ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(vals[i]).toFixed(1)}`).join(' ') });
    const dots = series.map((s, i) => {
      const label = `${fmtDay(s.created_at)}: top 3 at ${vals[i]}%, in top 20 at ${pct(s.found, s.done_points)}%${s.avg_rank != null ? `, avg rank ${s.avg_rank.toFixed(1)}` : ''}`;
      const show = () => {
        tip.textContent = label;
        tip.hidden = false;
        const r = box.getBoundingClientRect();
        tip.style.left = `${(x(times[i]) / W) * r.width}px`;
        tip.style.top = `${(y(vals[i]) / H) * r.height}px`;
      };
      const hide = () => (tip.hidden = true);
      return [
        svg('circle', { class: 'chart__hit', cx: x(times[i]), cy: y(vals[i]), r: 14, tabindex: 0, role: 'img', 'aria-label': label, onmouseenter: null }),
        svg('circle', { class: 'chart__dot', cx: x(times[i]), cy: y(vals[i]), r: 5 }),
      ].map((n, k) => {
        if (k === 0) {
          n.addEventListener('mouseenter', show);
          n.addEventListener('focus', show);
          n.addEventListener('mouseleave', hide);
          n.addEventListener('blur', hide);
        }
        return n;
      });
    });
    box.append(svg('svg', { class: 'chart__svg', viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Top 3 share over time' }, grid, xLabels, marks, path, dots), tip);
    return box;
  }

  /* ---------- Checklist ---------- */

  async function tabChecklist(d, header) {
    const loc = d.location;
    const latest = d.scans.find((s) => s.status === 'done' && s.mode === 'live') || d.scans.find((s) => s.status === 'done');
    let ctx = null;
    if (window.GR_PROMPTS) {
      const analysis = latest ? (await api(`/scans/${latest.id}`).catch(() => null))?.analysis : null;
      ctx = window.GR_PROMPTS.context(loc, analysis, latest?.keyword);
    }
    const state = new Map(d.checklist.filter((c) => !c.item.startsWith('plan-')).map((c) => [c.item, c]));
    const total = CHECKLIST.reduce((n, [, items]) => n + items.length, 0);
    const bar = el('div', { class: 'progress__bar' });
    const count = el('p', { class: 'meta' });
    const update = () => {
      const doneN = [...state.values()].filter((c) => c.done).length;
      bar.style.width = `${pct(doneN, total)}%`;
      count.textContent = `${doneN} of ${total} done`;
    };
    update();

    const save = async (item, patch, node) => {
      const cur = { done: 0, note: '', ...state.get(item), ...patch };
      state.set(item, { item, ...cur });
      update();
      try {
        await api(`/locations/${loc.id}/checklist/${item}`, { method: 'PUT', body: { done: Boolean(cur.done), note: cur.note || '' } });
      } catch (err) {
        node.setAttribute('aria-invalid', 'true');
        alert(err.message);
      }
    };

    const groups = CHECKLIST.map(([group, items]) =>
      el('fieldset', { class: 'checklist__group' },
        el('legend', { class: 'checklist__legend' }, group),
        items.map(([key, label, why]) => {
          const cur = state.get(key) || {};
          const id = `c-${key}`;
          const item = el('div', { class: `checklist__item${cur.done ? ' checklist__item--done' : ''}` });
          const box = el('input', { class: 'checklist__box', type: 'checkbox', id, checked: Boolean(cur.done), 'aria-describedby': `${id}-why` });
          const note = input({ class: 'field__input checklist__note', name: `${key}-note`, placeholder: 'Note (optional)', value: cur.note || '', maxlength: 500, 'aria-label': `Note for: ${label}` });
          box.addEventListener('change', () => {
            item.classList.toggle('checklist__item--done', box.checked);
            save(key, { done: box.checked ? 1 : 0, note: note.value }, box);
          });
          note.addEventListener('change', () => save(key, { done: box.checked ? 1 : 0, note: note.value }, note));
          const ai = ctx && aiPanel(window.GR_PROMPTS.checklist(key, ctx), 'Get AI to draft this');
          if (ai) ai.classList.add('checklist__ai');
          item.append(...[
            box,
            el('label', { class: 'checklist__label', for: id }, label, ai && el('span', { class: 'chip chip--ai', title: 'AI prompt available', style: 'margin-left:8px' }, '✦ AI')),
            el('p', { class: 'checklist__why', id: `${id}-why` }, why),
            note,
            ai,
          ].filter(Boolean));
          return item;
        })));

    render(header, section('Listing checklist',
      el('p', { class: 'section__lead' }, 'The basics the scan can’t check for you. Work top to bottom. Items marked ✦ have an AI prompt to draft the work. Saved as you go.'),
      el('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Checklist progress', 'aria-valuemin': 0, 'aria-valuemax': total }, bar),
      count,
      el('div', { class: 'checklist' }, groups)));
  }

  /* ---------- Settings ---------- */

  function tabSettings(d, header) {
    const loc = d.location;
    const status = el('p', { class: 'form__ok', role: 'status' });
    const form = locationForm(loc, async (body) => {
      await api(`/locations/${loc.id}`, { method: 'PATCH', body });
      status.textContent = 'Saved.';
      setTimeout(route, 600);
    });
    const schedules = d.schedules.length
      ? table('Repeating scans', ['Keyword', 'Grid', 'Repeats', 'Next run', ''], d.schedules.map((s) =>
          el('tr', null,
            td(s.keyword),
            td(`${s.size}×${s.size} · ${s.spacing_km} km · z${s.zoom}`),
            td(`every ${s.every_days} days`),
            td(fmtDate(s.next_run)),
            td(el('button', { class: 'link-button', type: 'button', onclick: async () => {
              if (!confirm(`Stop repeating "${s.keyword}"?`)) return;
              await api(`/schedules/${s.id}`, { method: 'DELETE' }).catch(fail);
              route();
            } }, 'Stop')))))
      : el('p', { class: 'empty' }, 'No repeating scans. Tick "Repeat" on the Run a scan tab to add one.');
    const del = el('button', { class: 'button button--danger', type: 'button', onclick: async () => {
      if (!confirm(`Delete ${loc.name}, its scans, checklist and change log? This cannot be undone.`)) return;
      await api(`/locations/${loc.id}`, { method: 'DELETE' }).catch(fail);
      location.hash = '#/';
    } }, 'Delete location');
    render(header, section('Edit location', form.node, status), section('Repeating scans', schedules), section('Danger zone', del));
    form.init();
  }

  /* ---------- Scan report ---------- */

  function drawGrid(map, pts, home, iconFor, popupFor) {
    L.marker([home.lat, home.lng], { icon: homeIcon(), title: home.name, keyboard: false, zIndexOffset: 1000 }).addTo(map);
    const layer = L.layerGroup().addTo(map);
    const draw = (iconFn) => {
      layer.clearLayers();
      pts.forEach((p) => {
        const [cls, html, title] = iconFn(p);
        L.marker([p.lat, p.lng], { icon: L.divIcon({ className: `pin pin--${cls}`, html, iconSize: [30, 30] }), title: title || html })
          .bindPopup(popupFor(p))
          .addTo(layer);
      });
    };
    draw(iconFor);
    map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])).pad(0.08));
    return draw;
  }

  // Places gained (+) or lost (−) at a point since an earlier scan. "Not in top 20" counts as 21.
  const pointDelta = (p, q) => (q && p.status === 'done' && q.status === 'done' ? (q.rank ?? 21) - (p.rank ?? 21) : null);
  const deltaBadge = (v) =>
    v == null || v === 0 ? '' : `<span class="pin__delta pin__delta--${v > 0 ? 'up' : 'down'}">${v > 0 ? '▲' : '▼'}${Math.abs(v)}</span>`;
  const signed = (v, digits = 0, unit = '', invert = false) => {
    if (v == null || !Number.isFinite(v) || Math.abs(v) < 10 ** -digits / 2) return v == null ? null : '(no change)';
    const good = invert ? v < 0 : v > 0;
    return `${good ? '▲' : '▼'} ${Math.abs(v).toFixed(digits)}${unit}`;
  };

  function rankPopup(p) {
    return el('div', null,
      el('p', { class: 'popup__title' }, `Rank: ${rankLabel(p)}`),
      p.prev && el('p', null, `Previous scan: ${rankLabel(p.prev)}${p.delta ? ` (${p.delta > 0 ? 'up' : 'down'} ${Math.abs(p.delta)})` : ' (no change)'}`),
      p.error && el('p', null, `Error: ${p.error}`),
      p.top?.length ? el('ol', { class: 'popup__list' }, p.top.map((t) =>
        el('li', { class: t.you ? 'popup__you' : null }, `${t.title}${t.rating ? ` (${t.rating}★${t.reviews != null ? `, ${t.reviews}` : ''})` : ''}`))) : null);
  }

  const legend = (items) => el('ul', { class: 'legend', 'aria-label': 'Key' }, items.map(([k, label]) => el('li', { class: 'legend__item' }, el('span', { class: `legend__swatch legend__swatch--${k}` }), label)));

  function viewScan(d, readOnly, reload) {
    const s = d.scan;
    const pts = d.points;
    const st = scanStats(pts);
    const prevByIdx = new Map((d.previous?.points || []).map((q) => [q.idx, q]));
    pts.forEach((p) => {
      p.prev = prevByIdx.get(p.idx) || null;
      p.delta = pointDelta(p, p.prev);
    });
    const ps = d.previous ? scanStats(d.previous.points) : null;
    const moves = pts.map((p) => p.delta).filter((v) => v != null);
    const showChange = el('input', { type: 'checkbox', id: 'show-change', checked: true });
    const errored = pts.filter((p) => p.status === 'error');
    const pendingN = pts.filter((p) => p.status === 'pending').length;
    const mapNode = el('div', { class: 'map', role: 'region', 'aria-label': 'Rank grid map' });

    let actions = null;
    if (!readOnly) {
      const out = el('div', { class: 'share' });
      const shareBtn = el('button', { class: 'button button--ghost', type: 'button' }, 'Create share link');
      shareBtn.addEventListener('click', async () => {
        shareBtn.disabled = true;
        try {
          const r = await api(`/scans/${s.id}/share`, { method: 'POST' });
          const box = input({ value: r.url, readonly: true, 'aria-label': 'Share link', class: 'field__input share__url' });
          const copy = el('button', { class: 'button', type: 'button' }, 'Copy');
          copy.addEventListener('click', () => navigator.clipboard.writeText(r.url).then(() => (copy.textContent = 'Copied')));
          out.replaceChildren(box, copy);
        } catch (err) {
          fail(err);
        }
      });
      out.append(shareBtn);
      actions = section('Share', el('p', { class: 'meta' }, 'Anyone with the link can see the map and competitors. Your action plan stays private.'), out);
    }

    const waiting = s.status === 'pending' && el('p', { class: 'notice' },
      `Waiting for Google results: ${pts.length - pendingN} of ${pts.length} points back. This page updates by itself. `,
      !readOnly && el('button', { class: 'button button--ghost button--small', type: 'button', onclick: async (e) => {
        e.target.disabled = true;
        await api(`/scans/${s.id}/refresh`, { method: 'POST' }).catch(fail);
        reload();
      } }, 'Check now'));

    const a = d.analysis;
    render(
      !readOnly && el('nav', { class: 'crumb', 'aria-label': 'Breadcrumb' }, el('a', { href: `#/loc/${s.location_id}/progress` }, `← ${d.location.name}`)),
      el('section', { class: 'section', 'aria-labelledby': 'report-title' },
        el('h1', { class: 'page-title', id: 'report-title' }, `"${s.keyword}"`, el('span', { class: 'page-title__sub' }, d.location.name)),
        el('p', { class: 'meta' },
          `Google Maps (DataForSEO “search this area”) · ${s.size}×${s.size} grid · ${s.spacing_km} km apart · zoom ${s.zoom} · run ${fmtDate(s.created_at)}${s.completed_at ? ` · finished ${fmtDate(s.completed_at)}` : ''}`),
        !readOnly && a && el('p', null, el('a', { class: 'button', href: `#/loc/${s.location_id}/plan/${s.id}` }, 'Open the action plan for this scan'))),
      s.mode === 'demo' && el('p', { class: 'notice notice--warn', role: 'note' }, 'Demo scan. These ranks are simulated, not real Google results.'),
      waiting,
      errored.length > 0 && el('p', { class: 'notice notice--warn', role: 'alert' }, `${errored.length} of ${pts.length} points failed. DataForSEO said: ${errored[0].error || 'no reason given'}`),
      el('section', { class: 'section', 'aria-label': 'Map' },
        ps && el('div', { class: 'notice notice--info', style: 'margin-bottom:12px' },
          el('strong', null, `Since ${fmtDay(d.previous.created_at)}:`),
          el('span', { class: 'move move--up' }, `▲ ${moves.filter((v) => v > 0).length} up`),
          el('span', { class: 'move move--down' }, `▼ ${moves.filter((v) => v < 0).length} down`),
          el('span', { class: 'move' }, `${moves.filter((v) => v === 0).length} same`),
          el('label', { class: 'fieldset__option', style: 'margin-left:auto' }, showChange, 'Show arrows on the map'),
          !readOnly && el('a', { href: `#/compare/${d.previous.id}/${s.id}` }, 'Full comparison')),
        mapNode,
        legend([['top', '1–3'], ['mid', '4–10'], ['low', '11–20'], ['none', 'Not in top 20'], ['wait', 'Waiting or error']]),
        ps && el('p', { class: 'field__hint', style: 'margin-top:6px' }, 'Arrows show places gained ▲ or lost ▼ at each point since the previous scan with the same keyword and grid.')),
      section('Summary', el('dl', { class: 'stats' },
        stat('Top 3 at', `${st.top3}%`, ps && signed(st.top3 - ps.top3, 0, ' pts')),
        stat('In top 20 at', `${st.found}%`, ps && signed(st.found - ps.found, 0, ' pts')),
        stat('Average rank (where found)', st.avg == null ? '–' : st.avg.toFixed(1), ps && st.avg != null && ps.avg != null && signed(st.avg - ps.avg, 1, '', true)),
        !readOnly && stat('Data cost', s.mode === 'live' ? money(s.cost) : '$0'))),
      a && section('Who you are up against', leaderTable(a)),
      a && section('How far your ranking reaches', reachView(a)),
      actions);

    const map = baseMap(mapNode, [d.location.lat, d.location.lng], 13);
    const plain = (p) => [rankClass(p), rankLabel(p)];
    const withArrows = (p) => [rankClass(p), `${rankLabel(p)}${deltaBadge(p.delta)}`, `Rank ${rankLabel(p)}${p.delta ? `, ${p.delta > 0 ? 'up' : 'down'} ${Math.abs(p.delta)}` : ''}`];
    const redraw = drawGrid(map, pts, d.location, ps ? withArrows : plain, rankPopup);
    showChange.addEventListener('change', () => redraw(showChange.checked ? withArrows : plain));
  }

  async function loadScan(id, readOnly) {
    const mine = renderId;
    const path = readOnly ? `/share/${id}` : `/scans/${id}`;
    const reload = async () => {
      if (mine !== renderId) return;
      const d = await api(path);
      if (mine !== renderId) return;
      viewScan(d, readOnly, reload);
      if (d.scan.status === 'pending') setTimeout(() => reload().catch(fail), 20000);
    };
    return reload();
  }

  /* ---------- Compare ---------- */

  async function viewCompare(a, b) {
    const d = await api(`/compare/${a}/${b}`);
    const before = d.before;
    const after = d.after;
    const sb = scanStats(before.points);
    const sa = scanStats(after.points);
    const beforeByIdx = new Map(before.points.map((p) => [p.idx, p]));
    const mapNode = el('div', { class: 'map', role: 'region', 'aria-label': 'Change in rank at each point' });
    const delta = (p) => {
      const q = beforeByIdx.get(p.idx);
      if (!q || p.status !== 'done' || q.status !== 'done') return null;
      return (q.rank ?? 21) - (p.rank ?? 21); // positive = moved up
    };
    const moves = after.points.map(delta).filter((v) => v != null);
    const up = moves.filter((v) => v > 0).length;
    const down = moves.filter((v) => v < 0).length;
    const fmtDelta = (v, invert, unit = '') => {
      if (v == null || !Number.isFinite(v)) return null;
      const good = invert ? v < 0 : v > 0;
      return v === 0 ? '(no change)' : `(${v > 0 ? '+' : ''}${Number.isInteger(v) ? v : v.toFixed(1)}${unit} ${good ? 'better' : 'worse'})`;
    };

    render(
      el('nav', { class: 'crumb', 'aria-label': 'Breadcrumb' }, el('a', { href: `#/loc/${before.scan.location_id}/progress` }, `← ${before.location.name}`)),
      el('section', { class: 'section', 'aria-labelledby': 'cmp-title' },
        el('h1', { class: 'page-title', id: 'cmp-title' }, 'Before and after', el('span', { class: 'page-title__sub' }, before.location.name)),
        el('p', { class: 'meta' }, `Before: "${before.scan.keyword}" ${fmtDate(before.scan.created_at)} · After: "${after.scan.keyword}" ${fmtDate(after.scan.created_at)}`)),
      !d.same && el('p', { class: 'notice notice--warn', role: 'alert' }, 'These scans use a different keyword, grid size or spacing. The point-by-point comparison is not meaningful.'),
      (before.scan.mode === 'demo' || after.scan.mode === 'demo') && el('p', { class: 'notice notice--warn' }, 'At least one scan is a demo (simulated).'),
      section('What changed', el('dl', { class: 'stats' },
        stat('Top 3 at', `${sa.top3}%`, fmtDelta(sa.top3 - sb.top3, false, ' pts')),
        stat('In top 20 at', `${sa.found}%`, fmtDelta(sa.found - sb.found, false, ' pts')),
        stat('Average rank (all points)', sa.avgAll == null ? '–' : sa.avgAll.toFixed(1), fmtDelta(sa.avgAll - sb.avgAll, true)),
        stat('Points moved', `${up} up · ${down} down`))),
      d.same && el('section', { class: 'section', 'aria-label': 'Change map' }, mapNode,
        legend([['up', 'Moved up'], ['same', 'No change'], ['down', 'Moved down']]),
        el('p', { class: 'field__hint' }, 'Numbers show places gained (+) or lost (−). "Not in top 20" counts as 21.')));

    if (d.same) {
      const map = baseMap(mapNode, [after.location.lat, after.location.lng], 13);
      drawGrid(map, after.points, after.location, (p) => {
        const v = delta(p);
        if (v == null) return ['wait', '?'];
        return [v > 0 ? 'up' : v < 0 ? 'down' : 'same', v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '='];
      }, (p) => {
        const q = beforeByIdx.get(p.idx);
        return el('p', null, `Before: ${q ? rankLabel(q) : '?'} → After: ${rankLabel(p)}`);
      });
    }
  }

  /* ---------- Profiles (compare all tracked profiles) ---------- */

  const reviewsLabel = (p) => (p.reviews != null ? p.reviews : p.rating == null && p.updated_at ? 0 : null);

  let profilePeriod = 30;
  const diff = (now, before) => (now != null && before != null ? +(now - before).toFixed(2) : null);
  const arrow = (v, digits = 0) =>
    v == null ? null : v === 0
      ? el('span', { class: 'delta delta--same', title: 'No change' }, '=')
      : el('span', { class: `delta delta--${v > 0 ? 'up' : 'down'}`, title: `${v > 0 ? 'Up' : 'Down'} ${Math.abs(v).toFixed(digits)}` }, `${v > 0 ? '▲' : '▼'}${Math.abs(v).toFixed(digits)}`);

  function baselineNote(list) {
    const days = list.map((p) => p.base_day).filter(Boolean).sort();
    if (!days.length) return el('span', { class: 'meta' }, 'Arrows appear after a profile has been tracked for at least a day.');
    const want = profilePeriod ? new Date(Date.now() - profilePeriod * 864e5).toISOString().slice(0, 10) : null;
    const short = want && days[days.length - 1] > want;
    return el('span', { class: 'meta' }, short
      ? `Not enough history yet for the full period: comparing with ${fmtDay(days[0])}${days[0] !== days[days.length - 1] ? `–${fmtDay(days[days.length - 1])}` : ''}.`
      : `Comparing with ${fmtDay(days[0])}${days[0] !== days[days.length - 1] ? ` to ${fmtDay(days[days.length - 1])}` : ''}.`);
  }

  async function viewProfiles() {
    updateHeader(null);
    const d = await api(`/profiles?days=${profilePeriod}`);
    const profiles = d.profiles.map((p) => {
      const reviewsN = reviewsLabel(p);
      const baseReviews = p.base_day ? p.base_reviews ?? (p.base_rating == null ? 0 : null) : null;
      return {
        ...p,
        reviewsN,
        dRating: p.base_day ? diff(p.rating, p.base_rating) : null,
        gain: p.base_day ? diff(reviewsN, baseReviews) : null,
        dPhotos: p.base_day ? diff(p.photos, p.base_photos) : null,
      };
    });
    const groups = [...new Set(profiles.map((p) => p.grp))].sort();
    let filter = 'all';
    let query = '';
    let sort = { key: 'reviewsN', dir: -1 };

    const COLS = [
      ['name', 'Business', 'text'],
      ['grp', 'Group', 'text'],
      ['category', 'Primary category', 'text'],
      ['rating', 'Rating', 'num'],
      ['reviewsN', 'Reviews', 'num'],
      ['gain', 'Review growth', 'num'],
      ['photos', 'Photos', 'num'],
      ['claimed', 'Claimed', 'flag'],
      ['has_hours', 'Hours', 'flag'],
      ['website', 'Website', 'flag'],
      ['updated_at', 'Updated', 'text'],
    ];
    const tableBox = el('div');
    const summaryBox = el('div');
    const groupList = el('datalist', { id: 'grp-list' }, groups.map((g) => el('option', { value: g })));

    const visible = () =>
      profiles
        .filter((p) => (filter === 'all' ? true : filter === 'yours' ? p.yours : p.grp === filter))
        .filter((p) => !query || `${p.name} ${p.category || ''} ${p.address || ''}`.toLowerCase().includes(query))
        .sort((a, b) => {
          const x = a[sort.key];
          const y = b[sort.key];
          if (x == null && y == null) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * sort.dir;
        });

    function summary(rows) {
      const by = new Map();
      rows.forEach((p) => by.set(p.grp, [...(by.get(p.grp) || []), p]));
      const avg = (list, k) => {
        const v = list.map((p) => p[k]).filter((n) => n != null);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
      };
      // Group change: average of each profile's own change, so new joiners don't skew it.
      const avgChange = (list, k, digits) => {
        const v = avg(list, k);
        return v == null ? null : v === 0 ? '(no change)' : `${v > 0 ? '▲' : '▼'} ${Math.abs(v).toFixed(digits)} each`;
      };
      const share = (list, k) => `${pct(list.filter((p) => p[k] === 1 || (k === 'website' && p.website)).length, list.length)}%`;
      summaryBox.replaceChildren(el('div', { class: 'grid-2' }, [...by.entries()].map(([g, list]) =>
        el('div', { class: 'stats__item' },
          el('h3', { class: 'section__title' }, `${g} · ${list.length}`),
          el('dl', { class: 'stats' },
            stat('Avg rating', avg(list, 'rating') == null ? '–' : `${avg(list, 'rating').toFixed(1)}★`, avgChange(list, 'dRating', 2)),
            stat('Avg reviews', avg(list, 'reviewsN') == null ? '–' : Math.round(avg(list, 'reviewsN')), avgChange(list, 'gain', 1)),
            stat('Avg photos', avg(list, 'photos') == null ? '–' : Math.round(avg(list, 'photos')), avgChange(list, 'dPhotos', 1)),
            stat('Claimed', share(list, 'claimed')),
            stat('Has hours', share(list, 'has_hours')))))));
    }

    function draw() {
      const rows = visible();
      summary(rows);
      if (!rows.length) {
        tableBox.replaceChildren(el('p', { class: 'empty' }, profiles.length ? 'Nothing matches that filter.' : 'No profiles yet. Add some below.'));
        return;
      }
      const best = {};
      ['rating', 'reviewsN', 'gain', 'photos'].forEach((k) => (best[k] = Math.max(...rows.map((p) => p[k] ?? -Infinity))));
      const head = el('tr', null, COLS.map(([k, label, type]) =>
        el('th', { class: `table__cell table__cell--head${type === 'num' ? ' table__cell--num' : ''}`, scope: 'col', 'aria-sort': sort.key === k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none' },
          el('button', { class: 'sort', type: 'button', onclick: () => { sort = { key: k, dir: sort.key === k ? -sort.dir : type === 'text' ? 1 : -1 }; draw(); } },
            label, sort.key === k ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''))).concat(el('th', { class: 'table__cell table__cell--head', scope: 'col' }, el('span', { class: 'visually-hidden' }, 'Actions'))));
      const num = (p, k, text) => el('td', { class: `table__cell table__cell--num${p[k] != null && p[k] === best[k] && best[k] > 0 ? ' table__cell--best' : ''}` }, text ?? '–');
      const flag = (v) => el('td', { class: 'table__cell' }, v == null ? '–' : v ? el('span', { class: 'chip chip--done' }, 'Yes') : el('span', { class: 'chip chip--high' }, 'No'));
      const body = rows.map((p) => {
        const grp = input({ value: p.grp, list: 'grp-list', 'aria-label': `Group for ${p.name}`, class: 'field__input field__input--cell' });
        grp.addEventListener('change', async () => {
          await api(`/profiles/${p.id}`, { method: 'PATCH', body: { grp: grp.value } }).catch(fail);
          p.grp = grp.value.trim() || p.grp;
          draw();
        });
        const refresh = d.live && (p.place_id || p.cid) && el('button', { class: 'link-button link-button--plain', type: 'button', onclick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = 'Refreshing…';
          try {
            await api(`/profiles/${p.id}/refresh`, { method: 'POST' });
            route();
          } catch (err) {
            e.target.textContent = err.message;
          }
        } }, 'Refresh');
        return el('tr', { class: p.yours ? 'table__row--self' : null },
          el('td', { class: 'table__cell' }, p.name, p.yours ? el('span', { class: 'chip chip--ai', style: 'margin-left:6px' }, 'You') : null,
            p.address ? el('span', { class: 'step__summary' }, p.address) : null),
          el('td', { class: 'table__cell' }, grp),
          td(p.category),
          num(p, 'rating', [p.rating != null ? `${p.rating}★` : p.reviewsN === 0 ? 'None' : '–', ' ', arrow(p.dRating, 1)]),
          num(p, 'reviewsN', [p.reviewsN === 0 ? 'None' : p.reviewsN ?? '–', ' ', arrow(p.gain)]),
          num(p, 'gain', p.gain == null ? (p.base_day ? null : el('span', { class: 'step__summary', title: 'Needs a second snapshot' }, 'New')) : p.gain > 0 ? `+${p.gain}` : String(p.gain)),
          num(p, 'photos', [p.photos ?? '–', ' ', arrow(p.dPhotos)]),
          flag(p.claimed),
          flag(p.has_hours),
          flag(p.website ? 1 : p.updated_at ? 0 : null),
          td(p.updated_at ? fmtDay(p.updated_at) : 'Never'),
          el('td', { class: 'table__cell', style: 'white-space:nowrap' }, refresh || null, ' ',
            el('button', { class: 'link-button', type: 'button', onclick: async () => {
              if (!confirm(`Stop tracking ${p.name}?`)) return;
              await api(`/profiles/${p.id}`, { method: 'DELETE' }).catch(fail);
              route();
            } }, 'Remove')));
      });
      tableBox.replaceChildren(el('div', { class: 'table-wrap' }, el('table', { class: 'table table--profiles' },
        el('caption', { class: 'visually-hidden' }, 'Tracked Google profiles'), el('thead', null, head), el('tbody', null, body))));
    }

    // Toolbar
    const search = input({ type: 'search', placeholder: 'Search name, category or area', 'aria-label': 'Search profiles', class: 'field__input' });
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); draw(); });
    const chips = el('div', { class: 'tabs', role: 'group', 'aria-label': 'Filter by group' });
    const drawChips = () => chips.replaceChildren(...[['all', 'All'], ['yours', 'Yours'], ...groups.map((g) => [g, g])].map(([k, label]) =>
      el('button', { class: `tabs__link${filter === k ? ' tabs__link--active' : ''}`, type: 'button', 'aria-pressed': String(filter === k), onclick: () => { filter = k; drawChips(); draw(); } },
        label, el('span', { class: 'tabs__count' }, String(k === 'all' ? profiles.length : k === 'yours' ? profiles.filter((p) => p.yours).length : profiles.filter((p) => p.grp === k).length)))));
    drawChips();
    const refreshAll = d.live && profiles.some((p) => p.place_id || p.cid) && el('button', { class: 'button button--ghost', type: 'button' }, 'Refresh all');
    if (refreshAll) refreshAll.addEventListener('click', async () => {
      const list = visible().filter((p) => p.place_id || p.cid);
      if (!confirm(`Fetch fresh data for ${list.length} profiles from DataForSEO? Each lookup costs a fraction of a cent. The cost is logged against your monthly cap.`)) return;
      refreshAll.disabled = true;
      for (let i = 0; i < list.length; i++) {
        refreshAll.textContent = `Refreshing ${i + 1} of ${list.length}…`;
        try {
          await api(`/profiles/${list[i].id}/refresh`, { method: 'POST' });
        } catch (err) {
          if (/cap/i.test(err.message)) { alert(err.message); break; }
        }
      }
      route();
    });

    // Add from scans
    const sugg = d.suggestions;
    const suggList = sugg.length
      ? el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
          el('caption', { class: 'visually-hidden' }, 'Businesses found in your scans'),
          el('thead', null, el('tr', null, ['Business', 'Category', 'Rating', 'Reviews', 'Seen in', ''].map((h, i) => el('th', { class: `table__cell table__cell--head${[2, 3, 4].includes(i) ? ' table__cell--num' : ''}`, scope: 'col' }, h)))),
          el('tbody', null, sugg.map((s) => {
            const btn = el('button', { class: 'button button--small', type: 'button' }, 'Track');
            btn.addEventListener('click', async () => {
              btn.disabled = true;
              try {
                await api('/profiles', { method: 'POST', body: { from_key: s.key } });
                btn.textContent = 'Tracking ✓';
                btn.className = 'button button--ok button--small';
              } catch (err) {
                btn.textContent = err.message;
              }
            });
            return el('tr', null,
              el('td', { class: 'table__cell' }, s.title, s.address ? el('span', { class: 'step__summary' }, s.address) : null),
              td(s.category), td(s.rating != null ? `${s.rating}★` : 'None', true), td(s.reviews ?? (s.rating == null ? 'None' : null), true),
              td(`${s.scans} ${s.scans === 1 ? 'scan' : 'scans'}`, true), el('td', { class: 'table__cell' }, btn));
          }))))
      : el('p', { class: 'empty' }, 'Run live scans to find businesses here. Everything they find shows up for one-click tracking.');

    // Add by link
    const linkIn = input({ name: 'input', required: true, placeholder: 'https://www.google.com/maps/place/…  or  ChIJ…' });
    const nameIn = input({ name: 'name', maxlength: 200 });
    const grpIn = input({ name: 'grp', list: 'grp-list', placeholder: 'e.g. Slimming World or Other' });
    const addErr = el('p', { class: 'form__error', role: 'alert' });
    const addForm = el('form', { class: 'form', novalidate: true },
      el('div', { class: 'form__row' },
        field('Google Maps link, Place ID or CID', linkIn, 'Open the business in Google Maps, copy the address bar link and paste it here.'),
        !d.live && field('Business name', nameIn, 'Needed because live lookups are not set up.'),
        field('Group', grpIn, 'Leave blank to auto-group.')),
      addErr,
      el('div', { class: 'form__actions' }, el('button', { class: 'button', type: 'submit' }, d.live ? 'Look up and track' : 'Track')));
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      addErr.textContent = '';
      busy(addForm, true);
      try {
        await api('/profiles', { method: 'POST', body: { input: linkIn.value, name: nameIn.value, grp: grpIn.value } });
        route();
      } catch (err) {
        addErr.textContent = err.message;
        busy(addForm, false);
      }
    });

    render(
      el('section', { class: 'section', 'aria-labelledby': 'prof-title' },
        el('div', { class: 'section__head' }, el('h1', { class: 'page-title', id: 'prof-title' }, 'Profile comparison'), refreshAll),
        el('p', { class: 'section__lead' }, 'Every Google profile you track, side by side. Tracked profiles update for free whenever a scan finds them. The best value in each column is highlighted. Arrows show the change over the period you pick.'),
        el('div', { class: 'toolbar' },
          el('div', { class: 'tabs', role: 'group', 'aria-label': 'Compare with' },
            [[30, 'vs 30 days ago'], [90, 'vs 90 days ago'], [0, 'Since tracking started']].map(([n, label]) =>
              el('button', { class: `tabs__link${profilePeriod === n ? ' tabs__link--active' : ''}`, type: 'button', 'aria-pressed': String(profilePeriod === n), onclick: () => { profilePeriod = n; route(); } }, label))),
          baselineNote(profiles)),
        groupList,
        el('div', { class: 'toolbar' }, chips, el('div', { class: 'toolbar__search' }, search)),
        tableBox),
      profiles.length > 0 && section('Group averages', summaryBox),
      section(`Add from your scans (${sugg.length})`, el('p', { class: 'section__lead' }, 'Businesses your live scans found. Track the ones you want to compare.'), suggList),
      section('Add any profile', addForm));
    draw();
  }

  /* ---------- Router ---------- */

  async function route() {
    renderId++;
    const h0 = location.hash || '#/';
    document.querySelectorAll('.header__link').forEach((a) => a.setAttribute('aria-current', (h0.startsWith('#/profiles') ? a.getAttribute('href') === '#/profiles' : a.getAttribute('href') === '#/') ? 'page' : 'false'));
    try {
      if (shareMatch) return await loadScan(shareMatch[1], true);
      const h = location.hash.replace(/^#/, '') || '/';
      let m;
      if ((m = h.match(/^\/loc\/([\w-]+)(?:\/(\w+))?(?:\/([\w-]+))?$/))) await viewLocation(m[1], m[2] || 'plan', m[3]);
      else if ((m = h.match(/^\/scan\/([\w-]+)$/))) await loadScan(m[1], false);
      else if ((m = h.match(/^\/compare\/([\w-]+)\/([\w-]+)$/))) await viewCompare(m[1], m[2]);
      else if (h === '/profiles') await viewProfiles();
      else await viewHome();
    } catch (err) {
      fail(err);
    }
  }

  window.addEventListener('hashchange', () => route().then(() => window.scrollTo(0, 0)));

  if (shareMatch) {
    document.querySelector('.header__brand').removeAttribute('href');
    route();
  } else {
    api('/config')
      .then((c) => {
        config = c;
        document.getElementById('user').textContent = c.email;
      })
      .catch(() => {})
      .then(route);
  }
})();
