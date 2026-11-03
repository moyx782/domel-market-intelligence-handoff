// Stored geography for event inference: country / province / city / district /
// county. The demo intentionally keeps this as data (seed/geo-cn.json) instead
// of guessing from name heuristics, so adding a new exhibition city is a data
// change, not a code change.
//
// Matching is plain substring lookup on normalised strings (no regular
// expressions): longest stored alias wins, and every level of the hierarchy is
// taken from the matched entry rather than inferred from the alias text.

import {readFileSync} from 'node:fs';

const SUFFIXES = [
 '特别行政区', '维吾尔自治区', '壮族自治区', '回族自治区', '自治区', '省', '市', '区', '县', '新区',
];
const IGNORED_CHARS = [' ', '\t', '\n', '（', '）', '(', ')', '·', '-', '—', '_', ',', '，', '.', '。', '/', '\\', '、'];

export function normalizeGeoText(value) {
 let text = String(value ?? '').trim().toLowerCase();
 for (const char of IGNORED_CHARS) text = text.split(char).join('');
 return text;
}

// A stored name can be used with or without its administrative suffix
// ("上海市" / "上海"); both forms are indexed.
function nameVariants(name) {
 const base = normalizeGeoText(name);
 if (!base) return [];
 const variants = new Set([base]);
 let stripped = base;
 for (const suffix of SUFFIXES) {
  if (stripped.endsWith(suffix) && stripped.length > suffix.length) {
   stripped = stripped.slice(0, -suffix.length);
   variants.add(stripped);
  }
 }
 return [...variants];
}

function loadData(file) {
 if (!file) return {version: 1, countries: [], provinces: [], cities: [], venues: [], regions: {}};
 try {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return {
   version: 1,
   countries: Array.isArray(parsed.countries) ? parsed.countries : [],
   provinces: Array.isArray(parsed.provinces) ? parsed.provinces : [],
   cities: Array.isArray(parsed.cities) ? parsed.cities : [],
   venues: Array.isArray(parsed.venues) ? parsed.venues : [],
   regions: parsed.regions && typeof parsed.regions === 'object' ? parsed.regions : {},
  };
 } catch {
  return {version: 1, countries: [], provinces: [], cities: [], venues: [], regions: {}};
 }
}

function indexEntries(entries) {
 return entries.map(entry => ({
  entry,
  variants: [...new Set([
   entry.name,
   entry.code,
   ...(Array.isArray(entry.aliases) ? entry.aliases : []),
  ].filter(Boolean).flatMap(nameVariants))],
 }));
}

function longestMatch(index, text) {
 const haystack = normalizeGeoText(text);
 if (!haystack) return null;
 let best = null;
 let bestLength = 0;
 for (const item of index) {
  for (const variant of item.variants) {
   if (variant.length < 2) continue;
   if (!haystack.includes(variant)) continue;
   if (variant.length > bestLength) {
    best = item.entry;
    bestLength = variant.length;
   }
  }
 }
 return best;
}

