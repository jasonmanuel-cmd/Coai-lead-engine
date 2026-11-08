// lib/ssrf.js — refuse to fetch internal/private addresses on behalf of users.

const dns = require('dns').promises;
const net = require('net');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
  }
  return true;
}

// Throws an Error (statusCode 400) when the URL is not a public http(s) target.
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { u = null; }
  const fail = (msg) => { const e = new Error(msg); e.statusCode = 400; return e; };
  if (!u || !/^https?:$/.test(u.protocol)) throw fail('A public http(s) URL is required.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw fail('That address is not allowed.');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw fail('That address is not allowed.');
    return u;
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw fail('Could not resolve that host.'); }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw fail('That address is not allowed.');
  return u;
}

module.exports = { assertPublicUrl, isPrivateIp };
