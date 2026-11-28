// lib/nightops-followups.js — draft the next touch for leads that are due.
//
// Reads the followups_due view (see sql/nightops.sql) and writes one DRAFT row
// per due lead into outreach_touches. It never sends anything: a draft becomes
// a sent touch only when Jay presses Send and the sender marks the row sent.
// At most two follow-ups per lead (day 3 and day 7), and none after a reply,
// bounce or opt-out.

const DEFAULT_SIGNATURE = [
  'Jay',
  'Chaotically Organized AI, Bakersfield',
  '(661) 683-0228 · chaoticallyorganizedai.com',
  '1520 18th St, Bakersfield, CA 93301',
  'If this isn\'t useful, reply "no thanks" and I won\'t follow up.',
].join('\n');

function signature(env = process.env) {
  const s = env.NIGHTOPS_SIGNATURE;
  return s ? s.replace(/\\n/g, '\n') : DEFAULT_SIGNATURE;
}

function shortDate(d) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric',
  }).format(new Date(d));
}

function replySubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return 'Following up';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

// The draft for touch 2 or 3. Uses only what touch 1 already said: the one
// observation it was built on (fact) and the offer. Invents nothing new.
function draftFor(due, env = process.env) {
  const sig = signature(env);
  const fact = due.fact ? String(due.fact).trim().replace(/\s+/g, ' ') : '';
  if (Number(due.next_touch) === 2) {
    const factLine = fact ? ` The thing I noticed: ${fact.replace(/[.\s]+$/, '')}.` : '';
    return {
      subject: replySubject(due.last_subject),
      body: `Hi there,\n\nFollowing up on my note from ${shortDate(due.last_sent_at)}.${factLine}`
        + ' I can send a free 2-minute video showing exactly what I\'d change, no call needed. Want it?'
        + `\n\n${sig}`,
    };
  }
  const offer = due.offer ? String(due.offer).trim() : 'a hand with your website';
  return {
    subject: replySubject(due.last_subject),
    body: `Hi there,\n\nLast note from me on this. If ${offer} ever becomes useful, just reply`
      + ' and I\'ll send that video. Either way, thanks for reading.'
      + `\n\n${sig}`,
  };
}

/** deps: { query }  Returns { due, drafted }. */
async function runFollowups(deps, env = process.env) {
  const { query } = deps;
  const due = (await query('SELECT * FROM followups_due ORDER BY due_at')).rows;
  let drafted = 0;
  for (const d of due) {
    if (![2, 3].includes(Number(d.next_touch))) continue;
    const { subject, body } = draftFor(d, env);
    const r = await query(
      `INSERT INTO outreach_touches
         (lead_key, place_id, business_name, email, channel, touch_no, subject, body,
          fact, offer, status, note)
       VALUES ($1,$2,$3,$4,'email',$5,$6,$7,$8,$9,'draft',
               'drafted by the follow-up job; goes out only when Jay presses Send')
       ON CONFLICT (lead_key, touch_no) DO NOTHING`,
      [d.lead_key, d.place_id, d.business_name, d.email, d.next_touch, subject, body, d.fact, d.offer]
    );
    drafted += r.rowCount || 0;
  }
  return { due: due.length, drafted };
}

module.exports = { DEFAULT_SIGNATURE, signature, draftFor, replySubject, runFollowups };
