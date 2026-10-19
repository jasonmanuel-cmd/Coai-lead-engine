// api/outreach.js — COAI Lead Engine AI Outreach Generator
// Supports multiple AI providers with auto-fallback to static templates
//
// Environment:
//   AI_PROVIDER          — 'gemini' (default, free) | 'perplexity' | 'anthropic'
//   GEMINI_API_KEY       — for Gemini (free from aistudio.google.com)
//   PERPLEXITY_API_KEY   — for Perplexity
//   ANTHROPIC_API_KEY    — for Claude
//   APP_PASSWORD         — shared auth key
//
// Method: POST
// Body:   { lead: <LeadObject>, type: 'text' | 'email' | 'voicemail' }
// Returns: { message: string, provider: string, aiGenerated: boolean }

function buildPrompt(lead, type, sender = {}) {
  const signals = [];
  if (!lead.hasWebsite)                          signals.push('no website listed on Google');
  if (lead.rating > 0 && lead.rating < 3.5)     signals.push(`only ${lead.rating} stars on Google`);
  if (lead.rating === 0)                         signals.push('no star rating on Google');
  if (lead.reviews === 0)                        signals.push('zero customer reviews');
  else if (lead.reviews < 10)                    signals.push(`only ${lead.reviews} customer reviews`);
  if (!lead.hasPhone)                            signals.push('no phone number listed on Google');
  const signalSummary = signals.length > 0 ? signals.join('; ') : 'an online presence that could be stronger';

  // Sender profile comes from the customer's in-app Settings. Fall back to
  // neutral placeholders so the message never leaks another user's identity.
  const s = {
    businessName: String(sender.businessName || '').trim(),
    ownerName: String(sender.ownerName || '').trim(),
    phone: String(sender.phone || '').trim(),
    email: String(sender.email || '').trim(),
    address: String(sender.address || '').trim(),
    website: String(sender.website || '').trim(),
    price: String(sender.price || '').trim(),
    tone: ['casual', 'professional', 'direct'].includes(sender.tone) ? sender.tone : 'casual',
  };
  const who = s.ownerName || 'a local business consultant';
  const biz = s.businessName || 'my agency';
  const where = (s.address.split(',').pop() || '').trim() || 'your area';
  const offer = s.price ? ` Their offer/pricing hook: "${s.price}".` : '';
  const contactLine = [s.phone, s.email, s.website].filter(Boolean).join(' · ') || '(no contact info provided — end with a soft ask to reply instead of a callback number)';

  const toneVoice = {
    casual: 'Casual and human, like a fellow local business owner texting a neighbor. Short sentences, no corporate speak.',
    professional: 'Professional and polished but warm — a trusted advisor, not a salesperson.',
    direct: 'Direct and punchy. Lead with the observed problem and the cost of ignoring it. No fluff.',
  }[s.tone];

  const formatInstructions = {
    text:      'Write a SHORT text message / DM (max 90 words). One clear ask at the end.',
    email:     'Write a cold email. Include a Subject: line first. Body = 3 short paragraphs max. End with one clear ask.',
    voicemail: `Write a voicemail script (~120 words, reads in under 60 seconds).${s.phone ? ` Say the callback number ${s.phone} twice — once in the middle and once at the end.` : ''}`
  };

  return `You are writing cold outreach ON BEHALF OF ${who}${s.businessName ? ` with ${biz}` : ''}, who helps local businesses win more customers (typical services: websites, reviews, local SEO, lead generation, AI receptionists — adapt to the offer below if one is given).${offer}

SENDER:
Name: ${who}
Business: ${biz}
Location: ${where}
Contact: ${contactLine}

TARGET BUSINESS:
Name: ${lead.name}
Industry: ${lead.cat}
Location: ${lead.address || 'their local area'}
What we can observe about them: ${signalSummary}

TASK: ${formatInstructions[type] || formatInstructions.text}

VOICE: ${toneVoice}

RULES:
- Reference the specific observation (missing website, low rating, few reviews, no phone) as the reason for reaching out
- Make the pain concrete: missed calls, lost Google traffic, competitors winning the click
- Offer a low-pressure next step (free audit / 10–15 minute call)
- Never open with "I hope this finds you well" or similar filler
- Never invent facts about the sender (no fake client counts, awards, or guarantees)
- Keep it short and actionable — the goal is a reply or callback

OUTPUT: The message text only. No preamble, no quotes, no explanation.`;
}

async function callGemini(prompt) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const resp = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
  const text = resp?.text;
  if (!text) throw new Error('Gemini returned empty response');
  return text.trim();
}

async function callPerplexity(prompt) {
  const resp = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || 'Perplexity API error');
  return data.choices?.[0]?.message?.content?.trim();
}

async function callAnthropic(prompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.content?.[0]?.text) {
    throw new Error(data.error?.message || 'Anthropic API error');
  }
  return data.content[0].text.trim();
}

function chooseProvider(clientPreferred) {
  const configured = [];
  if (process.env.GEMINI_API_KEY) configured.push('gemini');
  if (process.env.PERPLEXITY_API_KEY) configured.push('perplexity');
  if (process.env.ANTHROPIC_API_KEY) configured.push('anthropic');

  if (configured.length === 0) return null;

  // The customer's in-app AI choice wins if that key exists on the server,
  // then the server default, then whatever is configured.
  const candidates = [clientPreferred, process.env.AI_PROVIDER || 'gemini'];
  for (const c of candidates) {
    if (c && configured.includes(c)) return c;
  }
  return configured[0];
}

const { resolveCaller } = require('../lib/saas');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const caller = await resolveCaller(req);
  if (!caller) return res.status(401).json({ error: 'Unauthorized' });

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }

  const provider = chooseProvider(body.provider);
  if (!provider) {
    return res.status(200).json({ fallback: true, reason: 'No AI provider configured — using static template.', provider: null });
  }

  const { lead, type, sender } = body;
  if (!lead || !type) return res.status(400).json({ error: 'lead and type are required.' });

  const prompt = buildPrompt(lead, type, sender && typeof sender === 'object' ? sender : {});

  try {
    let message;
    switch (provider) {
      case 'gemini':
        message = await callGemini(prompt);
        break;
      case 'perplexity':
        message = await callPerplexity(prompt);
        break;
      case 'anthropic':
        message = await callAnthropic(prompt);
        break;
    }

    if (!message) throw new Error('No message generated');

    return res.status(200).json({ message, provider, aiGenerated: true });
  } catch (err) {
    return res.status(200).json({ fallback: true, reason: err.message, provider });
  }
};
