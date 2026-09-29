import { FeedUnitsReading } from './parse.js';

const MIN_TRUSTED_LISTINGS = 5;

export function isGatedVersion(graph: FeedUnitsReading, limit: number): boolean {
  const thin = graph.listings.length < Math.min(limit, MIN_TRUSTED_LISTINGS);
  return thin && (graph.malformed || graph.hasNextPage);
}
