# Night Ops: the no-website ("build") track

About half of the businesses Night Ops pulls have no website of their own. They
used to be dropped. Now the harvest keeps them as `track = 'build'` and ranks
them with `build_score` (0–130: reviews, rating, phone).

## Who qualifies
- `site_kind = 'none'`: Google lists no website.
- `site_kind = 'directory'`: the "website" is a Facebook, Yelp, free-builder or
  similar page, not a domain the business owns.

Check before pitching: a quick search can turn up a site Google doesn't list.
If one exists, the lead moves to the audit track.

## What may be said (facts we actually have)
- Their Google listing shows no website, or only a Facebook/Yelp page.
- Their rating and review count, as shown on Google.
- Never claim lost customers, revenue or rankings we haven't measured.

## Email opener (only when an email or form exists)
Subject: Your Google listing

Hi there,

I'm Jay, a web builder here in Bakersfield. Your Google listing has
{reviews} reviews at {rating} stars, but no website for people to land on.
I build simple sites for local shops that turn those searches into calls,
and you own the site outright. Worth a 10-minute call this week?

(signature, postal address and "no thanks" opt-out line)

## Call script (most build leads only have a phone)
1. "Hi, is this the owner? I'm Jay, a web builder here in Bakersfield."
2. "I saw your Google listing: {reviews} reviews, which is great, but no
   website. Is that on purpose, or just not gotten to yet?"
3. Listen. If "not gotten to": "I build simple sites for local shops, you own
   it outright. Can I text or email you a couple of examples?"
4. Get permission before any text. Calls are by hand only; no robocalls or
   automated texts (TCPA).

## Price
Jay's list: $1,997 build ($997 to start). Confirm with Jay before quoting.

## Reading the list
```sql
SELECT business_name, phone, website, rating::float, reviews, build_score,
       category, maps_url
FROM nightly_leads
WHERE night_date = (now() AT TIME ZONE 'America/Los_Angeles')::date
  AND status = 'new' AND track = 'build'
ORDER BY build_score DESC, reviews DESC NULLS LAST;
```
