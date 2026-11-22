// Profile comparison: track Google profiles (yours and rivals) side by side.
// Data comes free from scans, or on demand from DataForSEO's Business Info lookup.

const LOOKUP = 'https://api.dataforseo.com/v3/business_data/google/my_business_info/live';
const COLS = ['name', 'place_id', 'cid', 'category', 'categories', 'rating', 'reviews', 'photos', 'claimed', 'has_hours', 'website', 'phone', 'address', 'lat', 'lng', 'desc_len', 'source'];

// Accepts a Google Maps link, a Place ID, a "cid=" link or a bare CID.
export function parseProfileInput(raw) {
  const s = String(raw || '').trim();
  let m;
  if ((m = s.match(/[?&]cid=(\d{5,30})/))) return { cid: m[1] };
  if ((m = s.match(/0x[0-9a-f]+:0x([0-9a-f]+)/i))) return { cid: BigInt(`0x${m[1]}`).toString() };
  if ((m = s.match(/(ChIJ[\w-]{10,})/))) return { place_id: m[1] };
  if (/^\d{5,30}$/.test(s)) return { cid: s };
  return null;
}

export const guessGroup = (title) => (/slimming world/i.test(title || '') ? 'Slimming World' : 'Other');

function fromLookup(item) {
  const attrs = item.attributes?.available_attributes || {};
  return {
    name: String(item.title || '').slice(0, 200),
    place_id: item.place_id || null,
    cid: item.cid ? String(item.cid) : null,
    category: item.category || null,
    categories: JSON.stringify((item.additional_categories || []).slice(0, 10)),
    rating: item.rating?.value ?? null,
    reviews: item.rating?.votes_count ?? (item.rating ? 0 : null),
    photos: item.total_photos ?? null,
    claimed: typeof item.is_claimed === 'boolean' ? Number(item.is_claimed) : null,
    has_hours: item.work_time?.work_hours?.timetable ? 1 : 0,
    website: item.url || null,
    phone: item.phone || null,
    address: item.address || null,
    lat: item.latitude ?? null,
    lng: item.longitude ?? null,
    desc_len: item.description ? String(item.description).length : 0,
    source: 'lookup',
    attributes: Object.values(attrs).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0),
  };
}

const fromListing = (l) => ({
  name: l.title,
  place_id: l.place_id,
  cid: l.cid,
  category: l.category,
  categories: l.categories,
  rating: l.rating,
  reviews: l.reviews,
  photos: l.photos,
  claimed: l.claimed,
  has_hours: l.has_hours,
  website: l.website,
  phone: l.phone,
  address: l.address,
  lat: l.lat,
  lng: l.lng,
  desc_len: null,
  source: 'scan',
});

function snapshot(env, id, p, cost) {
  return env.DB.prepare(
    `INSERT INTO profile_snapshots (profile_id, day, rating, reviews, photos, cost, source) VALUES (?, date('now'), ?, ?, ?, ?, ?)
     ON CONFLICT (profile_id, day) DO UPDATE SET rating = excluded.rating, reviews = excluded.reviews, photos = excluded.photos,
       cost = profile_snapshots.cost + excluded.cost, source = excluded.source`,
  ).bind(id, p.rating ?? null, p.reviews ?? null, p.photos ?? null, cost || 0, p.source);
}

