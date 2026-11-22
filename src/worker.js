import INDEX_HTML from './client/index.html';
import APP_JS from './client/app.js';
import APP_CSS from './client/styles.css';
import PROMPTS_JS from './client/prompts.js';
import { analyse, isTarget, listingKey, distanceKm } from './analysis.js';
import { listProfiles, suggestions, addProfile, refreshProfile, updateProfile, syncFromListings } from './profiles.js';

const DFS = 'https://api.dataforseo.com/v3/serp/google/maps';
const COST_PER_POINT = 0.0006; // DataForSEO Maps, standard queue, per SERP
const SIZES = [3, 5, 7, 9];
const DEFAULT_ORIGIN = 'https://gbp.exoreach.dev';

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const need = (ok, message, status) => {
  if (!ok) throw new HttpError(message, status);
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const hasDfs = (env) => Boolean(env.DFS_LOGIN && env.DFS_PASSWORD && env.POSTBACK_KEY);
const dfsAuth = (env) => `Basic ${btoa(`${env.DFS_LOGIN}:${env.DFS_PASSWORD}`)}`;
const monthlyCap = (env) => Number(env.MONTHLY_CAP_USD) || 10;

const one = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();
const text = (v, max) => String(v ?? '').trim().slice(0, max);

/* ---------- Cloudflare Access JWT check (defence in depth) ---------- */

let jwks = [];
let jwksAt = 0;

const b64u = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

async function accessKey(env, kid) {
  const find = () => jwks.find((k) => k.kid === kid);
  if (!find() && Date.now() - jwksAt > 60_000) {
    const res = await fetch(`https://${env.ACCESS_TEAM}/cdn-cgi/access/certs`);
    jwks = (await res.json()).keys || [];
    jwksAt = Date.now();
  }
  const jwk = find();
  return jwk && crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

async function accessEmail(req, env) {
  const jwt = req.headers.get('cf-access-jwt-assertion');
  if (!jwt || !env.ACCESS_TEAM || !env.ACCESS_AUD) return null;
  const [h, p, s] = jwt.split('.');
  if (!s) return null;
  try {
    const dec = new TextDecoder();
    const header = JSON.parse(dec.decode(b64u(h)));
    const claims = JSON.parse(dec.decode(b64u(p)));
    const key = await accessKey(env, header.kid);
    if (!key) return null;
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(s), new TextEncoder().encode(`${h}.${p}`));
    const audOk = [].concat(claims.aud).includes(env.ACCESS_AUD);
    const fresh = claims.exp * 1000 > Date.now();
    const issOk = claims.iss === `https://${env.ACCESS_TEAM}`;
    return valid && audOk && fresh && issOk ? claims.email || 'service' : null;
  } catch {
    return null;
  }
}

/* ---------- Grid and listings ---------- */

function grid(lat, lng, size, km) {
  const half = (size - 1) / 2;
  const kmPerLng = 111.32 * Math.cos((lat * Math.PI) / 180);
  const points = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      points.push({
        idx: r * size + c,
        lat: +(lat + ((half - r) * km) / 111.32).toFixed(6),
        lng: +(lng + ((c - half) * km) / kmPerLng).toFixed(6),
      });
    }
  }
  return points;
}

// Slim, durable snapshot of one Maps result. Raw SERP JSON is never stored.
function toListing(i) {
  return {
    key: listingKey(i),
    place_id: i.place_id || null,
    cid: i.cid ? String(i.cid) : null,
    title: text(i.title, 200),
    category: i.category || null,
    categories: JSON.stringify((i.additional_categories || []).slice(0, 10)),
    rating: i.rating?.value ?? null,
    reviews: i.rating?.votes_count ?? null,
    photos: i.total_photos ?? null,
    claimed: typeof i.is_claimed === 'boolean' ? Number(i.is_claimed) : null,
    has_hours: i.work_hours?.timetable ? 1 : 'work_hours' in i ? 0 : null,
    website: i.url || null,
    phone: i.phone || null,
    lat: i.latitude ?? null,
    lng: i.longitude ?? null,
    address: i.address || null,
  };
}

