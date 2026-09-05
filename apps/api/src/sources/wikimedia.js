// The Wikimedia projects, read as a gazetteer and a picture library.
//
// Three endpoints, no key, no account, no bill (the owner asked whether he had
// to set anything up: for everything in this file, he does not):
//
//   query.wikidata.org   SPARQL. What is in a county, how notable it is, where
//                        it is, what it is called, what type of thing it is.
//                        Data is CC0.
//   wikimedia.org/api    Pageviews. How many people looked an article up over
//                        the last twelve months, which is the only signal here
//                        that measures interest rather than completeness.
//   commons.wikimedia.org/w/api.php
//                        The photographs, and — the part that matters — their
//                        licence, their creator and the page where both are
//                        stated, which is the attribution URL Roam has to keep
//                        and show.
//
// What we owe them in return is set out in the Wikimedia User-Agent policy:
// identify yourself, give a contact, and do not hammer it. `UA` names Roam and
// carries a URL; `paced()` keeps every caller to one request at a time with a
// gap; and nothing here runs on a household's request — the harvest is a back
// office job, so a slow Wikidata query never makes a screen wait.
//
// Two things this file deliberately does not do:
//
//   * It never downloads an image whose licence it could not read. `may_store`
//     comes back false and the caller drops it, because "we could not tell" and
//     "it is free" are different answers and only one of them is safe.
//   * It never asks Wikimedia for an arbitrary thumbnail width. Their renderer
//     serves a fixed set of buckets and 400px is not one of them (it answers
//     400 Bad Request); the API tells us the URL of the nearest bucket it will
//     serve, and that is the URL we fetch.

const SPARQL = 'https://query.wikidata.org/sparql';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const WIKIPEDIA = 'https://en.wikipedia.org/w/api.php';
const PAGEVIEWS = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user';

/**
 * Who we are. The Wikimedia policy asks for a real contact, and a bot that does
 * not give one gets blocked without warning — so this is not cosmetic.
 */
export const UA = 'RoamBot/1.0 (https://web-production-afce9.up.railway.app; roam atlas harvest; rogerrivers@gmail.com)';

const SPARQL_TIMEOUT = 60_000;   // WDQS's own ceiling is 60s; a county takes ~2s
const API_TIMEOUT = 20_000;
const GAP_MS = 120;              // ~8 requests a second, well inside anything they ask for

let queue = Promise.resolve();

/**
 * One request at a time, with a gap.
 *
 * Serial rather than a token bucket because the harvest is not in a hurry: a
 * county is a couple of hundred requests and the whole United Kingdom runs
 * overnight. Being unambiguously polite is worth more than being fast, since
 * the cost of getting this wrong is Wikimedia blocking the Railway IP.
 */
function paced(fn) {
  const run = queue.then(async () => {
    const out = await fn();
    await new Promise((r) => setTimeout(r, GAP_MS));
    return out;
  });
  queue = run.catch(() => {});
  return run;
}

/**
 * Which failures are worth trying again.
 *
 * A 404 means the article does not exist and asking a second time will not
 * change that. A 502 means one of Wikimedia's front ends had a bad moment, and
 * it very often will. Over a run that touches 107 regions across several hours
 * the difference is not academic: the first full harvest died on a single 502
 * from the query service four minutes in.
 */
const worthRetrying = (err) =>
  err.status === 429 || err.status === 408 || (err.status >= 500 && err.status <= 599) ||
  err.name === 'TimeoutError' || err.name === 'AbortError' || err.code === 'ETIMEDOUT' ||
  /fetch failed|network|socket|ECONNRESET|EAI_AGAIN/i.test(err.message ?? '');

const RETRIES = 4;

async function getJson(url, { timeout = API_TIMEOUT, accept = 'application/json' } = {}) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      return await paced(async () => {
        const res = await fetch(url, {
          headers: { 'user-agent': UA, accept },
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) {
          const why = (await res.text().catch(() => '')).slice(0, 200);
          throw Object.assign(new Error(`${new URL(url).hostname} ${res.status}: ${why}`), { status: res.status });
        }
        return res.json();
      });
    } catch (err) {
      last = err;
      if (attempt === RETRIES || !worthRetrying(err)) throw err;
      // Backing off rather than hammering: if the far end is struggling, the
      // polite thing and the effective thing are the same thing. 1s, 2s, 4s, 8s.
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// Wikidata
// ---------------------------------------------------------------------------

/**
 * Run a SPARQL query.
 *
 * `hint:Query hint:optimizer "None"` appears in every query below and is the
 * difference between two seconds and a timeout. WDQS's planner reorders a
 * `wdt:P131*` walk into something pathological; told to run the clauses in the
 * order they are written — county first, then the articles — it is fast.
 */
export async function sparql(query) {
  const url = `${SPARQL}?query=${encodeURIComponent(query)}&format=json`;
  const data = await getJson(url, { timeout: SPARQL_TIMEOUT, accept: 'application/sparql-results+json' });
  return (data?.results?.bindings ?? []).map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = v.value;
    return out;
  });
}

