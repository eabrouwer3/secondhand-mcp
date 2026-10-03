import { afterEach, describe, expect, it, vi } from 'vitest';
import { KslMarketplace, extractAfter, flightText } from '../src/marketplaces/ksl.js';

// ksl.ts builds a ProxyAgent from SMARTPROXY_URL at module evaluation.
vi.mock('undici', () => ({ ProxyAgent: class {} }));

/** A page whose flight payload carries `rsc`, split across two push scripts the way Next.js does. */
function page(rsc: string): string {
  const mid = Math.floor(rsc.length / 2);
  const push = (s: string) => `<script>self.__next_f.push([1,${JSON.stringify(s)}])</script>`;
  return `<!DOCTYPE html><html><body>${push(rsc.slice(0, mid))}${push(rsc.slice(mid))}</body></html>`;
}

const item = (over: Record<string, unknown> = {}) => ({
  id: 80466491,
  listingType: 'CLASSIFIED',
  title: 'Santa Cruz VALA',
  primaryImage: { url: 'https://image.ksldigital.com/a.png?filter=marketplace/400x300_cropped' },
  location: { city: 'Bountiful', state: 'UT', zip: '84010' },
  price: 8849,
  priceModifier: '',
  marketType: 'Sale',
  ...over,
});

function searchPage(items: unknown[], total = 1162): string {
  return page(
    `2d:["$","$L2e",null,{"initialState":{"results":[${JSON.stringify(items)}],` +
      `"pageInfo":[{"hasNextPage":true,"total":${total}}]}}]\n`
  );
}

const detailPage = page(
  `7:[["$","$L2f",null,{"listing":${JSON.stringify({
    id: 82145218,
    title: 'KTM SX 65',
    location: { city: 'Heber', state: 'UT', zip: '84032', coordinates: { latitude: 40.5, longitude: -111.39 } },
    contact: { memberId: 1, contactName: 'Scott' },
    primaryImage: { url: 'https://image.ksldigital.com/p.jpeg' },
    photos: [{ url: 'https://image.ksldigital.com/1.jpeg' }, { url: 'https://image.ksldigital.com/2.jpeg' }],
    description: '$$2,800 OBO\n\nTitle in hand.',
  })}}]]\n`
);

function stubFetch(...responses: Array<Response | (() => Response)>) {
  const urls: string[] = [];
  let i = 0;
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const r = responses[Math.min(i++, responses.length - 1)];
    return typeof r === 'function' ? r() : r;
  });
  vi.stubGlobal('fetch', mock);
  return { mock, urls };
}

const html = (body: string, status = 200) => () => new Response(body, { status });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('flight payload parsing', () => {
  it('joins push chunks and extracts the value after an anchor', () => {
    const text = flightText(page('x:{"listing":{"id":1,"title":"a } [ \\" b"},"other":2}'));
    expect(extractAfter(text, '"listing":{')).toEqual({ id: 1, title: 'a } [ " b' });
  });

  it('returns undefined when the anchor is absent', () => {
    expect(extractAfter(flightText(page('nothing here')), '"listing":{')).toBeUndefined();
  });
});