const LISTING_COLS = ['key', 'place_id', 'cid', 'title', 'category', 'categories', 'rating', 'reviews', 'photos', 'claimed', 'has_hours', 'website', 'phone', 'lat', 'lng', 'address'];
const insertListing = (env, scanId, l) =>
  env.DB.prepare(`INSERT OR IGNORE INTO listings (scan_id, ${LISTING_COLS.join(', ')}) VALUES (?, ${LISTING_COLS.map(() => '?').join(', ')})`).bind(
    scanId,
    ...LISTING_COLS.map((c) => l[c]),
  );

function readItems(items, loc) {
  const maps = (items || []).filter((i) => i.type === 'maps_search').slice(0, 20);
  const listings = maps.map(toListing);
  const hit = maps.findIndex((i) => isTarget(i, loc));
  return {
    rank: hit >= 0 ? hit + 1 : null,
    top: maps.slice(0, 3).map((i) => ({ title: i.title, rating: i.rating?.value ?? null, reviews: i.rating?.votes_count ?? null, you: isTarget(i, loc) })),
    ranks: listings.map((l) => l.key),
    listings,
    selfItem: hit >= 0 ? maps[hit] : null,
  };
}

function simulate(points, loc, keyword) {
  const brand = keyword.replace(/\b\w/g, (c) => c.toUpperCase());
  const cats = ['Weight loss service', 'Health consultant', 'Fitness centre', 'Nutritionist'];
  const rivals = ['Northside', 'Citywide', 'Prime', 'Apex', 'Swift', 'Premier', 'Local'].map((n, i) => ({
    place_id: `demo-${i}`,
    title: `${n} ${brand}`,
    category: cats[i % 3 === 0 ? 0 : i % 4],
    additional_categories: i % 2 ? ['Nutritionist'] : [],
    rating: { value: +(4.3 + (i % 5) / 10).toFixed(1), votes_count: 20 + i * 17 },
    total_photos: 10 + i * 6,
    is_claimed: true,
    work_hours: { timetable: {} },
    url: `https://example.com/${i}`,
    latitude: loc.lat + Math.sin(i) * 0.03,
    longitude: loc.lng + Math.cos(i) * 0.05,
    type: 'maps_search',
  }));
  const me = {
    place_id: loc.place_id || 'demo-self',
    cid: loc.cid,
    title: loc.name,
    category: 'Health consultant',
    additional_categories: [],
    rating: { value: 4.8, votes_count: 14 },
    total_photos: 6,
    is_claimed: true,
    work_hours: null,
    url: null,
    latitude: loc.lat,
    longitude: loc.lng,
    type: 'maps_search',
  };
  return points.map((p) => {
    const score = 1 + distanceKm(p, loc) * 2.2 + (Math.random() * 4 - 2);
    const rank = score > 20 ? null : Math.max(1, Math.round(score));
    const list = [...rivals].sort(() => Math.random() - 0.5);
    if (rank && rank <= list.length + 1) list.splice(rank - 1, 0, me);
    return { ...p, ...readItems(list, { ...loc, place_id: me.place_id }) };
  });
}

/* ---------- DataForSEO results ---------- */

async function finishIfComplete(env, scanId) {
  const { pending } = await one(env, "SELECT COUNT(*) AS pending FROM points WHERE scan_id = ? AND status = 'pending'", scanId);
  if (pending === 0) await run(env, "UPDATE scans SET status = 'done', completed_at = datetime('now') WHERE id = ? AND status = 'pending'", scanId);
}

// Learn the listing's Place ID the first time a name match finds it, so later matching is exact.
async function rememberIdentity(env, loc, item) {
  if (!item || loc.place_id || loc.cid) return;
  await run(env, 'UPDATE locations SET place_id = ?, cid = ? WHERE id = ? AND place_id IS NULL AND cid IS NULL', item.place_id || null, item.cid ? String(item.cid) : null, loc.id);
}