function writeProfile(env, id, p) {
  const cols = COLS.filter((c) => c !== 'desc_len' || p.desc_len != null);
  return env.DB.prepare(`UPDATE profiles SET ${cols.map((c) => `${c} = COALESCE(?, ${c})`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).bind(
    ...cols.map((c) => p[c] ?? null),
    id,
  );
}

async function findExisting(env, { place_id, cid }) {
  return env.DB.prepare('SELECT id, name FROM profiles WHERE (? IS NOT NULL AND place_id = ?) OR (? IS NOT NULL AND cid = ?)')
    .bind(place_id || null, place_id || null, cid || null, cid || null)
    .first();
}

export async function lookup(env, ids, dfsAuth) {
  const keyword = ids.place_id ? `place_id:${ids.place_id}` : `cid:${ids.cid}`;
  const res = await fetch(LOOKUP, {
    method: 'POST',
    headers: { authorization: dfsAuth, 'content-type': 'application/json' },
    body: JSON.stringify([{ keyword, location_name: 'United Kingdom', language_code: 'en' }]),
  });
  const data = await res.json().catch(() => ({}));
  const task = data.tasks?.[0];
  if (!task || task.status_code !== 20000) throw Object.assign(new Error(`DataForSEO: ${task?.status_message || data.status_message || res.status}`), { status: 502 });
  const item = task.result?.[0]?.items?.[0];
  if (!item) throw Object.assign(new Error('Google returned no profile for that ID. Check the link.'), { status: 404 });
  return { profile: fromLookup(item), cost: Number(task.cost) || 0 };
}

// days > 0: baseline is the latest snapshot at least `days` old (else the earliest one).
// days = 0: baseline is the first snapshot ever taken (since tracking started).
export async function listProfiles(env, days = 30) {
  const cutoff = `-${Math.max(0, Math.min(365, Number(days) || 0))} days`;
  const profiles = (
    await env.DB.prepare(
      `SELECT p.*,
         (SELECT MIN(day) FROM profile_snapshots s WHERE s.profile_id = p.id) AS first_day,
         (SELECT ROUND(SUM(cost), 4) FROM profile_snapshots s WHERE s.profile_id = p.id) AS total_cost,
         EXISTS (SELECT 1 FROM locations l WHERE (l.place_id IS NOT NULL AND l.place_id = p.place_id) OR (l.cid IS NOT NULL AND l.cid = p.cid)) AS yours
       FROM profiles p ORDER BY p.grp, p.name`,
    ).all()
  ).results;
  const base = (
    await env.DB.prepare(
      `SELECT profile_id, day, rating, reviews, photos FROM (
         SELECT s.*, ROW_NUMBER() OVER (
           PARTITION BY profile_id
           ORDER BY CASE WHEN ?1 = '-0 days' THEN 1 WHEN day <= date('now', ?1) THEN 0 ELSE 1 END,
                    CASE WHEN ?1 != '-0 days' AND day <= date('now', ?1) THEN day END DESC,
                    day ASC) AS rn
         FROM profile_snapshots s) WHERE rn = 1`,
    )
      .bind(cutoff)
      .all()
  ).results;
  const byId = new Map(base.map((b) => [b.profile_id, b]));
  return profiles.map((p) => {
    const b = byId.get(p.id);
    return b && b.day < new Date().toISOString().slice(0, 10)
      ? { ...p, base_day: b.day, base_rating: b.rating, base_reviews: b.reviews, base_photos: b.photos }
      : { ...p, base_day: null };
  });
}

export async function suggestions(env) {
  return (
    await env.DB.prepare(
      `SELECT li.key, li.place_id, li.cid, li.title, li.category, li.rating, li.reviews, li.photos, li.address,
         COUNT(DISTINCT li.scan_id) AS scans, MAX(s.created_at) AS last_seen
       FROM listings li JOIN scans s ON s.id = li.scan_id
       WHERE s.mode = 'live' AND NOT EXISTS (
         SELECT 1 FROM profiles p WHERE (li.place_id IS NOT NULL AND p.place_id = li.place_id) OR (li.cid IS NOT NULL AND p.cid = li.cid))
       GROUP BY li.key ORDER BY scans DESC, li.title LIMIT 300`,
    ).all()
  ).results;
}

export async function addProfile(env, b, { hasDfs, dfsAuth, checkCap }) {
  const grp = String(b.grp || '').trim().slice(0, 40);
  let p;
  let cost = 0;
  if (b.from_key) {
    const l = await env.DB.prepare(
      `SELECT li.* FROM listings li JOIN scans s ON s.id = li.scan_id WHERE li.key = ? AND s.mode = 'live' ORDER BY s.created_at DESC LIMIT 1`,
    )
      .bind(String(b.from_key))
      .first();
    if (!l) throw Object.assign(new Error('That business is no longer in your scans.'), { status: 404 });
    p = fromListing(l);
  } else {
    const ids = parseProfileInput(b.input);
    if (!ids) throw Object.assign(new Error('Paste a Google Maps link, a Place ID (starts ChIJ) or a CID number.'), { status: 400 });
    if (await findExisting(env, ids)) throw Object.assign(new Error('You already track that profile.'), { status: 409 });
    if (hasDfs) {
      await checkCap(0.01);
      ({ profile: p, cost } = await lookup(env, ids, dfsAuth));
    } else {
      const name = String(b.name || '').trim().slice(0, 200);
      if (!name) throw Object.assign(new Error('Add a name (live lookups are not set up).'), { status: 400 });
      p = { ...ids, name, source: 'manual' };
    }
  }
  const dupe = await findExisting(env, p);
  if (dupe) throw Object.assign(new Error(`You already track "${dupe.name}".`), { status: 409 });
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO profiles (id, name, grp) VALUES (?, ?, ?)').bind(id, p.name, grp || guessGroup(p.name)),
    writeProfile(env, id, p),
    snapshot(env, id, p, cost),
  ]);
  return { id, cost };
}

export async function refreshProfile(env, id, { dfsAuth, checkCap }) {
  const row = await env.DB.prepare('SELECT id, place_id, cid FROM profiles WHERE id = ?').bind(id).first();
  if (!row) throw Object.assign(new Error('Profile not found.'), { status: 404 });
  if (!row.place_id && !row.cid) throw Object.assign(new Error('This profile has no Place ID or CID to look up.'), { status: 400 });
  await checkCap(0.01);
  const { profile, cost } = await lookup(env, row, dfsAuth);
  await env.DB.batch([writeProfile(env, id, profile), snapshot(env, id, profile, cost)]);
  return { cost };
}

export async function updateProfile(env, id, b) {
  const grp = String(b.grp ?? '').trim().slice(0, 40);
  const name = String(b.name ?? '').trim().slice(0, 200);
  const sets = [];
  const args = [];
  if (grp) sets.push('grp = ?') && args.push(grp);
  if (name) sets.push('name = ?') && args.push(name);
  if (!sets.length) throw Object.assign(new Error('Nothing to update.'), { status: 400 });
  await env.DB.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id).run();
}

// Called after each live scan point: keeps tracked profiles fresh for free.
export async function syncFromListings(env, listings) {
  const pids = listings.map((l) => l.place_id).filter(Boolean);
  const cids = listings.map((l) => l.cid).filter(Boolean);
  if (!pids.length && !cids.length) return;
  const q = (n) => Array(n).fill('?').join(',') || 'NULL';
  const rows = (
    await env.DB.prepare(`SELECT id, place_id, cid FROM profiles WHERE place_id IN (${q(pids.length)}) OR cid IN (${q(cids.length)})`)
      .bind(...pids, ...cids)
      .all()
  ).results;
  if (!rows.length) return;
  const stmts = [];
  for (const r of rows) {
    const l = listings.find((x) => (r.place_id && x.place_id === r.place_id) || (r.cid && x.cid === r.cid));
    if (!l) continue;
    const p = fromListing(l);
    stmts.push(writeProfile(env, r.id, p), snapshot(env, r.id, p, 0));
  }
  if (stmts.length) await env.DB.batch(stmts);
}
