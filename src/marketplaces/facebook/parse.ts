import { parsePrice } from '../base.js';
import { Listing } from '../../types.js';

export interface FeedUnitsReading {
  listings: Listing[];
  malformed: boolean;
  hasNextPage: boolean;
}

export function readFeedUnits(feedUnits: any, limit: number, showSold: boolean): FeedUnitsReading {
  if (!feedUnits?.edges) {
    console.error('[facebook] unexpected graphql response structure');
    return { listings: [], malformed: true, hasNextPage: false };
  }
  const edges: any[] = feedUnits.edges;
  return {
    listings: parseListings(edges, limit, showSold),
    malformed: edges.some((edge) => edge?.node && !edge.node.listing),
    hasNextPage: feedUnits.page_info?.has_next_page === true,
  };
}

export function parseListings(edges: any[], limit: number, showSold: boolean): Listing[] {
  const listings: Listing[] = [];

  for (const edge of edges) {
    if (listings.length >= limit) break;

    try {
      // The wrapper's __typename varies between API versions; the listing
      // object is the contract.
      const listing = edge?.node?.listing;
      if (!listing) continue;
      if (!showSold && isUnavailable(listing)) continue;

      const price = listing.listing_price?.formatted_amount || 'Price not listed';
      const parsed = parsePrice(price);

      const imageUri = listing.primary_listing_photo?.image?.uri;

      listings.push({
        id: listing.id,
        title: listing.marketplace_listing_title || 'Untitled Listing',
        price,
        priceNumeric: parsed?.numeric,
        currency: parsed?.currency || '$',
        location: listingLocation(listing),
        url: `https://www.facebook.com/marketplace/item/${listing.id}`,
        images: imageUri ? [imageUri] : undefined,
        seller: listing.marketplace_listing_seller?.name,
        marketplace: 'facebook',
        scrapedAt: new Date().toISOString(),
      });
    } catch {
      continue;
    }
  }

  return listings;
}

function isUnavailable(listing: any): boolean {
  if (listing.is_sold === true) return true;
  if (listing.is_live === false) return true;
  if (listing.is_pending === true) return true;
  if (listing.is_hidden === true) return true;

  // Sellers sometimes mark sold items in the title instead.
  const title = (listing.marketplace_listing_title || '').toUpperCase();
  return title.startsWith('[SOLD]') || title.startsWith('SOLD -') || title === 'SOLD';
}

function listingLocation(listing: any): string | undefined {
  const geo = listing.location?.reverse_geocode;
  if (geo?.city_page?.display_name) return geo.city_page.display_name;
  if (geo?.city) return [geo.city, geo.state].filter(Boolean).join(', ');
  return undefined;
}

// The page embeds several feed_units payloads (preloader shells, module
// manifests) besides the real one, in an order that varies by variant.
export function extractFeedUnitEdges(html: string): any[] | null {
  let best: any[] | null = null;
  let bestListings = -1;
  for (
    let anchor = html.indexOf('"feed_units"');
    anchor !== -1;
    anchor = html.indexOf('"feed_units"', anchor + 1)
  ) {
    const edgesAt = html.indexOf('"edges":', anchor);
    if (edgesAt === -1 || edgesAt > anchor + 200) continue;
    const edges = extractJsonArray(html, html.indexOf('[', edgesAt));
    if (!edges) continue;
    const withListing = edges.filter((e: any) => e?.node?.listing).length;
    if (withListing > bestListings) {
      best = edges;
      bestListings = withListing;
    }
  }
  return best;
}

// Balanced-bracket scan; string-aware because listing titles contain brackets.
function extractJsonArray(html: string, start: number): any[] | null {
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