const qid = (uri) => (uri ? String(uri).split('/').pop() : null);

/**
 * The roots of "somewhere to go".
 *
 * Chosen for what a family would call a day out, not for taxonomic tidiness.
 * A restaurant is not here on purpose — the owner: "I don't care about
 * restaurant images… with restaurants it's more about reviews and the menus."
 */
/**
 * The catch-all roots: true of almost anything worth visiting, and therefore
 * never the interesting answer. A place is a "tourist attraction" when nothing
 * more specific fits, not instead of being a zoo.
 */
const GENERIC_LAST = new Set(['Q570116', 'Q4989906', 'Q22698']);

export const ATTRACTION_ROOTS = {
  Q570116: 'landmark',   // tourist attraction
  Q33506: 'museum',      // museum
  Q207694: 'arts',       // art museum
  // --- outdoors -----------------------------------------------------------
  // Everything a family calls "getting outside". Lakes, forests, hills and
  // country parks were all missing, which is why Virginia Water — one of the
  // best-known days out in the owner's own postcode — could never appear: it is
  // `instance of lake`, and lake descended from nothing we admitted.
  Q22698: 'outdoors',    // park
  Q350723: 'outdoors',   // country park
  Q1107656: 'outdoors',  // garden
  Q167346: 'outdoors',   // botanical garden
  Q272231: 'outdoors',   // arboretum
  Q473972: 'outdoors',   // protected area
  Q179049: 'outdoors',   // nature reserve
  Q40080: 'outdoors',    // beach
  Q23397: 'outdoors',    // lake
  Q131681: 'outdoors',   // reservoir
  Q4421: 'outdoors',     // forest
  Q54050: 'outdoors',    // hill
  Q2259176: 'outdoors',  // common land
  Q35509: 'outdoors',    // cave
  Q34038: 'outdoors',    // waterfall
  Q13405588: 'outdoors', // long-distance trail
  Q1757063: 'active',    // lido
  Q11875349: 'family',   // playground
  // --- heritage -----------------------------------------------------------
  Q23413: 'heritage',    // castle
  Q16560: 'heritage',    // palace
  Q2087181: 'heritage',  // historic house museum
  // A mansion is a building, not a walk. This root said 'outdoors' for a month
  // because the list was written from memory and Q1802963 was noted down as
  // "beach"; twenty-two kinds of English country house inherited it, and the
  // Outdoors shelf near Ascot filled with private estates and wedding venues.
  // Every root in this table has since been read back from Wikidata and checked
  // against its own label — three of thirty-five were wrong.
  Q1802963: 'heritage',  // mansion
  Q839954: 'heritage',   // archaeological site
  Q4989906: 'heritage',  // monument
  Q38720: 'heritage',    // windmill
  Q16970: 'heritage',    // church building (cathedrals and abbeys are under it)
  Q2977: 'heritage',     // cathedral
  Q44613: 'heritage',    // monastery
  Q4663971: 'heritage',  // abbey
  Q15135589: 'heritage', // pilgrimage site
  // --- landmarks, arts, days out ------------------------------------------
  Q39715: 'landmark',    // lighthouse
  Q12280: 'landmark',    // bridge
  Q15897166: 'landmark', // pier
  Q179700: 'arts',       // statue
  Q24354: 'arts',        // theatre building
  Q1060829: 'arts',      // concert hall
  Q43501: 'animals',     // zoo
  Q2281788: 'animals',   // public aquarium
  Q194195: 'family',     // amusement park
  Q420962: 'family',     // heritage railway
  Q1251750: 'family',    // distillery (and by subclass, breweries with a tour)
  Q1076486: 'active',    // sports venue
  Q1777138: 'active',    // race track
};

/**
 * Every Wikidata type that descends from one of those roots — about 5,300 of
 * them — with the root it came from, so each can be given a Roam category.
 *
 * Asked once and cached in `place_kinds`, because a subclass tree does not
 * change between Tuesdays and because doing this per county would put the
 * traversal inside every query and make each one take half a minute.
 */