async function saveTask(env, task) {
  const [scanId, idxRaw] = String(task.data?.tag || '').split(':');
  const idx = Number(idxRaw);
  const row = await one(
    env,
    `SELECT l.id, l.name, l.place_id, l.cid FROM points p
     JOIN scans s ON s.id = p.scan_id JOIN locations l ON l.id = s.location_id
     WHERE p.scan_id = ? AND p.idx = ? AND p.task_id = ? AND p.status = 'pending'`,
    scanId,
    idx,
    task.id,
  );
  if (!row) return;
  if (task.status_code === 20000 || task.status_code === 40102) {
    // 40102 = "No Search Results": a real answer (nothing ranks here), not a failure.
    const r = readItems(task.status_code === 20000 ? task.result?.[0]?.items : [], row);
    await env.DB.batch([
      env.DB.prepare("UPDATE points SET status = 'done', rank = ?, top = ?, ranks = ? WHERE scan_id = ? AND idx = ?").bind(
        r.rank,
        JSON.stringify(r.top),
        JSON.stringify(r.ranks),
        scanId,
        idx,
      ),
      ...r.listings.map((l) => insertListing(env, scanId, l)),
    ]);
    await rememberIdentity(env, row, r.selfItem);
    await syncFromListings(env, r.listings);
  } else {
    await run(env, "UPDATE points SET status = 'error', error = ? WHERE scan_id = ? AND idx = ?", text(`${task.status_code} ${task.status_message || ''}`, 300), scanId, idx);
  }
  await finishIfComplete(env, scanId);
}

async function readBody(req) {
  const buf = new Uint8Array(await req.arrayBuffer());
  const gz = buf[0] === 0x1f && buf[1] === 0x8b;
  const raw = gz ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : buf;
  return JSON.parse(new TextDecoder().decode(raw));
}

async function postback(req, env, url) {
  const enc = new TextEncoder();
  const given = enc.encode(url.searchParams.get('k') || '');
  const secret = enc.encode(env.POSTBACK_KEY || '');
  need(secret.length && given.length === secret.length && crypto.subtle.timingSafeEqual(given, secret), 'Forbidden', 403);
  const body = await readBody(req);
  for (const task of body.tasks || []) await saveTask(env, task);
  return json({ ok: true });
}

/* ---------- Locations ---------- */

function readLocation(b, partial = false) {
  const num = (v) => (v === '' || v == null ? NaN : Number(v));
  const out = {};
  if (!partial || 'name' in b) {
    out.name = text(b.name, 120);
    need(out.name, 'Enter a business name (max 120 characters).');
  }
  if (!partial || 'lat' in b || 'lng' in b) {
    out.lat = num(b.lat);
    out.lng = num(b.lng);
    need(
      Number.isFinite(out.lat) && Math.abs(out.lat) <= 90 && Number.isFinite(out.lng) && Math.abs(out.lng) <= 180 && !(out.lat === 0 && out.lng === 0),
      'Drop the pin on the business first.',
    );
  }
  if (!partial || 'place_id' in b) out.place_id = text(b.place_id, 200) || null;
  if (!partial || 'cid' in b) {
    out.cid = text(b.cid, 30) || null;
    need(!out.cid || /^\d+$/.test(out.cid), 'The CID should be numbers only.');
  }
  return out;
}

async function createLocation(env, b) {
  const l = readLocation(b);
  const id = crypto.randomUUID();
  await run(env, 'INSERT INTO locations (id, name, lat, lng, place_id, cid) VALUES (?, ?, ?, ?, ?, ?)', id, l.name, l.lat, l.lng, l.place_id, l.cid);
  return json({ id }, 201);
}

