// Brevo AI Mailer: paste a link, Claude writes the email, Brevo sends it to your list.
// Setup: copy .env.example to .env, fill it in, then `npm install && npm start` (Node 20.6+).
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { APP_PASSWORD, BREVO_API_KEY, ANTHROPIC_API_KEY, SENDER_EMAIL, SENDER_NAME = '', MAIL_ADDRESS = '',
  CLAUDE_MODEL = 'claude-sonnet-5-5', PORT = 3000 } = process.env;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (_, res) => res.sendFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html')));

// Every /api route needs your app password, so nobody else can email your list.
app.use('/api', (req, res, next) => {
  const a = Buffer.from(req.get('x-app-password') || ''), b = Buffer.from(APP_PASSWORD || '');
  if (!b.length || a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return res.status(401).json({ error: 'Wrong app password' });
  next();
});

const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); } };
const isUrl = u => /^https?:\/\//i.test(u || '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function brevo(method, url, body) {
  const r = await fetch('https://api.brevo.com/v3' + url, {
    method, body: body && JSON.stringify(body),
    headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
  });
  const text = await r.text();
  let data = {}; try { data = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`Brevo: ${data.message || r.status}`);
  return data;
}

// Spotify links: grab the title and cover art (public oEmbed, no key needed).
async function spotifyInfo(link) {
  if (!link.includes('open.spotify.com')) return {};
  try {
    const j = await (await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(link))).json();
    return { title: j.title, cover: j.thumbnail_url };
  } catch { return {}; }
}

const SYSTEM = `You are a senior email copywriter for independent musicians. Write a short email that makes the reader want to press play right now.
- subject: max 50 characters, specific and curiosity-driven. Never misleading, no ALL CAPS, no spammy words.
- preheader: max 90 characters, adds a new angle instead of repeating the subject.
- headline: max 8 words.
- paragraphs: 2-3 short paragraphs in the artist's warm first-person voice. Open with a feeling, a moment or a question, not "I'm excited to announce". Concrete detail beats hype. One idea per paragraph.
- cta: max 4 words, an action like "Listen now".
Never invent facts (stream counts, awards, collaborators) that are not in the brief.
Reply with ONLY a JSON object: {"subject":"","preheader":"","headline":"","paragraphs":[""],"cta":""}`;

// The AI writes the words; this fixed, email-safe layout does the HTML. Unsubscribe link is always included.
function render({ subject, preheader, headline, paragraphs = [], cta, link, cover }) {
  const url = isUrl(link) ? esc(link) : '#';
  const img = isUrl(cover)
    ? `<tr><td><a href="${url}"><img src="${esc(cover)}" width="600" alt="${esc(headline)}" style="display:block;width:100%;height:auto;border:0"></a></td></tr>` : '';
  const body = paragraphs.map(t => `<p style="margin:0 0 16px">${esc(t)}</p>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#eceaf6">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">
${img}
<tr><td style="padding:32px 32px 8px;font:800 32px/1.1 'Helvetica Neue',Arial,sans-serif;letter-spacing:-.5px;color:#1d1a33">${esc(headline)}</td></tr>
<tr><td style="padding:8px 32px;font:17px/1.6 Georgia,serif;color:#2b2842">${body}</td></tr>
<tr><td align="center" style="padding:8px 32px 40px"><a href="${url}" style="display:inline-block;background:#3a2bff;color:#ffffff;font:bold 17px Arial,sans-serif;text-decoration:none;padding:16px 40px;border-radius:6px">${esc(cta)}</a></td></tr>
</table>
<p style="max-width:520px;margin:20px 0 0;font:12px/1.5 Arial,sans-serif;color:#625f80">You are getting this because you subscribed to updates from ${esc(SENDER_NAME)}.${MAIL_ADDRESS ? ' ' + esc(MAIL_ADDRESS) : ''}<br><a href="{{ unsubscribe }}" style="color:#625f80">Unsubscribe</a></p>
</td></tr></table></body></html>`;
}

app.get('/api/lists', wrap(async (_, res) => {
  const { lists = [] } = await brevo('GET', '/contacts/lists?limit=50&sort=desc');
  res.json(lists.map(l => ({ id: l.id, name: l.name, count: l.totalSubscribers ?? 0 })));
}));

app.post('/api/generate', wrap(async (req, res) => {
  const { prompt = '', link = '', tone = 'warm and personal' } = req.body;
  if (!isUrl(link)) throw new Error('Add a link that starts with https://');
  const sp = await spotifyInfo(link);
  const brief = `Artist: ${SENDER_NAME}\nLink: ${link}\n${sp.title ? `Spotify title: ${sp.title}\n` : ''}Tone: ${tone}\nNotes from the artist: ${prompt || '(none)'}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1000, system: SYSTEM, messages: [{ role: 'user', content: brief }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Claude: ${j.error?.message || r.status}`);
  const txt = j.content.map(c => c.text || '').join('');
  let copy;
  try { copy = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); }
  catch { throw new Error('The AI reply was malformed. Click the button again.'); }
  copy.paragraphs = [].concat(copy.paragraphs || []);
  copy.link = link; copy.cover = sp.cover || '';
  res.json({ copy, html: render(copy) });
}));

app.post('/api/render', wrap(async (req, res) => res.json({ html: render(req.body.copy || {}) })));

// testEmail present: send a test to that address only. Otherwise send to the whole list.
app.post('/api/send', wrap(async (req, res) => {
  const { copy, listId, testEmail } = req.body;
  if (!copy?.subject || !listId) throw new Error('Pick a list and add a subject line');
  const { id } = await brevo('POST', '/emailCampaigns', {
    name: `${copy.subject} (${new Date().toISOString().slice(0, 10)})`,
    subject: copy.subject,
    sender: { name: SENDER_NAME, email: SENDER_EMAIL },
    htmlContent: render(copy),
    recipients: { listIds: [Number(listId)] },
  });
  if (testEmail) await brevo('POST', `/emailCampaigns/${id}/sendTest`, { emailTo: [testEmail] });
  else await brevo('POST', `/emailCampaigns/${id}/sendNow`);
  res.json({ ok: true, id });
}));

app.listen(PORT, () => console.log(`Open http://localhost:${PORT}`));
