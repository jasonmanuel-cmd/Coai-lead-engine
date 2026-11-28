const test = require('node:test');
const assert = require('node:assert');
const F = require('../lib/nightops-followups');

const due2 = { lead_key: 'p1', place_id: 'p1', business_name: 'Hawley AC', email: 'ted@x.com',
  next_touch: 2, last_sent_at: '2026-11-25T12:50:00Z', last_subject: 'Your reviews section',
  fact: 'Your site still says "Be the first to review us".', offer: 'the $350 audit' };

test('touch 2 replies on the same subject, repeats only the original fact, and carries the opt-out', () => {
  const d = F.draftFor(due2, {});
  assert.strictEqual(d.subject, 'Re: Your reviews section');
  assert.match(d.body, /my note from Nov 25\./);
  assert.match(d.body, /The thing I noticed: Your site still says "Be the first to review us"\./);
  assert.match(d.body, /no thanks/);
  assert.match(d.body, /1520 18th St/);
});

test('touch 3 is the last, short and polite', () => {
  const d = F.draftFor({ ...due2, next_touch: 3, last_subject: 'Re: Your reviews section' }, {});
  assert.strictEqual(d.subject, 'Re: Your reviews section');
  assert.match(d.body, /Last note from me/);
  assert.match(d.body, /If the \$350 audit ever becomes useful/);
});

test('no fact on file: touch 2 leaves that line out rather than inventing one', () => {
  const d = F.draftFor({ ...due2, fact: null }, {});
  assert.ok(!/noticed/.test(d.body));
});

test('signature can be replaced by env', () => {
  const d = F.draftFor(due2, { NIGHTOPS_SIGNATURE: 'Jay\\nCOAI' });
  assert.match(d.body, /Jay\nCOAI$/);
});

test('runFollowups writes drafts only, one per due lead, never a sent row', async () => {
  const inserts = [];
  const query = async (text, params) => {
    if (/FROM followups_due/.test(text)) return { rows: [due2, { ...due2, lead_key: 'p2', next_touch: 3 }] };
    if (/INSERT INTO outreach_touches/.test(text)) {
      assert.match(text, /'draft'/);
      assert.ok(!/'sent'/.test(text));
      inserts.push(params);
      return { rowCount: 1 };
    }
    throw new Error('unexpected ' + text);
  };
  const s = await F.runFollowups({ query }, {});
  assert.deepStrictEqual(s, { due: 2, drafted: 2 });
  assert.deepStrictEqual(inserts.map((p) => [p[0], p[4]]), [['p1', 2], ['p2', 3]]);
});
