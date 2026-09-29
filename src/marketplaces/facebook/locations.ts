import { lookupUsCity } from '../us-cities.js';
import { LocationCoordinates } from '../../types.js';
import { LOCATION_DOC_ID, locationVariables } from './queries.js';
import { fetchGraphQL } from './transport.js';

const CITY_PAGE_CACHE_MAX = 200;

export class LocationResolver {
  private coordsCache: Map<string, LocationCoordinates> = new Map();
  private cityPageIdCache: Map<string, string | null> = new Map();

  async coordinates(query: string): Promise<LocationCoordinates | null> {
    const local = lookupUsCity(query);
    if (local) return local;

    const primaryKey = query.toLowerCase().trim();

    for (const candidate of candidates(query)) {
      const coords = await this.coordinatesExact(candidate);
      if (coords) {
        if (candidate !== primaryKey) this.coordsCache.set(primaryKey, coords);
        return coords;
      }
    }
    return null;
  }

  async cityPageId(location: string): Promise<string | null> {
    const key = location.toLowerCase().trim();
    if (this.cityPageIdCache.has(key)) return this.cityPageIdCache.get(key)!;

    let pageId: string | null = null;
    for (const candidate of candidates(location)) {
      pageId = await lookupCityPageId(candidate);
      if (pageId) break;
    }

    if (this.cityPageIdCache.size > CITY_PAGE_CACHE_MAX) {
      const oldest = this.cityPageIdCache.keys().next().value;
      if (oldest !== undefined) this.cityPageIdCache.delete(oldest);
    }
    this.cityPageIdCache.set(key, pageId);
    return pageId;
  }

  private async coordinatesExact(cacheKey: string): Promise<LocationCoordinates | null> {
    if (this.coordsCache.has(cacheKey)) {
      return this.coordsCache.get(cacheKey)!;
    }

    try {
      const response = await fetchGraphQL(LOCATION_DOC_ID, locationVariables(cacheKey));

      const edges = response?.data?.city_street_search?.street_results?.edges;
      if (!edges || edges.length === 0) {
        return null;
      }

      // Results are ranked by check-ins, so "phoenix" leads with a venue in
      // South Africa and "sacramento" with a street in Portugal. Only real
      // places carry the bare "City" subtitle.
      const cityEdge = edges.find((e: any) => isCity(e.node));
      const node = (cityEdge ?? edges[0]).node;
      const name = isCity(node)
        ? node.single_line_address
        : subtitleKind(node) || node.single_line_address;

      const coords: LocationCoordinates = {
        latitude: node.location.latitude,
        longitude: node.location.longitude,
        name,
      };

      this.coordsCache.set(cacheKey, coords);
      return coords;
    } catch {
      return null;
    }
  }
}

async function lookupCityPageId(query: string): Promise<string | null> {
  try {
    const response = await fetchGraphQL(LOCATION_DOC_ID, locationVariables(query));
    const edges = response?.data?.city_street_search?.street_results?.edges ?? [];
    const places = edges.map((e: any) => e?.node).filter((n: any) => n?.page?.id);
    const city = places.find(isCity) ?? places[0];
    return city?.page?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Facebook's city search is literal, and a "City, ST" query does not just
 * miss — "kansas city, mo" returns Mound City, Kansas. Spelling the state
 * out is the only form that reliably lands, so it goes first; the bare
 * city name is a last resort because "austin" is Austin, Illinois.
 */
function candidates(query: string): string[] {
  const base = query.toLowerCase().trim();
  const out: string[] = [];

  if (!out.includes(base)) out.push(base);

  const bareCity = base.split(',')[0].trim();
  if (bareCity && !out.includes(bareCity)) out.push(bareCity);

  return out;
}

function subtitleKind(node: any): string | undefined {
  return node?.subtitle?.split(' ·')[0];
}

function isCity(node: any): boolean {
  return subtitleKind(node) === 'City';
}
