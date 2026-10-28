interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * budget-resolutions: adopted congressional budget-resolution targets
 * (concurrent resolutions on the budget, H.Con.Res. / S.Con.Res.) beside U.S.
 * Treasury actuals.
 *
 * Source: U.S. Congress, concurrent resolutions on the budget, text as
 * published by the U.S. Government Publishing Office (Congressional Bills);
 * actuals from the U.S. Treasury Monthly Treasury Statement. Bill text begins
 * with the 103rd Congress (1993), so fiscal years before 1994 are out of
 * coverage and say so.
 *
 * Tools:
 * - budget_resolution_find: which resolutions exist for a fiscal year, and how
 *   far each got (adopted / passed one chamber / only introduced)
 * - budget_resolution_targets: the levels a resolution sets: revenues, budget
 *   authority, outlays, deficit, debt, and budget authority + outlays per
 *   budget function, with a sum check against the stated totals
 * - budget_vs_actual: the targets for a fiscal year next to Treasury's actual
 *   revenues and outlays for the same year
 *
 * Nothing is stored: each call reads the resolution text and parses it. A year
 * with no resolution is a named answer (found:false + reason), never an empty list.
 */

import { parseResolutionText, type ParsedResolution } from './parse.js';

const UA = 'pipeworx-budget-resolutions/1.0 (+https://pipeworx.io)';

async function gpoFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'U.S. Government Publishing Office');
}
const SOURCE_RESOLUTION =
  'U.S. Congress, concurrent resolution on the budget (text as published by the U.S. Government Publishing Office, Congressional Bills)';
const SOURCE_ACTUALS = 'U.S. Treasury, Monthly Treasury Statement';

// ---------------------------------------------------------------------------
// Resolution identification
// ---------------------------------------------------------------------------

type Status = 'adopted' | 'passed_house' | 'passed_senate' | 'on_calendar_or_reported' | 'introduced' | 'other';

const STATUS_RANK: Record<Status, number> = {
  adopted: 5,
  passed_house: 4,
  passed_senate: 4,
  on_calendar_or_reported: 3,
  introduced: 2,
  other: 1,
};

const STATUS_NOTE: Record<Status, string> = {
  adopted: 'Agreed to by both chambers (enrolled text).',
  passed_house: 'Passed the House only. Not adopted: the Senate has not agreed to it.',
  passed_senate: 'Passed the Senate only. Not adopted: the House has not agreed to it.',
  on_calendar_or_reported: 'Reported or placed on a calendar in its chamber of origin; no chamber has passed it. Not adopted.',
  introduced: 'Introduced only. Not adopted.',
  other: 'Version status not recognised; treat as not adopted.',
};

function statusOf(type: 'hconres' | 'sconres', version: string): Status {
  if (version === 'enr') return 'adopted';
  if (type === 'hconres') {
    if (['eh', 'pcs', 'rfs', 'rds', 'eas', 'es', 'ath'].includes(version)) return 'passed_house';
    if (['rh', 'rs', 'rcs'].includes(version)) return 'on_calendar_or_reported';
    if (['ih', 'is'].includes(version)) return 'introduced';
  } else {
    if (['es', 'eas', 'rfh', 'rch', 'ath', 'eh'].includes(version)) return 'passed_senate';
    if (['rs', 'pcs', 'ras', 'rh'].includes(version)) return 'on_calendar_or_reported';
    if (['is', 'ih'].includes(version)) return 'introduced';
  }
  return 'other';
}

interface Version {
  package_id: string;
  congress: number;
  type: 'hconres' | 'sconres';
  number: number;
  version: string;
  status: Status;
  title: string;
  date_issued: string | null;
}

interface Family {
  key: string;
  label: string; // "H.Con.Res. 113 (119th Congress)"
  best: Version;
  versions: Version[];
}

const ID_RE = /^BILLS-(\d+)(hconres|sconres)(\d+)([a-z]+)$/;

function parseId(id: string, title: string, date: string | null): Version | null {
  const m = ID_RE.exec(id);
  if (!m) return null;
  const type = m[2] as 'hconres' | 'sconres';
  return {
    package_id: id,
    congress: Number(m[1]),
    type,
    number: Number(m[3]),
    version: m[4],
    status: statusOf(type, m[4]),
    title,
    date_issued: date,
  };
}

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};
const labelOf = (v: Version) =>
  `${v.type === 'hconres' ? 'H.Con.Res.' : 'S.Con.Res.'} ${v.number} (${ordinal(v.congress)} Congress)`;

/** Congress number that sits during calendar year y (the 103rd opened January 1993). */
const congressOfYear = (y: number) => Math.floor((y - 1789) / 2) + 1;