export async function attractionKinds() {
  const roots = Object.keys(ATTRACTION_ROOTS).map((q) => `wd:${q}`).join(' ');
  const rows = await sparql(`
    SELECT ?type ?root WHERE {
      VALUES ?root { ${roots} }
      ?type wdt:P279* ?root .
    }`);
  // A type under two roots takes the one declared first in ATTRACTION_ROOTS.
  // This used to take whichever row the query service happened to return first,
  // which is not an order at all — so which category a type ended up in was
  // effectively arbitrary and changed between refreshes.
  //
  // Two rules, and the second is the one that mattered. `P279*` matches zero
  // steps as well as many, so every root is also returned as a subclass of
  // itself *and* of anything above it. Amusement park is a subclass of tourist
  // attraction, and tourist attraction sat first in the table — so amusement
  // park was filed as a landmark, and with it every zoo, aquarium and heritage
  // railway in the country. `family` and `animals` were empty in all 250 of
  // Surrey's attractions, and Thorpe Park was a landmark.
  //
  //   1. A root is always itself. Nothing above it can claim it.
  //   2. Otherwise the first root declared wins, and GENERIC_LAST puts the
  //      catch-all roots at the back where they belong: "tourist attraction"
  //      is what something is when nothing more specific fits.
  const order = Object.keys(ATTRACTION_ROOTS)
    .sort((a, b) => (GENERIC_LAST.has(a) ? 1 : 0) - (GENERIC_LAST.has(b) ? 1 : 0));
  const priority = new Map(order.map((q, i) => [q, i]));
  const byType = new Map();
  for (const r of rows) {
    const t = qid(r.type); const root = qid(r.root);
    const rank = priority.get(root);
    if (rank == null) continue;
    if (t in ATTRACTION_ROOTS && t !== root) continue;      // rule 1
    const held = byType.get(t);
    if (held && priority.get(held.rootQid) <= rank) continue;
    byType.set(t, { qid: t, rootQid: root, category: ATTRACTION_ROOTS[root] });
  }
  return [...byType.values()];
}

/**
 * What each of those types is called, in English.
 *
 * `place_kinds` is filled from a subclass walk that returns identifiers and
 * nothing else, so the classifier reads as a column of Q-numbers — which is
 * fine for a pipeline and useless for a person. Nobody can decide whether
 * "Q1154710" belongs on the Adrenaline shelf; everybody can decide whether an
 * association football venue does. Asked in batches, because a VALUES clause
 * of five thousand is a query nothing answers.
 */
export async function kindLabels(qids, { batch = 300 } = {}) {
  const out = new Map();
  for (let i = 0; i < qids.length; i += batch) {
    const slice = qids.slice(i, i + batch);
    const rows = await sparql(`
      SELECT ?type ?typeLabel WHERE {
        VALUES ?type { ${slice.map((q) => `wd:${q}`).join(' ')} }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
      }`);
    for (const r of rows) {
      const q = qid(r.type);
      // The label service answers with the Q-number itself when there is no
      // English label; that is not a name and is worse than none.
      if (q && r.typeLabel && r.typeLabel !== q) out.set(q, r.typeLabel);
    }
  }
  return out;
}

/**
 * Everything notable inside an administrative area that has an English
 * Wikipedia article.
 *
 * Deliberately broad, and filtered afterwards against `place_kinds`. Asking
 * Wikidata to do the filtering means a subclass traversal inside the walk,
 * which took 24 seconds and returned 15 rows for Berkshire where this returns
 * 400 in two — and missed Legoland, because the query planner and the truth
 * disagree about what an amusement park is.
 *
 * `sitelinks > 1` is the floor: an item with one sitelink is an article on one
 * wiki and nothing else, and there are hundreds of thousands of them.
 *
 * The row limit is high because a row is not an item: an item comes back once
 * per heritage designation it holds, so a county of listed buildings uses
 * several rows each. At 600 Kent truncated to 516 items and lost Canterbury
 * Cathedral before anything had a chance to rank it.
 */
