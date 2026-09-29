import { ListingDetails } from '../../types.js';
import { DETAIL_INFO_DOC_ID, DETAIL_PHOTOS_DOC_ID, detailInfoVariables, detailPhotosVariables } from './queries.js';
import { fetchGraphQL } from './transport.js';

export async function getListingDetails(listingId: string): Promise<ListingDetails> {
  const [photosRes, infoRes] = await Promise.all([
    fetchGraphQL(DETAIL_PHOTOS_DOC_ID, detailPhotosVariables(listingId)),
    fetchGraphQL(DETAIL_INFO_DOC_ID, detailInfoVariables(listingId)),
  ]);

  const photosTarget = photosRes?.data?.viewer?.marketplace_product_details_page?.target;
  const infoTarget = infoRes?.data?.viewer?.marketplace_product_details_page?.target;

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

function photoUris(photosTarget: any): string[] {
  if (!Array.isArray(photosTarget?.listing_photos)) return [];
  return photosTarget.listing_photos
    .map((photo: any) => photo?.image?.uri)
    .filter((uri: unknown): uri is string => Boolean(uri));
}
