/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ENDPOINT SEARCH: how a person's words find an API operation
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `vremly_search_endpoints` is the first call an assistant makes, and it makes
 * it with the PERSON'S words: "book a shoot for 123 Main St", "where's my
 * photographer", "pay the invoice". The API uses other words
 * (`/agent-actions/booking/preview`, "technician", "checkout session"), and
 * scoring only those sent plain speech to the wrong routes. Measured on the
 * production connector, 2026-10-12:
 *
 *   "book a shoot for an address"        → availability diagnostics, payroll
 *   "track my photographer trip status"  → a Stripe order status, training
 *   "project tracking live trip"         → delivery templates
 *
 * Two causes, both fixed here.
 *
 * 1. SUBSTRING MATCHING. "a" and "an" are inside nearly every operation,
 *    "live" is inside "delivery" and "trip" is inside "stripe". Words now
 *    match whole words after a light stem (booking → book, cancelled →
 *    cancel), filler words are dropped, and a word counts for less the more
 *    operations contain it, so "project" cannot outvote "tracking".
 *
 * 2. NOTHING SAID HOW PEOPLE ASK. One mechanism carries that: the
 *    `x-agent-intents` OpenAPI extension. It is a list of phrases a realtor or
 *    a media-company owner actually uses for an operation. `@AgentIntents()`
 *    writes it on the route and the compiled emit publishes it. A whole phrase
 *    found in the query outranks any generic word match, so the core loop
 *    (book, reschedule, cancel, assign, track, deliver, revise, share card,
 *    invoice, pay) is found from plain speech. Fuzzy matching (one or two
 *    typos) applies only to those curated phrases. Across ~600 operations,
 *    fuzzy generic words are all noise.
 *
 * Every other operation keeps generic word scoring: path, summary,
 * operationId and tags. Query words that nothing in the document knows (an
 * address, a name, a date) are ignored rather than counted as misses.
 *
 * ── THIS FILE EXISTS TWICE, ON PURPOSE ────────────────────────────────────
 *
 * apps/backend/src/mcp/endpoint-search.ts is the original; the hosted
 * connector uses it. apps/mcp-server/src/endpoint-search.ts is a copy that
 * apps/mcp-server/scripts/sync-spec.js writes when it copies the OpenAPI
 * document, because the stdio package is published on its own and cannot
 * import the backend.
 * Edit the backend file, then run sync-spec. mcp-tools.service.spec.ts fails
 * if the two differ by a single byte. The file has no imports, so the copy
 * compiles in either package.
 */

/** The OpenAPI extension that carries an operation's natural phrasings. */
export const AGENT_INTENTS_EXTENSION = 'x-agent-intents';

export interface SearchableOperation {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  tags?: string[];
  /** The operation's `x-agent-intents`. */
  intents?: string[];
}

export interface RankedOperation<T> {
  op: T;
  score: number;
  /** The whole phrase that matched, if one did: why the operation ranked. */
  intent: string | null;
}

/**
 * Words that say nothing about WHICH operation is wanted. Question words that
 * do ("where", "when", "who") are deliberately absent: "where is my
 * photographer" is a tracking question because of "where".
 */
const STOPWORDS = new Set(
  (
    'a an the and or but of for to in on at by with from into onto about as ' +
    'up out off is are was were be been being am do does did have has had ' +
    'i im ive id me my we our us you your he she his her they them their ' +
    'it its this that these those there here please pls plz can could ' +
    'would will should shall may might must wanna like hey hi so some any ' +
    'all what whats how which why if then than too very really now right ' +
    'also go going gonna let lets help ok okay thanks via per one someone ' +
    'something got'
  ).split(' '),
);

/** Lowercase words, with camelCase split ("prepareBooking" → prepare booking). */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Suffix, replacement, and the shortest stem that may remain. */
const SUFFIXES: ReadonlyArray<readonly [string, string, number]> = [
  ['ations', '', 4],
  ['ation', '', 4],
  ['ings', '', 4],
  ['ing', '', 4],
  ['ies', 'y', 3],
  ['ied', 'y', 3],
  ['es', '', 4],
  ['ed', '', 4],
  ['s', '', 3],
];

