import { Rest } from 'ably';

export default async function handler(req, res) {
  const key = process.env.ABLY_API_KEY;
  if (!key) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'ABLY_API_KEY is not configured' }));
    return;
  }
  const rest = new Rest({ key });
  const tokenRequest = await rest.auth.createTokenRequest({
    clientId: '*',
    capability: { 'trio:*': ['publish', 'subscribe', 'presence'] },
    ttl: 60 * 60 * 1000,
  });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(tokenRequest));
}
