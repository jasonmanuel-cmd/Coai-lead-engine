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

function buildPrompt(lead, type) {
  const signals = [];
  if (!lead.hasWebsite)                          signals.push('no website or online store');
  if (lead.rating > 0 && lead.rating < 3.5)     signals.push(`only ${lead.rating} stars on Google`);
  if (lead.rating === 0)                         signals.push('zero star rating on Google');
  if (lead.reviews === 0)                        signals.push('zero customer reviews');
  else if (lead.reviews < 10)                    signals.push(`only ${lead.reviews} customer reviews`);
  if (!lead.hasPhone)                            signals.push('no phone number listed on Google');
  const signalSummary = signals.length > 0 ? signals.join('; ') : 'likely struggling with supply and visibility';

  const formatInstructions = {
    text:      'Write a SHORT text message / DM (max 90 words). Casual, direct, one clear ask at the end. Lead with the supply angle — you have products they need in stock NOW.',
    email:     'Write a cold email. Include a Subject: line first. Body = 3 paragraphs max. Professional but human tone. End with one clear ask. Lead with the supply angle — you have products they need in stock NOW.',
    voicemail: 'Write a voicemail script (~120 words, reads in under 60 seconds). Lead with the supply angle — you have products they need in stock NOW. Say the callback number (661) 610-9198 twice — once in the middle and once at the end.'
  };

  return `You are writing outreach ON BEHALF OF Jason Manuel, a wholesale smoke shop and head shop product supplier based in Bakersfield, CA.

Jason's value proposition: He supplies smoke shops, head shops, vape shops, tobacco shops, CBD stores, and glass shops with the products they need — pipes, glass, vape accessories, tobacco products, CBD, kratom, hookah supplies, and more. He has inventory IN STOCK and ready to ship or deliver locally. He works with shops that are in a bind — low on supply, can't get products from their usual distributors, or just need a reliable local source. No minimums for local shops. Competitive wholesale pricing.

TARGET BUSINESS:
Name: ${lead.name}
Industry: ${lead.cat}
Location: ${lead.address || 'Bakersfield area'}
What we know about them: ${signalSummary}

TASK: ${formatInstructions[type] || formatInstructions.text}

RULES:
- You are a SUPPLIER reaching out to a RETAIL STORE — NOT a web dev or marketing pitch
- Reference what you can see about their shop (low reviews, no website, etc.) as a signal they may need better supply to compete
- Write from Jason's voice: direct, no fluff, no corporate speak, sounds like a fellow business owner
- Never open with "I hope this finds you well" or any similar filler
- Never say "I understand" or "That's great"
- Sound like a supplier who has product ready to move, not a salesperson
- Mention you have IN STOCK inventory ready to ship/deliver
- Jason's phone: (661) 610-9198
- Jason's location: Bakersfield, CA
- Keep it short and actionable — the goal is to get them to call or reply

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

function chooseProvider() {
  const configured = [];
  if (process.env.GEMINI_API_KEY) configured.push('gemini');
  if (process.env.PERPLEXITY_API_KEY) configured.push('perplexity');
  if (process.env.ANTHROPIC_API_KEY) configured.push('anthropic');

  if (configured.length === 0) return null;

  const preferred = process.env.AI_PROVIDER || 'gemini';
  if (configured.includes(preferred)) return preferred;
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

  const provider = chooseProvider();
  if (!provider) {
    return res.status(200).json({ fallback: true, reason: 'No AI provider configured — using static template.', provider: null });
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }

  const { lead, type } = body;
  if (!lead || !type) return res.status(400).json({ error: 'lead and type are required.' });

  const prompt = buildPrompt(lead, type);

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