export async function areaCandidates(regionQid, { limit = 3000, minSitelinks = 1 } = {}) {
  const rows = await sparql(`
    SELECT ?item ?itemLabel ?desc ?sitelinks ?img ?article ?lat ?lng ?osm ?commonsCat ?site ?heritageLabel
           (MAX(?visitorsRaw) AS ?visitors) (SAMPLE(?operator) AS ?operatorAny)
           (GROUP_CONCAT(DISTINCT STRAFTER(STR(?type), "entity/"); separator=",") AS ?types) WHERE {
      hint:Query hint:optimizer "None" .
      ?item wdt:P131* wd:${regionQid} ; wikibase:sitelinks ?sitelinks .
      FILTER(?sitelinks > ${minSitelinks})
      ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
      ?item wdt:P31 ?type .
      OPTIONAL { ?item wdt:P18 ?img }
      OPTIONAL { ?item wdt:P402 ?osm }
      OPTIONAL { ?item wdt:P373 ?commonsCat }
      OPTIONAL { ?item wdt:P856 ?site }
      # Two properties that say a place is open to the public rather than merely
      # notable. Visitors per year is the strongest signal there is — nobody
      # publishes a visitor count for a house you cannot go into — and an
      # operator is the National Trust, a council or a company running it as
      # somewhere people go. Without these the ranking puts John Lennon's former
      # house above Legoland, which is how it behaved before they were added.
      OPTIONAL { ?item wdt:P1174 ?visitorsRaw }
      OPTIONAL { ?item wdt:P137 ?operator }
      OPTIONAL { ?item wdt:P1435 ?heritage . ?heritage rdfs:label ?heritageLabel FILTER(lang(?heritageLabel) = "en") }
      OPTIONAL { ?item p:P625/psv:P625 ?co . ?co wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lng . }
      OPTIONAL { ?item schema:description ?desc FILTER(lang(?desc) = "en") }
      ?item rdfs:label ?itemLabel . FILTER(lang(?itemLabel) = "en")
    }
    GROUP BY ?item ?itemLabel ?desc ?sitelinks ?img ?article ?lat ?lng ?osm ?commonsCat ?site ?heritageLabel
    ORDER BY DESC(?sitelinks) LIMIT ${limit}`);

  const byItem = new Map();
  for (const r of rows) {
    const id = qid(r.item);
    const existing = byItem.get(id);
    // The same item comes back once per heritage designation; keep the first
    // and merge the type lists rather than letting a Grade I listed building
    // outrank itself twice.
    if (existing) {
      existing.kinds = [...new Set([...existing.kinds, ...String(r.types || '').split(',').filter(Boolean)])];
      if (!existing.heritage && r.heritageLabel) existing.heritage = r.heritageLabel;
      continue;
    }
    byItem.set(id, {
      wikidataId: id,
      name: r.itemLabel,
      description: r.desc ?? null,
      sitelinks: Number(r.sitelinks) || 0,
      imageFile: r.img ? decodeURIComponent(String(r.img).split('/').pop()).replace(/_/g, ' ') : null,
      wikipediaUrl: r.article ?? null,
      wikipediaTitle: r.article ? decodeURIComponent(String(r.article).split('/wiki/').pop()).replace(/_/g, ' ') : null,
      lat: r.lat != null ? Number(r.lat) : null,
      lng: r.lng != null ? Number(r.lng) : null,
      osmRef: r.osm ?? null,
      commonsCategory: r.commonsCat ?? null,
      website: r.site ?? null,
      heritage: r.heritageLabel ?? null,
      visitorsPerYear: r.visitors != null ? Number(r.visitors) || null : null,
      hasOperator: Boolean(r.operatorAny),
      kinds: String(r.types || '').split(',').filter(Boolean),
    });
  }
  return [...byItem.values()];
}

// ---------------------------------------------------------------------------
// Wikipedia: the interest signal, and the description
// ---------------------------------------------------------------------------

const monthsAgo = (n) => {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n);
  return d;
};
const stamp = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

/**
 * How many people read this article in the last twelve months, human traffic
 * only (`user`, which excludes crawlers and Wikipedia's own bots).
 *
 * Returns null rather than 0 when the API has no data: an article created last
 * month has no year of views, and scoring it as "nobody looked" would bury
 * every new attraction for a year.
 */
export async function pageviewsYear(title) {
  const path = encodeURIComponent(String(title).replace(/ /g, '_'));
  const url = `${PAGEVIEWS}/${path}/monthly/${stamp(monthsAgo(12))}/${stamp(monthsAgo(1))}`;
  try {
    const data = await getJson(url);
    const items = data?.items ?? [];
    if (!items.length) return null;
    return items.reduce((n, i) => n + (i.views || 0), 0);
  } catch (err) {
    if (err.status === 404) return null;   // no data for this title, which is not an error
    throw err;
  }
}

/** The opening paragraphs, CC BY-SA, to be shown with a credit and a link. */
export async function articleExtract(title) {
  const p = new URLSearchParams({
    action: 'query', prop: 'extracts', titles: title, exintro: '1', explaintext: '1',
    exsentences: '4', format: 'json', redirects: '1', origin: '*',
  });
  const data = await getJson(`${WIKIPEDIA}?${p}`);
  const page = Object.values(data?.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined) return null;
  return (page.extract || '').trim() || null;
}