async function updateLocation(env, id, b) {
  const l = readLocation(b, true);
  const cols = Object.keys(l);
  need(cols.length, 'Nothing to update.');
  const res = await run(env, `UPDATE locations SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => l[c]), id);
  need(res.meta.changes, 'Location not found.', 404);
  return json({ ok: true });
}

const SCAN_SUMMARY = `s.id, s.keyword, s.size, s.spacing_km, s.zoom, s.mode, s.status, s.cost, s.created_at, s.completed_at,
  (SELECT AVG(rank) FROM points WHERE scan_id = s.id AND rank IS NOT NULL) AS avg_rank,
  (SELECT COUNT(*) FROM points WHERE scan_id = s.id AND rank IS NOT NULL) AS found,
  (SELECT COUNT(*) FROM points WHERE scan_id = s.id AND rank IS NOT NULL AND rank <= 3) AS top3,
  (SELECT COUNT(*) FROM points WHERE scan_id = s.id AND status = 'done') AS done_points,
  (SELECT COUNT(*) FROM points WHERE scan_id = s.id) AS total_points`;

async function getLocation(env, id) {
  const location = await one(env, 'SELECT * FROM locations WHERE id = ?', id);
  need(location, 'Location not found.', 404);
  const [scans, changes, checklist, schedules] = await Promise.all([
    all(env, `SELECT ${SCAN_SUMMARY} FROM scans s WHERE s.location_id = ? ORDER BY s.created_at DESC LIMIT 200`, id),
    all(env, 'SELECT id, happened_on, note, created_at FROM changes WHERE location_id = ? ORDER BY happened_on DESC, created_at DESC', id),
    all(env, 'SELECT item, done, note, updated_at FROM checklist WHERE location_id = ?', id),
    all(env, 'SELECT * FROM schedules WHERE location_id = ? ORDER BY created_at', id),
  ]);
  return json({ location, scans, changes, checklist, schedules });
}

async function addChange(env, locationId, b) {
  const note = text(b.note, 500);
  const day = text(b.happened_on, 10);
  need(note, 'Describe what you changed.');
  need(/^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)), 'Pick a valid date.');
  need(await one(env, 'SELECT id FROM locations WHERE id = ?', locationId), 'Location not found.', 404);
  const id = crypto.randomUUID();
  await run(env, 'INSERT INTO changes (id, location_id, happened_on, note) VALUES (?, ?, ?, ?)', id, locationId, day, note);
  return json({ id }, 201);
}

async function setChecklist(env, locationId, item, b) {
  need(/^[a-z0-9-]{1,40}$/.test(item), 'Unknown checklist item.');
  need(await one(env, 'SELECT id FROM locations WHERE id = ?', locationId), 'Location not found.', 404);
  await run(
    env,
    `INSERT INTO checklist (location_id, item, done, note, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (location_id, item) DO UPDATE SET done = excluded.done, note = excluded.note, updated_at = excluded.updated_at`,
    locationId,
    item,
    b.done ? 1 : 0,
    text(b.note, 500) || null,
  );
  return json({ ok: true });
}

/* ---------- Scans ---------- */

function readScanSettings(b) {
  const s = {
    keyword: text(b.keyword, 80),
    size: Number(b.size),
    spacing: Number(b.spacing_km),
    zoom: Number(b.zoom),
  };
  need(s.keyword, 'Enter a keyword (max 80 characters).');
  need(SIZES.includes(s.size), 'Pick a grid size.');
  need(s.spacing >= 0.1 && s.spacing <= 5, 'Spacing must be between 0.1 and 5 km.');
  need(Number.isInteger(s.zoom) && s.zoom >= 11 && s.zoom <= 18, 'Zoom must be a whole number from 11 to 18.');
  return s;
}

async function monthSpend(env) {
  const r = await one(
    env,
    `SELECT (SELECT COALESCE(SUM(cost), 0) FROM scans WHERE created_at >= strftime('%Y-%m-01', 'now'))
          + (SELECT COALESCE(SUM(cost), 0) FROM profile_snapshots WHERE day >= strftime('%Y-%m-01', 'now')) AS spent`,
  );
  return r.spent;
}

async function startScan(env, b, createdBy, origin) {
  const loc = await one(env, 'SELECT * FROM locations WHERE id = ?', text(b.location_id, 64));
  need(loc, 'Location not found.', 404);
  const s = readScanSettings(b);
  const mode = b.mode === 'live' ? 'live' : 'demo';
  const points = grid(loc.lat, loc.lng, s.size, s.spacing);

  if (mode === 'live') {
    need(hasDfs(env), 'DataForSEO is not set up yet. Use demo mode.');
    const spent = await monthSpend(env);
    const est = points.length * COST_PER_POINT;
    need(spent + est <= monthlyCap(env), `Monthly data cap reached ($${spent.toFixed(2)} of $${monthlyCap(env)}). Raise MONTHLY_CAP_USD to continue.`, 402);
  }

  const id = crypto.randomUUID();
  let rows;
  let cost = 0;

  if (mode === 'demo') {
    rows = simulate(points, loc, s.keyword).map((p) => ({ ...p, status: 'done', task_id: null, error: null }));
  } else {
    const tasks = points.map((p) => ({
      keyword: s.keyword,
      location_coordinate: `${p.lat},${p.lng},${s.zoom}z`,
      language_code: 'en',
      depth: 20,
      tag: `${id}:${p.idx}`,
      postback_data: 'advanced',
      postback_url: `${origin}/api/postback?k=${env.POSTBACK_KEY}`,
    }));
    const res = await fetch(`${DFS}/task_post`, {
      method: 'POST',
      headers: { authorization: dfsAuth(env), 'content-type': 'application/json' },
      body: JSON.stringify(tasks),
    });
    const data = await res.json().catch(() => ({}));
    need(data.status_code === 20000, `DataForSEO error: ${data.status_message || res.status}`, 502);
    const byTag = new Map((data.tasks || []).map((t) => [t.data?.tag, t]));
    rows = points.map((p) => {
      const t = byTag.get(`${id}:${p.idx}`);
      const ok = t?.status_code === 20100;
      if (ok) cost += COST_PER_POINT;
      const error = ok ? null : t ? text(`${t.status_code} ${t.status_message || ''}`, 300) : 'No task returned';
      return { ...p, status: ok ? 'pending' : 'error', task_id: t?.id ?? null, rank: null, top: null, ranks: null, listings: [], error };
    });
    const failed = rows.filter((r) => r.status === 'error');
    need(failed.length < rows.length, `DataForSEO rejected every point: ${failed[0]?.error}`, 502);
  }

  const done = rows.every((r) => r.status !== 'pending');
  const listings = new Map();
  rows.forEach((r) => (r.listings || []).forEach((l) => listings.set(l.key, l)));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO scans (id, location_id, keyword, size, spacing_km, zoom, mode, status, cost, created_by, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${done ? "datetime('now')" : 'NULL'})`,
    ).bind(id, loc.id, s.keyword, s.size, s.spacing, s.zoom, mode, done ? 'done' : 'pending', cost, createdBy),
    ...rows.map((r) =>
      env.DB.prepare('INSERT INTO points (scan_id, idx, lat, lng, task_id, status, rank, top, ranks, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
        id,
        r.idx,
        r.lat,
        r.lng,
        r.task_id,
        r.status,
        r.rank ?? null,
        r.top ? JSON.stringify(r.top) : null,
        r.ranks ? JSON.stringify(r.ranks) : null,
        r.error ?? null,
      ),
    ),
    ...[...listings.values()].map((l) => insertListing(env, id, l)),
  ]);
  return id;
}

