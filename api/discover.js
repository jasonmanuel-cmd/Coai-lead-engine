// api/discover.js — cautious website discovery and verification
const { resolveCaller } = require('../lib/saas');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const caller = await resolveCaller(req);
  if (!caller) return res.status(401).json({ error: 'Unauthorized.' });
  const { name = '', phone = '', address = '', city = '' } = req.query;
  if (!name.trim()) return res.status(400).json({ error: 'name is required.' });
  const excluded = ['google.com','bing.com','duckduckgo.com','yahoo.com','yelp.com','facebook.com','instagram.com','linkedin.com','yellowpages.com','mapquest.com','bbb.org','manta.com','nextdoor.com','angi.com','thumbtack.com','homeadvisor.com','chamberofcommerce.com','porch.com','buildzoom.com'];
  const stop = new Set(['the','and','llc','inc','corp','company','services','service','of','at']);
  const tokens = String(name).toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(x => x.length > 2 && !stop.has(x));
  const phoneDigits = String(phone).replace(/\D/g,'').slice(-10);
  const cityName = String(city || address).split(',')[0].trim().toLowerCase();
  function allowed(url) { try { const host = new URL(url).hostname.toLowerCase().replace(/^www\./,''); return host && !excluded.some(x => host.includes(x)); } catch { return false; } }
  function clean(url) { try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname || '/'}`; } catch { return ''; } }
  function guesses() { const joined=tokens.join(''), dashed=tokens.join('-'), first2=tokens.slice(0,2).join(''); return [...new Set([joined,dashed,first2].filter(Boolean))].flatMap(b=>['.com','.net','.co'].map(t=>`https://${b}${t}`)); }
  async function search(url, engine) {
    try {
      const r = await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 Chrome/124 Safari/537.36'}});
      const body = await r.text(); const out=[]; const patterns=[/<a[^>]+href="(https?:\/\/[^\"]+)"[^>]*>([\s\S]*?)<\/a>/gi,/<a[^>]+href='(https?:\/\/[^']+)'[^>]*>([\s\S]*?)<\/a>/gi];
      for (const p of patterns) { let m; while ((m=p.exec(body)) && out.length<40) { let href=m[1].replace(/&amp;/g,'&'); try { const u=new URL(href); if(u.hostname.includes('duckduckgo.com')&&u.searchParams.get('uddg')) href=decodeURIComponent(u.searchParams.get('uddg')); } catch {} if(allowed(href)) out.push({url:clean(href),source:engine}); } }
      return out;
    } catch { return []; }
  }
  async function verify(item) {
    try {
      const started=Date.now();
      const r=await fetch(item.url,{redirect:'follow',headers:{'User-Agent':'Mozilla/5.0 Chrome/124 Safari/537.36'},signal:AbortSignal.timeout(12000)});
      const html=await r.text(); const text=html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').toLowerCase();
      const host=new URL(r.url).hostname.toLowerCase().replace(/^www\./,''); let score=0; const evidence=[]; const exact=String(name).toLowerCase();
      if(text.includes(exact)){score+=38;evidence.push('Exact business name on website');}
      const hits=tokens.filter(t=>text.includes(t)).length;if(hits){score+=Math.min(24,hits*7);evidence.push(`${hits} business-name words match`);}
      const domainHits=tokens.filter(t=>host.includes(t)).length;if(domainHits){score+=Math.min(18,domainHits*8);evidence.push('Domain resembles business name');}
      const pageDigits=text.replace(/\D/g,'');if(phoneDigits&&pageDigits.includes(phoneDigits.slice(-7))){score+=45;evidence.push('Phone matches');}
      if(cityName&&text.includes(cityName)){score+=12;evidence.push('City matches');}
      if(address){const streetNumber=String(address).match(/\b\d{2,6}\b/)?.[0];if(streetNumber&&text.includes(streetNumber)){score+=12;evidence.push('Street number matches');}}
      return {url:r.url,host,score:Math.min(100,score),evidence,source:item.source,status:r.status,responseMs:Date.now()-started};
    } catch { return null; }
  }
  const q=encodeURIComponent(`"${name}" ${phone||''} ${city||address||''} official website`);
  let candidates=[...(await search(`https://www.bing.com/search?q=${q}`,'Bing')),...(await search(`https://html.duckduckgo.com/html/?q=${q}`,'DuckDuckGo')),...guesses().map(url=>({url,source:'Domain guess'}))];
  const seen=new Set(); candidates=candidates.filter(x=>{if(!x.url||!allowed(x.url))return false;const host=new URL(x.url).hostname.replace(/^www\./,'');if(seen.has(host))return false;seen.add(host);return true;}).slice(0,25);
  const checked=[]; for(const item of candidates){const v=await verify(item);if(v)checked.push(v);} checked.sort((a,b)=>b.score-a.score);
  const best=checked[0]&&checked[0].score>=35?checked[0]:null;
  return res.status(200).json({status:best?'VERIFIED':'NOT_VERIFIED',best,candidates:checked.slice(0,8),note:best?'A website candidate was verified against public business data.':'No website was verified. This does not prove that no website exists.'});
};