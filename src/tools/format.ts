import { ListingDetails, ListingPart, SearchParams, SearchResult } from '../types.js';

export function formatSingleResult(result: SearchResult, params: SearchParams, includeImages: boolean): string {
  if (!result.success) {
    return `❌ ${result.marketplace}: ${result.error}`;
  }

  if (result.listings.length === 0) {
    return `No listings found for "${params.query}" in ${params.location}`;
  }

  const lines = [
    `🔍 Found ${result.listings.length} listings for "${params.query}" on ${result.marketplace}`,
    `📍 Location: ${params.location}`,
    ''
  ];

  // Sort by price
  const sorted = [...result.listings].sort((a, b) => 
    (a.priceNumeric || 0) - (b.priceNumeric || 0)
  );

  for (const listing of sorted) {
    lines.push(`**${listing.price}** - ${listing.title}`);
    if (listing.location) {
      lines.push(`   📍 ${listing.location}`);
    }
    lines.push(`   🆔 ${listing.id}`);
    if (listing.images && listing.images.length > 0) {
      if (includeImages) {
        lines.push(`   🖼️ Images: ${listing.images.join(' , ')}`);
      } else {
        lines.push(`   📷 ${listing.images.length} photo${listing.images.length > 1 ? 's' : ''}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function formatMultipleResults(results: SearchResult[], params: SearchParams, includeImages: boolean): string {
  const lines = [
    `🔍 Search results for "${params.query}" across all marketplaces`,
    `📍 Location: ${params.location}`,
    ''
  ];

  for (const result of results) {
    lines.push(`## ${result.marketplace}`);
    
    if (!result.success) {
      lines.push(`❌ Error: ${result.error}`);
    } else if (result.listings.length === 0) {
      lines.push('No listings found');
    } else {
      lines.push(`Found ${result.listings.length} listings:`);
      
      const sorted = [...result.listings].sort((a, b) => 
        (a.priceNumeric || 0) - (b.priceNumeric || 0)
      ).slice(0, 10); // Top 10 per marketplace

      for (const listing of sorted) {
        lines.push(`  • **${listing.price}** - ${listing.title}`);
        if (listing.images && listing.images.length > 0) {
          if (includeImages) {
            lines.push(`    🖼️ Images: ${listing.images.join(' , ')}`);
          } else {
            lines.push(`    📷 ${listing.images.length} photo${listing.images.length > 1 ? 's' : ''}`);
          }
        }
        lines.push(`    🆔 ${listing.id}`);
      }
    }
    
    lines.push('');
  }

  return lines.join('\n');
}

const UNAVAILABLE_NOTES: Record<ListingPart, string> = {
  photos: "Photos couldn't be loaded right now; asking again may bring them back.",
  description: "The description, location and seller couldn't be loaded right now; asking again may bring them back.",
};

export function formatListingDetails(details: ListingDetails): string {
  const lines = [
    `📋 Listing Details`,
    `🔗 ${details.url}`,
    '',
  ];

  if (details.description) {
    lines.push(`**Description:** ${details.description}`);
    lines.push('');
  }

  if (details.location) {
    lines.push(`📍 ${details.location}`);
  }

  if (details.seller) {
    lines.push(`👤 Seller: ${details.seller}`);
  }

  if (details.deliveryTypes && details.deliveryTypes.length > 0) {
    lines.push(`🚚 Delivery: ${details.deliveryTypes.join(', ')}`);
  }

  if (details.isShippingOffered) {
    lines.push(`📦 Shipping available`);
  }

  for (const part of details.unavailable ?? []) {
    lines.push(`⚠️ ${UNAVAILABLE_NOTES[part]}`);
  }

  if (details.images.length > 0) {
    lines.push('');
    lines.push(`🖼️ Photos (${details.images.length}):`);
    for (const img of details.images) {
      lines.push(`   ${img}`);
    }
  }

  return lines.join('\n');
}