async function loadScan(env, scan, { withAnalysis }) {
  const location = await one(env, 'SELECT id, name, lat, lng, place_id, cid FROM locations WHERE id = ?', scan.location_id);
  const points = await all(env, 'SELECT idx, lat, lng, status, rank, top, ranks, error FROM points WHERE scan_id = ? ORDER BY idx', scan.id);
  let analysis = null;
  if (withAnalysis && scan.status === 'done') {
    const listings = await all(env, 'SELECT * FROM listings WHERE scan_id = ?', scan.id);
    const prevScan = await one(
      env,
      `SELECT id, created_at FROM scans WHERE location_id = ? AND mode = ? AND status = 'done' AND created_at <= datetime(?, '-7 days')
       ORDER BY created_at DESC LIMIT 1`,
      scan.location_id,
      scan.mode,
      scan.created_at,
    );
    const previous = prevScan && { ...prevScan, listings: await all(env, 'SELECT key, reviews FROM listings WHERE scan_id = ?', prevScan.id) };
    analysis = analyse({ scan, location, points, listings, previous });
  }
  // The latest earlier scan with the same keyword, grid and spacing: lets each point show its change.
  let previous = null;
  if (withAnalysis) {
    const prev = await one(
      env,
      `SELECT id, created_at FROM scans WHERE location_id = ? AND id != ? AND status = 'done' AND mode = ? AND lower(keyword) = lower(?)
         AND size = ? AND spacing_km = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1`,
      scan.location_id,
      scan.id,
      scan.mode,
      scan.keyword,
      scan.size,
      scan.spacing_km,
      scan.created_at,
    );
    if (prev) {
      const pts = await all(env, "SELECT idx, rank, status FROM points WHERE scan_id = ? ORDER BY idx", prev.id);
      previous = { id: prev.id, created_at: prev.created_at, points: pts };
    }
  }
  const { share_token: _t, created_by: _c, ...safe } = scan;
  return {
    scan: safe,
    location: { name: location.name, lat: location.lat, lng: location.lng },
    points: points.map(({ ranks: _r, ...p }) => ({ ...p, top: p.top ? JSON.parse(p.top) : [] })),
    analysis,
    previous,
  };
}