const FIRST_COVERED_FY = 1994;

function titleFiscalYear(title: string): number | null {
  const m = /fiscal years?,? (\d{4})/i.exec(title);
  return m ? Number(m[1]) : null;
}

function readFiscalYear(args: Record<string, unknown>): number {
  const raw = args.fiscal_year;
  const n = typeof raw === 'string' ? Number(raw.replace(/^FY\s*/i, '')) : (raw as number);
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1900 || n > 2200) {
    throw new Error('fiscal_year is required: a four-digit federal fiscal year such as 2025 (Oct 2024 to Sep 2025).');
  }
  return n;
}

async function giSearch(
  apiKey: string,
  body: unknown,
): Promise<{ count: number; offsetMark: string | null; results: Record<string, unknown>[] }> {
  const res = await gpoFetch(`https://api.govinfo.gov/search?api_key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) throw new Error('U.S. Government Publishing Office: unauthorized, check the data.gov key');
  if (res.status === 429) throw new Error('U.S. Government Publishing Office: rate limited (429); retry later');
  if (!res.ok) throw await httpError(res, 'U.S. Government Publishing Office');
  const j = (await res.json()) as { count?: number; offsetMark?: string; results?: Record<string, unknown>[] };
  return { count: j.count ?? 0, offsetMark: j.offsetMark ?? null, results: j.results ?? [] };
}

/** Every budget-resolution family whose title says it is the budget for `fy`. */
async function findFamilies(apiKey: string, fy: number): Promise<{ families: Family[]; congresses: number[] }> {
  const congresses = [...new Set([fy - 2, fy - 1, fy].map(congressOfYear))].filter((c) => c >= 103);
  const cq = congresses.map((c) => `congress:${c}`).join(' OR ');
  const query = `("congressional budget" OR "resolution on the budget") AND docClass:(hconres OR sconres) AND (${cq})`;
  const versions: Version[] = [];
  let mark = '*';
  for (let page = 0; page < 4; page++) {
    const r = await giSearch(apiKey, {
      query,
      pageSize: 100,
      offsetMark: mark,
      sorts: [{ field: 'publishdate', sortOrder: 'DESC' }],
    });
    for (const it of r.results) {
      const v = parseId(String(it.packageId ?? ''), String(it.title ?? ''), (it.dateIssued as string) ?? null);
      if (v) versions.push(v);
    }
    if (r.results.length < 100 || !r.offsetMark) break;
    mark = r.offsetMark;
  }
  const groups = new Map<string, Version[]>();
  for (const v of versions) {
    const k = `${v.congress}-${v.type}-${v.number}`;
    const arr = groups.get(k) ?? [];
    arr.push(v);
    groups.set(k, arr);
  }
  const families: Family[] = [];
  for (const [key, vs] of groups) {
    // The title of the enrolled copy is sometimes wrong in the source metadata
    // (another resolution's title), so a family matches if ANY version's title
    // is for this fiscal year; the parsed text is the final check.
    const fys = vs.map((v) => titleFiscalYear(v.title)).filter((x): x is number => x != null);
    if (!fys.includes(fy)) continue;
    const sorted = [...vs].sort(
      (a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || String(b.date_issued).localeCompare(String(a.date_issued)),
    );
    families.push({ key, label: labelOf(sorted[0]), best: sorted[0], versions: sorted });
  }
  families.sort(
    (a, b) =>
      STATUS_RANK[b.best.status] - STATUS_RANK[a.best.status] ||
      String(b.best.date_issued).localeCompare(String(a.best.date_issued)),
  );
  return { families, congresses };
}

const budgetTitle = (f: Family) =>
  f.versions.find((v) => /budget/i.test(v.title) && /fiscal years?/i.test(v.title))?.title ?? f.best.title;

function describeFamily(f: Family) {
  return {
    resolution: f.label,
    package_id: f.best.package_id,
    status: f.best.status,
    adopted: f.best.status === 'adopted',
    status_note: STATUS_NOTE[f.best.status],
    title: budgetTitle(f),
    date_issued: f.best.date_issued,
    versions_seen: f.versions.map((v) => ({ package_id: v.package_id, version: v.version, date_issued: v.date_issued })),
  };
}

function noResolutionReason(fy: number, congresses: number[], families: Family[], adoptedOnly: boolean): string {
  const cs = congresses.map(ordinal).join(', ');
  if (families.length === 0) {
    return `No concurrent resolution on the budget for fiscal year ${fy} appears in the published bill text of the ${cs} Congress. Congress did not adopt a budget resolution for that year. This is an answer, not a data gap: there are no resolution targets to return.`;
  }
  if (adoptedOnly) {
    return `No concurrent resolution on the budget for fiscal year ${fy} was adopted by both chambers. ${families.length} other proposal(s) exist (see candidates); pass package_id to read one that was not adopted.`;
  }
  return `No concurrent resolution on the budget for fiscal year ${fy} was adopted, and none passed even one chamber. ${families.length} proposal(s) were introduced or reported only (see candidates); pass package_id to read one.`;
}

async function fetchResolutionText(packageId: string, apiKey: string): Promise<string> {
  const keyless = `https://www.govinfo.gov/content/pkg/${packageId}/html/${packageId}.htm`;
  const res = await gpoFetch(keyless);
  if (res.ok) return res.text();
  const viaApi = await gpoFetch(`https://api.govinfo.gov/packages/${encodeURIComponent(packageId)}/htm?api_key=${encodeURIComponent(apiKey)}`);
  if (!viaApi.ok) throw new Error(`U.S. Government Publishing Office: text for ${packageId} unavailable (${res.status}/${viaApi.status})`);
  return viaApi.text();
}

interface Chosen {
  fiscal_year: number;
  family: Family;
  parsed: ParsedResolution;
  others: ReturnType<typeof describeFamily>[];
}

type Selection = { ok: true; chosen: Chosen } | { ok: false; out: Record<string, unknown> };

async function selectResolution(apiKey: string, fy: number, args: Record<string, unknown>): Promise<Selection> {
  if (fy < FIRST_COVERED_FY) {
    return {
      ok: false,
      out: {
        found: false,
        fiscal_year: fy,
        reason_code: 'before_coverage',
        reason: `Published bill text for concurrent resolutions begins with the 103rd Congress (1993), so the first covered budget year is fiscal ${FIRST_COVERED_FY}. Fiscal year ${fy} predates it; resolutions from the first years of the process (fiscal 1977 onward) are not in this source.`,
      },
    };
  }
  const adoptedOnly = args.adopted_only === true || args.adopted_only === 'true';
  const explicitId = typeof args.package_id === 'string' ? args.package_id.trim() : '';
  const { families, congresses } = await findFamilies(apiKey, fy);

  let pick: Family | undefined;
  if (explicitId) {
    const v0 = parseId(explicitId, '', null);
    if (!v0) throw new Error(`package_id "${explicitId}" is not a budget resolution package id like "BILLS-119hconres14enr".`);
    const fam = families.find((f) => f.versions.some((v) => v.package_id === explicitId));
    const v = fam?.versions.find((x) => x.package_id === explicitId) ?? v0;
    pick = { key: `${v.congress}-${v.type}-${v.number}`, label: labelOf(v), best: v, versions: fam?.versions ?? [v] };
  } else {
    const floor = adoptedOnly ? 5 : 4;
    pick = families.find((f) => STATUS_RANK[f.best.status] >= floor);
  }

  if (!pick) {
    return {
      ok: false,
      out: {
        found: false,
        fiscal_year: fy,
        reason_code: families.length === 0 ? 'no_resolution_exists' : adoptedOnly ? 'no_adopted_resolution' : 'no_resolution_passed_a_chamber',
        reason: noResolutionReason(fy, congresses, families, adoptedOnly),
        candidates: families.map(describeFamily),
        searched_congresses: congresses,
        source: SOURCE_RESOLUTION,
      },
    };
  }

  const text = await fetchResolutionText(pick.best.package_id, apiKey);
  const parsed = parseResolutionText(text);
  if (!parsed.first_fiscal_year || parsed.functions.length === 0) {
    return {
      ok: false,
      out: {
        found: false,
        fiscal_year: fy,
        reason_code: 'no_levels_in_text',
        reason: `${pick.label} (${pick.best.package_id}) was found, but its text carries no recommended-levels or functional-category tables to read, so no targets are returned.`,
        candidates: families.map(describeFamily),
        source: SOURCE_RESOLUTION,
      },
    };
  }
  if (!explicitId && parsed.first_fiscal_year !== fy) {
    return {
      ok: false,
      out: {
        found: false,
        fiscal_year: fy,
        reason_code: 'text_year_mismatch',
        reason: `${pick.label} is titled for fiscal year ${fy}, but its text sets levels starting at fiscal year ${parsed.first_fiscal_year}; refusing to return the wrong year's targets.`,
        candidates: families.map(describeFamily),
        source: SOURCE_RESOLUTION,
      },
    };
  }
  return {
    ok: true,
    chosen: { fiscal_year: fy, family: pick, parsed, others: families.filter((f) => f.key !== pick!.key).map(describeFamily) },
  };
}

// ---------------------------------------------------------------------------
// Shared shaping
// ---------------------------------------------------------------------------

function reconcile(p: ParsedResolution) {
  return p.fiscal_years.map((y) => {
    const sumBA = p.functions.reduce((s, f) => s + (f.years.find((v) => v.fiscal_year === y)?.budget_authority_usd ?? 0), 0);
    const sumOL = p.functions.reduce((s, f) => s + (f.years.find((v) => v.fiscal_year === y)?.outlays_usd ?? 0), 0);
    const statedBA = p.aggregates.budget_authority?.find((v) => v.fiscal_year === y)?.usd ?? null;
    const statedOL = p.aggregates.outlays?.find((v) => v.fiscal_year === y)?.usd ?? null;
    const one = (sum: number, stated: number | null) => ({
      sum_of_functions_usd: sum,
      stated_total_usd: stated,
      difference_usd: stated == null ? null : sum - stated,
      matches: stated == null ? null : sum === stated,
    });
    return { fiscal_year: y, budget_authority: one(sumBA, statedBA), outlays: one(sumOL, statedOL) };
  });
}

function resolutionHeader(c: Chosen) {
  const v = c.family.best;
  return {
    resolution: c.family.label,
    package_id: v.package_id,
    status: v.status,
    adopted: v.status === 'adopted',
    status_note: STATUS_NOTE[v.status],
    title: budgetTitle(c.family),
    text_version_date: v.date_issued,
  };
}

const matchFn = (name: string, q: string) => name.toLowerCase().includes(q.toLowerCase());

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const tools: McpToolExport['tools'] = [
  {
    name: 'budget_resolution_find',
    description:
      'Which congressional budget resolutions (concurrent resolutions on the budget, H.Con.Res. / S.Con.Res.) exist for a federal fiscal year, and how far each got: adopted by both chambers, passed one chamber, or only introduced. Use for "was a budget resolution adopted for FY2024?", "what budget resolutions were there for FY2027?". A year with no resolution returns found:false with a named reason, not an empty list. Covers fiscal years 1994 onward (bill text starts with the 103rd Congress). Source: U.S. Congress, as published by the U.S. Government Publishing Office.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fiscal_year: { type: 'number', description: 'Federal fiscal year (Oct-Sep), e.g. 2025 = Oct 2024 through Sep 2025.' },
      },
      required: ['fiscal_year'],
    },
  },
  {
    name: 'budget_resolution_targets',
    description:
      "The levels a congressional budget resolution sets for a fiscal year and the years after it: federal revenues, new budget authority, outlays, deficit and debt, plus new budget authority and outlays for each budget function (National Defense, Health, Medicare, Social Security, Net Interest, ...). Returns the adopted resolution; if none was adopted, the most advanced proposal that passed a chamber (clearly marked adopted:false), or found:false with a named reason. Includes a sum check: the function figures added up beside the resolution's stated totals. Use for \"FY2025 budget resolution defense outlays\", \"what did the House budget plan for FY2027 assume for revenues?\". Dollars are nominal US dollars. Optional filters narrow function and year. Source: U.S. Congress, as published by the U.S. Government Publishing Office.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        fiscal_year: { type: 'number', description: 'The budget year the resolution is for, e.g. 2025. Its levels also cover the later years in the resolution (typically nine more).' },
        function: { type: 'string', description: 'Budget function, case-insensitive substring ("Defense", "Medicare", "Net Interest") or the three-digit code ("050"). Omit for all functions.' },
        target_year: { type: 'number', description: 'Limit the output to one fiscal year inside the resolution (e.g. 2027 within a resolution that runs 2027-2036). Omit for every year.' },
        adopted_only: { type: 'boolean', description: 'true: return only a resolution adopted by both chambers; otherwise a one-chamber-passed plan may be returned if none was adopted (marked adopted:false).' },
        package_id: { type: 'string', description: 'Read a specific version, e.g. "BILLS-119hconres113pcs" (ids come from budget_resolution_find).' },
      },
      required: ['fiscal_year'],
    },
  },
  {
    name: 'budget_vs_actual',
    description:
      "A fiscal year's congressional budget-resolution targets next to what the U.S. Treasury actually reported: revenues, total outlays, the implied deficit, and outlays by budget function, each with budget, actual and the difference. Totals are compared on the on-budget basis the resolutions use (Social Security's off-budget part excluded), with unified totals beside them. Actuals come from the Monthly Treasury Statement (net outlays, nominal dollars) and say whether the year is complete; the budget side says whether the resolution was adopted. A year with no resolution still returns the actuals plus a named reason for the missing budget side. Use for \"how did FY2025 outlays compare to the budget resolution?\", \"defense spending vs budget plan\". Sources: U.S. Congress (as published by the U.S. Government Publishing Office) and U.S. Treasury.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        fiscal_year: { type: 'number', description: 'Federal fiscal year (Oct-Sep) to compare, e.g. 2025.' },
        function: { type: 'string', description: 'Limit to one budget function (substring or three-digit code). Totals are always included.' },
        adopted_only: { type: 'boolean', description: 'true: compare only against a resolution adopted by both chambers.' },
      },
      required: ['fiscal_year'],
    },
  },
];

