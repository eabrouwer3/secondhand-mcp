import { getAllMarketplaces, getMarketplace, listMarketplaceNames } from '../marketplaces/index.js';
import { SearchParams, SearchResult } from '../types.js';
import { formatMultipleResults, formatSingleResult } from './format.js';
import { ToolResult, errorResult, textResult } from './results.js';

interface SearchMarketplaceArgs {
  query: string;
  marketplace?: string;
  location?: string;
  radiusMiles?: number;
  maxPrice?: number;
  minPrice?: number;
  limit?: number;
  offset?: number;
  showSold?: boolean;
  includeImages?: boolean;
  sort?: string;
  condition?: string;
  category?: string;
  brand?: string;
  department?: string;
  sizes?: string[];
  colors?: string[];
}

export async function searchMarketplace(args: unknown): Promise<ToolResult> {
  const params = args as SearchMarketplaceArgs;
  if (!params.query) return errorResult('Missing required parameter: query');

  const searchParams = toSearchParams(params);
  const includeImages = params.includeImages || false;
  const marketplaceName = params.marketplace || 'facebook';

  if (marketplaceName === 'all') {
    const results = await searchEveryMarketplace(searchParams);
    return textResult(formatMultipleResults(results, searchParams, includeImages));
  }

  const marketplace = getMarketplace(marketplaceName);
  if (!marketplace) {
    return errorResult(`Unknown marketplace: ${marketplaceName}. Available: ${listMarketplaceNames().join(', ')}`);
  }

  try {
    const result = await marketplace.search(searchParams);
    return textResult(formatSingleResult(result, searchParams, includeImages));
  } catch (error) {
    return errorResult(`Error searching ${marketplace.displayName}: ${error}`);
  }
}

function toSearchParams(params: SearchMarketplaceArgs): SearchParams {
  return {
    query: params.query,
    location: params.location || 'san francisco',
    radius: params.radiusMiles,
    maxPrice: params.maxPrice,
    minPrice: params.minPrice,
    limit: params.limit || 20,
    offset: params.offset || 0,
    showSold: params.showSold || false,
    sort: params.sort as SearchParams['sort'],
    condition: params.condition as SearchParams['condition'],
    category: params.category,
    brand: params.brand,
    department: params.department,
    sizes: params.sizes,
    colors: params.colors,
  };
}

async function searchEveryMarketplace(searchParams: SearchParams): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  for (const mp of getAllMarketplaces()) {
    try {
      results.push(await mp.search(searchParams));
    } catch (error) {
      results.push({ marketplace: mp.name, success: false, listings: [], error: String(error) });
    }
  }
  return results;
}