async function getScan(env, id) {
  const scan = await one(env, 'SELECT * FROM scans WHERE id = ?', id);
  need(scan, 'Scan not found.', 404);
  return json({ ...(await loadScan(env, scan, { withAnalysis: true })), shared: Boolean(scan.share_token) });
}

async function refreshScan(env, id) {
  need(hasDfs(env), 'DataForSEO is not set up.');
  const pending = await all(env, "SELECT task_id FROM points WHERE scan_id = ? AND status = 'pending' AND task_id IS NOT NULL LIMIT 40", id);
  for (const { task_id } of pending) {
    const res = await fetch(`${DFS}/task_get/advanced/${task_id}`, { headers: { authorization: dfsAuth(env) } });
    const data = await res.json().catch(() => ({}));
    const task = data.tasks?.[0];
    if (task && task.status_code !== 40601 && task.status_code !== 40602) await saveTask(env, task); // 4060x = still queued
  }
  return getScan(env, id);
}

async function shareScan(env, id, origin) {
  const scan = await one(env, 'SELECT id, share_token FROM scans WHERE id = ?', id);
  need(scan, 'Scan not found.', 404);
  let token = scan.share_token;
  if (!token) {
    token = hex(24);
    await run(env, 'UPDATE scans SET share_token = ? WHERE id = ?', token, id);
  }
  return json({ url: `${origin}/r/${token}` });
}

async function getShared(env, token) {
  need(/^[a-f0-9]{48}$/.test(token), 'Report not found.', 404);
  const scan = await one(env, 'SELECT * FROM scans WHERE share_token = ?', token);
  need(scan, 'Report not found.', 404);
  const data = await loadScan(env, scan, { withAnalysis: true });
  // Clients see the map and competitor view, not the internal action plan.
  if (data.analysis) data.analysis = { ...data.analysis, recommendations: [], strengths: [] };
  return json(data);
}

async function compareScans(env, a, b) {
  const [sa, sb] = await Promise.all([one(env, 'SELECT * FROM scans WHERE id = ?', a), one(env, 'SELECT * FROM scans WHERE id = ?', b)]);
  need(sa && sb, 'Scan not found.', 404);
  need(sa.location_id === sb.location_id, 'Pick two scans of the same location.');
  const [before, after] = Date.parse(sa.created_at) <= Date.parse(sb.created_at) ? [sa, sb] : [sb, sa];
  const same = before.keyword.toLowerCase() === after.keyword.toLowerCase() && before.size === after.size && before.spacing_km === after.spacing_km;
  const [pb, pa] = await Promise.all([loadScan(env, before, { withAnalysis: false }), loadScan(env, after, { withAnalysis: false })]);
  return json({ same, before: pb, after: pa });
}

async function addSchedule(env, b) {
  const loc = await one(env, 'SELECT id FROM locations WHERE id = ?', text(b.location_id, 64));
  need(loc, 'Location not found.', 404);
  const s = readScanSettings(b);
  const every = Number(b.every_days) || 7;
  need([7, 14, 30].includes(every), 'Repeat every 7, 14 or 30 days.');
  const count = await one(env, 'SELECT COUNT(*) AS n FROM schedules');
  need(count.n < 50, 'Too many schedules (max 50).');
  const id = crypto.randomUUID();
  await run(
    env,
    `INSERT INTO schedules (id, location_id, keyword, size, spacing_km, zoom, every_days, next_run) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' days'))`,
    id,
    loc.id,
    s.keyword,
    s.size,
    s.spacing,
    s.zoom,
    every,
    every,
  );
  return json({ id }, 201);
}

