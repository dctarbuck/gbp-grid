// Prompt library: turns scan data into ready-to-paste AI prompts.
// AI writes the copy and plans; the person still makes the change in Google Business Profile.
(() => {
  'use strict';

  const list = (items) => items.filter(Boolean).join(', ') || 'none';

  // "12 High St, Haxby, York YO32 3XX" -> "York"
  function townFrom(address) {
    const parts = String(address || '').split(',').map((s) => s.trim()).filter(Boolean);
    const last = (parts[parts.length - 1] || '').replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i, '').replace(/\b[A-Z]{1,2}\d[A-Z\d]?\b/i, '').trim();
    return last || parts[parts.length - 2] || '';
  }

  function context(loc, analysis, keyword) {
    const self = analysis?.self || null;
    const leaders = (analysis?.competitors || []).filter((c) => c.top3 > 0).slice(0, 5);
    return {
      name: self?.title || loc.name,
      town: townFrom(self?.address) || '[your town]',
      address: self?.address || '[your address]',
      keyword: keyword || '[main keyword]',
      category: self?.category || '[current primary category]',
      extras: list(self?.categories || []),
      rating: self?.rating ?? '?',
      reviews: self?.reviews ?? '?',
      website: self?.website || '[your website]',
      leaders,
      competitors: analysis?.competitors || [],
      sectors: analysis?.reach?.sectors || [],
      lat: loc.lat,
      lng: loc.lng,
    };
  }

  function header(c) {
    const rivals = c.leaders.length
      ? c.leaders.map((l) => `- ${l.title} — ${l.category || 'unknown category'}, ${l.rating ?? '?'}★ from ${l.reviews ?? '?'} reviews`).join('\n')
      : '- (no competitor data yet)';
    return `You are a local SEO specialist helping a UK business improve its Google Business Profile (GBP).

About the business:
- Name: ${c.name}
- Address: ${c.address}
- Main search term we want to rank for: "${c.keyword}"
- Primary category: ${c.category}
- Extra categories: ${c.extras}
- Google rating: ${c.rating}★ from ${c.reviews} reviews
- Website: ${c.website}

Businesses currently beating us in the Google Maps results:
${rivals}

Rules you must follow:
- Follow Google Business Profile guidelines. No keyword stuffing, no fake or incentivised reviews, no false claims.
- Write in plain UK English, short sentences, friendly and professional.
- If you need a fact you don't have, ask me before you write. Don't invent details.
`;
  }

  const reviewAsk = (c) => `${header(c)}
Task: help me build a steady flow of genuine Google reviews (a few every week, not a burst).
Write:
1. A 2-sentence script to ask a happy customer in person.
2. A text message under 160 characters with [REVIEW LINK].
3. A short follow-up email.
4. A gentle reminder to send 5 days later if they haven't left one.
5. A simple weekly routine for me and any staff.
Don't offer rewards. Don't tell customers what words to use. Keep the tone warm and low-pressure.`;

  const replyTemplates = (c) => `${header(c)}
Task: write Google review reply templates I can personalise in 30 seconds.
Give me: three 5-star variations, one 4-star, one 3-star, and one 1–2 star.
Each reply: under 60 words, uses [NAME] and one specific detail placeholder, thanks them, and sounds human.
For negative reviews: stay calm, don't argue, don't share private details, and offer to take it offline with [CONTACT].`;

  const landingPage = (c) => `${header(c)}
Task: plan the web page my Google Business Profile should link to, for "${c.keyword}" in ${c.town}.
Give me:
1. Page title (under 60 characters) with the service and town.
2. Meta description (under 155 characters).
3. H1 heading.
4. A section-by-section outline with a 1-line note on what each section says.
5. Five FAQs with short answers.
6. The exact name, address and phone block. It must match my GBP word for word. Use [placeholders] for anything you don't know.
Write for people first. Mention the town naturally, never as a keyword list.`;

  const pageAudit = (c) => `${header(c)}
Task: audit my current landing page. Here is the page text:
[PASTE THE PAGE TEXT OR URL HERE]

Check it against "${c.keyword}" in ${c.town}:
- Title and H1: do they name the service and town?
- Is the name, address and phone on the page an exact match for GBP?
- Is there a clear section for each main service?
- Is anything missing that a customer would need to choose us?
Give a prioritised list of fixes, then rewritten title, meta description and H1.`;

  const photoList = (c) => `${header(c)}
Task: create a 20-shot photo list for my Google Business Profile.
Cover: outside (so people can find the door), inside, team, us at work, and results or products.
For each shot: what to capture, the best time of day, and a one-line caption idea.
Real photos only, no stock. Note: geotagging photos does nothing for rankings, so skip it.`;

  const localLinks = (c, dir) => `${header(c)}
Task: suggest 15 realistic local link and mention opportunities${dir ? ` in the area to the ${dir} of our location (around ${c.lat}, ${c.lng})` : ` near ${c.town}`}.
Think: community groups, sports clubs, venues, schools, charities, local news, events, and genuine local directories.
For each: why it's relevant, how likely it is, and a 3-line outreach message I can send.
No paid links, no link schemes.`;

  const categoryHelp = (c, extraOnly) => {
    const cats = {};
    c.leaders.forEach((l) => [l.category, ...(l.categories || [])].filter(Boolean).forEach((x) => (cats[x] = (cats[x] || 0) + 1)));
    const common = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`).join(', ') || 'unknown';
    return `${header(c)}
Categories used by the leaders (and how many use each): ${common}

Task: help me ${extraOnly ? 'choose accurate extra categories' : 'choose the best primary category, then any extra categories'}.
First, ask me for: my full list of services, and which ones bring in the most money.
Then recommend ${extraOnly ? 'up to 4 extra categories' : 'one primary category and up to 4 extra categories'} from Google's official category list.
For each: why it fits, and any risk. Tell me plainly if a category would NOT truly describe my business. Wrong categories can hurt rankings.`;
  };

  const brandKeywords = (c) => `${header(c)}
Task: suggest 12 search terms a NEW customer would type to find a business like mine in ${c.town}. They don't know our name yet.
Group them by: the service itself, the problem it solves, and "near me" style searches.
Mark the 3 I should track first in my rank tracker, and say why.
Don't include our brand name.`;

  const notFound = (c) => `${header(c)}
Task: we don't show in the top 20 Google Maps results for "${c.keyword}" anywhere in our area.
Give me a diagnosis checklist ordered by the most likely cause. For each item: what to check in GBP or on the website, and how to fix it.
Include: category fit, services list, the name matching real signage, the map pin, verification, suspensions, and whether the term matches what we actually offer.`;

  const spamCheck = (c, names) => `${header(c)}
These competitor names in the map results might break Google's naming rules:
${(names.length ? names : ['[COMPETITOR NAME]']).map((n) => `- ${n}`).join('\n')}

Task:
1. For each, explain what Google allows in a business name and what looks like it breaks the rules.
2. List the evidence I should check first: their signage, website, invoices, Companies House record.
3. Draft a short, neutral "Suggest an edit" note for each one that turns out to be wrong. Stick to facts I can verify. No accusations.`;

  const rating = (c) => `${header(c)}
Here are my recent 1–3 star reviews:
[PASTE THE REVIEWS HERE]

Task:
1. Find the common themes.
2. Suggest practical fixes for each theme.
3. Draft a calm, helpful public reply to each review (under 80 words). Don't argue, don't share private details, and offer to talk offline.`;

  const description = (c) => `${header(c)}
Task: write my Google Business Profile description.
- Max 750 characters. Put the most important point in the first 250.
- Say what we do, who it's for, and the area we serve, naturally.
- No links, prices, offers, ALL CAPS or keyword lists. These break GBP rules.
Give me 2 versions with different tones.`;

  const services = (c) => `${header(c)}
Task: build my Google Business Profile services list.
First ask me what I offer. Then, for each service, give a clear service name and a description under 300 characters.
Mark which ones match Google's predefined services for my category, as those are worth adding first. Only include services I really offer.`;

  const faqs = (c) => `${header(c)}
Task: write 8 FAQs for my website page about "${c.keyword}" in ${c.town}.
Use real questions customers ask before choosing a business like mine. Answers under 60 words, plain and specific. Use [placeholders] for prices, times and details I need to fill in.`;

  // Step prompts keyed by recommendation id.
  const forRec = {
    'brand-keyword': brandKeywords,
    'not-found': notFound,
    'primary-category': (c) => categoryHelp(c, false),
    'extra-categories': (c) => categoryHelp(c, true),
    'reviews-base': reviewAsk,
    'reviews-gap': reviewAsk,
    'review-pace': reviewAsk,
    rating,
    website: landingPage,
    'landing-page': pageAudit,
    photos: photoList,
    'weak-direction': (c, r) => localLinks(c, (r.title.match(/weakest to the (.+)$/) || [])[1]),
    spam: (c, r) => spamCheck(c, [...String(r.evidence).matchAll(/"([^"]+)"/g)].map((m) => m[1])),
  };

  // Checklist prompts keyed by checklist item.
  const forChecklist = {
    description,
    services,
    'page-title': landingPage,
    nap: landingPage,
    'service-pages': landingPage,
    faqs,
    'review-link': reviewAsk,
    'review-replies': replyTemplates,
    photos: photoList,
    links: (c) => localLinks(c, null),
    spam: (c) => spamCheck(c, []),
    'primary-category': (c) => categoryHelp(c, false),
    'extra-categories': (c) => categoryHelp(c, true),
  };

  window.GR_PROMPTS = {
    context,
    rec: (r, ctx) => (forRec[r.id] ? forRec[r.id](ctx, r) : null),
    checklist: (item, ctx) => (forChecklist[item] ? forChecklist[item](ctx) : null),
  };
})();
