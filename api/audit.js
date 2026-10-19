// api/audit.js — lightweight website opportunity audit
const { resolveCaller } = require('../lib/saas');
const { assertPublicUrl } = require('../lib/ssrf');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.SITE_URL || 'https://coaihq.online');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const caller=await resolveCaller(req);
  if(!caller)return res.status(401).json({error:'Unauthorized.'});
  const {url=''}=req.query;if(!/^https?:\/\//i.test(url))return res.status(400).json({error:'A full http(s) URL is required.'});
  try{
    await assertPublicUrl(url);
  }catch(e){return res.status(400).json({error:e.message})}
  try{
    const started=Date.now();const r=await fetch(url,{redirect:'follow',headers:{'User-Agent':'Mozilla/5.0 Chrome/124 Safari/537.36'},signal:AbortSignal.timeout(15000)});const body=await r.text();const lower=body.toLowerCase();const visible=body.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').toLowerCase();const responseMs=Date.now()-started;
    const tests={reachable:r.ok,https:r.url.startsWith('https://'),title:/<title[^>]*>\s*[^<]{3,}/i.test(body),description:/<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}/i.test(body)||/<meta[^>]+content=["'][^"']{20,}["'][^>]+name=["']description["']/i.test(body),viewport:/<meta[^>]+name=["']viewport["']/i.test(body),h1:(body.match(/<h1\b/gi)||[]).length,form:/<form\b/i.test(body),phoneLink:/href=["']tel:/i.test(body),schema:/application\/ld\+json/i.test(body),cta:/(get a quote|request a quote|book now|schedule|call now|free estimate|contact us)/i.test(visible),faq:/(frequently asked|\bfaq\b)/i.test(visible),analytics:/(googletagmanager|google-analytics|gtag\(|plausible\.io|matomo)/i.test(lower),responseMs,sizeKb:Math.round(Buffer.byteLength(body)/1024)};
    const years=[...visible.matchAll(/(?:©|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map(m=>Number(m[1]));tests.latestCopyrightYear=years.length?Math.max(...years):null;
    let score=100;const issues=[];const deduct=(c,p,i)=>{if(c){score-=p;issues.push(i)}};
    deduct(!tests.reachable,40,'Website is not responding normally');deduct(!tests.https,10,'No HTTPS');deduct(responseMs>3500,12,`Slow response (${(responseMs/1000).toFixed(1)}s)`);deduct(!tests.viewport,12,'No mobile viewport detected');deduct(!tests.title,7,'Missing or weak page title');deduct(!tests.description,6,'Missing meta description');deduct(tests.h1!==1,6,`${tests.h1} H1 headings detected`);deduct(!tests.phoneLink,8,'No click-to-call link');deduct(!tests.cta,10,'No strong call to action');deduct(!tests.form,8,'No contact or quote form');deduct(!tests.schema,7,'No structured data');deduct(!tests.faq,5,'No FAQ or answer-focused content');deduct(tests.latestCopyrightYear&&tests.latestCopyrightYear<new Date().getFullYear()-2,8,`Copyright appears old (${tests.latestCopyrightYear})`);score=Math.max(0,score);
    let classification='Healthy site';if(!tests.reachable||score<35)classification='Broken or severely weak site';else if((tests.latestCopyrightYear&&tests.latestCopyrightYear<new Date().getFullYear()-2)||!tests.viewport)classification='Outdated site';else if(!tests.cta||!tests.form||!tests.phoneLink)classification='Weak conversion site';else if(!tests.schema||!tests.faq||!tests.description)classification='Weak local SEO / AEO';else if(score<80)classification='Site needs improvement';
    return res.status(200).json({status:'OK',finalUrl:r.url,score,classification,issues,tests});
  }catch(error){return res.status(200).json({status:'FAILED',score:0,classification:'Broken or unreachable site',issues:[error.message],tests:{}})}
};