async function runSchedules(env) {
  if (!hasDfs(env)) return;
  const origin = env.PUBLIC_ORIGIN || DEFAULT_ORIGIN;
  const due = await all(env, "SELECT * FROM schedules WHERE next_run <= datetime('now') ORDER BY next_run LIMIT 20");
  for (const s of due) {
    try {
      await startScan(env, { location_id: s.location_id, keyword: s.keyword, size: s.size, spacing_km: s.spacing_km, zoom: s.zoom, mode: 'live' }, 'schedule', origin);
    } catch (err) {
      console.error('scheduled scan failed', s.id, err.message);
    }
    await run(env, "UPDATE schedules SET next_run = datetime('now', '+' || every_days || ' days') WHERE id = ?", s.id);
  }
}

/* ---------- Static app ---------- */

const SECURITY_HEADERS = {
  'referrer-policy': 'strict-origin-when-cross-origin', // OSM tiles require a Referer; this sends only the origin
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function page() {
  return new Response(INDEX_HTML, {
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': [
        "default-src 'self'",
        "script-src 'self' https://cdnjs.cloudflare.com",
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
        "img-src 'self' data: https://tile.openstreetmap.org https://cdnjs.cloudflare.com",
        "font-src 'self' data:",
        "connect-src 'self' https://nominatim.openstreetmap.org",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join('; '),
    },
  });
}