// ---------------------------------------------------------------------------
// Wikipedia: the whole article, in the sections its editors chose
// ---------------------------------------------------------------------------

// The sections of an article that are apparatus rather than reading. Nobody
// opening a drawer about Leeds Castle wants "External links", and a References
// section in plain text is four hundred lines of bare surnames.
const APPARATUS = /^(see also|references?|notes?|citations?|sources|footnotes?|further reading|bibliography|external links?|gallery|galleries|images?|photographs?|see more|literature|in popular culture|notable people|twin towns.*)$/i;

// Where the answer to "what is there to do" actually lives. A section called
// History tells you what the place is; one called Tourism, Attractions, Rides
// or Gardens tells you what you would spend the afternoon on. Both are kept —
// this only decides which get marked, so a drawer can lead with the useful one
// rather than opening on the twelfth century.
const DOING = /\b(tourism|visit|attraction|rides?|exhibit|collection|garden|grounds|trail|activit|facilit|what to see|things to do|events?|opening|admission|access|park(land)?|walks?|tour)\b/i;

const MAX_SECTION = 1200;
const MAX_SECTIONS_TEXT = 9000;

/**
 * The article as a list of sections, plain text, ready to be read in a drawer.
 *
 * `exintro` gives four sentences that say what a place *is*; this is the rest,
 * which is where anybody who has decided to go finds out what they will do when
 * they get there. One request, the same one, without the intro flag.
 *
 * Trimmed on the way out rather than on the way in, because the API has no
 * length control that respects section boundaries: a whole article arrives,
 * the apparatus is dropped, each section is cut to a paragraph or two and the
 * set is capped. A drawer is a read, not a reprint — and the credit and the
 * link to the full article travel with it either way.
 */
