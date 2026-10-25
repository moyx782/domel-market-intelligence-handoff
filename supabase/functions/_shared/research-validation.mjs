export function validateScope(p) {
 if (!p || !['title','question','segment','market'].every(k=>typeof p[k]==='string'&&p[k].trim())) throw Error('Research scope fields must be nonempty.');
 if (!/^20\d{2}-Q[1-4]$/.test(p.quarter)) throw Error('Invalid research quarter.');
 if (!Array.isArray(p.competitors)||p.competitors.length<1||p.competitors.length>3||p.competitors.some(c=>typeof c!=='string'||!c.trim())||new Set(p.competitors.map(c=>c.trim().toLowerCase())).size!==p.competitors.length) throw Error('Enter 1–3 distinct competitors.');
 const fields=['Product portfolio','Technology','Market activity','Sustainability','Supply chain'];
 if (!Array.isArray(p.focus)||!p.focus.length||p.focus.length>5||p.focus.some(f=>typeof f!=='string'||!f.trim()||f.length>80)||new Set(p.focus.map(f=>f.trim().toLowerCase())).size!==p.focus.length) throw Error('Invalid research focus.');
 if (!Array.isArray(p.source_urls)||p.source_urls.length>15) throw Error('Use at most 15 source URLs.');
 for (const raw of p.source_urls) {
  const u=new URL(raw);
  if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443'))throw Error('Only standard public HTTPS URLs are eligible.');
 }
 return p;
}
export function validateFindings(parsed,p,s) {
 if(!parsed||!Array.isArray(parsed.findings)||parsed.findings.length>5)throw Error('AI returned an invalid findings list.');
 for(const f of parsed.findings){
  if(!f||!p.competitors.includes(f.competitor)||!p.focus.includes(f.field)||typeof f.text!=='string'||!f.text.trim()||f.text.length>4000||typeof f.quote!=='string'||f.quote.length<30||f.quote.length>1200||!s.text.includes(f.quote))throw Error('AI evidence failed validation. No findings from this page were saved.');
 }
 return parsed.findings;
}
