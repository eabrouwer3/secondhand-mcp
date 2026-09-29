import { ListingDetails } from '../../types.js';
import { DETAIL_INFO_DOC_ID, DETAIL_PHOTOS_DOC_ID, detailInfoVariables, detailPhotosVariables } from './queries.js';
import { fetchGraphQL } from './transport.js';

export async function getListingDetails(listingId: string): Promise<ListingDetails> {
  const [photos, info] = await Promise.allSettled([
    fetchGraphQL(DETAIL_PHOTOS_DOC_ID, detailPhotosVariables(listingId)),
    fetchGraphQL(DETAIL_INFO_DOC_ID, detailInfoVariables(listingId)),
  ]);
  if (photos.status === 'rejected' && info.status === 'rejected') throw photos.reason;

  const photosTarget = detailsTarget(photos, 'photos');
  const infoTarget = detailsTarget(info, 'info');

  return {
    id: listingId,
    description: infoTarget?.redacted_description?.text ?? undefined,
    images: photoUris(photosTarget),
    location: infoTarget?.location_text?.text ?? undefined,
    locationCoords: infoTarget?.location ?? undefined,
    seller: infoTarget?.marketplace_listing_seller?.name ?? undefined,
    deliveryTypes: infoTarget?.delivery_types ?? undefined,
    isShippingOffered: infoTarget?.is_shipping_offered ?? undefined,
    url: `https://www.facebook.com/marketplace/item/${listingId}`,
  };
}

/** One request's share of the listing; a failed one leaves its fields empty. */
function detailsTarget(settled: PromiseSettledResult<any>, part: string): any {
  if (settled.status === 'rejected') {
    console.error(`[facebook] listing ${part} request failed:`, settled.reason?.message ?? settled.reason);
    return undefined;
  }
  return settled.value?.data?.viewer?.marketplace_product_details_page?.target;
}

function photoUris(photosTarget: any): string[] {
  if (!Array.isArray(photosTarget?.listing_photos)) return [];
  return photosTarget.listing_photos
    .map((photo: any) => photo?.image?.uri)
    .filter((uri: unknown): uri is string => Boolean(uri));
}