/**
 * Words of this domain that only look like inflections. A listing is not a
 * list, "just listed" is not the verb, and staging is not a stage; stemming
 * them would let "list projects" rank every /listings route first.
 */
const UNSTEMMED = new Set(
  (
    'listing listed setting staging building morning evening thing ' +
    'pricing parking flooring ceiling landing'
  ).split(' '),
);

/**
 * A light stem, applied to both sides of every comparison, so it only has to
 * be consistent, not linguistically right: booking/booked/bookings → book,
 * cancelled/canceled/cancellation → cancel, invoice/invoices → invoic.
 */
export function stem(word: string): string {
  let w =
    word.endsWith('ings') && UNSTEMMED.has(word.slice(0, -1))
      ? word.slice(0, -1)
      : word;
  if (UNSTEMMED.has(w)) return w;
  for (const [suffix, replacement, min] of SUFFIXES) {
    if (!w.endsWith(suffix)) continue;
    // "status", "address", "analysis" are not plurals.
    if (suffix === 's' && /(ss|us|is)$/.test(w)) break;
    const base = w.slice(0, w.length - suffix.length) + replacement;
    if (base.length >= min) {
      w = base;
      break;
    }
  }
  // cancell → cancel, shipp → ship; a doubled vowel ("fee", "book") stays.
  if (
    w.length >= 4 &&
    w[w.length - 1] === w[w.length - 2] &&
    !/[aeiou]/.test(w[w.length - 1])
  ) {
    w = w.slice(0, -1);
  }
  if (w.length >= 5 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** The meaningful stems of a text, in order, without repeats. */
export function searchTerms(text: string): string[] {
  const out: string[] = [];
  for (const word of words(text)) {
    if (STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    const s = stem(word);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * The same word, or one of them extends the other by a few letters
 * (deliver / delivery, custom / customer). The shorter must be five letters or
 * more: "live" must never match "delivery", nor "trip" match "stripe".
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return (
    short.length >= 5 &&
    long.length - short.length <= 3 &&
    long.startsWith(short)
  );
}

/** Optimal-string-alignment distance, stopping early once it exceeds `max`. */
function withinEdits(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const prev2: number[] = new Array(b.length + 1).fill(0);
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      row.push(d);
      if (d < best) best = d;
    }
    if (best > max) return false;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    prev = row;
  }
  return prev[b.length] <= max;
}

/** An intent word also accepts a typo: one edit from five letters, two from eight. */
function sameIntentWord(query: string, intent: string): boolean {
  if (sameWord(query, intent)) return true;
  const shortest = Math.min(query.length, intent.length);
  if (shortest < 5) return false;
  return withinEdits(query, intent, shortest >= 8 ? 2 : 1);
}

interface IndexedOperation<T> {
  op: T;
  words: string[];
  pathWords: string[];
  intents: { phrase: string; terms: string[] }[];
  /** Path segment count, then length: the more general route first on a tie. */
  depth: number;
}

export interface SearchIndex<T> {
  operations: IndexedOperation<T>[];
}

/** Tokenise every operation once; the document does not change at runtime. */
export function buildSearchIndex<T extends SearchableOperation>(
  operations: readonly T[],
): SearchIndex<T> {
  return {
    operations: operations.map((op) => {
      const pathWords = searchTerms(op.path.replace(/\{[^}]*\}/g, ' '));
      const all = new Set([
        ...pathWords,
        ...searchTerms(op.summary ?? ''),
        ...searchTerms(op.operationId ?? ''),
        ...searchTerms((op.tags ?? []).join(' ')),
      ]);
      return {
        op,
        words: [...all],
        pathWords,
        intents: (op.intents ?? [])
          .filter((phrase) => typeof phrase === 'string')
          .map((phrase) => ({ phrase, terms: searchTerms(phrase) }))
          .filter((intent) => intent.terms.length > 0),
        depth:
          op.path.split('/').filter(Boolean).length * 1000 + op.path.length,
      };
    }),
  };
}

/**
 * A whole phrase found in the query. Scaled by how much of the query the
 * phrase explains, so "cancellation requests" cannot claim "cancel a time-off
 * request" just by sharing two of its three words.
 */
const FULL_INTENT = 100;
/** Each word of a fully matched phrase: the more specific phrase wins. */
const INTENT_WORD = 10;
/**
 * Part of a phrase: two of its words or more, or the one word of a one-word
 * query. One shared word in a longer query ("list", "photo") is not evidence;
 * it would let every phrase containing it add noise.
 */
const PARTIAL_INTENT = 6;
/**
 * The operation's own words contain every word of the query. Strong, but below
 * a phrase that explains the whole query; it is what lets "webhook deliveries"
 * find the deliveries log rather than the phrase "webhook".
 */
const FULL_COVERAGE = 100;
/** A query word found in the path counts for more than one in prose. */
const PATH_WEIGHT = 1.5;

/**
 * Rank operations for a query, best first. Ties go to the shorter, more
 * general path, then to path and method order, so the result is stable.
 */
export function rankOperations<T extends SearchableOperation>(
  index: SearchIndex<T>,
  query: string,
): RankedOperation<T>[] {
  // A word nothing in the document knows ("Birch", "Smith", "tomorrow") is an
  // address, a name or a date. It cannot pick an operation, so it must not
  // dilute how much of the query a phrase explains either.
  const terms = searchTerms(query).filter((term) =>
    index.operations.some(
      (o) =>
        o.words.some((w) => sameWord(term, w)) ||
        o.intents.some((i) => i.terms.some((w) => sameIntentWord(term, w))),
    ),
  );
  if (terms.length === 0) return [];

  const total = index.operations.length;
  const rarity = terms.map((term) => {
    const holders = index.operations.filter((o) =>
      o.words.some((w) => sameWord(term, w)),
    ).length;
    return Math.log(1 + total / (1 + holders));
  });

  const ranked: (RankedOperation<T> & {
    depth: number;
    path: string;
    method: string;
  })[] = [];
  for (const indexed of index.operations) {
    let generic = 0;
    let covered = 0;
    terms.forEach((term, i) => {
      if (!indexed.words.some((w) => sameWord(term, w))) return;
      covered += 1;
      const inPath = indexed.pathWords.some((w) => sameWord(term, w));
      generic += rarity[i] * (inPath ? PATH_WEIGHT : 1);
    });
    if (terms.length >= 2 && covered === terms.length) generic += FULL_COVERAGE;

    let intentScore = 0;
    let intent: string | null = null;
    let full = false;
    for (const candidate of indexed.intents) {
      const matched = candidate.terms.filter((w) =>
        terms.some((term) => sameIntentWord(term, w)),
      ).length;
      let score = 0;
      if (matched === candidate.terms.length) {
        const explained = terms.filter((term) =>
          candidate.terms.some((w) => sameIntentWord(term, w)),
        ).length;
        score =
          ((FULL_INTENT + INTENT_WORD * matched) * explained) / terms.length;
      } else if (matched >= Math.min(2, terms.length)) {
        score = (PARTIAL_INTENT * matched) / candidate.terms.length;
      }
      if (score > intentScore) {
        intentScore = score;
        intent = candidate.phrase;
        full = matched === candidate.terms.length;
      }
    }

    const score = intentScore + generic;
    if (score <= 0) continue;
    ranked.push({
      op: indexed.op,
      score: Math.round(score * 100) / 100,
      intent: full ? intent : null,
      depth: indexed.depth,
      path: indexed.op.path,
      method: indexed.op.method.toUpperCase(),
    });
  }

  return ranked
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.depth - b.depth ||
        a.path.localeCompare(b.path) ||
        a.method.localeCompare(b.method),
    )
    .map(({ op, score, intent }) => ({ op, score, intent }));
}