describe('KslMarketplace.search', () => {
  it('builds path filters for price, condition, ZIP radius and sort', async () => {
    const { urls } = stubFetch(html(searchPage([item()])));
    await new KslMarketplace().search({
      query: 'mountain bike',
      minPrice: 100,
      maxPrice: 9000,
      condition: 'like_new',
      location: 'Bountiful, UT 84010',
      radius: 25,
      sort: 'price_high_to_low',
    });
    expect(urls[0]).toBe(
      'https://classifieds.ksl.com/v2/search/keyword/mountain%20bike/priceFrom/100/priceTo/9000' +
        '/newUsed/UsedExcellent/zip/84010/miles/25/sort/3'
    );
  });

  it('leaves out filters KSL has no equivalent for', async () => {
    const { urls } = stubFetch(html(searchPage([item()])));
    await new KslMarketplace().search({ query: 'bike', condition: 'used', sort: 'relevance' });
    expect(urls[0]).toBe('https://classifieds.ksl.com/v2/search/keyword/bike');
  });

  it('maps listings and skips wanted and job posts', async () => {
    stubFetch(
      html(
        searchPage([
          item({ priceModifier: 'OBO', newUsed: 'UsedGood' }),
          item({ id: 2, marketType: 'Wanted', title: 'Wanted: e-bike' }),
          item({ id: 3, marketType: 'Job', title: 'Bike mechanic' }),
          item({ id: 4, price: 0, primaryImage: null, title: 'Free bike' }),
        ])
      )
    );
    const r = await new KslMarketplace().search({ query: 'bike' });

    expect(r.success).toBe(true);
    expect(r.totalFound).toBe(1162);
    expect(r.listings.map((l) => l.id)).toEqual(['80466491', '4']);
    expect(r.listings[0]).toMatchObject({
      title: 'Santa Cruz VALA',
      price: '$8,849 OBO',
      priceNumeric: 8849,
      currency: '$',
      location: 'Bountiful, UT',
      url: 'https://classifieds.ksl.com/listing/80466491',
      images: ['https://image.ksldigital.com/a.png?filter=marketplace/400x300_cropped'],
      condition: 'Used - Good',
      marketplace: 'ksl',
    });
    expect(r.listings[1]).toMatchObject({ price: 'Price not listed', priceNumeric: undefined, images: undefined });
  });

  it('enforces price bounds and limit client-side', async () => {
    stubFetch(html(searchPage([item({ id: 1, price: 50 }), item({ id: 2, price: 150 }), item({ id: 3, price: 250 }), item({ id: 4, price: 900 })])));
    const r = await new KslMarketplace().search({ query: 'bike', minPrice: 100, maxPrice: 500, limit: 1 });
    expect(r.listings.map((l) => l.id)).toEqual(['2']);
  });

  it('searches all of KSL when the location has no ZIP', async () => {
    const { urls } = stubFetch(html(searchPage([item()])));
    const r = await new KslMarketplace().search({ query: 'bike', location: 'Provo, UT', radius: 10 });
    expect(urls[0]).toBe('https://classifieds.ksl.com/v2/search/keyword/bike');
    expect(r.note).toBeUndefined();
  });

  it('defaults the ZIP radius to 50 miles', async () => {
    const { urls } = stubFetch(html(searchPage([item()])));
    await new KslMarketplace().search({ query: 'bike', location: '84601' });
    expect(urls[0]).toBe('https://classifieds.ksl.com/v2/search/keyword/bike/zip/84601/miles/50');
  });

  it('notes an empty result', async () => {
    stubFetch(html(searchPage([], 0)));
    const r = await new KslMarketplace().search({ query: 'bike' });
    expect(r.success).toBe(true);
    expect(r.note).toMatch(/No KSL listings/);
  });

  it('fails cleanly when the page has no results payload', async () => {
    stubFetch(html('<html>Access denied</html>'));
    const r = await new KslMarketplace().search({ query: 'bike' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/blocked or its markup changed/);
  });

  it('retries a bot-wall refusal and succeeds on a later attempt', async () => {
    vi.useFakeTimers();
    const { mock } = stubFetch(html('denied', 403), html('busy', 503), html(searchPage([item()])));
    const running = new KslMarketplace().search({ query: 'bike' });
    await vi.runAllTimersAsync();
    const r = await running;
    expect(mock).toHaveBeenCalledTimes(3);
    expect(r.success).toBe(true);
  });

  it('reports the last status once retries run out', async () => {
    vi.useFakeTimers();
    const { mock } = stubFetch(html('denied', 403));
    const running = new KslMarketplace().search({ query: 'bike' });
    await vi.runAllTimersAsync();
    const r = await running;
    expect(mock).toHaveBeenCalledTimes(3);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/HTTP 403/);
  });

  it('does not retry a status that will not change', async () => {
    const { mock } = stubFetch(html('gone', 404));
    const r = await new KslMarketplace().search({ query: 'bike' });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(r.error).toMatch(/HTTP 404/);
  });
});

describe('KslMarketplace.getListingDetails', () => {
  it('maps description, every photo, location and seller', async () => {
    const { urls } = stubFetch(html(detailPage));
    const d = await new KslMarketplace().getListingDetails('82145218');

    expect(urls[0]).toBe('https://classifieds.ksl.com/listing/82145218');
    expect(d).toEqual({
      id: '82145218',
      description: '$2,800 OBO\n\nTitle in hand.',
      images: ['https://image.ksldigital.com/1.jpeg', 'https://image.ksldigital.com/2.jpeg'],
      location: 'Heber, UT',
      locationCoords: { latitude: 40.5, longitude: -111.39 },
      seller: 'Scott',
      url: 'https://classifieds.ksl.com/listing/82145218',
    });
  });

  it('falls back to the primary image when there are no photos', async () => {
    stubFetch(html(page(`7:{"listing":{"id":5,"primaryImage":{"url":"https://image.ksldigital.com/p.jpeg"},"photos":null}}`)));
    const d = await new KslMarketplace().getListingDetails('5');
    expect(d.images).toEqual(['https://image.ksldigital.com/p.jpeg']);
    expect(d.locationCoords).toBeUndefined();
  });

  it('throws when the listing payload is missing', async () => {
    stubFetch(html('<html></html>'));
    await expect(new KslMarketplace().getListingDetails('1')).rejects.toThrow(/not found/);
  });
});