export function openGeoIndex({file = null, data = null} = {}) {
 const source = data ?? loadData(file);
 const countries = indexEntries(source.countries);
 const provinces = indexEntries(source.provinces);
 const cities = indexEntries(source.cities);
 const venues = indexEntries(source.venues);
 const regions = source.regions ?? {};

 function countryEntry(value) {
  const hit = longestMatch(countries, value);
  return hit ? {...hit} : null;
 }

 function countryMatch(value) {
  const hit = countryEntry(value);
  return hit ? {country: hit.name} : null;
 }

 function regionOfCountry(country) {
  return countryEntry(country)?.region ?? '';
 }

 // Parentheses in trade-fair names are locations: "中国（阿联酋）贸易博览会" and
 // "China (UAE) Trade Expo" are held in the UAE even though the organiser is
 // Chinese. Parsing them is string scanning, not a guess from the name.
 function parseParentheticals(text) {
  const source = String(text ?? '');
  const parts = [];
  for (let index = 0; index < source.length; index += 1) {
   const open = source[index];
   if (open !== '（' && open !== '(') continue;
   const closeChar = open === '（' ? '）' : ')';
   const close = source.indexOf(closeChar, index + 1);
   if (close < 0) break;
   parts.push(source.slice(index + 1, close).trim());
   index = close;
  }
  return parts;
 }

 // A foreign location mentioned in the name (parenthetical first). "China" in
 // the name means the organiser/commodity origin, not the venue country.
 function locationFromName(name) {
  const text = String(name ?? '');
  if (!text) return null;
  for (const part of parseParentheticals(text)) {
   const cityHit = longestMatch(cities, part);
   if (cityHit && cityHit.country && cityHit.country !== '中国') {
    return {
     country: cityHit.country,
     province: cityHit.province ?? '',
     city: cityHit.name,
     district: '',
     region: regionOfCountry(cityHit.country) || 'global',
     matchedBy: 'name-parenthetical',
    };
   }
   const countryHit = longestMatch(countries, part);
   if (countryHit && countryHit.name !== '中国') {
    return {
     country: countryHit.name,
     province: '',
     city: '',
     district: '',
     region: countryHit.region ?? 'global',
     matchedBy: 'name-parenthetical',
    };
   }
  }
  // No usable parenthetical: scan country names in the name ("澳大利亚中国纺织服装服饰展").
  const haystack = normalizeGeoText(text);
  let best = null;
  let bestLength = 0;
  for (const country of source.countries) {
   if (country.name === '中国') continue;
   for (const variant of [...new Set([country.name, ...(Array.isArray(country.aliases) ? country.aliases : [])].flatMap(nameVariants))]) {
    if (variant.length < 2) continue;
    const latin = /^[a-z0-9]+$/.test(variant);
    if (latin && variant.length < 4) continue;
    if (!haystack.includes(variant) || variant.length <= bestLength) continue;
    best = country;
    bestLength = variant.length;
   }
  }
  return best
   ? {country: best.name, province: '', city: '', district: '', region: best.region ?? 'global', matchedBy: 'name-country'}
   : null;
 }

 function cityMatch(value) {
  const hit = longestMatch(cities, value);
  // Return the stored row (including districts) so callers can infer the
  // district from a venue/address in the same pass.
  return hit ? {...hit} : null;
 }

 function venueMatch(value) {
  const hit = longestMatch(venues, value);
  return hit
   ? {
    country: hit.country ?? '',
    province: hit.province ?? '',
    city: hit.city ?? '',
    district: hit.district ?? '',
    venue: hit.name,
   }
   : null;
 }

 function districtMatch(cityEntry, text) {
  if (!cityEntry || !Array.isArray(cityEntry.districts)) return '';
  const haystack = normalizeGeoText(text);
  if (!haystack) return '';
  let best = '';
  for (const district of cityEntry.districts) {
   for (const variant of nameVariants(district)) {
    if (variant.length >= 2 && haystack.includes(variant) && variant.length > best.length) best = district;
   }
  }
  return best;
 }

 // Infer the full stored hierarchy from whatever location text the event has.
 // Priority: explicit venue match > explicit city match > free-text scan >
 // explicit province/country match > region fallback. Never returns a guess for
 // a city that is not in the stored table.
 function infer(input = {}) {
  const {
   country = '', province = '', city = '', district = '', venue = '', address = '', name = '', region = '',
  } = input;
  const freeText = [name, address, venue].filter(Boolean).join(' ');
  const venueHit = (venue || address ? venueMatch([venue, address].filter(Boolean).join(' ')) : null) ?? venueMatch(freeText);
  const cityKey = city || venueHit?.city || '';
  const cityHit = cityKey ? cityMatch(cityKey) : null;
  const cityEntry = cityHit ? {...cityHit, city: cityHit.name} : null;
  let storedCity = null;
  if (!cityEntry) storedCity = longestMatch(cities, freeText);
  const resolvedCity = cityEntry ?? (storedCity ? {country: storedCity.country ?? '', province: storedCity.province ?? '', city: storedCity.name} : null);
  const venueCountry = venueHit?.country ?? '';
  const explicitCountry = country ? countryEntry(country) : null;
  const provinceHit = longestMatch(provinces, province)?.country ? longestMatch(provinces, province) : null;
  const nameLocation = locationFromName(name);
  // "China" in "China (UAE) Trade Expo" is the organiser/commodity origin; the
  // parenthetical city/country is where the event is held.
  const nameForeign = nameLocation && nameLocation.country !== '中国' ? nameLocation : null;
  let resolvedCountry;
  let resolvedRegion = region;
  if (country) {
   resolvedCountry = explicitCountry?.name || resolvedCity?.country || venueCountry || '';
   resolvedRegion = explicitCountry?.region || regionOfCountry(resolvedCountry) || region;
  } else {
   resolvedCountry = venueCountry || resolvedCity?.country || (provinceHit?.country ?? '') || nameForeign?.country || (region ? regions[region] ?? '' : '');
   const countryRegion = regionOfCountry(resolvedCountry);
   if (countryRegion) resolvedRegion = countryRegion;
   else if (nameForeign?.region) resolvedRegion = nameForeign.region;
  }
  const resolvedProvince = venueHit?.province || province || provinceHit?.name || resolvedCity?.province || nameForeign?.province || '';
  const resolvedCityName = venueHit?.city || (cityEntry ? cityEntry.city : (storedCity?.name ?? nameForeign?.city ?? ''));
  const resolvedDistrict = district
   || venueHit?.district
   || districtMatch(cityEntry ?? storedCity, [address, venue, name].filter(Boolean).join(' '));
  let matchedBy = 'none';
  if (venueHit) matchedBy = 'venue';
  else if (cityEntry || storedCity) matchedBy = 'city';
  else if (nameForeign) matchedBy = nameForeign.matchedBy;
  else if (explicitCountry || provinceHit) matchedBy = 'country';
  else if (region) matchedBy = 'region';
  return {
   country: resolvedCountry,
   province: resolvedProvince,
   city: resolvedCityName,
   district: resolvedDistrict,
   region: resolvedRegion,
   matchedBy,
  };
 }

 function stats() {
  return {
   file: file ?? null,
   countries: source.countries.length,
   provinces: source.provinces.length,
   cities: source.cities.length,
   venues: source.venues.length,
  };
 }

 return {
  file,
  data: source,
  stats,
  infer,
  country: countryMatch,
  countryEntry,
  city: cityMatch,
  venue: venueMatch,
 };
}

// Process-wide default index for the demo so modules can share one read.
let defaultIndex = null;
export function defaultGeoIndex(file = 'seed/geo-cn.json') {
 if (!defaultIndex) defaultIndex = openGeoIndex({file});
 return defaultIndex;
}
