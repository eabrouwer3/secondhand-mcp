/**
 * KSL Classifieds implementation
 *
 * classifieds.ksl.com is a Next.js app that server-renders its search and
 * listing pages, so a plain fetch is enough — no browser, no credentials. The
 * data rides in the React Server Components flight payload
 * (`self.__next_f.push([1,"…"])` scripts) as JSON, which is read directly
 * rather than scraped from styled markup.
 *
 * Filters are path segments: /v2/search/keyword/<q>/priceFrom/N/zip/Z/…
 * Location is a ZIP plus a radius in miles; KSL has no city filter, so a
 * location without a 5-digit ZIP searches all of KSL (mostly Utah).
 */

import { ProxyAgent } from 'undici';
import { BaseMarketplace } from './base.js';
import { SearchParams, SearchResult, Listing, ListingDetails } from '../types.js';

const KSL_BASE = 'https://classifieds.ksl.com';
const SEARCH_URL = `${KSL_BASE}/v2/search`;
const LISTING_URL = `${KSL_BASE}/listing/`;

const FETCH_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 750;
// KSL sits behind PerimeterX, which turns away a share of requests with 403 or
// 503 and lets the same request through moments later.
const RETRYABLE_STATUS = new Set([403, 429, 500, 502, 503, 504]);
const DEFAULT_RADIUS_MILES = 50;

const PAGE_HEADERS: Record<string, string> = {
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

// Same residential proxy Facebook uses, when configured.
const proxyAgent = process.env.SMARTPROXY_URL
  ? new ProxyAgent(process.env.SMARTPROXY_URL)
  : undefined;

// Newest first is KSL's default and has no slug.
const SORT_MAP: Record<string, string> = {
  price_low_to_high: '2',
  price_high_to_low: '3',
};

const CONDITION_MAP: Record<string, string> = {
  new: 'New',
  like_new: 'UsedExcellent',
  excellent: 'UsedExcellent',
  good: 'UsedGood',
  fair: 'UsedFair',
};

const CONDITION_LABELS: Record<string, string> = {
  New: 'New',
  UsedExcellent: 'Used - Excellent',
  UsedGood: 'Used - Good',
  UsedFair: 'Used - Fair',
  UsedPoor: 'Used - Poor',
  UsedDamaged: 'Used - Damaged',
};

// Posts that are not items for sale.
const SKIPPED_MARKET_TYPES = new Set(['Wanted', 'Job']);

interface KslLocation {
  city?: string;
  state?: string;
  zip?: string;
  coordinates?: { latitude?: number; longitude?: number };
}

interface KslSearchItem {
  id: number;
  title?: string;
  price?: number | null;
  priceModifier?: string;
  location?: KslLocation;
  primaryImage?: { url?: string } | null;
  marketType?: string;
  newUsed?: string;
}

interface KslListing extends KslSearchItem {
  description?: string;
  contact?: { contactName?: string };
  photos?: Array<{ url?: string }> | null;
}

/** The flight payload's JSON text, joined from every push script on the page. */
export function flightText(html: string): string {
  const chunks: string[] = [];
  const pattern = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  for (const m of html.matchAll(pattern)) {
    try {
      chunks.push(JSON.parse(m[1]));
    } catch {
      /* a malformed chunk only loses what it carried */
    }
  }
  return chunks.join('');
}

/** The JSON value starting at `start`, found by matching brackets outside strings. */
function sliceJson(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{' || c === '[') {
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** The value following the first occurrence of `anchor`, which ends where that value begins. */
export function extractAfter<T>(text: string, anchor: string): T | undefined {
  const at = text.indexOf(anchor);
  if (at === -1) return undefined;
  const raw = sliceJson(text, at + anchor.length - 1);
  if (!raw) return undefined;
  try {
    return unescapeDollars(JSON.parse(raw)) as T;
  } catch {
    return undefined;
  }
}

/** RSC escapes a literal leading "$" as "$$" to tell it apart from references. */
function unescapeDollars(value: unknown): unknown {
  if (typeof value === 'string') return value.startsWith('$$') ? value.slice(1) : value;
  if (Array.isArray(value)) return value.map(unescapeDollars);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unescapeDollars(v)]));
  }
  return value;
}