const asset = (body, type) =>
  new Response(body, { headers: { ...SECURITY_HEADERS, 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-cache' } });

/* ---------- Router ---------- */

async function checkCap(env, estimate) {
  const spent = await monthSpend(env);
  need(spent + estimate <= monthlyCap(env), `Monthly data cap reached ($${spent.toFixed(2)} of $${monthlyCap(env)}). Raise MONTHLY_CAP_USD to continue.`, 402);
}
const profileDeps = (env) => ({ hasDfs: hasDfs(env), dfsAuth: hasDfs(env) ? dfsAuth(env) : null, checkCap: (e) => checkCap(env, e) });
const wrap = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (err.status && !(err instanceof HttpError)) throw new HttpError(err.message, err.status);
    throw err;
  }
};

const routes = [
  ['GET', /^\/api\/profiles$/, async (c) => json({ profiles: await listProfiles(c.env), suggestions: await suggestions(c.env), live: hasDfs(c.env) })],
  ['POST', /^\/api\/profiles$/, (c) => wrap(async () => json(await addProfile(c.env, c.body, profileDeps(c.env)), 201))],
  ['POST', /^\/api\/profiles\/([\w-]+)\/refresh$/, (c, id) => wrap(async () => { need(hasDfs(c.env), 'DataForSEO is not set up.'); return json(await refreshProfile(c.env, id, profileDeps(c.env))); })],
  ['PATCH', /^\/api\/profiles\/([\w-]+)$/, (c, id) => wrap(async () => { await updateProfile(c.env, id, c.body); return json({ ok: true }); })],
  [
    'DELETE',
    /^\/api\/profiles\/([\w-]+)$/,
    async (c, id) => {
      await run(c.env, 'DELETE FROM profiles WHERE id = ?', id);
      return json({ ok: true });
    },
  ],
  ['GET', /^\/api\/config$/, async (c) => json({ live: hasDfs(c.env), email: c.email, spent: await monthSpend(c.env), cap: monthlyCap(c.env) })],
  [
    'GET',
    /^\/api\/locations$/,
    async (c) =>
      json(
        await all(
          c.env,
          `SELECT l.id, l.name, COUNT(s.id) AS scans, MAX(s.created_at) AS last_scan,
             (SELECT keyword FROM scans WHERE location_id = l.id AND status = 'done' ORDER BY created_at DESC LIMIT 1) AS last_keyword,
             (SELECT ROUND(100.0 * SUM(rank IS NOT NULL AND rank <= 3) / COUNT(*)) FROM points WHERE scan_id =
               (SELECT id FROM scans WHERE location_id = l.id AND status = 'done' ORDER BY created_at DESC LIMIT 1) AND status = 'done') AS last_top3
           FROM locations l LEFT JOIN scans s ON s.location_id = l.id GROUP BY l.id ORDER BY l.name`,
        ),
      ),
  ],
  ['POST', /^\/api\/locations$/, (c) => createLocation(c.env, c.body)],
  ['GET', /^\/api\/locations\/([\w-]+)$/, (c, id) => getLocation(c.env, id)],
  ['PATCH', /^\/api\/locations\/([\w-]+)$/, (c, id) => updateLocation(c.env, id, c.body)],
  [
    'DELETE',
    /^\/api\/locations\/([\w-]+)$/,
    async (c, id) => {
      await run(c.env, 'DELETE FROM locations WHERE id = ?', id);
      return json({ ok: true });
    },
  ],
  ['POST', /^\/api\/locations\/([\w-]+)\/changes$/, (c, id) => addChange(c.env, id, c.body)],
  [
    'DELETE',
    /^\/api\/changes\/([\w-]+)$/,
    async (c, id) => {
      await run(c.env, 'DELETE FROM changes WHERE id = ?', id);
      return json({ ok: true });
    },
  ],
  ['PUT', /^\/api\/locations\/([\w-]+)\/checklist\/([\w-]+)$/, (c, id, item) => setChecklist(c.env, id, item, c.body)],
  ['POST', /^\/api\/scans$/, async (c) => json({ id: await startScan(c.env, c.body, c.email, c.origin) }, 201)],
  ['GET', /^\/api\/scans\/([\w-]+)$/, (c, id) => getScan(c.env, id)],
  ['POST', /^\/api\/scans\/([\w-]+)\/refresh$/, (c, id) => refreshScan(c.env, id)],
  ['POST', /^\/api\/scans\/([\w-]+)\/share$/, (c, id) => shareScan(c.env, id, c.origin)],
  [
    'DELETE',
    /^\/api\/scans\/([\w-]+)$/,
    async (c, id) => {
      await run(c.env, 'DELETE FROM scans WHERE id = ?', id);
      return json({ ok: true });
    },
  ],
  ['GET', /^\/api\/compare\/([\w-]+)\/([\w-]+)$/, (c, a, b) => compareScans(c.env, a, b)],
  ['POST', /^\/api\/schedules$/, (c) => addSchedule(c.env, c.body)],
  [
    'DELETE',
    /^\/api\/schedules\/([\w-]+)$/,
    async (c, id) => {
      await run(c.env, 'DELETE FROM schedules WHERE id = ?', id);
      return json({ ok: true });
    },
  ],
];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    try {
      // Public paths (Access bypass): shared reports, their assets, and DataForSEO postbacks.
      if (method === 'POST' && path === '/api/postback') return await postback(req, env, url);
      if (method === 'GET' && path === '/assets/app.js') return asset(APP_JS, 'text/javascript');
      if (method === 'GET' && path === '/assets/app.css') return asset(APP_CSS, 'text/css');
      if (method === 'GET' && path === '/assets/prompts.js') return asset(PROMPTS_JS, 'text/javascript');
      if (method === 'GET' && /^\/r\/[a-f0-9]{48}$/.test(path)) return page();
      if (method === 'GET' && path.startsWith('/api/share/')) return await getShared(env, path.slice(11));

      const local = env.DEV_EMAIL && url.hostname === 'localhost';
      const email = local ? env.DEV_EMAIL : await accessEmail(req, env);
      if (!email) return json({ error: 'Unauthorised' }, 401);
      if (method === 'GET' && path === '/') return page();

      for (const [m, re, handler] of routes) {
        const match = method === m && path.match(re);
        if (!match) continue;
        const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await req.json().catch(() => ({})) : null;
        return await handler({ env, email, body: body || {}, origin: url.origin }, ...match.slice(1));
      }
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong.' }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runSchedules(env));
  },
};
