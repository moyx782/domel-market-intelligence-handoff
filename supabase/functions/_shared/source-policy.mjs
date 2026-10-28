// Source preferences do not restrict discovery. Only SOURCE_RESTRICT_DOMAINS is
// an optional administrator security boundary; the legacy setting is ignored.
export function sourcePolicy(get) {
 const restrictedDomains=(get('SOURCE_RESTRICT_DOMAINS')||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
 const raw=get('SOURCE_DEFAULT_URLS')||'[]';
 let defaultSourceUrls;
 try {defaultSourceUrls=JSON.parse(raw);}catch {throw Error('SOURCE_DEFAULT_URLS must be a JSON array of HTTPS page URLs.');}
 if(!Array.isArray(defaultSourceUrls)||defaultSourceUrls.length>15)throw Error('Configure at most 15 default source URLs.');
 defaultSourceUrls=[...new Set(defaultSourceUrls.map(url=>publicSourceUrl(url,restrictedDomains)))];
 return {restrictedDomains,defaultSourceUrls};
}
export function publicSourceUrl(raw, restrictedDomains=[]) {
 const u=new URL(raw);
 const host=u.hostname.toLowerCase().replace(/\.$/,'');
 if(u.protocol!=='https:'||u.username||u.password||u.port)throw Error('Only standard public HTTPS URLs are eligible.');
 // Reject IP literals (including URL-normalized numeric/hex IPv4), local and
 // reserved names. Provider Fetch handles retrieval; native Fetch also checks DNS.
 if(!host.includes('.')||/^[\d.]+$/.test(host)||host.includes(':')||/\.(localhost|local|internal|test|invalid|example|home|lan|onion)$/.test(host))throw Error('Source must use a public internet hostname.');
 if(restrictedDomains.length&&!restrictedDomains.includes(host))throw Error('Source domain is restricted by the administrator.');
 u.hostname=host;u.hash='';return u.href;
}
export function publicAddress(ip) {
 if(ip.includes(':')) {
  // Public IPv6 global unicast only. Reject mapped IPv4 and special-use ranges.
  return /^[23][0-9a-f]{0,3}:/i.test(ip)&&!/^2001:(0:|db8:|10:|20:)/i.test(ip)&&!/^2002:/i.test(ip);
 }
 const n=ip.split('.').map(Number);
 if(n.length!==4||n.some(v=>!Number.isInteger(v)||v<0||v>255))return false;
 const [a,b,c]=n;
 return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
}
