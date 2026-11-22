// Password-protects the whole site (page + API) with a browser login prompt (HTTP Basic Auth).
// The username and password are NOT in the code: set SITE_USER and SITE_PASS in Vercel -> Settings -> Environment Variables.
import { next } from '@vercel/functions';

export const config = { runtime: 'nodejs', matcher: ['/(.*)'] };

// compare without bailing out early, so response time doesn't leak how much of a guess was right
function same(a, b) {
  const x = String(a), y = String(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

export default function middleware(request) {
  const user = process.env.SITE_USER, pass = process.env.SITE_PASS;
  if (!user || !pass) {
    // fail closed: never serve the site unprotected because a setting is missing
    return new Response('This site is locked. Set SITE_USER and SITE_PASS in the Vercel project settings, then redeploy.', { status: 503 });
  }
  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice(6)), i = decoded.indexOf(':');
      const okUser = same(decoded.slice(0, i), user), okPass = same(decoded.slice(i + 1), pass);
      if (i >= 0 && okUser && okPass) return next();
    } catch { /* malformed header: fall through to the prompt */ }
  }
  return new Response('Login required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Options News", charset="UTF-8"', 'Cache-Control': 'no-store' },
  });
}
