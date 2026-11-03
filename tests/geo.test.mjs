import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {normalizeGeoText, openGeoIndex} from '../server/geo.mjs';

const geo = openGeoIndex({file: join(process.cwd(), 'seed', 'geo-cn.json')});

test('the stored geography loads countries, provinces, cities and venues', () => {
 const stats = geo.stats();
 assert.ok(stats.countries >= 10, String(stats.countries));
 assert.ok(stats.provinces >= 30, String(stats.provinces));
 assert.ok(stats.cities >= 60, String(stats.cities));
 assert.ok(stats.venues >= 30, String(stats.venues));
});

test('a venue lookup returns the full stored hierarchy including the district', () => {
 const result = geo.infer({venue: '国家会展中心（上海）'});
 assert.equal(result.country, '中国');
 assert.equal(result.province, '上海市');
 assert.equal(result.city, '上海');
 assert.equal(result.district, '青浦区');
 assert.equal(result.matchedBy, 'venue');

 const sni = geo.infer({address: '上海新国际博览中心（SNIEC）'});
 assert.equal(sni.city, '上海');
 assert.equal(sni.district, '浦东新区');

 const english = geo.infer({address: 'National Exhibition and Convention Center (Shanghai)'});
 assert.equal(english.city, '上海');
 assert.equal(english.district, '青浦区');
});

test('a city lookup infers country and province from the stored city row', () => {
 const shanghai = geo.infer({city: 'Shanghai'});
 assert.equal(shanghai.country, '中国');
 assert.equal(shanghai.province, '上海市');
 assert.equal(shanghai.city, '上海');

 const beijing = geo.infer({city: '北京市'});
 assert.equal(beijing.country, '中国');
 assert.equal(beijing.province, '北京市');
 assert.equal(beijing.city, '北京');

 const shenzhen = geo.infer({city: '深圳'});
 assert.equal(shenzhen.province, '广东省');
 assert.equal(shenzhen.city, '深圳');
});

test('districts can be inferred from the venue/address text of a known city', () => {
 const result = geo.infer({city: '上海', address: '上海市青浦区崧泽大道333号国家会展中心'});
 assert.equal(result.district, '青浦区');
 const fromVenue = geo.infer({venue: '广交会展馆'});
 assert.equal(fromVenue.city, '广州');
 assert.equal(fromVenue.district, '海珠区');
});

test('unknown places are not guessed; the region mapping is only a fallback', () => {
 const unknown = geo.infer({city: 'Atlantis'});
 assert.equal(unknown.country, '');
 assert.equal(unknown.province, '');
 assert.equal(unknown.city, '');

 const regionOnly = geo.infer({region: 'cn'});
 assert.equal(regionOnly.country, '中国');
 assert.equal(regionOnly.matchedBy, 'region');

 const withName = geo.infer({region: 'cn', name: '中国国际流体机械展览会'});
 assert.equal(withName.country, '中国');
});

test('normalisation strips punctuation and case without regular expressions', () => {
 assert.equal(normalizeGeoText(' 国家会展中心（上海） '), '国家会展中心上海');
 assert.equal(normalizeGeoText('Shanghai New International Expo Centre'), 'shanghainewinternationalexpocentre');
});
