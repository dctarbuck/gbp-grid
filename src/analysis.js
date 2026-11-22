// Turns one scan (points + listings) into competitor stats, reach and a ranked action plan.
// Guidance is tied to evidence levels from the research: Google guidance > controlled tests > expert survey.

const STOP = new Set(['near', 'me', 'in', 'the', 'best', 'for', 'and', 'a', 'of', 'to', 'top', 'local', 'cheap', 'my', 'nearby']);
const SECTORS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const IMPACT = { high: 0, medium: 1, low: 2 };

export const listingKey = (i) => i.place_id || (i.cid ? `cid:${i.cid}` : `t:${String(i.title || '').trim().toLowerCase()}`);

export const isTarget = (item, loc) =>
  Boolean(
    (loc.place_id && item.place_id === loc.place_id) ||
      (loc.cid && String(item.cid) === String(loc.cid)) ||
      (!loc.place_id && !loc.cid && item.title?.trim().toLowerCase() === loc.name.trim().toLowerCase()),
  );

export function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}

function bearing(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const sectorOf = (deg) => SECTORS[Math.round(deg / 45) % 8];

function median(values) {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));
const parseJSON = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

export function analyse({ scan, location, points, listings, previous }) {
  const byKey = new Map(listings.map((l) => [l.key, { ...l, categories: parseJSON(l.categories, []) }]));
  const done = points.filter((p) => p.status === 'done');
  const n = done.length;
  const pin = { lat: location.lat, lng: location.lng };

  // Presence of every listing across the grid.
  const stats = new Map();
  for (const p of done) {
    parseJSON(p.ranks, []).forEach((key, i) => {
      const s = stats.get(key) || { appear: 0, top3: 0, sum: 0, best: 99 };
      s.appear += 1;
      s.sum += i + 1;
      s.best = Math.min(s.best, i + 1);
      if (i < 3) s.top3 += 1;
      stats.set(key, s);
    });
  }

  const self = [...byKey.values()].find((l) => isTarget(l, location)) || null;
  const selfFound = done.filter((p) => p.rank != null);
  const selfTop3 = selfFound.filter((p) => p.rank <= 3);

  const competitors = [...stats.entries()]
    .filter(([key]) => !self || key !== self.key)
    .map(([key, s]) => ({ key, ...byKey.get(key), ...s, avg: s.sum / s.appear, top3Share: pct(s.top3, n), appearShare: pct(s.appear, n) }))
    .filter((c) => c.title)
    .sort((a, b) => b.top3 - a.top3 || b.appear - a.appear || a.avg - b.avg)
    .slice(0, 10);
  competitors.forEach((c) => {
    c.distanceKm = c.lat != null ? +distanceKm(pin, c).toFixed(1) : null;
    c.direction = c.lat != null && c.distanceKm >= 0.3 ? sectorOf(bearing(pin, c)) : null;
  });
  const leaders = competitors.filter((c) => c.top3 > 0).slice(0, 5);

  // Reach: how rank holds up with distance from the pin, and by compass direction.
  const bandEdges = [0, 1, 2, 3, 5, Infinity];
  const bands = bandEdges.slice(0, -1).map((from, i) => ({ from, to: bandEdges[i + 1], n: 0, found: 0, top3: 0 }));
  const sectors = Object.fromEntries(SECTORS.map((s) => [s, { n: 0, sumRank: 0, top3: 0, winners: {} }]));
  for (const p of done) {
    const d = distanceKm(pin, p);
    const band = bands.find((b) => d >= b.from && d < b.to);
    band.n += 1;
    if (p.rank != null) band.found += 1;
    if (p.rank != null && p.rank <= 3) band.top3 += 1;
    if (d < 0.3) continue;
    const s = sectors[sectorOf(bearing(pin, p))];
    s.n += 1;
    s.sumRank += p.rank ?? 21;
    if (p.rank != null && p.rank <= 3) s.top3 += 1;
    const first = parseJSON(p.ranks, [])[0];
    if (first && (!self || first !== self.key)) s.winners[first] = (s.winners[first] || 0) + 1;
  }
  const bandRows = bands.filter((b) => b.n).map((b) => ({ ...b, foundShare: pct(b.found, b.n), top3Share: pct(b.top3, b.n) }));
  const strongRadius = bandRows.filter((b) => b.top3Share >= 50).reduce((r, b) => Math.max(r, b.to === Infinity ? b.from : b.to), 0);
  const sectorRows = SECTORS.map((name) => {
    const s = sectors[name];
    const [winKey, wins] = Object.entries(s.winners).sort((a, b) => b[1] - a[1])[0] || [];
    return { name, n: s.n, avgRank: s.n ? +(s.sumRank / s.n).toFixed(1) : null, top3: s.top3, winner: winKey ? byKey.get(winKey)?.title : null, wins: wins || 0 };
  }).filter((s) => s.n);

  // Scans from before competitor capture have ranks only: show reach, skip advice that needs listing data.
  const legacy = done.length > 0 && done.every((p) => p.ranks == null);
  if (legacy) {
    return {
      legacy: true,
      points: n,
      self: null,
      competitors: [],
      reach: { bands: bandRows, strongRadius, sectors: sectorRows },
      recommendations: [],
      strengths: [],
    };
  }

  const recs = [];
  const strengths = [];
  const add = (r) => recs.push(r);
  const kw = tokens(scan.keyword);
  const selfTokens = new Set(tokens(location.name));

  // Brand keyword: Google jumps to one listing, so the grid can't show real competition.
  const brandWords = kw.filter((t) => selfTokens.has(t));
  const singleResultShare = pct(done.filter((p) => parseJSON(p.ranks, []).length <= 1).length, n);
  if (brandWords.length && kw.length && brandWords.length >= Math.ceil(kw.length / 2)) {
    add({
      id: 'brand-keyword',
      impact: 'high',
      title: 'Track a non-brand keyword too',
      evidence: `"${scan.keyword}" contains your business name.${singleResultShare >= 30 ? ` ${singleResultShare}% of points returned one result only.` : ''}`,
      why: 'People who search your name already know you. New customers search for the service. Brand searches make the map look better than it is.',
      how: ['Run a scan for what a new customer would type, e.g. the service plus "near me".', 'Track 2–3 service keywords per location.', 'Keep the brand scan only to check you show up for your own name.'],
      basis: 'Method',
    });
  }

  if (!self) {
    add({
      id: 'not-found',
      impact: 'high',
      title: 'You are not in the top 20 anywhere on this grid',
      evidence: `0 of ${n} points.`,
      why: 'Either the app cannot match your listing, or Google does not see you as relevant for this keyword.',
      how: [
        location.place_id || location.cid ? 'Check the Place ID on the Settings tab is right.' : 'Add your Place ID on the Settings tab. Name matching only works if the name is exact.',
        'Check your primary category matches this keyword.',
        'Add this service to your GBP services list, if you offer it.',
        'Run a smaller grid (e.g. 0.5 km apart) to see if you show up near your address.',
      ],
      basis: 'Google guidance',
    });
  }

  const leaderCats = leaders.map((c) => c.category).filter(Boolean);
  const catCounts = leaderCats.reduce((m, c) => m.set(c, (m.get(c) || 0) + 1), new Map());
  const [topCat, topCatCount] = [...catCounts.entries()].sort((a, b) => b[1] - a[1])[0] || [];

  if (self) {
    // Primary category
    if (self.category && topCat && self.category !== topCat && topCatCount / leaderCats.length >= 0.5) {
      const hasAsExtra = self.categories.includes(topCat);
      add({
        id: 'primary-category',
        impact: 'high',
        title: `Review your primary category`,
        evidence: `${topCatCount} of ${leaderCats.length} leaders use "${topCat}". Yours is "${self.category}".${hasAsExtra ? ` You have "${topCat}" as an extra category.` : ''}`,
        why: 'Primary category is the strongest ranking factor you control. Experts rank it #1 for the map pack.',
        how: ['GBP → Edit profile → Business category.', `Only switch if "${topCat}" truly describes your main service.`, 'Change one thing at a time, then re-scan in 2–3 weeks.'],
        basis: 'Expert survey (#1 factor)',
      });
    } else if (self.category && self.category === topCat) {
      strengths.push(`Your primary category ("${self.category}") matches most leaders.`);
    }

    // Extra categories
    const selfCats = new Set([self.category, ...self.categories].filter(Boolean));
    const catFreq = new Map();
    leaders.forEach((c) => new Set([c.category, ...(c.categories || [])].filter(Boolean)).forEach((x) => catFreq.set(x, (catFreq.get(x) || 0) + 1)));
    const missing = [...catFreq.entries()].filter(([c, k]) => !selfCats.has(c) && leaders.length >= 3 && k / leaders.length >= 0.4).map(([c]) => c);
    if (missing.length) {
      add({
        id: 'extra-categories',
        impact: 'medium',
        title: 'Consider extra categories',
        evidence: `Common among leaders but missing on yours: ${missing.slice(0, 4).map((c) => `"${c}"`).join(', ')}.`,
        why: 'Extra categories help you show for related searches. Wrong ones can hurt ("category confusion").',
        how: ['Add only categories for services you really offer.', 'Use the fewest categories that describe the business (Google guidance).'],
        basis: 'Expert survey + Google guidance',
      });
    }

    // Reviews
    // Google shows no rating block when a listing has no reviews: count that as 0.
    const compReviews = median(leaders.map((c) => c.reviews ?? (c.rating == null ? 0 : null)));
    const myReviews = self.reviews || 0;
    if (myReviews < 10) {
      add({
        id: 'reviews-base',
        impact: 'high',
        title: 'Get to at least 10 Google reviews',
        evidence: `You have ${myReviews}.${compReviews != null ? ` Leaders have about ${Math.round(compReviews)}.` : ''}`,
        why: 'Tests found a ranking lift around the 10-review mark. Google says more reviews and good ratings help.',
        how: ['Ask every happy customer, in person, then send a direct review link.', 'GBP → Ask for reviews gives you the link.', 'Never offer rewards or write fake reviews.'],
        basis: 'Google guidance + controlled tests',
      });
    } else if (compReviews != null && myReviews < compReviews * 0.8) {
      add({
        id: 'reviews-gap',
        impact: myReviews < compReviews * 0.5 ? 'high' : 'medium',
        title: 'Close the review gap',
        evidence: `You have ${myReviews} reviews. Leaders have about ${Math.round(compReviews)} (gap ≈ ${Math.round(compReviews - myReviews)}).`,
        why: 'Review count and recency are both top-15 factors. A steady flow beats a burst then silence.',
        how: ['Aim for a few new reviews every week, not 20 in one go.', 'Ask for honest, specific reviews. Do not script keywords.', 'Reply to every review.'],
        basis: 'Google guidance + expert survey',
      });
    } else if (compReviews != null) {
      strengths.push(`Your review count (${myReviews}) is level with or ahead of leaders (~${Math.round(compReviews)}).`);
    }

    // Review pace vs a previous scan
    if (previous?.listings?.length) {
      const days = Math.max(1, (Date.parse(scan.created_at + 'Z') - Date.parse(previous.created_at + 'Z')) / 864e5);
      if (days >= 7) {
        const prev = new Map(previous.listings.map((l) => [l.key, l]));
        const gain = (l) => (prev.get(l.key)?.reviews != null && l.reviews != null ? l.reviews - prev.get(l.key).reviews : null);
        const myGain = gain(self);
        const leaderGain = median(leaders.map(gain));
        if (myGain != null && leaderGain != null && myGain < leaderGain) {
          add({
            id: 'review-pace',
            impact: 'medium',
            title: 'Leaders are getting reviews faster',
            evidence: `In the last ${Math.round(days)} days you gained ${myGain}. Leaders gained about ${Math.round(leaderGain)}.`,
            why: 'Experts rate review recency and a steady flow as top-15 factors.',
            how: ['Build asking into every visit or job.', 'Track weekly. A quiet month shows up here.'],
            basis: 'Expert survey',
          });
        }
      }
    }

    // Rating
    const compRating = median(leaders.map((c) => c.rating));
    if (self.rating != null && self.rating < 4.5 && compRating != null && compRating >= 4.5) {
      add({
        id: 'rating',
        impact: self.rating < 4 ? 'high' : 'medium',
        title: 'Lift your star rating',
        evidence: `You are ${self.rating}★. Leaders are about ${compRating.toFixed(1)}★.`,
        why: 'High ratings rank #6 in the expert survey. 31% of people only use 4.5★+ businesses (BrightLocal 2026).',
        how: ['Fix the issues the low reviews mention.', 'Reply calmly to every negative review.', 'Get more reviews from happy customers. Volume dilutes old low scores.'],
        basis: 'Expert survey + consumer survey',
      });
    }

    if (self.claimed === 0) {
      add({
        id: 'claim',
        impact: 'high',
        title: 'Claim and verify your listing',
        evidence: 'Google shows this listing as unclaimed.',
        why: 'You cannot edit categories, hours or reply to reviews without owning it. Verified listings rank better.',
        how: ['Search your business on Google → "Own this business?"', 'Follow the verification steps.'],
        basis: 'Google guidance',
      });
    }

    if (self.has_hours === 0) {
      add({
        id: 'hours',
        impact: 'high',
        title: 'Add your opening hours',
        evidence: 'No hours found on your listing.',
        why: 'Being open at the time of search is now a top-5 factor. Google confirmed it uses open status.',
        how: ['GBP → Edit profile → Hours.', 'Add special hours for bank holidays and Christmas.', 'For classes or groups, list the session times.'],
        basis: 'Google statement + expert survey (#5)',
      });
    }

    if (!self.website) {
      add({
        id: 'website',
        impact: 'medium',
        title: 'Link a relevant web page',
        evidence: 'No website on your listing.',
        why: 'On-page signals are 15% of map pack weight (expert survey). A matching page backs up your relevance.',
        how: ['Link to a page about this location and service, not just a social profile.', 'Put your name, address and phone on that page, matching GBP exactly.'],
        basis: 'Expert survey',
      });
    } else {
      add({
        id: 'landing-page',
        impact: 'low',
        title: 'Check your landing page',
        evidence: `Your listing links to ${self.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}.`,
        why: 'Page title keywords and matching name/address/phone are top-20 factors.',
        how: [`Page title includes "${scan.keyword}" (or the service) and the town.`, 'Name, address and phone on the page match GBP exactly.', 'A dedicated page per main service.'],
        basis: 'Expert survey',
      });
    }

    const compPhotos = median(leaders.map((c) => c.photos));
    if (self.photos != null && compPhotos && self.photos < compPhotos * 0.5) {
      add({
        id: 'photos',
        impact: 'low',
        title: 'Add more real photos',
        evidence: `You have ${self.photos} photos. Leaders have about ${Math.round(compPhotos)}.`,
        why: 'Photos are a modest ranking signal but help people choose you. Geotagging photos does nothing.',
        how: ['Add outside (so people find you), inside, team and work photos.', 'Use real photos, not stock.', 'Add a few each month.'],
        basis: 'Google guidance + tests (conversion)',
      });
    }

    // Name keyword (policy-sensitive)
    const leadersWithKw = leaders.filter((c) => kw.some((t) => tokens(c.title).includes(t))).length;
    if (!brandWords.length && kw.length && leaders.length >= 3 && !kw.some((t) => selfTokens.has(t)) && leadersWithKw / leaders.length >= 0.6) {
      add({
        id: 'name',
        impact: 'low',
        title: 'Most leaders have the keyword in their name',
        evidence: `${leadersWithKw} of ${leaders.length} leaders' names include "${kw.join(' ')}". Yours does not.`,
        why: 'Name keywords are a strong signal, but adding words to your name breaks Google rules and can get you suspended.',
        how: ['Do NOT add keywords to your GBP name.', 'Only change it if your real trading name (signage, website, invoices) changes.', 'Check whether leaders are stuffing their names (see spam below).'],
        basis: 'Google policy',
      });
    }

    // Reach and direction
    const weak = sectorRows.filter((s) => s.avgRank != null && s.avgRank > 10).sort((a, b) => b.avgRank - a.avgRank)[0];
    if (weak && weak.winner) {
      const w = competitors.find((c) => c.title === weak.winner);
      add({
        id: 'weak-direction',
        impact: 'medium',
        title: `You are weakest to the ${weak.name}`,
        evidence: `Average rank ${weak.avgRank} there. ${weak.winner} is #1 at ${weak.wins} of ${weak.n} points${w?.distanceKm != null ? ` and sits ${w.distanceKm} km ${w.direction || 'away'} of you` : ''}.`,
        why: 'Distance is one of Google\'s three official factors. You cannot fake it. You can widen your reach with stronger relevance and prominence.',
        how: ['Compare your listing with theirs in the table below: category, reviews, photos.', 'Earn local links and mentions from that area (clubs, venues, local news).', 'Do not use a fake or virtual address. That risks suspension.'],
        basis: 'Google guidance',
      });
    }
  }

  // Possible spam in the competitive set
  const city = (self?.address || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const suspicious = competitors.filter((c) => {
    const words = String(c.title).split(/\s+/).length;
    const t = String(c.title).toLowerCase();
    const hasKw = kw.some((k) => tokens(c.title).includes(k));
    const hasCity = city.some((part) => part.length > 3 && t.includes(part));
    return c.top3 > 0 && (words >= 7 || /[|•]| - /.test(c.title) || (hasKw && hasCity));
  });
  if (suspicious.length) {
    add({
      id: 'spam',
      impact: 'medium',
      title: 'Check rivals for keyword-stuffed names',
      evidence: `Possible: ${suspicious.slice(0, 3).map((c) => `"${c.title}"`).join(', ')}.`,
      why: 'Names with extra keywords or towns break Google rules. Reporting fakes is allowed and can win back spots (spam fighting ranks #19).',
      how: ['Compare their GBP name with their signage and website.', 'If it does not match: Google Maps → listing → Suggest an edit → Change name.', 'For fake listings, use Google\'s Business Redressal Complaint Form.', 'These are only flags. Check before you report.'],
      basis: 'Google policy + expert survey',
    });
  }

  if (self && selfTop3.length / (n || 1) >= 0.8) strengths.push(`You are top 3 at ${pct(selfTop3.length, n)}% of points.`);

  recs.sort((a, b) => IMPACT[a.impact] - IMPACT[b.impact]);

  return {
    points: n,
    self: self && { ...self, found: selfFound.length, top3: selfTop3.length, avg: selfFound.length ? +(selfFound.reduce((s, p) => s + p.rank, 0) / selfFound.length).toFixed(1) : null },
    competitors,
    reach: { bands: bandRows, strongRadius, sectors: sectorRows },
    recommendations: recs,
    strengths,
  };
}