export async function articleSections(title) {
  const p = new URLSearchParams({
    action: 'query', prop: 'extracts', titles: title, explaintext: '1',
    format: 'json', redirects: '1', origin: '*',
  });
  const data = await getJson(`${WIKIPEDIA}?${p}`);
  const page = Object.values(data?.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined) return [];
  const whole = String(page.extract || '').trim();
  if (!whole) return [];

  // Headings come back as "\n== History ==\n" and "\n=== Medieval ===\n"; the
  // number of equals signs is the depth.
  const parts = whole.split(/\n(={2,6})\s*([^=\n]+?)\s*\1\n/);
  const out = [];
  let budget = MAX_SECTIONS_TEXT;

  const push = (heading, level, body) => {
    const text = String(body || '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text || budget <= 0) return;
    if (heading && APPARATUS.test(heading)) return;
    const cut = text.length > MAX_SECTION ? `${text.slice(0, MAX_SECTION).replace(/\s+\S*$/, '')}…` : text;
    const kept = cut.slice(0, budget);
    budget -= kept.length;
    out.push({ heading: heading ?? null, level, text: kept, doing: Boolean(heading && DOING.test(heading)) });
  };

  push(null, 1, parts[0]);
  for (let i = 1; i < parts.length; i += 3) push(parts[i + 1], parts[i].length, parts[i + 2]);
  return out;
}

// ---------------------------------------------------------------------------
// Wikidata: the designations, which are the attraction's accolades
// ---------------------------------------------------------------------------

/**
 * What has been said about this place by somebody whose job it is to say it.
 *
 * The restaurant side of Roam already draws this distinction (sources/
 * accolades.js): a rating is a licensed figure we may not keep, but that
 * somewhere is a World Heritage Site, a Grade I listed building or the holder
 * of a Green Flag is a fact about who said what, published in order to be
 * quoted, and ours for good.
 *
 * Two Wikidata properties carry it — P1435 heritage designation and P166 award
 * received — and both are CC0. Asked as a second, small query over the QIDs
 * that were actually published rather than folded into `areaCandidates`, which
 * already walks `wdt:P131*` across a county and does not need two more label
 * joins hung off it. Eighteen ids at a time is instant; the same clauses inside
 * the big query are how London times out.
 */
export async function designations(qids) {
  const ids = [...new Set((qids || []).filter((q) => /^Q\d+$/.test(q)))];
  const out = new Map();
  if (!ids.length) return out;

  for (let i = 0; i < ids.length; i += 120) {
    const batch = ids.slice(i, i + 120);
    const rows = await sparql(`
      SELECT ?item ?what ?whatLabel ?prop WHERE {
        hint:Query hint:optimizer "None" .
        VALUES ?item { ${batch.map((q) => `wd:${q}`).join(' ')} }
        # The label join sits inside each branch rather than after the union.
        # Outside it, ?what is unbound when the planner reaches it and the query
        # walks every label in Wikidata: the same two ids that answer in 0.2s
        # this way do not answer at all in sixty the other.
        { ?item wdt:P1435 ?what . ?what rdfs:label ?whatLabel .
          FILTER(lang(?whatLabel) = "en") BIND("designation" AS ?prop) }
        UNION
        { ?item wdt:P166 ?what . ?what rdfs:label ?whatLabel .
          FILTER(lang(?whatLabel) = "en") BIND("award" AS ?prop) }
      }`);
    for (const r of rows) {
      const id = qid(r.item);
      if (!out.has(id)) out.set(id, []);
      const list = out.get(id);
      const label = String(r.whatLabel || '').trim();
      if (label && !list.some((d) => d.label === label)) {
        list.push({ label, kind: r.prop, qid: qid(r.what) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wikivoyage: what it costs, when it opens, and why you would bother
// ---------------------------------------------------------------------------

const WIKIVOYAGE = 'https://en.wikivoyage.org/w/api.php';

/**
 * Pull one `{{see}}` / `{{do}}` / `{{listing}}` template out of wikitext,
 * brace-counting rather than regex-matching, because listings contain nested
 * templates ({{flag}}, {{USD}}) often enough that a lazy `\}\}` truncates them
 * mid-price.
 */
function templatesIn(wikitext, names) {
  const out = [];
  const open = new RegExp(`\\{\\{\\s*(${names.join('|')})\\s*[|\\n]`, 'gi');
  for (const m of String(wikitext).matchAll(open)) {
    let depth = 1;
    let i = m.index + 2;
    while (i < wikitext.length && depth > 0) {
      if (wikitext.startsWith('{{', i)) { depth += 1; i += 2; }
      else if (wikitext.startsWith('}}', i)) { depth -= 1; i += 2; }
      else i += 1;
    }
    if (depth === 0) out.push({ kind: m[1].toLowerCase(), body: wikitext.slice(m.index + 2, i - 2) });
  }
  return out;
}

/** `| name=Leeds Castle | price=£12.50` → { name: 'Leeds Castle', price: '£12.50' }. */
function fieldsOf(body) {
  const fields = {};
  let depth = 0;
  let current = '';
  const parts = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body.startsWith('{{', i) || body.startsWith('[[', i)) { depth += 1; current += body.slice(i, i + 2); i += 1; continue; }
    if (body.startsWith('}}', i) || body.startsWith(']]', i)) { depth -= 1; current += body.slice(i, i + 2); i += 1; continue; }
    if (body[i] === '|' && depth <= 0) { parts.push(current); current = ''; continue; }
    current += body[i];
  }
  parts.push(current);
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1)
      .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')   // [[Kent|the county]] → the county
      .replace(/\[\[([^\]]*)\]\]/g, '$1')
      .replace(/'''?/g, '')
      .replace(/<ref[^>]*>[\s\S]*?<\/ref>|<ref[^>]*\/>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (value) fields[key] = value;
  }
  return fields;
}

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * What a travel guide says about this place.
 *
 * Wikivoyage is the same licence as Wikipedia — CC BY-SA — and a completely
 * different thing to read. Its entries are written by people who went, for
 * people deciding whether to, so they carry the four facts an encyclopedia
 * never does: what it costs, when it opens, how to reach it, and one sentence
 * on whether it is worth the afternoon.
 *
 * Matched on the `wikidata=` field the listings carry, which is exact, before
 * falling back to the name — because "All Saints Church" is a hundred places
 * and a QID is one.
 *
 * `lastedit` comes back with the price on purpose. A Wikivoyage admission
 * figure can be a decade old (Leeds Castle is still listed at £12.50 there),
 * and a price with no date on it is worse than no price: the date is what lets
 * a screen say "read in 2017" instead of quietly lying.
 */
export async function voyageListings({ wikidataId, name, near = null } = {}) {
  const query = near ? `"${name}" ${near}` : `"${name}"`;
  let hits;
  try {
    const p = new URLSearchParams({
      action: 'query', list: 'search', srsearch: query, srlimit: '3',
      srnamespace: '0', format: 'json', origin: '*',
    });
    hits = (await getJson(`${WIKIVOYAGE}?${p}`))?.query?.search ?? [];
  } catch { return { listing: null, listings: [] }; }
  if (!hits.length) return { listing: null, listings: [] };

  const wanted = norm(name);
  let matched = null;
  const listings = [];

  for (const hit of hits.slice(0, 2)) {
    let wikitext;
    try {
      const p = new URLSearchParams({
        action: 'parse', page: hit.title, prop: 'wikitext',
        format: 'json', redirects: '1', origin: '*',
      });
      wikitext = (await getJson(`${WIKIVOYAGE}?${p}`))?.parse?.wikitext?.['*'];
    } catch { continue; }
    if (!wikitext) continue;

    // The page is the attraction itself — a destination in its own right, like
    // a national park — so everything it lists is something to do *here*.
    const pageIsThePlace = norm(hit.title) === wanted;

    for (const t of templatesIn(wikitext, ['see', 'do', 'listing', 'marker'])) {
      const f = fieldsOf(t.body);
      if (!f.name) continue;
      const entry = {
        name: f.name,
        kind: t.kind === 'do' ? 'do' : 'see',
        note: f.content ?? null,
        price: f.price ?? null,
        hours: f.hours ?? null,
        url: f.url ?? null,
        phone: f.phone ?? null,
        address: f.address ?? null,
        wikidataId: /^Q\d+$/.test(f.wikidata ?? '') ? f.wikidata : null,
        wikipediaTitle: f.wikipedia ?? null,
        lastedit: f.lastedit ?? null,
        page: hit.title,
        pageUrl: `https://en.wikivoyage.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
      };
      const isThisOne = (wikidataId && entry.wikidataId === wikidataId) || norm(entry.name) === wanted;
      if (isThisOne && !matched) matched = entry;
      else if (pageIsThePlace) listings.push(entry);
    }
    if (matched && !pageIsThePlace) break;
  }
  return { listing: matched, listings: listings.slice(0, 40) };
}

// Wikipedia articles carry the site's own furniture as well as photographs:
// maps, flags, edit pencils, the Commons logo, featured-article stars. None of
// them is a picture of the place.
const CHROME = /^File:(Commons-logo|Cscr-featured|OOjs|Red pog|Blue pog|Green pog|Pending-protection|Wikisource|Wikiquote|Wiktionary|Question book|Ambox|Edit-|Symbol |Semi-protection|Loudspeaker|Sound-icon|Folder|Nuvola|Crystal |Gnome-|Increase2?|Decrease2?|Steady2?|Flag of|Coat of arms|Arms of|Location map|.* location map|.*locator map|.*UK location map)/i;
const NOT_A_PHOTO = /\.(svg|png|gif|tif|tiff|webp|ogv|ogg|pdf|djvu|xcf)$/i;

/**
 * The pictures an article actually uses, in the order the editors put them.
 *
 * A better source of a gallery than the Commons category, which is a filing
 * system rather than a selection: Category:Windsor Castle contains a photograph
 * of a Kia Sorento. What is *in the article* has been through an editor.
 */
export async function articleImages(title, { limit = 24 } = {}) {
  const p = new URLSearchParams({
    action: 'query', prop: 'images', titles: title, imlimit: String(limit * 2),
    format: 'json', redirects: '1', origin: '*',
  });
  const data = await getJson(`${WIKIPEDIA}?${p}`);
  const page = Object.values(data?.query?.pages ?? {})[0];
  return (page?.images ?? [])
    .map((i) => i.title)
    .filter((t) => !CHROME.test(t) && !NOT_A_PHOTO.test(t))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Commons: the pictures, and the terms they come under
// ---------------------------------------------------------------------------

const stripTags = (html) => (html ? String(html).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || null : null);
const firstHref = (html) => {
  const m = html && String(html).match(/href="([^"]+)"/);
  if (!m) return null;
  return m[1].startsWith('//') ? `https:${m[1]}` : m[1];
};

/**
 * Licences that permit keeping the bytes and republishing them.
 *
 * An allow-list, not a deny-list. Commons carries plenty that looks free and is
 * not — fair-use logos, "non-commercial only", images with a `Restrictions`
 * note about trademark or personality rights — and the failure mode of a
 * deny-list is that the one we did not think of gets stored.
 */
const STORABLE = [
  /^cc[ -]?by([ -]sa)?([ -][0-9.]+)?$/i,
  /^cc[ -]?0/i, /^cc0/i,
  /^public domain/i, /^pd[- ]/i, /^no restrictions$/i,
  /^attribution$/i,
  /^ogl/i,                                   // UK Open Government Licence
  /^gfdl/i,                                  // usually dual-licensed with CC BY-SA
];
const NEVER = /non[- ]commercial|nc\b|no derivative|nd\b|fair use|copyright|all rights reserved/i;

function readLicence(meta = {}) {
  const short = stripTags(meta.LicenseShortName?.value) || stripTags(meta.UsageTerms?.value) || null;
  const restrictions = stripTags(meta.Restrictions?.value) || null;
  const terms = stripTags(meta.UsageTerms?.value) || null;
  const permitted =
    Boolean(short) &&
    STORABLE.some((re) => re.test(short.trim())) &&
    !NEVER.test(short) &&
    !NEVER.test(terms || '') &&
    // Commons' own warning field. "trademarked" or "personality" means the
    // licence covers the copyright and something else does not; we do not take
    // those, because the whole promise of this library is that everything in it
    // is safe to put on a card.
    !restrictions;
  return {
    licence: short || 'unknown',
    licenceUrl: meta.LicenseUrl?.value ?? null,
    usageTerms: terms,
    restrictions,
    // CC0 and public domain ask for nothing; everything else asks to be
    // credited, and Commons says which in a field of its own.
    attributionRequired: /^(cc[ -]?0|cc0|public domain|pd[- ])/i.test(short || '')
      ? false
      : String(meta.AttributionRequired?.value ?? 'true') !== 'false',
    mayStore: permitted,
  };
}

/**
 * Everything about a set of Commons files — the licence, the creator, the page
 * that states both, and a URL for a thumbnail at roughly the width asked for.
 *
 * Batched fifty at a time because that is the API's limit for `titles`, and one
 * request per width because `iiurlwidth` takes a single value.
 */
export async function fileDetails(titles, { widths = [20, 500, 960] } = {}) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    for (const [n, width] of widths.entries()) {
      const p = new URLSearchParams({
        action: 'query', prop: 'imageinfo', titles: batch.join('|'),
        // The metadata only has to come back once; the other passes are only
        // after a thumbnail URL.
        iiprop: n === 0 ? 'url|size|mime|extmetadata' : 'url|size',
        iiurlwidth: String(width), iiextmetadatafilter:
          'LicenseShortName|LicenseUrl|UsageTerms|AttributionRequired|Restrictions|Artist|Credit|ImageDescription|ObjectName|DateTimeOriginal',
        format: 'json', redirects: '1', origin: '*',
      });
      const data = await getJson(`${COMMONS}?${p}`);
      // `normalized`/`redirects` mean the title we asked for is not always the
      // title that comes back; keep both so the caller can match either.
      const alias = new Map();
      for (const r of [...(data?.query?.normalized ?? []), ...(data?.query?.redirects ?? [])]) alias.set(r.to, r.from);

      for (const page of Object.values(data?.query?.pages ?? {})) {
        const info = page.imageinfo?.[0];
        if (!info) continue;
        const key = page.title;
        let row = out.get(key);
        if (!row) {
          const meta = info.extmetadata ?? {};
          const artistHtml = meta.Artist?.value ?? null;
          const licence = readLicence(meta);
          row = {
            title: key,
            askedAs: alias.get(key) ?? key,
            descriptionUrl: (info.descriptionurl || '').split('?')[0] || null,
            originalUrl: (info.url || '').split('?')[0] || null,
            width: info.width ?? null,
            height: info.height ?? null,
            mime: info.mime ?? null,
            creator: stripTags(artistHtml),
            creatorUrl: firstHref(artistHtml),
            caption: stripTags(meta.ImageDescription?.value)?.slice(0, 600) ?? null,
            objectName: stripTags(meta.ObjectName?.value) ?? null,
            ...licence,
            thumbs: {},
          };
          out.set(key, row);
        }
        if (info.thumburl) {
          row.thumbs[width] = {
            url: info.thumburl.split('?')[0],
            width: info.thumbwidth ?? null,
            height: info.thumbheight ?? null,
          };
        }
      }
    }
  }
  return out;
}

/**
 * Fetch the bytes of one thumbnail.
 *
 * Returns null rather than throwing when the picture is simply not there: one
 * missing file is a picture we do not have, not a reason to stop harvesting a
 * county. A server that is struggling is retried; a 404 is not.
 */
export async function fetchImage(url) {
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    try {
      return await paced(async () => {
        const res = await fetch(url, {
          headers: { 'user-agent': UA, referer: 'https://commons.wikimedia.org/' },
          signal: AbortSignal.timeout(API_TIMEOUT),
        });
        if (!res.ok) {
          if (res.status >= 500 || res.status === 429) {
            throw Object.assign(new Error(`upload ${res.status}`), { status: res.status });
          }
          return null;
        }
        const type = res.headers.get('content-type') || '';
        // A Wikimedia error page comes back as HTML with a 200 in some caches;
        // storing that as a JPEG is how a library fills up with 2KB of markup.
        if (!type.startsWith('image/')) return null;
        return { mime: type.split(';')[0], body: Buffer.from(await res.arrayBuffer()) };
      });
    } catch (err) {
      if (attempt === 2 || !worthRetrying(err)) return null;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  return null;
}
