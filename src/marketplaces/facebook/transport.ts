import { ProxyAgent } from 'undici';

const GRAPHQL_URL = 'https://www.facebook.com/api/graphql/';

const MAX_ATTEMPTS = 3;
const PAGE_ATTEMPTS = 2;
const ATTEMPT_TIMEOUT_MS = 8000;
const TOTAL_BUDGET_MS = 15000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const GRAPHQL_HEADERS: Record<string, string> = {
  'content-type': 'application/x-www-form-urlencoded',
  'sec-fetch-site': 'same-origin',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// The search page only renders results for browser-shaped requests.
const SEARCH_PAGE_HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

// Residential proxy for Facebook requests (avoids datacenter IP rate limits)
const proxyAgent = process.env.SMARTPROXY_URL
  ? new ProxyAgent(process.env.SMARTPROXY_URL)
  : undefined;

export async function fetchGraphQL(docId: string, variables: string): Promise<any> {
  const body = new URLSearchParams({
    variables,
    doc_id: docId,
  });

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    let expiry: ReturnType<typeof setTimeout> | undefined;

    try {
      const running = attemptGraphQL(body, Math.min(ATTEMPT_TIMEOUT_MS, remaining));
      // A transport that is slow to honour its abort would otherwise carry an
      // attempt past the deadline; losing this race is what caps elapsed time.
      running.catch(() => {});
      const expired = new Promise<never>((_, reject) => {
        expiry = setTimeout(
          () =>
            reject(
              Object.assign(new Error('Facebook request exceeded its time budget'), {
                name: 'TimeoutError',
              })
            ),
          remaining
        );
      });

      return await Promise.race([running, expired]);
    } catch (err: any) {
      if (err?.fatal) throw err;
      lastError = err;

      const backoff = 1000 * 2 ** (attempt - 1) * (0.5 + Math.random());
      if (attempt === MAX_ATTEMPTS || Date.now() + backoff >= deadline) break;
      await new Promise((r) => setTimeout(r, backoff));
    } finally {
      clearTimeout(expiry);
    }
  }

  throw lastError ?? new Error('Facebook request failed');
}

async function attemptGraphQL(body: URLSearchParams, timeoutMs: number): Promise<any> {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: GRAPHQL_HEADERS,
    body: body.toString(),
    signal: AbortSignal.timeout(timeoutMs),
    // @ts-ignore — dispatcher is a Node.js/undici-specific fetch option
    dispatcher: proxyAgent,
  });

  if (RETRYABLE_STATUS.has(response.status)) {
    throw new Error(`Facebook API returned status ${response.status}`);
  }
  if (!response.ok) {
    throw Object.assign(new Error(`Facebook API returned status ${response.status}`), {
      fatal: true,
    });
  }

  const json = (await response.json()) as any;

  // Errors can be partial, such as one listing's field failing server-side,
  // and arrive alongside usable data.
  if (json.errors?.length && !json.data) {
    throw Object.assign(new Error(`Facebook GraphQL error: ${json.errors[0].message}`), {
      fatal: true,
    });
  }
  if (json.errors?.length) {
    console.error('[facebook] partial graphql error, continuing with data:', json.errors[0].message);
  }

  return json;
}

export async function fetchSearchPage(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PAGE_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: SEARCH_PAGE_HEADERS,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        // @ts-ignore — dispatcher is a Node.js/undici-specific fetch option
        dispatcher: proxyAgent,
      });
      if (!response.ok) throw new Error(`Facebook page returned status ${response.status}`);
      const html = await response.text();
      // A blocked or login-walled page is a 200 without the search payload.
      if (!html.includes('marketplace_search')) {
        throw new Error('Facebook served the search page without results');
      }
      return html;
    } catch (err) {
      lastError = err;
      if (!isTransientNetworkError(err)) throw err;
    }
  }
  throw lastError;
}

/** Facebook answered, but with an error instead of data. Retrying the same
 *  request will not help; a different route to the same results might. */
export function isRefusal(err: unknown): boolean {
  return (err as { fatal?: boolean } | null)?.fatal === true;
}

function isTransientNetworkError(err: any): boolean {
  return err?.name === 'TimeoutError' || /fetch failed|aborted|socket|ECONN/i.test(err?.message ?? '');
}
