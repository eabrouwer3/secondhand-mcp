import { researchFetch, researchSearch } from './deep-research.js';
import { listMarketplaces } from './list-marketplaces.js';
import { listingDetails } from './listing-details.js';
import { ToolResult, errorResult } from './results.js';
import { searchMarketplace } from './search-marketplace.js';

export { tools } from './definitions.js';
export { INSTRUCTIONS } from './instructions.js';

const HANDLERS: Record<string, (args: unknown) => Promise<ToolResult>> = {
  search_marketplace: searchMarketplace,
  get_listing_details: listingDetails,
  list_marketplaces: listMarketplaces,
  search: researchSearch,
  fetch: researchFetch,
};

export function callTool(name: string, args: unknown): Promise<ToolResult> {
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
  return handler ? handler(args) : Promise.resolve(errorResult(`Unknown tool: ${name}`));
}