function formatLocation(loc?: KslLocation): string | undefined {
  if (!loc) return undefined;
  const parts = [loc.city, loc.state].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

export class KslMarketplace extends BaseMarketplace {
  readonly name = 'ksl';
  readonly displayName = 'KSL Classifieds';
  readonly requiresAuth = false;

  async search(params: SearchParams): Promise<SearchResult> {
    const { minPrice, maxPrice, limit = 48 } = params;
    const zip = params.location?.match(/\b\d{5}\b/)?.[0];

    try {
      const text = flightText(await this.fetchPage(this.buildSearchUrl(params, zip)));
      const pages = extractAfter<KslSearchItem[][]>(text, '"initialState":{"results":[');
      if (!pages) {
        return this.createError('KSL search returned no results payload. The page may have been blocked or its markup changed.');
      }
      const total = extractAfter<Array<{ total?: number }>>(text, '"pageInfo":[')?.[0]?.total;

      let listings = pages
        .flat()
        .filter((item) => item && !SKIPPED_MARKET_TYPES.has(item.marketType ?? ''))
        .map((item) => this.toListing(item));

      // The URL bounds are applied server-side too; this guards featured slots.
      if (minPrice != null) listings = listings.filter((l) => l.priceNumeric == null || l.priceNumeric >= minPrice);
      if (maxPrice != null) listings = listings.filter((l) => l.priceNumeric == null || l.priceNumeric <= maxPrice);
      listings = listings.slice(0, limit);

      return {
        marketplace: this.name,
        success: true,
        listings,
        totalFound: total ?? listings.length,
        ...(listings.length === 0 && {
          note: 'No KSL listings parsed. The search may have been too narrow, or the page was blocked or its markup changed.',
        }),
      };
    } catch (error) {
      return this.createError(`KSL search failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async getListingDetails(listingId: string): Promise<ListingDetails> {
    const url = `${LISTING_URL}${encodeURIComponent(listingId)}`;
    const text = flightText(await this.fetchPage(url));
    const listing = extractAfter<KslListing>(text, '"listing":{');
    if (!listing) throw new Error(`KSL listing ${listingId} not found or its page markup changed`);

    const images: string[] = [];
    for (const p of listing.photos ?? []) if (p?.url && !images.includes(p.url)) images.push(p.url);
    if (images.length === 0 && listing.primaryImage?.url) images.push(listing.primaryImage.url);

    const coords = listing.location?.coordinates;
    return {
      id: String(listing.id ?? listingId),
      description: listing.description || undefined,
      images,
      location: formatLocation(listing.location),
      ...(coords?.latitude != null && coords.longitude != null && {
        locationCoords: { latitude: coords.latitude, longitude: coords.longitude },
      }),
      seller: listing.contact?.contactName || undefined,
      url,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.search({ query: 'test', limit: 1 });
      return result.success;
    } catch {
      return false;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async fetchPage(url: string): Promise<string> {
    let lastError = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt - 1)));
      try {
        const resp = await fetch(url, {
          headers: PAGE_HEADERS,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          // @ts-ignore — dispatcher is a Node.js/undici-specific fetch option
          dispatcher: proxyAgent,
        });
        if (resp.ok) return await resp.text();
        lastError = `HTTP ${resp.status}`;
        await resp.body?.cancel().catch(() => {});
        if (!RETRYABLE_STATUS.has(resp.status)) break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    throw new Error(`${lastError} from ${url} after retries`);
  }

  buildSearchUrl(params: SearchParams, zip?: string): string {
    const segments: string[] = ['keyword', params.query];
    if (params.minPrice != null) segments.push('priceFrom', String(Math.floor(params.minPrice)));
    if (params.maxPrice != null) segments.push('priceTo', String(Math.ceil(params.maxPrice)));
    if (params.condition && CONDITION_MAP[params.condition]) segments.push('newUsed', CONDITION_MAP[params.condition]);
    if (zip) segments.push('zip', zip, 'miles', String(Math.round(params.radius ?? DEFAULT_RADIUS_MILES)));
    const sort = params.sort && SORT_MAP[params.sort];
    if (sort) segments.push('sort', sort);
    return `${SEARCH_URL}/${segments.map(encodeURIComponent).join('/')}`;
  }

  private toListing(item: KslSearchItem): Listing {
    const hasPrice = typeof item.price === 'number' && item.price > 0;
    const modifier = item.priceModifier?.trim();
    const price = hasPrice
      ? `$${item.price!.toLocaleString('en-US')}${modifier ? ` ${modifier}` : ''}`
      : modifier || 'Price not listed';

    return {
      id: String(item.id),
      title: item.title || `KSL listing ${item.id}`,
      price,
      priceNumeric: hasPrice ? item.price! : undefined,
      currency: '$',
      location: formatLocation(item.location),
      url: `${LISTING_URL}${item.id}`,
      images: item.primaryImage?.url ? [item.primaryImage.url] : undefined,
      condition: item.newUsed ? CONDITION_LABELS[item.newUsed] ?? item.newUsed : undefined,
      marketplace: this.name,
      scrapedAt: new Date().toISOString(),
    };
  }
}