// ---------------------------------------------------------------------------
// Treasury actuals (Monthly Treasury Statement, outlays by function)
// ---------------------------------------------------------------------------

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

interface Actuals {
  statement_date: string;
  complete: boolean;
  functions: { name: string; fytd_usd: number | null }[];
  total_outlays_usd: number | null;
  total_receipts_usd: number | null;
  on_budget_outlays_usd: number | null;
  on_budget_receipts_usd: number | null;
  off_budget_outlays_usd: number | null;
}

// Treasury's edge rejects Cloudflare Worker egress (525 / hangs) -- the same
// block the treasury-fiscal pack documents. That pack serves a daily mirror from
// Supabase when the live call fails; this pack reads the same mirror table
// (injectSupabase) so budget_vs_actual works from the gateway. Live is tried
// first, once, with a short timeout; after one failure this isolate goes
// mirror-first for 5 minutes so a slow block is paid once, not per call.
type Supa = { url: string; key: string } | null;
type FiscalRows = { data?: Record<string, string>[] };
const TREASURY_BASE = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/';
const TREASURY_LIVE_MS = 6000;
let liveBlockedUntil = 0;

function supaFromArgs(args: Record<string, unknown>): Supa {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  return url && key ? { url, key } : null;
}

async function readMirror(dataset: string, supa: Supa): Promise<{ payload: FiscalRows; fetched_at: string } | null> {
  if (!supa) return null;
  try {
    const res = await fetchWithTimeout(
      `${supa.url}/rest/v1/treasury_fiscal_mirror?dataset=eq.${encodeURIComponent(dataset)}&select=payload,fetched_at`,
      { headers: { apikey: supa.key, Authorization: `Bearer ${supa.key}`, 'User-Agent': UA } },
      'U.S. Treasury Fiscal Data',
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ payload: FiscalRows; fetched_at: string }>;
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/** Live first (one bounded try), then the mirror. `mirror` is set when the mirror answered. */
async function treasuryRows(
  dataset: string,
  endpoint: string,
  params: Record<string, string>,
  supa: Supa,
): Promise<{ rows: Record<string, string>[]; mirror: string | null }> {
  const fromMirror = async () => {
    const m = await readMirror(dataset, supa);
    return m ? { rows: m.payload.data ?? [], mirror: m.fetched_at } : null;
  };
  if (supa && Date.now() < liveBlockedUntil) {
    const m = await fromMirror();
    if (m) return m;
  }
  try {
    const url = new URL(TREASURY_BASE + endpoint);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TREASURY_LIVE_MS);
    let res: Response;
    try {
      res = await fetch(url.toString(), { headers: { 'User-Agent': UA }, signal: ctl.signal });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) throw await httpError(res, 'U.S. Treasury Fiscal Data');
    liveBlockedUntil = 0;
    return { rows: ((await res.json()) as FiscalRows).data ?? [], mirror: null };
  } catch (e) {
    liveBlockedUntil = Date.now() + 5 * 60_000;
    const m = await fromMirror();
    if (m) return m;
    throw e;
  }
}

/** On-/off-budget split of the same statement (Monthly Treasury Statement summary table). Null when unavailable. */
async function fetchBudgetSplit(
  stmtDate: string,
  supa: Supa,
  viaMirror: boolean,
): Promise<{ onOut: number | null; onRcpt: number | null; offOut: number | null }> {
  const none = { onOut: null, onRcpt: null, offOut: null };
  let rows: Record<string, string>[] = [];
  try {
    if (viaMirror) {
      rows = ((await readMirror('outlays_split', supa))?.payload.data ?? []).filter((r) => r.record_date === stmtDate);
    } else {
      rows = (
        await treasuryRows('outlays_split', 'v1/accounting/mts/mts_table_3', { filter: `record_date:eq:${stmtDate}`, 'page[size]': '200' }, supa)
      ).rows;
    }
  } catch {
    return none;
  }
  const outTotal = rows.find((r) => r.classification_desc === 'Total Outlays');
  const rcptTotal = rows.find((r) => r.classification_desc === 'Total Receipts');
  const child = (parent: Record<string, string> | undefined, tag: string) =>
    parent ? num(rows.find((r) => r.parent_id === parent.classification_id && r.classification_desc === tag)?.current_fytd_rcpt_outly_amt) : null;
  return { onOut: child(outTotal, '(On-Budget)'), onRcpt: child(rcptTotal, '(On-Budget)'), offOut: child(outTotal, '(Off-Budget)') };
}

async function fetchActuals(fy: number, supa: Supa): Promise<{ actuals: Actuals | null; reason?: string }> {
  const gte = `${fy - 1}-10-01`;
  const lte = `${fy}-09-30`;
  const got = await treasuryRows(
    'outlays',
    'v1/accounting/mts/mts_table_9',
    { sort: '-record_date', 'page[size]': '400', filter: `record_date:gte:${gte},record_date:lte:${lte}` },
    supa,
  );
  // The mirror holds the newest statements unfiltered; apply the window here.
  const rows = got.rows.filter((r) => r.record_date >= gte && r.record_date <= lte);
  if (rows.length === 0 && got.mirror && got.rows.length > 0) {
    const oldest = got.rows.map((r) => r.record_date).reduce((x, y) => (x < y ? x : y));
    if (lte < oldest) {
      return {
        actuals: null,
        reason: `The Treasury statements for fiscal year ${fy} are older than the window this service can read right now (it holds statements from ${oldest}). They are not known to be missing from the publisher; try a more recent fiscal year or try again later.`,
      };
    }
  }
  if (rows.length === 0) {
    return {
      actuals: null,
      reason: `Treasury has not yet published a Monthly Treasury Statement for any month of fiscal year ${fy} (the year runs ${fy - 1}-10-01 to ${fy}-09-30), or the series does not reach back that far (it starts with fiscal year 2015).`,
    };
  }
  const stmtDate = rows.map((r) => r.record_date).reduce((a, b) => (a > b ? a : b));
  const stmt = rows.filter((r) => r.record_date === stmtDate);
  const outRoot = stmt.find((r) => r.parent_id === 'null' && r.classification_desc === 'Net Outlays');
  const rcptRoot = stmt.find((r) => r.parent_id === 'null' && r.classification_desc === 'Receipts');
  if (!outRoot || !rcptRoot) throw new Error(`Treasury statement ${stmtDate} lacks the expected Receipts / Net Outlays structure; refusing to guess.`);
  const outTotal = stmt.find((r) => r.parent_id === outRoot.classification_id && r.data_type_cd === 'T');
  const rcptTotal = stmt.find((r) => r.parent_id === rcptRoot.classification_id && r.data_type_cd === 'T');
  const fnRows = stmt
    .filter((r) => r.parent_id === outRoot.classification_id && r.data_type_cd === 'D')
    .sort((a, b) => Number(a.src_line_nbr) - Number(b.src_line_nbr));
  if (!outTotal || !rcptTotal || fnRows.length === 0) throw new Error(`Treasury statement ${stmtDate} is missing totals or function rows; refusing to return a partial table.`);
  const split = await fetchBudgetSplit(stmtDate, supa, got.mirror !== null);
  return {
    actuals: {
      on_budget_outlays_usd: split.onOut,
      on_budget_receipts_usd: split.onRcpt,
      off_budget_outlays_usd: split.offOut,
      statement_date: stmtDate,
      complete: stmtDate.startsWith(`${fy}-09`),
      functions: fnRows.map((r) => ({ name: r.classification_desc, fytd_usd: num(r.current_fytd_rcpt_outly_amt) })),
      total_outlays_usd: num(outTotal.current_fytd_rcpt_outly_amt),
      total_receipts_usd: num(rcptTotal.current_fytd_rcpt_outly_amt),
    },
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function doFind(apiKey: string, args: Record<string, unknown>) {
  const fy = readFiscalYear(args);
  if (fy < FIRST_COVERED_FY) {
    return {
      found: false,
      fiscal_year: fy,
      reason_code: 'before_coverage',
      reason: `Published bill text for concurrent resolutions begins with the 103rd Congress (1993), so the first covered budget year is fiscal ${FIRST_COVERED_FY}. Fiscal year ${fy} predates it.`,
    };
  }
  const { families, congresses } = await findFamilies(apiKey, fy);
  const adopted = families.filter((f) => f.best.status === 'adopted');
  if (adopted.length === 0) {
    return {
      found: false,
      fiscal_year: fy,
      reason_code: families.length === 0 ? 'no_resolution_exists' : 'no_adopted_resolution',
      reason: noResolutionReason(fy, congresses, families, true),
      candidates: families.map(describeFamily),
      searched_congresses: congresses,
      source: SOURCE_RESOLUTION,
    };
  }
  return {
    found: true,
    fiscal_year: fy,
    adopted_count: adopted.length,
    adopted: adopted.map(describeFamily),
    not_adopted: families.filter((f) => f.best.status !== 'adopted').map(describeFamily),
    searched_congresses: congresses,
    source: SOURCE_RESOLUTION,
  };
}

async function doTargets(apiKey: string, args: Record<string, unknown>) {
  const fy = readFiscalYear(args);
  const sel = await selectResolution(apiKey, fy, args);
  if (!sel.ok) return sel.out;
  const c = sel.chosen;
  const fnArg = typeof args.function === 'string' ? args.function.trim() : '';
  const tyArg = args.target_year == null || args.target_year === '' ? null : Number(args.target_year);
  const yearOk = (y: number) => tyArg == null || y === tyArg;

  let functions = c.parsed.functions;
  if (fnArg) {
    functions = functions.filter((f) => f.code === fnArg || matchFn(f.name, fnArg));
    if (functions.length === 0) {
      return {
        found: false,
        fiscal_year: fy,
        reason_code: 'no_such_function',
        reason: `No budget function in ${c.family.label} matches "${fnArg}".`,
        available_functions: c.parsed.functions.map((f) => `${f.code} ${f.name}`),
        source: SOURCE_RESOLUTION,
      };
    }
  }
  if (tyArg != null && !c.parsed.fiscal_years.includes(tyArg)) {
    return {
      found: false,
      fiscal_year: fy,
      reason_code: 'target_year_outside_resolution',
      reason: `${c.family.label} sets levels for fiscal years ${c.parsed.fiscal_years[0]} through ${c.parsed.fiscal_years[c.parsed.fiscal_years.length - 1]}; ${tyArg} is outside that span.`,
      source: SOURCE_RESOLUTION,
    };
  }
  const aggregates: Record<string, { fiscal_year: number; usd: number }[]> = {};
  for (const [k, series] of Object.entries(c.parsed.aggregates)) aggregates[k] = series.filter((v) => yearOk(v.fiscal_year));
  const recon = reconcile(c.parsed).filter((r) => yearOk(r.fiscal_year));
  return {
    found: true,
    fiscal_year: fy,
    ...resolutionHeader(c),
    covers_fiscal_years: c.parsed.fiscal_years,
    basis:
      'Levels set by the resolution, nominal US dollars, federal fiscal year Oct-Sep. Deficit is as the resolution states it (on-budget in most resolutions); budget_authority and outlays are the totals the resolution states.',
    aggregates,
    functions: functions.map((f) => ({
      code: f.code,
      function: f.name,
      years: f.years
        .filter((y) => yearOk(y.fiscal_year))
        .map((y) => ({ fiscal_year: y.fiscal_year, budget_authority_usd: y.budget_authority_usd, outlays_usd: y.outlays_usd })),
    })),
    reconciliation: {
      note: 'Per fiscal year: the budget-function figures added up, against the total the resolution states. matches:true means they agree to the dollar; a difference is reported, not hidden (older resolutions state totals on a different basis, e.g. with off-budget items apart).',
      years: recon,
    },
    other_candidates: c.others,
    data_as_of: c.family.best.date_issued,
    source: SOURCE_RESOLUTION,
  };
}

async function doVsActual(apiKey: string, args: Record<string, unknown>) {
  const fy = readFiscalYear(args);
  const fnArg = typeof args.function === 'string' ? args.function.trim() : '';
  const [sel, act] = await Promise.all([selectResolution(apiKey, fy, args), fetchActuals(fy, supaFromArgs(args))]);
  const a = act.actuals;

  const actualBlock = a
    ? {
        statement_date: a.statement_date,
        fiscal_year_complete: a.complete,
        basis:
          'Treasury net outlays and total receipts, fiscal-year-to-date through the statement date, nominal US dollars.' +
          (a.complete ? '' : ' The fiscal year is not over: these are partial-year figures and are NOT comparable to a full-year target.'),
      }
    : null;

  if (!sel.ok) {
    return {
      found: false,
      fiscal_year: fy,
      budget: null,
      budget_reason: sel.out.reason,
      budget_reason_code: sel.out.reason_code,
      actual: a
        ? {
            ...actualBlock,
            total_outlays_usd: a.total_outlays_usd,
            total_receipts_usd: a.total_receipts_usd,
            on_budget_outlays_usd: a.on_budget_outlays_usd,
            on_budget_receipts_usd: a.on_budget_receipts_usd,
            outlays_by_function: a.functions.map((f) => ({ function: f.name, outlays_usd: f.fytd_usd })),
          }
        : null,
      actual_reason: a ? undefined : act.reason,
      candidates: sel.out.candidates,
      data_as_of: a ? a.statement_date : null,
      sources: [SOURCE_RESOLUTION, SOURCE_ACTUALS],
    };
  }

  const c = sel.chosen;
  const budgetOf = (key: string) => c.parsed.aggregates[key]?.find((v) => v.fiscal_year === fy)?.usd ?? null;
  const cmp = (budget: number | null, actual: number | null) => ({
    budget_usd: budget,
    actual_usd: actual,
    difference_usd: budget != null && actual != null ? actual - budget : null,
    difference_pct: budget != null && actual != null && budget !== 0 ? Math.round(((actual - budget) / Math.abs(budget)) * 10000) / 100 : null,
  });
  const bRev = budgetOf('revenues');
  const bOut = budgetOf('outlays');
  // The resolution's aggregates and function levels leave out Social Security's
  // off-budget part, so the like-for-like actual is Treasury's ON-budget total.
  // The unified totals are returned beside them for reference.
  const aOut = a?.on_budget_outlays_usd ?? null;
  const aRev = a?.on_budget_receipts_usd ?? null;

  const fnBudget = c.parsed.functions
    .filter((f) => !fnArg || f.code === fnArg || matchFn(f.name, fnArg))
    .map((f) => {
      const b = f.years.find((y) => y.fiscal_year === fy)?.outlays_usd ?? null;
      const t = a?.functions.find((x) => x.name.toLowerCase() === f.name.toLowerCase());
      let note: string | undefined;
      let comparable = !!t;
      if (!t && a) note = `Treasury's statement has no line named "${f.name}" (a budget-resolution allowance or savings placeholder, not a spending line); no actual to compare.`;
      if (t && f.code === '650') {
        comparable = false;
        note = `The resolution's Social Security level is the on-budget part only; Treasury's line includes off-budget Social Security (off-budget outlays this year: ${a?.off_budget_outlays_usd ?? 'n/a'}). The two are not like-for-like.`;
      }
      return { code: f.code, function: f.name, comparable, ...cmp(b, t?.fytd_usd ?? null), note };
    });
  const budgetNames = new Set(c.parsed.functions.map((f) => f.name.toLowerCase()));
  const unmatchedActual = a ? a.functions.filter((f) => !budgetNames.has(f.name.toLowerCase())).map((f) => f.name) : [];

  return {
    found: true,
    fiscal_year: fy,
    budget: { ...resolutionHeader(c), fiscal_year_in_resolution: fy },
    actual: actualBlock,
    actual_reason: a ? undefined : act.reason,
    comparable: a ? a.complete : false,
    totals: {
      basis: 'Resolution levels vs Treasury ON-budget totals (Social Security off-budget excluded on both sides).',
      revenues: cmp(bRev, aRev),
      outlays: cmp(bOut, aOut),
      implied_deficit: cmp(bRev != null && bOut != null ? bOut - bRev : null, aRev != null && aOut != null ? aOut - aRev : null),
      note:
        'implied_deficit = total outlays minus total revenues on each side.' +
        (a && aOut == null ? ' Treasury\'s on-budget split for this statement is not available right now, so the totals are not compared; the per-function comparison below is unaffected.' : ''),
      unified_reference: a
        ? { total_receipts_usd: a.total_receipts_usd, total_outlays_usd: a.total_outlays_usd, off_budget_outlays_usd: a.off_budget_outlays_usd }
        : null,
    },
    outlays_by_function: fnBudget,
    treasury_lines_without_budget_line: unmatchedActual.length ? unmatchedActual : undefined,
    other_candidates: c.others,
    data_as_of: a ? `Treasury statement ${a.statement_date}; resolution text ${c.family.best.date_issued}` : c.family.best.date_issued,
    sources: [SOURCE_RESOLUTION, SOURCE_ACTUALS],
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = (args._apiKey as string | undefined)?.trim();
  if (!apiKey) {
    throw new Error(
      'This pack needs a data.gov API key to look up congressional resolutions: pass your key as the _apiKey argument (free at https://api.data.gov/signup).',
    );
  }
  switch (name) {
    case 'budget_resolution_find':
      return doFind(apiKey, args);
    case 'budget_resolution_targets':
      return doTargets(apiKey, args);
    case 'budget_vs_actual':
      return doVsActual(apiKey, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

// Exposed for the unit test only (the Treasury leg is tested without the GPO leg).
export { fetchActuals as _fetchActualsForTest };
